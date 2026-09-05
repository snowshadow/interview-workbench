import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Archive,
  BriefcaseBusiness,
  CalendarClock,
  CalendarDays,
  Download,
  Ellipsis,
  ListFilter,
  Maximize2,
  Minimize2,
  MonitorSpeaker,
  Mic,
  PanelsTopLeft,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Settings,
  Square,
  X,
  Trash2,
  Upload,
  WandSparkles,
} from "lucide-react";
import "./styles.css";
import "./workbench.css";
import { InterviewCalendarDialog } from "./components/InterviewCalendarDialog.jsx";
import { SessionLibraryDialog } from "./components/SessionLibraryDialog.jsx";
import { ApplicationStatusPicker } from "./components/ApplicationStatusPicker.jsx";
import { PanelTitle } from "./components/WorkbenchPrimitives.jsx";
import { TranscriptPanel } from "./components/TranscriptPanel.jsx";
import { AnalysisCardList, isPendingAnalyzeCard } from "./components/AnalysisCardList.jsx";
import { InterviewFormDialog } from "./components/dialogs/InterviewFormDialog.jsx";
import {
  ProviderSettingsDialog,
  createProviderSettingsDraft,
} from "./components/dialogs/ProviderSettingsDialog.jsx";
import { ResumePane } from "./components/resume/ResumePane.jsx";
import { enqueueApplicationSave, preservePendingAnnotations, upsertNote } from "./lib/resume-annotations.js";
import { SplitPane } from "./components/SplitPane.jsx";
import { readUiPreferences, saveUiPreferences } from "./lib/ui-preferences.js";
import {
  DEFAULT_APPLICATION_STATUS,
  DEFAULT_INTERVIEW_DURATION_MINUTES,
  MAX_INTERVIEW_DURATION_MINUTES,
  MIN_INTERVIEW_DURATION_MINUTES,
  ROUND_STATUS_OPTIONS,
  formatShortDateTime,
  inferRoundStatus,
  interviewStatusTone,
  isValidInterviewDurationMinutes,
  normalizeStatusLabel,
  roundLabelFor,
  roundStatusTone,
  roundsForApplication,
} from "./interview-domain.js";
import {
  ApiError,
  apiFetch,
  createAsrWebSocket,
  requestJson,
  setAccessToken,
} from "./api.js";
import {
  AUDIO_SOURCE_MEETING,
  AUDIO_SOURCE_MICROPHONE,
  audioCaptureErrorMessage,
  buildDisplayMediaOptions,
  createCaptureError,
  hasAudioTrack,
} from "./audio-capture.js";
import {
  DEFAULT_INTERVIEW_STATUSES,
  STORE_KEY,
  applicationMetadataChanges,
  clearLegacyInterviewStore,
  interviewMetadataPatch,
  loadRemoteInterviewStore,
  mergeStatusOptions,
  normalizeStore,
  preserveActiveInterview,
  safeId,
  withLocalTranscripts,
} from "./lib/store-normalize.js";
import {
  createPartialTextBridge,
  extractQuestionLikeLines,
  formatLineForPrompt,
  mergeQuestions,
  mergeTranscriptLines,
} from "./lib/transcript.js";
import { CHUNK_MS, CHUNK_SAMPLES, floatTo16BitPcm, resampleTo16k } from "./lib/audio-pipeline.js";
import {
  isWordFile,
  serializeResumeFile,
} from "./lib/resume-files.js";
import { clampNumber } from "./lib/format.js";
import {
  buildInterviewIcs,
  calendarExportFilename,
} from "./lib/calendar.js";

if (!Promise.withResolvers) {
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    return { promise, resolve, reject };
  };
}

const EMPTY_APPLICATION = {
  id: "",
  name: "",
  applicationStatus: "",
  resumeMarkdown: "",
  roleMarkdown: "",
  resumeFile: null,
  resumeNotes: [],
  selectedJdId: "",
  jdDraftName: "",
  roleShortName: "",
};
const EMPTY_INTERVIEW = {
  id: "",
  applicationId: "",
  name: "",
  scheduledAt: "",
  durationMinutes: DEFAULT_INTERVIEW_DURATION_MINUTES,
  sessionStartedAt: null,
  roundOrder: 1,
  roundLabel: "",
  roundStatus: "待安排",
  outcome: "",
  roundFocus: "",
  resumeMarkdown: "",
  roleMarkdown: "",
  resumeFile: null,
  resumeNotes: [],
  jdDraftName: "",
  roleShortName: "",
  lines: [],
  cards: [],
  askedQuestions: [],
  lastProcessedLineCount: 0,
  speakerLabels: {},
};

