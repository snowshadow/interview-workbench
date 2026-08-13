---
name: interview-resume-screening
description: "Screen a resume against a JD and produce an evidence-based recommendation shared by the whole Interview Workbench Application. Use for resume screening, JD fit, hiring risks, whether to interview, or saving reusable screening evidence across all Rounds for the exact candidate-and-role process."
---

# Resume Screening

Evaluate the candidate against the actual work in the JD. Do not summarize the resume for its own sake and do not score keyword overlap.

## Workflow

1. Read the JD and resume from their source files. If an Interview Workbench record is named, use `list_applications` and `get_application_context` first. Match on both candidate and target role; never merge same-name Applications for different roles.
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

Resume screening belongs to the Application, not an individual Round. When one exact candidate-and-role Application exists, save the final Markdown with `save_application_artifact`, kind `resume-screening`, and title `Resume screening`, then verify it through `get_application_context`.

Do not create a Round merely to store screening. If no exact Application exists, return the result without attaching it to a guessed record. Do not change Application status unless the user explicitly asks.
