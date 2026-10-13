import assert from "node:assert/strict";
import test from "node:test";
import { AssistantJobService } from "../server/services/assistant-job-service.js";

test("automatic summary is skipped without new persisted lines and ignores caller text", async () => {
  const fixture = setup();
  const job = fixture.service.enqueue({ interviewId: "r1", mode: "summary", transcriptSlice: "forged client text", segmentEnd: 9999 });
  await fixture.service.run(job);
  assert.equal(fixture.calls[0].transcriptLines.map((line) => line.text).join(""), "问题回答");
  assert.equal(fixture.store.getAssistantState("r1").processedLineCount, 2);
  assert.equal(fixture.service.enqueue({ interviewId: "r1", mode: "summary" }), null);
});

test("manual suggestions can regenerate without new text while duplicate pending requests merge", async () => {
  const fixture = setup();
  const first = fixture.service.enqueue({ interviewId: "r1", mode: "followup" });
  const repeated = fixture.service.enqueue({ interviewId: "r1", mode: "followup" });
  assert.equal(first.id, repeated.id);
  await fixture.service.run(first);
  const next = fixture.service.enqueue({ interviewId: "r1", mode: "followup" });
  assert.notEqual(next.id, first.id);
  await fixture.service.run(next);
  assert.deepEqual(fixture.calls.map((call) => call.mode), ["followup", "followup"]);
  assert.deepEqual(fixture.calls[1].transcriptLines, []);
});

test("a failed provider call does not advance the cursor and retry uses the latest saved state", async () => {
  let attempts = 0;
  const fixture = setup(async (input) => {
    if (++attempts === 1) throw new Error("network timeout");
    return unchanged(input);
  });
  const job = fixture.service.enqueue({ interviewId: "r1", mode: "summary" });
  await fixture.service.run(job);
  assert.equal(fixture.service.get(job.id).status, "retrying");
  assert.equal(fixture.store.getAssistantState("r1").processedLineCount, 0);
  await fixture.service.run(fixture.service.get(job.id));
  assert.equal(fixture.service.get(job.id).status, "done");
  assert.equal(fixture.store.getAssistantState("r1").processedLineCount, 2);
});

test("validation feedback is persisted, logged, and cleared after the corrected chunk", async () => {
  let attempts = 0;
  const logs = [];
  const feedback = "topics[0].qas[0].evidenceLineIds[0]: L99 is not in the provided sources; use only listed source aliases.";
  const fixture = setup(async (input) => {
    if (++attempts === 1) throw validationError(feedback);
    return unchanged(input);
  }, { chunkLines: 1, logger: { info() {}, warn: (_event, fields) => logs.push(fields), error: (_event, fields) => logs.push(fields) } });
  const job = fixture.service.enqueue({ interviewId: "r1", mode: "summary" });
  await fixture.service.run(job);
  assert.equal(fixture.store.getAssistantState("r1").processedLineCount, 0);
  assert.equal(fixture.service.get(job.id).payload.validationFeedback, feedback);
  assert.equal(logs[0].validationFeedback, feedback);
  await fixture.service.run(fixture.service.get(job.id));
  assert.equal(fixture.calls[1].validationFeedback, feedback);
  assert.equal(fixture.calls[2].validationFeedback, "", "feedback for the corrected chunk must not leak into the next chunk");
  assert.equal(fixture.service.get(job.id).payload.validationFeedback, "");
  assert.equal(fixture.service.get(job.id).status, "done");
});

test("an automatic retry catches up with newly persisted transcript and retains correction feedback", async () => {
  let attempts = 0;
  const feedback = "topics[0].qas[0]: represent the candidate's spontaneous statement without inventing a question.";
  const fixture = setup(async (input) => { if (++attempts === 1) throw validationError(feedback); return unchanged(input); });
  const job = fixture.service.enqueue({ interviewId: "r1", mode: "summary" });
  await fixture.service.run(job);
  fixture.interviews.r1.lines.push({ id: "a2", text: "候选人继续补充" });
  await fixture.service.run(fixture.service.get(job.id));
  assert.equal(fixture.service.get(job.id).payload.targetLineCount, 3);
  assert.deepEqual(fixture.calls[1].transcriptLines.map((line) => line.id), ["q1", "a1", "a2"]);
  assert.equal(fixture.calls[1].validationFeedback, feedback);
  assert.equal(fixture.store.getAssistantState("r1").processedLineCount, 3);
});

