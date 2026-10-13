import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Maximize2, Minimize2, MoreHorizontal, RotateCcw, Sparkles, WandSparkles } from "lucide-react";
import { PanelTitle, TranscriptLine } from "./WorkbenchPrimitives.jsx";
import { AnalysisCardList } from "./AnalysisCardList.jsx";
import { isAssistantJobPending } from "../lib/assistant-state.js";
import { assistantDisplayLabel, assistantLineTime, assistantReviewRows, buildAssistantView } from "../lib/assistant-view.js";
import "./interview-assistant.css";

const INITIAL_REVIEW = { mode: "recent", selectedId: "", snapshot: null };

export function InterviewAssistantPanel({
  state, lines, speakerLabels, jobs, autoEnabled, onToggleAuto, onRequestFollowup,
  onRetry, focused, onToggleFocus, legacyCards, onRetryLegacy, error, submitting, loading,
}) {
  const [review, setReview] = useState(INITIAL_REVIEW);
  const settingsRef = useRef(null);
  const reviewScrollRef = useRef(null);
  const view = useMemo(() => buildAssistantView(state, lines), [state, lines]);
  const lineMap = useMemo(() => new Map(lines.map((line) => [line.id, line])), [lines]);
  const current = view.focus;
  const suggestion = view.suggestion;
  const pendingManual = submitting === "followup" || jobs.some((job) => job.mode === "followup" && isAssistantJobPending(job));
  const pendingSummary = submitting === "summary" || jobs.some((job) => job.mode === "summary" && isAssistantJobPending(job));
  const pending = pendingManual || pendingSummary;
  const latestJob = jobs[0];
  const failedJob = ["error", "cancelled"].includes(latestJob?.status) ? latestJob : null;
  const hasError = Boolean(error || failedJob);
  const rows = assistantReviewRows(view, review);
  const latestRows = new Map([...view.recorded, ...view.pending].map((row) => [row.id, row]));
  const reviewing = Boolean(review.snapshot);
  const newQuestionCount = reviewing ? Math.max(0, view.asked.length - review.snapshot.asked.length) : 0;
  const processedTime = assistantLineTime(view.lastProcessedLine);
  const suggestionTime = assistantLineTime(view.suggestionLine);
  const sourceLabel = suggestion?.source === "manual" ? "手动刷新" : suggestion?.source === "automatic" ? "自动提示" : "已有建议";
  const progress = view.lastProcessedLine ? `已整理至 ${processedTime || `第 ${view.processedLineCount} 条`}` : "尚未整理";

  useEffect(() => {
    function closeSettings(event) {
      if (!settingsRef.current?.open) return;
      if (event.type === "keydown") {
        if (event.key !== "Escape") return;
        settingsRef.current.open = false;
        settingsRef.current.querySelector("summary")?.focus();
        event.stopPropagation();
      } else if (!settingsRef.current.contains(event.target)) settingsRef.current.open = false;
    }
    document.addEventListener("pointerdown", closeSettings);
    document.addEventListener("keydown", closeSettings, true);
    return () => {
      document.removeEventListener("pointerdown", closeSettings);
      document.removeEventListener("keydown", closeSettings, true);
    };
  }, []);

  function snapshot() {
    return review.snapshot || { asked: view.asked, recorded: view.recorded, pending: view.pending, recent: assistantReviewRows(view) };
  }

  function browse(mode) {
    setReview({ mode, selectedId: "", snapshot: snapshot() });
    if (reviewScrollRef.current) reviewScrollRef.current.scrollTop = 0;
  }

  function returnToLive() {
    setReview(INITIAL_REVIEW);
    if (reviewScrollRef.current) reviewScrollRef.current.scrollTop = 0;
  }

  return (
    <section className={`interview-assistant pane ${focused ? "panel-focus-mode" : ""} ${hasError ? "assistant-has-error" : ""}`}>
      <PanelTitle icon={<Sparkles size={17} />} title="AI 面试助手">
        {!view.candidateQuestion ? <button className="followup-action" onClick={onRequestFollowup} disabled={!lines.length || pendingManual || loading}>
          <WandSparkles size={14} /><span>{pendingManual ? "生成中" : "立即追问"}</span>
        </button> : null}
        <details ref={settingsRef} className="assistant-settings">
          <summary aria-label="整理设置与进度" title="整理设置与进度"><MoreHorizontal size={17} /></summary>
          <div className="assistant-settings-content">
            <button className="assistant-auto" aria-pressed={autoEnabled} onClick={onToggleAuto}>
              <span className={`assistant-auto-dot ${autoEnabled ? "enabled" : ""}`} />
              {autoEnabled ? "自动整理 · 每 30 秒" : "自动整理已暂停"}
            </button>
            <span>{progress}</span>
            {pending ? <span role="status">{view.candidateQuestion ? "正在整理对话" : pendingManual ? "正在生成追问" : "正在整理新回答"}</span> : null}
            {hasError ? <p>{error || failedJob?.error || "本次整理失败"}</p> : null}
          </div>
        </details>
        <button className="icon-button" onClick={onToggleFocus} aria-label={focused ? "退出助手专注模式" : "最大化 AI 面试助手"}>
          {focused ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
      </PanelTitle>

      {hasError ? <div className="assistant-error" role="alert">
        <span>{autoEnabled && failedJob?.status === "error" ? "更新失败，有新内容后重试" : "更新失败，已保留进度"}</span>
        <button onClick={() => onRetry(error ? null : failedJob)}><RotateCcw size={12} />重试</button>
      </div> : null}

      <div className="assistant-live" aria-label="当前问题与追问">
        <div className="assistant-live-meta">
          <span className="assistant-live-label"><span className={`assistant-auto-dot ${autoEnabled ? "enabled" : ""}`} />{view.hasUnprocessed ? "依据已整理内容" : "跟随现场"}</span>
          <span role="status" aria-live="polite">{loading ? "读取中" : pending ? "更新中…" : view.hasUnprocessed ? "有新回答待整理" : !autoEnabled ? "自动已暂停" : current ? "已更新" : "等待回答"}</span>
        </div>
        {current ? <>
          <div className="assistant-current-topic" title={current.topic.title}><span className="assistant-current-topic-text">{assistantDisplayLabel(current.topic.shortTitle, current.topic.title)}</span>{!current.qa ? <span className="assistant-statement-marker"> · 自述</span> : null}</div>
          {current.qa ? <h3 className="assistant-current-question" title={current.qa.question}>{assistantDisplayLabel(current.qa.shortQuestion, current.qa.question)}</h3> : null}
        </> : <p className="assistant-current-empty">{loading ? "正在读取面试进度" : lines.length ? "正在识别当前讨论" : "开始面试后，跟随当前问题"}</p>}

        {!view.candidateQuestion ? <div className={`assistant-next-question ${!suggestion ? "is-empty" : ""}`}>
          <div className="assistant-next-label"><span>{view.hasUnprocessed ? "上次建议" : "可追问"}</span><span>{suggestion ? sourceLabel : pendingManual ? "生成中" : ""}</span></div>
          {suggestion ? <>
            <p title={suggestion.question}>{suggestion.question}</p>
            <div className="assistant-next-meta">
              {suggestion.purpose ? <span title={suggestion.purpose}>{suggestion.purpose}</span> : null}
              {suggestionTime ? <span>依据 {suggestionTime}</span> : <span>依据已整理回答</span>}
            </div>
          </> : <p>{pending ? "正在根据回答更新…" : current ? "暂无合适追问，可点「立即追问」" : "识别当前问题后提供建议"}</p>}
        </div> : null}
      </div>

      <div className="assistant-review" aria-label="问题回看">
        <div className="assistant-review-navigation">
          {reviewing ? <button className="assistant-review-return" onClick={returnToLive} aria-label={newQuestionCount ? `返回最新，新增 ${newQuestionCount} 问` : "返回最新"}>返回最新{newQuestionCount ? <span> +{newQuestionCount}</span> : null}</button> : <span>{rows.some((row) => row.kind === "statement") ? "最近记录" : "最近已问"}</span>}
          <div className="assistant-review-tabs" aria-label="问题范围">
            <button aria-pressed={review.mode === "asked"} onClick={() => browse("asked")}>已问 {view.asked.length}</button>
            <button aria-pressed={review.mode === "pending"} onClick={() => browse("pending")}>待问 {view.pending.length}</button>
          </div>
        </div>
        <div className="assistant-review-scroll" ref={reviewScrollRef}>
          {!rows.length ? <p className="assistant-review-empty">{review.mode === "pending" ? "暂无待问话题" : "尚未记录到实际提问"}</p> : null}
          {rows.map((row) => {
            const open = review.selectedId === row.id;
            const isCurrent = row.qa ? current?.topicId === row.topic.id && current?.qaId === row.qa.id : current?.topicId === row.topic.id;
            return <div className={`assistant-review-item ${isCurrent ? "is-current" : ""}`} key={row.id}>
              <button className="assistant-review-row" aria-expanded={open} onClick={() => setReview({ ...review, snapshot: snapshot(), selectedId: open ? "" : row.id })}>
                <span className="assistant-review-indicator">{row.kind === "statement" ? "自述" : row.qa ? assistantLineTime(lineMap.get(row.evidenceLineIds[0])) || "·" : row.topic.status === "partial" ? "待补" : "未问"}</span>
                <span className="assistant-review-title" title={row.qa?.question || row.topic.title}>{row.title}</span>
                <ChevronDown size={13} className={open ? "" : "closed"} />
              </button>
              {open ? <ReviewDetail row={latestRows.get(row.id) || row} lineMap={lineMap} speakerLabels={speakerLabels} /> : null}
            </div>;
          })}
          {legacyCards.length ? <details className="assistant-legacy"><summary>历史追问 · {legacyCards.length}</summary><AnalysisCardList cards={legacyCards} onRetry={onRetryLegacy} /></details> : null}
        </div>
      </div>
    </section>
  );
}

function ReviewDetail({ row, lineMap, speakerLabels }) {
  const [originalOpen, setOriginalOpen] = useState(false);
  const evidence = row.evidenceLineIds.map((id) => lineMap.get(id)).filter(Boolean);
  const answer = row.qa ? row.qa.answer : row.topic.summary;
  const detail = row.followup?.question || answer || (row.qa ? "尚未记录到回答" : row.topic.title);
  return <div className="assistant-review-detail">
    <span className="assistant-detail-label">{row.kind === "statement" ? "自述摘要" : row.qa ? "回答要点" : row.followup ? "待问方向" : row.topic.status === "partial" ? "已知进度" : "待问方向"}</span>
    <p title={detail}>{detail}</p>
    {row.followup?.purpose ? <span className="assistant-detail-label">{row.followup.purpose}</span> : null}
    {row.qa?.gap ? <p className="assistant-detail-gap" title={row.qa.gap}>待补：{row.qa.gap}</p> : null}
    {row.qa?.question || row.topic.title || evidence.length ? <button className="assistant-original-toggle" aria-expanded={originalOpen} onClick={() => setOriginalOpen((value) => !value)}>{originalOpen ? "收起原文" : row.qa ? "查看完整原问与原文" : "查看完整主题与原文"}</button> : null}
    {originalOpen ? <div className="assistant-evidence">
      <p className="assistant-original-question"><span>{row.qa ? "完整原问" : "完整主题"}</span>{row.qa?.question || row.topic.title}</p>
      {evidence.map((line) => <TranscriptLine key={line.id} line={line} speakerLabels={speakerLabels} processed />)}
    </div> : null}
  </div>;
}
