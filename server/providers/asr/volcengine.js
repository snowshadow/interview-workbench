import crypto from "node:crypto";
import zlib from "node:zlib";
import { WebSocket } from "ws";

export class VolcengineAsrProvider {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  isConfigured() {
    return Boolean(this.config.apiKey) || Boolean(this.config.appKey && this.config.accessKey);
  }

  createSession(client) {
    return new VolcengineAsrSession({
      client,
      config: this.config,
      logger: this.logger,
    });
  }
}

class VolcengineAsrSession {
  constructor({ client, config, logger }) {
    this.id = crypto.randomUUID();
    this.client = client;
    this.config = config;
    this.logger = logger;
    this.upstream = null;
    this.closed = false;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.hasSentFinal = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
  }

  start() {
    this.log("session.created");
    if (!this.isConfigured()) {
      this.log("session.error", { message: "ASR credential missing" });
      this.sendToClient({ type: "error", message: "火山 ASR 未配置，请在工作台设置中完成配置" });
      this.client.close();
      return;
    }

    this.client.on("message", (data, isBinary) => {
      if (isBinary) {
        this.handleAudio(Buffer.from(data));
        return;
      }
      this.handleControlMessage(data.toString("utf8"));
    });
    this.client.on("close", () => {
      this.log("client.closed");
      this.close();
    });
    this.client.on("error", (error) => {
      this.log("client.error", { error });
      this.close();
    });
    this.openUpstream();
  }

  isConfigured() {
    return Boolean(this.config.apiKey) || Boolean(this.config.appKey && this.config.accessKey);
  }

  openUpstream() {
    if (this.closed || this.hasSentFinal) return;
    const connectId = crypto.randomUUID();
    const upstream = new WebSocket(this.config.url, {
      headers: buildAsrHeaders(this.config, connectId),
    });
    this.upstream = upstream;
    this.log("upstream.connecting", { connectId, attempt: this.reconnectAttempts + 1 });

    upstream.on("open", () => {
      if (this.upstream !== upstream) return;
      this.reconnectAttempts = 0;
      this.log("upstream.connected", { connectId });
      this.sendToClient({ type: "status", status: "asr-connected" });
      upstream.send(buildFullClientRequest());
      this.flushPendingAudio();
    });

    upstream.on("message", (data) => {
      if (this.upstream !== upstream) return;
      let parsed;
      try {
        parsed = parseServerMessage(Buffer.from(data));
      } catch (error) {
        this.log("upstream.invalid_message", { error });
        this.sendToClient({ type: "status", status: "asr-reconnecting" });
        upstream.terminate();
        return;
      }
      if (parsed.type === "error") {
        this.sendToClient({ type: "error", message: parsed.message, code: parsed.code });
        return;
      }
      if (parsed.type !== "response") return;
      const transcript = normalizeAsrResult(parsed.payload);
      if (transcript.text || transcript.utterances.length) {
        this.log("transcript.sent", {
          textChars: transcript.text?.length || 0,
          utteranceCount: transcript.utterances.length,
          definiteCount: transcript.utterances.filter((item) => item.definite).length,
        });
        this.sendToClient({ type: "transcript", ...transcript });
      }
    });

    upstream.on("close", (code, reason) => {
      if (this.upstream !== upstream || this.closed || this.hasSentFinal) return;
      this.log("upstream.closed", { code, reason: reason?.toString?.() || "" });
      this.sendToClient({
        type: "status",
        status: "asr-reconnecting",
        code,
        reason: reason?.toString?.() || "",
      });
      this.scheduleReconnect();
    });

    upstream.on("error", (error) => {
      if (this.upstream !== upstream || this.closed || this.hasSentFinal) return;
      this.log("upstream.error", { error });
      this.sendToClient({
        type: "status",
        status: "asr-reconnecting",
        message: "ASR 上游连接异常，正在重连",
      });
      if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(upstream.readyState)) upstream.terminate();
      this.scheduleReconnect();
    });
  }

  handleControlMessage(raw) {
    try {
      const message = JSON.parse(raw);
      if (message.type === "stop") this.sendFinalAudio();
    } catch {
      // Ignore malformed client control messages.
    }
  }

  handleAudio(audioBuffer) {
    if (!audioBuffer.length || this.hasSentFinal || this.closed) return;
    if (this.upstream?.readyState === WebSocket.OPEN) {
      this.upstream.send(buildAudioRequest(audioBuffer, false));
    } else {
      this.enqueuePendingAudio(audioBuffer);
    }
  }

  enqueuePendingAudio(audioBuffer) {
    this.pendingAudio.push(audioBuffer);
    this.pendingAudioBytes += audioBuffer.length;
    const maxPendingAudioBytes = 16000 * 2 * 8;
    while (this.pendingAudio.length > 1 && this.pendingAudioBytes > maxPendingAudioBytes) {
      const dropped = this.pendingAudio.shift();
      this.pendingAudioBytes -= dropped.length;
    }
  }

  flushPendingAudio() {
    while (this.pendingAudio.length && this.upstream?.readyState === WebSocket.OPEN) {
      const audioBuffer = this.pendingAudio.shift();
      this.pendingAudioBytes -= audioBuffer.length;
      this.upstream.send(buildAudioRequest(audioBuffer, false));
    }
  }

  scheduleReconnect() {
    if (this.closed || this.hasSentFinal || this.reconnectTimer) return;
    const attempt = this.reconnectAttempts + 1;
    const delayMs = Math.min(5000, 600 * attempt);
    this.reconnectAttempts = attempt;
    this.log("upstream.reconnect_scheduled", { attempt, delayMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openUpstream();
    }, delayMs);
  }

  sendFinalAudio() {
    if (this.hasSentFinal) return;
    this.hasSentFinal = true;
    this.log("session.final_audio");
    if (this.upstream?.readyState === WebSocket.OPEN) {
      this.upstream.send(buildAudioRequest(Buffer.alloc(0), true));
      setTimeout(() => this.close(), 1200);
    } else {
      this.close();
    }
  }

  sendToClient(message) {
    if (this.client.readyState === WebSocket.OPEN) this.client.send(JSON.stringify(message));
  }

  close(closeClient = true) {
    if (this.closed) return;
    this.closed = true;
    this.log("session.closed", { closeClient });
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(this.upstream?.readyState)) {
      this.upstream.terminate();
    }
    if (closeClient && this.client.readyState === WebSocket.OPEN) this.client.close();
  }

  log(event, fields = {}) {
    this.logger.info(`asr.${event}`, { sessionId: this.id, ...fields });
  }
}