test("extending a pending snapshot preserves its previous validation feedback", async () => {
  const feedback = "topics[0].qas[0].evidenceLineIds: use the listed source aliases.";
  const fixture = setup(async () => { throw validationError(feedback); });
  const job = fixture.service.enqueue({ interviewId: "r1", mode: "summary" });
  await fixture.service.run(job);
  fixture.interviews.r1.lines.push({ id: "a2", text: "新增回答" });
  const merged = fixture.service.enqueue({ interviewId: "r1", mode: "summary" });
  assert.equal(merged.id, job.id);
  assert.equal(merged.payload.targetLineCount, 3);
  assert.equal(merged.payload.validationFeedback, feedback);
});

test("manual retry refreshes the terminal job's snapshot and generates suggestions after catching up", async () => {
  let attempts = 0;
  const feedback = "topics[0].qas[0].evidenceLineIds: invalid source alias.";
  const fixture = setup(async (input) => { if (++attempts === 1) throw validationError(feedback); return unchanged(input); }, { maxAttempts: 1, chunkLines: 2 });
  const job = fixture.service.enqueue({ interviewId: "r1", mode: "followup" });
  await fixture.service.run(job);
  assert.equal(fixture.service.get(job.id).status, "error");
  fixture.interviews.r1.lines.push(...[2, 3, 4].map((index) => ({ id: `a${index}`, text: "更多实际回答" })));
  const retried = fixture.service.retry(job.id);
  assert.equal(retried.id, job.id);
  assert.equal(retried.mode, "followup");
  assert.equal(retried.attempts, 0);
  assert.equal(retried.payload.targetLineCount, 5);
  assert.equal(retried.payload.lineDigests.length, 5);
  assert.equal(retried.payload.validationFeedback, feedback);
  await fixture.service.run(retried);
  assert.deepEqual(fixture.calls.slice(1).map((call) => call.mode), ["summary", "summary", "followup"]);
  assert.equal(fixture.calls[1].validationFeedback, feedback);
  assert.equal(fixture.store.getAssistantState("r1").processedLineCount, 5);
});

test("a fresh manual request inherits the latest failure's feedback, and retrying the old job reuses it", async () => {
  const feedback = "topics[0].qas[0].evidenceLineIds[0]: use source aliases from this request.";
  const fixture = setup(async () => { throw validationError(feedback); }, { maxAttempts: 1 });
  const failed = fixture.service.enqueue({ interviewId: "r1", mode: "summary" });
  await fixture.service.run(failed);
  fixture.interviews.r1.lines.push({ id: "a2", text: "新增回答" });
  const manual = fixture.service.enqueue({ interviewId: "r1", mode: "followup" });
  assert.equal(manual.payload.targetLineCount, 3);
  assert.equal(manual.payload.validationFeedback, feedback);
  const reused = fixture.service.retry(failed.id);
  assert.equal(reused.id, manual.id);
  assert.equal(fixture.service.get(failed.id).status, "error");
  assert.equal(fixture.store.listAssistantJobs("r1", { pendingOnly: true }).length, 1);
});

test("manual requests keep their click-time snapshot while queued summaries catch up on start", async () => {
  for (const mode of ["summary", "followup"]) {
    const fixture = setup();
    const job = fixture.service.enqueue({ interviewId: "r1", mode });
    fixture.interviews.r1.lines.push({ id: "a2", text: "点击之后才到达的回答" });
    await fixture.service.run(job);
    const expected = mode === "summary" ? 3 : 2;
    assert.equal(fixture.calls[0].transcriptLines.length, expected);
    assert.equal(fixture.store.getAssistantState("r1").processedLineCount, expected);
  }
});

