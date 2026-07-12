import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../server/config.js";
import { createSecurity } from "../server/security.js";

test("non-loopback listeners require an access token", () => {
  assert.throws(
    () => loadConfig({ HOST: "0.0.0.0", PORT: "8787" }),
    /WORKBENCH_ACCESS_TOKEN/,
  );
  const config = loadConfig({
    HOST: "0.0.0.0",
    PORT: "8787",
    WORKBENCH_ACCESS_TOKEN: "secret",
  });
  assert.equal(config.host, "0.0.0.0");
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

  assert.equal(
    security.validateUpgrade({
      url: "/ws/asr?token=secret",
      headers: { origin: "http://127.0.0.1:5173" },
    }),
    true,
  );
  assert.equal(
    security.validateUpgrade({
      url: "/ws/asr?token=wrong",
      headers: { origin: "http://127.0.0.1:5173" },
    }),
    false,
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

function runMiddleware(middleware, headers) {
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
  middleware({ headers }, response, () => {
    result.nextCalled = true;
  });
  return result;
}
