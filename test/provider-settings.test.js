import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEffectiveProviderConfig,
  normalizeProviderSettingsPatch,
  publicProviderSettings,
} from "../server/provider-settings.js";

const baseConfig = {
  asr: {
    provider: "volcengine",
    apiKey: "env-asr-key",
    appKey: "",
    accessKey: "",
    resourceId: "default-resource",
    url: "wss://asr.example.test/ws",
  },
  llm: {
    provider: "openai-compatible",
    apiKey: "env-llm-key",
    baseUrl: "https://api.example.test",
    model: "default-model",
    timeoutMs: 75000,
  },
};

test("stored provider settings override environment defaults without exposing secrets", () => {
  const stored = normalizeProviderSettingsPatch({}, {
    asr: {
      apiKey: "saved-asr-key",
      resourceId: "saved-resource",
      url: "wss://saved-asr.example.test/ws",
    },
    llm: {
      apiKey: "saved-llm-key",
      baseUrl: "https://saved-llm.example.test/v1/",
      model: "saved-model",
      timeoutMs: 90000,
    },
  });
  const effective = buildEffectiveProviderConfig(baseConfig, stored);
  assert.equal(effective.asr.apiKey, "saved-asr-key");
  assert.equal(effective.llm.baseUrl, "https://saved-llm.example.test/v1");

  const publicValue = publicProviderSettings(effective, stored);
  assert.equal(publicValue.asr.apiKeyConfigured, true);
  assert.equal(publicValue.llm.apiKeyStored, true);
  assert.equal(JSON.stringify(publicValue).includes("saved-llm-key"), false);
});

test("blank secret inputs keep the saved value and clear flags remove it", () => {
  const current = {
    asr: {
      apiKey: "saved-asr-key",
      appKey: "legacy-app",
      accessKey: "legacy-access",
      resourceId: "resource",
      url: "wss://asr.example.test/ws",
    },
    llm: {
      apiKey: "saved-llm-key",
      baseUrl: "https://api.example.test",
      model: "model",
      timeoutMs: 75000,
    },
  };
  const kept = normalizeProviderSettingsPatch(current, {
    asr: { apiKey: "", resourceId: "resource", url: "wss://asr.example.test/ws" },
    llm: { apiKey: "", baseUrl: "https://api.example.test", model: "model", timeoutMs: 75000 },
  });
  assert.equal(kept.asr.apiKey, "saved-asr-key");
  assert.equal(kept.llm.apiKey, "saved-llm-key");

  const cleared = normalizeProviderSettingsPatch(current, {
    asr: {
      clearApiKey: true,
      clearLegacyCredentials: true,
      resourceId: "resource",
      url: "wss://asr.example.test/ws",
    },
    llm: {
      clearApiKey: true,
      baseUrl: "https://api.example.test",
      model: "model",
      timeoutMs: 75000,
    },
  });
  assert.equal(cleared.asr.apiKey, "");
  assert.equal(cleared.asr.appKey, "");
  assert.equal(cleared.llm.apiKey, "");
});

test("provider settings reject invalid endpoints", () => {
  assert.throws(
    () => normalizeProviderSettingsPatch({}, {
      asr: { resourceId: "resource", url: "https://not-websocket.example.test" },
      llm: { baseUrl: "https://api.example.test", model: "model", timeoutMs: 75000 },
    }),
    /ASR 地址协议无效/,
  );
});
