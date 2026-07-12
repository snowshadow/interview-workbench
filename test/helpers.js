import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createTestConfig(prefix = "interview-workbench-") {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dataDir,
    attachmentDir: path.join(dataDir, "attachments"),
    databaseFile: path.join(dataDir, "workbench.sqlite"),
    legacyStoreFile: path.join(dataDir, "interview-store.json"),
    backupDir: path.join(dataDir, "backups"),
    logDir: path.join(dataDir, "logs"),
    logLevel: "silent",
    logMaxBytes: 65536,
    logMaxFiles: 2,
  };
}

export function cleanupTestConfig(config) {
  fs.rmSync(config.dataDir, { recursive: true, force: true });
}

export const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function sampleInterview(overrides = {}) {
  return {
    id: "candidate-1",
    name: "示例候选人",
    interviewStatus: "已安排",
    scheduledAt: "2026-07-12T02:00:00.000Z",
    resumeMarkdown: "简历预分析",
    roleMarkdown: "岗位要求",
    resumeNotes: [],
    lines: [
      { id: "line-1", text: "请介绍最近的项目", speaker: "1" },
      { id: "line-2", text: "我负责 Agent 运行时", speaker: "2" },
    ],
    cards: [],
    askedQuestions: [],
    lastProcessedLineCount: 0,
    speakerLabels: {},
    ...overrides,
  };
}
