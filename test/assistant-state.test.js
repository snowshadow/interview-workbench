import assert from "node:assert/strict";
import test from "node:test";
import { newerAssistantState, shouldAutoSummarize, createTranscriptWriteQueue } from "../src/lib/assistant-state.js";

test("late assistant snapshots cannot rewind revision or transcript coverage", () => {
  const current = { revision: 4, processedLineCount: 20 };
  assert.equal(newerAssistantState(current, { revision: 3, processedLineCount: 20 }), current);
  assert.equal(newerAssistantState(current, { revision: 5, processedLineCount: 19 }), current);
  assert.deepEqual(newerAssistantState(current, { revision: 5, processedLineCount: 21 }), { revision: 5, processedLineCount: 21 });
});

test("automatic summaries require fresh confirmed lines and never queue behind pending work", () => {
  const input = { recording: true, autoEnabled: true, lineCount: 12, state: { processedLineCount: 10 }, jobs: [], submitting: "" };
  assert.equal(shouldAutoSummarize(input), true);
  for (const patch of [{ recording: false }, { autoEnabled: false }, { lineCount: 10 }, { submitting: "followup" }, { jobs: [{ mode: "followup", status: "queued" }] }, { jobs: [{ mode: "summary", status: "running" }] }, { jobs: [{ mode: "summary", status: "error" }] }]) {
    assert.equal(shouldAutoSummarize({ ...input, ...patch }), false);
  }
});

test("manual assistant requests can await all pending transcript writes in order", async () => {
  const writes = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queue = createTranscriptWriteQueue(async (id, lines) => { if (!writes.length) await gate; writes.push([id, lines]); });
  const first = queue.enqueue("round-a", ["question"]);
  const second = queue.enqueue("round-a", ["answer"]);
  const flush = queue.flush("round-a");
  assert.equal(first, second);
  assert.equal(first, flush);
  assert.deepEqual(writes, []);
  release(); await flush;
  assert.deepEqual(writes, [["round-a", ["question"]], ["round-a", ["answer"]]]);
});

test("failed transcript writes stay available for retry without blocking another round", async () => {
  let failed = true;
  const writes = [];
  const queue = createTranscriptWriteQueue(async (id, lines) => {
    if (id === "round-a" && failed) throw new Error("offline");
    writes.push([id, lines]);
  });
  await assert.rejects(queue.enqueue("round-a", ["answer"]), /offline/);
  await queue.enqueue("round-b", ["unrelated"]);
  failed = false;
  await queue.flushAll();
  assert.deepEqual(writes, [["round-b", ["unrelated"]], ["round-a", ["answer"]]]);
});

test("an enqueue at the end of a drain is not acknowledged before it is written", async () => {
  const writes = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queue = createTranscriptWriteQueue((id, lines) => {
    writes.push(lines[0]);
    return lines[0] === "question" ? gate : Promise.resolve();
  });
  const first = queue.enqueue("round-a", ["question"]);
  // Returning the write promise directly puts this enqueue after the old drain
  // loop finished, but before its separate .finally() cleared queue.promise.
  // Extra await/then layers would miss that window and let the broken code pass.
  const second = gate.then(() => queue.enqueue("round-a", ["answer"]));
  release();
  await Promise.all([first, second]);
  assert.deepEqual(writes, ["question", "answer"]);
});
