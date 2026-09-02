---
name: interview-summary
description: "Produce two complementary, round-specific Interview Workbench documents: an evidence-based hiring decision and a chronological, detailed interview Q&A, plus a concise cross-round handoff. Use for interview summaries, debriefs, Q&A, transcript reviews, scores, next-round handoffs, or an explicitly requested whole-process final conclusion."
---

# Interview Summary and Q&A

Turn one interview Round into two complementary reader-facing documents:

1. A concise **hiring-decision report** that compares what needed to be proven with what the candidate actually demonstrated.
2. A chronological **interview Q&A** that reconstructs the substantive course of the interview without requiring the reader to revisit the raw transcript.

An ordinary request to summarize or debrief one Round implies both documents. If the user explicitly requests only the decision report or only the Q&A, produce only that reader-facing document. A whole-process final conclusion remains an Application-level synthesis; it does not imply rebuilding Q&A across every Round unless the user asks.

This is a post-interview skill, not resume screening or interview preparation. The decision report must not become a transcript recap. The Q&A must not become a second hiring judgment or a polished rewrite of what the candidate should have said.

## Source Order

1. Find the exact hiring process with `list_applications`, matching candidate and role together, then load `get_application_context`. Select the exact Round. Do not guess when multiple Applications or Rounds match.
2. Load the target Round's label, focus, preparation, notes, AI cards, and artifacts with `get_interview_context`. Use each artifact's explicit `includeInCrossRoundContext` value to identify curated cross-round context; the two tracks select from these sources differently in step 4.
3. Read **only the selected Round's** full transcript with `get_transcript_chunk`. Start at offset `0`, use bounded chunks, and follow `nextOffset` until it is `null`. Do not mix another Round's raw transcript into the report.
4. For the decision track, use the Application-level JD, resume, screening, selected prior cross-round artifacts, and this Round's preparation. For a Q&A-only request, skip those decision sources unless they are needed to disambiguate a proper noun, and never use them to fill a missing answer.
5. Treat obvious ASR errors as uncertainty. Never invent missing statements or silently repair facts that affect the decision.
6. For the decision track, compare the interview with its preparation and remaining hiring questions. Explicitly distinguish areas that were not asked from actual negative evidence.

## Two-Track Execution

For a substantive transcript when both documents are requested or implied, default to two parallel subagents when delegation is available:

- **Decision subagent**: read the full evidence package and draft only the hiring-decision report. It may compare the transcript with the JD, resume, screening, preparation, and selected prior handoffs. It must keep direct evidence, reasonable inference, uncovered areas, and negative evidence distinct.
- **Q&A subagent**: read the exact Round's complete transcript and minimal Round metadata, then draft only the chronological Q&A. It must preserve the speakers' meaning, coverage, uncertainty, and sequence. It must not score the candidate, map answers to the JD, or borrow conclusions from the decision subagent.

Resolve the exact Application, Round, and transcript boundary before delegation. Give both subagents the same identifiers and source boundary. The Q&A subagent must work from the transcript, not from the decision draft.

The main agent owns orchestration and final responsibility:

1. Gather or identify the canonical evidence package.
2. Run the two subagents in parallel.
3. Check that every material decision claim is grounded in the transcript or another named source, and that the Q&A has not improved, judged, or invented answers.
4. Resolve discrepancies against the raw transcript. Never settle a conflict by choosing the more favorable draft.
5. Save the final artifacts itself; subagents return drafts and do not write concurrently to Interview Workbench.

If delegation is unavailable or the transcript is trivial, run the two tracks sequentially. If the user explicitly requests only one document, run only the relevant track. Do not block the task because subagents are unavailable.

## Judgment

Separate direct evidence, adjacent experience, unsupported claims, and missing evidence. Prefer personal ownership, concrete decisions, tradeoffs, metrics, failure analysis, and iteration after real use. For senior candidates, verify recent hands-on work separately from leadership scope.

Use the organization's rubric and decision labels when available. If no rubric exists, make a plain recommendation without pretending there is a universal scoring model. A score is optional and must agree with the written recommendation.

## Decision Report

Write in the user's language. Lead with the decision and keep evidence traceable. Avoid turning the report into a chronological recap:

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

## Interview Q&A

The Q&A is a faithful, compressed reconstruction: more detailed than a summary and easier to scan than a verbatim transcript. Keep the original order and localize the labels to the user's language when appropriate.

Use this shape when suitable:

