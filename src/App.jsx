import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BriefcaseBusiness,
  CalendarClock,
  Download,
  Ellipsis,
  FileText,
  ListFilter,
  Maximize2,
  Minimize2,
  MonitorSpeaker,
  MousePointer2,
  Mic,
  Pause,
  Pencil,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Settings,
  Square,
  StickyNote,
  X,
  Trash2,
  Upload,
  WandSparkles,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import "./styles.css";
import { SessionLibraryDialog } from "./components/SessionLibraryDialog.jsx";
import { PanelTitle, StatusPill } from "./components/WorkbenchPrimitives.jsx";
import { TranscriptPanel } from "./components/TranscriptPanel.jsx";
import { AnalysisCardList, isPendingAnalyzeCard } from "./components/AnalysisCardList.jsx";
import { InterviewFormDialog } from "./components/dialogs/InterviewFormDialog.jsx";
import {
  ProviderSettingsDialog,
  createProviderSettingsDraft,
} from "./components/dialogs/ProviderSettingsDialog.jsx";
import { ResumeDocument } from "./components/resume/ResumeDocument.jsx";
import {
  formatShortDateTime,
  inferInterviewStatus,
  interviewStatusTone,
  normalizeStatusLabel,
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
  clearLegacyInterviewStore,
  createInterview,
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
  formatFileSize,
  isPdfFile,
  isWordFile,
  serializeResumeFile,
} from "./lib/resume-files.js";
import { clampNumber } from "./lib/format.js";

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

