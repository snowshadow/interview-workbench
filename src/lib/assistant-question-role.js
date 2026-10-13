// Explicit question ownership wins over the topic label, including when the
// interviewer resumes questioning inside a previously shared topic.
export function isCandidateQuestion(topic, qa) {
  const askedBy = qa?.askedBy || topic?.askedBy;
  if (askedBy && askedBy !== "unknown") return askedBy === "candidate";
  // Compatibility for saved rounds that predate question ownership.
  return [topic?.title, topic?.shortTitle].some((label) =>
    /^(?:候选人(?:提问|反问)|反问环节)(?:$|[\s：:（(·—-])/.test(String(label || "").trim()));
}
