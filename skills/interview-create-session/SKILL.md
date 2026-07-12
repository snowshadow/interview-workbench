---
name: interview-create-session
description: Create an Interview Workbench session from an AI coding harness, including candidate name, status, schedule, JD, preparation notes, resume analysis, and a local PDF/DOC/DOCX resume. Use when the user asks to create, schedule, or register an interview without operating the web UI.
---

# Create Interview Session

Create the workbench record without asking the user to repeat information already available in files or conversation.

## Workflow

1. Resolve the candidate or session name. This is the only required field.
2. Use the supplied status. Otherwise default to `未面`; a custom status is allowed.
3. Convert scheduled time to an ISO 8601 value while preserving the user's timezone intent.
4. Read the target JD and preparation material, then pass their Markdown to `create_interview`.
5. Pass a local PDF, DOC, or DOCX path as `resumePath` when available.
6. The MCP server links the current Codex, Claude Code, or WorkBuddy session when its session identifier is available.
7. If separate screening or preparation reports already exist, save them with `save_interview_artifact` as `resume-screening` and `interview-preparation` after creation.

Do not place API keys, access tokens, or private configuration inside the interview record. Do not create duplicate sessions when `list_interviews` shows an obvious exact match; ask before replacing or duplicating it.

Report the created interview ID, name, status, scheduled time, attachment result, and which artifacts were saved.
