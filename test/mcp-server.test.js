import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP server exposes the no-export interview workflow", async () => {
  const state = {
    interview: null,
    artifacts: [],
    sessions: [],
  };
  const api = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const body = await readJson(req);
    res.setHeader("Content-Type", "application/json");

    if (req.method === "GET" && url.pathname === "/api/interviews") {
      return send(res, { interviews: state.interview ? [state.interview] : [] });
    }
    if (req.method === "POST" && url.pathname === "/api/interviews") {
      state.interview = { id: "candidate-1", ...body, artifacts: [], harnessSessions: [] };
      return send(res, { interview: state.interview }, 201);
    }
    if (req.method === "GET" && url.pathname === "/api/interviews/candidate-1/context") {
      return send(res, {
        interview: {
          ...state.interview,
          artifacts: state.artifacts,
          harnessSessions: state.sessions,
        },
      });
    }
    if (req.method === "GET" && url.pathname === "/api/interviews/candidate-1/transcript") {
      return send(res, { interviewId: "candidate-1", total: 0, nextOffset: null, lines: [] });
    }
    if (req.method === "POST" && url.pathname === "/api/interviews/candidate-1/harness-sessions") {
      const session = { id: "session-1", interviewId: "candidate-1", ...body };
      state.sessions = [session];
      return send(res, { session }, 201);
    }
    if (req.method === "PUT" && url.pathname === "/api/interviews/candidate-1/artifacts/interview-summary") {
      const artifact = { id: "artifact-1", interviewId: "candidate-1", kind: "interview-summary", ...body };
      state.artifacts = [artifact];
      return send(res, { artifact });
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
        "list_interviews",
        "get_interview_context",
        "get_transcript_chunk",
        "create_interview",
        "save_interview_artifact",
        "link_harness_session",
        "update_interview_status",
      ],
    );

    const created = await call(client, "create_interview", {
      name: "Synthetic Candidate",
      interviewStatus: "scheduled",
      roleMarkdown: "# Role",
    });
    assert.equal(created.linkedSession.session.sessionId, "test-thread");

    await call(client, "save_interview_artifact", {
      interviewId: "candidate-1",
      kind: "interview-summary",
      markdown: "# Decision\n\nProceed.",
    });
    const context = await call(client, "get_interview_context", {
      interviewId: "candidate-1",
    });
    assert.equal(context.interview.artifacts[0].sourceSessionId, "test-thread");
    assert.equal(context.interview.harnessSessions[0].sessionId, "test-thread");
  } finally {
    await client.close();
    await new Promise((resolve) => api.close(resolve));
  }
});

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse(result.content[0].text);
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
