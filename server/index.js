import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createSecurity } from "./security.js";
import { SqliteStore } from "./storage/sqlite-store.js";
import { createLlmProvider } from "./providers/llm/index.js";
import { createAsrProvider } from "./providers/asr/index.js";
import { AnalysisJobService } from "./services/analysis-job-service.js";
import { createInterviewAnalyzer } from "./services/interview-analysis.js";
import { extractWordPreviewText, isWordAttachment } from "./services/resume-preview.js";
import {
  buildEffectiveProviderConfig,
  normalizeProviderSettingsPatch,
  publicProviderSettings,
} from "./provider-settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.umask(0o077);
const config = loadConfig();
const logger = createLogger(config);
const security = createSecurity(config);
const storeRepository = new SqliteStore(config, logger);
const baseProviderConfig = structuredClone({ asr: config.asr, llm: config.llm });
let storedProviderSettings = storeRepository.getProviderSettings();
applyEffectiveProviderConfig();
const llmProvider = createLlmProvider(config.llm);
const asrProvider = createAsrProvider(config.asr, logger);
const analysisJobService = new AnalysisJobService({
  store: storeRepository,
  provider: createInterviewAnalyzer(llmProvider),
  logger,
});
const PORT = config.port;

appendServerLog("process.started", {
  pid: process.pid,
  node: process.version,
  port: PORT,
});

const app = express();
app.use(security.responseHeaders);
app.use(express.json({ limit: "16mb" }));
app.use("/api", security.httpMiddleware);

app.get("/api/health", (_req, res) => {
  res.json(currentHealth());
});

app.get("/api/provider-settings", (_req, res) => {
  res.json({ settings: publicProviderSettings(config, storedProviderSettings) });
});

app.put("/api/provider-settings", (req, res) => {
  try {
    const nextSettings = normalizeProviderSettingsPatch(storedProviderSettings, req.body || {});
    storedProviderSettings = storeRepository.setProviderSettings(nextSettings);
    applyEffectiveProviderConfig();
    const settings = publicProviderSettings(config, storedProviderSettings);
    appendServerLog("provider_settings.updated", {
      asrConfigured: settings.asr.configured,
      llmConfigured: settings.llm.configured,
    });
    res.json({ settings, health: currentHealth() });
  } catch (error) {
    res.status(400).json({ error: error.message || "保存服务配置失败" });
  }
});

function currentHealth() {
  const asrConfigured = asrProvider.isConfigured();
  const llmConfigured = llmProvider.isConfigured();
  return {
    ok: true,
    asrConfigured,
    llmConfigured,
    llmProvider: config.llm.provider,
    llmModel: config.llm.model,
    asrProvider: config.asr.provider,
    asrResourceId: config.asr.resourceId,
    storage: "sqlite",
    schemaVersion: 3,
    accessMode: config.accessToken ? "token" : "local-only",
    issues: [
      ...(!asrConfigured ? ["ASR_NOT_CONFIGURED"] : []),
      ...(!llmConfigured ? ["LLM_NOT_CONFIGURED"] : []),
    ],
  };
}

function applyEffectiveProviderConfig() {
  const effective = buildEffectiveProviderConfig(baseProviderConfig, storedProviderSettings);
  Object.assign(config.asr, effective.asr);
  Object.assign(config.llm, effective.llm);
}

app.get("/api/store", (_req, res) => {
  try {
    res.json({ store: storeRepository.getStore() });
  } catch (error) {
    appendServerLog("store.read_failed", { error: serializeError(error) });
    res.status(500).json({ error: "读取场次数据失败" });
  }
});

app.put("/api/store", (req, res) => {
  try {
    const nextStore = storeRepository.transaction(() =>
      storeRepository.importStore(req.body?.store || req.body, { replace: true }),
    );
    res.json({ ok: true, store: nextStore, updatedAt: new Date().toISOString() });
  } catch (error) {
    appendServerLog("store.write_failed", { error: serializeError(error) });
    res.status(500).json({ error: error.message || "保存场次数据失败" });
  }
});

