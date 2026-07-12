import fs from "node:fs";
import path from "node:path";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger(config) {
  fs.mkdirSync(config.logDir, { recursive: true, mode: 0o700 });
  const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

  function write(level, event, fields = {}) {
    if ((LEVELS[level] ?? LEVELS.info) < threshold) return;
    const entry = redact({
      ts: new Date().toISOString(),
      level,
      event,
      ...fields,
    });
    const file = path.join(config.logDir, `${event.split(".")[0] || "server"}.jsonl`);
    rotate(file, config.logMaxBytes, config.logMaxFiles);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

function rotate(file, maxBytes, maxFiles) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < maxBytes) return;
    if (maxFiles <= 1) {
      fs.unlinkSync(file);
      return;
    }
    const oldest = `${file}.${maxFiles - 1}`;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    for (let index = maxFiles - 2; index >= 1; index -= 1) {
      const source = `${file}.${index}`;
      const target = `${file}.${index + 1}`;
      if (fs.existsSync(source)) fs.renameSync(source, target);
    }
    fs.renameSync(file, `${file}.1`);
  } catch {
    // Logging must not crash the interview session.
  }
}

function redact(value, key = "") {
  if (value == null) return value;
  if (/name|transcript|resume|markdown|content|authorization|api.?key|token/i.test(key)) {
    if (typeof value === "string") return `[redacted:${value.length}]`;
  }
  if (typeof value === "string" && /message|stack/i.test(key)) return scrubMessage(value);
  if (value instanceof Error) {
    return { name: value.name, message: scrubMessage(value.message), code: value.code };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redact(childValue, childKey),
      ]),
    );
  }
  return value;
}

function scrubMessage(value) {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(sk|key|token)-[A-Za-z0-9_-]{8,}\b/gi, "$1-[redacted]")
    .slice(0, 2000);
}
