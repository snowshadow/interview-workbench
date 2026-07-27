export function normalizeStatusLabel(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, 24);
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
  未面: "gray",
  已安排: "amber",
  面试中: "blue",
  已面待定: "gray",
  一面通过: "green",
  未通过: "red",
  "放弃/归档": "red",
};

export function normalizeStatusColor(value) {
  return STATUS_COLOR_TONES[value] ? value : "";
}

export function statusColorFor(status, statusColors = {}) {
  return normalizeStatusColor(statusColors?.[status]) || DEFAULT_STATUS_COLORS[status] || "gray";
}

export function inferInterviewStatus(interview) {
  return interview?.lines?.length ||
    interview?.transcriptLineCount ||
    interview?.cards?.length ||
    interview?.sessionStartedAt
    ? "已面待定"
    : "未面";
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

export function interviewStatusTone(status, statusColors = {}) {
  return STATUS_COLOR_TONES[statusColorFor(status, statusColors)] || "neutral";
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
