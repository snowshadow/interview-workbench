import crypto from "node:crypto";
import { isRetriable } from "./analysis-job-service.js";

const PENDING = ["queued", "retrying", "running"];
const EMPTY_STATE = { revision: 0, processedLineCount: 0, updatedAt: null, topics: [], followups: [] };

export class AssistantJobService {
  constructor({ store, provider, logger, concurrency = 2, maxAttempts = 3, chunkChars = 24000, chunkLines = 60 }) {
    this.store = store;
    this.provider = provider;
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.concurrency = concurrency;
    this.maxAttempts = maxAttempts;
    this.chunkChars = Math.max(1, chunkChars);
    this.chunkLines = Math.max(1, chunkLines);
    this.running = new Map();
    this.retryAt = new Map();
    this.timer = null;
    this.timerAt = 0;
    this.stopped = false;
    this.generation = 0;
  }

  start() {
    this.stopped = false;
    this.schedule();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const { controller } of this.running.values()) controller.abort();
  }

  replaceStore(replace) {
    // Backup restore may reuse both job IDs and state revisions. A separate
    // in-memory generation prevents old requests from writing into that world.
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const [id, { controller, initialAttempts }] of this.running) {
      controller.abort();
      const job = this.get(id);
      if (job?.status === "running") {
        this.store.updateAssistantJob(id, {
          status: "retrying", attempts: initialAttempts, error: "数据恢复后继续整理",
        });
      }
    }
    this.running.clear();
    this.retryAt.clear();
    try {
      return replace();
    } finally {
      // Also resume interrupted work when backup validation/import fails.
      this.schedule();
    }
  }

  enqueue({ interviewId, mode = "summary" }) {
    if (!["summary", "followup"].includes(mode)) throw serviceError("助手任务类型无效", 400);
    const interview = this.store.getInterview(interviewId);
    if (!interview) throw serviceError("面试场次不存在", 404);
    const state = this.store.getAssistantState(interviewId) || EMPTY_STATE;
    const targetLineCount = interview.lines.length;
    if (mode === "summary" && targetLineCount <= state.processedLineCount) return null;
    if (!targetLineCount) throw serviceError("还没有可处理的转录文本", 400);
    const pending = this.store.listAssistantJobs(interviewId, { pendingOnly: true });
    const existing = pending.find((job) => job.mode === mode)
      || (mode === "summary" ? pending.find((job) => job.mode === "followup") : null);
    if (existing) {
      const job = targetLineCount > existing.payload.targetLineCount
        ? this.store.updateAssistantJob(existing.id, { payload: { ...existing.payload, ...snapshot(interview, state) } })
        : existing;
      this.schedule();
      return job;
    }
    const previous = this.store.listAssistantJobs(interviewId)[0];
    const validationFeedback = previous?.status === "error"
      ? previous.payload.validationFeedback || validationFeedbackFor({ message: previous.error }) : "";
    const job = this.store.createAssistantJob({
      interviewId,
      mode,
      payload: { ...snapshot(interview, state), ...(validationFeedback ? { validationFeedback } : {}) },
      idempotencyKey: crypto.randomUUID(),
      maxAttempts: this.maxAttempts,
    });
    this.logger.info("assistant.queued", { jobId: job.id, interviewId, mode, targetLineCount });
    this.schedule();
    return job;
  }

  get(id) {
    return this.store.getAssistantJob(id);
  }

  retry(id) {
    const previous = this.get(id);
    if (!previous || !["error", "cancelled"].includes(previous.status)) return null;
    const interview = this.store.getInterview(previous.interviewId);
    if (!interview) return null;
    const state = this.store.getAssistantState(previous.interviewId) || EMPTY_STATE;
    const pending = this.store.listAssistantJobs(previous.interviewId, { pendingOnly: true })
      .find((job) => job.mode === previous.mode || (previous.mode === "summary" && job.mode === "followup"));
    if (pending) {
      const job = interview.lines.length > pending.payload.targetLineCount
        ? this.store.updateAssistantJob(pending.id, { payload: { ...pending.payload, ...snapshot(interview, state) } }) : pending;
      this.schedule();
      return job;
    }
    let job = this.store.retryAssistantJob(id);
    if (job) {
      job = this.store.updateAssistantJob(id, { payload: {
        ...previous.payload,
        ...snapshot(interview, state),
        validationFeedback: previous.payload.validationFeedback || validationFeedbackFor({ message: previous.error }),
      } });
      this.retryAt.delete(id);
      this.schedule();
    }
    return job;
  }

  cancel(id) {
    const job = this.get(id);
    if (!job) return null;
    if (!PENDING.includes(job.status)) return job;
    this.running.get(id)?.controller.abort();
    this.retryAt.delete(id);
    return this.store.updateAssistantJob(id, { status: "cancelled", error: "已取消本次整理" });
  }

  schedule(delayMs = 0) {
    if (this.stopped || this.concurrency <= 0) return;
    const when = Date.now() + delayMs;
    if (this.timer && this.timerAt <= when) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = when;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, delayMs);
    this.timer.unref?.();
  }

  drain() {
    if (this.stopped || this.running.size >= this.concurrency) return;
    const occupied = new Set([...this.running.values()].map((item) => item.interviewId));
    const jobs = this.store.listRunnableAssistantJobs(1000).sort((a, b) =>
      Number(b.mode === "followup") - Number(a.mode === "followup") || a.createdAt.localeCompare(b.createdAt));
    let delay = Infinity;
    for (const job of jobs) {
      if (this.running.size >= this.concurrency) break;
      if (this.running.has(job.id) || occupied.has(job.interviewId)) continue;
      const remaining = (this.retryAt.get(job.id) || 0) - Date.now();
      if (remaining > 0) { delay = Math.min(delay, remaining); continue; }
      occupied.add(job.interviewId);
      void this.run(job);
    }
    if (Number.isFinite(delay)) this.schedule(delay);
  }

  async run(candidate) {
    if (this.stopped || this.running.has(candidate.id)) return null;
    if ([...this.running.values()].some((item) => item.interviewId === candidate.interviewId)) return null;
    const job = this.get(candidate.id);
    if (!job || !["queued", "retrying"].includes(job.status)) return null;
    if (job.attempts >= job.maxAttempts) {
      return this.store.updateAssistantJob(job.id, { status: "error", error: "整理重试次数已用完" });
    }
    const controller = new AbortController();
    const generation = this.generation;
    this.running.set(job.id, { controller, interviewId: job.interviewId, initialAttempts: job.attempts });
    const attempt = job.attempts + 1;
    this.store.updateAssistantJob(job.id, { status: "running", attempts: attempt, error: "" });
    this.retryAt.delete(job.id);
    let lineOffset = 0;
    try {
      if (job.mode === "summary") {
        const interview = this.store.getInterview(job.interviewId);
        if (!interview) throw serviceError("面试场次不存在", 404);
        verifySnapshot(interview.lines, job.payload);
        if (interview.lines.length > job.payload.targetLineCount) {
          // Catch up once per automatic attempt; new arrivals during this
          // attempt wait for the next request instead of extending it forever.
          this.store.updateAssistantJob(job.id, { payload: {
            ...job.payload,
            ...snapshot(interview, this.store.getAssistantState(job.interviewId) || EMPTY_STATE),
          } });
        }
      }
      let generatedFollowup = false;
      while (true) {
        checkAbort(controller);
        const currentJob = this.get(job.id);
        if (!currentJob || currentJob.status === "cancelled") throw serviceError("助手任务已取消", 409);
        const interview = this.store.getInterview(job.interviewId);
        if (!interview) throw serviceError("面试场次不存在", 404);
        const state = this.store.getAssistantState(job.interviewId) || structuredClone(EMPTY_STATE);
        const target = currentJob.payload.targetLineCount;
        verifySnapshot(interview.lines, currentJob.payload);
        if (state.processedLineCount >= target && (job.mode === "summary" || generatedFollowup)) break;
        const start = state.processedLineCount;
        const chunk = transcriptChunk(interview.lines, start, target, lineOffset, this.chunkChars, this.chunkLines);
        const mode = job.mode === "followup" && chunk.end >= target ? "followup" : "summary";
        const preparation = interview.artifacts?.find((artifact) => artifact.kind === "interview-preparation");
        const result = await this.provider.analyze({
          mode,
          state,
          transcriptLines: chunk.lines,
          contextLines: recentContext(interview.lines, start, 8000),
          outlineMarkdown: preparation?.markdown || interview.resumeMarkdown || "",
          outlineSource: preparation?.markdown ? "interview-preparation" : "resume-background",
          resumeMarkdown: interview.resumeMarkdown || "",
          roleMarkdown: interview.roleMarkdown || "",
          currentRoundFocus: interview.roundFocus || "",
          speakerLabels: interview.speakerLabels || {},
          validationFeedback: currentJob.payload.validationFeedback || "",
          isLatestChunk: chunk.end >= target,
        }, { signal: controller.signal });
        if (generation !== this.generation) return null;
        checkAbort(controller);
        if (!result || !Array.isArray(result.topics) || !Array.isArray(result.followups)) throw new Error("Assistant returned invalid JSON state");
        const latestJob = this.get(job.id);
        const latestInterview = this.store.getInterview(job.interviewId);
        if (!latestInterview || !latestJob) throw serviceError("面试场次不存在", 404);
        verifySnapshot(latestInterview.lines, currentJob.payload);
        const beforeSave = this.store.getAssistantState(job.interviewId) || EMPTY_STATE;
        if (beforeSave.revision !== state.revision) {
          const error = serviceError("面试进度已更新，正在重新整理", 409);
          error.code = "ASSISTANT_STATE_CONFLICT";
          throw error;
        }
        // A historical chunk (or a request extended while the model was running)
        // must not publish a next question for speech we have not caught up to.
        const followups = latestJob.payload.targetLineCount > chunk.end
          ? result.followups.filter((item) => item.source === "manual" && !item.qaId
            && result.topics.some((topic) => topic.id === item.topicId && topic.status === "unasked"))
          : result.followups;
        this.store.saveAssistantState(job.interviewId, {
          ...state,
          topics: result.topics,
          followups,
          ...(Object.hasOwn(result, "focus") ? { focus: result.focus } : {}),
          processedLineCount: Math.max(start, chunk.end),
          updatedAt: new Date().toISOString(),
        }, { expectedRevision: state.revision });
        if (latestJob.payload.validationFeedback) {
          this.store.updateAssistantJob(job.id, { payload: { ...latestJob.payload, validationFeedback: "" } });
        }
        lineOffset = chunk.nextOffset;
        generatedFollowup = mode === "followup" && latestJob.payload.targetLineCount <= chunk.end;
      }
      const result = this.store.getAssistantState(job.interviewId);
      const completed = this.store.updateAssistantJob(job.id, { status: "done", result, error: "" });
      this.logger.info("assistant.succeeded", { jobId: job.id, attempt, processedLineCount: result?.processedLineCount });
      return completed;
    } catch (error) {
      if (generation !== this.generation) return null;
      const latest = this.get(job.id);
      if (!latest) return null;
      if (controller.signal.aborted) {
        const cancelled = latest.status === "cancelled" || !this.stopped;
        return this.store.updateAssistantJob(job.id, {
          status: cancelled ? "cancelled" : "retrying",
          attempts: this.stopped && !cancelled ? job.attempts : attempt,
          error: cancelled ? "已取消本次整理" : "服务重启后继续整理",
        });
      }
      const willRetry = isRetriable(error) && attempt < job.maxAttempts;
      const validationFeedback = validationFeedbackFor(error);
      if (willRetry) this.retryAt.set(job.id, Date.now() + Math.min(5000, 800 * attempt));
      this.logger[willRetry ? "warn" : "error"]("assistant.failed", {
        jobId: job.id, attempt, willRetry, error,
        ...(validationFeedback ? { validationFeedback } : {}),
      });
      return this.store.updateAssistantJob(job.id, {
        status: willRetry ? "retrying" : "error", attempts: attempt, error: error.message || "整理失败",
        ...(validationFeedback ? { payload: { ...latest.payload, validationFeedback } } : {}),
      });
    } finally {
      if (generation === this.generation && this.running.get(job.id)?.controller === controller) {
        this.running.delete(job.id);
        this.schedule();
      }
    }
  }
}

