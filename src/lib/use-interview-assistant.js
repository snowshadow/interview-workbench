import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson } from "../api.js";
import { readUiPreferences, saveUiPreferences } from "./ui-preferences.js";
import { ASSISTANT_INTERVAL_MS, EMPTY_ASSISTANT_STATE, isAssistantJobPending, newerAssistantState, shouldAutoSummarize } from "./assistant-state.js";

export function useInterviewAssistant({ interviewId, enabled, recording, lineCount, beforeRequest, resetKey = 0 }) {
  const [snapshot, setSnapshot] = useState({ interviewId: "", state: EMPTY_ASSISTANT_STATE, jobs: [] });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState("");
  const [loading, setLoading] = useState(false);
  const [autoEnabled, setAutoEnabled] = useState(() => readUiPreferences().assistantAuto !== false);
  const current = useRef({});
  const generation = useRef(0);
  const sequence = useRef(0);
  const appliedSequence = useRef(0);
  const locks = useRef(new Set());
  const failedRequest = useRef(null);
  current.current = { interviewId, enabled, recording, lineCount, beforeRequest, autoEnabled, snapshot, submitting };

  const apply = useCallback((id, data, epoch, order) => {
    if (generation.current !== epoch || current.current.interviewId !== id) return;
    if (order < appliedSequence.current) return;
    appliedSequence.current = order;
    setSnapshot((previous) => ({
      interviewId: id,
      state: newerAssistantState(previous.interviewId === id ? previous.state : null, data.state),
      jobs: data.jobs || [],
    }));
  }, []);

  const refresh = useCallback(async (id, epoch) => {
    const order = ++sequence.current;
    const data = await requestJson(`/api/interviews/${encodeURIComponent(id)}/assistant`);
    apply(id, data, epoch, order);
    if (generation.current === epoch && !failedRequest.current) setError("");
    return data;
  }, [apply]);

  useEffect(() => {
    const epoch = ++generation.current;
    setError(""); setSubmitting("");
    failedRequest.current = null;
    setSnapshot({ interviewId: "", state: EMPTY_ASSISTANT_STATE, jobs: [] });
    if (!interviewId || !enabled) { setLoading(false); return; }
    setLoading(true);
    refresh(interviewId, epoch).catch((err) => {
      if (epoch === generation.current) setError(err.message || "读取面试进度失败");
    }).finally(() => { if (epoch === generation.current) setLoading(false); });
    return () => { generation.current += 1; };
  }, [interviewId, enabled, resetKey, refresh]);

  const state = snapshot.interviewId === interviewId ? snapshot.state : EMPTY_ASSISTANT_STATE;
  const jobs = snapshot.interviewId === interviewId ? snapshot.jobs : [];
  const hasPending = jobs.some(isAssistantJobPending);
  useEffect(() => {
    if (!enabled || !interviewId || !hasPending) return;
    const epoch = generation.current;
    let stopped = false;
    let timer;
    async function poll() {
      try { await refresh(interviewId, epoch); }
      catch (err) { if (!stopped) setError(err.message || "读取整理进度失败"); }
      if (!stopped) timer = setTimeout(poll, 1500);
    }
    timer = setTimeout(poll, 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [enabled, interviewId, resetKey, hasPending, refresh]);

  const request = useCallback(async (mode = "followup") => {
    const context = current.current;
    const id = context.interviewId;
    const epoch = generation.current;
    const key = `${epoch}:${id}:${mode}`;
    if (!context.enabled || !id || locks.current.has(key)) return;
    locks.current.add(key);
    failedRequest.current = null;
    setSubmitting(mode); setError("");
    try {
      await context.beforeRequest(id);
      if (generation.current !== epoch || current.current.interviewId !== id) return;
      const data = await requestJson(`/api/interviews/${encodeURIComponent(id)}/assistant-jobs`, {
        method: "POST", body: JSON.stringify({ mode }),
      });
      // A GET started while this POST was waiting can predate job creation.
      // Fence those snapshots out so the newly created job always starts polling.
      apply(id, data, epoch, ++sequence.current);
    } catch (err) {
      if (epoch === generation.current) {
        failedRequest.current = mode;
        setError(err.message || "创建整理任务失败");
      }
    } finally {
      locks.current.delete(key);
      if (epoch === generation.current) setSubmitting(locks.current.has(`${epoch}:${id}:followup`) ? "followup" : locks.current.has(`${epoch}:${id}:summary`) ? "summary" : "");
    }
  }, [apply]);

  useEffect(() => {
    if (!enabled || !interviewId || !recording || !autoEnabled) return;
    const timer = setInterval(() => {
      const c = current.current;
      const sameRound = c.snapshot.interviewId === c.interviewId;
      if (shouldAutoSummarize({ ...c, state: sameRound ? c.snapshot.state : null, jobs: sameRound ? c.snapshot.jobs : [] })) request("summary");
    }, ASSISTANT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, interviewId, recording, autoEnabled, request]);

  const retry = useCallback(async (job) => {
    const id = current.current.interviewId;
    const epoch = generation.current;
    setError("");
    try {
      if (!job) {
        if (failedRequest.current) await request(failedRequest.current);
        else await refresh(id, epoch);
        return;
      }
      await requestJson(`/api/assistant-jobs/${encodeURIComponent(job.id)}/retry`, { method: "POST" });
      await refresh(id, epoch);
    } catch (err) { if (epoch === generation.current) setError(err.message || "重试失败"); }
  }, [refresh, request]);

  const toggleAuto = useCallback(() => setAutoEnabled((value) => {
    saveUiPreferences({ assistantAuto: !value }); return !value;
  }), []);

  return { state, jobs, error, submitting, loading, autoEnabled, toggleAuto, request, retry };
}
