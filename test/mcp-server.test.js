import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP server exposes application and interview-round workflows", async () => {
  const state = {
    application: null,
    interview: null,
    applicationArtifacts: [],
    interviewArtifacts: [],
    sessions: [],
    interviewListQueries: [],
  };
  const api = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const body = await readJson(req);
    res.setHeader("Content-Type", "application/json");

    if (req.method === "GET" && url.pathname === "/api/applications") {
      return send(res, { applications: state.application ? [state.application] : [] });
    }
    if (req.method === "GET" && url.pathname === "/api/applications/application-1/context") {
      return send(res, {
        application: {
          ...state.application,
          artifacts: state.applicationArtifacts,
          rounds: state.interview ? [state.interview] : [],
        },
      });
    }
    if (req.method === "POST" && url.pathname === "/api/applications/application-1/rounds") {
      state.interview = {
        id: "round-2",
        applicationId: "application-1",
        roundOrder: 2,
        ...body,
        resumeMarkdown: "private current-candidate resume",
      };
      return send(res, {
        application: {
          ...state.application,
          resumeMarkdown: "private current-candidate resume",
          rounds: [state.interview],
        },
        interview: state.interview,
        store: { interviews: [{ name: "unrelated candidate" }] },
      }, 201);
    }
    if (req.method === "PUT" && url.pathname === "/api/applications/application-1/artifacts/application-handoff") {
      const artifact = {
        id: "application-artifact-1",
        applicationId: "application-1",
        kind: "application-handoff",
        ...body,
      };
      state.applicationArtifacts = [artifact];
      return send(res, { artifact });
    }
    if (req.method === "PATCH" && url.pathname === "/api/applications/application-1") {
      state.application = { ...state.application, ...body };
      return send(res, { application: state.application });
    }
    if (req.method === "GET" && url.pathname === "/api/interviews") {
      state.interviewListQueries.push(Object.fromEntries(url.searchParams));
      return send(res, { interviews: state.interview ? [state.interview] : [] });
    }
    if (req.method === "POST" && url.pathname === "/api/interviews") {
      state.application = {
        id: "application-1",
        name: body.name,
        applicationStatus: body.applicationStatus || body.interviewStatus || "招聘中",
        jdDraftName: body.jdDraftName,
        roleShortName: body.roleShortName,
      };
      state.interview = {
        id: "round-1",
        applicationId: "application-1",
        roundOrder: 1,
        roundLabel: "一面",
        ...body,
        artifacts: [],
        harnessSessions: [],
      };
      return send(res, { application: state.application, interview: state.interview }, 201);
    }
    if (req.method === "GET" && url.pathname === "/api/interviews/round-2/context") {
      return send(res, {
        interview: {
          ...state.interview,
          artifacts: state.interviewArtifacts,
          harnessSessions: state.sessions,
        },
      });
    }
    if (req.method === "GET" && url.pathname === "/api/interviews/round-2/transcript") {
      return send(res, { interviewId: "round-2", total: 0, nextOffset: null, lines: [] });
    }
    const harnessMatch = url.pathname.match(/^\/api\/interviews\/(round-[12])\/harness-sessions$/);
    if (req.method === "POST" && harnessMatch) {
      const session = { id: "session-1", interviewId: harnessMatch[1], ...body };
      state.sessions = [session];
      return send(res, { session }, 201);
    }
    if (req.method === "PUT" && url.pathname === "/api/interviews/round-2/artifacts/interview-summary") {
      const artifact = { id: "artifact-1", interviewId: "round-2", kind: "interview-summary", ...body };
      state.interviewArtifacts = [artifact];
      return send(res, { artifact });
    }
    if (req.method === "PATCH" && url.pathname === "/api/interviews/round-2") {
      if (body.interviewStatus) {
        state.application = { ...state.application, applicationStatus: body.interviewStatus };
      } else {
        state.interview = { ...state.interview, ...body };
      }
      return send(res, { application: state.application, interview: state.interview });
    }
    return send(res, { error: "Not found" }, 404);
  });

  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  const client = new Client({ name: "mcp-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["mcp/server.mjs"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      WORKBENCH_URL: `http://127.0.0.1:${address.port}`,
      CODEX_THREAD_ID: "test-thread",
    },
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      [
        "list_applications",
        "get_application_context",
        "list_interviews",
        "get_interview_context",
        "get_transcript_chunk",
        "create_interview",
        "create_interview_round",
        "save_application_artifact",
        "save_interview_artifact",
        "link_harness_session",
        "update_application_status",
        "update_interview_round",
        "update_interview_status",
      ],
    );

    for (const applicationStatus of ["   ", null, 42]) {
      await expectToolInputError(client, "create_interview", {
        name: "Invalid Status Candidate", applicationStatus,
      });
    }
    assert.equal(state.application, null);

    for (const args of [
      { name: "Restored Status Candidate", applicationStatus: "一面通过" },
      { name: "Restored Status Candidate", applicationStatus: "二面通过" },
      { name: "Restored Status Candidate", interviewStatus: "未面" },
    ]) {
      const restored = await call(client, "create_interview", args);
      assert.equal(restored.application.applicationStatus, args.applicationStatus || args.interviewStatus);
    }

    const created = await call(client, "create_interview", {
      name: "Synthetic Candidate",
      applicationStatus: "招聘中",
      durationMinutes: 90,
      roleName: "量化策略研究负责人",
      roleShortName: "量化",
      roleMarkdown: "# Role",
    });
    assert.equal(created.linkedSession.session.sessionId, "test-thread");
    assert.equal(created.application.id, "application-1");
    assert.equal(created.application.jdDraftName, "量化策略研究负责人");
    assert.equal(created.application.roleShortName, "量化");
    assert.equal(created.interview.applicationId, "application-1");
    assert.equal(created.interview.roleShortName, "量化");
    assert.equal(created.interview.durationMinutes, 90);

    const applications = await call(client, "list_applications", {
      query: "Synthetic",
      applicationStatus: "招聘中",
    });
    assert.equal(applications.applications[0].id, "application-1");

    await call(client, "list_interviews", {
      applicationStatus: "招聘中",
      roundStatus: "已安排",
    });
    assert.deepEqual(state.interviewListQueries.at(-1), {
      applicationStatus: "招聘中",
      roundStatus: "已安排",
      limit: "50",
    });

    const nextRound = await call(client, "create_interview_round", {
      applicationId: "application-1",
      roundLabel: "二面",
      scheduledAt: "2026-08-08T02:00:00.000Z",
      durationMinutes: 45,
      roundFocus: "验证一面遗留的上线 ownership",
      roundStatus: "已安排",
    });
    assert.equal(nextRound.interview.roundLabel, "二面");
    assert.equal(nextRound.interview.roundFocus, "验证一面遗留的上线 ownership");
    assert.equal(nextRound.interview.durationMinutes, 45);
    assert.equal("resumeMarkdown" in nextRound.interview, false);
    assert.equal("resumeMarkdown" in nextRound.application, false);
    assert.equal("store" in nextRound, false);

    await call(client, "save_application_artifact", {
      applicationId: "application-1",
      kind: "application-handoff",
      markdown: "# 跨轮交接\n\n## 未验证项\n\n- 上线 ownership",
      includeInCrossRoundContext: true,
    });

    await call(client, "save_interview_artifact", {
      interviewId: "round-2",
      kind: "interview-summary",
      markdown: "# Decision\n\nProceed.",
      includeInCrossRoundContext: false,
    });
    const context = await call(client, "get_interview_context", {
      interviewId: "round-2",
    });
    assert.equal(context.interview.artifacts[0].sourceSessionId, "test-thread");
    assert.equal(context.interview.artifacts[0].includeInCrossRoundContext, false);
    assert.equal(context.interview.harnessSessions[0].sessionId, "test-thread");

    const applicationContext = await call(client, "get_application_context", {
      applicationId: "application-1",
    });
    assert.equal(applicationContext.application.rounds[0].id, "round-2");
    assert.equal(applicationContext.application.artifacts[0].sourceSessionId, "test-thread");
    assert.equal(applicationContext.application.artifacts[0].includeInCrossRoundContext, true);

    const roundUpdated = await call(client, "update_interview_round", {
      interviewId: "round-2",
      durationMinutes: 75,
      roundStatus: "已结束",
      outcome: "通过",
    });
    assert.equal(roundUpdated.interview.durationMinutes, 75);
    assert.equal(roundUpdated.interview.roundStatus, "已结束");
    assert.equal(roundUpdated.interview.outcome, "通过");
    assert.equal(roundUpdated.application.applicationStatus, "招聘中");

    const updated = await call(client, "update_application_status", {
      applicationId: "application-1",
      applicationStatus: "通过",
    });
    assert.equal(updated.application.applicationStatus, "通过");

    for (const applicationStatus of ["未面", "已安排", "面试中", "已面待定", "一面通过", "二面通过", "二面未通过", "offer"]) {
      const restored = await call(client, "update_application_status", {
        applicationId: "application-1", applicationStatus,
      });
      assert.equal(restored.application.applicationStatus, applicationStatus);
      assert.equal(state.interview.roundStatus, "已结束");
      assert.equal(state.interview.outcome, "通过");
    }

    const restoredAlias = await call(client, "update_interview_status", {
      interviewId: "round-2",
      interviewStatus: "二面未通过",
    });
    assert.equal(restoredAlias.application.applicationStatus, "二面未通过");
    assert.equal(restoredAlias.interview.roundStatus, "已结束");
    assert.equal(restoredAlias.interview.outcome, "通过");

    await expectToolInputError(client, "update_application_status", {
      applicationId: "application-1", applicationStatus: "   ",
    });
    await expectToolInputError(client, "update_interview_status", {
      interviewId: "round-2", interviewStatus: null,
    });
    assert.equal(state.application.applicationStatus, "二面未通过");

    const legacyUpdated = await call(client, "update_interview_status", {
      interviewId: "round-2",
      interviewStatus: "未通过",
    });
    assert.equal(legacyUpdated.application.applicationStatus, "未通过");
  } finally {
    await client.close();
    await new Promise((resolve) => api.close(resolve));
  }
});

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse(result.content[0].text);
}

async function expectToolInputError(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true);
  assert.match(
    result.content.map((item) => item.text || "").join("\n"),
    /Input validation error/,
  );
}

function send(res, body, status = 200) {
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (!["POST", "PUT", "PATCH"].includes(req.method)) return {};
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