test("retrying an old summary reuses pending manual work even when all lines are already covered", () => {
  const fixture = setup();
  const old = fixture.service.enqueue({ interviewId: "r1", mode: "summary" });
  fixture.store.updateAssistantJob(old.id, { status: "error" });
  fixture.store.saveAssistantState("r1", { ...fixture.store.getAssistantState("r1"), processedLineCount: 2 }, { expectedRevision: 0 });
  const manual = fixture.service.enqueue({ interviewId: "r1", mode: "followup" });
  assert.equal(fixture.service.retry(old.id).id, manual.id);
  assert.equal(fixture.store.listAssistantJobs("r1", { pendingOnly: true }).length, 1);
});

test("validation feedback survives worker restart while transport errors stay out of the model prompt", async () => {
  const feedback = "topics[0].qas[0].evidenceLineIds: reference a provided source.";
  const fixture = setup(async () => { throw validationError(feedback); });
  const job = fixture.service.enqueue({ interviewId: "r1", mode: "summary" });
  await fixture.service.run(job);
  let restoredInput;
  const resumed = new AssistantJobService({ store: fixture.store, concurrency: 0, provider: { analyze: async (input) => { restoredInput = input; return unchanged(input); } } });
  await resumed.run(resumed.get(job.id));
  assert.equal(restoredInput.validationFeedback, feedback);
  const network = setup(async () => { throw new Error("network timeout"); });
  const networkJob = network.service.enqueue({ interviewId: "r1", mode: "summary" });
  await network.service.run(networkJob);
  assert.equal(network.service.get(networkJob.id).payload.validationFeedback, undefined);
});

test("retrying an older failed job derives feedback from its saved validation message", async () => {
  const fixture = setup();
  const job = fixture.service.enqueue({ interviewId: "r1", mode: "summary" });
  fixture.store.updateAssistantJob(job.id, { status: "error", error: "LLM JSON references evidence outside this round context" });
  const retried = fixture.service.retry(job.id);
  await fixture.service.run(retried);
  assert.equal(fixture.calls[0].validationFeedback, "LLM JSON references evidence outside this round context");
});

test("long history is processed in bounded chunks with followups only after the requested snapshot", async () => {
  const fixture = setup(undefined, { chunkChars: 5, chunkLines: 2 });
  fixture.interviews.r1.lines = Array.from({ length: 8 }, (_, index) => ({ id: `l${index}`, text: "abcd" }));
  const job = fixture.service.enqueue({ interviewId: "r1", mode: "followup" });
  await fixture.service.run(job);
  assert.deepEqual(fixture.calls.flatMap((call) => call.transcriptLines.map((line) => line.id)), fixture.interviews.r1.lines.map((line) => line.id));
  assert.ok(fixture.calls.every((call) => call.transcriptLines.reduce((sum, line) => sum + line.text.length, 0) <= 5));
  assert.deepEqual(fixture.calls.map((call) => call.mode), [...Array(7).fill("summary"), "followup"]);
  assert.deepEqual(fixture.calls.map((call) => call.isLatestChunk), [...Array(7).fill(false), true]);
  assert.equal(fixture.store.getAssistantState("r1").processedLineCount, 8);
});

test("automatic progress saves the latest focus and publishes a suggestion only after catching up", async () => {
  const observed = [];
  const fixture = setup(async (input) => {
    if (input.state.processedLineCount) observed.push(input.state);
    const line = input.transcriptLines.at(-1);
    return {
      topics: [{ id: "runtime", shortTitle: "状态恢复", status: "answering", qas: [] }],
      focus: { topicId: "runtime", evidenceLineIds: [line.id] },
      followups: [{ id: "suggestion", topicId: "runtime", question: "怎样恢复？", source: "automatic", evidenceLineIds: [line.id] }],
    };
  }, { chunkLines: 1 });
  await fixture.service.run(fixture.service.enqueue({ interviewId: "r1", mode: "summary" }));
  assert.deepEqual(fixture.calls.map((call) => call.isLatestChunk), [false, true]);
  assert.deepEqual(observed[0].focus.evidenceLineIds, ["q1"]);
  assert.deepEqual(observed[0].followups, []);
  const saved = fixture.store.getAssistantState("r1");
  assert.deepEqual(saved.focus.evidenceLineIds, ["a1"]);
  assert.equal(saved.followups[0].source, "automatic");
});

