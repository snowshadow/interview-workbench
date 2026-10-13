import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION, SqliteStore } from "../server/storage/sqlite-store.js";
import { mergeAssistantPatch } from "../server/services/live-interview-assistant.js";
import { buildAssistantView } from "../src/lib/assistant-view.js";
import { cleanupTestConfig, createTestConfig, sampleInterview, silentLogger } from "./helpers.js";

const EMPTY_STATE = { revision: 0, processedLineCount: 0, updatedAt: null, topics: [], followups: [] };

function state(overrides = {}) {
  return {
    ...EMPTY_STATE,
    processedLineCount: 2,
    topics: [{
      id: "runtime",
      title: "在最近负责的 Agent 运行时中，如何界定个人工作，以及如何从真实线上故障中验证改进？",
      origin: "outline",
      summary: "候选人介绍了个人负责的运行时模块，线上验证仍待补充。",
      status: "partial",
      qas: [
        { id: "ownership", question: "请介绍最近的项目，并区分团队产出和你个人负责的部分。", answer: "负责 Agent 运行时。", status: "answered", evidenceLineIds: ["line-1", "line-2"], gap: "" },
        { id: "validation", question: "你如何验证失败恢复逻辑在真实线上有效？", answer: "", status: "answering", evidenceLineIds: [], gap: "" },
      ],
    }],
    followups: [{ id: "next", topicId: "runtime", qaId: "ownership", question: "请举一个你本人处理的线上故障。", evidenceLineIds: ["line-2"] }],
    ...overrides,
  };
}

