import { requestJson } from "../api.js";
import { inferInterviewStatus, normalizeStatusLabel } from "../interview-domain.js";

export const STORE_KEY = "interview-workbench.sessions.v1";
export const DEFAULT_INTERVIEW_STATUSES = [
  "未面",
  "已安排",
  "面试中",
  "已面待定",
  "一面通过",
  "未通过",
  "放弃/归档",
];

export function safeId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

export function createInterview(name = "未命名面试") {
  const now = new Date().toISOString();
  return {
    id: safeId(),
    name,
    createdAt: now,
    updatedAt: now,
    sessionStartedAt: null,
    scheduledAt: "",
    interviewStatus: "未面",
    resumeMarkdown: "",
    roleMarkdown: "",
    resumeFile: null,
    resumeNotes: [],
    selectedJdId: "",
    jdDraftName: "",
    lines: [],
    cards: [],
    askedQuestions: [],
    lastProcessedLineCount: 0,
    speakerLabels: {},
  };
}

export function clearLegacyInterviewStore() {
  try {
    localStorage.removeItem(STORE_KEY);
    localStorage.setItem(
      `${STORE_KEY}.server`,
      JSON.stringify({ migratedAt: new Date().toISOString() }),
    );
  } catch {
    // Browser storage is only a migration cache now; the server file is primary.
  }
}

export async function loadRemoteInterviewStore() {
  const data = await requestJson("/api/store");
  return data.store ? normalizeStore(data.store) : null;
}

export function interviewMetadataPatch(interview) {
  return {
    name: interview.name,
    sessionStartedAt: interview.sessionStartedAt,
    scheduledAt: interview.scheduledAt,
    interviewStatus: interview.interviewStatus,
    resumeMarkdown: interview.resumeMarkdown,
    roleMarkdown: interview.roleMarkdown,
    resumeNotes: interview.resumeNotes,
    selectedJdId: interview.selectedJdId,
    jdDraftName: interview.jdDraftName,
    speakerLabels: interview.speakerLabels,
    askedQuestions: interview.askedQuestions,
  };
}

export function normalizeStore(store) {
  const interviews = Array.isArray(store?.interviews)
    ? store.interviews.map(normalizeInterview)
    : [];
  const fallback = createInterview("未命名面试");
  const nextInterviews = interviews.length ? interviews : [fallback];
  const activeInterviewId =
    store?.activeInterviewId &&
    nextInterviews.some((interview) => interview.id === store.activeInterviewId)
      ? store.activeInterviewId
      : nextInterviews[0].id;
  return {
    activeInterviewId,
    interviews: nextInterviews,
    jdLibrary: Array.isArray(store?.jdLibrary)
      ? store.jdLibrary.map(normalizeSavedJd)
      : [],
    statusOptions: mergeStatusOptions(store?.statusOptions, nextInterviews),
  };
}

export function preserveActiveInterview(remoteStore, preferredInterviewId) {
  const normalized = normalizeStore(remoteStore);
  return normalized.interviews.some((interview) => interview.id === preferredInterviewId)
    ? { ...normalized, activeInterviewId: preferredInterviewId }
    : normalized;
}

// getStore 只内联活跃场次的转录；远端未带 lines 的场次保留本地已加载的转录，
// 避免焦点刷新把界面上的转录清空。
export function withLocalTranscripts(nextStore, currentStore) {
  if (!nextStore) return nextStore;
  const localById = new Map(
    (currentStore?.interviews || []).map((interview) => [interview.id, interview]),
  );
  return {
    ...nextStore,
    interviews: nextStore.interviews.map((interview) => {
      if (interview.lines.length) return interview;
      const local = localById.get(interview.id);
      return local?.lines?.length ? { ...interview, lines: local.lines } : interview;
    }),
  };
}

export function normalizeInterview(interview) {
  const fallback = createInterview(interview?.name || "未命名面试");
  const merged = { ...fallback, ...interview };
  return {
    ...merged,
    scheduledAt: normalizeDateValue(interview?.scheduledAt),
    interviewStatus:
      normalizeStatusLabel(interview?.interviewStatus) || inferInterviewStatus(merged),
    lines: Array.isArray(interview?.lines) ? interview.lines : [],
    transcriptLineCount: Number.isFinite(Number(interview?.transcriptLineCount))
      ? Number(interview.transcriptLineCount)
      : Array.isArray(interview?.lines)
        ? interview.lines.length
        : 0,
    cards: Array.isArray(interview?.cards) ? interview.cards : [],
    askedQuestions: Array.isArray(interview?.askedQuestions)
      ? interview.askedQuestions
      : [],
    resumeFile:
      interview?.resumeFile && typeof interview.resumeFile === "object"
        ? interview.resumeFile
        : null,
    resumeNotes: Array.isArray(interview?.resumeNotes)
      ? interview.resumeNotes
      : [],
    speakerLabels:
      interview?.speakerLabels && typeof interview.speakerLabels === "object"
        ? interview.speakerLabels
        : {},
  };
}

export function mergeStatusOptions(...sources) {
  const statuses = [];
  const seen = new Set();
  const add = (value) => {
    const status = normalizeStatusLabel(
      typeof value === "string" ? value : value?.interviewStatus,
    );
    if (!status || seen.has(status)) return;
    seen.add(status);
    statuses.push(status);
  };

  DEFAULT_INTERVIEW_STATUSES.forEach(add);
  sources.forEach((source) => {
    if (Array.isArray(source)) source.forEach(add);
  });
  return statuses;
}

export function normalizeSavedJd(jd) {
  const now = new Date().toISOString();
  return {
    id: jd?.id || safeId(),
    name: jd?.name || "未命名 JD",
    content: jd?.content || "",
    createdAt: jd?.createdAt || now,
    updatedAt: jd?.updatedAt || jd?.createdAt || now,
  };
}

export function normalizeDateValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}
