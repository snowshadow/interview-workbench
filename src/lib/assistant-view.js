import { isCandidateQuestion } from "./assistant-question-role.js";

// Prefer a complete short label. Older labels may already contain a literal
// ellipsis; recover their source text and let CSS truncate at the panel edge.
export function assistantDisplayLabel(shortText, fullText) {
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const short = clean(shortText);
  return !short || /(?:…|\.{3,})$/.test(short) ? clean(fullText) || short : short;
}

// A directory's order says nothing about the conversation's current position.
// Older saved rounds have no explicit focus, so only their transcript evidence
// can tell us where the interviewer most recently was.
export function buildAssistantView(state = {}, lines = []) {
  const topics = state.topics || [];
  const processedLineCount = Number.isFinite(state.processedLineCount)
    ? Math.max(0, Math.min(lines.length, state.processedLineCount)) : lines.length;
  const positions = new Map(lines.slice(0, processedLineCount).map((line, index) => [line.id, index]));
  const positionOf = (ids = []) => ids.reduce((latest, id) => Math.max(latest, positions.get(id) ?? -1), -1);
  const firstPositionOf = (ids = []) => {
    const found = ids.map((id) => positions.get(id)).filter(Number.isFinite);
    return found.length ? Math.min(...found) : -1;
  };
  let focus = null;
  if (Object.hasOwn(state, "focus")) {
    const topic = topics.find((item) => item.id === state.focus?.topicId);
    const qa = topic?.qas?.find((item) => item.id === state.focus?.qaId);
    if (topic && (!state.focus.qaId || qa)) {
      focus = { ...state.focus, topic, qa, position: positionOf(state.focus.evidenceLineIds || qa?.evidenceLineIds || topic.evidenceLineIds) };
    }
  } else {
    function consider(topic, qa, evidenceLineIds) {
      const position = positionOf(evidenceLineIds);
      if (position >= 0 && (!focus || position > focus.position || (position === focus.position && qa && !focus.qa))) {
        focus = { topicId: topic.id, ...(qa ? { qaId: qa.id } : {}), evidenceLineIds, topic, qa, position };
      }
    }
    for (const topic of topics) {
      consider(topic, null, topic.evidenceLineIds || []);
      for (const qa of topic.qas || []) consider(topic, qa, qa.evidenceLineIds || []);
    }
  }

  const candidateQuestion = Boolean(focus && isCandidateQuestion(focus.topic, focus.qa));
  const suggestion = focus && !candidateQuestion ? (state.followups || []).find((item) => item.topicId === focus.topicId
    && (item.qaId || null) === (focus.qaId || null) && String(item.question || "").trim()) || null : null;
  const asked = topics.flatMap((topic) => (topic.qas || []).map((qa) => ({
    id: `qa:${topic.id}:${qa.id}`, topic, qa,
    title: assistantDisplayLabel(qa.shortQuestion, qa.question),
    position: firstPositionOf(qa.evidenceLineIds),
    evidenceLineIds: qa.evidenceLineIds || [],
  }))).sort((a, b) => a.position - b.position);
  const statements = topics.filter((topic) => !topic.qas?.length && positionOf(topic.evidenceLineIds) >= 0).map((topic) => ({
    id: `statement:${topic.id}`, kind: "statement", topic, qa: null,
    title: assistantDisplayLabel(topic.shortTitle, topic.title),
    position: firstPositionOf(topic.evidenceLineIds),
    evidenceLineIds: topic.evidenceLineIds || [],
  }));
  const recorded = [...asked, ...statements].sort((a, b) => a.position - b.position);
  const pending = topics.filter((topic) => !isCandidateQuestion(topic) && ["unasked", "partial"].includes(topic.status)).map((topic) => {
    const followup = !candidateQuestion && (state.followups || []).find((item) => item.topicId === topic.id && !item.qaId && item.source === "manual");
    return {
      id: `topic:${topic.id}`, kind: "pending", topic, qa: null, followup,
      title: assistantDisplayLabel(topic.shortTitle, topic.title),
      evidenceLineIds: [...new Set([...(topic.evidenceLineIds || []), ...(followup?.evidenceLineIds || [])])],
    };
  });

  return {
    focus, suggestion, asked, recorded, pending, candidateQuestion,
    hasUnprocessed: lines.length > processedLineCount,
    processedLineCount,
    lastProcessedLine: lines[processedLineCount - 1] || null,
    suggestionLine: suggestion ? lines[positionOf(suggestion.evidenceLineIds)] || null : null,
  };
}

// Freezing the lower list keeps incoming answers from moving a row being read.
// The live question and suggestion continue to use the newest assistant view.
export function assistantReviewRows(view, review = {}) {
  const source = review.snapshot || view;
  const recorded = source.recorded || source.asked;
  if (review.mode === "pending") return source.pending;
  if (review.mode === "asked") return recorded;
  if (review.snapshot?.recent) return review.snapshot.recent;
  return recorded.filter((row) => !row.qa || row.topic.id !== view.focus?.topicId || row.qa.id !== view.focus?.qaId).slice(-3);
}

export function assistantLineTime(line) {
  const time = Number(line?.endTime ?? line?.startTime);
  if (!Number.isFinite(time) || (line?.endTime == null && line?.startTime == null)) return "";
  const seconds = Math.floor(time / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
