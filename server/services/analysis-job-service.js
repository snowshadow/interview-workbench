import crypto from "node:crypto";

export class AnalysisJobService {
  constructor({ store, provider, logger, concurrency = 2, maxAttempts = 3 }) {
    this.store = store;
    this.provider = provider;
    this.logger = logger;
    this.concurrency = concurrency;
    this.maxAttempts = maxAttempts;
    this.running = new Map();
    this.scheduled = false;
    this.scheduleTimer = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.schedule();
  }

  stop() {
    this.stopped = true;
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    this.scheduleTimer = null;
    this.scheduled = false;
    for (const controller of this.running.values()) controller.abort();
  }

  enqueue(input) {
    const interview = this.store.getInterview(input.interviewId);
    if (!interview) throw new Error("面试场次不存在");
    const transcriptSlice = boundedText(input.transcriptSlice, 100000);
    if (!transcriptSlice) throw new Error("这一段还没有可处理的转录文本");
    const segmentStart = boundedInteger(
      input.segmentStart ?? interview.lastProcessedLineCount,
      0,
      interview.lines.length,
    );
    const segmentEnd = boundedInteger(
      input.segmentEnd ?? interview.lines.length,
      segmentStart,
      interview.lines.length,
    );
    const idempotencyKey = input.idempotencyKey || createIdempotencyKey(
      input.interviewId,
      segmentStart,
      segmentEnd,
      transcriptSlice,
    );
    const card = {
      id: input.cardId || crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      transcriptSlice,
      segmentStart,
      segmentEnd,
    };
    let job = this.store.createAnalysisJob({
      interviewId: input.interviewId,
      card,
      payload: {
        segmentStart,
        segmentEnd,
        resumeMarkdown: boundedText(input.resumeMarkdown, 80000),
        roleMarkdown: boundedText(input.roleMarkdown, 80000),
        transcriptSlice,
        askedQuestions: boundedList(input.askedQuestions, 200, 500),
        previousCards: boundedList(input.previousCards, 10, 1000),
      },
      idempotencyKey,
      maxAttempts: this.maxAttempts,
    });
    if (["error", "cancelled"].includes(job.status)) job = this.store.retryJob(job.id);
    this.logger.info("job.queued", {
      jobId: job.id,
      interviewId: input.interviewId,
      segmentStart,
      segmentEnd,
    });
    this.schedule();
    return job;
  }

  get(id) {
    return this.store.getJob(id);
  }

  retry(id) {
    const job = this.store.retryJob(id);
    if (job) this.schedule();
    return job;
  }

  cancel(id) {
    const job = this.store.getJob(id);
    if (!job) return null;
    this.running.get(id)?.abort();
    return this.store.updateJob(id, { status: "cancelled", error: "已取消本次分析" });
  }

  schedule(delayMs = 0) {
    if (this.stopped || this.scheduled) return;
    this.scheduled = true;
    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = null;
      this.scheduled = false;
      this.drain();
    }, delayMs);
  }

  drain() {
    if (this.stopped) return;
    const available = this.concurrency - this.running.size;
    if (available <= 0) return;
    const jobs = this.store
      .listRunnableJobs(available)
      .filter((job) => !this.running.has(job.id));
    for (const job of jobs) this.run(job);
  }

  async run(job) {
    if (this.stopped) return null;
    if (job.attempts >= job.maxAttempts) {
      this.store.updateJob(job.id, { status: "error", error: "分析重试次数已用完" });
      this.logger.warn("job.attempts_exhausted", { jobId: job.id, attempts: job.attempts });
      return null;
    }
    const controller = new AbortController();
    this.running.set(job.id, controller);
    const attempt = job.attempts + 1;
    this.store.updateJob(job.id, { status: "running", attempts: attempt, error: "" });
    const startedAt = Date.now();
    this.logger.info("job.attempt_started", { jobId: job.id, attempt });
    try {
      const markdown = await this.provider.analyzeInterview(job.payload, {
        signal: controller.signal,
      });
      const completed = this.store.updateJob(job.id, {
        status: "done",
        attempts: attempt,
        markdown,
        detectedQuestions: [],
        error: "",
      });
      this.logger.info("job.succeeded", {
        jobId: job.id,
        attempt,
        durationMs: Date.now() - startedAt,
        outputChars: markdown.length,
      });
      return completed;
    } catch (error) {
      if (controller.signal.aborted) {
        this.store.updateJob(job.id, { status: "cancelled", attempts: attempt, error: "已取消本次分析" });
        return null;
      }
      const retriable = isRetriable(error);
      const willRetry = retriable && attempt < job.maxAttempts;
      this.store.updateJob(job.id, {
        status: willRetry ? "retrying" : "error",
        attempts: attempt,
        error: error.message || "分析失败",
      });
      this.logger[willRetry ? "warn" : "error"]("job.attempt_failed", {
        jobId: job.id,
        attempt,
        retriable,
        willRetry,
        durationMs: Date.now() - startedAt,
        error,
      });
      if (willRetry) this.schedule(Math.min(5000, 800 * attempt));
      return null;
    } finally {
      this.running.delete(job.id);
      this.schedule();
    }
  }
}

export function createIdempotencyKey(interviewId, segmentStart, segmentEnd, transcript) {
  return crypto
    .createHash("sha256")
    .update(`${interviewId}:${segmentStart}:${segmentEnd}:${transcript}`)
    .digest("hex");
}

export function isRetriable(error) {
  const message = `${error?.code || ""} ${error?.message || ""}`.toLowerCase();
  const status = Number(error?.statusCode || 0);
  if ([401, 403, 404, 422].includes(status)) return false;
  if (status === 400 && /api key|model|context|parameter|balance/.test(message)) return false;
  if ([408, 409, 425, 429].includes(status) || status >= 500) return true;
  if (/cancel|api key|unauthorized|balance/.test(message)) return false;
  return /timeout|socket|network|econn|terminated|unexpected|json|no content|sections/.test(message) || !status;
}

function boundedText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function boundedList(value, maxItems, maxLength) {
  return (Array.isArray(value) ? value : [])
    .slice(0, maxItems)
    .map((item) => boundedText(item, maxLength))
    .filter(Boolean);
}

function boundedInteger(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}
