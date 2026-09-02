import { requestJson } from "../api.js";
import {
  APPLICATION_STATUS_PRESETS,
  DEFAULT_APPLICATION_STATUS,
  ROUND_STATUS_OPTIONS,
  inferRoundStatus,
  normalizeStatusColor,
  normalizeStatusLabel,
  resolveInterviewDurationMinutes,
  roundLabelFor,
} from "../interview-domain.js";

export const STORE_KEY = "interview-workbench.sessions.v1";
export const DEFAULT_INTERVIEW_STATUSES = APPLICATION_STATUS_PRESETS.map(({ value }) => value);
export const DEFAULT_ROUND_STATUSES = ROUND_STATUS_OPTIONS;

export function safeId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

export function createApplication(name = "未命名候选人") {
  const now = new Date().toISOString();
  return {
    id: safeId(),
    name,
    createdAt: now,
    updatedAt: now,
    applicationStatus: DEFAULT_APPLICATION_STATUS,
    resumeMarkdown: "",
    roleMarkdown: "",
    resumeFile: null,
    resumeNotes: [],
    selectedJdId: "",
    jdDraftName: "",
    roleShortName: "",
  };
}

export function createInterview(name = "未命名面试", options = {}) {
  const now = new Date().toISOString();
  const roundOrder = Math.max(1, Number(options.roundOrder) || 1);
  return {
    id: safeId(),
    applicationId: options.applicationId || safeId(),
    name,
    createdAt: now,
    updatedAt: now,
    sessionStartedAt: null,
    scheduledAt: "",
    durationMinutes: resolveInterviewDurationMinutes(options.durationMinutes),
    applicationStatus: DEFAULT_APPLICATION_STATUS,
    interviewStatus: DEFAULT_APPLICATION_STATUS,
    roundOrder,
    roundLabel: roundLabelFor({ roundOrder }),
    roundStatus: "待安排",
    outcome: "",
    roundFocus: "",
    resumeMarkdown: "",
    roleMarkdown: "",
    resumeFile: null,
    resumeNotes: [],
    selectedJdId: "",
    jdDraftName: "",
    roleShortName: "",
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
    sessionStartedAt: interview.sessionStartedAt,
    scheduledAt: interview.scheduledAt,
    durationMinutes: interview.durationMinutes,
    roundOrder: interview.roundOrder,
    roundLabel: interview.roundLabel,
    roundStatus: interview.roundStatus,
    outcome: interview.outcome,
    roundFocus: interview.roundFocus,
    speakerLabels: interview.speakerLabels,
    askedQuestions: interview.askedQuestions,
  };
}

export function applicationMetadataPatch(application) {
  return {
    name: application.name,
    applicationStatus: application.applicationStatus,
    resumeMarkdown: application.resumeMarkdown,
    roleMarkdown: application.roleMarkdown,
    resumeNotes: application.resumeNotes,
    selectedJdId: application.selectedJdId,
    jdDraftName: application.jdDraftName,
    roleShortName: application.roleShortName,
  };
}

export function normalizeStore(store) {
  const rawInterviews = Array.isArray(store?.interviews) ? store.interviews : [];
  const applicationMap = new Map(
    (Array.isArray(store?.applications) ? store.applications : []).map((application) => {
      const normalized = normalizeApplication(application);
      return [normalized.id, normalized];
    }),
  );

  for (const interview of rawInterviews) {
    const applicationId = interview?.applicationId || interview?.id || safeId();
    if (!applicationMap.has(applicationId)) {
      applicationMap.set(applicationId, normalizeApplication({ ...interview, id: applicationId }));
    }
  }

  let applications = Array.from(applicationMap.values());
  let interviews = rawInterviews.map((interview) => {
    const applicationId = interview?.applicationId || interview?.id;
    return normalizeInterview(
      { ...interview, applicationId },
      applicationMap.get(applicationId),
    );
  });

  const nextInterviews = interviews;
  const activeInterviewId =
    store?.activeInterviewId &&
    nextInterviews.some((interview) => interview.id === store.activeInterviewId)
      ? store.activeInterviewId
      : nextInterviews[0]?.id || "";
  return {
    activeInterviewId,
    activeApplicationId:
      nextInterviews.find((interview) => interview.id === activeInterviewId)?.applicationId ||
      applications[0]?.id ||
      "",
    applications,
    interviews: nextInterviews,
    jdLibrary: Array.isArray(store?.jdLibrary)
      ? store.jdLibrary.map(normalizeSavedJd)
      : [],
    statusOptions: mergeStatusOptions(store?.statusOptions, nextInterviews),
    statusColors: normalizeStatusColors(store?.statusColors),
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
      const local = localById.get(interview.id);
      if (!local?.lines?.length) return interview;
      return {
        ...interview,
        lines: mergePersistedAndLocalLines(interview.lines, local.lines),
      };
    }),
  };
}

