#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  DEFAULT_INTERVIEW_DURATION_MINUTES,
  MAX_INTERVIEW_DURATION_MINUTES,
  MIN_INTERVIEW_DURATION_MINUTES,
  isRetiredApplicationStatus,
} from "../src/interview-domain.js";
import { readAllowedResumeFile } from "./resume-path.js";

const baseUrl = String(process.env.WORKBENCH_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const accessToken = String(process.env.WORKBENCH_ACCESS_TOKEN || "").trim();
const writableApplicationStatusSchema = z.string().min(1).max(24).refine(
  (status) => !isRetiredApplicationStatus(status),
  { message: "Legacy and round statuses cannot be written as an application status" },
);

const server = new McpServer({
  name: "interview-workbench",
  version: "0.1.0",
});

server.registerTool("list_applications", {
  title: "List applications",
  description: "Find candidate application processes without loading resumes, round details, or transcripts.",
  inputSchema: {
    query: z.string().max(160).optional().describe("Candidate or role name search"),
    applicationStatus: z.string().max(24).optional().describe("Exact application status"),
    limit: z.number().int().min(1).max(200).default(50),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async (input) => toolResult(await request(`/api/applications?${queryString(input)}`)));

server.registerTool("get_application_context", {
  title: "Get application context",
  description: "Load application-wide candidate, role, resume, round summaries, unresolved items, and saved artifacts. Full round transcripts are excluded; use get_transcript_chunk for a specific round only when needed.",
  inputSchema: {
    applicationId: z.string().min(1).max(160),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ applicationId }) => toolResult(
  await request(`/api/applications/${encodeURIComponent(applicationId)}/context`),
));

server.registerTool("list_interviews", {
  title: "List interviews",
  description: "Find individual interview rounds without loading resumes or transcripts.",
  inputSchema: {
    query: z.string().max(160).optional().describe("Candidate or role name search"),
    applicationStatus: z.string().max(24).optional().describe("Exact parent application hiring status"),
    roundStatus: z.string().max(24).optional().describe("Exact round lifecycle status"),
    status: z.string().max(24).optional().describe("Deprecated alias for applicationStatus"),
    limit: z.number().int().min(1).max(200).default(50),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async (input) => toolResult(await request(`/api/interviews?${queryString(input)}`)));

server.registerTool("get_interview_context", {
  title: "Get interview context",
  description: "Load one interview round's metadata, preparation, notes, AI cards, saved artifacts, and linked sessions. Transcript lines are excluded; use get_transcript_chunk for them. Use get_application_context for cross-round context.",
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
  description: "Create a candidate application and its first interview round through the backwards-compatible interview endpoint, optionally attach a local PDF/DOC/DOCX resume, and link the current AI session to that round.",
  inputSchema: {
    name: z.string().min(1).max(160).describe("Candidate or interview name"),
    applicationStatus: writableApplicationStatusSchema.optional().describe("Application hiring status; omitted for the workbench default"),
    interviewStatus: writableApplicationStatusSchema.optional().describe("Deprecated alias for applicationStatus"),
    scheduledAt: z.string().optional().describe("ISO 8601 date-time"),
    durationMinutes: z.number().int()
      .min(MIN_INTERVIEW_DURATION_MINUTES)
      .max(MAX_INTERVIEW_DURATION_MINUTES)
      .default(DEFAULT_INTERVIEW_DURATION_MINUTES),
    roleMarkdown: z.string().max(500000).optional().describe("Job description in Markdown"),
    resumeMarkdown: z.string().max(500000).optional().describe("Resume screening or interview preparation Markdown"),
    roleName: z.string().max(300).optional(),
    roleShortName: z.string().max(40).optional().describe("Short job name used in calendars"),
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
      applicationStatus: input.applicationStatus,
      interviewStatus: input.interviewStatus,
      scheduledAt: input.scheduledAt,
      durationMinutes: input.durationMinutes,
      roleMarkdown: input.roleMarkdown,
      resumeMarkdown: input.resumeMarkdown,
      jdDraftName: input.roleName,
      roleShortName: input.roleShortName,
    },
  });
  let resumeFile = null;
  if (input.resumePath) resumeFile = await uploadResume(created.interview.id, input.resumePath);
  const session = resolveSession(input);
  let linkedSession = null;
  if (session) linkedSession = await linkSession(created.interview.id, session);
  return toolResult({
    application: created.application || null,
    interview: created.interview,
    resumeFile,
    linkedSession,
  });
});

server.registerTool("create_interview_round", {
  title: "Create interview round",
  description: "Add a new interview round to an existing candidate application without duplicating its resume or job description.",
  inputSchema: {
    applicationId: z.string().min(1).max(160),
    roundLabel: z.string().min(1).max(80).describe("Round name, for example 一面、二面 or 终面"),
    scheduledAt: z.string().optional().describe("ISO 8601 date-time"),
    durationMinutes: z.number().int()
      .min(MIN_INTERVIEW_DURATION_MINUTES)
      .max(MAX_INTERVIEW_DURATION_MINUTES)
      .default(DEFAULT_INTERVIEW_DURATION_MINUTES),
    roundFocus: z.string().max(10000).optional().describe("Goals and unresolved items for this round"),
    roundStatus: z.string().max(24).optional().describe("Round lifecycle status; omitted to let the workbench infer it from scheduledAt"),
  },
  annotations: { destructiveHint: false, openWorldHint: false },
}, async ({ applicationId, ...round }) => {
  const created = await request(`/api/applications/${encodeURIComponent(applicationId)}/rounds`, {
    method: "POST",
    body: round,
  });
  return toolResult({
    application: applicationToolSummary(created.application),
    interview: interviewRoundToolSummary(created.interview),
  });
});

server.registerTool("save_application_artifact", {
  title: "Save application artifact",
  description: "Save or replace an application-wide Markdown artifact, such as a cross-round handoff, unresolved-item summary, or final decision.",
  inputSchema: {
    applicationId: z.string().min(1).max(160),
    kind: z.string().regex(/^[a-z0-9._-]+$/).max(80),
    title: z.string().max(200).optional(),
    markdown: z.string().min(1).max(1000000),
    includeInCrossRoundContext: z.boolean().optional().describe("Whether this artifact should be included automatically in later rounds; required for a new custom kind"),
    harness: z.string().max(40).optional(),
    sessionId: z.string().max(200).optional(),
  },
  annotations: { destructiveHint: false, openWorldHint: false },
}, async (input) => {
  const session = resolveSession(input);
  return toolResult(await request(
    `/api/applications/${encodeURIComponent(input.applicationId)}/artifacts/${encodeURIComponent(input.kind)}`,
    {
      method: "PUT",
      body: {
        title: input.title,
        markdown: input.markdown,
        includeInCrossRoundContext: input.includeInCrossRoundContext,
        sourceHarness: session?.harness || "",
        sourceSessionId: session?.sessionId || "",
      },
    },
  ));
});

server.registerTool("save_interview_artifact", {
  title: "Save interview artifact",
  description: "Save or replace a round-specific Markdown artifact, such as interview preparation, round handoff, or interview summary. Use save_application_artifact for resume screening and process-wide conclusions.",
  inputSchema: {
    interviewId: z.string().min(1).max(160),
    kind: z.string().regex(/^[a-z0-9._-]+$/).max(80),
    title: z.string().max(200).optional(),
    markdown: z.string().min(1).max(1000000),
    includeInCrossRoundContext: z.boolean().optional().describe("Whether this artifact should be included automatically in later rounds; required for a new custom kind"),
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
        includeInCrossRoundContext: input.includeInCrossRoundContext,
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

server.registerTool("update_application_status", {
  title: "Update application status",
  description: "Update the hiring status of a candidate application only after the user has explicitly chosen or approved it.",
  inputSchema: {
    applicationId: z.string().min(1).max(160),
    applicationStatus: writableApplicationStatusSchema,
  },
  annotations: { destructiveHint: false, openWorldHint: false },
}, async ({ applicationId, applicationStatus }) => toolResult(
  await request(`/api/applications/${encodeURIComponent(applicationId)}`, {
    method: "PATCH",
    body: { applicationStatus },
  }),
));

server.registerTool("update_interview_round", {
  title: "Update interview round",
  description: "Update round-owned schedule, duration, lifecycle, focus, or outcome without changing the parent application's hiring status.",
  inputSchema: {
    interviewId: z.string().min(1).max(160),
    scheduledAt: z.string().optional().describe("ISO 8601 date-time"),
    durationMinutes: z.number().int()
      .min(MIN_INTERVIEW_DURATION_MINUTES)
      .max(MAX_INTERVIEW_DURATION_MINUTES)
      .optional(),
    roundStatus: z.string().max(24).optional(),
    outcome: z.string().max(80).optional(),
    roundFocus: z.string().max(500000).optional(),
  },
  annotations: { destructiveHint: false, openWorldHint: false },
}, async ({ interviewId, ...patch }) => {
  const body = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  if (!Object.keys(body).length) throw new Error("At least one round field is required");
  return toolResult(await request(`/api/interviews/${encodeURIComponent(interviewId)}`, {
    method: "PATCH",
    body,
  }));
});

server.registerTool("update_interview_status", {
  title: "Update application status by interview",
  description: "Deprecated compatibility tool: update the parent application's hiring status through an interview-round ID. Use update_interview_round for round lifecycle and outcome.",
  inputSchema: {
    interviewId: z.string().min(1).max(160),
    interviewStatus: writableApplicationStatusSchema,
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
  const file = readAllowedResumeFile(resumePath);
  const dataUrl = `data:${file.type};base64,${file.bytes.toString("base64")}`;
  return request(`/api/interviews/${encodeURIComponent(interviewId)}/resume`, {
    method: "PUT",
    body: {
      resumeFile: {
        name: file.name,
        type: file.type,
        size: file.size,
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

function applicationToolSummary(application) {
  if (!application) return null;
  return {
    id: application.id,
    name: application.name,
    applicationStatus: application.applicationStatus,
    jdDraftName: application.jdDraftName,
    roleShortName: application.roleShortName,
    roundCount: application.roundCount ?? application.rounds?.length ?? 0,
    updatedAt: application.updatedAt,
  };
}

function interviewRoundToolSummary(interview) {
  if (!interview) return null;
  return {
    id: interview.id,
    applicationId: interview.applicationId,
    roundOrder: interview.roundOrder,
    roundLabel: interview.roundLabel,
    roundStatus: interview.roundStatus,
    outcome: interview.outcome,
    roundFocus: interview.roundFocus,
    roleShortName: interview.roleShortName,
    scheduledAt: interview.scheduledAt,
    durationMinutes: interview.durationMinutes,
    createdAt: interview.createdAt,
    updatedAt: interview.updatedAt,
  };
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
