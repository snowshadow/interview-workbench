import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../server/config.js";
import { createSecurity } from "../server/security.js";

test("non-loopback listeners require an access token", () => {
  assert.throws(
    () => loadConfig({ HOST: "0.0.0.0", PORT: "8787" }),
    /WORKBENCH_ACCESS_TOKEN/,
  );
  assert.throws(
    () => loadConfig({
      HOST: "0.0.0.0",
      PORT: "8787",
      WORKBENCH_ACCESS_TOKEN: "short-token",
    }),
    /at least 16 characters/,
  );
  const config = loadConfig({
    HOST: "0.0.0.0",
    PORT: "8787",
    WORKBENCH_ACCESS_TOKEN: "test-access-token",
  });
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.trustProxy, false);
});

test("trust proxy is opt-in", () => {
  const config = loadConfig({
    HOST: "127.0.0.1",
    WORKBENCH_TRUST_PROXY: "1",
  });
  assert.equal(config.trustProxy, true);
});

test("startup config rejects metadata provider URLs", () => {
  assert.throws(
    () => loadConfig({ LLM_BASE_URL: "http://169.254.169.254/" }),
    /大模型 API 地址不可用/,
  );
});

test("HTTP and WebSocket requests enforce origin and bearer token", () => {
  const security = createSecurity({
    accessToken: "secret",
    allowedOrigins: new Set(["http://127.0.0.1:5173"]),
  });
  const accepted = runMiddleware(security.httpMiddleware, {
    origin: "http://127.0.0.1:5173",
    authorization: "Bearer secret",
  });
  assert.equal(accepted.nextCalled, true);
  assert.equal(accepted.headers["Cache-Control"], "no-store");

  const rejected = runMiddleware(security.httpMiddleware, {
    origin: "https://evil.example",
    authorization: "Bearer secret",
  });
  assert.equal(rejected.statusCode, 403);

  // Query-string tokens are no longer accepted: they leak into proxy logs.
  assert.equal(
    security.validateUpgrade({
      url: "/ws/asr?token=secret",
      headers: { origin: "http://127.0.0.1:5173" },
    }),
    false,
  );
  assert.equal(
    security.validateUpgrade({
      url: "/ws/asr",
      headers: {
        origin: "http://127.0.0.1:5173",
        authorization: "Bearer secret",
      },
    }),
    true,
  );
  const encoded = Buffer.from("secret").toString("base64url");
  assert.equal(
    security.validateUpgrade({
      url: "/ws/asr",
      headers: {
        origin: "http://127.0.0.1:5173",
        "sec-websocket-protocol": `interview-workbench, auth.${encoded}`,
      },
    }),
    true,
  );
});

test("API rate limit is keyed by socket address and ignores forwarded headers", () => {
  const security = createSecurity({
    accessToken: "",
    allowedOrigins: new Set(),
    rateLimitMax: 2,
    rateLimitWindowMs: 60_000,
  });
  const headers = { "x-forwarded-for": "203.0.113.9" };
  assert.equal(runMiddleware(security.rateLimitMiddleware, headers).nextCalled, true);
  assert.equal(runMiddleware(security.rateLimitMiddleware, headers).nextCalled, true);
  const blocked = runMiddleware(security.rateLimitMiddleware, headers);
  assert.equal(blocked.statusCode, 429);
  assert.deepEqual(blocked.body, { error: "请求过于频繁" });

  const otherClient = runMiddleware(
    security.rateLimitMiddleware,
    headers,
    { socket: { remoteAddress: "192.0.2.10" } },
  );
  assert.equal(otherClient.nextCalled, true);
});

test("failed bearer attempts are independently throttled", () => {
  const security = createSecurity({
    accessToken: "secret",
    allowedOrigins: new Set(),
    authFailLimit: 2,
    authFailWindowMs: 60_000,
  });
  const first = runMiddleware(security.httpMiddleware, { authorization: "Bearer wrong" });
  const second = runMiddleware(security.httpMiddleware, { authorization: "Bearer wrong" });
  const third = runMiddleware(security.httpMiddleware, { authorization: "Bearer wrong" });
  assert.equal(first.statusCode, 401);
  assert.equal(second.statusCode, 401);
  assert.equal(third.statusCode, 429);
});

test("JSON parse errors return JSON without a stack", () => {
  const security = createSecurity({
    accessToken: "",
    allowedOrigins: new Set(),
  });
  const result = { statusCode: 200, headers: {}, body: null, nextCalled: false };
  const response = {
    headersSent: false,
    status(code) {
      result.statusCode = code;
      return this;
    },
    json(body) {
      result.body = body;
    },
    setHeader(name, value) {
      result.headers[name] = value;
    },
  };
  const err = new SyntaxError("Unexpected token");
  err.type = "entity.parse.failed";
  err.stack = "SyntaxError: Unexpected token\n    at /Users/demo/project/node_modules/body-parser/lib/types/json.js:1:1";
  security.apiErrorHandler(err, { headers: {} }, response, () => {
    result.nextCalled = true;
  });
  assert.equal(result.statusCode, 400);
  assert.deepEqual(result.body, { error: "请求 JSON 无效" });
  assert.equal(JSON.stringify(result.body).includes("body-parser"), false);
  assert.equal(JSON.stringify(result.body).includes("/Users/"), false);
  assert.equal(result.nextCalled, false);
});

function runMiddleware(middleware, headers, extra = {}) {
  const result = { statusCode: 200, headers: {}, body: null, nextCalled: false };
  const response = {
    status(code) {
      result.statusCode = code;
      return this;
    },
    json(body) {
      result.body = body;
    },
    setHeader(name, value) {
      result.headers[name] = value;
    },
  };
  middleware({
    headers,
    ip: extra.ip,
    socket: extra.socket || { remoteAddress: "127.0.0.1" },
  }, response, () => {
    result.nextCalled = true;
  });
  return result;
}
