import assert from "node:assert/strict";
import test from "node:test";
import {
  compareInterviews,
  getInterviewRole,
  inferInterviewStatus,
  interviewStatusTone,
} from "../src/interview-domain.js";

test("interview domain defaults stay independent from UI components", () => {
  assert.equal(inferInterviewStatus({ lines: [] }), "未面");
  assert.equal(inferInterviewStatus({ lines: [{ text: "hello" }] }), "已面待定");
  assert.equal(getInterviewRole({}), "未设置岗位");
  assert.equal(interviewStatusTone("自定义状态"), "neutral");
});

test("session sorting uses stable role-specific date rules", () => {
  const earlier = { name: "乙", scheduledAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z" };
  const later = { name: "甲", scheduledAt: "2026-01-02T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z" };
  assert.ok(compareInterviews(earlier, later, "scheduled") < 0);
  assert.ok(compareInterviews(earlier, later, "updated") > 0);
});
