import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  buildInterviewIcs,
  monthCalendarDays,
  scheduledInterviews,
  startOfLocalWeek,
} from "../src/lib/calendar.js";
import {
  isLoopbackRequest,
  openInterviewInSystemCalendar,
} from "../server/services/calendar-export.js";
import {
  cleanupTestConfig,
  createTestConfig,
  sampleInterview,
} from "./helpers.js";

test("buildInterviewIcs exports the scheduled instant as a one-hour UTC event", () => {
  const content = buildInterviewIcs(
    sampleInterview({
      id: "candidate/1",
      name: "林,嘉",
      jdDraftName: "Agent;工程师",
      scheduledAt: "2026-07-12T02:00:00.000Z",
    }),
    new Date("2026-07-10T08:30:00.000Z"),
  );

  assert.match(content, /UID:interview-candidate-1@lingban-workbench\.local/);
  assert.match(content, /DTSTAMP:20260710T083000Z/);
  assert.match(content, /DTSTART:20260712T020000Z/);
  assert.match(content, /DTEND:20260712T030000Z/);
  assert.match(content, /SUMMARY:面试 · 林\\,嘉/);
  assert.match(content, /岗位：Agent\\;工程师\\n状态：已安排/);
  assert.ok(content.endsWith("\r\n"));
});

test("calendar date helpers use Monday-based local ranges", () => {
  const sunday = new Date(2026, 6, 12, 10);
  const monday = startOfLocalWeek(sunday);
  assert.equal(monday.getDay(), 1);
  assert.equal(monday.getDate(), 6);

  const days = monthCalendarDays(new Date(2026, 6, 31));
  assert.equal(days.length, 42);
  assert.equal(days[0].getDay(), 1);
  assert.equal(days[41].getDay(), 0);
});

test("scheduledInterviews ignores missing and invalid times", () => {
  const entries = scheduledInterviews([
    sampleInterview({ id: "late", scheduledAt: "2026-07-12T03:00:00.000Z" }),
    sampleInterview({ id: "missing", scheduledAt: "" }),
    sampleInterview({ id: "invalid", scheduledAt: "not-a-date" }),
    sampleInterview({ id: "early", scheduledAt: "2026-07-12T01:00:00.000Z" }),
  ]);
  assert.deepEqual(entries.map(({ interview }) => interview.id), ["early", "late"]);
});

test("openInterviewInSystemCalendar writes a private file and launches it", async () => {
  const config = createTestConfig("calendar-export-");
  const launched = [];
  try {
    const result = await openInterviewInSystemCalendar({
      interview: sampleInterview(),
      exportDir: path.join(config.dataDir, "calendar-exports"),
      launch: async (filePath) => launched.push(filePath),
      platform: "darwin",
    });
    assert.deepEqual(launched, [result.filePath]);
    assert.match(fs.readFileSync(result.filePath, "utf8"), /BEGIN:VCALENDAR/);
    assert.equal(fs.statSync(result.filePath).mode & 0o777, 0o600);
  } finally {
    cleanupTestConfig(config);
  }
});

test("system calendar launch is limited to loopback requests", () => {
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: "::1" } }), true);
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: "::ffff:127.0.0.1" } }), true);
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: "192.168.1.20" } }), false);
});