app.post("/api/interviews", (req, res) => {
  try {
    const interview = storeRepository.createInterview(req.body || {});
    const nextStore = storeRepository.getStore();
    appendServerLog("interview.created", {
      interviewId: interview.id,
      name: interview.name,
      status: interview.interviewStatus,
      hasResume: Boolean(interview.resumeFile),
      roleChars: interview.roleMarkdown.length,
      resumeChars: interview.resumeMarkdown.length,
    });
    res.status(201).json({ interview, store: nextStore });
  } catch (error) {
    appendServerLog("interview.create_failed", { error: serializeError(error) });
    res.status(500).json({ error: error.message || "创建面试失败" });
  }
});

app.get("/api/interviews", (req, res) => {
  const interviews = storeRepository.listInterviews({
    query: req.query.query,
    status: req.query.status,
    limit: req.query.limit,
  });
  res.json({ interviews });
});

app.get("/api/interviews/:interviewId", (req, res) => {
  const interview = storeRepository.getInterview(req.params.interviewId);
  if (!interview) return res.status(404).json({ error: "面试场次不存在" });
  res.json({ interview });
});

app.put("/api/interviews/:interviewId/active", (req, res) => {
  const interview = storeRepository.setActiveInterview(req.params.interviewId);
  if (!interview) return res.status(404).json({ error: "面试场次不存在" });
  res.json({ activeInterviewId: interview.id });
});

app.get("/api/interviews/:interviewId/context", (req, res) => {
  const interview = storeRepository.getInterviewContext(req.params.interviewId);
  if (!interview) return res.status(404).json({ error: "面试场次不存在" });
  res.json({ interview });
});

app.get("/api/interviews/:interviewId/transcript", (req, res) => {
  const chunk = storeRepository.getTranscriptChunk(req.params.interviewId, {
    offset: req.query.offset,
    limit: req.query.limit,
  });
  if (!chunk) return res.status(404).json({ error: "面试场次不存在" });
  res.json(chunk);
});

app.get("/api/interviews/:interviewId/artifacts", (req, res) => {
  if (!storeRepository.getInterviewContext(req.params.interviewId)) {
    return res.status(404).json({ error: "面试场次不存在" });
  }
  res.json({ artifacts: storeRepository.listArtifacts(req.params.interviewId) });
});

app.put("/api/interviews/:interviewId/artifacts/:kind", (req, res) => {
  try {
    const artifact = storeRepository.upsertArtifact(req.params.interviewId, {
      ...(req.body || {}),
      kind: req.params.kind,
    });
    if (!artifact) return res.status(404).json({ error: "面试场次不存在" });
    res.json({ artifact });
  } catch (error) {
    res.status(400).json({ error: error.message || "保存面试产物失败" });
  }
});

app.get("/api/interviews/:interviewId/harness-sessions", (req, res) => {
  if (!storeRepository.getInterviewContext(req.params.interviewId)) {
    return res.status(404).json({ error: "面试场次不存在" });
  }
  res.json({ sessions: storeRepository.listHarnessSessions(req.params.interviewId) });
});

app.post("/api/interviews/:interviewId/harness-sessions", (req, res) => {
  try {
    const session = storeRepository.linkHarnessSession(req.params.interviewId, req.body || {});
    if (!session) return res.status(404).json({ error: "面试场次不存在" });
    res.status(201).json({ session });
  } catch (error) {
    res.status(400).json({ error: error.message || "关联 AI 会话失败" });
  }
});

app.patch("/api/interviews/:interviewId", (req, res) => {
  try {
    const interview = storeRepository.patchInterview(req.params.interviewId, req.body || {});
    if (!interview) return res.status(404).json({ error: "面试场次不存在" });
    res.json({ interview });
  } catch (error) {
    res.status(400).json({ error: error.message || "更新面试失败" });
  }
});

app.delete("/api/interviews/:interviewId", (req, res) => {
  const deleted = storeRepository.softDeleteInterview(req.params.interviewId);
  if (!deleted) return res.status(404).json({ error: "面试场次不存在" });
  res.json({ ok: true });
});

app.post("/api/interviews/:interviewId/lines", (req, res) => {
  try {
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (!lines.length || lines.length > 200) {
      return res.status(400).json({ error: "转录行数量无效" });
    }
    const interview = storeRepository.appendLines(req.params.interviewId, lines);
    if (!interview) return res.status(404).json({ error: "面试场次不存在" });
    res.status(201).json({ interview });
  } catch (error) {
    res.status(400).json({ error: error.message || "保存转录失败" });
  }
});

