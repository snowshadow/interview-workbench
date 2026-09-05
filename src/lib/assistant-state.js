export const ASSISTANT_INTERVAL_MS = 30_000;
export const EMPTY_ASSISTANT_STATE = Object.freeze({ revision: 0, processedLineCount: 0, topics: [], followups: [], updatedAt: null });

export function isAssistantJobPending(job) {
  return ["queued", "running", "retrying"].includes(job?.status);
}

export function newerAssistantState(current, incoming) {
  if (!incoming) return current || EMPTY_ASSISTANT_STATE;
  if (!current) return incoming;
  if (Number(incoming.revision || 0) < Number(current.revision || 0)) return current;
  if (Number(incoming.processedLineCount || 0) < Number(current.processedLineCount || 0)) return current;
  return incoming;
}

export function shouldAutoSummarize({ recording, autoEnabled, lineCount, state, jobs, submitting }) {
  return Boolean(recording && autoEnabled && !submitting && lineCount > (state?.processedLineCount || 0)
    && !jobs.some(isAssistantJobPending) && !["error", "cancelled"].includes(jobs[0]?.status));
}

// A failed write retains its batch. The assistant must wait for persistence,
// otherwise it can mistake a network-delayed answer for an unanswered question.
export function createTranscriptWriteQueue(write) {
  const rounds = new Map();
  function flush(id) {
    const queue = rounds.get(id);
    if (!queue?.batches.length) return queue?.promise || Promise.resolve();
    if (queue.promise) return queue.promise;
    queue.promise = Promise.resolve().then(async () => {
      try {
        while (queue.batches.length) {
          await write(id, queue.batches[0]);
          queue.batches.shift();
        }
      } finally {
        // Clear in the same continuation that drains the final batch. An enqueue
        // in the next microtask must start a new drain, not inherit a settled one.
        queue.promise = null;
      }
    });
    return queue.promise;
  }
  return {
    enqueue(id, lines) {
      if (!rounds.has(id)) rounds.set(id, { batches: [], promise: null });
      rounds.get(id).batches.push(lines);
      return flush(id);
    },
    flush,
    flushAll: () => Promise.all([...rounds.keys()].map(flush)),
  };
}

export function assistantMarkdown(state) {
  return (state?.topics || []).map((topic) => [
    `### ${topic.title}`, topic.summary || "",
    ...topic.qas.flatMap((qa) => [`\n**问：** ${qa.question}`, `\n**答：** ${qa.answer || "尚未记录到回答"}`, qa.gap ? `\n待补充：${qa.gap}` : ""]),
  ].filter(Boolean).join("\n")).join("\n\n");
}
