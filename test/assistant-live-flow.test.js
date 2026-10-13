import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../server/storage/sqlite-store.js";
import { AssistantJobService } from "../server/services/assistant-job-service.js";
import { createLiveInterviewAssistant } from "../server/services/live-interview-assistant.js";
import { cleanupTestConfig, createTestConfig, sampleInterview, silentLogger } from "./helpers.js";

test("live focus follows A to B and back to A while stored evidence and automatic/manual suggestions stay consistent", async () => {
  const config = createTestConfig("assistant-live-flow-");
  const store = new SqliteStore(config, silentLogger);
  const texts = [
    "请介绍断线后恢复会话的完整过程，并说明你本人负责的实现。",
    "我负责恢复状态机，重连时从保存的状态继续执行。",
    "现在聊模型评测，你们如何验证一次模型升级确实有效？",
    "我们用固定问题集进行离线回放，还没有说明线上结果。",
    "回到刚才的断线恢复，如何避免恢复后重复执行先前的工具？",
    "我增加了幂等键，目前只在测试环境验证了重复调用。",
    "补充刚才的验证结果，灰度环境连续运行两天，没有再出现重复调用。",
  ];
  const lines = texts.map((text, index) => ({
    id: `fixture-session:${index % 2 ? "candidate" : "interviewer"}:${index * 10000}:${(index + 1) * 10000}:${text}`,
    text, speaker: index === 6 || index % 2 ? "2" : "1", startTime: index * 10000, endTime: (index + 1) * 10000,
  }));
  const prompts = [];
  const outputs = [
    (prompt) => ({
      topics: [
        topic("a", "断线后的会话状态恢复与个人实现职责", "断线恢复", qa("a1", texts[0], "如何恢复会话", "负责恢复状态机，重连后继续执行。", refs(prompt))),
        { id: "c", title: "团队协作中的分工与交接机制", shortTitle: "团队协作", origin: "outline", summary: "", status: "unasked", qas: [] },
      ],
      focus: focus("a", "a1", refs(prompt)),
      followups: [suggestion("auto-a1", "a", "a1", "恢复失败时如何处理？", "确认恢复", refs(prompt))],
    }),
    (prompt) => ({
      topics: [topic("b", "模型升级的离线评测与线上验证结果", "模型评测", qa("b1", texts[2], "如何验证模型升级", "用固定问题集离线回放，线上结果尚未说明。", refs(prompt)))],
      focus: focus("b", "b1", refs(prompt)),
      followups: [suggestion("auto-b1", "b", "b1", "线上效果如何验证？", "补充线上", refs(prompt))],
    }),
    (prompt) => ({
      topics: [{ id: "a", summary: "已介绍状态机和幂等处理，验证暂限于测试环境。", qas: [qa("a2", texts[4], "如何避免重复执行工具", "增加幂等键，已在测试环境验证重复调用。", refs(prompt))] }],
      focus: focus("a", "a2", refs(prompt)),
      followups: [suggestion("auto-a2", "a", "a2", "幂等处理在线上是否验证过？", "核实结果", refs(prompt))],
    }),
    (prompt) => ({
      topics: [],
      focus: prompt.currentState.focus,
      followups: [
        suggestion("manual-a2", "a", "a2", "请举一次上线后的实际验证结果。", "追问验证", prompt.currentState.focus.evidenceLineIds),
        suggestion("manual-a2-extra", "a", "a2", "出现冲突时幂等键怎么处理？", "补充边界", prompt.currentState.focus.evidenceLineIds),
        suggestion("manual-c", "c", null, "你与同事如何划分项目职责？", "覆盖协作", []),
      ],
    }),
    (prompt) => ({
      topics: [{ id: "a", summary: "已说明幂等处理，并补充两天灰度验证结果。", qas: [{ id: "a2", answer: "增加幂等键；测试环境完成验证，灰度运行两天未再重复调用。", status: "answered", gap: "", evidenceLineIds: refs(prompt) }] }],
      focus: focus("a", "a2", refs(prompt)),
      followups: [suggestion("auto-a3", "a", "a2", "灰度期间如何确认没有漏掉工具执行？", "核实完整性", refs(prompt))],
    }),
  ];
  const provider = createLiveInterviewAssistant({
    isConfigured: () => true,
    chatComplete: async ({ messages }) => {
      const prompt = JSON.parse(messages[1].content);
      const output = outputs[prompts.length];
      assert.ok(output, "the whole flow should need only five model calls");
      prompts.push(prompt);
      for (const line of [...prompt.earlierRoundLines, ...prompt.newRoundLines]) assert.match(line.id, /^L[\da-f]{16}$/);
      if (prompt.currentState.focus) {
        for (const id of prompt.currentState.focus.evidenceLineIds) assert.match(id, /^L[\da-f]{16}$/);
      }
      return JSON.stringify(output(prompt));
    },
  });
  const service = new AssistantJobService({ store, provider, logger: silentLogger, concurrency: 0 });
  try {
    const interview = store.createInterview(sampleInterview({ lines: lines.slice(0, 2), speakerLabels: { 1: "面试官", 2: "候选人" } }));
    async function run(mode) {
      const job = service.enqueue({ interviewId: interview.id, mode });
      assert.ok(job);
      await service.run(job);
      const completed = service.get(job.id);
      assert.equal(completed.status, "done", completed.payload.validationFeedback || completed.error);
      return store.getAssistantState(interview.id);
    }

    const first = await run("summary");
    assert.deepEqual(first.focus, focus("a", "a1", lines.slice(0, 2).map((line) => line.id)));
    assert.equal(first.topics[0].shortTitle, "断线恢复");
    assert.equal(first.topics[0].qas[0].shortQuestion, "如何恢复会话");
    assert.equal(first.topics[0].qas[0].question, texts[0]);
    assert.deepEqual(first.followups.map((item) => [item.id, item.source, item.purpose]), [["auto-a1", "automatic", "确认恢复"]]);

    store.appendLines(interview.id, lines.slice(2, 4));
    const second = await run("summary");
    assert.equal(second.focus.topicId, "b");
    assert.equal(second.focus.qaId, "b1");
    assert.deepEqual(second.followups.map((item) => item.id), ["auto-b1"]);
    assert.equal(second.followups[0].source, "automatic");

    store.appendLines(interview.id, lines.slice(4, 6));
    const third = await run("summary");
    assert.deepEqual(third.topics.map((item) => item.id), ["a", "c", "b"], "revisiting A must not reorder topics or create a duplicate");
    assert.deepEqual(third.focus, focus("a", "a2", lines.slice(4, 6).map((line) => line.id)));
    assert.equal(third.topics[0].qas.length, 2);
    assert.equal(third.topics[0].qas[1].shortQuestion, "如何避免重复执行工具");
    assert.deepEqual(third.topics[0].qas[0].evidenceLineIds, lines.slice(0, 2).map((line) => line.id));
    assert.deepEqual(third.followups.map((item) => item.id), ["auto-a2"]);

    const manual = await run("followup");
    assert.deepEqual(prompts[3].newRoundLines, [], "manual refresh works without new transcript");
    assert.deepEqual(manual.focus, third.focus);
    assert.equal(manual.processedLineCount, 6);
    assert.deepEqual(manual.followups.map((item) => item.id), ["manual-a2", "manual-c"]);
    assert.ok(manual.followups.every((item) => item.source === "manual"));
    assert.equal(manual.followups.filter((item) => item.topicId === manual.focus.topicId).length, 1);
    assert.equal(manual.topics.find((item) => item.id === "c").status, "unasked", "a suggested question is not an actual asked question");

    store.appendLines(interview.id, lines.slice(6));
    const final = await run("summary");
    assert.equal(final.processedLineCount, lines.length);
    assert.deepEqual(final.focus, focus("a", "a2", [lines[6].id]));
    assert.deepEqual(final.topics[0].qas[1].evidenceLineIds, lines.slice(4).map((line) => line.id));
    assert.equal(final.topics[0].qas[1].shortQuestion, "如何避免重复执行工具");
    assert.equal(final.followups.find((item) => item.topicId === "a").id, "auto-a3");
    assert.equal(final.followups.find((item) => item.topicId === "a").source, "automatic");
    assert.equal(final.followups.find((item) => item.topicId === "c").source, "manual");
    assert.equal(final.followups.length, 2);
    const sourceIds = new Set(store.getInterview(interview.id).lines.map((line) => line.id));
    for (const id of [
      ...final.focus.evidenceLineIds,
      ...final.topics.flatMap((item) => [...(item.evidenceLineIds || []), ...item.qas.flatMap((entry) => entry.evidenceLineIds)]),
      ...final.followups.flatMap((item) => item.evidenceLineIds),
    ]) assert.ok(sourceIds.has(id) && id.startsWith("fixture-session:"), "persisted citations must remain original transcript links");
    assert.deepEqual(prompts.map((prompt) => prompt.mode), ["summary", "summary", "summary", "followup", "summary"]);
  } finally {
    service.stop();
    store.close();
    cleanupTestConfig(config);
  }
});

function refs(prompt) { return prompt.newRoundLines.map((line) => line.id); }
function focus(topicId, qaId, evidenceLineIds) { return { topicId, qaId, evidenceLineIds }; }
function qa(id, question, shortQuestion, answer, evidenceLineIds) {
  return { id, question, shortQuestion, answer, status: "partial", gap: "尚待补充实际验证", evidenceLineIds };
}
function topic(id, title, shortTitle, entry) {
  return { id, title, shortTitle, origin: "outline", summary: entry.answer, status: "partial", qas: [entry] };
}
function suggestion(id, topicId, qaId, question, purpose, evidenceLineIds) {
  return { id, topicId, ...(qaId ? { qaId } : {}), question, purpose, evidenceLineIds };
}
