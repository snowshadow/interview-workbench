---
name: interview-summary
description: "Produce an evidence-based report and cross-round handoff for one Interview Workbench round from Application-level evidence, Round preparation, notes, AI follow-ups, and that Round's full transcript. Use for interview summaries, debriefs, scores, next-round handoffs, or an explicitly requested whole-process final conclusion."
---

# Interview Summary

Produce a hiring decision, not a transcript recap. Compare what needed to be proven before the interview with what the interview actually established.

## Source Order

1. Find the exact hiring process with `list_applications`, matching candidate and role together, then load `get_application_context`. Select the exact Round. Do not guess when multiple Applications or Rounds match.
2. Load the target Round's label, focus, preparation, notes, AI cards, and artifacts with `get_interview_context`. Use Application-level JD, resume, and screening plus selected prior `round-handoff` and `interview-summary` artifacts for cross-round context.
3. Read **only the selected Round's** full transcript with `get_transcript_chunk`. Start at offset `0`, use bounded chunks, and follow `nextOffset` until it is `null`. Do not mix another Round's raw transcript into the report.
4. Treat obvious ASR errors as uncertainty. Never invent missing statements or silently repair facts that affect the decision.
5. Compare this round with the remaining hiring questions and its `interview-preparation` artifact. Explicitly call out important areas that were not asked or not answered.

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

Save the report to the target Round with `save_interview_artifact`, kind `interview-summary`, and title `Interview summary`. Save a second Round artifact with kind `round-handoff` and exactly these headings:

```markdown
## Confirmed evidence

## Unresolved risks

## Contradictions

## Next-round objectives
```

The handoff, not prior raw transcripts, is the default input to later-round preparation. Verify both saved artifacts before reporting success.

Only when the user explicitly asks for a whole-process or final hiring conclusion, synthesize all Round summaries and save it on the Application with `save_application_artifact`, kind `final-summary`, and title `Final summary`. Do not treat an ordinary Round summary as the whole-process decision, and do not update Application status unless the user explicitly confirms it.