test("assistant state belongs to one round and never leaks into new rounds or cross-round artifacts", () => {
  const config = createTestConfig("assistant-round-isolation-");
  const store = new SqliteStore(config, silentLogger);
  try {
    const first = store.createInterview(sampleInterview());
    assert.deepEqual(first.assistantState, EMPTY_STATE);
    const saved = store.saveAssistantState(first.id, state(), { expectedRevision: 0 });
    assert.equal(saved.revision, 1);
    assert.equal(saved.topics[0].qas.length, 2);
    assert.equal(store.getInterviewContext(first.id).assistantState.topics[0].title, state().topics[0].title);
    assert.equal(store.getStore().interviews[0].assistantState.revision, 1);
    const second = store.createInterviewRound(first.applicationId, { assistantState: saved, lines: first.lines });
    assert.deepEqual(second.assistantState, EMPTY_STATE);
    assert.deepEqual(second.lines, []);
    assert.deepEqual(store.getInterview(first.id).cards, []);
    assert.deepEqual(store.listArtifacts(first.id), []);
    assert.equal(store.getCrossRoundContext(second.id), "");
    assert.equal(store.saveAssistantState("missing-round", state()), null);
    store.softDeleteInterview(first.id);
    assert.equal(store.saveAssistantState(first.id, state()), null);
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("assistant saves reject stale revisions and older transcript cursors atomically across connections", () => {
  const config = createTestConfig("assistant-state-conflict-");
  const first = new SqliteStore(config, silentLogger);
  const second = new SqliteStore(config, silentLogger);
  try {
    const interview = first.createInterview(sampleInterview());
    const stale = second.getAssistantState(interview.id);
    const saved = first.saveAssistantState(interview.id, state(), { expectedRevision: stale.revision });
    assert.throws(() => second.saveAssistantState(interview.id, state({ topics: [] }), { expectedRevision: stale.revision }), { code: "ASSISTANT_STATE_CONFLICT" });
    assert.deepEqual(second.getAssistantState(interview.id), saved);
    assert.throws(() => second.saveAssistantState(interview.id, state({ processedLineCount: 1 }), { expectedRevision: saved.revision }), { code: "ASSISTANT_STATE_CONFLICT" });
    assert.deepEqual(first.getAssistantState(interview.id), saved);
    const updated = second.saveAssistantState(interview.id, { ...saved, followups: [] }, { expectedRevision: saved.revision });
    assert.equal(updated.revision, saved.revision + 1);
    assert.equal(updated.processedLineCount, saved.processedLineCount);
    assert.deepEqual(updated.followups, []);
    assert.equal(first.getInterview(interview.id).lastProcessedLineCount, 0);
  } finally {
    second.close();
    first.close();
    cleanupTestConfig(config);
  }
});

test("topic evidence survives persistence and backup without inventing a question or changing legacy topics", () => {
  const sourceConfig = createTestConfig("assistant-topic-evidence-");
  const targetConfig = createTestConfig("assistant-topic-evidence-restore-");
  let source = new SqliteStore(sourceConfig, silentLogger);
  const target = new SqliteStore(targetConfig, silentLogger);
  try {
    const interview = source.createInterview(sampleInterview());
    const saved = source.saveAssistantState(interview.id, state({ topics: [
      ...state().topics,
      {
        id: "introduction", title: "项目经历", origin: "emergent", status: "answering",
        summary: "候选人主动介绍了最近的项目，尚未进入问答。",
        evidenceLineIds: ["line-1", " line-2 ", "line-1", ""], qas: [],
      },
    ] }));
    assert.equal(Object.hasOwn(saved.topics[0], "evidenceLineIds"), false);
    assert.deepEqual(saved.topics[1].evidenceLineIds, ["line-1", "line-2"]);
    assert.deepEqual(saved.topics[1].qas, []);
    source.close();
    source = new SqliteStore(sourceConfig, silentLogger);
    assert.deepEqual(source.getAssistantState(interview.id), saved);
    target.importBackup(source.exportStore());
    assert.deepEqual(target.getAssistantState(interview.id), saved);
  } finally {
    source.close();
    target.close();
    cleanupTestConfig(sourceConfig);
    cleanupTestConfig(targetConfig);
  }
});

test("focus and compact presentation fields survive reopening and backup without truncating full content", () => {
  const sourceConfig = createTestConfig("assistant-focus-");
  const targetConfig = createTestConfig("assistant-focus-restore-");
  let source = new SqliteStore(sourceConfig, silentLogger);
  const target = new SqliteStore(targetConfig, silentLogger);
  try {
    const interview = source.createInterview(sampleInterview());
    const input = state();
    input.focus = { topicId: " runtime ", qaId: " ownership ", evidenceLineIds: ["line-1", " line-2 ", "line-1", ""] };
    input.topics[0].shortTitle = "运行时中的个人职责与故障恢复机制";
    input.topics[0].summary = "历史摘要的完整内容需要保留。".repeat(12);
    input.topics[0].qas[0].shortQuestion = "具体如何区分团队完成的项目成果与你本人承担的实现和线上排查职责";
    input.topics[0].qas[0].answer = "历史回答包含具体做法和验证过程。".repeat(12);
    input.followups[0].purpose = "核实个人职责与线上结果";
    input.followups[0].source = "automatic";
    input.followups.push({ id: "manual-next", topicId: "runtime", question: "请补充验证结果。", purpose: "补充结果", source: "manual", evidenceLineIds: ["line-2"] });
    const saved = source.saveAssistantState(interview.id, input);
    assert.deepEqual(saved.focus, { topicId: "runtime", qaId: "ownership", evidenceLineIds: ["line-1", "line-2"] });
    assert.equal(saved.topics[0].shortTitle, input.topics[0].shortTitle.slice(0, 12));
    assert.equal(saved.topics[0].qas[0].shortQuestion, input.topics[0].qas[0].shortQuestion.slice(0, 24));
    assert.equal(saved.followups[0].purpose, input.followups[0].purpose.slice(0, 8));
    assert.deepEqual(saved.followups.map((item) => item.source), ["automatic", "manual"]);
    assert.equal(saved.topics[0].title, input.topics[0].title);
    assert.equal(saved.topics[0].summary, input.topics[0].summary);
    assert.equal(saved.topics[0].qas[0].question, input.topics[0].qas[0].question);
    assert.equal(saved.topics[0].qas[0].answer, input.topics[0].qas[0].answer);
    assert.equal(Object.hasOwn(saved.topics[0].qas[1], "shortQuestion"), false);
    source.close();
    source = new SqliteStore(sourceConfig, silentLogger);
    assert.deepEqual(source.getAssistantState(interview.id), saved);
    target.importBackup(source.exportStore());
    assert.deepEqual(target.getAssistantState(interview.id), saved);
  } finally {
    source.close();
    target.close();
    cleanupTestConfig(sourceConfig);
    cleanupTestConfig(targetConfig);
  }
});

test("question ownership survives saving, reopening and backup so candidate questions stay suppressed", () => {
  const sourceConfig = createTestConfig("assistant-question-role-");
  const targetConfig = createTestConfig("assistant-question-role-restore-");
  let source = new SqliteStore(sourceConfig, silentLogger);
  const target = new SqliteStore(targetConfig, silentLogger);
  try {
    const lines = [
      { id: "line-1", text: "团队平时如何协作？", speaker: "2" },
      { id: "line-2", text: "我们每周一起制定计划。", speaker: "1" },
      { id: "line-3", text: "你如何处理协作中的分歧？", speaker: "1" },
      { id: "line-4", text: "我会先核对双方的目标。", speaker: "2" },
    ];
    const interview = source.createInterview(sampleInterview({ lines }));
    const input = state({
      processedLineCount: lines.length,
      topics: [{
        id: "team", title: "团队协作", askedBy: "candidate", status: "partial",
        qas: [
          { id: "candidate", question: lines[0].text, answer: lines[1].text, askedBy: "candidate", status: "answered", evidenceLineIds: ["line-1", "line-2"], gap: "" },
          { id: "interviewer", question: lines[2].text, answer: lines[3].text, askedBy: "interviewer", status: "answered", evidenceLineIds: ["line-3", "line-4"], gap: "" },
        ],
      }],
      focus: { topicId: "team", qaId: "candidate", evidenceLineIds: ["line-1", "line-2"] },
      followups: [{ id: "stale", topicId: "team", qaId: "candidate", question: "计划如何分工？", source: "manual", evidenceLineIds: ["line-2"] }],
    });
    const saved = source.saveAssistantState(interview.id, input);
    source.close();
    source = new SqliteStore(sourceConfig, silentLogger);
    target.importBackup(source.exportStore());

    for (const current of [saved, source.getAssistantState(interview.id), target.getAssistantState(interview.id)]) {
      assert.equal(current.topics[0].askedBy, "candidate");
      assert.deepEqual(current.topics[0].qas.map((qa) => qa.askedBy), ["candidate", "interviewer"]);
      assert.equal(buildAssistantView(current, lines).candidateQuestion, true);
      assert.equal(buildAssistantView(current, lines).suggestion, null);
      assert.deepEqual(mergeAssistantPatch(current, { topics: [], followups: current.followups }, { mode: "followup", lines }).followups, []);
      assert.equal(buildAssistantView({ ...current, focus: { topicId: "team" } }, lines).candidateQuestion, true);
      assert.equal(buildAssistantView({ ...current, focus: { topicId: "team", qaId: "interviewer" } }, lines).candidateQuestion, false);
    }
  } finally {
    source.close();
    target.close();
    cleanupTestConfig(sourceConfig);
    cleanupTestConfig(targetConfig);
  }
});

test("question ownership preserves supported roles and legacy omissions without trusting invalid roles", () => {
  const config = createTestConfig("assistant-question-role-validation-");
  const store = new SqliteStore(config, silentLogger);
  try {
    const interview = store.createInterview(sampleInterview());
    const legacy = store.saveAssistantState(interview.id, state());
    assert.equal(Object.hasOwn(legacy.topics[0], "askedBy"), false);
    assert.equal(Object.hasOwn(legacy.topics[0].qas[0], "askedBy"), false);
    for (const askedBy of ["interviewer", "candidate", "unknown", "unsupported", null]) {
      const input = state();
      input.topics[0].askedBy = askedBy;
      input.topics[0].qas[0].askedBy = askedBy;
      const saved = store.saveAssistantState(interview.id, input);
      const expected = ["interviewer", "candidate", "unknown"].includes(askedBy) ? askedBy : "unknown";
      assert.equal(saved.topics[0].askedBy, expected);
      assert.equal(saved.topics[0].qas[0].askedBy, expected);
      assert.equal(Object.hasOwn(saved.topics[0].qas[1], "askedBy"), false);
    }
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("focus only names an existing topic and its QA, while legacy states keep their original shape", () => {
  const config = createTestConfig("assistant-focus-validation-");
  const store = new SqliteStore(config, silentLogger);
  try {
    const interview = store.createInterview(sampleInterview());
    const legacy = store.saveAssistantState(interview.id, state());
    assert.deepEqual(legacy.topics, state().topics);
    assert.deepEqual(legacy.followups, state().followups);
    assert.equal(Object.hasOwn(legacy, "focus"), false);
    const topicFocus = store.saveAssistantState(interview.id, { ...legacy, focus: { topicId: "runtime", evidenceLineIds: ["line-2", "line-2"] } });
    assert.deepEqual(topicFocus.focus, { topicId: "runtime", evidenceLineIds: ["line-2"] });
    const otherTopic = { id: "other", title: "其他话题", origin: "outline", summary: "", status: "unasked", qas: [] };
    for (const focus of [null, "runtime", [], { topicId: "missing" }, { topicId: "runtime", qaId: "missing" }, { topicId: "other", qaId: "ownership" }]) {
      const saved = store.saveAssistantState(interview.id, { ...legacy, topics: [...legacy.topics, otherTopic], focus });
      assert.equal(saved.focus, null);
    }
    const unsupportedSource = store.saveAssistantState(interview.id, state({ followups: [{ ...state().followups[0], source: "imported" }] }));
    assert.equal(Object.hasOwn(unsupportedSource.followups[0], "source"), false);
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("legacy patches and full snapshots preserve assistant state and pending jobs", () => {
  const config = createTestConfig("assistant-legacy-snapshot-");
  const store = new SqliteStore(config, silentLogger);
  try {
    const interview = store.createInterview(sampleInterview());
    const oldSnapshot = store.getStore({ includeAllLines: true });
    delete oldSnapshot.interviews[0].assistantState;
    oldSnapshot.schemaVersion = 7;
    const saved = store.saveAssistantState(interview.id, state());
    const job = store.createAssistantJob({ interviewId: interview.id, mode: "followup", payload: { processedLineCount: 2 }, idempotencyKey: "manual-1" });
    store.patchInterview(interview.id, { speakerLabels: { 1: "面试官" } });
    assert.deepEqual(store.getAssistantState(interview.id), saved);
    store.upsertInterviewSnapshot(oldSnapshot.interviews[0]);
    assert.deepEqual(store.getAssistantState(interview.id), saved);
    store.importStore(oldSnapshot, { replace: true });
    assert.deepEqual(store.getAssistantState(interview.id), saved);
    assert.equal(store.getAssistantJob(job.id).status, "queued");
    const staleSnapshot = { ...oldSnapshot, interviews: [{ ...oldSnapshot.interviews[0], assistantState: EMPTY_STATE }] };
    store.importStore(staleSnapshot, { replace: true });
    assert.deepEqual(store.getAssistantState(interview.id), saved);
    store.upsertInterviewSnapshot(staleSnapshot.interviews[0]);
    assert.deepEqual(store.getAssistantState(interview.id), saved);
    assert.equal(store.getAssistantJob(job.id).status, "queued");
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("assistant backups restore state, results, and interrupted jobs and survive reopening", () => {
  const sourceConfig = createTestConfig("assistant-export-");
  const targetConfig = createTestConfig("assistant-import-");
  const source = new SqliteStore(sourceConfig, silentLogger);
  let target = new SqliteStore(targetConfig, silentLogger);
  try {
    const interview = source.createInterview(sampleInterview());
    const saved = source.saveAssistantState(interview.id, state());
    const done = source.createAssistantJob({ interviewId: interview.id, mode: "summary", payload: { count: 2 }, idempotencyKey: "summary-1" });
    source.updateAssistantJob(done.id, { status: "done", attempts: 1, result: saved });
    const running = source.createAssistantJob({ interviewId: interview.id, mode: "followup", payload: { latestLines: ["line-2"] }, idempotencyKey: "followup-1" });
    source.updateAssistantJob(running.id, { status: "running", attempts: 1 });
    const backup = source.exportStore();
    assert.equal(backup.assistantJobs.length, 2);
    target.importBackup(backup);
    target.saveAssistantState(interview.id, { ...saved, processedLineCount: 3, followups: [] });
    target.importBackup(backup);
    assert.deepEqual(target.getAssistantState(interview.id), saved);
    assert.deepEqual(target.getAssistantJob(done.id).result, saved);
    assert.equal(target.getAssistantJob(running.id).status, "retrying");
    target.updateAssistantJob(running.id, { status: "running", attempts: 2 });
    target.close();
    target = new SqliteStore(targetConfig, silentLogger);
    assert.deepEqual(target.getAssistantState(interview.id), saved);
    assert.equal(target.getAssistantJob(running.id).status, "retrying");
    assert.equal(target.getAssistantJob(running.id).attempts, 2);
    assert.deepEqual(target.listRunnableAssistantJobs().map(({ id }) => id), [running.id]);
    assert.deepEqual(target.getInterview(interview.id).cards, []);
  } finally {
    source.close();
    target.close();
    cleanupTestConfig(sourceConfig);
    cleanupTestConfig(targetConfig);
  }
});

test("assistant jobs deduplicate within a round and mode, retain ordering, and retry only failures", () => {
  const config = createTestConfig("assistant-job-lifecycle-");
  const store = new SqliteStore(config, silentLogger);
  try {
    const first = store.createInterview(sampleInterview());
    const second = store.createInterviewRound(first.applicationId);
    const input = { interviewId: first.id, mode: "summary", payload: { count: 2 }, idempotencyKey: "same-key" };
    const summary = store.createAssistantJob(input);
    assert.equal(store.createAssistantJob(input).id, summary.id);
    const followup = store.createAssistantJob({ ...input, mode: "followup" });
    const otherRound = store.createAssistantJob({ ...input, interviewId: second.id });
    assert.notEqual(summary.id, followup.id);
    assert.notEqual(summary.id, otherRound.id);
    assert.deepEqual(store.listAssistantJobs(first.id).map(({ id }) => id), [followup.id, summary.id]);
    assert.equal(store.retryAssistantJob(summary.id), null);
    store.updateAssistantJob(summary.id, { status: "error", attempts: 3, error: "timeout" });
    assert.deepEqual(store.listAssistantJobs(first.id, { pendingOnly: true }).map(({ id }) => id), [followup.id]);
    const retried = store.retryAssistantJob(summary.id);
    assert.equal(retried.status, "queued");
    assert.equal(retried.attempts, 0);
    assert.equal(retried.error, undefined);
    store.softDeleteInterview(first.id);
    assert.deepEqual(store.listRunnableAssistantJobs().map(({ id }) => id), [otherRound.id]);
    assert.equal(store.createAssistantJob(input), null);
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});

test("schema eight backs up a version seven database before adding assistant tables", () => {
  const config = createTestConfig("assistant-schema-upgrade-");
  let store = new SqliteStore(config, silentLogger);
  try {
    store.createInterview(sampleInterview());
    store.db.exec("DROP TABLE assistant_jobs; DROP TABLE assistant_states; UPDATE meta SET value='7' WHERE key='schema_version'");
    store.close();
    store = new SqliteStore(config, silentLogger);
    assert.equal(store.getStore().schemaVersion, SCHEMA_VERSION);
    assert.deepEqual(store.getInterview("candidate-1").assistantState, EMPTY_STATE);
    assert.equal(store.getInterview("candidate-1").lines.length, 2);
    const backups = fs.readdirSync(config.backupDir).filter((name) => name.startsWith("workbench-pre-v8-"));
    assert.equal(backups.length, 1);
    const before = new DatabaseSync(path.join(config.backupDir, backups[0]), { readOnly: true });
    try {
      assert.equal(before.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, "7");
      assert.equal(before.prepare("SELECT COUNT(*) AS count FROM transcript_lines").get().count, 2);
      assert.equal(before.prepare("SELECT name FROM sqlite_master WHERE name='assistant_states'").get(), undefined);
    } finally {
      before.close();
    }
  } finally {
    store.close();
    cleanupTestConfig(config);
  }
});
