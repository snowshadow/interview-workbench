---
name: interview-preparation
description: Prepare a concise, evidence-driven interview plan from a JD, resume, screening notes, and organization rubric. Use when the user asks for interview preparation, interview questions, a candidate-specific interview outline, risks to verify, or wants the plan saved to Interview Workbench.
---

# Interview Preparation

Prepare an interview plan, not another resume screen. The goal is to reveal whether the candidate's claimed experience transfers to the target role.

## Workflow

1. If the interview is already in Interview Workbench, find it with `list_interviews` and load it with `get_interview_context`.
2. Read the JD, resume evidence, and the `resume-screening` artifact when present.
3. Choose the two or three claims or projects that most affect the hiring decision.
4. Build a short interview path. Each section should state what it verifies, the main question, details that must be forced, and pass/risk signals.
5. Include important JD areas that have no resume evidence so they are not forgotten.

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

When an interview session exists, save the final Markdown with `save_interview_artifact` using kind `interview-preparation` and title `Interview preparation`.