function snapshot(interview, state) {
  return {
    targetLineCount: interview.lines.length,
    baseRevision: state.revision,
    lineDigests: interview.lines.map(lineDigest),
  };
}

function validationFeedbackFor(error) {
  if (typeof error?.validationFeedback === "string") return error.validationFeedback.trim().slice(0, 8000);
  const message = String(error?.message || "");
  return error?.code === "ASSISTANT_INVALID_OUTPUT" || /(?:LLM.*JSON|Assistant returned invalid JSON)/i.test(message)
    ? message.slice(0, 8000) : "";
}

function lineDigest(line) {
  return crypto.createHash("sha256").update(JSON.stringify([line.id, line.text, line.speaker])).digest("hex");
}

function verifySnapshot(lines, payload) {
  if (lines.length < payload.targetLineCount
    || payload.lineDigests.some((digest, index) => lineDigest(lines[index] || {}) !== digest)) {
    throw serviceError("转录内容已改变，请重新发起整理", 422);
  }
}

// An unusually long single ASR line is sent in full across bounded fragments.
// Its cursor advances only after the final fragment; a retry safely revisits it.
function transcriptChunk(lines, start, target, offset, maxChars, maxLines) {
  const result = [];
  let chars = 0;
  let end = start;
  let nextOffset = 0;
  while (end < target && result.length < maxLines && chars < maxChars) {
    const line = lines[end];
    const text = String(line.text || "");
    const from = end === start ? offset : 0;
    const available = maxChars - chars;
    if (result.length && text.length - from > available) break;
    const part = text.slice(from, from + available);
    const partial = from + part.length < text.length;
    result.push({ ...line, text: part, ...((from || partial) ? { fragment: { start: from, end: from + part.length, continues: partial } } : {}) });
    chars += part.length;
    if (partial) { nextOffset = from + part.length; break; }
    end += 1;
  }
  return { lines: result, end, nextOffset };
}

function recentContext(lines, before, maxChars) {
  const result = [];
  let chars = 0;
  for (let index = before - 1; index >= 0 && result.length < 12; index -= 1) {
    const line = lines[index];
    if (chars + String(line.text || "").length > maxChars) break;
    result.unshift(line);
    chars += String(line.text || "").length;
  }
  return result;
}

function serviceError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function checkAbort(controller) {
  if (controller.signal.aborted) throw new Error("Assistant job cancelled");
}
