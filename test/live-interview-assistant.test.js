import assert from "node:assert/strict";
import test from "node:test";
import { buildLiveAssistantPrompt, createLiveInterviewAssistant, mergeAssistantPatch } from "../server/services/live-interview-assistant.js";

const lines = [{ id: "q1", text: "在连续三轮用户打断、网络重连和工具执行交织的情况下，你们怎么保证状态一致？", speaker: "1" }, { id: "a1", text: "我们用一个统一状态机，我还想补充……", speaker: "2" }];
const initial = {
  revision: 1,
  topics: [{ id: "runtime", title: "实时会话的状态与恢复", shortTitle: "状态与恢复", origin: "outline", summary: "正在介绍状态机", status: "answering", qas: [
    { id: "qa1", question: lines[0].text, shortQuestion: "打断、重连时如何保持一致？", answer: "用统一状态机", status: "answering", evidenceLineIds: ["q1", "a1"], gap: "" },
  ] }, { id: "evaluation", title: "评测与发布", shortTitle: "评测与发布", origin: "outline", summary: "", status: "unasked", qas: [] }],
  followups: [{ id: "f1", topicId: "runtime", qaId: "qa1", question: "发生重复执行怎么办？", purpose: "验证幂等", source: "manual", evidenceLineIds: ["q1"] }],
  focus: { topicId: "runtime", qaId: "qa1", evidenceLineIds: ["a1"] },
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

test("summary can clear resolved suggestions and offer one automatic question for the current focus", () => {
  const result = mergeAssistantPatch(initial, { topics: [], resolvedFollowupIds: ["f1"], followups: [] });
  assert.deepEqual(result.followups, []);
  const next = mergeAssistantPatch(initial, { topics: [], followups: [
    { id: "new", topicId: "runtime", qaId: "qa1", question: "幂等键如何生成？", purpose: "验证幂等", evidenceLineIds: ["a1"] },
    { id: "extra", topicId: "runtime", qaId: "qa1", question: "失效怎么办？", evidenceLineIds: ["a1"] },
    { id: "pending", topicId: "evaluation", question: "如何评测？", evidenceLineIds: [] },
  ] });
  assert.equal(next.followups.length, 1);
  assert.equal(next.followups[0].source, "automatic");
  assert.equal(next.followups[0].question, "幂等键如何生成？");
  assert.deepEqual(mergeAssistantPatch(initial, { topics: [] }).followups, initial.followups);
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

test("a just-asked unanswered QA cannot produce or retain a repeated current question", () => {
  const base = structuredClone(initial);
  base.topics[0].qas[0].answer = "   ";
  const pending = { id: "pending", topicId: "evaluation", question: "如何评测发布质量？", purpose: "验证评测", evidenceLineIds: [] };
  for (const mode of ["summary", "followup"]) {
    const result = mergeAssistantPatch(base, { topics: [], followups: [initial.followups[0], pending] }, { mode });
    assert.deepEqual(result.followups.map((item) => item.id), mode === "followup" ? ["pending"] : []);
    assert.deepEqual(result.focus, initial.focus);
  }
  const omitted = mergeAssistantPatch(base, { topics: [] });
  assert.deepEqual(omitted.followups, [], "an unchanged but premature current suggestion must also be removed");
  base.topics[0].qas[0].answer = "刚开始介绍统一状态机";
  const ongoing = mergeAssistantPatch(base, { topics: [], followups: [initial.followups[0]] });
  assert.equal(ongoing.topics[0].qas[0].status, "answering");
  assert.equal(ongoing.followups.length, 1, "an ongoing answer with actual content can still be clarified");
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
  await assert.rejects(invalid.analyze({}), (error) => error.code === "ASSISTANT_INVALID_OUTPUT" && /invalid JSON/.test(error.validationFeedback));
});

test("all existing evidence and unsliced outline stay available across long sessions", () => {
  const outline = "提纲".repeat(60000);
  const prompt = JSON.parse(buildLiveAssistantPrompt({ state: initial, outlineMarkdown: outline }));
  assert.equal(prompt.background.outlineMarkdown, outline);
  assert.equal(prompt.currentState.topics[0].qas[0].evidenceLineIds.length, 2);
  assert.ok(prompt.currentState.topics[0].qas[0].evidenceLineIds.every((id) => /^L[\da-f]{16}$/.test(id)));
});

test("an unsolicited introduction can be summarized with topic evidence without fabricating a question", async () => {
  const statement = { id: "run:0:487101:497101:我主要做数据平台，现在先介绍一下过去的经历。", text: "我主要做数据平台，现在先介绍一下过去的经历。", speaker: "0" };
  const analyzer = createLiveInterviewAssistant({ async chatComplete(body) {
    const input = JSON.parse(body.messages[1].content);
    return JSON.stringify({ topics: [{ id: "intro", title: "工作经历", origin: "emergent", summary: "正在介绍数据平台经历", status: "answering", evidenceLineIds: [input.newRoundLines[0].id], qas: [] }] });
  } });
  const state = await analyzer.analyze({ transcriptLines: [statement] });
  assert.equal(state.topics[0].summary, "正在介绍数据平台经历");
  assert.equal(state.topics[0].status, "answering");
  assert.deepEqual(state.topics[0].qas, []);
  assert.deepEqual(state.topics[0].evidenceLineIds, [statement.id]);
  const next = mergeAssistantPatch(state, { topics: [{ id: "intro", summary: "已介绍两段数据平台经历", evidenceLineIds: ["continuation"] }] }, { lines: [{ id: "continuation" }] });
  assert.deepEqual(next.topics[0].evidenceLineIds, [statement.id, "continuation"]);
  assert.throws(() => mergeAssistantPatch({}, { topics: [{ id: "unsupported", title: "未出现的经验", origin: "emergent", summary: "来自简历", qas: [] }] }), /needs actual transcript evidence/);
  assert.throws(() => mergeAssistantPatch({}, { topics: [{ id: "unsupported", title: "经验", origin: "emergent", evidenceLineIds: [statement.id], qas: [{ id: "q", question: "", answer: "自述" }] }] }, { lines: [statement] }), /actual question/);
});

test("long stored references stay stable and round-trip through short model IDs without recopying old evidence", async () => {
  const originals = Array.from({ length: 81 }, (_, index) => `run:0:${index}:转录第${index}段，包含逗号、时间:12:30和容易误抄的原文。${"长陈述".repeat(40)}`);
  const base = structuredClone(initial);
  base.topics[0].qas[0].evidenceLineIds = originals;
  base.followups[0].evidenceLineIds = ["old-followup-only-reference"];
  const newLine = { id: "run:0:82:这是新增的一段回答。", text: "这是新增的一段回答。" };
  let prompt;
  const analyzer = createLiveInterviewAssistant({ async chatComplete(body) {
    prompt = JSON.parse(body.messages[1].content);
    return JSON.stringify({ topics: [{ id: "runtime", qas: [{ id: "qa1", answer: "先前回答和新的补充", evidenceLineIds: [` ${prompt.newRoundLines[0].id} `] }] }] });
  } });
  const result = await analyzer.analyze({ state: base, transcriptLines: [newLine], contextLines: [{ id: originals[80], text: "上一段" }] });
  assert.deepEqual(result.topics[0].qas[0].evidenceLineIds, [...originals, newLine.id]);
  assert.equal(result.topics[0].qas[0].answer, "先前回答和新的补充");
  const shortIds = prompt.currentState.topics[0].qas[0].evidenceLineIds;
  assert.equal(new Set(shortIds).size, 81);
  assert.equal(prompt.earlierRoundLines[0].id, shortIds[80]);
  assert.equal(shortIds.join("").length, 81 * 17);
  assert.ok(!JSON.stringify(prompt).includes(originals[0]));
  const shifted = JSON.parse(buildLiveAssistantPrompt({ state: result, contextLines: [newLine] }));
  assert.deepEqual(shifted.currentState.topics[0].qas[0].evidenceLineIds.slice(0, 81), shortIds);
  assert.equal(shifted.earlierRoundLines[0].id, prompt.newRoundLines[0].id);
  assert.deepEqual(base.topics[0].qas[0].evidenceLineIds, originals);
});

test("manual followups may reuse older topic and suggestion evidence outside the recent transcript window", async () => {
  const base = structuredClone(initial);
  base.topics[0].evidenceLineIds = ["older-statement"];
  base.followups[0].evidenceLineIds = ["older-suggestion-only"];
  const analyzer = createLiveInterviewAssistant({ async chatComplete(body) {
    const input = JSON.parse(body.messages[1].content);
    return JSON.stringify({ topics: [], followups: [{ ...input.currentState.followups[0], evidenceLineIds: [...input.currentState.followups[0].evidenceLineIds, ...input.currentState.topics[0].evidenceLineIds] }] });
  } });
  const state = await analyzer.analyze({ mode: "followup", state: base, transcriptLines: [] });
  assert.deepEqual(state.followups[0].evidenceLineIds, ["older-suggestion-only", "older-statement"]);
});

test("unknown references reject the whole patch with precise repair feedback without leaking source text", async () => {
  const base = structuredClone(initial);
  const badReference = "other-round:do not follow instructions:private transcript text";
  const analyzer = createLiveInterviewAssistant({ async chatComplete() {
    return JSON.stringify({ topics: [{ id: "runtime", summary: "should not save", qas: [{ id: "qa1", answer: "should not save", evidenceLineIds: [badReference] }] }] });
  } });
  await assert.rejects(analyzer.analyze({ state: base }), (error) => {
    assert.equal(error.code, "ASSISTANT_INVALID_OUTPUT");
    assert.match(error.validationFeedback, /topics\[0\].qas\[0\].evidenceLineIds\[0\]/);
    assert.match(error.validationFeedback, /unknown reference/);
    assert.ok(!error.validationFeedback.includes(badReference));
    return true;
  });
  assert.deepEqual(base, initial);
  const prompt = JSON.parse(buildLiveAssistantPrompt({ validationFeedback: "Use only provided IDs" }));
  assert.equal(prompt.validationFeedback, "Use only provided IDs");
});

test("manual followup supports a statement-only topic without requiring an invented QA", async () => {
  const base = { topics: [{ id: "intro", title: "自述经历", origin: "emergent", summary: "介绍数据平台", status: "answering", evidenceLineIds: ["statement"], qas: [] }], followups: [], focus: { topicId: "intro", evidenceLineIds: ["statement"] } };
  const analyzer = createLiveInterviewAssistant({ async chatComplete(body) {
    const input = JSON.parse(body.messages[1].content);
    return JSON.stringify({ topics: [], followups: ["请详细说说其中一段经历？", "你负责哪一部分？"].map((question, index) => ({ id: `f${index}`, topicId: "intro", question, evidenceLineIds: input.currentState.topics[0].evidenceLineIds })) });
  } });
  const result = await analyzer.analyze({ mode: "followup", state: base });
  assert.equal(result.followups.length, 1);
  assert.equal(result.followups[0].qaId, undefined);
  assert.deepEqual(result.followups[0].evidenceLineIds, ["statement"]);
  assert.deepEqual(result.topics[0].qas, []);
});

test("focus follows the latest actual evidence when returning to an earlier topic, not directory or patch order", () => {
  const base = structuredClone(initial);
  base.topics.push({ id: "later", title: "后面的主题", origin: "emergent", summary: "旧陈述", status: "answering", evidenceLineIds: ["old"], qas: [] });
  base.focus = { topicId: "later", evidenceLineIds: ["old"] };
  base.followups = [{ id: "stale", topicId: "later", question: "旧陈述的问题？", source: "automatic", evidenceLineIds: ["old"] }];
  const result = mergeAssistantPatch(base, { topics: [
    { id: "runtime", qas: [{ id: "qa2", question: "重连时哪个状态优先？", answer: "以服务端为准", status: "answered", evidenceLineIds: ["new-question", "new-answer"] }] },
    { id: "later", summary: "补上先前陈述", evidenceLineIds: ["old"] },
  ] }, { lines: [{ id: "old" }, { id: "new-question" }, { id: "new-answer" }] });
  assert.equal(result.focus.topicId, "runtime");
  assert.equal(result.focus.qaId, "qa2");
  assert.deepEqual(result.topics.map((topic) => topic.id), ["runtime", "evaluation", "later"]);
  assert.deepEqual(result.followups, []);
});

test("answering status alone cannot establish a missing focus", () => {
  const base = structuredClone(initial);
  delete base.focus;
  const result = mergeAssistantPatch(base, { topics: [] });
  assert.equal(result.focus, null);
  assert.deepEqual(result.followups, []);
});

test("null focus and historical catch-up remove current suggestions but retain manual unanswered topics", () => {
  const base = structuredClone(initial);
  base.followups.push({ id: "pending", topicId: "evaluation", question: "如何设定发布门槛？", purpose: "验证评测", source: "manual", evidenceLineIds: [] });
  const cleared = mergeAssistantPatch(base, { topics: [], focus: null });
  assert.equal(cleared.focus, null);
  assert.deepEqual(cleared.followups.map((item) => item.id), ["pending"]);
  const historical = mergeAssistantPatch(base, { topics: [], followups: [initial.followups[0]] }, { isLatestChunk: false });
  assert.deepEqual(historical.focus, initial.focus);
  assert.deepEqual(historical.followups.map((item) => item.id), ["pending"]);
});

test("moving to a new QA within the same topic removes stale QA suggestions", () => {
  const result = mergeAssistantPatch(initial, {
    topics: [{ id: "runtime", qas: [{ id: "qa2", question: "故障之后如何回滚？", answer: "切回上一版本", status: "answered", evidenceLineIds: ["q2"] }] }],
    focus: { topicId: "runtime", qaId: "qa2", evidenceLineIds: ["q2"] },
    followups: [{ ...initial.followups[0] }, { id: "new", topicId: "runtime", qaId: "qa2", question: "回滚结果如何验证？", purpose: "验证恢复", evidenceLineIds: ["q2"] }],
  }, { lines: [{ id: "q2" }] });
  assert.deepEqual(result.followups.map((item) => item.id), ["new"]);
  assert.equal(result.followups[0].source, "automatic");
});

test("same-ID followups can change meaning as the answer develops, while harmless whitespace stays stable", () => {
  for (const mode of ["summary", "followup"]) {
    const changed = mergeAssistantPatch(initial, { topics: [], followups: [{ ...initial.followups[0], question: "你本人改了哪部分？", purpose: "确认职责", source: "forged" }] }, { mode });
    assert.equal(changed.followups[0].question, "你本人改了哪部分？");
    assert.equal(changed.followups[0].source, mode === "summary" ? "automatic" : "manual");
    const stable = mergeAssistantPatch(initial, { topics: [], followups: [{ ...initial.followups[0], question: "发生重复执行 怎么办？" }] }, { mode });
    assert.equal(stable.followups[0].question, initial.followups[0].question);
  }
});

test("focus rejects unknown topics, cross-topic QAs and valid references belonging to another record", () => {
  const base = structuredClone(initial);
  base.topics[1].qas = [{ id: "eval-qa", question: "怎样评测？", answer: "使用回归集", status: "answered", evidenceLineIds: ["eval-source"], gap: "" }];
  for (const focus of [
    { topicId: "unknown", evidenceLineIds: ["a1"] },
    { topicId: "evaluation", qaId: "qa1", evidenceLineIds: ["a1"] },
    { topicId: "runtime", qaId: "qa1", evidenceLineIds: ["eval-source"] },
    { topicId: "runtime", evidenceLineIds: ["eval-source"] },
    { topicId: "runtime", qaId: "qa1", evidenceLineIds: [] },
  ]) assert.throws(() => mergeAssistantPatch(base, { topics: [], focus }), /focus/);
});

test("focus references round-trip through short aliases and invalid focus feedback names the exact path", async () => {
  let captured;
  const analyzer = createLiveInterviewAssistant({ async chatComplete(body) {
    captured = JSON.parse(body.messages[1].content);
    return JSON.stringify({ topics: [], focus: captured.currentState.focus, followups: [] });
  } });
  const result = await analyzer.analyze({ state: initial, isLatestChunk: false });
  assert.match(captured.currentState.focus.evidenceLineIds[0], /^L[\da-f]{16}$/);
  assert.equal(captured.isLatestChunk, false);
  assert.deepEqual(result.focus, initial.focus);
  const invalid = createLiveInterviewAssistant({ async chatComplete() {
    return JSON.stringify({ topics: [], focus: { topicId: "runtime", qaId: "qa1", evidenceLineIds: ["Ldeadbeef"] } });
  } });
  await assert.rejects(invalid.analyze({ state: initial }), (error) => /focus.evidenceLineIds\[0\]/.test(error.validationFeedback));
});

test("existing full questions are retained while the model receives compact historical labels", () => {
  const original = lines[0].text.repeat(5);
  const base = structuredClone(initial);
  base.topics[0].qas[0].question = original;
  const prompt = JSON.parse(buildLiveAssistantPrompt({ state: base }));
  assert.equal(prompt.currentState.topics[0].qas[0].question, undefined);
  assert.equal(prompt.currentState.topics[0].qas[0].shortQuestion, initial.topics[0].qas[0].shortQuestion);
  assert.equal(prompt.currentQuestion.question, original);
  const result = mergeAssistantPatch(base, { topics: [{ id: "runtime", qas: [{ id: "qa1", question: "模型缩写了原问题", answer: "新的补充" }] }] });
  assert.equal(result.topics[0].qas[0].question, original);
});

test("display compression gets one focused pass, preserves full records and does not rewrite unrelated historical answers", async () => {
  const base = structuredClone(initial);
  const fullTitle = "实时会话在连续打断和重连时的状态一致性与失败恢复";
  const fullQuestion = lines[0].text.repeat(3);
  base.topics[0].title = fullTitle;
  delete base.topics[0].shortTitle;
  base.topics[0].qas[0].question = fullQuestion;
  delete base.topics[0].qas[0].shortQuestion;
  base.topics[1].qas = [{ id: "historic", question: "这是很早以前问过而当前没有讨论的一个长问题，需要为目录补短标题。", answer: "未涉及的旧回答".repeat(25), status: "answered", evidenceLineIds: ["history"] }];
  let calls = 0;
  let compressed;
  const analyzer = createLiveInterviewAssistant({ async chatComplete(body) {
    calls += 1;
    if (calls === 1) return JSON.stringify({ topics: [{ id: "runtime", summary: "进度说明".repeat(35), qas: [{ id: "qa1", answer: "关键回答".repeat(35), gap: "待核实的关键条件".repeat(6), status: "partial" }] }], followups: [{ id: "f2", topicId: "runtime", qaId: "qa1", question: "请详细说明这个系统在什么条件下出现失败".repeat(3), purpose: "验证端到端故障恢复能力", evidenceLineIds: [] }] });
    compressed = JSON.parse(body.messages[1].content);
    return JSON.stringify({ fields: [
      ...compressed.fields.map((field) => ({ path: field.path, text: field.path.endsWith("shortTitle") ? "状态与恢复" : "简洁要点" })),
      { path: "topics[0].title", text: "不应改写" }, { path: "topics[0].qas[0].question", text: "不应改写" },
    ] });
  } });
  const result = await analyzer.analyze({ state: base });
  assert.equal(calls, 2);
  assert.ok(compressed.fields.some((field) => field.path === "topics[1].qas[0].shortQuestion"));
  assert.ok(!compressed.fields.some((field) => field.path === "topics[1].qas[0].answer"));
  assert.equal(result.topics[0].title, fullTitle);
  assert.equal(result.topics[0].qas[0].question, fullQuestion);
  assert.equal(result.topics[1].qas[0].answer, base.topics[1].qas[0].answer);
  assert.equal(result.topics[0].qas[0].answer, "简洁要点");
  assert.ok(Array.from(result.topics[0].shortTitle).length <= 12);
  assert.ok(result.followups[0].question.length <= 32);
  assert.ok(result.followups[0].purpose.length <= 8);
  assert.deepEqual(result.topics[0].qas[0].evidenceLineIds, base.topics[0].qas[0].evidenceLineIds);
});

test("failed or still-too-long compression falls back to bounded text without blocking valid progress", async () => {
  for (const repair of ["failure", "still-long"]) {
    let calls = 0;
    const analyzer = createLiveInterviewAssistant({ async chatComplete(body) {
      if (++calls === 1) return JSON.stringify({ topics: [{ id: "runtime", shortTitle: "很长的标题".repeat(8), summary: "总结".repeat(70), qas: [{ id: "qa1", shortQuestion: "需要压缩的问题".repeat(8), answer: "回答".repeat(70), gap: "缺少条件".repeat(10), status: "partial" }] }], followups: [{ id: "long", topicId: "runtime", qaId: "qa1", question: "这是尚需核实的一个问题".repeat(8), purpose: "需要核实这段真实经历", evidenceLineIds: [] }] });
      if (repair === "failure") throw new Error("compression timeout");
      return JSON.stringify({ fields: JSON.parse(body.messages[1].content).fields.map((field) => ({ path: field.path, text: "仍然超长".repeat(40) })) });
    } });
    const result = await analyzer.analyze({ state: initial });
    assert.equal(calls, 2);
    const topic = result.topics[0];
    const qa = topic.qas[0];
    for (const [value, limit] of [[topic.shortTitle, 12], [topic.summary, 80], [qa.shortQuestion, 24], [qa.answer, 80], [qa.gap, 24], [result.followups[0].question, 32], [result.followups[0].purpose, 8]]) {
      assert.ok(Array.from(value).length <= limit);
      assert.ok(value.endsWith("…"));
    }
    assert.equal(qa.question, lines[0].text);
    assert.deepEqual(result.focus, initial.focus);
  }
});

test("candidate questions keep the conversation but suppress automatic, manual and stale followups", () => {
  for (const mode of ["summary", "followup"]) {
    const base = structuredClone(initial);
    base.followups.push({ id: "pending", topicId: "evaluation", question: "如何评测？", source: "manual", evidenceLineIds: [] });
    const result = mergeAssistantPatch(base, {
      topics: [{ id: "runtime", qas: [{ id: "qa1", askedBy: "candidate", status: "partial", gap: "缺少数字", evidenceLineIds: [] }] }],
      followups: base.followups,
    }, { mode });
    assert.deepEqual(result.followups, []);
    assert.equal(result.topics[0].qas[0].gap, "");
    assert.equal(result.topics[0].qas[0].answer, initial.topics[0].qas[0].answer);
    assert.equal(result.topics[0].qas[0].askedBy, "candidate");
    assert.deepEqual(mergeAssistantPatch(result, { topics: [] }).followups, []);
    const resumed = mergeAssistantPatch(result, {
      topics: [{ id: "runtime", qas: [{ id: "qa1", askedBy: "interviewer", evidenceLineIds: [] }] }],
      followups: [initial.followups[0]],
    }, { mode });
    assert.equal(resumed.followups.length, 1);
  }
});

test("legacy candidate-question topics and statement-only candidate turns suppress suggestions", () => {
  const base = structuredClone(initial);
  base.topics[0].title = "候选人提问";
  assert.deepEqual(mergeAssistantPatch(base, { topics: [] }).followups, []);
  base.topics[0].title = "公司情况";
  base.topics[0].askedBy = "candidate";
  base.topics[0].evidenceLineIds = ["a1"];
  base.topics[0].qas = [];
  base.focus = { topicId: "runtime", evidenceLineIds: ["a1"] };
  assert.deepEqual(mergeAssistantPatch(base, { topics: [], followups: [{ topicId: "runtime", question: "为何这样？", evidenceLineIds: ["a1"] }] }).followups, []);
});