function mergePersistedAndLocalLines(persistedLines, localLines) {
  const merged = Array.isArray(persistedLines) ? [...persistedLines] : [];
  const seen = new Set(merged.map(transcriptLineKey));
  for (const line of localLines) {
    const key = transcriptLineKey(line);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(line);
  }
  return merged;
}

function transcriptLineKey(line) {
  return line?.id || [
    line?.runId || "",
    line?.speaker || "",
    line?.startTime ?? "",
    line?.endTime ?? "",
    line?.text || "",
  ].join(":");
}

export function normalizeApplication(application) {
  const fallback = createApplication(application?.name || "未命名候选人");
  const merged = { ...fallback, ...application };
  const applicationStatus =
    normalizeStatusLabel(application?.applicationStatus || application?.interviewStatus) ||
    DEFAULT_APPLICATION_STATUS;
  return {
    ...merged,
    applicationStatus,
    roleShortName:
      typeof application?.roleShortName === "string" ? application.roleShortName.trim() : "",
    resumeFile:
      application?.resumeFile && typeof application.resumeFile === "object"
        ? application.resumeFile
        : null,
    resumeNotes: Array.isArray(application?.resumeNotes) ? application.resumeNotes : [],
  };
}

export function normalizeInterview(interview, application = null) {
  const fallback = createInterview(interview?.name || "未命名面试");
  const merged = { ...fallback, ...interview };
  const shared = application || normalizeApplication({
    ...interview,
    id: interview?.applicationId || interview?.id || fallback.applicationId,
  });
  const roundOrder = Math.max(1, Number(interview?.roundOrder) || 1);
  const applicationStatus =
    normalizeStatusLabel(shared.applicationStatus || interview?.applicationStatus || interview?.interviewStatus) ||
    DEFAULT_APPLICATION_STATUS;
  return {
    ...merged,
    applicationId: shared.id,
    name: shared.name,
    applicationStatus,
    interviewStatus: applicationStatus,
    resumeMarkdown: shared.resumeMarkdown || "",
    roleMarkdown: shared.roleMarkdown || "",
    resumeFile: shared.resumeFile,
    resumeNotes: shared.resumeNotes,
    selectedJdId: shared.selectedJdId || "",
    jdDraftName: shared.jdDraftName || "",
    roleShortName: shared.roleShortName || "",
    roundOrder,
    roundLabel: normalizeStatusLabel(interview?.roundLabel) || roundLabelFor({ roundOrder }),
    roundStatus: inferRoundStatus({ ...merged, roundStatus: interview?.roundStatus }),
    outcome: normalizeStatusLabel(interview?.outcome),
    roundFocus: typeof interview?.roundFocus === "string" ? interview.roundFocus : "",
    scheduledAt: normalizeDateValue(interview?.scheduledAt),
    durationMinutes: resolveInterviewDurationMinutes(interview?.durationMinutes),
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
      typeof value === "string"
        ? value
        : value?.applicationStatus || value?.interviewStatus,
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

export function normalizeStatusColors(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([status, color]) => [
        normalizeStatusLabel(status),
        normalizeStatusColor(color),
      ])
      .filter(([status, color]) => status && color),
  );
}

export function normalizeSavedJd(jd) {
  const now = new Date().toISOString();
  return {
    id: jd?.id || safeId(),
    name: jd?.name || "未命名 JD",
    shortName: typeof jd?.shortName === "string" ? jd.shortName.trim() : "",
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
