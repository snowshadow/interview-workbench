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
  招聘中: "blue",
  通过: "green",
  未面: "gray",
  待安排: "gray",
  已安排: "amber",
  面试中: "blue",
  进行中: "blue",
  已结束: "gray",
  已取消: "red",
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

export function getInterviewRoleShortLabel(interview) {
  const role = getInterviewRole(interview);
  if (role === "未设置岗位") return "岗位待定";

  const knownRole = [
    [/智能硬件|硬件产品/, "硬件产品"],
    [/实时语音|语音.*多模态|多模态.*语音/, "实时语音"],
    [/大模型评测|评测研发|LLM.*评测/i, "大模型评测"],
    [/大模型应用|角色对话|Agent.*应用|应用研发/i, "Agent 应用"],
    [/Agent.*(?:技术负责人|架构)|Agent 架构/i, "Agent 架构"],
  ].find(([pattern]) => pattern.test(role));
  if (knownRole) return knownRole[1];

  const baseRole = role
    .replace(/\s*[（(].*$/, "")
    .replace(/(?:高级|资深)?(?:研发)?(?:工程师|负责人|产品经理)$/, "")
    .trim();
  return Array.from(baseRole || role).slice(0, 6).join("");
}

export function getInterviewSystemCalendarRoleLabel(interview) {
  const displayLabel = getInterviewRoleShortLabel(interview);
  const systemCalendarLabels = {
    "大模型评测": "评测",
    "Agent 架构": "架构",
    "Agent 应用": "应用",
    "实时语音": "语音",
    "硬件产品": "硬件",
    "岗位待定": "岗位",
  };
  return (
    systemCalendarLabels[displayLabel] ||
    Array.from(displayLabel.replace(/\s+/g, "")).slice(0, 4).join("")
  );
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
