import assert from "node:assert/strict";
import zlib from "node:zlib";
import test from "node:test";
import {
  buildAudioRequest,
  buildFullClientRequest,
  normalizeAsrResult,
  parseServerMessage,
} from "../server/providers/asr/volcengine.js";

test("Volcengine client request declares 16k mono PCM and speaker separation", () => {
  const message = buildFullClientRequest();
  assert.equal(message[0], 0x11);
  assert.equal(message[1] >> 4, 0x1);
  const size = message.readUInt32BE(4);
  const payload = JSON.parse(zlib.gunzipSync(message.subarray(8, 8 + size)).toString("utf8"));
  assert.equal(payload.audio.rate, 16000);
  assert.equal(payload.audio.channel, 1);
  assert.equal(payload.request.enable_speaker_info, true);
});

test("final audio frame uses the protocol final flag", () => {
  const normal = buildAudioRequest(Buffer.from([1, 2]), false);
  const final = buildAudioRequest(Buffer.alloc(0), true);
  assert.equal(normal[1] & 0x0f, 0);
  assert.equal(final[1] & 0x0f, 2);
});

test("ASR transcript normalization accepts speaker IDs from additions", () => {
  const normalized = normalizeAsrResult({
    result: {
      text: "你好",
      utterances: [{
        text: "你好",
        start_time: 0,
        end_time: 300,
        definite: true,
        additions: { speaker_id: "2" },
      }],
    },
  });
  assert.equal(normalized.utterances[0].speaker, "2");
  assert.equal(normalized.utterances[0].definite, true);
});

test("malformed ASR frames are rejected before reading past the buffer", () => {
  assert.throws(() => parseServerMessage(Buffer.from([0x11, 0x90])), /too short/);
  const invalid = Buffer.from([0x11, 0x90, 0x11, 0x00, 0xff, 0xff, 0xff, 0xff]);
  assert.throws(() => parseServerMessage(invalid), /payload size/);
});
