import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
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

test("JD role short names persist without depending on known job titles", () => {
  const config = createTestConfig("interview-jd-short-name-");
  const first = new SqliteStore(config, silentLogger);
  try {
    const saved = first.upsertJd({
      id: "jd-quant",
      name: "量化策略研究负责人",
      shortName: " 量化 ",
      content: "# JD",
    });
    assert.equal(saved.shortName, "量化");
    assert.equal(first.getStore().jdLibrary[0].shortName, "量化");
    first.upsertJd({
      id: "jd-quant",
      name: "量化策略研究负责人",
      content: "# 更新后的 JD",
    });
    assert.equal(first.getStore().jdLibrary[0].shortName, "量化");
    first.upsertJd({
      id: "jd-quant",
      name: "量化策略研究负责人",
      shortName: "",
      content: "# 更新后的 JD",
    });
    assert.equal(first.getStore().jdLibrary[0].shortName, "");
    first.upsertJd({
      id: "jd-quant",
      name: "量化策略研究负责人",
      shortName: "量化",
      content: "# 更新后的 JD",
    });
  } finally {
    first.close();
  }

  const reopened = new SqliteStore(config, silentLogger);
  try {
    assert.equal(reopened.getStore().jdLibrary[0].shortName, "量化");
  } finally {
    reopened.close();
    cleanupTestConfig(config);
  }
});

