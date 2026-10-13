import assert from "node:assert/strict";
import test from "node:test";
import { assistantDisplayLabel, assistantReviewRows, buildAssistantView } from "../src/lib/assistant-view.js";

const lines = Array.from({ length: 6 }, (_, index) => ({ id: `line-${index}`, endTime: index * 1000 }));
const qa = (id, positions, shortQuestion = id) => ({ id, shortQuestion, question: `完整问题 ${id}`, evidenceLineIds: positions.map((index) => lines[index].id) });
const topic = (id, qas = [], status = "answering") => ({ id, title: id, shortTitle: id, status, qas });

test("legacy focus follows the newest source even when returning to the first topic", () => {
  const view = buildAssistantView({ topics: [topic("first", [qa("older", [0, 5])]), topic("last", [qa("later", [2, 3])])] }, lines);
  assert.equal(view.focus.topicId, "first");
  assert.equal(view.focus.qaId, "older");
  assert.deepEqual(view.asked.map((row) => row.qa.id), ["older", "later"]);
});

test("explicit focus and a deliberate null focus override legacy inference", () => {
  const topics = [topic("one", [qa("one-q", [1])]), topic("two", [qa("two-q", [5])])];
  assert.equal(buildAssistantView({ topics, focus: { topicId: "one", qaId: "one-q" } }, lines).focus.qaId, "one-q");
  assert.equal(buildAssistantView({ topics, focus: null }, lines).focus, null);
  assert.equal(buildAssistantView({ topics, focus: { topicId: "one", qaId: "missing" } }, lines).focus, null);
  assert.equal(buildAssistantView({ topics: [topic("outline", [], "unasked")] }, lines).focus, null);
});

test("new self-introduction evidence can be current without inventing a question", () => {
  const view = buildAssistantView({ topics: [{ ...topic("experience", [qa("old", [1])]), evidenceLineIds: [lines[5].id] }] }, lines);
  assert.equal(view.focus.topicId, "experience");
  assert.equal(view.focus.qaId, undefined);
  assert.equal(view.focus.qa, null);
});

test("evidenced statements remain reviewable without being counted as questions", () => {
  const introduction = { ...topic("intro"), summary: "已介绍项目经历", evidenceLineIds: [lines[4].id, lines[5].id] };
  const view = buildAssistantView({ topics: [topic("one", [qa("asked", [1])]), introduction, topic("outline", [], "unasked")] }, lines);
  assert.equal(view.asked.length, 1);
  assert.equal(view.recorded.length, 2);
  const recent = assistantReviewRows(view);
  assert.deepEqual(recent.map((row) => row.id), ["qa:one:asked", "statement:intro"]);
  assert.equal(recent[1].kind, "statement");
  assert.equal(recent[1].qa, null);
  assert.equal(recent[1].topic.summary, introduction.summary);
  assert.deepEqual(recent[1].evidenceLineIds, introduction.evidenceLineIds);
  assert.equal(assistantReviewRows(view, { mode: "asked" }).length, 2);
});

test("pending topic details retain their manually requested followup", () => {
  const manual = { topicId: "todo", source: "manual", question: "如何验收质量？", purpose: "验收依据", evidenceLineIds: [lines[2].id] };
  const view = buildAssistantView({
    topics: [topic("todo", [], "unasked")],
    followups: [{ ...manual, source: "automatic", question: "自动建议" }, { ...manual, qaId: "old-question" }, manual],
  }, lines);
  const row = assistantReviewRows(view, { mode: "pending" })[0];
  assert.equal(row.followup, manual);
  assert.equal(row.title, "todo");
  assert.deepEqual(row.evidenceLineIds, manual.evidenceLineIds);
  assert.equal(view.suggestion, null);
});

test("suggestions match the exact current question, independently of browsing", () => {
  const state = {
    topics: [topic("one", [qa("one-q", [5]), qa("old-q", [1])])],
    focus: { topicId: "one", qaId: "one-q", evidenceLineIds: [lines[5].id] },
    followups: [
      { id: "old", topicId: "one", qaId: "old-q", question: "旧问题的建议" },
      { id: "topic-only", topicId: "one", question: "话题建议" },
      { id: "current", topicId: "one", qaId: "one-q", question: "当前追问", evidenceLineIds: [lines[4].id] },
    ],
  };
  const view = buildAssistantView(state, lines);
  assert.equal(view.suggestion.id, "current");
  assert.equal(view.suggestionLine.id, lines[4].id);
  assert.equal(buildAssistantView({ ...state, focus: { topicId: "one" } }, lines).suggestion.id, "topic-only");
});

