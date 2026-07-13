export function buildEffectiveProviderConfig(baseConfig, storedSettings = {}) {
  const storedAsr = storedSettings.asr || {};
  const storedLlm = storedSettings.llm || {};
  return {
    asr: {
      ...baseConfig.asr,
      ...presentValues(storedAsr, ["apiKey", "appKey", "accessKey", "resourceId", "url"]),
    },
    llm: {
      ...baseConfig.llm,
      ...presentValues(storedLlm, ["apiKey", "baseUrl", "model", "timeoutMs"]),
    },
  };
}

export function normalizeProviderSettingsPatch(current = {}, patch = {}) {
  const currentAsr = current.asr || {};
  const currentLlm = current.llm || {};
  const patchAsr = patch.asr || {};
  const patchLlm = patch.llm || {};
  return {
    asr: {
      apiKey: nextSecret(currentAsr.apiKey, patchAsr.apiKey, patchAsr.clearApiKey),
      appKey: nextSecret(currentAsr.appKey, patchAsr.appKey, patchAsr.clearLegacyCredentials),
      accessKey: nextSecret(
        currentAsr.accessKey,
        patchAsr.accessKey,
        patchAsr.clearLegacyCredentials,
      ),
      resourceId: requiredText(
        patchAsr.resourceId ?? currentAsr.resourceId,
        "ASR 资源 ID",
        300,
      ),
      url: normalizeUrl(patchAsr.url ?? currentAsr.url, ["ws:", "wss:"], "ASR 地址"),
    },
    llm: {
      apiKey: nextSecret(currentLlm.apiKey, patchLlm.apiKey, patchLlm.clearApiKey),
      baseUrl: normalizeUrl(
        patchLlm.baseUrl ?? currentLlm.baseUrl,
        ["http:", "https:"],
        "大模型 API 地址",
      ).replace(/\/$/, ""),
      model: requiredText(patchLlm.model ?? currentLlm.model, "模型名称", 300),
      timeoutMs: normalizeTimeout(patchLlm.timeoutMs ?? currentLlm.timeoutMs),
    },
  };
}

export function publicProviderSettings(config, storedSettings = {}) {
  return {
    asr: {
      configured: Boolean(config.asr.apiKey || (config.asr.appKey && config.asr.accessKey)),
      apiKeyConfigured: Boolean(config.asr.apiKey),
      apiKeyStored: Boolean(storedSettings.asr?.apiKey),
      legacyCredentialsConfigured: Boolean(config.asr.appKey && config.asr.accessKey),
      legacyCredentialsStored: Boolean(
        storedSettings.asr?.appKey && storedSettings.asr?.accessKey,
      ),
      resourceId: config.asr.resourceId,
      url: config.asr.url,
    },
    llm: {
      configured: Boolean(config.llm.apiKey && config.llm.baseUrl && config.llm.model),
      apiKeyConfigured: Boolean(config.llm.apiKey),
      apiKeyStored: Boolean(storedSettings.llm?.apiKey),
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      timeoutMs: config.llm.timeoutMs,
    },
  };
}

function presentValues(source, keys) {
  return Object.fromEntries(
    keys
      .filter((key) => source[key] !== undefined && source[key] !== "")
      .map((key) => [key, source[key]]),
  );
}

function nextSecret(current, next, shouldClear) {
  if (shouldClear) return "";
  const value = String(next || "").trim();
  if (!value) return String(current || "");
  if (value.length > 2000) throw new Error("凭证长度无效");
  return value;
}

function requiredText(value, label, maxLength) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength) throw new Error(`${label}无效`);
  return text;
}

function normalizeUrl(value, protocols, label) {
  const text = requiredText(value, label, 2000);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label}格式无效`);
  }
  if (!protocols.includes(url.protocol)) throw new Error(`${label}协议无效`);
  return url.toString();
}

function normalizeTimeout(value) {
  const timeout = Number(value || 75000);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 300000) {
    throw new Error("请求超时必须在 1000 到 300000 毫秒之间");
  }
  return timeout;
}
