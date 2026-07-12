---
name: interview-summary
description: Produce an evidence-based post-interview hiring report from an Interview Workbench session, integrating the JD, resume analysis, prior screening and preparation artifacts, AI follow-ups, notes, and the full transcript. Use for interview summaries, debriefs, hiring decisions, scores, or when the user wants to avoid manually exporting a transcript.
---

# Interview Summary

Produce a hiring decision, not a transcript recap. Compare what needed to be proven before the interview with what the interview actually established.

## Source Order

1. Find the exact session with `list_interviews`. Do not guess when multiple candidates match.
2. Load metadata, JD, resume analysis, notes, AI cards, and saved artifacts with `get_interview_context`.
3. Read the full transcript using `get_transcript_chunk`. Start at offset `0`, use bounded chunks, and continue with `nextOffset` until it is `null`.
4. Treat obvious ASR errors as uncertainty. Never invent missing statements or silently repair facts that affect the decision.
5. Compare the interview with the JD, `resume-screening`, and `interview-preparation` artifacts. Explicitly call out important areas that were not asked or not answered.

## Judgment

Separate direct evidence, adjacent experience, unsupported claims, and missing evidence. Prefer personal ownership, concrete decisions, tradeoffs, metrics, failure analysis, and iteration after real use. For senior candidates, verify recent hands-on work separately from leadership scope.

Use the organization's rubric and decision labels when available. If no rubric exists, make a plain recommendation without pretending there is a universal scoring model. A score is optional and must agree with the written recommendation.

## Output

Write in the user's language. Lead with the decision and keep evidence traceable:

```markdown
**Decision**: ...

**Role fit**: ...

**Evidence from the interview**: ...

**Compared with the preparation plan**: ...

**Strengths**: ...

**Gaps and risks**: ...

**Next step**: ...

**One-line assessment**: ...
```

Save the final Markdown with `save_interview_artifact` using kind `interview-summary` and title `Interview summary`. The save replaces the current summary artifact for that interview. Do not update interview status unless the user explicitly confirms the new status.
