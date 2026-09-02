---
name: interview-create-session
description: "Create a new Interview Workbench application or add a round to an existing candidate-and-role application, including shared JD and resume evidence plus round-specific schedule, focus, and preparation. Use when the user asks to create, schedule, register, or continue an interview process without operating the web UI."
---

# Create Interview Application or Round

Use the workbench's **Application → InterviewRound** model. An Application is one candidate's hiring process for one role; each interview is a separate Round inside it.

## Data Boundaries

- Application owns the candidate, target role and JD, shared resume, hiring status, resume screening, and whole-process conclusion.
- Round owns its label, schedule, lifecycle status, focus, preparation, transcript, AI cards, notes, linked AI sessions, summary, and handoff.

Do not copy Round-owned evidence into a new Round. Cross-round context must come from saved summaries and handoffs.

## Workflow

1. Resolve the candidate name and target role from the request and available files. Search with `list_applications` before creating anything, then match on **both** candidate and role. Never merge by name alone.
2. If several Applications or Rounds remain plausible, state the ambiguity and ask for the exact target instead of choosing silently.
3. For a new hiring process, call `create_interview`. It creates the Application and first Round. Use `applicationStatus` only when the user supplied or approved a hiring status; otherwise the workbench defaults to `招聘中`. Convert the schedule to ISO 8601 while preserving the user's timezone intent, and pass the planned `durationMinutes` when known. Pass a local PDF, DOC, or DOCX path as `resumePath` when available. Resume files must be under the user's Downloads, Documents, or Desktop directory, or a directory listed in `WORKBENCH_RESUME_ROOTS`.
4. For another Round in an existing process, first load `get_application_context`, verify the candidate and role, then call `create_interview_round`. Supply only Round-owned fields such as `applicationId`, `roundLabel`, `scheduledAt`, `durationMinutes`, `roundFocus`, and `roundStatus`; do not overwrite Application status, JD, resume, or screening through a Round creation request.
5. Link the current Codex, Claude Code, or WorkBuddy session to the created Round when its session identifier is available.
6. Save screening with `save_application_artifact` as `resume-screening` and `includeInCrossRoundContext: false`. Save preparation with `save_interview_artifact` as `interview-preparation` on the exact target Round, also with `includeInCrossRoundContext: false`.
7. Verify the result with `get_application_context` and `get_interview_context`. A newly added Round must start without transcript lines, AI cards, or linked sessions other than the session just linked for this task.

Do not place API keys, access tokens, or private configuration inside the record. Do not create a second Application when an exact candidate-and-role Application already exists unless the user explicitly starts a separate hiring process.

Report the candidate, role, Application ID and status, Round ID and label, schedule, attachment result, and saved artifacts.