const UI_PREF_KEY = "interview-workbench.ui.v1";

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
  const [markMode, setMarkMode] = useState(false);
  const [noteDraft, setNoteDraft] = useState(null);
  const [selectedNoteId, setSelectedNoteId] = useState("");
  const [resumeZoom, setResumeZoom] = useState(1);
  const [resumeFocusMode, setResumeFocusMode] = useState(false);
  const [resumePreviewError, setResumePreviewError] = useState("");
  const [resumeReplacing, setResumeReplacing] = useState(false);
  const [notesView, setNotesView] = useState("hidden");
  const [workspaceSplit, setWorkspaceSplit] = useState(loadWorkspaceSplit);
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
  const resumeScrollerRef = useRef(null);
  const resumeReplaceInputRef = useRef(null);
  const workspaceRef = useRef(null);
  const workspaceResizeRef = useRef(null);
  const captureAttemptRef = useRef("");
  const metadataPersistTimersRef = useRef(new Map());
  const retryAnalysisCardRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);

  const activeInterview = useMemo(() => {
    return (
      store.interviews.find((interview) => interview.id === store.activeInterviewId) ||
      store.interviews[0]
    );
  }, [store]);
  const statusOptions = useMemo(
    () => mergeStatusOptions(store.statusOptions, store.interviews),
    [store.interviews, store.statusOptions],
  );

  const {
    id: activeInterviewId,
    name: interviewName,
    resumeMarkdown,
    roleMarkdown,
    resumeFile,
    resumeNotes: savedResumeNotes,
    jdDraftName,
    interviewStatus,
    scheduledAt,
    sessionStartedAt,
    lines,
    cards,
    askedQuestions,
    lastProcessedLineCount,
    speakerLabels,
  } = activeInterview;
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
    setMarkMode(false);
    setNoteDraft(null);
    setSelectedNoteId("");
    setSpeakerEditorOpen(false);
    setStatusPickerOpen(false);
    setCustomStatusDraft("");
    setResumeZoom(1);
    setResumeFocusMode(false);
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
      if (resumeFocusMode) setResumeFocusMode(false);
      if (notesView === "focus") setNotesView("sidebar");
    }

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [notesView, resumeFocusMode]);

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
      loadRemoteInterviewStore()
        .then((remoteStore) => {
          if (remoteStore) {
            setStore((current) =>
              withLocalTranscripts(
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

  const canSwitchInterview =
    status === "idle" || status === "stopped" || status === "error";
  const canMarkResume = Boolean(
    resumeFile &&
      (isPdfFile(resumeFile) || (isWordFile(resumeFile) && resumeFile.previewText)),
  );
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
      const interviews = prev.interviews.map((interview) => {
        if (interview.id !== prev.activeInterviewId) return interview;
        const patch = typeof updater === "function" ? updater(interview) : updater;
        changedInterview = { ...interview, ...patch, updatedAt };
        return changedInterview;
      });
      if (changedInterview) scheduleInterviewMetadataPersist(changedInterview);
      return {
        ...prev,
        interviews,
      };
    });
  }

  function scheduleInterviewMetadataPersist(interview) {
    const existing = metadataPersistTimersRef.current.get(interview.id);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(async () => {
      metadataPersistTimersRef.current.delete(interview.id);
      try {
        await requestJson(`/api/interviews/${encodeURIComponent(interview.id)}`, {
          method: "PATCH",
          body: JSON.stringify(interviewMetadataPatch(interview)),
        });
        setPersistError("");
      } catch {
        setPersistError("场次保存失败，请先导出 Markdown 兜底");
      }
    }, 350);
    metadataPersistTimersRef.current.set(interview.id, timer);
  }

  function applyActiveInterviewStatus(value) {
    const nextStatus = normalizeStatusLabel(value);
    if (!nextStatus) return;
    setStore((prev) => {
      const updatedAt = new Date().toISOString();
      return {
        ...prev,
        statusOptions: mergeStatusOptions(prev.statusOptions, [nextStatus], prev.interviews),
        interviews: prev.interviews.map((interview) =>
          interview.id === prev.activeInterviewId
            ? { ...interview, interviewStatus: nextStatus, updatedAt }
            : interview,
        ),
      };
    });
    setCustomStatusDraft("");
    setStatusPickerOpen(false);
    requestJson(`/api/interviews/${encodeURIComponent(activeInterviewId)}`, {
      method: "PATCH",
      body: JSON.stringify({ interviewStatus: nextStatus }),
    }).catch(() => setPersistError("面试状态保存失败"));
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
    if (!canSwitchInterview) return;
    setError("");
    setSessionMenuOpen(false);
    const source = mode === "edit" ? activeInterview : null;
    setInterviewForm({
      mode,
      name: source?.name === "未命名面试" ? "" : source?.name || "",
      interviewStatus: source?.interviewStatus || "未面",
      scheduledAt: toDatetimeLocalValue(source?.scheduledAt),
      selectedJdId: source?.selectedJdId || "",
      jdDraftName: source?.jdDraftName || "",
      roleMarkdown: source?.roleMarkdown || "",
      resumeMarkdown: source?.resumeMarkdown || "",
      resumeFile: source?.resumeFile || null,
      resumeFileChanged: false,
      saveJdToLibrary: false,
    });
  }

  function patchInterviewForm(patch) {
    setInterviewForm((current) => (current ? { ...current, ...patch } : current));
  }

  function selectFormJd(jdId) {
    if (!jdId) {
      patchInterviewForm({ selectedJdId: "", jdDraftName: "", roleMarkdown: "" });
      return;
    }
    const savedJd = store.jdLibrary.find((item) => item.id === jdId);
    if (!savedJd) return;
    patchInterviewForm({
      selectedJdId: savedJd.id,
      jdDraftName: savedJd.name,
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
          withLocalTranscripts({ ...remoteStore, activeInterviewId }, current),
        );
      }
      setMarkMode(false);
      setNoteDraft(null);
      setSelectedNoteId("");
      setNotesView("hidden");
      setResumePreviewError("");
      setPersistError("");
    } catch (replacementError) {
      setError(replacementError.message || "更换简历失败");
    } finally {
      setResumeReplacing(false);
    }
  }

  async function submitInterviewForm() {
    if (!interviewForm || !canSwitchInterview) return;
    if (interviewFormSubmitLockRef.current) return;
    const name = interviewForm.name.trim();
    if (!name) {
      setError("请填写候选人姓名");
      return;
    }
    const interviewStatusValue = normalizeStatusLabel(interviewForm.interviewStatus);
    if (!interviewStatusValue) {
      setError("请填写面试状态");
      return;
    }

    const roleMarkdownValue = interviewForm.roleMarkdown.trim();
    const jdName =
      interviewForm.jdDraftName.trim() ||
      extractMarkdownTitle(roleMarkdownValue) ||
      "";
    let nextJdId = interviewForm.selectedJdId || "";
    setError("");
    interviewFormSubmitLockRef.current = true;
    setInterviewFormSubmitting(true);
    try {
      if (interviewForm.saveJdToLibrary && roleMarkdownValue) {
        const existing = nextJdId
          ? store.jdLibrary.find((item) => item.id === nextJdId)
          : null;
        const { jd } = await requestJson("/api/jds", {
          method: "POST",
          body: JSON.stringify({
            id: existing?.id || safeId(),
            name: jdName || existing?.name || `JD ${store.jdLibrary.length + 1}`,
            content: roleMarkdownValue,
            createdAt: existing?.createdAt,
          }),
        });
        nextJdId = jd.id;
      }

      const patch = {
        name,
        interviewStatus: interviewStatusValue,
        scheduledAt: fromDatetimeLocalValue(interviewForm.scheduledAt),
        selectedJdId: nextJdId,
        jdDraftName: jdName,
        roleMarkdown: roleMarkdownValue,
        resumeMarkdown: interviewForm.resumeMarkdown,
        ...(interviewForm.resumeFileChanged ? { resumeNotes: [] } : {}),
      };

      let nextActiveId = activeInterviewId;
      if (interviewForm.mode === "create") {
        const data = await requestJson("/api/interviews", {
          method: "POST",
          body: JSON.stringify({ ...patch, resumeFile: interviewForm.resumeFile, activate: true }),
        });
        nextActiveId = data.interview.id;
      } else {
        await requestJson(`/api/interviews/${encodeURIComponent(activeInterviewId)}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
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

      const remoteStore = await loadRemoteInterviewStore();
      if (remoteStore) {
        setStore((current) =>
          withLocalTranscripts({ ...remoteStore, activeInterviewId: nextActiveId }, current),
        );
      }
      partialTextBridge.set("");
      setInterviewForm(null);
      setPersistError("");
    } catch (err) {
      setError(err.message || "保存面试失败");
    } finally {
      interviewFormSubmitLockRef.current = false;
      setInterviewFormSubmitting(false);
    }
  }

  async function deleteActiveInterview() {
    if (!canSwitchInterview) return;
    if (!window.confirm(`确认删除“${interviewName || "未命名面试"}”？此操作会移入本机回收状态。`)) {
      return;
    }
    partialTextBridge.set("");
    setError("");
    setSessionMenuOpen(false);
    try {
      await requestJson(`/api/interviews/${encodeURIComponent(activeInterviewId)}`, {
        method: "DELETE",
      });
      if (store.interviews.length <= 1) {
        await requestJson("/api/interviews", {
          method: "POST",
          body: JSON.stringify({ name: "未命名面试", interviewStatus: "未面" }),
        });
      }
      const remoteStore = await loadRemoteInterviewStore();
      if (remoteStore) {
        setStore((current) => withLocalTranscripts(remoteStore, current));
      }
    } catch (err) {
      setError(err.message || "删除面试失败");
    }
  }

  function handleResumeMark(event, anchor = {}) {
    if (!markMode) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.min(0.98, Math.max(0.02, (event.clientX - rect.left) / rect.width));
    const y = Math.min(0.98, Math.max(0.02, (event.clientY - rect.top) / rect.height));
    setNoteDraft({
      id: safeId(),
      x,
      y,
      text: "",
      coordinateMode: anchor.coordinateMode || "document",
      pageNumber: anchor.pageNumber || null,
    });
  }

  function saveResumeNote() {
    const text = noteDraft?.text?.trim();
    if (!text) {
      setError("备注内容为空");
      return;
    }
    setError("");
    updateActiveInterview((interview) => ({
      resumeNotes: [
        {
          ...noteDraft,
          text,
          createdAt: new Date().toISOString(),
        },
        ...(interview.resumeNotes || []),
      ],
    }));
    setSelectedNoteId(noteDraft.id);
    setNoteDraft(null);
    setMarkMode(false);
    setNotesView("sidebar");
  }

  function deleteResumeNote(noteId) {
    updateActiveInterview((interview) => ({
      resumeNotes: (interview.resumeNotes || []).filter((note) => note.id !== noteId),
    }));
    if (selectedNoteId === noteId) setSelectedNoteId("");
  }

  function focusResumeNote(note) {
    setSelectedNoteId(note.id);
    if (notesView === "focus") setNotesView("sidebar");
    const scroller = resumeScrollerRef.current;
    if (!scroller) return;
    window.requestAnimationFrame(() => {
      const marker = Array.from(
        scroller.querySelectorAll("[data-resume-note-id]"),
      ).find((element) => element.dataset.resumeNoteId === note.id);
      if (marker) {
        marker.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
        return;
      }
      const targetTop = note.y * scroller.scrollHeight - scroller.clientHeight / 2;
      scroller.scrollTo({
        top: Math.max(0, Math.min(targetTop, scroller.scrollHeight - scroller.clientHeight)),
        behavior: "smooth",
      });
    });
  }

  function changeResumeZoom(delta) {
    setResumeZoom((current) => clampNumber(Number((current + delta).toFixed(1)), 0.5, 2));
  }

  function startWorkspaceResize(event) {
    const workspace = workspaceRef.current;
    if (!workspace || window.innerWidth <= 900) return;
    const rect = workspace.getBoundingClientRect();
    event.preventDefault();
    const resize = { rect, nextSplit: workspaceSplit };
    workspaceResizeRef.current = resize;
    document.body.classList.add("workspace-resizing");

    function moveWorkspaceResize(pointerEvent) {
      if (workspaceResizeRef.current !== resize) return;
      const usableWidth = Math.max(1, resize.rect.width - 8);
      const minLeft = Math.min(520, usableWidth * 0.48);
      const minRight = Math.min(420, usableWidth * 0.4);
      const leftWidth = clampNumber(
        pointerEvent.clientX - resize.rect.left,
        minLeft,
        Math.max(minLeft, usableWidth - minRight),
      );
      resize.nextSplit = (leftWidth / usableWidth) * 100;
      workspace.style.setProperty("--resume-pane-width", `${resize.nextSplit}%`);
    }

    function endWorkspaceResize() {
      if (workspaceResizeRef.current !== resize) return;
      workspaceResizeRef.current = null;
      document.body.classList.remove("workspace-resizing");
      window.removeEventListener("pointermove", moveWorkspaceResize);
      window.removeEventListener("pointerup", endWorkspaceResize);
      window.removeEventListener("pointercancel", endWorkspaceResize);
      setWorkspaceSplit(resize.nextSplit);
      saveWorkspaceSplit(resize.nextSplit);
    }

    window.addEventListener("pointermove", moveWorkspaceResize);
    window.addEventListener("pointerup", endWorkspaceResize);
    window.addEventListener("pointercancel", endWorkspaceResize);
  }

  async function startInterview() {
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
        interviewStatus: "面试中",
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
    updateActiveInterview((interview) => ({
      interviewStatus:
        interview.interviewStatus === "面试中"
          ? "已面待定"
          : interview.interviewStatus || inferInterviewStatus(interview),
    }));
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
      `面试状态：${interviewStatus || "未面"}`,
      `计划面试时间：${formatDateTime(scheduledAt) || "未设置"}`,
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
    anchor.download = `${sanitizeFilename(interviewName || "面试记录")}-${new Date()
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
      <header className="topbar">
        <div className="brand">
          <Radio size={21} />
          <div>
            <h1>面试工作台</h1>
            <p>{statusLabel(status, isPaused)}</p>
          </div>
        </div>

        <section className="active-session-summary" aria-label="当前场次">
          <div className="active-session-name">{interviewName || "未命名面试"}</div>
          <div className="active-session-meta">
            <span className="session-role">
              <BriefcaseBusiness size={14} />
              {jdDraftName || "未设置岗位"}
            </span>
            <div className="status-picker">
              <button
                className={`session-status status-picker-trigger ${interviewStatusTone(
                  interviewStatus,
                )}`}
                disabled={!canSwitchInterview}
                onClick={() => setStatusPickerOpen((open) => !open)}
                title="修改面试状态"
              >
                {interviewStatus || "未面"}
              </button>
              {statusPickerOpen ? (
                <div className="status-picker-popover">
                  <div className="status-picker-options">
                    {statusOptions.map((statusOption) => (
                      <button
                        className={`session-status ${interviewStatusTone(statusOption)} ${
                          statusOption === interviewStatus ? "selected" : ""
                        }`}
                        key={statusOption}
                        onClick={() => applyActiveInterviewStatus(statusOption)}
                        type="button"
                      >
                        {statusOption}
                      </button>
                    ))}
                  </div>
                  <form
                    className="status-picker-custom"
                    onSubmit={(event) => {
                      event.preventDefault();
                      applyActiveInterviewStatus(customStatusDraft);
                    }}
                  >
                    <input
                      aria-label="自定义面试状态"
                      maxLength={24}
                      onChange={(event) => setCustomStatusDraft(event.target.value)}
                      placeholder="自定义状态"
                      value={customStatusDraft}
                    />
                    <button
                      aria-label="添加自定义状态"
                      className="icon-button"
                      disabled={!customStatusDraft.trim()}
                      title="添加并使用"
                      type="submit"
                    >
                      <Plus size={15} />
                    </button>
                  </form>
                </div>
              ) : null}
            </div>
            <span className="session-time">
              <CalendarClock size={14} />
              {formatShortDateTime(scheduledAt) || "未安排时间"}
            </span>
          </div>
        </section>

        <div className="management-actions">
          <StatusPill health={health} />
          <button
            disabled={!canSwitchInterview}
            onClick={openProviderSettings}
            title="配置语音识别和大模型"
          >
            <Settings size={17} />
            配置
          </button>
          <button
            disabled={!canSwitchInterview}
            onClick={() => setSessionLibraryOpen(true)}
            title="浏览和筛选场次"
          >
            <ListFilter size={17} />
            场次库
          </button>
          <button
            className="primary"
            disabled={!canSwitchInterview}
            onClick={() => openInterviewForm("create")}
            title="新建面试"
          >
            <Plus size={17} />
            新建
          </button>
          <div className="session-menu">
            <button
              className="icon-button"
              disabled={!canSwitchInterview}
              onClick={() => setSessionMenuOpen((open) => !open)}
              title="当前场次操作"
              aria-label="当前场次操作"
            >
              <Ellipsis size={19} />
            </button>
            {sessionMenuOpen ? (
              <div className="session-menu-popover">
                <button onClick={() => openInterviewForm("edit")}>
                  <Pencil size={16} />
                  编辑资料
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
                <button className="danger-action" onClick={deleteActiveInterview}>
                  <Trash2 size={16} />
                  删除场次
                </button>
              </div>
            ) : null}
          </div>
          <div className="audio-source-segmented" aria-label="收音方式" role="group">
            <button
              aria-pressed={audioSourceMode === AUDIO_SOURCE_MICROPHONE}
              className={audioSourceMode === AUDIO_SOURCE_MICROPHONE ? "selected" : ""}
              disabled={!canSwitchInterview}
              onClick={() => {
                setAudioSourceMode(AUDIO_SOURCE_MICROPHONE);
                saveAudioSourceMode(AUDIO_SOURCE_MICROPHONE);
              }}
              title="只采集当前麦克风"
              type="button"
            >
              <Mic size={15} />
              麦克风
            </button>
            <button
              aria-pressed={audioSourceMode === AUDIO_SOURCE_MEETING}
              className={audioSourceMode === AUDIO_SOURCE_MEETING ? "selected" : ""}
              disabled={!canSwitchInterview}
              onClick={() => {
                setAudioSourceMode(AUDIO_SOURCE_MEETING);
                saveAudioSourceMode(AUDIO_SOURCE_MEETING);
              }}
              title="同时采集麦克风和腾讯会议等桌面应用声音"
              type="button"
            >
              <MonitorSpeaker size={15} />
              会议声音
            </button>
          </div>
          <span className="toolbar-separator" />
          {status === "idle" || status === "stopped" || status === "error" ? (
            <button className="primary" onClick={startInterview} title="开始面试">
              <Play size={17} />
              开始
            </button>
          ) : (
            <>
              <button onClick={pauseInterview} title={isPaused ? "继续" : "暂停"}>
                {isPaused ? <Play size={17} /> : <Pause size={17} />}
                {isPaused ? "继续" : "暂停"}
              </button>
              <button onClick={stopInterview} title="结束面试">
                <Square size={16} />
                结束
              </button>
            </>
          )}
        </div>
      </header>

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
          <button disabled={!canSwitchInterview} onClick={openProviderSettings}>
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
          interviews={store.interviews}
          onClose={() => setSessionLibraryOpen(false)}
          onSelect={switchInterview}
          statusOptions={statusOptions}
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

      <section
        className="workspace interview-workspace"
        ref={workspaceRef}
        style={{ "--resume-pane-width": `${workspaceSplit}%` }}
      >
        <section className={`resume-pane pane ${resumeFocusMode ? "resume-focus-mode" : ""}`}>
          <PanelTitle icon={<FileText size={18} />} title="简历预览">
            <input
              accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className="file-input"
              onChange={handleActiveResumeReplacement}
              ref={resumeReplaceInputRef}
              type="file"
            />
            <button
              className="resume-replace-action"
              disabled={!canSwitchInterview || resumeReplacing}
              onClick={() => resumeReplaceInputRef.current?.click()}
              title={resumeFile ? "更换当前简历附件" : "添加简历附件"}
              type="button"
            >
              <RefreshCw size={15} />
              {resumeReplacing ? "处理中" : resumeFile ? "更换" : "添加"}
            </button>
            <button
              className={`resume-mark-action ${markMode ? "active" : ""}`}
              disabled={!canMarkResume}
              onClick={() => {
                setNoteDraft(null);
                setMarkMode((value) => !value);
              }}
              title="在简历上标记备注位置"
            >
              <MousePointer2 size={16} />
              {markMode ? "点击位置" : "标记"}
            </button>
            <button
              className={`icon-button notes-toggle ${notesView !== "hidden" ? "selected-control" : ""}`}
              disabled={!resumeFile}
              onClick={() => setNotesView((view) => (view === "hidden" ? "sidebar" : "hidden"))}
              title="查看简历备注"
              aria-label="查看简历备注"
            >
              <StickyNote size={16} />
              {resumeNotes.length ? <span className="control-badge">{resumeNotes.length}</span> : null}
            </button>
            <span className="toolbar-separator" />
            <button
              className="icon-button"
              disabled={!resumeFile || resumeZoom <= 0.5}
              onClick={() => changeResumeZoom(-0.1)}
              title="缩小简历"
              aria-label="缩小简历"
            >
              <ZoomOut size={16} />
            </button>
            <button
              className="zoom-value"
              disabled={!resumeFile}
              onClick={() => setResumeZoom(1)}
              title="恢复适合宽度"
            >
              {Math.round(resumeZoom * 100)}%
            </button>
            <button
              className="icon-button"
              disabled={!resumeFile || resumeZoom >= 2}
              onClick={() => changeResumeZoom(0.1)}
              title="放大简历"
              aria-label="放大简历"
            >
              <ZoomIn size={16} />
            </button>
            <button
              className="icon-button"
              disabled={!resumeFile}
              onClick={() => setResumeFocusMode((focused) => !focused)}
              title={resumeFocusMode ? "退出简历专注模式" : "最大化简历"}
              aria-label={resumeFocusMode ? "退出简历专注模式" : "最大化简历"}
            >
              {resumeFocusMode ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
          </PanelTitle>

          <div className={`resume-preview-wrap notes-${notesView}`}>
            <div className="resume-document-area">
              {resumeFile ? (
                <div className="resume-filebar">
                  <span>{resumeFile.name}</span>
                  <span>{formatFileSize(resumeFile.size)}</span>
                </div>
              ) : null}

              <div className="resume-preview-surface">
                <div className="resume-preview-scroller" ref={resumeScrollerRef}>
                  {resumeFile ? (
                    <ResumeDocument
                      file={resumeFile}
                      markMode={markMode}
                      noteDraft={noteDraft}
                      notes={resumeNotes}
                      onCancelDraft={() => setNoteDraft(null)}
                      onDraftChange={(text) =>
                        setNoteDraft((draft) => (draft ? { ...draft, text } : draft))
                      }
                      onFocusNote={focusResumeNote}
                      onMark={handleResumeMark}
                      onSaveDraft={saveResumeNote}
                      selectedNoteId={selectedNoteId}
                      previewError={resumePreviewError}
                      zoom={resumeZoom}
                    />
                  ) : (
                    <div className="resume-empty">
                      <FileText size={30} />
                      <p>请在编辑资料中添加 PDF 或 Word 简历。</p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {notesView !== "hidden" ? <aside className="resume-notes-list">
              <div className="resume-notes-head">
                <div>
                  <StickyNote size={15} />
                  <span>简历备注</span>
                  <span className="notes-count">{resumeNotes.length}</span>
                </div>
                <div className="resume-notes-actions">
                  <button
                    className="icon-button"
                    onClick={() => setNotesView((view) => (view === "focus" ? "sidebar" : "focus"))}
                    title={notesView === "focus" ? "恢复文档与备注" : "最大化备注"}
                    aria-label={notesView === "focus" ? "恢复文档与备注" : "最大化备注"}
                  >
                    {notesView === "focus" ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                  </button>
                  <button
                    className="icon-button"
                    onClick={() => setNotesView("hidden")}
                    title="关闭备注"
                    aria-label="关闭备注"
                  >
                    <X size={15} />
                  </button>
                </div>
              </div>
              {resumeNotes.length ? (
                resumeNotes.map((note) => (
                  <div
                    className={`resume-note-item ${
                      selectedNoteId === note.id ? "selected" : ""
                    }`}
                    key={note.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => focusResumeNote(note)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        focusResumeNote(note);
                      }
                    }}
                  >
                    <StickyNote size={15} />
                    <div className="resume-note-body">
                      <p>{note.text}</p>
                      <span>
                        {formatResumeNoteLocation(note)}
                      </span>
                    </div>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteResumeNote(note.id);
                      }}
                      title="删除备注"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))
              ) : (
                <div className="notes-empty">暂无备注</div>
              )}
            </aside> : null}
          </div>
        </section>

        <div
          className="workspace-splitter"
          role="separator"
          aria-label="调整简历与分析区域宽度"
          aria-orientation="vertical"
          onPointerDown={startWorkspaceResize}
        >
          <span />
        </div>

        <section className="assist-pane">
          <section className="cards pane">
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
                立即追问
              </button>
            </PanelTitle>
            <AnalysisCardList cards={cards} onRetry={handleRetryCard} />
          </section>

          <TranscriptPanel
            lastProcessedLineCount={lastProcessedLineCount}
            lines={lines}
            onSpeakerLabelChange={handleSpeakerLabelChange}
            onToggleSpeakerEditor={() => setSpeakerEditorOpen((open) => !open)}
            partialTextBridge={partialTextBridge}
            speakerEditorOpen={speakerEditorOpen}
            speakerLabels={speakerLabels}
          />
        </section>
      </section>
    </main>
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
  const interview = createInterview("未命名面试");
  return {
    activeInterviewId: interview.id,
    interviews: [interview],
    jdLibrary: [],
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

function formatResumeNoteLocation(note) {
  if (note.coordinateMode === "page" && note.pageNumber) {
    return `第 ${note.pageNumber} 页 · 纵向 ${Math.round(note.y * 100)}%`;
  }
  if (note.coordinateMode === "document") {
    return `文档位置 · ${Math.round(note.y * 100)}%`;
  }
  return `原位置 · ${Math.round(note.y * 100)}%`;
}

function loadWorkspaceSplit() {
  const preferences = readUiPreferences();
  return clampNumber(Number(preferences.workspaceSplit) || 56, 38, 72);
}

function saveWorkspaceSplit(workspaceSplit) {
  saveUiPreferences({ workspaceSplit: clampNumber(workspaceSplit, 38, 72) });
}

function loadAudioSourceMode() {
  const mode = readUiPreferences().audioSourceMode;
  return mode === AUDIO_SOURCE_MEETING ? AUDIO_SOURCE_MEETING : AUDIO_SOURCE_MICROPHONE;
}

function saveAudioSourceMode(audioSourceMode) {
  saveUiPreferences({ audioSourceMode });
}

function readUiPreferences() {
  try {
    return JSON.parse(localStorage.getItem(UI_PREF_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function saveUiPreferences(patch) {
  try {
    localStorage.setItem(UI_PREF_KEY, JSON.stringify({ ...readUiPreferences(), ...patch }));
  } catch {
    // UI preferences are optional and do not affect interview data.
  }
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
