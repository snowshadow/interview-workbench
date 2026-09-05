import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ListTree, Maximize2, Minimize2, RotateCcw, Sparkles, WandSparkles, X } from "lucide-react";
import { PanelTitle, TranscriptLine } from "./WorkbenchPrimitives.jsx";
import { AnalysisCardList } from "./AnalysisCardList.jsx";
import { isAssistantJobPending } from "../lib/assistant-state.js";
import "./interview-assistant.css";

const TOPIC_STATUS = { unasked: "未涉及", answering: "回答中", partial: "待补充", covered: "已覆盖" };

export function InterviewAssistantPanel({
  state, lines, speakerLabels, jobs, autoEnabled, onToggleAuto, onRequestFollowup,
  onRetry, focused, onToggleFocus, legacyCards, onRetryLegacy, error, submitting, loading,
}) {
  const [selectedId, setSelectedId] = useState("");
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const directoryRef = useRef(null);
  const directoryButtonRef = useRef(null);
  const suggestionsRef = useRef(null);
  const manualTransition = useRef(null);
  const topics = state.topics || [];
  const selected = topics.find((topic) => topic.id === selectedId)
    || topics.findLast((topic) => topic.status === "answering")
    || topics.findLast((topic) => topic.qas?.length) || topics[0];
  const lineMap = useMemo(() => new Map(lines.map((line) => [line.id, line])), [lines]);
  const selectedIndex = topics.indexOf(selected);
  const pendingManual = submitting === "followup" || jobs.some((job) => job.mode === "followup" && isAssistantJobPending(job));
  const pendingSummary = submitting === "summary" || jobs.some((job) => job.mode === "summary" && isAssistantJobPending(job));
  const latestJob = jobs[0];
  const failedJob = ["error", "cancelled"].includes(latestJob?.status) ? latestJob : null;
  const relevantFollowups = (state.followups || []).filter((item) => item.topicId === selected?.id);
  const otherFollowups = (state.followups || []).filter((item) => item.topicId !== selected?.id);
  const lastLine = lines[Math.min(lines.length, state.processedLineCount) - 1];
  const coverage = `${topics.filter((t) => t.status === "covered").length} 已覆盖 · ${topics.filter((t) => t.status === "unasked").length} 未涉及`;

  useEffect(() => {
    if (!selectedId && selected) setSelectedId(selected.id);
  }, [selectedId, selected?.id]);

  const completedManualId = jobs.find((job) => job.mode === "followup" && job.status === "done")?.id || "";
  useEffect(() => {
    if (pendingManual && !manualTransition.current) manualTransition.current = { previousId: completedManualId };
    if (!pendingManual && manualTransition.current) {
      if (completedManualId && completedManualId !== manualTransition.current.previousId) suggestionsRef.current?.scrollIntoView({ block: "nearest" });
      manualTransition.current = null;
    }
  }, [completedManualId, pendingManual]);

  useEffect(() => {
    if (!directoryOpen) return;
    function close(event) {
      if (event.type === "keydown" && event.key !== "Escape") return;
      if (event.type === "pointerdown" && (directoryRef.current?.contains(event.target) || directoryButtonRef.current?.contains(event.target))) return;
      setDirectoryOpen(false);
      if (event.type === "keydown") { event.stopPropagation(); directoryButtonRef.current?.focus(); }
    }
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close, true);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close, true); };
  }, [directoryOpen]);

  function selectTopic(id) {
    setSelectedId(id); setDirectoryOpen(false); directoryButtonRef.current?.focus();
  }

  return (
    <section className={`interview-assistant pane ${focused ? "panel-focus-mode" : ""}`}>
      <PanelTitle icon={<Sparkles size={18} />} title="AI 面试助手">
        <button className="followup-action" onClick={onRequestFollowup} disabled={!lines.length || pendingManual || loading}>
          <WandSparkles size={15} /><span>{pendingManual ? "生成中" : "立即追问"}</span>
        </button>
        <button className="icon-button" onClick={onToggleFocus} aria-label={focused ? "退出助手专注模式" : "最大化 AI 面试助手"}>
          {focused ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </PanelTitle>
      <div className="assistant-statusbar">
        <button className="assistant-auto" aria-pressed={autoEnabled} onClick={onToggleAuto}>
          <span className={autoEnabled ? "assistant-auto-dot enabled" : "assistant-auto-dot"} />
          {autoEnabled ? "自动整理 · 每 30 秒" : "自动整理已暂停"}
        </button>
        <span role="status" aria-live="polite">{loading ? "读取进度…" : pendingManual ? "正在根据最新回答生成…" : pendingSummary ? "正在整理新回答…" : lastLine ? `已整理至 ${lineTime(lastLine) || `第 ${state.processedLineCount} 条`}` : "尚未整理"}</span>
      </div>
      <div className="assistant-navigation">
        <button ref={directoryButtonRef} className="assistant-directory-toggle" onClick={() => setDirectoryOpen((value) => !value)} aria-expanded={directoryOpen} aria-controls="assistant-directory" disabled={!topics.length}>
          <ListTree size={15} />话题目录 {topics.length ? `${selectedIndex + 1} / ${topics.length}` : ""}<ChevronDown size={13} />
        </button>
        {topics.length ? <span className="assistant-coverage">{coverage}</span> : null}
        {directoryOpen ? <nav ref={directoryRef} id="assistant-directory" className="assistant-directory" aria-label="本轮话题目录">
          <div className="assistant-directory-heading"><span>本轮话题</span><button onClick={() => setDirectoryOpen(false)} aria-label="收起话题目录"><X size={15} /></button></div>
          {topics.map((topic, index) => <button className={`assistant-directory-item ${selected?.id === topic.id ? "selected" : ""}`} key={topic.id} aria-current={selected?.id === topic.id ? "true" : undefined} onClick={() => selectTopic(topic.id)}>
            <span>{String(index + 1).padStart(2, "0")}</span><span>{topic.title}<small>{topic.qas.length} 组问答 · {TOPIC_STATUS[topic.status] || "待补充"}{topic.origin === "emergent" ? " · 临时话题" : ""}</small></span>
          </button>)}
        </nav> : null}
      </div>
      {error || failedJob ? <div className="assistant-error" role="alert"><span>{error || `${failedJob.error || "本次整理失败"} · 自动整理等待重试`}</span><button onClick={() => onRetry(error ? null : failedJob)}><RotateCcw size={13} />重试</button></div> : null}
      <div className="assistant-content">
        {selected ? <article className="assistant-topic" key={selected.id}>
          <h3>{selected.title}</h3>
          <div className="assistant-topic-meta"><span>{selected.qas.length} 组问答</span><span className={`assistant-topic-status ${selected.status}`}>{TOPIC_STATUS[selected.status]}</span></div>
          {selected.summary ? <p className="assistant-topic-summary">{selected.summary}</p> : null}
          {!selected.qas.length ? <p className="assistant-empty-topic">本轮尚未记录到这个话题的问答。</p> : null}
          <div ref={suggestionsRef}>
          {relevantFollowups.map((followup) => <div className="assistant-followup" key={followup.id}><div className="assistant-followup-label">AI 追问 · 手动生成</div><p>{followup.question}</p></div>)}
          {otherFollowups.length ? <div className="assistant-pending-topics"><div>待问关键问题</div>{otherFollowups.map((item) => <button key={item.id} onClick={() => selectTopic(item.topicId)}>{item.question}</button>)}</div> : null}
          </div>
          {selected.qas.map((qa, index) => <QuestionAnswer key={qa.id} qa={qa} index={index} initiallyOpen={index >= selected.qas.length - 2} lineMap={lineMap} speakerLabels={speakerLabels} />)}
          {topics[selectedIndex + 1] ? <button className="assistant-next-topic" onClick={() => selectTopic(topics[selectedIndex + 1].id)}>下一话题：{topics[selectedIndex + 1].title} →</button> : null}
        </article> : <div className="empty">{loading ? "正在读取面试进度" : lines.length ? "点击「立即追问」整理已有问答；面试转录期间每 30 秒自动更新。" : "开始面试后，AI 会按话题整理问答。需要下一问时，点击「立即追问」。"}</div>}
        {legacyCards.length ? <details className="assistant-legacy"><summary>历史追问 · {legacyCards.length}</summary><AnalysisCardList cards={legacyCards} onRetry={onRetryLegacy} /></details> : null}
      </div>
    </section>
  );
}

