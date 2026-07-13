import assert from "node:assert/strict";
import test from "node:test";
import {
  AUDIO_SOURCE_MEETING,
  audioCaptureErrorMessage,
  buildDisplayMediaOptions,
  createCaptureError,
  hasAudioTrack,
} from "../src/audio-capture.js";

test("meeting capture asks for system audio without suppressing local playback", () => {
  const options = buildDisplayMediaOptions();
  assert.equal(options.video.displaySurface, "window");
  assert.equal(options.systemAudio, "include");
  assert.equal(options.windowAudio, "system");
  assert.equal(options.audio.suppressLocalAudioPlayback, false);
  assert.equal(options.selfBrowserSurface, "exclude");
});

test("meeting capture requires a live audio track", () => {
  assert.equal(hasAudioTrack({ getAudioTracks: () => [] }), false);
  assert.equal(hasAudioTrack({
    getAudioTracks: () => [{ readyState: "live" }],
  }), true);
  assert.equal(hasAudioTrack({
    getAudioTracks: () => [{ readyState: "ended" }],
  }), false);
});

test("capture errors explain how to enable meeting audio", () => {
  assert.match(
    audioCaptureErrorMessage(createCaptureError("SYSTEM_AUDIO_MISSING"), AUDIO_SOURCE_MEETING),
    /开启共享音频/,
  );
  assert.match(
    audioCaptureErrorMessage({ name: "NotAllowedError" }, AUDIO_SOURCE_MEETING),
    /共享窗口/,
  );
});