test("replace import rejects invalid payloads without deleting existing rows", () => {
  const config = createTestConfig("interview-replace-guard-");
  const store = new SqliteStore(config, silentLogger);
  try {
    store.createInterview(sampleInterview());
    assert.equal(store.getStore().interviews.length, 1);
    for (const payload of [{}, null, [], { interviews: "nope" }]) {
      assert.throws(() => store.importStore(payload, { replace: true }), {
        code: "INVALID_STORE_FORMAT",
        message: /保存数据格式无效/,
      });
    }
    assert.throws(() => store.importBackup({}), /备份文件格式无效/);
    assert.equal(store.getStore().interviews.length, 1);
    store.importStore({ interviews: [] }, { replace: true });
    assert.equal(store.getStore().interviews.length, 0);
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("invalid legacy JSON does not wipe an existing sqlite store", () => {
  const config = createTestConfig("interview-legacy-guard-");
  const first = new SqliteStore(config, silentLogger);
  first.createInterview(sampleInterview());
  first.close();
  fs.writeFileSync(config.legacyStoreFile, JSON.stringify({ not: "a store" }));
  const second = new SqliteStore(config, silentLogger);
  try {
    assert.equal(second.getStore().interviews.length, 1);
  } finally {
    second.close();
    cleanupTestConfig(config);
  }
});

test("existing data directories are tightened to 0700", () => {
  const config = createTestConfig("interview-dir-mode-");
  fs.chmodSync(config.dataDir, 0o755);
  const store = new SqliteStore(config, silentLogger);
  try {
    assert.equal(fs.statSync(config.dataDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(config.attachmentDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(config.backupDir).mode & 0o777, 0o700);
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
    source.createInterview(sampleInterview({
      jdDraftName: "量化策略研究负责人",
      roleShortName: "量化",
      durationMinutes: 90,
    }));
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
    assert.equal(imported.roleShortName, "量化");
    assert.equal(imported.durationMinutes, 90);
    assert.equal(target.getApplication(imported.applicationId).roleShortName, "量化");
    assert.deepEqual(fs.readFileSync(attachment.absolutePath), bytes);
  } finally {
    source.close();
    target.close();
    cleanupTestConfig(sourceConfig);
    cleanupTestConfig(targetConfig);
  }
});

test("archived application attachments are no longer addressable", () => {
  const config = createTestConfig();
  const store = new SqliteStore(config, silentLogger);
  try {
    store.createInterview(sampleInterview());
    const resume = store.saveAttachment("candidate-1", {
      name: "resume.pdf",
      type: "application/pdf",
      dataUrl: `data:application/pdf;base64,${Buffer.from("%PDF-1.4\ndeleted").toString("base64")}`,
    });
    assert.ok(store.getAttachment(resume.id));
    store.softDeleteApplication("candidate-1");
    assert.equal(store.getAttachment(resume.id), null);
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("new interviews do not replace the active interview unless explicitly requested", () => {
  const config = createTestConfig();
  const store = new SqliteStore(config, silentLogger);
  try {
    const scheduledInterview = (id, name, activate = false) =>
      sampleInterview({ id, name, activate, lines: [], cards: [], askedQuestions: [] });
    const created = store.createInterview(scheduledInterview("first", "第一场"));
    assert.equal(created.name, "第一场");
    assert.equal(created.roleMarkdown, "岗位要求");
    store.createInterview(scheduledInterview("second", "第二场"));
    assert.equal(store.getStore().activeInterviewId, "first");

    store.setActiveInterview("second");
    assert.equal(store.getStore().activeInterviewId, "second");

    store.createInterview(scheduledInterview("third", "第三场", true));
    assert.equal(store.getStore().activeInterviewId, "third");
    assert.equal(store.setActiveInterview("missing"), null);
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
      includeInCrossRoundContext: true,
      sourceHarness: "codex",
      sourceSessionId: "thread-1",
    });
    source.upsertArtifact("candidate-1", {
      kind: "interview-summary",
      markdown: "# Summary\n\nDo not proceed.",
      sourceHarness: "codex",
      sourceSessionId: "thread-1",
    });
    source.upsertArtifact("candidate-1", {
      kind: "resume-screening",
      markdown: "旧轮次中的筛选结论",
    });
    source.upsertApplicationArtifact("candidate-1", {
      kind: "resume-screening",
      markdown: "更新后的流程级筛选结论",
      includeInCrossRoundContext: false,
    });
    const session = source.linkHarnessSession("candidate-1", {
      harness: "codex",
      sessionId: "thread-1",
      label: "Agent engineer - candidate",
      cwd: "/workspace",
    });

    const summary = source.listArtifacts("candidate-1")
      .find((artifact) => artifact.kind === "interview-summary");
    assert.equal(summary.id, first.id);
    assert.match(summary.markdown, /Do not proceed/);
    assert.equal(summary.includeInCrossRoundContext, true);
    assert.equal(session.isPrimary, true);
    assert.equal(source.getInterviewContext("candidate-1").lines, undefined);

    target.importBackup(source.exportStore());
    const imported = target.getInterview("candidate-1");
    assert.ok(imported.artifacts.some((artifact) => artifact.kind === "interview-summary"));
    assert.equal(
      imported.artifacts.find((artifact) => artifact.kind === "interview-summary")
        ?.includeInCrossRoundContext,
      true,
    );
    assert.equal(imported.harnessSessions[0].sessionId, "thread-1");
    assert.equal(
      target.getApplicationContext("candidate-1").applicationArtifacts
        .find((artifact) => artifact.kind === "resume-screening")?.markdown,
      "更新后的流程级筛选结论",
    );
    assert.equal(
      target.getApplicationContext("candidate-1").applicationArtifacts
        .find((artifact) => artifact.kind === "resume-screening")
        ?.includeInCrossRoundContext,
      false,
    );
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
    const matches = store.listInterviews({
      query: "示例",
      applicationStatus: "招聘中",
      roundStatus: "已结束",
    });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].applicationStatus, "招聘中");
    assert.equal(matches[0].roundStatus, "已结束");
    assert.equal(matches[0].transcriptLineCount, 2);
    assert.equal(store.listInterviews({ roundStatus: "已取消" }).length, 0);
    assert.equal(store.listInterviews({ status: "招聘中" }).length, 1);

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

test("getStore inlines transcript only for the active interview", () => {
  const config = createTestConfig();
  const store = new SqliteStore(config, silentLogger);
  try {
    store.createInterview(sampleInterview({ id: "candidate-1", activate: true }));
    store.createInterview(sampleInterview({
      id: "candidate-2",
      name: "另一位候选人",
      lines: [
        { id: "line-3", text: "请介绍团队规模", speaker: "1" },
        { id: "line-4", text: "十人平台组", speaker: "2" },
      ],
    }));

    const slim = store.getStore();
    assert.equal(slim.activeInterviewId, "candidate-1");
    const active = slim.interviews.find((item) => item.id === "candidate-1");
    const inactive = slim.interviews.find((item) => item.id === "candidate-2");
    assert.equal(active.lines.length, 2);
    assert.equal(active.transcriptLineCount, 2);
    assert.equal(inactive.lines, undefined);
    assert.equal(inactive.transcriptLineCount, 2);

    const exported = store.exportStore();
    for (const interview of exported.interviews) {
      assert.equal(interview.lines.length, 2);
    }
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("nested transactions roll back only the inner savepoint", () => {
  const config = createTestConfig();
  const store = new SqliteStore(config, silentLogger);
  try {
    const result = store.transaction(() => {
      store.createInterview(sampleInterview({ id: "candidate-1", activate: true }));
      assert.throws(
        () => store.transaction(() => {
          store.createInterview(sampleInterview({ id: "candidate-2", name: "会被回滚", lines: [] }));
          throw new Error("inner failure");
        }),
        /inner failure/,
      );
      return store.getStore();
    });
    assert.equal(result.interviews.length, 1);
    assert.equal(store.getInterview("candidate-1").id, "candidate-1");
    assert.equal(store.getInterview("candidate-2"), null);
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("patchInterview never rewinds the analysis cursor", () => {
  const config = createTestConfig();
  const store = new SqliteStore(config, silentLogger);
  try {
    store.createInterview(sampleInterview({ id: "candidate-1", lastProcessedLineCount: 5 }));
    const rewound = store.patchInterview("candidate-1", { lastProcessedLineCount: 2, name: "改名" });
    assert.equal(rewound.lastProcessedLineCount, 5);
    assert.equal(rewound.name, "改名");
    const advanced = store.patchInterview("candidate-1", { lastProcessedLineCount: 9 });
    assert.equal(advanced.lastProcessedLineCount, 9);
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("applications own shared fields while rounds keep independent lifecycle data", () => {
  const config = createTestConfig();
  const store = new SqliteStore(config, silentLogger);
  try {
    store.upsertJd({
      id: "jd-quant",
      name: "量化策略研究负责人",
      shortName: "量化",
      content: "# Agent JD",
    });
    const application = store.createApplication({
      id: "application-1",
      name: "同一位候选人",
      resumeMarkdown: "# 原简历分析",
      roleMarkdown: "# Agent JD",
      selectedJdId: "jd-quant",
      jdDraftName: "量化策略研究负责人",
      roleShortName: "量化",
      firstRound: { id: "round-1", roundLabel: "技术一面", durationMinutes: 90 },
    });
    assert.equal(application.rounds.length, 1);
    assert.equal(application.rounds[0].applicationId, "application-1");
    assert.equal(application.applicationStatus, "招聘中");
    assert.equal(store.getInterview("round-1").roleShortName, "量化");
    assert.equal(application.rounds[0].durationMinutes, 90);
    assert.equal(application.rounds[0].roundStatus, "待安排");
    store.upsertJd({
      id: "jd-quant",
      name: "量化策略研究负责人",
      shortName: "策略库",
      content: "# Agent JD",
    });
    assert.equal(store.getApplication("application-1").roleShortName, "量化");
    assert.throws(
      () => store.createApplication({ id: "application-1", name: "不得覆盖" }),
      (error) => error.code === "APPLICATION_ID_CONFLICT",
    );
    assert.equal(store.getApplication("application-1").name, "同一位候选人");

    const secondRound = store.createInterviewRound("application-1", {
      id: "round-2",
      roundLabel: "业务二面",
      scheduledAt: "2026-08-08T02:00:00.000Z",
      durationMinutes: 45,
      roundFocus: "验证跨轮风险",
      roundOrder: 99,
      outcome: "调用方不得预填",
      sessionStartedAt: "2026-08-08T02:00:00.000Z",
      lines: [{ id: "copied-line", text: "不得复制旧转写" }],
      cards: [{ id: "copied-card", markdown: "不得复制旧卡片" }],
      askedQuestions: ["不得复制旧问题"],
      lastProcessedLineCount: 99,
      speakerLabels: { 1: "旧说话人" },
      artifacts: [{ kind: "interview-summary", markdown: "不得复制旧总结" }],
      harnessSessions: [{ harness: "codex", sessionId: "old-session" }],
      resumeFile: {
        name: "injected.pdf",
        type: "application/pdf",
        dataUrl: `data:application/pdf;base64,${Buffer.from("injected").toString("base64")}`,
      },
    });
    assert.equal(secondRound.roundOrder, 2);
    assert.equal(secondRound.roleShortName, "量化");
    assert.equal(secondRound.roundStatus, "已安排");
    assert.equal(secondRound.durationMinutes, 45);
    assert.equal(secondRound.outcome, "");
    assert.equal(secondRound.sessionStartedAt, null);
    assert.deepEqual(secondRound.lines, []);
    assert.deepEqual(secondRound.cards, []);
    assert.deepEqual(secondRound.askedQuestions, []);
    assert.equal(secondRound.lastProcessedLineCount, 0);
    assert.deepEqual(secondRound.speakerLabels, {});
    assert.deepEqual(secondRound.artifacts, []);
    assert.deepEqual(secondRound.harnessSessions, []);
    assert.equal(store.getApplication("application-1").resumeFile, null);
    assert.throws(
      () => store.createInterviewRound("application-1", { id: "round-1", roundLabel: "不得覆盖" }),
      (error) => error.code === "INTERVIEW_ID_CONFLICT",
    );
    assert.equal(store.getInterview("round-1").roundLabel, "技术一面");

    const applicationSummary = store.listApplications({ query: "同一位", status: "招聘中" })[0];
    assert.equal(applicationSummary.id, "application-1");
    assert.equal(applicationSummary.roundCount, 2);
    assert.equal("resumeMarkdown" in applicationSummary, false);
    assert.equal("roleMarkdown" in applicationSummary, false);
    assert.equal("resumeNotes" in applicationSummary, false);

    store.patchApplication("application-1", {
      name: "候选人（更新）",
      resumeMarkdown: "# 更新后的共享分析",
      roleShortName: "策略",
    });
    assert.equal(store.getInterview("round-1").name, "候选人（更新）");
    assert.equal(store.getInterview("round-2").resumeMarkdown, "# 更新后的共享分析");
    assert.equal(store.getInterview("round-1").roleShortName, "策略");
    assert.equal(store.getInterview("round-2").roleShortName, "策略");

    store.patchInterview("round-2", {
      roleMarkdown: "# 更新后的共享 JD",
      roleShortName: "研究",
      outcome: "通过",
      durationMinutes: 75,
    });
    assert.equal(store.getApplication("application-1").roleMarkdown, "# 更新后的共享 JD");
    assert.equal(store.getApplication("application-1").roleShortName, "研究");
    assert.equal(store.getInterview("round-1").roleMarkdown, "# 更新后的共享 JD");
    assert.equal(store.getInterview("round-1").roleShortName, "研究");
    assert.equal(store.getInterview("round-1").durationMinutes, 90);
    assert.equal(store.getInterview("round-2").outcome, "通过");
    assert.equal(store.getInterview("round-2").durationMinutes, 75);

    const pdf = Buffer.from("%PDF-1.4\nshared resume");
    const resume = store.saveAttachment("round-1", {
      name: "resume.pdf",
      type: "application/pdf",
      dataUrl: `data:application/pdf;base64,${pdf.toString("base64")}`,
    });
    assert.equal(store.getAttachmentForInterview("round-2").id, resume.id);
    assert.equal(store.getApplication("application-1").resumeFile.id, resume.id);

    const snapshot = store.getStore();
    assert.equal(snapshot.schemaVersion, 7);
    assert.equal(snapshot.applications.length, 1);
    assert.equal(snapshot.interviews.length, 2);
    const exported = store.exportStore();
    assert.equal(exported.applications[0].roleShortName, "研究");
    assert.deepEqual(
      Object.fromEntries(exported.interviews.map((round) => [round.id, round.durationMinutes])),
      { "round-1": 90, "round-2": 75 },
    );
    assert.equal(exported.jdLibrary[0].shortName, "策略库");
    assert.match(exported.applications[0].resumeFile.dataUrl, /^data:application\/pdf;base64,/);
    assert.equal(exported.interviews.some((round) => round.resumeFile?.dataUrl), false);
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("round duration rejects invalid create and update values", () => {
  const config = createTestConfig("interview-duration-validation-");
  const store = new SqliteStore(config, silentLogger);
  try {
    for (const durationMinutes of [0, -1, 60.5, 1441, "invalid", null, "", true]) {
      assert.throws(
        () => store.createInterview(sampleInterview({
          id: `invalid-${String(durationMinutes)}`,
          durationMinutes,
        })),
        /面试时长必须是/,
      );
    }
    store.createInterview(sampleInterview({ id: "valid-round", durationMinutes: 60 }));
    for (const durationMinutes of [0, -1, 60.5, 1441, "invalid", null, "", true]) {
      assert.throws(
        () => store.patchInterview("valid-round", { durationMinutes }),
        /面试时长必须是/,
      );
    }
    assert.equal(store.getInterview("valid-round").durationMinutes, 60);
    assert.throws(
      () => store.importBackup({
        schemaVersion: 7,
        applications: [],
        interviews: [sampleInterview({ id: "invalid-import", durationMinutes: 0 })],
      }),
      /面试时长必须是/,
    );
    assert.equal(store.getInterview("valid-round").durationMinutes, 60);
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("cross-round context follows artifact metadata instead of kind whitelists", () => {
  const config = createTestConfig();
  const store = new SqliteStore(config, silentLogger);
  try {
    store.createApplication({
      id: "application-1",
      name: "候选人",
      firstRound: {
        id: "round-1",
        lines: [{ id: "private-line", text: "不应注入的原始转录", speaker: "1" }],
        cards: [{
          id: "private-card",
          markdown: "卡片结论",
          transcriptSlice: "不应由卡片泄露的原始转录",
        }],
        askedQuestions: ["不应跨轮返回的已问问题"],
        speakerLabels: { 1: "候选人" },
      },
    });
    store.upsertApplicationArtifact("application-1", {
      kind: "process-brief",
      markdown: "共享流程摘要",
      includeInCrossRoundContext: true,
    });
    store.upsertApplicationArtifact("application-1", {
      kind: "private-note",
      markdown: "不应自动注入的流程私密备注",
      includeInCrossRoundContext: false,
    });
    store.upsertArtifact("round-1", {
      kind: "round-handoff",
      markdown: "一面待验证风险",
      includeInCrossRoundContext: true,
    });
    store.upsertArtifact("round-1", {
      kind: "interview-preparation",
      markdown: "不应作为跨轮摘要返回的准备稿",
      includeInCrossRoundContext: false,
    });
    store.upsertArtifact("round-1", {
      kind: "resume-screening",
      markdown: "旧客户端保存的共享筛选结论",
      includeInCrossRoundContext: false,
    });
    store.upsertArtifact("round-1", {
      kind: "decision-note",
      markdown: "自定义类型也应进入跨轮上下文",
      includeInCrossRoundContext: true,
    });
    store.upsertArtifact("round-1", {
      kind: "private-detail",
      markdown: "自定义类型可明确排除",
      includeInCrossRoundContext: false,
    });
    assert.throws(
      () => store.upsertArtifact("round-1", {
        kind: "unknown-without-policy",
        markdown: "不能静默猜测",
      }),
      /必须明确设置 includeInCrossRoundContext/,
    );
    store.upsertArtifact("round-1", {
      kind: "decision-note",
      markdown: "更新后的自定义类型仍应进入跨轮上下文",
    });
    store.linkHarnessSession("round-1", {
      harness: "codex",
      sessionId: "private-session",
    });
    store.createInterviewRound("application-1", { id: "round-2", roundLabel: "二面" });
    store.upsertArtifact("round-2", {
      kind: "interview-summary",
      markdown: "当前轮总结不应注入自身上下文",
      includeInCrossRoundContext: true,
    });

    const context = store.getCrossRoundContext("round-2");
    assert.match(context, /共享流程摘要/);
    assert.match(context, /一面待验证风险/);
    assert.match(context, /更新后的自定义类型仍应进入跨轮上下文/);
    assert.doesNotMatch(context, /不应自动注入的流程私密备注/);
    assert.doesNotMatch(context, /不应作为跨轮摘要返回的准备稿/);
    assert.doesNotMatch(context, /旧客户端保存的共享筛选结论/);
    assert.doesNotMatch(context, /自定义类型可明确排除/);
    assert.doesNotMatch(context, /不应注入的原始转录/);
    assert.doesNotMatch(context, /当前轮总结不应注入自身上下文/);
    assert.equal(store.getCrossRoundContext("round-2", 12).length, 12);
    const applicationContext = store.getApplicationContext("application-1");
    assert.equal(
      applicationContext.applicationArtifacts
        .find((artifact) => artifact.kind === "resume-screening")?.markdown,
      "旧客户端保存的共享筛选结论",
    );
    assert.deepEqual(applicationContext.rounds.map((round) => round.id), ["round-1", "round-2"]);
    const firstRoundContext = applicationContext.rounds[0];
    assert.equal(firstRoundContext.transcriptLineCount, 1);
    assert.deepEqual(
      new Set(firstRoundContext.artifacts.map((artifact) => artifact.kind)),
      new Set(["round-handoff", "decision-note"]),
    );
    assert.equal(
      firstRoundContext.artifacts.find((artifact) => artifact.kind === "decision-note")
        ?.includeInCrossRoundContext,
      true,
    );
    for (const privateField of [
      "lines",
      "cards",
      "askedQuestions",
      "speakerLabels",
      "harnessSessions",
      "resumeMarkdown",
      "roleMarkdown",
    ]) {
      assert.equal(privateField in firstRoundContext, false);
    }
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("new custom artifacts must declare their cross-round policy", () => {
  const config = createTestConfig("interview-artifact-policy-");
  const store = new SqliteStore(config, silentLogger);
  try {
    assert.throws(
      () => store.createApplication({
        id: "application-round-artifact",
        name: "候选人 A",
        firstRound: {
          id: "round-artifact",
          artifacts: [{ kind: "custom-note", markdown: "不得静默遗漏" }],
        },
      }),
      /必须明确设置 includeInCrossRoundContext/,
    );
    assert.equal(store.getApplication("application-round-artifact"), null);
    assert.equal(store.getInterview("round-artifact"), null);

    assert.throws(
      () => store.createApplication({
        id: "application-level-artifact",
        name: "候选人 B",
        firstRound: { id: "application-level-round" },
        applicationArtifacts: [{ kind: "custom-brief", markdown: "不得静默遗漏" }],
      }),
      /必须明确设置 includeInCrossRoundContext/,
    );
    assert.equal(store.getApplication("application-level-artifact"), null);
    assert.equal(store.getInterview("application-level-round"), null);
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("schema v7 import preserves explicit artifact exclusion during legacy promotion", () => {
  const sourceConfig = createTestConfig("interview-artifact-v7-source-");
  const targetConfig = createTestConfig("interview-artifact-v7-target-");
  const source = new SqliteStore(sourceConfig, silentLogger);
  const target = new SqliteStore(targetConfig, silentLogger);
  try {
    source.createApplication({
      id: "application-1",
      name: "候选人",
      firstRound: { id: "round-1" },
    });
    source.createInterviewRound("application-1", { id: "round-2", roundLabel: "二面" });
    source.upsertArtifact("round-1", {
      kind: "process-brief",
      markdown: "明确排除的流程材料",
      includeInCrossRoundContext: false,
    });
    const backup = source.exportStore();
    backup.applications[0].applicationArtifacts = [];
    backup.applications[0].artifacts = [];

    target.importBackup(backup);
    const promoted = target.getApplicationContext("application-1").applicationArtifacts
      .find((artifact) => artifact.kind === "process-brief");
    assert.equal(promoted.includeInCrossRoundContext, false);
    assert.doesNotMatch(target.getCrossRoundContext("round-2"), /明确排除的流程材料/);
  } finally {
    source.close();
    target.close();
    cleanupTestConfig(sourceConfig);
    cleanupTestConfig(targetConfig);
  }
});

test("schema v7 restart preserves an explicit flag when rebuilding a missing mirror", () => {
  const config = createTestConfig("interview-artifact-v7-restart-");
  const initial = new SqliteStore(config, silentLogger);
  initial.createApplication({
    id: "application-1",
    name: "候选人",
    firstRound: { id: "round-1" },
  });
  initial.createInterviewRound("application-1", { id: "round-2", roundLabel: "二面" });
  initial.upsertArtifact("round-1", {
    kind: "process-brief",
    markdown: "重启后仍应排除",
    includeInCrossRoundContext: false,
  });
  initial.close();

  const interrupted = new DatabaseSync(config.databaseFile);
  interrupted.prepare(`
    DELETE FROM application_artifacts
    WHERE application_id = ? AND kind = 'process-brief'
  `).run("application-1");
  interrupted.close();

  const reopened = new SqliteStore(config, silentLogger);
  try {
    const promoted = reopened.getApplicationContext("application-1").applicationArtifacts
      .find((artifact) => artifact.kind === "process-brief");
    assert.equal(promoted.includeInCrossRoundContext, false);
    assert.doesNotMatch(reopened.getCrossRoundContext("round-2"), /重启后仍应排除/);
  } finally {
    reopened.close();
    cleanupTestConfig(config);
  }
});

test("artifact policy migration is retryable and fail-closed", () => {
  const config = createTestConfig("interview-artifact-migration-retry-");
  const initial = new SqliteStore(config, silentLogger);
  initial.createInterview(sampleInterview({ id: "round-1" }));
  initial.upsertArtifact("round-1", {
    kind: "interview-summary",
    markdown: "详细总结",
    includeInCrossRoundContext: true,
  });
  initial.upsertArtifact("round-1", {
    kind: "round-handoff",
    markdown: "精简交接",
    includeInCrossRoundContext: true,
  });
  initial.upsertArtifact("round-1", {
    kind: "interview-preparation",
    markdown: "准备稿",
    includeInCrossRoundContext: false,
  });
  initial.close();

  const interrupted = new DatabaseSync(config.databaseFile);
  interrupted.exec(`
    UPDATE meta SET value = '6' WHERE key = 'schema_version';
    DELETE FROM meta WHERE key = 'artifact_context_policy_v7';
    UPDATE interview_artifacts SET include_in_cross_round_context = 1;
  `);
  interrupted.close();

  const migrated = new SqliteStore(config, silentLogger);
  try {
    const policies = Object.fromEntries(
      migrated.listArtifacts("round-1")
        .map((artifact) => [artifact.kind, artifact.includeInCrossRoundContext]),
    );
    assert.deepEqual(policies, {
      "interview-summary": false,
      "round-handoff": true,
      "interview-preparation": false,
    });
  } finally {
    migrated.close();
    cleanupTestConfig(config);
  }
});

test("the only active round cannot be deleted independently", () => {
  const config = createTestConfig();
  const store = new SqliteStore(config, silentLogger);
  try {
    store.createApplication({
      id: "application-1",
      name: "候选人",
      firstRound: { id: "round-1" },
    });
    assert.throws(
      () => store.softDeleteInterview("round-1"),
      (error) => error.code === "LAST_ROUND" && /唯一一轮不能删除/.test(error.message),
    );
    assert.ok(store.getInterview("round-1"));

    store.createInterviewRound("application-1", { id: "round-2", roundLabel: "二面" });
    assert.equal(store.softDeleteInterview("round-1"), true);
    assert.equal(store.getInterview("round-1"), null);
    assert.equal(store.getApplicationContext("application-1").rounds[0].id, "round-2");
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("schema v5 migration adds empty role short names without inferring them", () => {
  const config = createTestConfig("interview-schema-v5-role-short-name-");
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.backupDir, { recursive: true });
  const legacyDb = new DatabaseSync(config.databaseFile);
  legacyDb.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta (key, value) VALUES ('schema_version', '5');
    CREATE TABLE jd_library (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE applications (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      application_status TEXT NOT NULL,
      resume_markdown TEXT NOT NULL DEFAULT '',
      role_markdown TEXT NOT NULL DEFAULT '',
      resume_notes_json TEXT NOT NULL DEFAULT '[]',
      selected_jd_id TEXT NOT NULL DEFAULT '',
      jd_draft_name TEXT NOT NULL DEFAULT '',
      deleted_at TEXT
    );
    CREATE TABLE interviews (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      round_order INTEGER NOT NULL DEFAULT 1,
      round_label TEXT NOT NULL DEFAULT '',
      round_status TEXT NOT NULL DEFAULT '待安排',
      outcome TEXT NOT NULL DEFAULT '',
      round_focus TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      session_started_at TEXT,
      scheduled_at TEXT,
      interview_status TEXT NOT NULL,
      resume_markdown TEXT NOT NULL DEFAULT '',
      role_markdown TEXT NOT NULL DEFAULT '',
      resume_notes_json TEXT NOT NULL DEFAULT '[]',
      selected_jd_id TEXT NOT NULL DEFAULT '',
      jd_draft_name TEXT NOT NULL DEFAULT '',
      last_processed_line_count INTEGER NOT NULL DEFAULT 0,
      speaker_labels_json TEXT NOT NULL DEFAULT '{}',
      deleted_at TEXT
    );
    INSERT INTO jd_library VALUES
      ('jd-1', '量化策略研究负责人', '# JD', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    INSERT INTO applications VALUES
      ('application-1', '候选人', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
       '招聘中', '', '# JD', '[]', 'jd-1', '量化策略研究负责人', NULL);
    INSERT INTO interviews VALUES
      ('round-1', 'application-1', 1, '一面', '待安排', '', '', '候选人',
       '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', NULL, NULL,
       '招聘中', '', '# JD', '[]', 'jd-1', '量化策略研究负责人', 0, '{}', NULL);
  `);
  legacyDb.close();

  const migrated = new SqliteStore(config, silentLogger);
  try {
    const snapshot = migrated.getStore();
    assert.equal(snapshot.schemaVersion, 7);
    assert.equal(snapshot.jdLibrary[0].name, "量化策略研究负责人");
    assert.equal(snapshot.jdLibrary[0].shortName, "");
    assert.equal(snapshot.applications[0].jdDraftName, "量化策略研究负责人");
    assert.equal(snapshot.applications[0].roleShortName, "");
    assert.equal(snapshot.interviews[0].roleShortName, "");
    assert.equal(snapshot.interviews[0].durationMinutes, 60);
  } finally {
    migrated.close();
  }

  const reopened = new SqliteStore(config, silentLogger);
  try {
    assert.equal(reopened.getStore().applications[0].roleShortName, "");
  } finally {
    reopened.close();
    cleanupTestConfig(config);
  }
});

test("schema v4 migration backs up once and never merges same-name interviews", () => {
  const config = createTestConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.backupDir, { recursive: true });
  const legacyDb = new DatabaseSync(config.databaseFile);
  legacyDb.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta (key, value) VALUES ('schema_version', '4');
    CREATE TABLE interviews (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      session_started_at TEXT,
      scheduled_at TEXT,
      interview_status TEXT NOT NULL,
      resume_markdown TEXT NOT NULL DEFAULT '',
      role_markdown TEXT NOT NULL DEFAULT '',
      resume_notes_json TEXT NOT NULL DEFAULT '[]',
      selected_jd_id TEXT NOT NULL DEFAULT '',
      jd_draft_name TEXT NOT NULL DEFAULT '',
      last_processed_line_count INTEGER NOT NULL DEFAULT 0,
      speaker_labels_json TEXT NOT NULL DEFAULT '{}',
      deleted_at TEXT
    );
    INSERT INTO interviews VALUES
      ('legacy-1', '同名候选人', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
       NULL, NULL, '未面', '简历一', 'JD', '[]', '', '', 0, '{}', NULL),
      ('legacy-2', '同名候选人', '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z',
       NULL, NULL, '未面', '简历二', 'JD', '[]', '', '', 0, '{}', NULL);
    CREATE TABLE interview_artifacts (
      id TEXT PRIMARY KEY,
      interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      markdown TEXT NOT NULL,
      source_harness TEXT NOT NULL DEFAULT '',
      source_session_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(interview_id, kind)
    );
    INSERT INTO interview_artifacts VALUES
      ('screening-1', 'legacy-1', 'resume-screening', 'Resume screening',
       '旧版共享筛选结论', '', '', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
  `);
  legacyDb.close();

  const store = new SqliteStore(config, silentLogger);
  try {
    const snapshot = store.getStore();
    assert.equal(snapshot.schemaVersion, 7);
    assert.deepEqual(snapshot.applications.map((application) => application.id).sort(), ["legacy-1", "legacy-2"]);
    assert.equal(store.getApplicationContext("legacy-1").rounds[0].id, "legacy-1");
    assert.equal(store.getApplicationContext("legacy-2").rounds[0].id, "legacy-2");
    assert.equal(
      store.getApplicationContext("legacy-1").applicationArtifacts
        .find((artifact) => artifact.kind === "resume-screening")?.markdown,
      "旧版共享筛选结论",
    );
    assert.equal(
      store.getApplicationContext("legacy-1").applicationArtifacts
        .find((artifact) => artifact.kind === "resume-screening")
        ?.includeInCrossRoundContext,
      false,
    );
    assert.equal(
      store.getInterview("legacy-1").artifacts
        .find((artifact) => artifact.kind === "resume-screening")
        ?.includeInCrossRoundContext,
      false,
    );
    assert.equal(store.getInterview("legacy-1").durationMinutes, 60);
    const backups = fs.readdirSync(config.backupDir)
      .filter((name) => name.startsWith("workbench-pre-v7-") && name.endsWith(".sqlite"));
    assert.equal(backups.length, 1);
    assert.ok(fs.statSync(path.join(config.backupDir, backups[0])).size > 0);
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});
