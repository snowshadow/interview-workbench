# AI Harness integration

Interview Workbench exposes a local stdio MCP server and four portable Agent Skills. This lets an AI coding harness read interview context, create sessions, consume long transcripts in chunks, and write Markdown artifacts back without manual export.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `list_interviews` | Find a session without loading private content |
| `get_interview_context` | Read JD, resume analysis, notes, follow-ups, artifacts, and linked sessions |
| `get_transcript_chunk` | Read the transcript chronologically in bounded pages |
| `create_interview` | Create a session and optionally attach a local resume |
| `save_interview_artifact` | Save or replace screening, preparation, or summary Markdown |
| `link_harness_session` | Associate a harness session with an interview |
| `update_interview_status` | Change status only after explicit user approval |

The workbench service must be running before the MCP server is used:

```bash
npm run build
npm start
```

Use an absolute repository path in the commands below.

## Codex

```bash
codex mcp add interview-workbench \
  --env WORKBENCH_URL=http://127.0.0.1:8787 \
  -- node /absolute/path/to/interview-workbench/mcp/server.mjs

node scripts/install-skills.mjs codex
```

When `CODEX_THREAD_ID` is available, created interviews and saved artifacts are automatically linked to the current Codex session.

## Claude Code

```bash
claude mcp add --scope user interview-workbench \
  -e WORKBENCH_URL=http://127.0.0.1:8787 \
  -- node /absolute/path/to/interview-workbench/mcp/server.mjs

node scripts/install-skills.mjs claude
```

Claude Code can also use a project copy under `.claude/skills/`.

## WorkBuddy and other harnesses

Create a local **MCP + CLI** connector with:

```text
Command: node
Arguments: /absolute/path/to/interview-workbench/mcp/server.mjs
Environment: WORKBENCH_URL=http://127.0.0.1:8787
```

Import the folders under `skills/` through the harness's local Skill interface. If it accepts a filesystem destination, install a copy with:

```bash
node scripts/install-skills.mjs custom --target-dir /path/to/harness/skills
```

## Access token

For a non-loopback workbench, pass the same token to the MCP process without placing it in Skill files:

```text
WORKBENCH_ACCESS_TOKEN=your-local-secret
```

The stdio MCP server does not expose a network listener. It calls the workbench REST API, so the existing host, origin, and access-token rules still apply.

## No-export summary flow

After an interview, ask the harness to run `interview-summary` for the candidate or interview ID. The Skill:

1. finds the exact session;
2. reads the JD, resume analysis, preparation artifacts, notes, and AI follow-ups;
3. consumes every transcript chunk;
4. produces an evidence-based hiring report;
5. saves it back as the `interview-summary` artifact.

It does not change the interview status unless the user explicitly approves a new status.
