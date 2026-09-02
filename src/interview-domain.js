export const DEFAULT_APPLICATION_STATUS = "招聘中";
export const APPLICATION_STATUS_PRESETS = [
  { value: "招聘中", color: "blue" },
  { value: "通过", color: "green" },
  { value: "未通过", color: "red" },
  { value: "放弃/归档", color: "red" },
];
export const ROUND_STATUS_OPTIONS = ["待安排", "已安排", "进行中", "已结束", "已取消"];
const RETIRED_APPLICATION_STATUSES = new Set([
  "未面",
  "面试中",
  "已面待定",
  ...ROUND_STATUS_OPTIONS,
]);
export const DEFAULT_INTERVIEW_DURATION_MINUTES = 60;
export const MIN_INTERVIEW_DURATION_MINUTES = 1;
export const MAX_INTERVIEW_DURATION_MINUTES = 24 * 60;

export function isValidInterviewDurationMinutes(value) {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_INTERVIEW_DURATION_MINUTES &&
    value <= MAX_INTERVIEW_DURATION_MINUTES
  );
}

export function resolveInterviewDurationMinutes(
  value,
  fallback = DEFAULT_INTERVIEW_DURATION_MINUTES,
) {
  if (isValidInterviewDurationMinutes(value)) return value;
  return isValidInterviewDurationMinutes(fallback)
    ? fallback
    : DEFAULT_INTERVIEW_DURATION_MINUTES;
}

export function normalizeStatusLabel(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, 24);
}

export function isRetiredApplicationStatus(value) {
  const status = normalizeStatusLabel(value);
  return RETIRED_APPLICATION_STATUSES.has(status) || /面(?:通过|未通过|待定)$/u.test(status);
}

export const STATUS_COLOR_OPTIONS = [
  { value: "gray", label: "灰色" },
  { value: "blue", label: "蓝色" },
  { value: "green", label: "绿色" },
  { value: "amber", label: "黄色" },
  { value: "red", label: "红色" },
  { value: "purple", label: "紫色" },
];

const STATUS_COLOR_TONES = {
  gray: "neutral",
  blue: "active",
  green: "success",
  amber: "scheduled",
  red: "negative",
  purple: "purple",
};

const DEFAULT_STATUS_COLORS = {
  ...Object.fromEntries(APPLICATION_STATUS_PRESETS.map(({ value, color }) => [value, color])),
  未面: "gray",
  待安排: "gray",
  已安排: "amber",
  面试中: "blue",
  进行中: "blue",
  已结束: "gray",
  已取消: "red",
  已面待定: "gray",
  一面通过: "green",
};

export function normalizeStatusColor(value) {
  return STATUS_COLOR_TONES[value] ? value : "";
}

export function statusColorFor(status, statusColors = {}) {
  return normalizeStatusColor(statusColors?.[status]) || DEFAULT_STATUS_COLORS[status] || "gray";
}

export function inferRoundStatus(interview) {
  if (interview?.roundStatus) return normalizeStatusLabel(interview.roundStatus);
  if (interview?.lines?.length || interview?.transcriptLineCount || interview?.sessionStartedAt) {
    return "已结束";
  }
  return interview?.scheduledAt ? "已安排" : "待安排";
}

export function roundLabelFor(interview) {
  const explicit = normalizeStatusLabel(interview?.roundLabel);
  if (explicit) return explicit;
  const order = Math.max(1, Number(interview?.roundOrder) || 1);
  const commonLabels = ["一面", "二面", "三面", "四面", "五面"];
  return commonLabels[order - 1] || `第 ${order} 轮`;
}

export function roundDisplayName(interview) {
  return `${interview?.name || "未命名候选人"} · ${roundLabelFor(interview)}`;
}

export function compareRounds(left, right) {
  const orderDifference = (Number(left?.roundOrder) || 0) - (Number(right?.roundOrder) || 0);
  if (orderDifference) return orderDifference;
  return new Date(left?.createdAt || 0).getTime() - new Date(right?.createdAt || 0).getTime();
}

export function roundsForApplication(interviews, applicationId) {
  return (Array.isArray(interviews) ? interviews : [])
    .filter((interview) => interview.applicationId === applicationId)
    .sort(compareRounds);
}

export function preferredRoundForApplication(interviews, applicationId, now = new Date()) {
  const rounds = roundsForApplication(interviews, applicationId);
  if (!rounds.length) return null;
  const nowTime = new Date(now).getTime();
  return (
    rounds.find((round) => {
      const scheduledTime = new Date(round.scheduledAt || "").getTime();
      return Number.isFinite(scheduledTime) && scheduledTime >= nowTime && inferRoundStatus(round) !== "已取消";
    }) || rounds.at(-1)
  );
}

export function getApplicationRole(application) {
  return application?.jdDraftName?.trim() || "未设置岗位";
}

export function compareApplications(left, right, sortBy, interviews = []) {
  if (sortBy === "name") return (left.name || "").localeCompare(right.name || "", "zh-CN");
  const applicationRounds = (application) => roundsForApplication(interviews, application.id);
  const dateValue = (application) => {
    if (sortBy === "scheduled") {
      return preferredRoundForApplication(interviews, application.id)?.scheduledAt || "9999-12-31";
    }
    if (sortBy === "created") return application.createdAt || 0;
    const rounds = applicationRounds(application);
    return application.updatedAt || rounds.at(-1)?.updatedAt || application.createdAt || 0;
  };
  const leftDate = new Date(dateValue(left)).getTime();
  const rightDate = new Date(dateValue(right)).getTime();
  return sortBy === "scheduled" ? leftDate - rightDate : rightDate - leftDate;
}

export function formatShortDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function getInterviewRole(interview) {
  return interview?.jdDraftName?.trim() || "未设置岗位";
}

export function getInterviewRoleLabel(interview) {
  const shortName =
    typeof interview?.roleShortName === "string" ? interview.roleShortName.trim() : "";
  return shortName || getInterviewRole(interview);
}

export function interviewStatusTone(status, statusColors = {}) {
  return STATUS_COLOR_TONES[statusColorFor(status, statusColors)] || "neutral";
}

export function roundStatusTone(status) {
  return interviewStatusTone(status);
}

export function compareInterviews(left, right, sortBy) {
  if (sortBy === "name") return (left.name || "").localeCompare(right.name || "", "zh-CN");
  const dateValue = (interview) => {
    if (sortBy === "scheduled") return interview.scheduledAt || "9999-12-31";
    if (sortBy === "created") return interview.createdAt || 0;
    return interview.updatedAt || interview.createdAt || 0;
  };
  const leftDate = new Date(dateValue(left)).getTime();
  const rightDate = new Date(dateValue(right)).getTime();
  return sortBy === "scheduled" ? leftDate - rightDate : rightDate - leftDate;
}