function buildAsrHeaders(config, connectId) {
  const headers = {
    "X-Api-Resource-Id": config.resourceId,
    "X-Api-Connect-Id": connectId,
  };
  if (config.apiKey) headers["X-Api-Key"] = config.apiKey;
  else {
    headers["X-Api-App-Key"] = config.appKey;
    headers["X-Api-Access-Key"] = config.accessKey;
  }
  return headers;
}

export function buildFullClientRequest() {
  const payload = {
    user: { uid: "interview-workbench", platform: "web" },
    audio: { format: "pcm", codec: "raw", rate: 16000, bits: 16, channel: 1 },
    request: {
      model_name: "bigmodel",
      enable_nonstream: true,
      enable_itn: true,
      enable_punc: true,
      enable_ddc: false,
      show_utterances: true,
      result_type: "single",
      enable_speaker_info: true,
      ssd_version: "200",
      end_window_size: 800,
    },
  };
  return buildClientMessage({
    messageType: 0x1,
    flags: 0x0,
    serialization: 0x1,
    compression: 0x1,
    payload: Buffer.from(JSON.stringify(payload), "utf8"),
  });
}

export function buildAudioRequest(audioBuffer, isFinal) {
  return buildClientMessage({
    messageType: 0x2,
    flags: isFinal ? 0x2 : 0x0,
    serialization: 0x0,
    compression: 0x1,
    payload: audioBuffer,
  });
}

function buildClientMessage({ messageType, flags, serialization, compression, payload }) {
  const compressedPayload = compression === 0x1 ? zlib.gzipSync(payload) : payload;
  const header = Buffer.from([
    0x11,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00,
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(compressedPayload.length);
  return Buffer.concat([header, size, compressedPayload]);
}

export function parseServerMessage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) throw new Error("ASR response is too short");
  const headerSize = (buffer[0] & 0x0f) * 4;
  const messageType = buffer[1] >> 4;
  const flags = buffer[1] & 0x0f;
  const serialization = buffer[2] >> 4;
  const compression = buffer[2] & 0x0f;
  let offset = headerSize;
  if (headerSize < 4 || offset + 4 > buffer.length) throw new Error("Invalid ASR response header");

  if (messageType === 0xf) {
    if (offset + 8 > buffer.length) throw new Error("Invalid ASR error response");
    const code = buffer.readUInt32BE(offset);
    offset += 4;
    const size = buffer.readUInt32BE(offset);
    offset += 4;
    if (offset + size > buffer.length) throw new Error("Invalid ASR error payload size");
    return { type: "error", code, message: buffer.subarray(offset, offset + size).toString("utf8") };
  }
  if (messageType !== 0x9) return { type: "unknown", messageType };

  let sequence = null;
  if (flags === 0x1 || flags === 0x3) {
    if (offset + 4 > buffer.length) throw new Error("Invalid ASR sequence");
    sequence = buffer.readInt32BE(offset);
    offset += 4;
  }
  if (offset + 4 > buffer.length) throw new Error("Invalid ASR payload header");
  const size = buffer.readUInt32BE(offset);
  offset += 4;
  if (offset + size > buffer.length) throw new Error("Invalid ASR payload size");
  let payload = buffer.subarray(offset, offset + size);
  if (compression === 0x1) payload = zlib.gunzipSync(payload);
  if (serialization === 0x1) payload = JSON.parse(payload.toString("utf8"));
  return { type: "response", flags, sequence, payload };
}

export function normalizeAsrResult(payload) {
  const result = Array.isArray(payload?.result) ? payload.result[0] : payload?.result;
  const utterances = Array.isArray(result?.utterances)
    ? result.utterances.map((item) => ({
        text: item.text || "",
        startTime: item.start_time,
        endTime: item.end_time,
        definite: Boolean(item.definite),
        speaker: getSpeakerId(item),
      }))
    : [];
  return { text: result?.text || "", utterances };
}

function getSpeakerId(utterance) {
  const additions = utterance?.additions || {};
  return (
    utterance?.speaker ||
    utterance?.speaker_id ||
    utterance?.speakerId ||
    additions?.speaker ||
    additions?.speaker_id ||
    additions?.speakerId ||
    ""
  );
}