test("an extended request cannot publish its earlier next question under a newer focus", async () => {
  const gate = deferred();
  let count = 0;
  let intermediate;
  const fixture = setup(async (input) => {
    if (++count === 1) await gate.promise;
    else intermediate = input.state;
    return {
      topics: [{ id: "runtime", status: "answering", qas: [] }],
      focus: { topicId: "runtime", evidenceLineIds: [input.transcriptLines.at(-1).id] },
      followups: [{ id: `f${count}`, topicId: "runtime", question: "怎样处理？", source: "manual", evidenceLineIds: [] }],
    };
  });
  const job = fixture.service.enqueue({ interviewId: "r1", mode: "followup" });
  const running = fixture.service.run(job);
  fixture.interviews.r1.lines.push({ id: "a2", text: "新回答" });
  fixture.service.enqueue({ interviewId: "r1", mode: "followup" });
  gate.resolve();
  await running;
  assert.deepEqual(intermediate.followups, []);
  assert.deepEqual(fixture.store.getAssistantState("r1").focus.evidenceLineIds, ["a2"]);
  assert.equal(fixture.store.getAssistantState("r1").followups[0].id, "f2");
});

test("an explicit cleared focus is persisted instead of retaining the previous current topic", async () => {
  const fixture = setup(async (input) => ({ ...unchanged(input), focus: null }));
  fixture.store.saveAssistantState("r1", { ...fixture.store.getAssistantState("r1"), focus: { topicId: "old", evidenceLineIds: [] } }, { expectedRevision: 0 });
  await fixture.service.run(fixture.service.enqueue({ interviewId: "r1", mode: "summary" }));
  assert.equal(fixture.store.getAssistantState("r1").focus, null);
});

test("a single oversized transcript line is not truncated and its cursor waits for all fragments", async () => {
  const cursors = [];
  const fixture = setup(async (input) => { cursors.push(input.state.processedLineCount); return unchanged(input); }, { chunkChars: 4 });
  fixture.interviews.r1.lines = [{ id: "long", text: "abcdefghijk" }];
  const job = fixture.service.enqueue({ interviewId: "r1", mode: "followup" });
  await fixture.service.run(job);
  assert.equal(fixture.calls.flatMap((call) => call.transcriptLines).map((line) => line.text).join(""), "abcdefghijk");
  assert.deepEqual(cursors, [0, 0, 0]);
  assert.deepEqual(fixture.calls.map((call) => call.mode), ["summary", "summary", "followup"]);
  assert.equal(fixture.store.getAssistantState("r1").processedLineCount, 1);
});

test("chunk failure preserves successful work and restart resumes from the saved cursor", async () => {
  let count = 0;
  const fixture = setup(async (input) => {
    if (++count === 2) throw new Error("network timeout");
    return unchanged(input);
  }, { chunkLines: 1 });
  const job = fixture.service.enqueue({ interviewId: "r1", mode: "followup" });
  await fixture.service.run(job);
  assert.equal(fixture.store.getAssistantState("r1").processedLineCount, 1);
  const resumed = new AssistantJobService({ store: fixture.store, provider: { analyze: async (input) => { fixture.calls.push(input); return unchanged(input); } }, concurrency: 0 });
  await resumed.run(resumed.get(job.id));
  assert.equal(fixture.calls.at(-1).transcriptLines[0].id, "a1");
  assert.equal(resumed.get(job.id).status, "done");
});

