import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createLogger } from "../server/logger.js";
import { cleanupTestConfig, createTestConfig } from "./helpers.js";

test("logs redact sensitive fields and cap rotated files", () => {
  const config = createTestConfig("interview-logs-");
  config.logLevel = "debug";
  config.logMaxBytes = 220;
  config.logMaxFiles = 2;
  const logger = createLogger(config);
  try {
    for (let index = 0; index < 20; index += 1) {
      logger.error("server.test", {
        candidateName: "示例候选人",
        transcript: "敏感转录",
        error: new Error("request failed with Bearer secret-token-12345678"),
        index,
      });
    }
    const files = fs.readdirSync(config.logDir).filter((name) => name.startsWith("server.jsonl"));
    assert.ok(files.length <= 2);
    const content = files.map((name) => fs.readFileSync(path.join(config.logDir, name), "utf8")).join("\n");
    assert.equal(content.includes("示例候选人"), false);
    assert.equal(content.includes("敏感转录"), false);
    assert.equal(content.includes("secret-token-12345678"), false);
    assert.ok(content.includes("[redacted"));
    for (const name of files) {
      assert.equal(fs.statSync(path.join(config.logDir, name)).mode & 0o777, 0o600);
    }
  } finally {
    cleanupTestConfig(config);
  }
});