test("unprocessed speech is distinguished from the saved focus and suggestion basis", () => {
  const view = buildAssistantView({ processedLineCount: 3, topics: [topic("one", [qa("known", [1]), qa("not-processed", [5])])] }, lines);
  assert.equal(view.hasUnprocessed, true);
  assert.equal(view.lastProcessedLine.id, lines[2].id);
  assert.equal(view.focus.qaId, "known");
});

test("review snapshots retain their rows while the default recent list advances", () => {
  const view = buildAssistantView({ topics: [topic("one", [qa("a", [0]), qa("b", [1]), qa("c", [2])])] }, lines);
  const review = { mode: "recent", snapshot: { asked: view.asked, pending: view.pending, recent: assistantReviewRows(view) } };
  const next = buildAssistantView({ topics: [topic("one", [qa("a", [0]), qa("b", [1]), qa("c", [2]), qa("d", [5])]), topic("todo", [], "unasked")] }, lines);
  assert.deepEqual(assistantReviewRows(next, review).map((row) => row.qa.id), ["a", "b"]);
  assert.deepEqual(assistantReviewRows(next).map((row) => row.qa.id), ["a", "b", "c"]);
  assert.equal(assistantReviewRows(next, { mode: "asked" }).length, 4);
  assert.equal(assistantReviewRows(next, { mode: "pending" })[0].topic.id, "todo");
});

test("display labels recover clipped legacy text without changing complete short labels", () => {
  const full = "我们怎样验证长问题😀的完整意思以及重要条件是否保留？";
  for (const short of [undefined, "", "旧问题…", "旧问题……", "旧问题...  "]) {
    assert.equal(assistantDisplayLabel(short, full), full);
  }
  assert.equal(assistantDisplayLabel("怎样验证关键条件？", full), "怎样验证关键条件？");
  assert.equal(assistantDisplayLabel("先验…再验？", full), "先验…再验？");
  assert.equal(assistantDisplayLabel("仅剩残文…", ""), "仅剩残文…");
});

test("review labels preserve full text for width-based truncation in every list", () => {
  const old = qa("old", [0]);
  delete old.shortQuestion;
  old.question = "完整问题".repeat(20);
  const statement = { ...topic("intro"), title: "个人项目经历以及完整职责", shortTitle: "个人项目经…", evidenceLineIds: [lines[4].id] };
  const pending = { ...topic("todo", [], "unasked"), title: "三十天养成价值与证据判断", shortTitle: "三十天养成..." };
  const state = { topics: [topic("one", [old]), statement, pending] };
  const before = structuredClone(state);
  const view = buildAssistantView(state, lines);
  assert.equal(view.asked[0].title, old.question);
  assert.equal(view.recorded.find((row) => row.kind === "statement").title, statement.title);
  assert.equal(view.pending[0].title, pending.title);
  assert.deepEqual(state, before);
});

test("candidate questions hide stale suggestions while keeping the question and answer reviewable", () => {
  for (const explicitRole of [false, true]) {
    const question = { ...qa("q", [5]), answer: "通常按季度回款", ...(explicitRole ? { askedBy: "candidate" } : {}) };
    const current = { ...topic("company", [question], "partial"), title: explicitRole ? "回款周期" : "候选人提问" };
    const state = { topics: [current], focus: { topicId: current.id, qaId: question.id }, followups: [{ topicId: current.id, qaId: question.id, question: "周期为何这么长？" }] };
    const view = buildAssistantView(state, lines);
    assert.equal(view.candidateQuestion, true);
    assert.equal(view.suggestion, null);
    assert.equal(view.recorded[0].qa.answer, question.answer);
    question.askedBy = "interviewer";
    const resumed = buildAssistantView(state, lines);
    assert.equal(resumed.candidateQuestion, false);
    assert.equal(resumed.suggestion.question, "周期为何这么长？");
  }
});