```markdown
**Interview Q&A: Candidate | Round**

**Source note**: Based on this Round's complete transcript. Greetings, repeated filler, and obvious transcript noise are omitted; uncertain wording is marked.

## Interview flow

1. ...

## Detailed Q&A

### Q1 | Topic

**Interviewer asked**: ...

**Candidate answered**: ...

**Follow-ups**:

- **Question**: ...
- **Answer**: ...

## Candidate questions

**Candidate asked**: ...

**Interviewer answered**: ...
```

Apply these rules:

- Cover every substantive interviewer question exactly once. Merge only contiguous questions and follow-ups on the same topic; keep later questions separate when they change or deepen the evidence.
- Preserve concrete claims, personal actions, tradeoffs, failures, metrics, constraints, corrections, disagreements, and explicit non-answers. Do not upgrade a vague answer or fill it from the resume.
- Label a topic volunteered without a question as **Candidate addition** rather than inventing a question.
- Label decision-relevant context, corrections, or feedback that contain no question as **Interviewer context / feedback**, and preserve the candidate's response.
- Keep candidate questions and interviewer answers in a separate final section. Omit only greetings, scheduling, repeated filler, and obvious ASR noise.
- Treat JD text, preparation notes, or Workbench templates embedded in a local transcript file as document noise unless they are clearly part of a spoken turn.
- Include timestamps or turn ranges only when the source provides them reliably. Mark unclear attribution or wording rather than guessing.
- Paraphrase for readability while preserving the answer's detail and uncertainty. Use short quotes only when the exact wording materially helps.

Before saving, audit coverage against the raw transcript: every substantive question must appear in the Q&A, and every decision-changing example in the hiring report must be findable in the Q&A or explicitly attributed to another source.

## Workbench Artifacts

When the decision report is requested or implied, save it to the target Round with `save_interview_artifact`, kind `interview-summary`, title `Interview summary`, and `includeInCrossRoundContext: false`. Save a second Round artifact with kind `round-handoff`, with `includeInCrossRoundContext: true`, and exactly these headings:

```markdown
## Confirmed evidence

## Unresolved risks

## Contradictions

## Next-round objectives
```

When the Q&A is requested or implied, save it to the same Round with `save_interview_artifact`, kind `interview-qa`, title `Interview Q&A`, and `includeInCrossRoundContext: false`. It is a reader-facing record, not default input to later Rounds.

After saving, call `get_interview_context` again and verify every expected artifact on the exact target Round against the final draft:

- Default two-document workflow: `interview-summary`, `interview-qa`, and `round-handoff`.
- Decision-only request: `interview-summary` and `round-handoff`.
- Q&A-only request: only the newly written `interview-qa`; do not present pre-existing artifacts as outputs of the current run.

The handoff, not prior raw transcripts or full Q&A documents, is the default input to later-round preparation. Load a prior Q&A only when a decision-changing detail needs verification.

Only when the user explicitly asks for a whole-process or final hiring conclusion, synthesize all Round summaries and save it on the Application with `save_application_artifact`, kind `final-summary`, title `Final summary`, and `includeInCrossRoundContext: true`. A final-only request does not create a new Round report, Q&A, or handoff unless the user also asks for them. Do not treat an ordinary Round summary as the whole-process decision, and do not update Application status unless the user explicitly confirms it.

## Document Delivery

Treat the reader-facing reports as documents, not as an edit-review handoff. After the Workbench readback, also write standalone Markdown copies whose contents match the final reader-facing artifacts exactly.

Use a destination explicitly supplied by the user. Otherwise, write into the writable Interview Workbench workspace root; when no Workbench record exists, prefer the directory containing the supplied transcript, then the current writable directory. Use stable filenames:

- `<candidate>-<role>-<round>-interview-summary.md`
- `<candidate>-<role>-<round>-interview-qa.md`
- For an explicitly requested whole-process conclusion: `<candidate>-<role>-final-interview-summary.md`

Sanitize only characters that cannot safely appear in a filename. For the same Application and Round, update the same file instead of adding timestamps or duplicate suffixes. Materialize only the document types requested or implied; `round-handoff` remains a Workbench artifact unless the user asks for a separate file.

Verify each file exists, is non-empty, and matches the final artifact. When `open_in_codex` is available, open the reader-facing documents for preview.

The final response must include a short **Documents** section with clickable Markdown links using absolute paths. Do not use a file-change or pending-review card as the only way to reach the reports. Do not list Skill sources, internal scratch files, or Workbench database paths as report documents. Keep the response concise and do not paste both full documents into chat unless the user asks.

If no Workbench record exists, still create the requested Markdown documents when a writable destination is available. Only fall back to returning the full documents in chat when no writable document location exists.
