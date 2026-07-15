export function createPartialTextBridge() {
  let value = "";
  const listeners = new Set();
  return {
    get() {
      return value;
    },
    set(next) {
      const text = next || "";
      if (text === value) return;
      value = text;
      for (const listener of listeners) listener(text);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function mergeTranscriptLines(prev, incoming) {
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

export function formatLineForPrompt(line, speakerLabels) {
  const speaker = line.speaker
    ? speakerLabels[line.speaker] || `说话人 ${line.speaker}`
    : "转录";
  return `[${speaker}] ${line.text}`;
}

export function extractQuestionLikeLines(text) {
  return text
    .split(/\r?\n|。|？|\?/)
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, "").trim())
    .filter((line) => /问|介绍|说一下|讲一下|解释|为什么|怎么|多少|哪些/.test(line))
    .slice(-8);
}

export function mergeQuestions(prev, incoming) {
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
