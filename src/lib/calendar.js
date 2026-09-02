import {
  getInterviewRoleLabel,
  inferRoundStatus,
  resolveInterviewDurationMinutes,
  roundLabelFor,
} from "../interview-domain.js";

export function scheduledInterviewDate(interview) {
  if (!interview?.scheduledAt) return null;
  const date = new Date(interview.scheduledAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function scheduledInterviews(interviews) {
  return (Array.isArray(interviews) ? interviews : [])
    .map((interview) => ({
      interview,
      date: scheduledInterviewDate(interview),
      endDate: scheduledInterviewEndDate(interview),
    }))
    .filter((entry) => entry.date)
    .sort((left, right) => left.date - right.date);
}

export function scheduledInterviewEndDate(interview) {
  const start = scheduledInterviewDate(interview);
  if (!start) return null;
  const durationMinutes = resolveInterviewDurationMinutes(interview?.durationMinutes);
  return new Date(start.getTime() + durationMinutes * 60 * 1000);
}

export function startOfLocalDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

export function startOfLocalWeek(value) {
  const date = startOfLocalDay(value);
  const daysFromMonday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - daysFromMonday);
  return date;
}

export function addLocalDays(value, amount) {
  const date = new Date(value);
  date.setDate(date.getDate() + amount);
  return date;
}

export function addLocalMonths(value, amount) {
  const date = new Date(value);
  date.setDate(1);
  date.setMonth(date.getMonth() + amount);
  return date;
}

export function sameLocalDay(left, right) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

export function localDayKey(value) {
  const date = new Date(value);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function monthCalendarDays(value) {
  const monthStart = new Date(value);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const rangeStart = startOfLocalWeek(monthStart);
  return Array.from({ length: 42 }, (_, index) => addLocalDays(rangeStart, index));
}

export function buildInterviewIcs(interview, now = new Date()) {
  const start = scheduledInterviewDate(interview);
  if (!start) throw new Error("这场面试还没有安排时间");

  const durationMinutes = resolveInterviewDurationMinutes(interview?.durationMinutes);
  const end = scheduledInterviewEndDate(interview);
  const candidate = String(interview.name || "未命名候选人").trim();
  const role = String(interview.jdDraftName || "未设置岗位").trim();
  const roleLabel = getInterviewRoleLabel(interview);
  const roundLabel = roundLabelFor(interview);
  const status = inferRoundStatus(interview);
  const uidPart = String(interview.id || `${start.getTime()}-${candidate}`)
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(0, 120);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Lingban//Interview Workbench//ZH-CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:interview-${uidPart}@lingban-workbench.local`,
    `DTSTAMP:${formatIcsUtc(now)}`,
    `DTSTART:${formatIcsUtc(start)}`,
    `DTEND:${formatIcsUtc(end)}`,
    `SUMMARY:${escapeIcsText(`${roleLabel}-${candidate}-${roundLabel}`)}`,
    `DESCRIPTION:${escapeIcsText(`岗位：${role}\n轮次：${roundLabel}\n轮次状态：${status}\n计划时长：${durationMinutes} 分钟\n来自灵伴面试工作台`)}`,
    "STATUS:CONFIRMED",
    "CATEGORIES:面试",
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

export function calendarExportFilename(interview) {
  const start = scheduledInterviewDate(interview);
  const day = start ? localDayKey(start).replaceAll("-", "") : "unscheduled";
  const time = start
    ? `${String(start.getHours()).padStart(2, "0")}${String(start.getMinutes()).padStart(2, "0")}`
    : "";
  const candidate = String(interview?.name || "interview")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .slice(0, 48);
  const roundLabel = String(interview?.roundLabel || "round")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .slice(0, 24);
  return `${candidate || "interview"}-${roundLabel || "round"}-${day}${time ? `-${time}` : ""}.ics`;
}

function formatIcsUtc(value) {
  return new Date(value)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function escapeIcsText(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function foldIcsLine(line) {
  const encoder = new TextEncoder();
  const folded = [];
  let current = "";
  let bytes = 0;

  for (const character of line) {
    const characterBytes = encoder.encode(character).length;
    if (current && bytes + characterBytes > 73) {
      folded.push(current);
      current = ` ${character}`;
      bytes = 1 + characterBytes;
    } else {
      current += character;
      bytes += characterBytes;
    }
  }
  folded.push(current);
  return folded.join("\r\n");
}
