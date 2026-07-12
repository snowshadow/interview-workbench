---
name: interview-resume-screening
description: Screen a candidate resume against a job description and produce an evidence-based hiring recommendation. Use when the user asks for resume screening, JD matching, candidate fit, hiring risks, whether to interview, or wants the result saved to Interview Workbench.
---

# Resume Screening

Evaluate the candidate against the actual work in the JD. Do not summarize the resume for its own sake and do not score keyword overlap.

## Workflow

1. Read the JD and resume from their source files. If an Interview Workbench session is named, use `list_interviews` and `get_interview_context` first.
2. Separate the JD into must-haves, differentiators, and points that need interview evidence.
3. Identify what the resume proves about ownership, scope, technical or functional depth, outcomes, and recent hands-on work.
4. Separate **direct evidence** from **adjacent evidence**. Titles, team size, product names, and fashionable terms are not proof by themselves.
5. Make a clear recommendation before explaining it. State important uncertainty plainly.

Prefer evidence that is hard to fake: a complete system or business path, personal decisions, metrics with baselines, failure cases, tradeoffs, and changes made after real use. For senior candidates, distinguish leadership scope from recent hands-on ability.

## Output

Write in the user's language. Keep the report concise and decision-led:

```markdown
**Recommendation**: ...

**Strong evidence**: ...

**Gaps and risks**: ...

**What to verify in interview**: ...
```

Use the organization's own decision labels when supplied. Do not invent a universal score or hiring threshold.

When an interview session exists, save the final Markdown with `save_interview_artifact` using kind `resume-screening` and title `Resume screening`. Do not change interview status unless the user explicitly asks.
