---
name: interview-preparation
description: "Prepare a concise, evidence-driven plan for one Interview Workbench round from Application-level JD, resume, and screening evidence plus selected prior-round handoffs. Use for first-round or later-round preparation, candidate-specific questions, unresolved risks, round focus, or saving a plan to the exact target Round."
---

# Interview Preparation

Prepare an interview plan, not another resume screen. The goal is to reveal whether the candidate's claimed experience transfers to the target role.

## Workflow

1. Find the hiring process with `list_applications`, matching candidate and role together, then load `get_application_context`. Select the exact Round and load it with `get_interview_context`. If several Applications or Rounds remain plausible, do not guess.
2. Read the Application-level JD, resume evidence, and `resume-screening`. Use the target Round's label, schedule, focus, notes, and existing artifacts as the current boundary.
3. For a later Round, use selected prior `round-handoff` and `interview-summary` artifacts. Carry forward only confirmed evidence, unresolved risks, contradictions, and next-round objectives. Do not read every earlier raw transcript unless a decision-changing fact cannot be resolved from the curated artifacts.
4. Choose the two or three points that can still change the hiring decision. Avoid re-testing evidence already established in an earlier Round.
5. Build a short interview path. Each section should state what it verifies, the main question, necessary follow-ups, and pass/risk signals.
6. Include important JD areas that still have no evidence, but do not turn the accumulated gap list into a full re-interview.

## Round Calibration

- A first Round may cover a broader evidence base: project reality, personal ownership, role fit, and the most important domain depth.
- A later Round should focus on remaining uncertainty and its explicit `roundFocus`. Unless the user specifies otherwise, keep a second Round within 30 minutes and two or three decision-changing points.
- Favor cognition, methodology, priorities, and tradeoffs when prior Rounds already established the project facts. Add another deep technical check only when it is the decisive unknown.

Questions should start from the candidate's own claims. Replace generic prompts such as "tell me about the project" with requests for a complete path, personal boundary, tradeoff, metric, failure, and iteration.

For senior candidates, explicitly test recent hands-on work. Management scope alone is not evidence of personal depth.

## Output

Write in the user's language and keep it usable during a live interview:

```markdown
**Interview objective**: ...

**Suggested flow**: ...

**Project deep dives**: ...

**Coverage gaps**: ...

**Pass and risk signals**: ...
```

When a target Round exists, save the final Markdown there with `save_interview_artifact`, kind `interview-preparation`, and title `Interview preparation`. Do not save Round preparation on the Application, copy it to another Round, or change hiring status.
