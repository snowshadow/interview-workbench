export function normalizeStatusLabel(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, 24);
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

export function interviewStatusTone(status) {
  if (status === "一面通过") return "success";
  if (["未通过", "放弃/归档"].includes(status)) return "negative";
  if (status === "面试中") return "active";
  if (status === "已安排") return "scheduled";
  return "neutral";
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
