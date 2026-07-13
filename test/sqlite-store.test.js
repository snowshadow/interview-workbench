import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SqliteStore } from "../server/storage/sqlite-store.js";
import {
  cleanupTestConfig,
  createTestConfig,
  sampleInterview,
  silentLogger,
} from "./helpers.js";

test("legacy JSON migrates without losing interviews and extracts attachments", () => {
  const config = createTestConfig();
  const pdf = Buffer.from("%PDF-1.4\nsynthetic test file");
  const legacy = {
    activeInterviewId: "candidate-1",
    statusOptions: ["自定义状态"],
    jdLibrary: [{ id: "jd-1", name: "Agent 工程师", content: "JD" }],
    interviews: [sampleInterview({
      interviewStatus: "自定义状态",
      resumeFile: {
        name: "resume.pdf",
        type: "application/pdf",
        size: pdf.length,
        dataUrl: `data:application/pdf;base64,${pdf.toString("base64")}`,
      },
    })],
  };
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(config.legacyStoreFile, JSON.stringify(legacy));

  const store = new SqliteStore(config, silentLogger);
  try {
    const migrated = store.getStore();
    assert.equal(migrated.interviews.length, 1);
    assert.equal(migrated.interviews[0].lines.length, 2);
    assert.equal(migrated.interviews[0].resumeFile.name, "resume.pdf");
    assert.ok(migrated.statusOptions.includes("自定义状态"));
    const attachment = store.getAttachment(migrated.interviews[0].resumeFile.id);
    assert.deepEqual(fs.readFileSync(attachment.absolutePath), pdf);
    assert.equal(fs.statSync(config.legacyStoreFile).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(config.backupDir).filter((name) => name.endsWith(".json")).length, 1);
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("full export and import preserve attachment bytes", () => {
  const sourceConfig = createTestConfig("interview-source-");
  const targetConfig = createTestConfig("interview-target-");
  const source = new SqliteStore(sourceConfig, silentLogger);
  const target = new SqliteStore(targetConfig, silentLogger);
  try {
    source.createInterview(sampleInterview());
    const bytes = Buffer.from("%PDF-1.4\nbackup roundtrip");
    source.saveAttachment("candidate-1", {
      name: "resume.pdf",
      type: "application/pdf",
      dataUrl: `data:application/pdf;base64,${bytes.toString("base64")}`,
    });
    const exported = source.exportStore();
    target.importBackup(exported);
    const imported = target.getInterview("candidate-1");
    const attachment = target.getAttachment(imported.resumeFile.id);
    assert.deepEqual(fs.readFileSync(attachment.absolutePath), bytes);
  } finally {
    source.close();
    target.close();
    cleanupTestConfig(sourceConfig);
    cleanupTestConfig(targetConfig);
  }
});

test("deleted interview attachments are no longer addressable", () => {
  const config = createTestConfig();
  const store = new SqliteStore(config, silentLogger);
  try {
    store.createInterview(sampleInterview());
    const resume = store.saveAttachment("candidate-1", {
      name: "resume.pdf",
      type: "application/pdf",
      dataUrl: `data:application/pdf;base64,${Buffer.from("pdf").toString("base64")}`,
    });
    assert.ok(store.getAttachment(resume.id));
    store.softDeleteInterview("candidate-1");
    assert.equal(store.getAttachment(resume.id), null);
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("interview artifacts and harness sessions persist and survive export", () => {
  const sourceConfig = createTestConfig("interview-artifacts-source-");
  const targetConfig = createTestConfig("interview-artifacts-target-");
  const source = new SqliteStore(sourceConfig, silentLogger);
  const target = new SqliteStore(targetConfig, silentLogger);
  try {
    source.createInterview(sampleInterview());
    const first = source.upsertArtifact("candidate-1", {
      kind: "interview-summary",
      title: "Post-interview report",
      markdown: "# Summary\n\nProceed.",
      sourceHarness: "codex",
      sourceSessionId: "thread-1",
    });
    source.upsertArtifact("candidate-1", {
      kind: "interview-summary",
      markdown: "# Summary\n\nDo not proceed.",
      sourceHarness: "codex",
      sourceSessionId: "thread-1",
    });
    const session = source.linkHarnessSession("candidate-1", {
      harness: "codex",
      sessionId: "thread-1",
      label: "Agent engineer - candidate",
      cwd: "/workspace",
    });

    assert.equal(source.listArtifacts("candidate-1").length, 1);
    assert.equal(source.listArtifacts("candidate-1")[0].id, first.id);
    assert.match(source.listArtifacts("candidate-1")[0].markdown, /Do not proceed/);
    assert.equal(session.isPrimary, true);
    assert.equal(source.getInterviewContext("candidate-1").lines, undefined);

    target.importBackup(source.exportStore());
    const imported = target.getInterview("candidate-1");
    assert.equal(imported.artifacts[0].kind, "interview-summary");
    assert.equal(imported.harnessSessions[0].sessionId, "thread-1");
  } finally {
    source.close();
    target.close();
    cleanupTestConfig(sourceConfig);
    cleanupTestConfig(targetConfig);
  }
});

test("interview listing and transcript pagination avoid loading the full transcript", () => {
  const config = createTestConfig();
  const store = new SqliteStore(config, silentLogger);
  try {
    store.createInterview(sampleInterview());
    const matches = store.listInterviews({ query: "示例", status: "已安排" });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].transcriptLineCount, 2);

    const firstPage = store.getTranscriptChunk("candidate-1", { offset: 0, limit: 1 });
    assert.equal(firstPage.lines.length, 1);
    assert.equal(firstPage.total, 2);
    assert.equal(firstPage.nextOffset, 1);
    const secondPage = store.getTranscriptChunk("candidate-1", { offset: 1, limit: 1 });
    assert.equal(secondPage.nextOffset, null);
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("provider settings persist locally but stay out of JSON exports", () => {
  const config = createTestConfig();
  const store = new SqliteStore(config, silentLogger);
  try {
    store.setProviderSettings({
      asr: { apiKey: "private-asr-key" },
      llm: { apiKey: "private-llm-key" },
    });
    assert.equal(store.getProviderSettings().llm.apiKey, "private-llm-key");
    const exported = JSON.stringify(store.exportStore());
    assert.equal(exported.includes("private-asr-key"), false);
    assert.equal(exported.includes("private-llm-key"), false);
    assert.equal(fs.statSync(config.databaseFile).mode & 0o777, 0o600);
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});