function QuestionAnswer({ qa, index, initiallyOpen, lineMap, speakerLabels }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const evidence = (qa.evidenceLineIds || []).map((id) => lineMap.get(id)).filter(Boolean);
  return <div className="assistant-qa">
    <button className="assistant-question" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <ChevronDown size={15} className={open ? "" : "closed"} />
      <span><span className="assistant-question-meta">Q{index + 1}{evidence[0] ? ` · ${lineTime(evidence[0])}` : ""}{qa.status === "answering" ? <span className="assistant-topic-status answering">回答中</span> : null}</span><span className="assistant-question-text">{qa.question}</span>{!open && qa.answer ? <span className="assistant-answer-teaser">{qa.answer}</span> : null}</span>
    </button>
    {open ? <div className="assistant-answer"><span className="assistant-answer-label">回答摘要</span><p>{qa.answer || (qa.status === "answering" ? "正在等待完整回答" : "尚未记录到回答")}</p>
      {qa.gap && qa.status !== "answering" ? <p className="assistant-gap">待补充：{qa.gap}</p> : null}
      {evidence.length ? <><button className="assistant-evidence-toggle" onClick={() => setEvidenceOpen((value) => !value)} aria-expanded={evidenceOpen}>{evidenceOpen ? "收起问答原文" : "查看问答原文"}</button>{evidenceOpen ? <div className="assistant-evidence">{evidence.map((line) => <TranscriptLine key={line.id} line={line} speakerLabels={speakerLabels} processed />)}</div> : null}</> : null}
    </div> : null}
  </div>;
}

function lineTime(line) {
  const time = Number(line?.endTime ?? line?.startTime);
  if (!Number.isFinite(time) || (line?.endTime == null && line?.startTime == null)) return "";
  const seconds = Math.floor(time / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