function App() {
  const [store, setStore] = useState(loadInterviewStore);
  const [storeReady, setStoreReady] = useState(false);
  const [persistError, setPersistError] = useState("");
  const [health, setHealth] = useState(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [accessTokenDraft, setAccessTokenDraft] = useState("");
  const [status, setStatus] = useState("idle");
  const [isPaused, setIsPaused] = useState(false);
  const [hasPartialText, setHasPartialText] = useState(false);
  const [error, setError] = useState("");
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [sessionLibraryOpen, setSessionLibraryOpen] = useState(false);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [interviewForm, setInterviewForm] = useState(null);
  const [interviewFormSubmitting, setInterviewFormSubmitting] = useState(false);
  const interviewFormSubmitLockRef = useRef(false);
  const [providerSettingsOpen, setProviderSettingsOpen] = useState(false);
  const [providerSettingsDraft, setProviderSettingsDraft] = useState(null);
  const [providerSettingsSaving, setProviderSettingsSaving] = useState(false);
  const [providerSettingsError, setProviderSettingsError] = useState("");
  const [speakerEditorOpen, setSpeakerEditorOpen] = useState(false);
  const [statusPickerOpen, setStatusPickerOpen] = useState(false);
  const [customStatusDraft, setCustomStatusDraft] = useState("");
  const [resumePreviewError, setResumePreviewError] = useState("");
  const [resumeReplacing, setResumeReplacing] = useState(false);
  const [annotationSaveStates, setAnnotationSaveStates] = useState({});
  const [focusedPanel, setFocusedPanel] = useState("");
  const [audioSourceMode, setAudioSourceMode] = useState(loadAudioSourceMode);

  const wsRef = useRef(null);
  const streamRef = useRef(null);
  const displayStreamRef = useRef(null);
  const audioContextRef = useRef(null);
  const workletRef = useRef(null);
  const mutedGainRef = useRef(null);
  const pendingInputRef = useRef(new Float32Array(0));
  const statusRef = useRef(status);
  const pausedRef = useRef(isPaused);
  const partialTextBridgeRef = useRef(null);
  if (!partialTextBridgeRef.current) partialTextBridgeRef.current = createPartialTextBridge();
  const partialTextBridge = partialTextBridgeRef.current;
  const runIdRef = useRef("");
  const captureAttemptRef = useRef("");
  const metadataPersistTimersRef = useRef(new Map());
  const applicationPersistTimersRef = useRef(new Map());
  const applicationPendingPatchesRef = useRef(new Map());
  const applicationSaveQueuesRef = useRef(new Map());
  const unsavedAnnotationsRef = useRef(new Set());
  const retryAnalysisCardRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);

  const activeInterview = useMemo(() => {
    return (
      store.interviews.find((interview) => interview.id === store.activeInterviewId) ||
      store.interviews[0] ||
      EMPTY_INTERVIEW
    );
  }, [store]);
  const activeApplication = useMemo(
    () =>
      store.applications.find(
        (application) => application.id === activeInterview.applicationId,
      ) || (activeInterview.id ? activeInterview : EMPTY_APPLICATION),
    [activeInterview, store.applications],
  );
  const hasActiveInterview = Boolean(activeInterview.id);
  const activeRounds = useMemo(
    () => roundsForApplication(store.interviews, activeInterview.applicationId),
    [activeInterview.applicationId, store.interviews],
  );
  const statusOptions = useMemo(
    () => mergeStatusOptions(store.statusOptions, store.applications),
    [store.applications, store.statusOptions],
  );

  const {
    id: activeInterviewId,
    name: interviewName,
    resumeMarkdown,
    roleMarkdown,
    resumeFile,
    resumeNotes: savedResumeNotes,
    jdDraftName,
    scheduledAt,
    sessionStartedAt,
    roundStatus,
    outcome,
    roundFocus,
    durationMinutes,
    lines,
    cards,
    askedQuestions,
    lastProcessedLineCount,
    speakerLabels,
  } = activeInterview;
  const interviewStatus =
    activeApplication.applicationStatus ||
    activeInterview.interviewStatus ||
    DEFAULT_APPLICATION_STATUS;
  const resumeNotes = Array.isArray(savedResumeNotes) ? savedResumeNotes : [];

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    pausedRef.current = isPaused;
  }, [isPaused]);

  useEffect(() => {
    setHasPartialText(Boolean(partialTextBridge.get()));
    return partialTextBridge.subscribe((text) => setHasPartialText(Boolean(text)));
  }, [partialTextBridge]);

  useEffect(() => {
    retryAnalysisCardRef.current = retryAnalysisCard;
  });
  const handleRetryCard = useCallback((card) => retryAnalysisCardRef.current(card), []);

  useEffect(() => {
    setSpeakerEditorOpen(false);
    setStatusPickerOpen(false);
    setCustomStatusDraft("");
    setFocusedPanel("");
    setResumePreviewError("");
  }, [activeInterviewId]);

  useEffect(() => {
    if (!resumeFile || !isWordFile(resumeFile) || resumeFile.previewText || !resumeFile.id) {
      setResumePreviewError("");
      return undefined;
    }

    let cancelled = false;
    setResumePreviewError("");
    requestJson(`/api/attachments/${encodeURIComponent(resumeFile.id)}/preview-text`)
      .then(({ previewText }) => {
        if (cancelled) return;
        setStore((current) => ({
          ...current,
          interviews: current.interviews.map((interview) =>
            interview.resumeFile?.id === resumeFile.id
              ? {
                  ...interview,
                  resumeFile: { ...interview.resumeFile, previewText },
                }
              : interview,
          ),
        }));
      })
      .catch((previewError) => {
        if (!cancelled) {
          setResumePreviewError(previewError.message || "Word 简历预览生成失败");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [resumeFile?.id, resumeFile?.previewText]);

  useEffect(() => {
    function handleEscape(event) {
      if (event.key !== "Escape") return;
      setFocusedPanel("");
    }

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadRemoteInterviewStore()
      .then((remoteStore) => {
        if (cancelled) return;
        if (remoteStore) setStore(remoteStore);
        clearLegacyInterviewStore();
      })
      .catch((loadError) => {
        if (cancelled) return;
        if (loadError instanceof ApiError && loadError.status === 401) setAuthRequired(true);
        else setPersistError("历史场次读取失败，请检查本地服务");
      })
      .finally(() => {
        if (!cancelled) setStoreReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!storeReady) return undefined;

    function refreshStoreOnFocus() {
      if (!["idle", "stopped", "error"].includes(statusRef.current)) return;
      // 本地还有未落库的场次修改（如刚删除的备注）时跳过，
      // 否则远端旧快照会把这次修改覆盖回来。
      if (
        metadataPersistTimersRef.current.size > 0 ||
        applicationPersistTimersRef.current.size > 0 || applicationSaveQueuesRef.current.size > 0 ||
        unsavedAnnotationsRef.current.size > 0
      ) return;
      loadRemoteInterviewStore()
        .then((remoteStore) => {
          if (remoteStore) {
            setStore((current) =>
              mergeRemoteStore(
                preserveActiveInterview(remoteStore, current.activeInterviewId),
                current,
              ),
            );
          }
        })
        .catch(() => {});
    }

    window.addEventListener("focus", refreshStoreOnFocus);
    return () => window.removeEventListener("focus", refreshStoreOnFocus);
  }, [storeReady]);

  useEffect(() => {
    function protectPendingNotes(event) {
      if (!unsavedAnnotationsRef.current.size) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", protectPendingNotes);
    return () => window.removeEventListener("beforeunload", protectPendingNotes);
  }, []);

  useEffect(() => {
    refreshHealth();
  }, []);

  const transcriptText = useMemo(() => {
    return lines
      .map((line) => formatLineForPrompt(line, speakerLabels))
      .join("\n")
      .trim();
  }, [lines, speakerLabels]);

  const getCurrentSegmentText = useCallback(() => {
    const freshLines = lines.slice(lastProcessedLineCount);
    const body = freshLines
      .map((line) => formatLineForPrompt(line, speakerLabels))
      .join("\n")
      .trim();
    if (body) return body;
    const partialText = partialTextBridge.get();
    return partialText ? `正在识别：${partialText}` : "";
  }, [lastProcessedLineCount, lines, partialTextBridge, speakerLabels]);
  const currentSegmentText = useMemo(
    () => getCurrentSegmentText(),
    [getCurrentSegmentText, hasPartialText],
  );
  const currentSegmentPending = useMemo(
    () =>
      cards.some(
        (card) =>
          isPendingAnalyzeCard(card) &&
          Number(card.segmentStart ?? card.snapshotLineCount ?? -1) === lastProcessedLineCount &&
          Number(card.segmentEnd ?? card.snapshotLineCount ?? -1) === lines.length,
      ),
    [cards, lastProcessedLineCount, lines.length],
  );

  const canManageWorkbench =
    storeReady && (status === "idle" || status === "stopped" || status === "error");
  const canSwitchInterview = canManageWorkbench && hasActiveInterview;
  const pendingJobIds = useMemo(() => {
    return store.interviews.flatMap((interview) =>
      interview.cards
        .filter((card) => card.jobId && isPendingAnalyzeCard(card))
        .map((card) => card.jobId),
    );
  }, [store.interviews]);

  useEffect(() => {
    if (!pendingJobIds.length) return undefined;

    let stopped = false;
    async function pollJobs() {
      const uniqueJobIds = Array.from(new Set(pendingJobIds));
      const results = await Promise.all(
        uniqueJobIds.map(async (jobId) => {
          try {
            const response = await apiFetch(`/api/analyze-jobs/${jobId}`);
            const data = await response.json();
            if (!response.ok) {
              return {
                id: jobId,
                status: "error",
                error: data.error || "读取分析任务失败",
                attempts: 0,
                maxAttempts: 3,
              };
            }
            return data;
          } catch {
            return null;
          }
        }),
      );

      if (stopped) return;

      for (const job of results.filter(Boolean)) applyAnalyzeJobUpdate(job);
    }

    pollJobs();
    const timer = setInterval(pollJobs, 1400);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pendingJobIds.join("|")]);

  function updateActiveInterview(updater) {
    setStore((prev) => {
      const updatedAt = new Date().toISOString();
      let changedInterview = null;
      let interviews = prev.interviews.map((interview) => {
        if (interview.id !== prev.activeInterviewId) return interview;
        const patch = typeof updater === "function" ? updater(interview) : updater;
        changedInterview = { ...interview, ...patch, updatedAt };
        return changedInterview;
      });
      let applications = prev.applications;
      let changedApplication = null;
      let applicationPatch = null;
      if (changedInterview) {
        const currentApplication = prev.applications.find(
          (application) => application.id === changedInterview.applicationId,
        );
        if (currentApplication) {
          const sharedPatch = applicationMetadataChanges(currentApplication, changedInterview);
          if (Object.keys(sharedPatch).length) {
            applicationPatch = sharedPatch;
            changedApplication = { ...currentApplication, ...sharedPatch, updatedAt };
            applications = prev.applications.map((application) =>
              application.id === changedApplication.id ? changedApplication : application,
            );
            interviews = interviews.map((interview) =>
              interview.applicationId === changedApplication.id
                ? {
                    ...interview,
                    ...sharedPatch,
                    applicationStatus: changedApplication.applicationStatus,
                    interviewStatus: changedApplication.applicationStatus,
                  }
                : interview,
            );
          }
        }
        scheduleInterviewMetadataPersist(changedInterview);
        if (changedApplication) scheduleApplicationMetadataPersist(changedApplication.id, applicationPatch);
      }
      return {
        ...prev,
        applications,
        interviews,
      };
    });
  }

  function mergeRemoteStore(remote, current) {
    return withLocalTranscripts(preservePendingAnnotations(remote, current, unsavedAnnotationsRef.current), current);
  }

  function scheduleInterviewMetadataPersist(interview) {
    const existing = metadataPersistTimersRef.current.get(interview.id);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(async () => {
      try {
        await requestJson(`/api/interviews/${encodeURIComponent(interview.id)}`, {
          method: "PATCH",
          body: JSON.stringify(interviewMetadataPatch(interview)),
        });
        setPersistError("");
      } catch {
        setPersistError("当前轮次保存失败，请先导出 Markdown 兜底");
      } finally {
        // 请求结束后再移除，focus 刷新守卫要覆盖到请求完成为止；
        // 期间若重新调度过，map 里已是新 timer，不能误删。
        if (metadataPersistTimersRef.current.get(interview.id) === timer) {
          metadataPersistTimersRef.current.delete(interview.id);
        }
      }
    }, 350);
    metadataPersistTimersRef.current.set(interview.id, timer);
  }

  function scheduleApplicationMetadataPersist(applicationId, patch) {
    const pending = { ...applicationPendingPatchesRef.current.get(applicationId), ...patch };
    applicationPendingPatchesRef.current.set(applicationId, pending);
    const existing = applicationPersistTimersRef.current.get(applicationId);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(async () => {
      applicationPendingPatchesRef.current.delete(applicationId);
      try {
        await enqueueApplicationSave(applicationSaveQueuesRef.current, applicationId, () => requestJson(`/api/applications/${encodeURIComponent(applicationId)}`, {
          method: "PATCH",
          body: JSON.stringify(pending),
        }));
        if (applicationPersistTimersRef.current.get(applicationId) === timer) {
          unsavedAnnotationsRef.current.delete(applicationId);
          setAnnotationSaveStates((current) => ({ ...current, [applicationId]: "saved" }));
        }
        setPersistError("");
      } catch {
        if (applicationPersistTimersRef.current.get(applicationId) === timer) {
          setAnnotationSaveStates((current) => ({ ...current, [applicationId]: "error" }));
        }
        setPersistError("应聘流程资料保存失败，请先导出 Markdown 兜底");
      } finally {
        if (applicationPersistTimersRef.current.get(applicationId) === timer) {
          applicationPersistTimersRef.current.delete(applicationId);
        }
      }
    }, 350);
    applicationPersistTimersRef.current.set(applicationId, timer);
  }

  function applyActiveApplicationStatus(value, { keepPickerOpen = false } = {}) {
    const nextStatus = normalizeStatusLabel(value);
    if (!nextStatus) return;
    setError("");
    setStore((prev) => {
      const updatedAt = new Date().toISOString();
      return {
        ...prev,
        statusOptions: mergeStatusOptions(prev.statusOptions, [nextStatus], prev.applications),
        applications: prev.applications.map((application) =>
          application.id === activeApplication.id
            ? { ...application, applicationStatus: nextStatus, updatedAt }
            : application,
        ),
        interviews: prev.interviews.map((interview) =>
          interview.applicationId === activeApplication.id
            ? {
                ...interview,
                applicationStatus: nextStatus,
                interviewStatus: nextStatus,
                updatedAt,
              }
            : interview,
        ),
      };
    });
    setCustomStatusDraft("");
    setStatusPickerOpen(keepPickerOpen);
    enqueueApplicationSave(applicationSaveQueuesRef.current, activeApplication.id, () => requestJson(`/api/applications/${encodeURIComponent(activeApplication.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ applicationStatus: nextStatus }),
    })).catch(() => setPersistError("应聘流程状态保存失败"));
  }

  function applyStatusColor(color) {
    const statusLabel = normalizeStatusLabel(interviewStatus);
    if (!statusLabel) return;
    setStore((prev) => ({
      ...prev,
      statusColors: {
        ...prev.statusColors,
        [statusLabel]: color,
      },
    }));
    setStatusPickerOpen(false);
    requestJson("/api/status-options", {
      method: "PUT",
      body: JSON.stringify({ value: statusLabel, color }),
    }).catch(() => setPersistError("标签颜色保存失败"));
  }

  async function appendTranscriptLines(interviewId, nextLines) {
    try {
      await requestJson(`/api/interviews/${encodeURIComponent(interviewId)}/lines`, {
        method: "POST",
        body: JSON.stringify({ lines: nextLines }),
      });
      setPersistError("");
    } catch {
      setPersistError("转录保存失败，请先导出 Markdown 兜底");
    }
  }

  function switchInterview(interviewId) {
    if (!canSwitchInterview) return;
    partialTextBridge.set("");
    setError("");
    setIsPaused(false);
    setSessionLibraryOpen(false);
    setSessionMenuOpen(false);
    setStore((prev) => ({ ...prev, activeInterviewId: interviewId }));
    requestJson(`/api/interviews/${encodeURIComponent(interviewId)}/active`, {
      method: "PUT",
    })
      .then(() => setPersistError(""))
      .catch(() => setPersistError("当前场次保存失败"));
    hydrateInterviewTranscript(interviewId);
  }

  function hydrateInterviewTranscript(interviewId) {
    const target = store.interviews.find((interview) => interview.id === interviewId);
    if (!target || target.lines.length || !target.transcriptLineCount) return;
    requestJson(`/api/interviews/${encodeURIComponent(interviewId)}`)
      .then(({ interview }) => {
        if (!Array.isArray(interview?.lines)) return;
        setStore((prev) => ({
          ...prev,
          interviews: prev.interviews.map((item) =>
            item.id === interviewId && !item.lines.length
              ? { ...item, lines: interview.lines }
              : item,
          ),
        }));
      })
      .catch(() => setPersistError("转录读取失败，请重新打开该场次"));
  }

  function openInterviewForm(mode) {
    if (!canManageWorkbench) return;
    if (mode !== "create-application" && !hasActiveInterview) return;
    setError("");
    setSessionMenuOpen(false);
    const usesApplication = mode === "edit-application";
    const usesRound = mode === "edit-round";
    const sourceApplication = usesApplication ? activeApplication : null;
    const sourceRound = usesRound ? activeInterview : null;
    const nextRoundOrder = Math.max(0, ...activeRounds.map((round) => Number(round.roundOrder) || 0)) + 1;
    setInterviewForm({
      mode,
      applicationId: activeApplication.id,
      name:
        sourceApplication?.name === "未命名候选人"
          ? ""
          : sourceApplication?.name || "",
      applicationStatus: sourceApplication?.applicationStatus || DEFAULT_APPLICATION_STATUS,
      selectedJdId: sourceApplication?.selectedJdId || "",
      jdDraftName: sourceApplication?.jdDraftName || "",
      roleShortName: sourceApplication?.roleShortName || "",
      roleMarkdown: sourceApplication?.roleMarkdown || "",
      resumeMarkdown: sourceApplication?.resumeMarkdown || "",
      resumeFile: sourceApplication?.resumeFile || null,
      resumeFileChanged: false,
      saveJdToLibrary: false,
      roundOrder: sourceRound?.roundOrder || nextRoundOrder,
      roundLabel:
        sourceRound?.roundLabel ||
        roundLabelFor({ roundOrder: mode === "create-application" ? 1 : nextRoundOrder }),
      roundStatus: sourceRound?.roundStatus || "待安排",
      outcome: sourceRound?.outcome || "",
      roundFocus: sourceRound?.roundFocus || "",
      scheduledAt: toDatetimeLocalValue(sourceRound?.scheduledAt),
      durationMinutes:
        sourceRound?.durationMinutes || DEFAULT_INTERVIEW_DURATION_MINUTES,
    });
  }

  function patchInterviewForm(patch) {
    setInterviewForm((current) => (current ? { ...current, ...patch } : current));
  }

  function selectFormJd(jdId) {
    if (!jdId) {
      patchInterviewForm({
        selectedJdId: "",
        jdDraftName: "",
        roleShortName: "",
        roleMarkdown: "",
      });
      return;
    }
    const savedJd = store.jdLibrary.find((item) => item.id === jdId);
    if (!savedJd) return;
    patchInterviewForm({
      selectedJdId: savedJd.id,
      jdDraftName: savedJd.name,
      roleShortName: savedJd.shortName || "",
      roleMarkdown: savedJd.content,
    });
  }

  async function handleInterviewFormResumeFileChange(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const resumeFile = await serializeResumeFile(file);
      setError("");
      patchInterviewForm({ resumeFile, resumeFileChanged: true });
    } catch (err) {
      setError(err.message || "读取简历文件失败");
    }
  }

  async function handleActiveResumeReplacement(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !canSwitchInterview || !activeInterviewId) return;

    setResumeReplacing(true);
    setError("");
    try {
      const nextResumeFile = await serializeResumeFile(file);
      await requestJson(`/api/interviews/${encodeURIComponent(activeInterviewId)}/resume`, {
        method: "PUT",
        body: JSON.stringify({ resumeFile: nextResumeFile }),
      });
      const remoteStore = await loadRemoteInterviewStore();
      if (remoteStore) {
        setStore((current) =>
          mergeRemoteStore({ ...remoteStore, activeInterviewId }, current),
        );
      }
      setResumePreviewError("");
      setPersistError("");
    } catch (replacementError) {
      setError(replacementError.message || "更换简历失败");
    } finally {
      setResumeReplacing(false);
    }
  }

  async function submitInterviewForm() {
    if (!interviewForm || !canManageWorkbench) return;
    if (interviewForm.mode !== "create-application" && !hasActiveInterview) return;
    if (interviewFormSubmitLockRef.current) return;
    const isRoundForm = ["create-round", "edit-round"].includes(interviewForm.mode);
    const roundLabelValue = normalizeStatusLabel(interviewForm.roundLabel);
    if (!roundLabelValue) {
      setError("请填写轮次名称");
      return;
    }
    const durationMinutesValue = Number(interviewForm.durationMinutes);
    if (!isValidInterviewDurationMinutes(durationMinutesValue)) {
      setError(
        `面试时长必须是 ${MIN_INTERVIEW_DURATION_MINUTES}–${MAX_INTERVIEW_DURATION_MINUTES} 之间的整数分钟`,
      );
      return;
    }
    setError("");
    interviewFormSubmitLockRef.current = true;
    setInterviewFormSubmitting(true);
    try {
      const scheduledAtValue = fromDatetimeLocalValue(interviewForm.scheduledAt);
      const roundPatch = {
        scheduledAt: fromDatetimeLocalValue(interviewForm.scheduledAt),
        durationMinutes: durationMinutesValue,
        roundLabel: roundLabelValue,
        roundStatus:
          interviewForm.mode === "edit-round"
            ? interviewForm.roundStatus
            : scheduledAtValue
              ? "已安排"
              : "待安排",
        outcome: normalizeStatusLabel(interviewForm.outcome),
        roundFocus: interviewForm.roundFocus.trim(),
      };

      let nextActiveId = activeInterviewId;
      if (interviewForm.mode === "create-round") {
        const data = await requestJson(
          `/api/applications/${encodeURIComponent(activeApplication.id)}/rounds`,
          {
            method: "POST",
            body: JSON.stringify({ ...roundPatch, activate: true }),
          },
        );
        nextActiveId = data.interview?.id || nextActiveId;
      } else if (interviewForm.mode === "edit-round") {
        await requestJson(`/api/interviews/${encodeURIComponent(activeInterviewId)}`, {
          method: "PATCH",
          body: JSON.stringify(roundPatch),
        });
      } else {
        const name = interviewForm.name.trim();
        if (!name) throw new Error("请填写候选人姓名");
        const applicationStatusValue = normalizeStatusLabel(interviewForm.applicationStatus);
        if (!applicationStatusValue) throw new Error("请填写应聘流程状态");
        const roleMarkdownValue = interviewForm.roleMarkdown.trim();
        const roleShortNameValue = interviewForm.roleShortName.trim();
        const jdName =
          interviewForm.jdDraftName.trim() ||
          extractMarkdownTitle(roleMarkdownValue) ||
          "";
        let nextJdId = interviewForm.selectedJdId || "";

        if (interviewForm.saveJdToLibrary && roleMarkdownValue) {
          const existing = nextJdId
            ? store.jdLibrary.find((item) => item.id === nextJdId)
            : null;
          const { jd } = await requestJson("/api/jds", {
            method: "POST",
            body: JSON.stringify({
              id: existing?.id || safeId(),
              name: jdName || existing?.name || `JD ${store.jdLibrary.length + 1}`,
              shortName: roleShortNameValue,
              content: roleMarkdownValue,
              createdAt: existing?.createdAt,
            }),
          });
          nextJdId = jd.id;
        }

        const applicationPatch = {
          name,
          applicationStatus: applicationStatusValue,
          selectedJdId: nextJdId,
          jdDraftName: jdName,
          roleShortName: roleShortNameValue,
          roleMarkdown: roleMarkdownValue,
          resumeMarkdown: interviewForm.resumeMarkdown,
          ...(interviewForm.resumeFileChanged ? { resumeNotes: [] } : {}),
        };

        if (interviewForm.mode === "create-application") {
          const data = await requestJson("/api/applications", {
            method: "POST",
            body: JSON.stringify({
              ...applicationPatch,
              ...roundPatch,
              firstRound: roundPatch,
              resumeFile: interviewForm.resumeFile,
              activate: true,
            }),
          });
          nextActiveId = data.interview?.id || data.application?.rounds?.[0]?.id || nextActiveId;
        } else {
          await requestJson(`/api/applications/${encodeURIComponent(activeApplication.id)}`, {
            method: "PATCH",
            body: JSON.stringify(applicationPatch),
          });
          if (interviewForm.resumeFileChanged) {
            if (interviewForm.resumeFile) {
              await requestJson(`/api/interviews/${encodeURIComponent(activeInterviewId)}/resume`, {
                method: "PUT",
                body: JSON.stringify({ resumeFile: interviewForm.resumeFile }),
              });
            } else {
              await requestJson(`/api/interviews/${encodeURIComponent(activeInterviewId)}/resume`, {
                method: "DELETE",
              });
            }
          }
        }
      }

      const remoteStore = await loadRemoteInterviewStore();
      if (remoteStore) {
        setStore((current) =>
          mergeRemoteStore(
            preserveActiveInterview(remoteStore, nextActiveId),
            current,
          ),
        );
      }
      partialTextBridge.set("");
      setInterviewForm(null);
      setPersistError("");
    } catch (err) {
      setError(err.message || (isRoundForm ? "保存轮次失败" : "保存应聘流程失败"));
    } finally {
      interviewFormSubmitLockRef.current = false;
      setInterviewFormSubmitting(false);
    }
  }

  async function deleteActiveRound() {
    if (!canSwitchInterview || activeRounds.length <= 1) return;
    if (!window.confirm(`确认删除“${roundLabelFor(activeInterview)}”？该轮的转录和分析将移入本机回收状态。`)) {
      return;
    }
    partialTextBridge.set("");
    setError("");
    setSessionMenuOpen(false);
    const currentRoundIndex = activeRounds.findIndex((round) => round.id === activeInterviewId);
    const adjacentRound =
      activeRounds[currentRoundIndex - 1] || activeRounds[currentRoundIndex + 1];
    let deleted = false;
    try {
      await requestJson(`/api/interviews/${encodeURIComponent(activeInterviewId)}`, {
        method: "DELETE",
      });
      deleted = true;
      try {
        await requestJson(`/api/interviews/${encodeURIComponent(adjacentRound.id)}/active`, {
          method: "PUT",
        });
        setPersistError("");
      } catch {
        setPersistError("轮次已删除，但当前轮次同步失败");
      }
      const remoteStore = await loadRemoteInterviewStore();
      if (remoteStore) {
        setStore((current) =>
          mergeRemoteStore(
            preserveActiveInterview(remoteStore, adjacentRound.id),
            current,
          ),
        );
      }
      hydrateInterviewTranscript(adjacentRound.id);
    } catch (err) {
      setError(
        deleted
          ? "轮次已删除，但工作台刷新失败，请重新打开页面"
          : err.message || "删除当前轮失败",
      );
    }
  }

  async function archiveActiveApplication() {
    if (!canSwitchInterview) return;
    if (!window.confirm(`确认归档“${interviewName || "未命名候选人"}”的整个应聘流程？所有轮次将从工作台隐藏。`)) {
      return;
    }
    partialTextBridge.set("");
    setError("");
    setSessionMenuOpen(false);
    try {
      await requestJson(`/api/applications/${encodeURIComponent(activeApplication.id)}`, {
        method: "DELETE",
      });
      const remoteStore = await loadRemoteInterviewStore();
      if (remoteStore) {
        setStore((current) => mergeRemoteStore(remoteStore, current));
      }
    } catch (err) {
      setError(err.message || "归档应聘流程失败");
    }
  }

  function saveResumeAnnotation(note) {
    if (!note.text.trim()) return;
    unsavedAnnotationsRef.current.add(activeApplication.id);
    setAnnotationSaveStates((current) => ({ ...current, [activeApplication.id]: "saving" }));
    updateActiveInterview((interview) => ({ resumeNotes: upsertNote(interview.resumeNotes || [], note) }));
  }

  function deleteResumeAnnotation(noteId) {
    unsavedAnnotationsRef.current.add(activeApplication.id);
    setAnnotationSaveStates((current) => ({ ...current, [activeApplication.id]: "saving" }));
    updateActiveInterview((interview) => ({ resumeNotes: (interview.resumeNotes || []).filter((note) => note.id !== noteId) }));
  }

  function retryResumeAnnotations() {
    unsavedAnnotationsRef.current.add(activeApplication.id);
    setAnnotationSaveStates((current) => ({ ...current, [activeApplication.id]: "saving" }));
    scheduleApplicationMetadataPersist(activeApplication.id, { resumeNotes });
  }

  async function startInterview() {
    if (!canSwitchInterview || !activeInterviewId) return;
    const captureAttemptId = safeId();
    captureAttemptRef.current = captureAttemptId;
    setError("");
    setStatus("connecting");
    partialTextBridge.set("");
    pendingInputRef.current = new Float32Array(0);
    runIdRef.current = safeId();

    try {
      let displayStream = null;
      if (audioSourceMode === AUDIO_SOURCE_MEETING) {
        if (!navigator.mediaDevices?.getDisplayMedia) {
          throw createCaptureError("SYSTEM_AUDIO_UNSUPPORTED");
        }
        displayStream = await navigator.mediaDevices.getDisplayMedia(buildDisplayMediaOptions());
        if (captureAttemptRef.current !== captureAttemptId) {
          displayStream.getTracks().forEach((track) => track.stop());
          return;
        }
        displayStreamRef.current = displayStream;
        if (!hasAudioTrack(displayStream)) throw createCaptureError("SYSTEM_AUDIO_MISSING");
      }

      const microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (captureAttemptRef.current !== captureAttemptId) {
        microphoneStream.getTracks().forEach((track) => track.stop());
        displayStream?.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = microphoneStream;
      displayStreamRef.current = displayStream;

      displayStream?.getAudioTracks()[0]?.addEventListener("ended", () => {
        if (
          captureAttemptRef.current === captureAttemptId &&
          displayStreamRef.current === displayStream &&
          ["recording", "reconnecting"].includes(statusRef.current)
        ) {
          setError("会议声音共享已停止，当前仅转录麦克风");
        }
      });

      updateActiveInterview((interview) => ({
        sessionStartedAt: interview.sessionStartedAt || new Date().toISOString(),
        roundStatus: "进行中",
      }));

      reconnectAttemptRef.current = 0;
      openAsrSocket(captureAttemptId);
    } catch (err) {
      if (captureAttemptRef.current !== captureAttemptId) return;
      setError(audioCaptureErrorMessage(err, audioSourceMode));
      setStatus("error");
      stopLocalAudio();
    }
  }

  function openAsrSocket(captureAttemptId, { reconnectAttempt = 0 } = {}) {
    const socket = createAsrWebSocket();
    socket.binaryType = "arraybuffer";
    wsRef.current = socket;

    socket.onopen = async () => {
      try {
        if (captureAttemptRef.current !== captureAttemptId) return;
        if (!audioContextRef.current) {
          await startAudioCapture(streamRef.current, displayStreamRef.current);
        }
        if (captureAttemptRef.current !== captureAttemptId) return;
        setStatus("recording");
        if (reconnectAttempt > 0) setError("");
        reconnectAttemptRef.current = 0;
      } catch (captureError) {
        setError(captureError.message || "无法处理音频");
        setStatus("error");
        socket.close();
        stopLocalAudio();
      }
    };
    socket.onmessage = (event) => {
      if (wsRef.current !== socket) return;
      handleServerMessage(event.data);
    };
    socket.onerror = () => {
      if (wsRef.current !== socket) return;
      socket.close();
    };
    socket.onclose = () => {
      if (wsRef.current !== socket) return;
      if (statusRef.current === "stopped") {
        stopLocalAudio();
        return;
      }
      if (
        captureAttemptRef.current === captureAttemptId &&
        ["recording", "reconnecting", "connecting"].includes(statusRef.current)
      ) {
        scheduleAsrReconnect(captureAttemptId);
        return;
      }
      commitPartialTranscript();
      setStatus("stopped");
      setError("转录连接已断开，请重新开始面试");
      stopLocalAudio();
    };
  }

  function scheduleAsrReconnect(captureAttemptId) {
    const attempt = reconnectAttemptRef.current + 1;
    if (attempt > 5) {
      commitPartialTranscript();
      setError("转录连接已断开，请重新开始面试");
      setStatus("error");
      stopLocalAudio();
      return;
    }
    reconnectAttemptRef.current = attempt;
    setStatus("reconnecting");
    setError("转录连接中断，正在重连");
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (captureAttemptRef.current !== captureAttemptId) return;
      if (!["recording", "reconnecting", "connecting"].includes(statusRef.current)) return;
      openAsrSocket(captureAttemptId, { reconnectAttempt: attempt });
    }, 800 * attempt);
  }

  async function startAudioCapture(microphoneStream, displayStream = null) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioContext();
    audioContextRef.current = audioContext;
    await audioContext.audioWorklet.addModule("/pcm-worklet.js");

    const microphoneSource = audioContext.createMediaStreamSource(microphoneStream);
    const mixBus = audioContext.createGain();
    mixBus.gain.value = displayStream ? 0.82 : 1;
    const worklet = new AudioWorkletNode(audioContext, "pcm-capture");
    const mutedGain = audioContext.createGain();
    mutedGain.gain.value = 0;

    worklet.port.onmessage = (event) => {
      if (
        !["recording", "reconnecting"].includes(statusRef.current) ||
        pausedRef.current ||
        !wsRef.current ||
        wsRef.current.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      enqueueAudioChunk(event.data, audioContext.sampleRate);
    };

    microphoneSource.connect(mixBus);
    if (displayStream && hasAudioTrack(displayStream)) {
      const displaySource = audioContext.createMediaStreamSource(displayStream);
      displaySource.connect(mixBus);
    }
    mixBus.connect(worklet);
    worklet.connect(mutedGain);
    mutedGain.connect(audioContext.destination);
    await audioContext.resume();

    workletRef.current = worklet;
    mutedGainRef.current = mutedGain;
  }

  function enqueueAudioChunk(floatChunk, inputSampleRate) {
    const previous = pendingInputRef.current;
    const next = new Float32Array(previous.length + floatChunk.length);
    next.set(previous);
    next.set(floatChunk, previous.length);

    const inputChunkSize = Math.max(
      1,
      Math.round((inputSampleRate * CHUNK_MS) / 1000),
    );
    let offset = 0;

    while (next.length - offset >= inputChunkSize) {
      const inputChunk = next.slice(offset, offset + inputChunkSize);
      const resampled = resampleTo16k(inputChunk, inputSampleRate);
      const pcm = floatTo16BitPcm(resampled.slice(0, CHUNK_SAMPLES));
      wsRef.current?.send(pcm);
      offset += inputChunkSize;
    }

    pendingInputRef.current = next.slice(offset);
  }

  function handleServerMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.type === "error") {
      setError(message.message || "转录服务返回错误");
      return;
    }
    if (message.type === "status") {
      if (message.status === "asr-connected") {
        if (statusRef.current !== "stopped") setStatus("recording");
        setError("");
      }
      if (
        message.status === "asr-reconnecting" ||
        message.status === "asr-closed"
      ) {
        if (statusRef.current !== "stopped") setStatus("reconnecting");
        setError("语音识别连接中断，正在自动重连");
      }
      return;
    }
    if (message.type !== "transcript") return;

    const definite = (message.utterances || [])
      .filter((item) => item.definite && item.text?.trim())
      .map((item) => ({ ...item, runId: runIdRef.current }));
    const partial = [...(message.utterances || [])]
      .reverse()
      .find((item) => !item.definite && item.text);

    if (definite.length) {
      updateActiveInterview((interview) => {
        const nextSpeakerLabels = { ...interview.speakerLabels };
        for (const item of definite) {
          if (item.speaker && !nextSpeakerLabels[item.speaker]) {
            nextSpeakerLabels[item.speaker] = `说话人 ${item.speaker}`;
          }
        }
        return {
          lines: mergeTranscriptLines(interview.lines, definite),
          speakerLabels: nextSpeakerLabels,
        };
      });
      appendTranscriptLines(activeInterviewId, definite);
      partialTextBridge.set("");
    } else if (partial?.text) {
      partialTextBridge.set(partial.text);
    } else if (message.text) {
      partialTextBridge.set(message.text);
    }
  }

  function pauseInterview() {
    setIsPaused((value) => !value);
  }

  function stopInterview() {
    commitPartialTranscript();
    setStatus("stopped");
    setIsPaused(false);
    updateActiveInterview({ roundStatus: "已结束" });
    const socket = wsRef.current;
    try {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "stop" }));
      }
    } finally {
      socket?.close();
      stopLocalAudio();
    }
  }

  function stopLocalAudio() {
    captureAttemptRef.current = "";
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptRef.current = 0;
    workletRef.current?.disconnect();
    mutedGainRef.current?.disconnect();
    audioContextRef.current?.close().catch(() => {});
    streamRef.current?.getTracks().forEach((track) => track.stop());
    displayStreamRef.current?.getTracks().forEach((track) => track.stop());
    wsRef.current = null;
    streamRef.current = null;
    displayStreamRef.current = null;
    audioContextRef.current = null;
    workletRef.current = null;
    mutedGainRef.current = null;
  }

  function handleSpeakerLabelChange(speaker, value) {
    updateActiveInterview((interview) => ({
      speakerLabels: {
        ...interview.speakerLabels,
        [speaker]: value,
      },
    }));
  }

  function commitPartialTranscript() {
    const text = partialTextBridge.get().trim();
    if (!text) return;
    const line = {
      runId: runIdRef.current || "partial",
      text,
      speaker: "",
    };
    updateActiveInterview((interview) => ({
      lines: mergeTranscriptLines(interview.lines, [line]),
    }));
    appendTranscriptLines(activeInterviewId, [line]);
    partialTextBridge.set("");
  }

  async function processNow() {
    const transcriptSlice = getCurrentSegmentText().trim();
    if (!transcriptSlice) {
      setError("这一段还没有可处理的转录文本");
      return;
    }
    if (currentSegmentPending) {
      setError("当前转录片段已经在分析中");
      return;
    }

    setError("");
    const segmentStart = lastProcessedLineCount;
    const snapshotLineCount = lines.length;
    const pendingCard = {
      id: safeId(),
      createdAt: new Date().toISOString(),
      status: "queued",
      markdown: "已提交分析任务...",
      transcriptSlice,
      snapshotLineCount,
      segmentStart,
      segmentEnd: snapshotLineCount,
      attempts: 0,
    };
    updateActiveInterview((interview) => ({
      cards: [pendingCard, ...interview.cards],
    }));

    try {
      const response = await apiFetch("/api/analyze-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          interviewId: activeInterviewId,
          cardId: pendingCard.id,
          segmentStart,
          segmentEnd: snapshotLineCount,
          resumeMarkdown,
          roleMarkdown,
          transcriptSlice,
          askedQuestions,
          previousCards: cards.slice(0, 5).map((card) => summarizeCard(card.markdown)),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "创建分析任务失败");

      updateActiveInterview((interview) => ({
        cards: interview.cards.map((card) =>
          card.id === pendingCard.id && isPendingAnalyzeCard(card)
            ? {
                ...card,
                jobId: data.id,
                status: data.status,
                attempts: data.attempts || 0,
                markdown: analyzeJobPlaceholder(data),
              }
            : card,
        ),
      }));
    } catch (err) {
      const message = err.message || "创建分析任务失败";
      setError(message);
      updateActiveInterview((interview) => ({
        cards: interview.cards.map((card) =>
          card.id === pendingCard.id
            ? { ...card, status: "error", markdown: message }
            : card,
        ),
      }));
    }
  }

  async function retryAnalysisCard(card) {
    setError("");
    try {
      let data;
      if (card.jobId) {
        data = await requestJson(`/api/analyze-jobs/${encodeURIComponent(card.jobId)}/retry`, {
          method: "POST",
        });
      } else {
        data = await requestJson("/api/analyze-jobs", {
          method: "POST",
          body: JSON.stringify({
            interviewId: activeInterviewId,
            cardId: card.id,
            segmentStart: card.segmentStart ?? lastProcessedLineCount,
            segmentEnd: card.segmentEnd ?? card.snapshotLineCount ?? lines.length,
            resumeMarkdown,
            roleMarkdown,
            transcriptSlice: card.transcriptSlice,
            askedQuestions,
            previousCards: cards.slice(0, 5).map((item) => summarizeCard(item.markdown)),
          }),
        });
      }
      updateActiveInterview((interview) => ({
        cards: interview.cards.map((item) =>
          item.id === card.id
            ? { ...item, jobId: data.id, status: data.status, attempts: data.attempts, markdown: analyzeJobPlaceholder(data) }
            : item,
        ),
      }));
    } catch (err) {
      setError(err.message || "重新分析失败");
    }
  }

  function applyAnalyzeJobUpdate(job) {
    setStore((prev) => ({
      ...prev,
      interviews: prev.interviews.map((interview) => {
        let askedQuestions = interview.askedQuestions;
        const cards = interview.cards.map((card) => {
          if (card.jobId !== job.id) return card;
          if (job.status === "done") {
            askedQuestions = mergeQuestions(askedQuestions, [
              ...extractQuestionLikeLines(card.transcriptSlice || ""),
              ...(job.detectedQuestions || []),
            ]);
            return {
              ...card,
              status: "done",
              attempts: job.attempts,
              markdown: job.markdown,
            };
          }
          if (job.status === "error" || job.status === "cancelled") {
            return {
              ...card,
              status: "error",
              attempts: job.attempts,
              markdown: job.error || "分析失败",
            };
          }
          return {
            ...card,
            status: job.status,
            attempts: job.attempts,
            markdown: analyzeJobPlaceholder(job),
          };
        });
        const completedCard = cards.find((card) => card.jobId === job.id);
        const lastProcessedLineCount =
          job.status === "done"
            ? Math.max(
                interview.lastProcessedLineCount,
                Number(job.segmentEnd ?? completedCard?.segmentEnd ?? completedCard?.snapshotLineCount ?? 0),
              )
            : interview.lastProcessedLineCount;
        return { ...interview, cards, askedQuestions, lastProcessedLineCount };
      }),
    }));
  }

  function exportMarkdown() {
    const content = [
      `# ${interviewName || "面试记录"}`,
      "",
      `应聘流程状态：${interviewStatus || DEFAULT_APPLICATION_STATUS}`,
      `面试轮次：${roundLabelFor(activeInterview)}`,
      `轮次状态：${roundStatus || inferRoundStatus(activeInterview)}`,
      `本轮结果：${outcome || "未填写"}`,
      `本轮重点：${roundFocus || "未填写"}`,
      `计划面试时间：${formatDateTime(scheduledAt) || "未设置"}`,
      `计划面试时长：${durationMinutes} 分钟`,
      `开始时间：${sessionStartedAt ? new Date(sessionStartedAt).toLocaleString() : "未开始"}`,
      "",
      "## 岗位能力要求",
      roleMarkdown || "未填写",
      "",
      "## 简历预分析",
      resumeMarkdown || "未填写",
      "",
      "## 简历备注",
      resumeNotes.length
        ? resumeNotes
            .slice()
            .reverse()
            .map(
              (note) =>
                `- 位置 ${Math.round(note.x * 100)}% / ${Math.round(
                  note.y * 100,
                )}%：${note.text}`,
            )
            .join("\n")
        : "暂无",
      "",
      "## 转录文稿",
      transcriptText || "暂无",
      "",
      "## 累计已问问题",
      askedQuestions.length
        ? askedQuestions.map((item) => `- ${item}`).join("\n")
        : "暂无",
      "",
      "## AI 追问卡片",
      cards
        .slice()
        .reverse()
        .map((card, index) => `### 卡片 ${index + 1}\n\n${card.markdown}`)
        .join("\n\n"),
    ].join("\n");

    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${sanitizeFilename(`${interviewName || "面试记录"}-${roundLabelFor(activeInterview)}`)}-${new Date()
      .toISOString()
      .slice(0, 19)}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function exportFullBackup() {
    setError("");
    try {
      const response = await apiFetch("/api/export");
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "导出完整备份失败");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") || "";
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] || "interview-workbench-backup.json";
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message || "导出完整备份失败");
    } finally {
      setSessionMenuOpen(false);
    }
  }

  async function connectWithAccessToken(event) {
    event.preventDefault();
    setAccessToken(accessTokenDraft);
    setError("");
    try {
      const [healthResponse, remoteStore] = await Promise.all([
        apiFetch("/api/health"),
        loadRemoteInterviewStore(),
      ]);
      if (!healthResponse.ok) throw new ApiError("连接口令无效", healthResponse.status);
      setHealth(await healthResponse.json());
      if (remoteStore) setStore(remoteStore);
      setPersistError("");
      setAuthRequired(false);
      setAccessTokenDraft("");
      setStoreReady(true);
    } catch (connectError) {
      setAccessToken("");
      setError(connectError.status === 401 ? "连接口令无效" : connectError.message || "连接失败");
    }
  }

  async function refreshHealth() {
    try {
      const response = await apiFetch("/api/health");
      setHealth(await response.json());
    } catch {
      setHealth({ ok: false });
    }
  }

  async function openProviderSettings() {
    setProviderSettingsOpen(true);
    setProviderSettingsDraft(null);
    setProviderSettingsError("");
    try {
      const data = await requestJson("/api/provider-settings");
      setProviderSettingsDraft(createProviderSettingsDraft(data.settings));
    } catch (settingsError) {
      setProviderSettingsError(settingsError.message || "读取服务配置失败");
    }
  }

  async function saveProviderSettings() {
    if (!providerSettingsDraft) return;
    setProviderSettingsSaving(true);
    setProviderSettingsError("");
    try {
      const data = await requestJson("/api/provider-settings", {
        method: "PUT",
        body: JSON.stringify({
          asr: {
            apiKey: providerSettingsDraft.asr.apiKey,
            appKey: providerSettingsDraft.asr.appKey,
            accessKey: providerSettingsDraft.asr.accessKey,
            clearApiKey: providerSettingsDraft.asr.clearApiKey,
            clearLegacyCredentials: providerSettingsDraft.asr.clearLegacyCredentials,
            resourceId: providerSettingsDraft.asr.resourceId,
            url: providerSettingsDraft.asr.url,
          },
          llm: {
            apiKey: providerSettingsDraft.llm.apiKey,
            clearApiKey: providerSettingsDraft.llm.clearApiKey,
            baseUrl: providerSettingsDraft.llm.baseUrl,
            model: providerSettingsDraft.llm.model,
            timeoutMs: Number(providerSettingsDraft.llm.timeoutMs),
          },
        }),
      });
      setHealth(data.health);
      setProviderSettingsOpen(false);
      setProviderSettingsDraft(null);
    } catch (settingsError) {
      setProviderSettingsError(settingsError.message || "保存服务配置失败");
    } finally {
      setProviderSettingsSaving(false);
    }
  }

  function importFullBackup() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (!window.confirm("导入会替换当前工作台数据。服务端会先自动备份，确认继续吗？")) return;
      setError("");
      try {
        const parsed = JSON.parse(await file.text());
        const data = await requestJson("/api/import", {
          method: "POST",
          body: JSON.stringify(parsed),
        });
        setStore(normalizeStore(data.store));
      } catch (err) {
        setError(err.message || "导入完整备份失败");
      }
    };
    input.click();
    setSessionMenuOpen(false);
  }

  return (
    <main className="app">
      <nav className="app-rail" aria-label="工作台导航">
        <a className="rail-brand" href="#workspace" title="面试工作台" aria-label="面试工作台">
          <img src="/favicon.png" alt="" />
        </a>
        <div className="rail-navigation">
          <a className="rail-action selected" href="#workspace" aria-current="page">
            <PanelsTopLeft size={20} /><span>工作台</span>
          </a>
          <button className="rail-action" disabled={!canManageWorkbench} onClick={() => setCalendarOpen(true)} title="预览面试安排">
            <CalendarDays size={20} /><span>日历</span>
          </button>
          <button className="rail-action" disabled={!canManageWorkbench} onClick={() => setSessionLibraryOpen(true)} title="浏览和筛选面试流程">
            <ListFilter size={20} /><span>流程库</span>
          </button>
          <button className="rail-action" disabled={!canManageWorkbench} onClick={() => openInterviewForm("create-application")} title="新建面试流程">
            <Plus size={20} /><span>新建</span>
          </button>
        </div>
        <button className="rail-action rail-settings" disabled={!canManageWorkbench} onClick={openProviderSettings} title="配置语音识别和大模型">
          <Settings size={20} /><span>配置</span>
          {health && (!health.asrConfigured || !health.llmConfigured) ? <i className="rail-warning" /> : null}
        </button>
      </nav>
      <div className="app-content">
      <header className="topbar">
        <section className="active-session-summary" aria-label="当前面试流程">
          <div className="session-breadcrumb">面试 <span>/</span> {hasActiveInterview ? roundLabelFor(activeInterview) : "工作台"}</div>
          <h1 className="active-session-name">
            {hasActiveInterview ? interviewName || "未命名候选人" : "面试工作台"}
          </h1>
          {hasActiveInterview ? <div className="active-session-meta">
            <span className="session-role">
              <BriefcaseBusiness size={14} />
              {jdDraftName || "未设置岗位"}
            </span>
            <ApplicationStatusPicker value={interviewStatus} options={statusOptions} colors={store.statusColors}
              disabled={!canSwitchInterview} open={statusPickerOpen} onOpenChange={setStatusPickerOpen}
              draft={customStatusDraft} onDraftChange={setCustomStatusDraft} onSelect={applyActiveApplicationStatus} onColorChange={applyStatusColor} />
            <span className="current-round-label">{roundLabelFor(activeInterview)}</span>
            <span className="session-time">
              <CalendarClock size={14} />
              {formatShortDateTime(scheduledAt) || "未安排时间"}
            </span>
          </div> : <div className="active-session-meta">新建流程后即可安排首轮面试</div>}
        </section>

        <div className="management-actions">
          <p className={`session-state state-${status}${isPaused ? " state-paused" : ""}`}>
            {statusLabel(status, isPaused)}
          </p>
          <div className="session-menu">
            <button
              className="icon-button"
              disabled={!canSwitchInterview}
              onClick={() => setSessionMenuOpen((open) => !open)}
              title="当前流程与轮次操作"
              aria-label="当前流程与轮次操作"
            >
              <Ellipsis size={19} />
            </button>
            {sessionMenuOpen ? (
              <div className="session-menu-popover">
                <button onClick={() => openInterviewForm("edit-application")}>
                  <Pencil size={16} />
                  编辑应聘流程
                </button>
                <button onClick={() => openInterviewForm("edit-round")}>
                  <Pencil size={16} />
                  编辑当前轮
                </button>
                <button onClick={() => openInterviewForm("create-round")}>
                  <Plus size={16} />
                  安排下一轮
                </button>
                <button
                  onClick={() => {
                    exportMarkdown();
                    setSessionMenuOpen(false);
                  }}
                >
                  <Download size={16} />
                  导出记录
                </button>
                <button onClick={exportFullBackup}>
                  <Download size={16} />
                  导出完整备份
                </button>
                <button onClick={importFullBackup}>
                  <Upload size={16} />
                  导入完整备份
                </button>
                <button
                  className="danger-action"
                  disabled={activeRounds.length <= 1}
                  onClick={deleteActiveRound}
                  title={activeRounds.length <= 1 ? "唯一一轮不能删除，请归档整个流程" : "只删除当前轮"}
                >
                  <Trash2 size={16} />
                  删除当前轮
                </button>
                <button className="danger-action" onClick={archiveActiveApplication}>
                  <Archive size={16} />
                  归档整个流程
                </button>
              </div>
            ) : null}
          </div>
          <label className="audio-source-select">
            {audioSourceMode === AUDIO_SOURCE_MEETING ? <MonitorSpeaker size={16} /> : <Mic size={16} />}
            <select aria-label="收音方式" value={audioSourceMode} disabled={!canSwitchInterview}
              onChange={(event) => {
                setAudioSourceMode(event.target.value);
                saveAudioSourceMode(event.target.value);
              }}>
              <option value={AUDIO_SOURCE_MICROPHONE}>麦克风</option>
              <option value={AUDIO_SOURCE_MEETING}>麦克风 + 会议声音</option>
            </select>
          </label>
          {status === "idle" || status === "stopped" || status === "error" ? (
            <button
              className="session-start primary"
              disabled={!canSwitchInterview}
              onClick={startInterview}
              title="开始面试"
            >
              <Play size={17} />
              开始面试
            </button>
          ) : (
            <>
              <button onClick={pauseInterview} title={isPaused ? "继续" : "暂停"}>
                {isPaused ? <Play size={17} /> : <Pause size={17} />}
                {isPaused ? "继续" : "暂停"}
              </button>
              <button className="stop-action" onClick={stopInterview} title="结束面试">
                <Square size={16} />
                结束面试
              </button>
            </>
          )}
        </div>
      </header>

      {hasActiveInterview ? <RoundTimeline
        activeInterviewId={activeInterviewId}
        canSwitch={canSwitchInterview}
        onAdd={() => openInterviewForm("create-round")}
        onSelect={switchInterview}
        rounds={activeRounds}
      /> : <section className="empty-workbench" role="status">
        <div>
          <h2>{storeReady ? "还没有面试流程" : "正在读取面试流程"}</h2>
          <p>{storeReady ? "先建立候选人应聘流程，并在同一流程下继续安排二面、终面或加面。" : "请稍候。"}</p>
        </div>
        {storeReady ? <button
          className="primary"
          disabled={!canManageWorkbench}
          onClick={() => openInterviewForm("create-application")}
          type="button"
        >
          <Plus size={16} />
          新建面试流程
        </button> : null}
      </section>}

      {error || persistError ? <div className="error">{error || persistError}</div> : null}

      {health && health.ok && (!health.asrConfigured || !health.llmConfigured) ? (
        <div className="configuration-warning" role="status">
          <span>
            服务已启动，但{!health.asrConfigured && !health.llmConfigured
              ? "语音识别和大模型"
              : !health.asrConfigured
                ? "语音识别"
                : "大模型"}尚未配置。
          </span>
          <button disabled={!canManageWorkbench} onClick={openProviderSettings}>
            <Settings size={15} />
            打开配置
          </button>
        </div>
      ) : null}

      {audioSourceMode === AUDIO_SOURCE_MEETING && canSwitchInterview ? (
        <div className="meeting-audio-hint" role="status">
          <MonitorSpeaker size={16} />
          <span>开始后请选择腾讯会议窗口或整个屏幕，并开启共享音频；工作台不会上传或保存屏幕画面。</span>
        </div>
      ) : null}

      {authRequired ? (
        <div className="dialog-backdrop">
          <form className="access-dialog" onSubmit={connectWithAccessToken}>
            <div className="dialog-header">
              <div>
                <h2>连接工作台</h2>
                <p>此服务启用了访问保护</p>
              </div>
            </div>
            <label>
              <span>连接口令</span>
              <input
                autoFocus
                type="password"
                value={accessTokenDraft}
                onChange={(event) => setAccessTokenDraft(event.target.value)}
                autoComplete="off"
              />
            </label>
            <button className="primary" disabled={!accessTokenDraft.trim()} type="submit">
              连接
            </button>
          </form>
        </div>
      ) : null}

      {sessionLibraryOpen ? (
        <SessionLibraryDialog
          activeInterviewId={activeInterviewId}
          applications={store.applications}
          interviews={store.interviews}
          onClose={() => setSessionLibraryOpen(false)}
          onSelect={switchInterview}
          statusColors={store.statusColors}
          statusOptions={statusOptions}
        />
      ) : null}

      {calendarOpen ? (
        <InterviewCalendarDialog
          interviews={store.interviews}
          onClose={() => setCalendarOpen(false)}
          onSync={syncInterviewToSystemCalendar}
        />
      ) : null}

      {interviewForm ? (
        <InterviewFormDialog
          form={interviewForm}
          jdLibrary={store.jdLibrary}
          onChange={patchInterviewForm}
          onClose={() => setInterviewForm(null)}
          onResumeFileChange={handleInterviewFormResumeFileChange}
          onSelectJd={selectFormJd}
          onSubmit={submitInterviewForm}
          roundStatusOptions={ROUND_STATUS_OPTIONS}
          statusOptions={statusOptions}
          submitting={interviewFormSubmitting}
        />
      ) : null}

      {providerSettingsOpen ? (
        <ProviderSettingsDialog
          draft={providerSettingsDraft}
          error={providerSettingsError}
          onChange={setProviderSettingsDraft}
          onClose={() => {
            if (providerSettingsSaving) return;
            setProviderSettingsOpen(false);
            setProviderSettingsDraft(null);
            setProviderSettingsError("");
          }}
          onSubmit={saveProviderSettings}
          saving={providerSettingsSaving}
        />
      ) : null}

      {hasActiveInterview ? <div className="workspace-frame">
      <SplitPane id="workspace" preferenceKey="workspaceSplit" className="workspace interview-workspace"
        label="调整简历与分析区域大小" defaultSize={61} minPrimary={320} minSecondary={300} stackAt={760}>
        <ResumePane key={`${activeInterviewId}:${resumeFile?.id || resumeFile?.name || "empty"}`}
          file={resumeFile} notes={resumeNotes} previewError={resumePreviewError}
          replacing={resumeReplacing} canReplace={canSwitchInterview} onReplace={handleActiveResumeReplacement}
          onUpsertNote={saveResumeAnnotation} onDeleteNote={deleteResumeAnnotation} onRetryNotes={retryResumeAnnotations}
          saveState={annotationSaveStates[activeApplication.id] || "saved"} />

        <SplitPane id="assistant-panels" preferenceKey="assistSplit" className="assist-pane" direction="vertical"
          label="调整 AI 追问与实时转录高度" defaultSize={54} minPrimary={150} minSecondary={150}>
          <section className={`cards pane ${focusedPanel === "analysis" ? "panel-focus-mode" : ""}`}>
            <PanelTitle icon={<WandSparkles size={18} />} title="AI 追问">
              <button
                className="followup-action"
                disabled={!currentSegmentText.trim() || currentSegmentPending}
                onClick={processNow}
                title={
                  currentSegmentPending
                    ? "当前片段正在分析"
                    : currentSegmentText.trim()
                      ? "分析最新转录"
                      : "暂无新转录"
                }
              >
                <WandSparkles size={15} />
                <span className="tool-label">{currentSegmentPending ? "分析中" : "立即追问"}</span>
              </button>
              <button className="icon-button" onClick={() => setFocusedPanel((value) => value === "analysis" ? "" : "analysis")}
                aria-label={focusedPanel === "analysis" ? "退出追问专注模式" : "最大化 AI 追问"} title={focusedPanel === "analysis" ? "退出追问专注模式" : "最大化 AI 追问"}>
                {focusedPanel === "analysis" ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
            </PanelTitle>
            <AnalysisCardList cards={cards} onRetry={handleRetryCard} />
          </section>

          <TranscriptPanel
            focused={focusedPanel === "transcript"}
            onToggleFocus={() => setFocusedPanel((value) => value === "transcript" ? "" : "transcript")}
            lastProcessedLineCount={lastProcessedLineCount}
            lines={lines}
            onSpeakerLabelChange={handleSpeakerLabelChange}
            onToggleSpeakerEditor={() => setSpeakerEditorOpen((open) => !open)}
            partialTextBridge={partialTextBridge}
            speakerEditorOpen={speakerEditorOpen}
            speakerLabels={speakerLabels}
          />
        </SplitPane>
      </SplitPane>
      </div> : null}
      </div>
    </main>
  );
}

function RoundTimeline({
  activeInterviewId,
  canSwitch,
  onAdd,
  onSelect,
  rounds,
}) {
  return (
    <nav className="round-timeline" aria-label="面试轮次">
      <span className="round-timeline-title">面试轮次</span>
      <div className="round-timeline-track">
        {rounds.map((round, index) => {
          const status = inferRoundStatus(round);
          return (
            <React.Fragment key={round.id}>
              {index ? <span className="round-connector" aria-hidden="true" /> : null}
              <button
                aria-current={round.id === activeInterviewId ? "step" : undefined}
                className={`round-step ${round.id === activeInterviewId ? "selected" : ""}`}
                disabled={!canSwitch}
                onClick={() => onSelect(round.id)}
                title={`${roundLabelFor(round)} · ${status}${round.outcome ? ` · ${round.outcome}` : ""}`}
                type="button"
              >
                <span className={`round-step-dot ${roundStatusTone(status)}`} />
                <span>{roundLabelFor(round)}</span>
                <small>{round.outcome || status}</small>
              </button>
            </React.Fragment>
          );
        })}
      </div>
      <button
        className="round-add-action"
        disabled={!canSwitch}
        onClick={onAdd}
        title="安排下一轮"
        type="button"
      >
        <Plus size={15} />
        下一轮
      </button>
    </nav>
  );
}

function analyzeJobPlaceholder(job) {
  if (job.status === "retrying") {
    return `网络不稳定，正在重试...（${job.attempts}/${job.maxAttempts}）`;
  }
  if (job.status === "running") {
    return `正在分析...（${job.attempts || 1}/${job.maxAttempts || 3}）`;
  }
  return "等待分析...";
}

function loadInterviewStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (parsed?.interviews?.length && parsed?.activeInterviewId) {
      return normalizeStore(parsed);
    }
  } catch {
    // Ignore broken local data and start fresh.
  }
  return {
    activeInterviewId: "",
    activeApplicationId: "",
    applications: [],
    interviews: [],
    jdLibrary: [],
    statusColors: {},
    statusOptions: [...DEFAULT_INTERVIEW_STATUSES],
  };
}

function extractMarkdownTitle(markdown) {
  const heading = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^#{1,3}\s+/.test(line));
  if (heading) return heading.replace(/^#{1,3}\s+/, "").slice(0, 36);
  return markdown.split(/\r?\n/).find(Boolean)?.trim().slice(0, 36) || "";
}

async function syncInterviewToSystemCalendar(interview) {
  try {
    return await requestJson(
      `/api/interviews/${encodeURIComponent(interview.id)}/calendar-import`,
      { method: "POST" },
    );
  } catch {
    downloadInterviewCalendar(interview);
    return { ok: true, action: "downloaded" };
  }
}

function downloadInterviewCalendar(interview) {
  const blob = new Blob([buildInterviewIcs(interview)], {
    type: "text/calendar;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = calendarExportFilename(interview);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function loadAudioSourceMode() {
  const mode = readUiPreferences().audioSourceMode;
  return mode === AUDIO_SOURCE_MEETING ? AUDIO_SOURCE_MEETING : AUDIO_SOURCE_MICROPHONE;
}

function saveAudioSourceMode(audioSourceMode) {
  saveUiPreferences({ audioSourceMode });
}

function toDatetimeLocalValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function fromDatetimeLocalValue(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function summarizeCard(markdown) {
  return markdown
    .replace(/[#>*_`-]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join("；")
    .slice(0, 220);
}

function sanitizeFilename(value) {
  return value.replace(/[\\/:*?"<>|]/g, "_").trim() || "面试记录";
}

function statusLabel(status, paused) {
  if (paused) return "已暂停";
  const map = {
    idle: "未开始",
    connecting: "连接中",
    recording: "转录中",
    reconnecting: "重连中",
    stopped: "已结束",
    error: "异常",
  };
  return map[status] || status;
}

const rootElement = document.getElementById("root");
globalThis.__interviewWorkbenchRoot ||= createRoot(rootElement);
globalThis.__interviewWorkbenchRoot.render(<App />);