test("manual request queued during automatic analysis reads the completed state and new persisted lines", async () => {
  const wait = deferred();
  let count = 0;
  const fixture = setup(async (input) => {
    if (++count === 1) await wait.promise;
    return unchanged(input);
  });
  const automatic = fixture.service.enqueue({ interviewId: "r1", mode: "summary" });
  const running = fixture.service.run(automatic);
  fixture.interviews.r1.lines.push({ id: "a2", text: "补充回答" });
  const manual = fixture.service.enqueue({ interviewId: "r1", mode: "followup" });
  assert.equal(await fixture.service.run(manual), null);
  wait.resolve();
  await running;
  await fixture.service.run(manual);
  assert.equal(fixture.calls[1].state.processedLineCount, 2);
  assert.deepEqual(fixture.calls[1].transcriptLines.map((line) => line.id), ["a2"]);
  assert.equal(fixture.store.getAssistantState("r1").processedLineCount, 3);
});

test("duplicate in-flight manual request extends the snapshot without parallel model work", async () => {
  const wait = deferred();
  let count = 0;
  const fixture = setup(async (input) => { if (++count === 1) await wait.promise; return unchanged(input); });
  const first = fixture.service.enqueue({ interviewId: "r1", mode: "followup" });
  const running = fixture.service.run(first);
  fixture.interviews.r1.lines.push({ id: "new", text: "新回答" });
  const second = fixture.service.enqueue({ interviewId: "r1", mode: "followup" });
  assert.equal(first.id, second.id);
  wait.resolve();
  await running;
  assert.equal(fixture.calls.length, 2);
  assert.deepEqual(fixture.calls[1].transcriptLines.map((line) => line.id), ["new"]);
  assert.equal(fixture.service.get(first.id).status, "done");
});

test("a stale model result cannot replace newer assistant state", async () => {
  const wait = deferred();
  const fixture = setup(async (input) => { await wait.promise; return unchanged(input); });
  const job = fixture.service.enqueue({ interviewId: "r1", mode: "summary" });
  const running = fixture.service.run(job);
  fixture.store.saveAssistantState("r1", { ...fixture.store.getAssistantState("r1"), topics: [{ id: "manual-correction" }] }, { expectedRevision: 0 });
  wait.resolve();
  await running;
  assert.equal(fixture.service.get(job.id).status, "retrying");
  assert.deepEqual(fixture.store.getAssistantState("r1").topics, [{ id: "manual-correction" }]);
  assert.equal(fixture.store.getAssistantState("r1").processedLineCount, 0);
});

test("edits to source lines during analysis are rejected without advancing progress", async () => {
  const wait = deferred();
  const fixture = setup(async (input) => { await wait.promise; return unchanged(input); });
  const job = fixture.service.enqueue({ interviewId: "r1", mode: "summary" });
  const running = fixture.service.run(job);
  fixture.interviews.r1.lines[0].text = "已修订的问题";
  wait.resolve();
  await running;
  assert.equal(fixture.service.get(job.id).status, "error");
  assert.equal(fixture.store.getAssistantState("r1").processedLineCount, 0);
});

test("cancellation discards late provider results even if the provider ignores abort", async () => {
  const wait = deferred();
  const fixture = setup(async (input) => { await wait.promise; return unchanged(input); });
  const job = fixture.service.enqueue({ interviewId: "r1", mode: "summary" });
  const running = fixture.service.run(job);
  fixture.service.cancel(job.id);
  wait.resolve();
  await running;
  assert.equal(fixture.service.get(job.id).status, "cancelled");
  assert.equal(fixture.store.getAssistantState("r1").processedLineCount, 0);
});

