import assert from "node:assert/strict";
import test from "node:test";
import {
  APPLICATION_STATUS_PRESETS,
  DEFAULT_APPLICATION_STATUS,
  DEFAULT_INTERVIEW_DURATION_MINUTES,
  MAX_INTERVIEW_DURATION_MINUTES,
  MIN_INTERVIEW_DURATION_MINUTES,
  compareInterviews,
  getInterviewRole,
  getInterviewRoleLabel,
  interviewStatusTone,
  normalizeStatusLabel,
  isValidInterviewDurationMinutes,
  resolveInterviewDurationMinutes,
  roundStatusTone,
} from "../src/interview-domain.js";

test("interview domain defaults stay independent from UI components", () => {
  assert.equal(getInterviewRole({}), "未设置岗位");
  assert.equal(interviewStatusTone("自定义状态"), "neutral");
});

test("application and duration defaults have one domain-level source", () => {
  assert.equal(DEFAULT_APPLICATION_STATUS, "招聘中");
  assert.deepEqual(
    APPLICATION_STATUS_PRESETS.map(({ value }) => value),
    ["招聘中", "通过", "未通过", "放弃/归档"],
  );
  assert.equal(DEFAULT_INTERVIEW_DURATION_MINUTES, 60);
  assert.equal(isValidInterviewDurationMinutes(MIN_INTERVIEW_DURATION_MINUTES), true);
  assert.equal(isValidInterviewDurationMinutes(MAX_INTERVIEW_DURATION_MINUTES), true);
  assert.equal(isValidInterviewDurationMinutes(0), false);
  assert.equal(isValidInterviewDurationMinutes(60.5), false);
  assert.equal(isValidInterviewDurationMinutes(true), false);
  assert.equal(resolveInterviewDurationMinutes(90), 90);
  assert.equal(resolveInterviewDurationMinutes(undefined), 60);
  assert.equal(resolveInterviewDurationMinutes("invalid", 45), 45);
  assert.equal(roundStatusTone("已安排"), "scheduled");
  assert.equal(interviewStatusTone("已安排", { 已安排: "purple" }), "purple");
});

test("status labels preserve existing workflow names instead of classifying them by wording", () => {
  for (const status of [
    "未面",
    "面试中",
    "已面待定",
    "待安排",
    "已安排",
    "进行中",
    "已结束",
    "已取消",
    "一面通过",
    "二面未通过",
    "终面待定",
  ]) {
    assert.equal(normalizeStatusLabel(` ${status} `), status);
  }
  assert.equal(normalizeStatusLabel(" offer   审批中 "), "offer 审批中");
  assert.equal(normalizeStatusLabel("   "), "");
  assert.equal(normalizeStatusLabel(["已安排"]), "");
});

test("calendar role labels come from interview data without inferring job semantics", () => {
  assert.equal(
    getInterviewRoleLabel({
      jdDraftName: "量化策略研究负责人",
      roleShortName: " 量化 ",
    }),
    "量化",
  );
  assert.equal(
    getInterviewRoleLabel({ jdDraftName: "量化策略研究负责人" }),
    "量化策略研究负责人",
  );
  assert.equal(getInterviewRoleLabel({}), "未设置岗位");
});

test("session sorting uses stable role-specific date rules", () => {
  const earlier = { name: "乙", scheduledAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" };
  const later = { name: "甲", scheduledAt: "2026-01-02T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z" };
  assert.ok(compareInterviews(earlier, later, "scheduled") < 0);
  assert.ok(compareInterviews(earlier, later, "updated") > 0);
});
