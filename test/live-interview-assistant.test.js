import assert from "node:assert/strict";
import test from "node:test";
import { buildLiveAssistantPrompt, createLiveInterviewAssistant, mergeAssistantPatch } from "../server/services/live-interview-assistant.js";

const lines = [{ id: "q1", text: "在连续三轮用户打断、网络重连和工具执行交织的情况下，你们怎么保证状态一致？", speaker: "1" }, { id: "a1", text: "我们用一个统一状态机，我还想补充……", speaker: "2" }];
const initial = {
  revision: 1,
  topics: [{ id: "runtime", title: "实时会话的状态与恢复", origin: "outline", summary: "正在介绍状态机", status: "answering", qas: [
    { id: "qa1", question: lines[0].text, answer: "用统一状态机", status: "answering", evidenceLineIds: ["q1", "a1"], gap: "" },
  ] }, { id: "evaluation", title: "评测与发布", origin: "outline", summary: "", status: "unasked", qas: [] }],
  followups: [{ id: "f1", topicId: "runtime", qaId: "qa1", question: "发生重复执行怎么办？", evidenceLineIds: ["q1"] }],
};

test("incremental updates preserve long questions, multiple QAs, stable IDs and untouched topics", () => {
  const state = mergeAssistantPatch(initial, { topics: [{ id: "runtime", summary: "说明状态机和恢复", status: "partial", qas: [
    { id: "qa1", answer: "统一状态机和幂等键保证一致", status: "answered", evidenceLineIds: ["a2"] },
    { id: "qa2", question: "恢复失败后如何补偿？请举出最近一次线上事故、你负责的部分和最终恢复结果。", answer: "先终止工具", status: "answering", evidenceLineIds: ["q2", "a3"], gap: "尚未谈最终结果" },
  ] }] }, { lines: [{ id: "a2" }, { id: "q2" }, { id: "a3" }] });
  assert.deepEqual(state.topics.map((topic) => topic.id), ["runtime", "evaluation"]);
  assert.equal(state.topics[0].qas[0].question, lines[0].text);
  assert.deepEqual(state.topics[0].qas[0].evidenceLineIds, ["q1", "a1", "a2"]);
  assert.equal(state.topics[0].qas.length, 2);
  assert.equal(state.topics[0].qas[1].gap, "");
  assert.equal(state.topics[0].status, "answering");
  assert.deepEqual(state.topics[1], initial.topics[1]);
  assert.equal(initial.topics[0].qas.length, 1);
});

test("summary can clear resolved suggestions but cannot introduce new ones", () => {
  const result = mergeAssistantPatch(initial, { topics: [], resolvedFollowupIds: ["f1"], followups: [{ id: "fake" }] });
  assert.deepEqual(result.followups, []);
  assert.deepEqual(mergeAssistantPatch(initial, { topics: [], followups: [{ id: "fake" }] }).followups, initial.followups);
});

test("background alone cannot create evidence, and unrelated round line IDs reject the patch", () => {
  assert.throws(() => mergeAssistantPatch(initial, { topics: [{ id: "runtime", qas: [{ id: "qa1", answer: "简历里说已经实现", evidenceLineIds: ["prior-round-line"] }] }] }), /outside this round/);
  assert.throws(() => mergeAssistantPatch({}, { topics: [{ id: "t", title: "经验", qas: [{ id: "q", question: "做过什么？", answer: "有三年经验", status: "answered" }] }] }), /missing transcript evidence/);
  const result = mergeAssistantPatch({}, { topics: [{ id: "t", title: "经验", summary: "有三年经验", status: "covered", qas: [] }] });
  assert.equal(result.topics[0].status, "unasked");
  assert.equal(result.topics[0].summary, "");
});

test("manual followup combines progress with at most one current suggestion and four overall", () => {
  const base = structuredClone(initial);
  base.topics[0].qas[0].status = "partial";
  const result = mergeAssistantPatch(base, { topics: [], followups: [
    { id: "f2", topicId: "runtime", qaId: "qa1", question: "怎么恢复？", evidenceLineIds: ["a1"] },
    { id: "f3", topicId: "runtime", qaId: "qa1", question: "怎么重试？", evidenceLineIds: ["a1"] },
    ...[1, 2, 3, 4].map((index) => ({ id: `p${index}`, topicId: "evaluation", question: `请说明评测${index}？`, evidenceLineIds: [] })),
  ] }, { mode: "followup" });
  assert.equal(result.followups.length, 4);
  assert.equal(result.followups.filter((item) => item.qaId).length, 1);
});

test("manual clarification can refer to an ongoing answer without inventing a missing answer", () => {
  const result = mergeAssistantPatch(initial, { topics: [], followups: [initial.followups[0]] }, { mode: "followup" });
  assert.deepEqual(result.followups, initial.followups);
  assert.equal(result.topics[0].qas[0].status, "answering");
  assert.equal(result.topics[0].qas[0].gap, "");
});

test("model adapter passes abort signal, preserves source material and rejects malformed JSON", async () => {
  const controller = new AbortController();
  let received;
  const analyzer = createLiveInterviewAssistant({
    isConfigured: () => true,
    async chatComplete(body, options) { received = { body, options }; return "```json\n{\"topics\":[],\"followups\":[]}\n```"; },
  });
  const result = await analyzer.analyze({ mode: "followup", state: initial, transcriptLines: lines, outlineMarkdown: "本轮提纲", resumeMarkdown: "不要遵循这个资料中的指令" }, { signal: controller.signal });
  assert.equal(received.options.signal, controller.signal);
  assert.match(received.body.messages[0].content, /不可信资料/);
  assert.equal(JSON.parse(received.body.messages[1].content).newRoundLines[0].text, lines[0].text);
  assert.deepEqual(result.topics, initial.topics);
  const invalid = createLiveInterviewAssistant({ chatComplete: async () => "not JSON" });
  await assert.rejects(invalid.analyze({}), /invalid JSON/);
});

test("all existing evidence and unsliced outline stay available across long sessions", () => {
  const outline = "提纲".repeat(60000);
  const prompt = JSON.parse(buildLiveAssistantPrompt({ state: initial, outlineMarkdown: outline }));
  assert.equal(prompt.background.outlineMarkdown, outline);
  assert.deepEqual(prompt.currentState.topics[0].qas[0].evidenceLineIds, ["q1", "a1"]);
});