test("scheduler prioritizes manual work and runs different rounds concurrently", async () => {
  const wait = deferred();
  const fixture = setup(async (input) => { await wait.promise; return unchanged(input); });
  fixture.interviews.r2 = { ...structuredClone(fixture.interviews.r1), id: "r2" };
  const automatic = fixture.service.enqueue({ interviewId: "r1", mode: "summary" });
  const manual = fixture.service.enqueue({ interviewId: "r1", mode: "followup" });
  const other = fixture.service.enqueue({ interviewId: "r2", mode: "summary" });
  fixture.service.concurrency = 2;
  fixture.service.drain();
  assert.equal(fixture.service.get(manual.id).status, "running");
  assert.equal(fixture.service.get(other.id).status, "running");
  assert.equal(fixture.service.get(automatic.id).status, "queued");
  assert.equal(fixture.calls.length, 2);
  fixture.service.stop();
  wait.resolve();
  await Promise.all(fixture.runs);
});

test("the round preparation artifact wins over resume background", async () => {
  const fixture = setup();
  fixture.interviews.r1.artifacts = [{ kind: "interview-preparation", markdown: "本轮提纲" }];
  await fixture.service.run(fixture.service.enqueue({ interviewId: "r1", mode: "summary" }));
  assert.equal(fixture.calls[0].outlineMarkdown, "本轮提纲");
  assert.equal(fixture.calls[0].outlineSource, "interview-preparation");
});

test("import wakes an idle scheduler for restored pending work", async () => {
  const started = deferred();
  const fixture = setup(async (input) => { started.resolve(); return unchanged(input); });
  const job = fixture.service.enqueue({ interviewId: "r1", mode: "summary" });
  fixture.store.updateAssistantJob(job.id, { status: "done" });
  fixture.service.concurrency = 1;
  fixture.service.drain();
  assert.equal(fixture.service.running.size, 0);
  fixture.service.replaceStore(() => fixture.store.updateAssistantJob(job.id, { status: "retrying" }));
  keepScheduledRunAlive(fixture.service);
  await started.promise;
  assert.equal(fixture.runs.length, 1);
  await fixture.runs[0];
  assert.equal(fixture.service.get(job.id).status, "done");
  assert.equal(fixture.store.getAssistantState("r1").processedLineCount, 2);
  fixture.service.stop();
});

for (const oldOutcome of ["success", "failure"]) {
  test(`an in-flight ${oldOutcome} cannot mutate a restored job with the same ID and revision`, async () => {
    const oldRequest = deferred();
    const restoredRequest = deferred();
    const restoredStarted = deferred();
    let count = 0;
    const fixture = setup(async (input) => {
      if (++count === 1) {
        await oldRequest.promise;
        if (oldOutcome === "failure") throw new Error("old request failed after restore");
        return { topics: [{ id: "stale-result" }], followups: [] };
      }
      restoredStarted.resolve();
      await restoredRequest.promise;
      return unchanged(input);
    });
    const job = fixture.service.enqueue({ interviewId: "r1", mode: "summary" });
    const oldRun = fixture.service.run(job);
    fixture.service.concurrency = 1;
    fixture.service.replaceStore(() => fixture.restore({
      state: { revision: 0, processedLineCount: 0, updatedAt: null, topics: [{ id: "restored-topic" }], followups: [] },
      job: { ...job, status: "retrying" },
    }));
    keepScheduledRunAlive(fixture.service);
    await restoredStarted.promise;
    assert.equal(fixture.runs.length, 2);
    oldRequest.resolve();
    await oldRun;
    assert.equal(fixture.service.get(job.id).status, "running");
    assert.equal(fixture.service.running.size, 1, "old finally must not remove the restored run's slot");
    assert.deepEqual(fixture.store.getAssistantState("r1").topics, [{ id: "restored-topic" }]);
    restoredRequest.resolve();
    await fixture.runs[1];
    assert.equal(fixture.service.get(job.id).status, "done");
    assert.equal(fixture.store.getAssistantState("r1").revision, 1);
    assert.equal(fixture.store.getAssistantState("r1").processedLineCount, 2);
    assert.deepEqual(fixture.store.getAssistantState("r1").topics, [{ id: "restored-topic" }]);
    fixture.service.stop();
  });
}

