const TOKEN_KEY = "interview-workbench.access-token";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function getAccessToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setAccessToken(value) {
  try {
    const token = String(value || "").trim();
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Session storage can be unavailable in locked-down browser contexts.
  }
}

export function getApiHeaders() {
  const token = getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function apiFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      ...getApiHeaders(),
      ...(options.headers || {}),
    },
  });
}

export async function requestJson(url, options = {}) {
  const response = await apiFetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error || `请求失败：${response.status}`, response.status);
  return data;
}

export function createAsrWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const url = `${protocol}://${window.location.host}/ws/asr`;
  const token = getAccessToken();
  if (!token) return new WebSocket(url);
  return new WebSocket(url, ["interview-workbench", `auth.${base64Url(token)}`]);
}

function base64Url(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