app.put("/api/interviews/:interviewId/resume", (req, res) => {
  try {
    const resumeFile = storeRepository.saveAttachment(req.params.interviewId, req.body?.resumeFile || req.body);
    if (!resumeFile) return res.status(404).json({ error: "面试场次不存在" });
    storeRepository.patchInterview(req.params.interviewId, { resumeNotes: [] });
    res.json({ resumeFile });
  } catch (error) {
    res.status(400).json({ error: error.message || "保存简历失败" });
  }
});

app.delete("/api/interviews/:interviewId/resume", (req, res) => {
  storeRepository.removeAttachment(req.params.interviewId);
  res.json({ ok: true });
});

app.get("/api/attachments/:attachmentId", (req, res) => {
  const attachment = storeRepository.getAttachment(req.params.attachmentId);
  if (!attachment || !fs.existsSync(attachment.absolutePath)) {
    return res.status(404).json({ error: "附件不存在" });
  }
  res.type(attachment.type);
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`);
  res.sendFile(attachment.absolutePath);
});

app.get("/api/attachments/:attachmentId/preview-text", async (req, res) => {
  const attachment = storeRepository.getAttachment(req.params.attachmentId);
  if (!attachment || !fs.existsSync(attachment.absolutePath)) {
    return res.status(404).json({ error: "附件不存在" });
  }
  if (!isWordAttachment(attachment)) {
    return res.status(415).json({ error: "当前附件不是 Word 文档" });
  }
  if (attachment.previewText) return res.json({ previewText: attachment.previewText });

  try {
    const previewText = await extractWordPreviewText(attachment.absolutePath);
    if (!previewText) return res.status(422).json({ error: "Word 文档中没有可预览的文字" });
    storeRepository.setAttachmentPreviewText(attachment.id, previewText);
    res.json({ previewText });
  } catch (error) {
    appendServerLog("resume.preview_failed", {
      attachmentId: attachment.id,
      error: serializeError(error),
    });
    res.status(422).json({ error: "Word 简历预览生成失败，请下载查看原文件" });
  }
});

app.post("/api/backups", (_req, res) => {
  const backup = storeRepository.backup();
  res.status(201).json({ ok: true, file: path.basename(backup) });
});

app.get("/api/export", (_req, res) => {
  try {
    const exported = storeRepository.exportStore();
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="interview-workbench-${date}.json"`);
    res.send(JSON.stringify(exported));
  } catch (error) {
    appendServerLog("store.export_failed", { error: serializeError(error) });
    res.status(500).json({ error: "导出备份失败" });
  }
});

app.post("/api/import", (req, res) => {
  try {
    const nextStore = storeRepository.importBackup(req.body?.store || req.body);
    appendServerLog("store.imported", { interviews: nextStore.interviews.length });
    res.json({ ok: true, store: nextStore });
  } catch (error) {
    appendServerLog("store.import_failed", { error: serializeError(error) });
    res.status(400).json({ error: error.message || "导入备份失败" });
  }
});

app.post("/api/jds", (req, res) => {
  try {
    const jd = storeRepository.upsertJd(req.body || {});
    res.status(201).json({ jd });
  } catch (error) {
    res.status(400).json({ error: error.message || "保存 JD 失败" });
  }
});

app.post("/api/status-options", (req, res) => {
  const value = String(req.body?.value || "").trim();
  if (!value || value.length > 24) return res.status(400).json({ error: "状态名称无效" });
  storeRepository.addStatus(value);
  res.status(201).json({ value });
});

app.post("/api/analyze-jobs", (req, res) => {
  try {
    const payload = normalizeAnalyzePayload(req.body || {});

    if (!llmProvider.isConfigured()) {
      res.status(400).json({ error: "LLM API key 未配置" });
      return;
    }

    if (!payload.transcriptSlice.trim()) {
      res.status(400).json({ error: "这一段还没有可处理的转录文本" });
      return;
    }

    const fallbackInterviewId = storeRepository.getStore().activeInterviewId;
    const job = analysisJobService.enqueue({
      ...payload,
      interviewId: req.body?.interviewId || fallbackInterviewId,
      cardId: req.body?.cardId,
      segmentStart: req.body?.segmentStart,
      segmentEnd: req.body?.segmentEnd,
      idempotencyKey: req.get("Idempotency-Key") || req.body?.idempotencyKey,
    });

    res.status(202).json(publicAnalyzeJob(job));
  } catch (error) {
    console.error("[analyze-job:create]", error);
    res.status(500).json({ error: error.message || "创建分析任务失败" });
  }
});