test("failed import resumes the original work without counting cancellation as an attempt", async () => {
  const wait = deferred();
  const fixture = setup(async (input) => { await wait.promise; return unchanged(input); });
  const job = fixture.service.enqueue({ interviewId: "r1", mode: "summary" });
  const oldRun = fixture.service.run(job);
  assert.throws(() => fixture.service.replaceStore(() => { throw new Error("invalid backup"); }), /invalid backup/);
  assert.equal(fixture.service.get(job.id).status, "retrying");
  assert.equal(fixture.service.get(job.id).attempts, 0);
  wait.resolve();
  await oldRun;
  await fixture.service.run(fixture.service.get(job.id));
  assert.equal(fixture.service.get(job.id).status, "done");
  assert.equal(fixture.service.get(job.id).attempts, 1);
});

function unchanged(input) {
  return { topics: input.state.topics, followups: input.state.followups };
}

function validationError(feedback) {
  const error = new Error("Assistant output failed validation");
  error.code = "ASSISTANT_INVALID_OUTPUT";
  error.validationFeedback = feedback;
  return error;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function keepScheduledRunAlive(service) {
  // Production unrefs this timer because the HTTP server owns process lifetime.
  // These isolated tests must keep it alive until the observed run starts.
  assert.ok(service.timer, "restoring work must schedule the idle worker");
  service.timer.ref();
}

function setup(analyze = unchanged, options = {}) {
  const interviews = { r1: { id: "r1", lines: [{ id: "q1", text: "问题", speaker: "1" }, { id: "a1", text: "回答", speaker: "2" }], artifacts: [], resumeMarkdown: "简历背景", roleMarkdown: "岗位", speakerLabels: { "1": "面试官", "2": "候选人" } } };
  const states = new Map();
  const jobs = new Map();
  const calls = [];
  const store = {
    getInterview: (id) => interviews[id] ? structuredClone(interviews[id]) : null,
    getAssistantState: (id) => structuredClone(states.get(id) || { revision: 0, processedLineCount: 0, updatedAt: null, topics: [], followups: [] }),
    saveAssistantState(id, next, { expectedRevision }) {
      assert.equal(store.getAssistantState(id).revision, expectedRevision);
      const saved = { ...next, revision: expectedRevision + 1 };
      states.set(id, structuredClone(saved));
      return structuredClone(saved);
    },
    createAssistantJob(input) {
      const job = { ...input, id: `job-${jobs.size}`, attempts: 0, status: "queued", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      jobs.set(job.id, structuredClone(job));
      return job;
    },
    getAssistantJob: (id) => jobs.has(id) ? structuredClone(jobs.get(id)) : null,
    updateAssistantJob(id, patch) {
      const job = { ...jobs.get(id), ...structuredClone(patch), updatedAt: new Date().toISOString() };
      jobs.set(id, job);
      return structuredClone(job);
    },
    listAssistantJobs: (id, { pendingOnly } = {}) => [...jobs.values()].reverse().filter((job) => job.interviewId === id && (!pendingOnly || ["queued", "running", "retrying"].includes(job.status))).map((job) => structuredClone(job)),
    listRunnableAssistantJobs: () => [...jobs.values()].filter((job) => ["queued", "retrying"].includes(job.status)).map((job) => structuredClone(job)),
    retryAssistantJob: (id) => store.updateAssistantJob(id, { status: "queued", attempts: 0, error: "" }),
  };
  const service = new AssistantJobService({ store, provider: { analyze: async (input, requestOptions) => { calls.push(structuredClone(input)); return analyze(input, requestOptions); } }, concurrency: 0, ...options });
  const runs = [];
  const run = service.run.bind(service);
  service.run = (job) => {
    const completion = run(job);
    runs.push(completion);
    return completion;
  };
  return {
    interviews, calls, store, service, runs,
    restore({ state, job }) {
      states.set(job.interviewId, structuredClone(state));
      jobs.clear();
      jobs.set(job.id, structuredClone(job));
    },
  };
}
