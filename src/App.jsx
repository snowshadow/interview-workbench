import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import ReactMarkdown from "react-markdown";
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
  RotateCcw,
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
import { PanelTitle, StatusPill, TranscriptLine } from "./components/WorkbenchPrimitives.jsx";
import {
  formatShortDateTime,
  inferInterviewStatus,
  interviewStatusTone,
} from "./interview-domain.js";
import {
  ApiError,
  apiFetch,
  createAsrWebSocket,
  getApiHeaders,
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

const SAMPLE_RATE = 16000;
const CHUNK_MS = 200;
const CHUNK_SAMPLES = (SAMPLE_RATE * CHUNK_MS) / 1000;
const STORE_KEY = "interview-workbench.sessions.v1";
const UI_PREF_KEY = "interview-workbench.ui.v1";
const MAX_RESUME_FILE_SIZE = 4 * 1024 * 1024;
const DEFAULT_INTERVIEW_STATUSES = [
  "未面",
  "已安排",
  "面试中",
  "已面待定",
  "一面通过",
  "未通过",
  "放弃/归档",
];

function App() {
  const [store, setStore] = useState(loadInterviewStore);
  const [storeReady, setStoreReady] = useState(false);
  const [persistError, setPersistError] = useState("");
  const [health, setHealth] = useState(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [accessTokenDraft, setAccessTokenDraft] = useState("");
  const [status, setStatus] = useState("idle");
  const [isPaused, setIsPaused] = useState(false);
  const [partialText, setPartialText] = useState("");
  const [error, setError] = useState("");
  const [sessionLibraryOpen, setSessionLibraryOpen] = useState(false);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [interviewForm, setInterviewForm] = useState(null);
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
  const partialTextRef = useRef(partialText);
  const runIdRef = useRef("");
  const resumeScrollerRef = useRef(null);
  const resumeReplaceInputRef = useRef(null);
  const workspaceRef = useRef(null);
  const workspaceResizeRef = useRef(null);
  const captureAttemptRef = useRef("");
  const metadataPersistTimersRef = useRef(new Map());

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
    partialTextRef.current = partialText;
  }, [partialText]);

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
          if (remoteStore) setStore(remoteStore);
        })
        .catch(() => {});
    }

    window.addEventListener("focus", refreshStoreOnFocus);
    return () => window.removeEventListener("focus", refreshStoreOnFocus);
  }, [storeReady]);

  useEffect(() => {
    refreshHealth();
  }, []);

  const seenSpeakers = useMemo(() => {
    return Array.from(new Set(lines.map((line) => line.speaker).filter(Boolean)));
  }, [lines]);

  const transcriptText = useMemo(() => {
    return lines
      .map((line) => formatLineForPrompt(line, speakerLabels))
      .join("\n")
      .trim();
  }, [lines, speakerLabels]);

  const currentSegmentText = useMemo(() => {
    const freshLines = lines.slice(lastProcessedLineCount);
    const body = freshLines
      .map((line) => formatLineForPrompt(line, speakerLabels))
      .join("\n")
      .trim();
    if (body) return body;
    return partialText ? `正在识别：${partialText}` : "";
  }, [lastProcessedLineCount, lines, partialText, speakerLabels]);
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
    setPartialText("");
    setError("");
    setIsPaused(false);
    setSessionLibraryOpen(false);
    setSessionMenuOpen(false);
    setStore((prev) => ({ ...prev, activeInterviewId: interviewId }));
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
      setStore({ ...remoteStore, activeInterviewId });
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
          body: JSON.stringify({ ...patch, resumeFile: interviewForm.resumeFile }),
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
      setStore({ ...remoteStore, activeInterviewId: nextActiveId });
      setPartialText("");
      setInterviewForm(null);
      setPersistError("");
    } catch (err) {
      setError(err.message || "保存面试失败");
    }
  }

  async function deleteActiveInterview() {
    if (!canSwitchInterview) return;
    if (!window.confirm(`确认删除“${interviewName || "未命名面试"}”？此操作会移入本机回收状态。`)) {
      return;
    }
    setPartialText("");
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
      setStore(remoteStore);
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
    setPartialText("");
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

      const socket = createAsrWebSocket();
      socket.binaryType = "arraybuffer";
      wsRef.current = socket;

      socket.onopen = async () => {
        try {
          if (captureAttemptRef.current !== captureAttemptId) return;
          await startAudioCapture(microphoneStream, displayStream);
          if (captureAttemptRef.current === captureAttemptId) setStatus("recording");
        } catch (captureError) {
          setError(captureError.message || "无法处理音频");
          setStatus("error");
          socket.close();
          stopLocalAudio();
        }
      };
      socket.onmessage = (event) => handleServerMessage(event.data);
      socket.onerror = () => {
        commitPartialTranscript();
        setError("转录连接出错");
        setStatus("error");
        socket.close();
        stopLocalAudio();
      };
      socket.onclose = () => {
        if (statusRef.current !== "stopped") {
          commitPartialTranscript();
          setStatus("stopped");
        }
        stopLocalAudio();
      };
    } catch (err) {
      if (captureAttemptRef.current !== captureAttemptId) return;
      setError(audioCaptureErrorMessage(err, audioSourceMode));
      setStatus("error");
      stopLocalAudio();
    }
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
      setPartialText("");
    } else if (partial?.text) {
      setPartialText(partial.text);
    } else if (message.text) {
      setPartialText(message.text);
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
    wsRef.current?.send(JSON.stringify({ type: "stop" }));
    wsRef.current?.close();
    stopLocalAudio();
  }

  function stopLocalAudio() {
    captureAttemptRef.current = "";
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

  function commitPartialTranscript() {
    const text = partialTextRef.current.trim();
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
    setPartialText("");
  }

  async function processNow() {
    const transcriptSlice = currentSegmentText.trim();
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
            <div className="cards-list">
              {cards.length === 0 ? <div className="empty">等待第一次处理</div> : null}
              {cards.map((card) => (
                <article
                  className={`ai-card ${
                    isPendingAnalyzeCard(card) ? "loading" : card.status
                  }`}
                  key={card.id}
                >
                  <div className="card-meta">
                    <span>{new Date(card.createdAt).toLocaleTimeString()}</span>
                    <div>
                      <span>{cardStatusLabel(card)}</span>
                      {card.status === "error" && card.transcriptSlice ? (
                        <button
                          className="card-retry"
                          onClick={() => retryAnalysisCard(card)}
                          title="重新分析这段转录"
                        >
                          <RotateCcw size={13} />
                          重试
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <ReactMarkdown>{card.markdown}</ReactMarkdown>
                </article>
              ))}
            </div>
          </section>

          <section className="transcript pane compact-transcript">
            <PanelTitle icon={<Mic size={18} />} title="实时转录">
              {seenSpeakers.length ? (
                <button
                  className={speakerEditorOpen ? "icon-button primary" : "icon-button"}
                  onClick={() => setSpeakerEditorOpen((open) => !open)}
                  title="编辑说话人名称"
                  aria-label="编辑说话人名称"
                >
                  <Pencil size={16} />
                </button>
              ) : null}
            </PanelTitle>
            {speakerEditorOpen ? (
              <div className="speaker-inline-editor">
                {seenSpeakers.map((speaker) => (
                  <label key={speaker}>
                    <span>说话人 {speaker}</span>
                    <input
                      value={speakerLabels[speaker] || ""}
                      onChange={(event) =>
                        updateActiveInterview((interview) => ({
                          speakerLabels: {
                            ...interview.speakerLabels,
                            [speaker]: event.target.value,
                          },
                        }))
                      }
                      placeholder={`默认显示为说话人 ${speaker}`}
                    />
                  </label>
                ))}
              </div>
            ) : null}
            <div className="transcript-list">
              {lines.length === 0 && !partialText ? (
                <div className="empty">等待转录</div>
              ) : null}
              {partialText ? (
                <div className="line partial">
                  <div className="line-meta">正在识别</div>
                  <div className="line-text">{partialText}</div>
                </div>
              ) : null}
              {lines
                .map((line, index) => ({ line, index }))
                .reverse()
                .map(({ line, index }) => (
                  <TranscriptLine
                    key={line.id}
                    line={line}
                    speakerLabels={speakerLabels}
                    processed={index < lastProcessedLineCount}
                  />
                ))}
            </div>
          </section>
        </section>
      </section>
    </main>
  );
}

function InterviewFormDialog({
  form,
  jdLibrary,
  onChange,
  onClose,
  onResumeFileChange,
  onSelectJd,
  onSubmit,
  statusOptions,
}) {
  const isCreate = form.mode === "create";

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="interview-form-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="dialog-header">
          <div>
            <h2>{isCreate ? "新建面试" : "编辑面试资料"}</h2>
            <p>{isCreate ? "一次填好候选人与面试准备信息" : "修改当前场次的资料与准备内容"}</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="关闭" aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="interview-form-body">
          <section className="form-section">
            <h3>基本信息</h3>
            <div className="form-grid form-grid-basic">
              <label>
                <span>候选人姓名</span>
                <input
                  autoFocus
                  required
                  value={form.name}
                  onChange={(event) => onChange({ name: event.target.value })}
                  placeholder="例如：张宇"
                />
              </label>
              <label>
                <span>面试状态</span>
                <input
                  list="interview-status-options"
                  maxLength={24}
                  placeholder="选择或输入状态"
                  required
                  value={form.interviewStatus}
                  onChange={(event) => onChange({ interviewStatus: event.target.value })}
                />
                <datalist id="interview-status-options">
                  {statusOptions.map((status) => (
                    <option key={status} value={status} />
                  ))}
                </datalist>
              </label>
              <label>
                <span>计划面试时间</span>
                <input
                  type="datetime-local"
                  value={form.scheduledAt}
                  onChange={(event) => onChange({ scheduledAt: event.target.value })}
                />
              </label>
            </div>
          </section>

          <section className="form-section">
            <h3>岗位与 JD</h3>
            <div className="form-grid form-grid-jd">
              <label>
                <span>已保存 JD</span>
                <select value={form.selectedJdId} onChange={(event) => onSelectJd(event.target.value)}>
                  <option value="">新建或不关联 JD</option>
                  {jdLibrary.map((jd) => (
                    <option key={jd.id} value={jd.id}>
                      {jd.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>岗位名称</span>
                <input
                  value={form.jdDraftName}
                  onChange={(event) => onChange({ jdDraftName: event.target.value })}
                  placeholder="例如：大模型应用研发工程师"
                />
              </label>
            </div>
            <label>
              <span>岗位 JD / 能力要求</span>
              <textarea
                value={form.roleMarkdown}
                onChange={(event) => onChange({ roleMarkdown: event.target.value })}
                placeholder="粘贴岗位 JD 或能力要求 Markdown"
              />
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={form.saveJdToLibrary}
                onChange={(event) => onChange({ saveJdToLibrary: event.target.checked })}
              />
              <span>将本次 JD 保存或同步到 JD 库</span>
            </label>
          </section>

          <section className="form-section">
            <h3>候选人准备</h3>
            <div className="resume-upload-field">
              <div>
                <span>简历附件</span>
                <p>
                  {form.resumeFile
                    ? `${form.resumeFile.name} · ${formatFileSize(form.resumeFile.size)}`
                    : "尚未上传"}
                </p>
              </div>
              <div className="resume-upload-actions">
                <input
                  className="file-input"
                  id="interview-form-resume-upload"
                  type="file"
                  accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={onResumeFileChange}
                />
                <label className="file-button" htmlFor="interview-form-resume-upload">
                  <Upload size={16} />
                  {form.resumeFile ? "替换" : "上传"}
                </label>
                {form.resumeFile ? (
                  <button
                    type="button"
                    className="icon-button"
                    title="移除简历"
                    aria-label="移除简历"
                    onClick={() => onChange({ resumeFile: null, resumeFileChanged: true })}
                  >
                    <X size={17} />
                  </button>
                ) : null}
              </div>
            </div>
            <label>
              <span>简历预分析</span>
              <textarea
                value={form.resumeMarkdown}
                onChange={(event) => onChange({ resumeMarkdown: event.target.value })}
                placeholder="粘贴简历预分析 Markdown"
              />
            </label>
          </section>

        </div>

        <div className="dialog-footer">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" type="submit">
            {isCreate ? "创建场次" : "保存修改"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ProviderSettingsDialog({ draft, error, onChange, onClose, onSubmit, saving }) {
  function patchSection(section, patch) {
    onChange((current) => ({
      ...current,
      [section]: { ...current[section], ...patch },
    }));
  }

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <form
        className="provider-settings-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="dialog-header">
          <div>
            <h2>服务配置</h2>
            <p>密钥只保存在本机，不会显示在页面或导出备份中</p>
          </div>
          <button
            aria-label="关闭配置"
            className="icon-button"
            disabled={saving}
            onClick={onClose}
            title="关闭"
            type="button"
          >
            <X size={18} />
          </button>
        </div>

        <div className="provider-settings-body">
          {error ? <div className="settings-error">{error}</div> : null}
          {!draft ? <div className="settings-loading">正在读取配置...</div> : (
            <>
              <section className="form-section provider-section">
                <div className="provider-section-heading">
                  <div>
                    <h3>语音识别</h3>
                    <p>火山引擎流式语音识别</p>
                  </div>
                  <span className={`provider-state ${draft.asr.configured ? "ready" : "warn"}`}>
                    {draft.asr.configured ? "已配置" : "待配置"}
                  </span>
                </div>
                <label>
                  <span>API Key</span>
                  <input
                    autoComplete="new-password"
                    onChange={(event) => patchSection("asr", { apiKey: event.target.value })}
                    placeholder={draft.asr.apiKeyConfigured ? "已配置，留空则不修改" : "请输入火山引擎 API Key"}
                    type="password"
                    value={draft.asr.apiKey}
                  />
                </label>
                {draft.asr.apiKeyStored ? (
                  <label className="checkbox-field settings-clear-field">
                    <input
                      checked={draft.asr.clearApiKey}
                      onChange={(event) => patchSection("asr", { clearApiKey: event.target.checked })}
                      type="checkbox"
                    />
                    <span>删除工作台保存的 API Key</span>
                  </label>
                ) : null}
                <details className="settings-details">
                  <summary>旧版火山引擎凭证</summary>
                  <div className="settings-details-body form-grid form-grid-jd">
                    <label>
                      <span>App Key</span>
                      <input
                        autoComplete="new-password"
                        onChange={(event) => patchSection("asr", { appKey: event.target.value })}
                        placeholder={draft.asr.legacyCredentialsConfigured ? "已配置，留空则不修改" : "可选"}
                        type="password"
                        value={draft.asr.appKey}
                      />
                    </label>
                    <label>
                      <span>Access Key</span>
                      <input
                        autoComplete="new-password"
                        onChange={(event) => patchSection("asr", { accessKey: event.target.value })}
                        placeholder={draft.asr.legacyCredentialsConfigured ? "已配置，留空则不修改" : "可选"}
                        type="password"
                        value={draft.asr.accessKey}
                      />
                    </label>
                  </div>
                  {draft.asr.legacyCredentialsStored ? (
                    <label className="checkbox-field settings-clear-field">
                      <input
                        checked={draft.asr.clearLegacyCredentials}
                        onChange={(event) => patchSection("asr", { clearLegacyCredentials: event.target.checked })}
                        type="checkbox"
                      />
                      <span>删除工作台保存的旧版凭证</span>
                    </label>
                  ) : null}
                </details>
                <details className="settings-details">
                  <summary>高级设置</summary>
                  <div className="settings-details-body">
                    <label>
                      <span>资源 ID</span>
                      <input
                        onChange={(event) => patchSection("asr", { resourceId: event.target.value })}
                        value={draft.asr.resourceId}
                      />
                    </label>
                    <label>
                      <span>WebSocket 地址</span>
                      <input
                        onChange={(event) => patchSection("asr", { url: event.target.value })}
                        value={draft.asr.url}
                      />
                    </label>
                  </div>
                </details>
              </section>

              <section className="form-section provider-section">
                <div className="provider-section-heading">
                  <div>
                    <h3>大模型</h3>
                    <p>DeepSeek 或其他兼容 OpenAI 的服务</p>
                  </div>
                  <span className={`provider-state ${draft.llm.configured ? "ready" : "warn"}`}>
                    {draft.llm.configured ? "已配置" : "待配置"}
                  </span>
                </div>
                <label>
                  <span>API Key</span>
                  <input
                    autoComplete="new-password"
                    onChange={(event) => patchSection("llm", { apiKey: event.target.value })}
                    placeholder={draft.llm.apiKeyConfigured ? "已配置，留空则不修改" : "请输入大模型 API Key"}
                    type="password"
                    value={draft.llm.apiKey}
                  />
                </label>
                {draft.llm.apiKeyStored ? (
                  <label className="checkbox-field settings-clear-field">
                    <input
                      checked={draft.llm.clearApiKey}
                      onChange={(event) => patchSection("llm", { clearApiKey: event.target.checked })}
                      type="checkbox"
                    />
                    <span>删除工作台保存的 API Key</span>
                  </label>
                ) : null}
                <div className="form-grid form-grid-jd settings-model-grid">
                  <label>
                    <span>API 地址</span>
                    <input
                      onChange={(event) => patchSection("llm", { baseUrl: event.target.value })}
                      value={draft.llm.baseUrl}
                    />
                  </label>
                  <label>
                    <span>模型名称</span>
                    <input
                      onChange={(event) => patchSection("llm", { model: event.target.value })}
                      value={draft.llm.model}
                    />
                  </label>
                </div>
                <details className="settings-details">
                  <summary>高级设置</summary>
                  <div className="settings-details-body">
                    <label>
                      <span>请求超时（毫秒）</span>
                      <input
                        max="300000"
                        min="1000"
                        onChange={(event) => patchSection("llm", { timeoutMs: event.target.value })}
                        step="1000"
                        type="number"
                        value={draft.llm.timeoutMs}
                      />
                    </label>
                  </div>
                </details>
              </section>
            </>
          )}
        </div>

        <div className="dialog-footer">
          <button disabled={saving} onClick={onClose} type="button">取消</button>
          <button className="primary" disabled={!draft || saving} type="submit">
            {saving ? "保存中..." : "保存配置"}
          </button>
        </div>
      </form>
    </div>
  );
}

function createProviderSettingsDraft(settings) {
  return {
    asr: {
      ...settings.asr,
      apiKey: "",
      appKey: "",
      accessKey: "",
      clearApiKey: false,
      clearLegacyCredentials: false,
    },
    llm: {
      ...settings.llm,
      apiKey: "",
      clearApiKey: false,
    },
  };
}

function ResumeDocument({
  file,
  markMode,
  noteDraft,
  notes,
  onCancelDraft,
  onDraftChange,
  onFocusNote,
  onMark,
  onSaveDraft,
  previewError,
  selectedNoteId,
  zoom,
}) {
  const markerProps = {
    markMode,
    noteDraft,
    notes,
    onCancelDraft,
    onDraftChange,
    onFocusNote,
    onMark,
    onSaveDraft,
    selectedNoteId,
  };

  if (isPdfFile(file)) {
    return <PdfPreview file={file} markerProps={markerProps} zoom={zoom} />;
  }

  if (isWordFile(file) && file.previewText) {
    return <DocxPreview file={file} markerProps={markerProps} zoom={zoom} />;
  }

  if (isWordFile(file) && !previewError) {
    return (
      <div className="resume-file-placeholder">
        <FileText size={30} />
        <p>{file.name}</p>
        <span>正在生成 Word 预览...</span>
      </div>
    );
  }

  return (
    <div className="resume-file-placeholder">
      <FileText size={30} />
      <p>{file.name}</p>
      <span>{previewError || "文件已保存到当前面试；当前格式先用下载查看。"}</span>
      <a href={resumeFileSource(file)} download={file.name}>
        下载查看
      </a>
    </div>
  );
}

function ResumeMarkerLayer({
  coordinateMode,
  markMode,
  noteDraft,
  notes,
  onCancelDraft,
  onDraftChange,
  onFocusNote,
  onMark,
  onSaveDraft,
  pageNumber = null,
  selectedNoteId,
}) {
  const layerNotes = notes.filter((note) => {
    const noteMode = note.coordinateMode || "content";
    if (noteMode !== coordinateMode) return false;
    return coordinateMode !== "page" || Number(note.pageNumber) === Number(pageNumber);
  });
  const draftVisible =
    noteDraft?.coordinateMode === coordinateMode &&
    (coordinateMode !== "page" || Number(noteDraft.pageNumber) === Number(pageNumber));

  return (
    <div
      className={`resume-mark-layer ${markMode ? "marking" : ""}`}
      onClick={(event) =>
        onMark(event, {
          coordinateMode,
          pageNumber,
        })
      }
    >
      {layerNotes.map((note) => (
        <button
          type="button"
          className={`resume-note-marker ${selectedNoteId === note.id ? "selected" : ""}`}
          data-resume-note-id={note.id}
          key={note.id}
          style={{ left: `${note.x * 100}%`, top: `${note.y * 100}%` }}
          title={note.text}
          onClick={(event) => {
            event.stopPropagation();
            onFocusNote(note);
          }}
        >
          <StickyNote size={13} />
        </button>
      ))}

      {draftVisible ? (
        <div
          className="note-popover"
          style={{
            left: `clamp(128px, ${noteDraft.x * 100}%, calc(100% - 128px))`,
            top: `clamp(8px, ${noteDraft.y * 100}%, calc(100% - 126px))`,
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <textarea
            autoFocus
            value={noteDraft.text}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder="写一句关键词备注"
          />
          <div className="note-actions">
            <button type="button" className="primary" onClick={onSaveDraft}>
              保存
            </button>
            <button type="button" onClick={onCancelDraft}>
              取消
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PdfPreview({ file, markerProps, zoom }) {
  const containerRef = useRef(null);
  const [pages, setPages] = useState([]);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [pdfError, setPdfError] = useState("");

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;

    let frame = 0;
    function updateWidth() {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        setAvailableWidth(Math.max(260, node.clientWidth));
      });
    }

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(node);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!resumeFileSource(file)) return undefined;

    let cancelled = false;
    let loadingTask = null;

    setPages([]);
    setPdfError("");

    async function loadPdf() {
      const pdfjsLib = await import("pdfjs-dist");
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      if (cancelled) return;

      loadingTask = pdfjsLib.getDocument(
        file.dataUrl
          ? { data: dataUrlToUint8Array(file.dataUrl), disableWorker: true }
          : { url: file.url, httpHeaders: getApiHeaders(), disableWorker: true },
      );

      const pdf = await loadingTask.promise;
      const loadedPages = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        if (cancelled) return;
        loadedPages.push(await pdf.getPage(pageNumber));
      }
      if (!cancelled) setPages(loadedPages);
    }

    loadPdf()
      .catch((error) => {
        console.error("[pdf-preview]", error);
        if (!cancelled) setPdfError("PDF 预览失败，可先下载查看");
      });

    return () => {
      cancelled = true;
      loadingTask?.destroy();
    };
  }, [file?.dataUrl, file?.url]);

  return (
    <div className="pdf-preview-viewport" ref={containerRef}>
      <div className="pdf-preview-pages">
        {pdfError ? (
          <div className="resume-file-placeholder">
            <FileText size={28} />
            <p>{pdfError}</p>
            <a href={resumeFileSource(file)} download={file.name}>
              下载查看
            </a>
          </div>
        ) : null}
        {!pdfError && !pages.length ? <div className="pdf-loading">正在加载 PDF</div> : null}
        {!pdfError
          ? pages.map((page) => (
              <PdfPageCanvas
                availableWidth={availableWidth}
                key={page.pageNumber}
                markerProps={markerProps}
                page={page}
                zoom={zoom}
              />
            ))
          : null}
        <ResumeMarkerLayer
          {...markerProps}
          coordinateMode="content"
          markMode={false}
          noteDraft={null}
        />
      </div>
    </div>
  );
}

function PdfPageCanvas({ page, availableWidth, markerProps, zoom }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!page || !availableWidth || !canvasRef.current) return undefined;

    const baseViewport = page.getViewport({ scale: 1 });
    const targetWidth = Math.max(260, (availableWidth - 34) * zoom);
    const scale = targetWidth / baseViewport.width;
    const viewport = page.getViewport({ scale });
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");

    canvas.width = Math.floor(viewport.width * pixelRatio);
    canvas.height = Math.floor(viewport.height * pixelRatio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const renderContext = {
      canvasContext: context,
      viewport,
    };
    if (pixelRatio !== 1) {
      renderContext.transform = [pixelRatio, 0, 0, pixelRatio, 0, 0];
    }

    const renderTask = page.render(renderContext);
    renderTask.promise.catch(() => {});

    return () => {
      renderTask.cancel();
    };
  }, [availableWidth, page, zoom]);

  return (
    <div className="pdf-page">
      <canvas aria-label={`PDF 第 ${page.pageNumber} 页`} ref={canvasRef} />
      <ResumeMarkerLayer
        {...markerProps}
        coordinateMode="page"
        pageNumber={page.pageNumber}
      />
    </div>
  );
}

function DocxPreview({ file, markerProps, zoom }) {
  const containerRef = useRef(null);
  const [availableWidth, setAvailableWidth] = useState(0);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;
    let frame = 0;
    function updateWidth() {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => setAvailableWidth(node.clientWidth));
    }
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(node);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  const fitScale = availableWidth ? Math.min(1, Math.max(0.35, (availableWidth - 34) / 794)) : 1;
  const scale = clampNumber(fitScale * zoom, 0.25, 2);

  return (
    <div className="docx-preview-viewport" ref={containerRef}>
      <div className="docx-preview-canvas" style={{ zoom: scale }}>
        <pre>{file.previewText}</pre>
        <ResumeMarkerLayer {...markerProps} coordinateMode="document" />
        <ResumeMarkerLayer
          {...markerProps}
          coordinateMode="content"
          markMode={false}
          noteDraft={null}
        />
      </div>
    </div>
  );
}

function isPendingAnalyzeCard(card) {
  return ["queued", "running", "retrying", "loading"].includes(card?.status);
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

function cardStatusLabel(card) {
  const labels = {
    queued: "排队中",
    running: "处理中",
    retrying: "重试中",
    done: "Markdown",
    error: "失败",
    loading: "处理中",
  };
  return labels[card.status] || "Markdown";
}

function createInterview(name = "未命名面试") {
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

function clearLegacyInterviewStore() {
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

async function loadRemoteInterviewStore() {
  const data = await requestJson("/api/store");
  return data.store ? normalizeStore(data.store) : null;
}

function interviewMetadataPatch(interview) {
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
    lastProcessedLineCount: interview.lastProcessedLineCount,
    speakerLabels: interview.speakerLabels,
    askedQuestions: interview.askedQuestions,
  };
}

function normalizeStore(store) {
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

function mergeInterviewStores(localStore, remoteStore) {
  if (!remoteStore?.interviews?.length) return normalizeStore(localStore);

  const local = normalizeStore(localStore);
  const remote = normalizeStore(remoteStore);
  const byId = new Map();
  for (const interview of [...remote.interviews, ...local.interviews]) {
    const existing = byId.get(interview.id);
    if (!existing || isNewerInterview(interview, existing)) {
      byId.set(interview.id, interview);
    }
  }

  let interviews = Array.from(byId.values()).sort(
    (left, right) =>
      new Date(right.updatedAt || right.createdAt || 0).getTime() -
      new Date(left.updatedAt || left.createdAt || 0).getTime(),
  );
  if (interviews.some(isMeaningfulInterview)) {
    interviews = interviews.filter(isMeaningfulInterview);
  }
  if (!interviews.length) interviews = [createInterview("未命名面试")];

  const localMeaningful = local.interviews.some(isMeaningfulInterview);
  const remoteMeaningful = remote.interviews.some(isMeaningfulInterview);
  const activeInterviewId =
    localMeaningful && interviews.some((item) => item.id === local.activeInterviewId)
      ? local.activeInterviewId
      : remoteMeaningful &&
          interviews.some((item) => item.id === remote.activeInterviewId)
        ? remote.activeInterviewId
        : interviews[0].id;

  return {
    activeInterviewId,
    interviews,
    jdLibrary: mergeSavedJds(local.jdLibrary, remote.jdLibrary),
    statusOptions: mergeStatusOptions(
      local.statusOptions,
      remote.statusOptions,
      interviews,
    ),
  };
}

function isNewerInterview(left, right) {
  return (
    new Date(left.updatedAt || left.createdAt || 0).getTime() >=
    new Date(right.updatedAt || right.createdAt || 0).getTime()
  );
}

function isMeaningfulInterview(interview) {
  return Boolean(
    interview?.sessionStartedAt ||
      interview?.resumeMarkdown?.trim() ||
      interview?.roleMarkdown?.trim() ||
      interview?.resumeFile ||
      interview?.resumeNotes?.length ||
      interview?.lines?.length ||
      interview?.cards?.length ||
      interview?.askedQuestions?.length ||
      (interview?.name && interview.name !== "未命名面试"),
  );
}

function mergeSavedJds(localJds = [], remoteJds = []) {
  const byId = new Map();
  for (const jd of [...remoteJds, ...localJds]) {
    const existing = byId.get(jd.id);
    if (
      !existing ||
      new Date(jd.updatedAt || jd.createdAt || 0).getTime() >=
        new Date(existing.updatedAt || existing.createdAt || 0).getTime()
    ) {
      byId.set(jd.id, jd);
    }
  }
  return Array.from(byId.values()).sort(
    (left, right) =>
      new Date(right.updatedAt || right.createdAt || 0).getTime() -
      new Date(left.updatedAt || left.createdAt || 0).getTime(),
  );
}

function normalizeInterview(interview) {
  const fallback = createInterview(interview?.name || "未命名面试");
  const merged = { ...fallback, ...interview };
  return {
    ...merged,
    scheduledAt: normalizeDateValue(interview?.scheduledAt),
    interviewStatus:
      normalizeStatusLabel(interview?.interviewStatus) || inferInterviewStatus(merged),
    lines: Array.isArray(interview?.lines) ? interview.lines : [],
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

function normalizeStatusLabel(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, 24);
}

function mergeStatusOptions(...sources) {
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

function normalizeSavedJd(jd) {
  const now = new Date().toISOString();
  return {
    id: jd?.id || safeId(),
    name: jd?.name || "未命名 JD",
    content: jd?.content || "",
    createdAt: jd?.createdAt || now,
    updatedAt: jd?.updatedAt || jd?.createdAt || now,
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

function safeId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

async function serializeResumeFile(file) {
  if (file.size > MAX_RESUME_FILE_SIZE) {
    throw new Error("简历文件超过 4MB，当前 MVP 先支持小文件预览");
  }

  const dataUrl = await readFileAsDataUrl(file);
  const previewText = await extractDocxPreviewText(file);
  return {
    name: file.name,
    type: file.type || inferFileType(file.name),
    size: file.size,
    dataUrl,
    previewText,
    updatedAt: new Date().toISOString(),
  };
}

function dataUrlToUint8Array(dataUrl) {
  const base64 = String(dataUrl).split(",")[1] || "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function resumeFileSource(file) {
  return file?.url || file?.dataUrl || "";
}

async function extractDocxPreviewText(file) {
  if (!isDocxFile(file)) return "";
  try {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value.trim();
  } catch {
    return "";
  }
}

function inferFileType(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".doc")) return "application/msword";
  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return "application/octet-stream";
}

function isPdfFile(file) {
  return file?.type === "application/pdf" || file?.name?.toLowerCase().endsWith(".pdf");
}

function isDocxFile(file) {
  return (
    file?.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    file?.name?.toLowerCase().endsWith(".docx")
  );
}

function isWordFile(file) {
  return (
    isDocxFile(file) ||
    file?.type === "application/msword" ||
    file?.name?.toLowerCase().endsWith(".doc")
  );
}

function formatFileSize(size = 0) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))}KB`;
  return `${(size / 1024 / 1024).toFixed(1)}MB`;
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

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

function normalizeDateValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
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

function mergeTranscriptLines(prev, incoming) {
  const seen = new Set(prev.map((line) => line.id));
  const next = [...prev];
  for (const item of incoming) {
    const id = [
      item.runId || "run",
      item.speaker || "na",
      item.startTime ?? "x",
      item.endTime ?? "x",
      item.text,
    ].join(":");
    if (seen.has(id) || !item.text?.trim()) continue;
    seen.add(id);
    next.push({
      id,
      runId: item.runId || "",
      text: item.text.trim(),
      startTime: item.startTime,
      endTime: item.endTime,
      speaker: item.speaker ? String(item.speaker) : "",
    });
  }
  return next;
}

function formatLineForPrompt(line, speakerLabels) {
  const speaker = line.speaker
    ? speakerLabels[line.speaker] || `说话人 ${line.speaker}`
    : "转录";
  return `[${speaker}] ${line.text}`;
}

function resampleTo16k(input, inputSampleRate) {
  if (inputSampleRate === SAMPLE_RATE) return input;
  const ratio = inputSampleRate / SAMPLE_RATE;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const sourceIndex = i * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(left + 1, input.length - 1);
    const weight = sourceIndex - left;
    output[i] = input[left] * (1 - weight) + input[right] * weight;
  }
  return output;
}

function floatTo16BitPcm(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}

function extractQuestionLikeLines(text) {
  return text
    .split(/\r?\n|。|？|\?/)
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, "").trim())
    .filter((line) => /问|介绍|说一下|讲一下|解释|为什么|怎么|多少|哪些/.test(line))
    .slice(-8);
}

function mergeQuestions(prev, incoming) {
  const next = [...prev];
  for (const question of incoming) {
    const normalized = question.trim();
    if (!normalized) continue;
    if (next.some((item) => similarityKey(item) === similarityKey(normalized))) continue;
    next.push(normalized);
  }
  return next.slice(-80);
}

function similarityKey(text) {
  return text.replace(/\s+/g, "").replace(/[，。？！?.,]/g, "").slice(0, 48);
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