app.get("/api/analyze-jobs/:jobId", (req, res) => {
  const job = analysisJobService.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "分析任务不存在或已过期" });
    return;
  }
  res.json(publicAnalyzeJob(job));
});

app.delete("/api/analyze-jobs/:jobId", (req, res) => {
  const job = analysisJobService.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "分析任务不存在或已过期" });
    return;
  }
  res.json(publicAnalyzeJob(analysisJobService.cancel(job.id)));
});

app.post("/api/analyze-jobs/:jobId/retry", (req, res) => {
  const job = analysisJobService.retry(req.params.jobId);
  if (!job) return res.status(409).json({ error: "当前任务不可重试" });
  res.status(202).json(publicAnalyzeJob(job));
});

const distDir = path.join(__dirname, "..", "dist");
app.use(express.static(distDir));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/ws")) {
    next();
    return;
  }
  res.sendFile(path.join(distDir, "index.html"), (error) => {
    if (error) next();
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  if (!request.url?.startsWith("/ws/asr") || !security.validateUpgrade(request)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (client) => {
    wss.emit("connection", client, request);
  });
});

wss.on("connection", (client) => {
  const session = asrProvider.createSession(client);
  session.start();
});

server.listen(PORT, config.host, () => {
  console.log(`Interview workbench backend listening on http://${config.host}:${PORT}`);
  appendServerLog("server.listening", { pid: process.pid, port: PORT, host: config.host });
});

server.on("error", (error) => {
  appendServerLog("server.error", {
    pid: process.pid,
    port: PORT,
    error: serializeError(error),
  });
  console.error("[server]", error);
  process.exit(1);
});

analysisJobService.start();
registerProcessLogging();

function normalizeAnalyzePayload(body) {
  return {
    resumeMarkdown: body.resumeMarkdown || "",
    roleMarkdown: body.roleMarkdown || "",
    transcriptSlice: body.transcriptSlice || "",
    askedQuestions: Array.isArray(body.askedQuestions) ? body.askedQuestions : [],
    previousCards: Array.isArray(body.previousCards) ? body.previousCards : [],
  };
}

function publicAnalyzeJob(job) {
  return {
    id: job.id,
    interviewId: job.interviewId,
    cardId: job.cardId,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    markdown: job.markdown,
    detectedQuestions: job.detectedQuestions || [],
    error: job.error,
    segmentStart: job.payload?.segmentStart,
    segmentEnd: job.payload?.segmentEnd,
  };
}

function appendServerLog(event, fields = {}) {
  const level = /failed|error|exception/.test(event) ? "error" : "info";
  logger[level](`server.${event}`, fields);
}

function registerProcessLogging() {
  process.on("uncaughtException", (error) => {
    appendServerLog("process.uncaught_exception", {
      pid: process.pid,
      error: serializeError(error),
    });
    console.error("[uncaughtException]", error);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    appendServerLog("process.unhandled_rejection", {
      pid: process.pid,
      error: serializeError(reason),
    });
    console.error("[unhandledRejection]", reason);
  });

  process.on("warning", (warning) => {
    appendServerLog("process.warning", {
      pid: process.pid,
      error: serializeError(warning),
    });
  });

  process.on("exit", (code) => {
    appendServerLog("process.exit", { pid: process.pid, code });
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      appendServerLog("process.signal", { pid: process.pid, signal });
      analysisJobService.stop();
      for (const client of wss.clients) client.close(1001, "Server shutting down");
      const exitCode = signal === "SIGINT" ? 130 : 143;
      const forceExit = setTimeout(() => process.exit(exitCode), 3000);
      forceExit.unref();
      server.close(async () => {
        const deadline = Date.now() + 2500;
        while (analysisJobService.running.size && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        try {
          storeRepository.close();
        } finally {
          process.exit(exitCode);
        }
      });
    });
  }
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      stack: error.stack,
    };
  }
  if (typeof error === "object" && error) {
    return {
      name: error.name,
      message: error.message || JSON.stringify(error).slice(0, 500),
      code: error.code,
    };
  }
  return { message: String(error) };
}
