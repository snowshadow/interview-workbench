#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const baseUrl = String(process.env.WORKBENCH_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const accessToken = String(process.env.WORKBENCH_ACCESS_TOKEN || "").trim();

const server = new McpServer({
  name: "interview-workbench",
  version: "0.1.0",
});

server.registerTool("list_interviews", {
  title: "List interviews",
  description: "Find interview sessions without loading resumes or transcripts.",
  inputSchema: {
    query: z.string().max(160).optional().describe("Candidate or role name search"),
    status: z.string().max(24).optional().describe("Exact interview status"),
    limit: z.number().int().min(1).max(200).default(50),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async (input) => toolResult(await request(`/api/interviews?${queryString(input)}`)));

server.registerTool("get_interview_context", {
  title: "Get interview context",
  description: "Load interview metadata, JD, resume analysis, notes, AI cards, saved artifacts, and linked sessions. Transcript lines are excluded; use get_transcript_chunk for them.",
  inputSchema: {
    interviewId: z.string().min(1).max(160),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ interviewId }) => toolResult(
  await request(`/api/interviews/${encodeURIComponent(interviewId)}/context`),
));

server.registerTool("get_transcript_chunk", {
  title: "Get transcript chunk",
  description: "Read a transcript in bounded chronological chunks. Continue with nextOffset until it is null.",
  inputSchema: {
    interviewId: z.string().min(1).max(160),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(200),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ interviewId, offset, limit }) => toolResult(
  await request(
    `/api/interviews/${encodeURIComponent(interviewId)}/transcript?${queryString({ offset, limit })}`,
  ),
));

server.registerTool("create_interview", {
  title: "Create interview",
  description: "Create an interview session, optionally attach a local PDF/DOC/DOCX resume, and link the current AI session.",
  inputSchema: {
    name: z.string().min(1).max(160).describe("Candidate or interview name"),
    interviewStatus: z.string().max(24).default("未面"),
    scheduledAt: z.string().optional().describe("ISO 8601 date-time"),
    roleMarkdown: z.string().max(500000).optional().describe("Job description in Markdown"),
    resumeMarkdown: z.string().max(500000).optional().describe("Resume screening or interview preparation Markdown"),
    roleName: z.string().max(300).optional(),
    resumePath: z.string().max(2000).optional().describe("Local PDF, DOC, or DOCX path"),
    harness: z.string().max(40).optional(),
    sessionId: z.string().max(200).optional(),
  },
  annotations: { destructiveHint: false, openWorldHint: false },
}, async (input) => {
  const created = await request("/api/interviews", {
    method: "POST",
    body: {
      name: input.name,
      interviewStatus: input.interviewStatus,
      scheduledAt: input.scheduledAt,
      roleMarkdown: input.roleMarkdown,
      resumeMarkdown: input.resumeMarkdown,
      jdDraftName: input.roleName,
    },
  });
  let resumeFile = null;
  if (input.resumePath) resumeFile = await uploadResume(created.interview.id, input.resumePath);
  const session = resolveSession(input);
  let linkedSession = null;
  if (session) linkedSession = await linkSession(created.interview.id, session);
  return toolResult({ interview: created.interview, resumeFile, linkedSession });
});

server.registerTool("save_interview_artifact", {
  title: "Save interview artifact",
  description: "Save or replace a Markdown artifact for an interview, such as resume screening, interview preparation, or interview summary.",
  inputSchema: {
    interviewId: z.string().min(1).max(160),
    kind: z.string().regex(/^[a-z0-9._-]+$/).max(80),
    title: z.string().max(200).optional(),
    markdown: z.string().min(1).max(1000000),
    harness: z.string().max(40).optional(),
    sessionId: z.string().max(200).optional(),
  },
  annotations: { destructiveHint: false, openWorldHint: false },
}, async (input) => {
  const session = resolveSession(input);
  const result = await request(
    `/api/interviews/${encodeURIComponent(input.interviewId)}/artifacts/${encodeURIComponent(input.kind)}`,
    {
      method: "PUT",
      body: {
        title: input.title,
        markdown: input.markdown,
        sourceHarness: session?.harness || "",
        sourceSessionId: session?.sessionId || "",
      },
    },
  );
  if (session) await linkSession(input.interviewId, session);
  return toolResult(result);
});

server.registerTool("link_harness_session", {
  title: "Link AI session",
  description: "Associate a Codex, Claude Code, WorkBuddy, or other AI Harness session with an interview.",
  inputSchema: {
    interviewId: z.string().min(1).max(160),
    harness: z.string().regex(/^[a-z0-9._-]+$/).max(40),
    sessionId: z.string().min(1).max(200),
    label: z.string().max(160).optional(),
    cwd: z.string().max(1000).optional(),
    isPrimary: z.boolean().default(true),
  },
  annotations: { destructiveHint: false, openWorldHint: false },
}, async ({ interviewId, ...session }) => toolResult(
  await linkSession(interviewId, session),
));

server.registerTool("update_interview_status", {
  title: "Update interview status",
  description: "Update an interview status only after the user has explicitly chosen or approved it.",
  inputSchema: {
    interviewId: z.string().min(1).max(160),
    interviewStatus: z.string().min(1).max(24),
  },
  annotations: { destructiveHint: false, openWorldHint: false },
}, async ({ interviewId, interviewStatus }) => toolResult(
  await request(`/api/interviews/${encodeURIComponent(interviewId)}`, {
    method: "PATCH",
    body: { interviewStatus },
  }),
));

async function request(resource, options = {}) {
  const headers = { Accept: "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (options.body) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(`${baseUrl}${resource}`, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    throw new Error(`Interview Workbench is unavailable at ${baseUrl}: ${error.message}`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Workbench request failed (${response.status})`);
  return data;
}

async function uploadResume(interviewId, resumePath) {
  const absolutePath = path.resolve(resumePath);
  const extension = path.extname(absolutePath).toLowerCase();
  const types = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  if (!types[extension]) throw new Error("Resume must be a PDF, DOC, or DOCX file");
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile() || stat.size < 1 || stat.size > 10 * 1024 * 1024) {
    throw new Error("Resume must be a file between 1 byte and 10MB");
  }
  const dataUrl = `data:${types[extension]};base64,${fs.readFileSync(absolutePath).toString("base64")}`;
  return request(`/api/interviews/${encodeURIComponent(interviewId)}/resume`, {
    method: "PUT",
    body: {
      resumeFile: {
        name: path.basename(absolutePath),
        type: types[extension],
        size: stat.size,
        dataUrl,
      },
    },
  });
}

function resolveSession(input = {}) {
  if (input.harness && input.sessionId) {
    return {
      harness: input.harness,
      sessionId: input.sessionId,
      cwd: process.cwd(),
      isPrimary: true,
    };
  }
  const detected = [
    ["codex", process.env.CODEX_THREAD_ID],
    ["claude", process.env.CLAUDE_SESSION_ID],
    ["workbuddy", process.env.WORKBUDDY_SESSION_ID],
  ].find(([, sessionId]) => sessionId);
  return detected
    ? { harness: detected[0], sessionId: detected[1], cwd: process.cwd(), isPrimary: true }
    : null;
}

async function linkSession(interviewId, session) {
  return request(`/api/interviews/${encodeURIComponent(interviewId)}/harness-sessions`, {
    method: "POST",
    body: session,
  });
}

function queryString(input) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input || {})) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  return params.toString();
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
