import assert from "node:assert/strict";
import test from "node:test";
import {
  compareInterviews,
  getInterviewRole,
  getInterviewRoleShortLabel,
  getInterviewSystemCalendarRoleLabel,
  inferInterviewStatus,
  interviewStatusTone,
} from "../src/interview-domain.js";

test("interview domain defaults stay independent from UI components", () => {
  assert.equal(inferInterviewStatus({ lines: [] }), "未面");
  assert.equal(inferInterviewStatus({ lines: [{ text: "hello" }] }), "已面待定");
  assert.equal(getInterviewRole({}), "未设置岗位");
  assert.equal(interviewStatusTone("自定义状态"), "neutral");
});

test("calendar role labels stay short and stable for known Lingban roles", () => {
  assert.equal(
    getInterviewRoleShortLabel({
      jdDraftName: "大模型 Agent 技术负责人（AI 陪伴 / Agent 架构方向）",
    }),
    "Agent 架构",
  );
  assert.equal(
    getInterviewRoleShortLabel({ jdDraftName: "大模型评测研发负责人（LLM / Agent / 多模态方向）" }),
    "大模型评测",
  );
  assert.equal(
    getInterviewRoleShortLabel({ jdDraftName: "大模型应用研发工程师（AI Agent / 角色对话方向）" }),
    "Agent 应用",
  );
  assert.equal(
    getInterviewRoleShortLabel({ jdDraftName: "实时语音 / 多模态 Agent 工程师" }),
    "实时语音",
  );
  assert.equal(getInterviewRoleShortLabel({ jdDraftName: "AI 智能硬件产品负责人" }), "硬件产品");
  assert.equal(getInterviewRoleShortLabel({ jdDraftName: "搜索推荐算法工程师（北京）" }), "搜索推荐算法");
  assert.equal(getInterviewRoleShortLabel({}), "岗位待定");
});

test("system calendar role labels use the shortest recognizable names", () => {
  assert.equal(
    getInterviewSystemCalendarRoleLabel({ jdDraftName: "大模型评测研发负责人" }),
    "评测",
  );
  assert.equal(
    getInterviewSystemCalendarRoleLabel({ jdDraftName: "大模型 Agent 技术负责人" }),
    "架构",
  );
  assert.equal(
    getInterviewSystemCalendarRoleLabel({ jdDraftName: "大模型应用研发工程师" }),
    "应用",
  );
  assert.equal(
    getInterviewSystemCalendarRoleLabel({ jdDraftName: "实时语音 / 多模态 Agent 工程师" }),
    "语音",
  );
  assert.equal(
    getInterviewSystemCalendarRoleLabel({ jdDraftName: "AI 智能硬件产品负责人" }),
    "硬件",
  );
  assert.equal(getInterviewSystemCalendarRoleLabel({ jdDraftName: "搜索推荐算法工程师" }), "搜索推荐");
});

test("session sorting uses stable role-specific date rules", () => {
  const earlier = { name: "乙", scheduledAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" };
  const later = { name: "甲", scheduledAt: "2026-01-02T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z" };
  assert.ok(compareInterviews(earlier, later, "scheduled") < 0);
  assert.ok(compareInterviews(earlier, later, "updated") > 0);
});
