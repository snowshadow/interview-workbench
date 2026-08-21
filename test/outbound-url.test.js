import assert from "node:assert/strict";
import test from "node:test";
import {
  assertOutboundUrl,
  assertSafeIp,
  createSafeLookup,
  loadOutboundPolicy,
} from "../server/outbound-url.js";

test("outbound policy reads allowlist and private-block flags", () => {
  assert.deepEqual(
    loadOutboundPolicy({
      WORKBENCH_BLOCK_PRIVATE_PROVIDERS: "1",
      WORKBENCH_OUTBOUND_ALLOWLIST: "api.example.test, Asr.Example.Test ",
    }),
    {
      blockPrivate: true,
      allowlist: ["api.example.test", "asr.example.test"],
    },
  );
});

test("cloud metadata and link-local targets are always rejected", () => {
  const policy = { allowlist: [] };
  assert.throws(() => assertOutboundUrl("http://169.254.169.254/", policy, { label: "大模型 API 地址" }), /不可用/);
  assert.throws(() => assertOutboundUrl("http://metadata.google.internal/", policy), /不可用/);
  assert.throws(() => assertOutboundUrl("http://100.100.100.200/", policy), /不可用/);
  assert.throws(() => assertSafeIp("::ffff:169.254.169.254", policy), /不可用/);
  assert.throws(() => assertSafeIp("fe80::1", policy), /不可用/);
});

test("loopback URLs stay allowed unless private providers are blocked", () => {
  const url = assertOutboundUrl("http://127.0.0.1:11434/v1", { allowlist: [] }, {
    protocols: ["http:", "https:"],
    label: "大模型 API 地址",
  });
  assert.equal(url.hostname, "127.0.0.1");
  assert.throws(
    () => assertOutboundUrl("http://127.0.0.1:11434/v1", { blockPrivate: true, allowlist: [] }),
    /不可用/,
  );
  assert.throws(
    () => assertOutboundUrl("http://localhost:11434/v1", { blockPrivate: true, allowlist: [] }),
    /不可用/,
  );
});

test("allowlist rejects hosts outside the configured names", () => {
  assert.throws(
    () => assertOutboundUrl("https://evil.example/v1", { allowlist: ["api.deepseek.com"] }),
    /出站名单/,
  );
  const url = assertOutboundUrl("https://api.deepseek.com/v1", { allowlist: ["api.deepseek.com"] });
  assert.equal(url.hostname, "api.deepseek.com");
});

test("safe lookup rejects DNS results that resolve to metadata", async () => {
  const lookup = createSafeLookup({ allowlist: [] }, (_hostname, _options, callback) => {
    callback(null, [{ address: "169.254.169.254", family: 4 }]);
  });
  const error = await new Promise((resolve) => {
    lookup("attacker.example", {}, resolve);
  });
  assert.match(error.message, /不可用/);
});
