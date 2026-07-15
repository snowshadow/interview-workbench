import http from "node:http";
import https from "node:https";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class OpenAiCompatibleLlmProvider {
  constructor(config) {
    this.config = config;
  }

  isConfigured() {
    return Boolean(this.config.apiKey && this.config.baseUrl && this.config.model);
  }

  async chatComplete({ messages, temperature }, options = {}) {
    const response = await postJson(`${this.config.baseUrl}/chat/completions`, {
      timeoutMs: options.timeoutMs || this.config.timeoutMs,
      signal: options.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature,
        messages,
      }),
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      const detail = safeProviderError(response.body);
      const error = new Error(`LLM provider returned ${response.statusCode}${detail ? `: ${detail}` : ""}`);
      error.statusCode = response.statusCode;
      throw error;
    }

    let data;
    try {
      data = JSON.parse(response.body);
    } catch {
      throw new Error("LLM provider returned invalid JSON");
    }
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("LLM provider returned no content");
    return content;
  }
}

function postJson(urlString, { headers, body, timeoutMs, signal }) {
  const url = new URL(urlString);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported LLM URL protocol");
  const bodyBuffer = Buffer.from(body, "utf8");
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Request cancelled"));
    const request = transport.request(
      {
        method: "POST",
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, "Content-Length": bodyBuffer.length },
        ALPNProtocols: ["http/1.1"],
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(new Error("LLM response exceeded 2MB"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({
          statusCode: response.statusCode || 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    request.setTimeout(timeoutMs, () => {
      const error = new Error("LLM request timed out");
      error.code = "LLM_TIMEOUT";
      request.destroy(error);
    });
    request.on("error", reject);
    signal?.addEventListener("abort", () => request.destroy(new Error("Request cancelled")), { once: true });
    request.end(bodyBuffer);
  });
}

function safeProviderError(body) {
  try {
    const data = JSON.parse(body);
    return String(data?.error?.message || data?.message || "").slice(0, 240);
  } catch {
    return "";
  }
}
