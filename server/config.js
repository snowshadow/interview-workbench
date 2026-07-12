import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(serverDir, "..");

export function loadConfig(env = process.env) {
  const port = readInteger(env.PORT, 8787, 1, 65535);
  const host = String(env.HOST || "127.0.0.1").trim();
  const accessToken = String(env.WORKBENCH_ACCESS_TOKEN || "").trim();
  const dataDir = path.resolve(projectDir, env.WORKBENCH_DATA_DIR || "data");
  const allowedOrigins = parseList(env.WORKBENCH_ALLOWED_ORIGINS);
  if (!allowedOrigins.length) {
    allowedOrigins.push(
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      "http://127.0.0.1:5173",
      "http://localhost:5173",
    );
  }

  if (!isLoopbackHost(host) && !accessToken) {
    throw new Error(
      "WORKBENCH_ACCESS_TOKEN is required when HOST is not a loopback address",
    );
  }

  return {
    projectDir,
    port,
    host,
    accessToken,
    allowedOrigins: new Set(allowedOrigins),
    dataDir,
    attachmentDir: path.join(dataDir, "attachments"),
    databaseFile: path.join(dataDir, "workbench.sqlite"),
    legacyStoreFile: path.join(dataDir, "interview-store.json"),
    backupDir: path.join(dataDir, "backups"),
    logDir: path.join(dataDir, "logs"),
    logLevel: String(env.WORKBENCH_LOG_LEVEL || "info").toLowerCase(),
    logMaxBytes: readInteger(env.WORKBENCH_LOG_MAX_BYTES, 5 * 1024 * 1024, 65536),
    logMaxFiles: readInteger(env.WORKBENCH_LOG_MAX_FILES, 3, 1, 20),
    llm: {
      provider: String(env.LLM_PROVIDER || "openai-compatible"),
      apiKey: String(env.DEEPSEEK_API_KEY || env.LLM_API_KEY || ""),
      baseUrl: String(
        env.DEEPSEEK_BASE_URL || env.LLM_BASE_URL || "https://api.deepseek.com",
      ).replace(/\/$/, ""),
      model: String(env.DEEPSEEK_MODEL || env.LLM_MODEL || "deepseek-chat"),
      timeoutMs: readInteger(env.DEEPSEEK_TIMEOUT_MS, 75000, 1000, 300000),
    },
    asr: {
      provider: String(env.ASR_PROVIDER || "volcengine"),
      apiKey: String(env.VOLCENGINE_ASR_API_KEY || ""),
      appKey: String(env.VOLCENGINE_ASR_APP_KEY || ""),
      accessKey: String(env.VOLCENGINE_ASR_ACCESS_KEY || ""),
      resourceId: String(
        env.VOLCENGINE_ASR_RESOURCE_ID || "volc.seedasr.sauc.duration",
      ),
      url: String(
        env.VOLCENGINE_ASR_URL ||
          "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
      ),
    },
  };
}

export function isLoopbackHost(host) {
  return ["127.0.0.1", "::1", "localhost"].includes(host);
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readInteger(value, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
