export const AUDIO_SOURCE_MICROPHONE = "microphone";
export const AUDIO_SOURCE_MEETING = "meeting";

export function buildDisplayMediaOptions() {
  return {
    video: { displaySurface: "window" },
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      suppressLocalAudioPlayback: false,
    },
    systemAudio: "include",
    windowAudio: "system",
    selfBrowserSurface: "exclude",
    surfaceSwitching: "exclude",
  };
}

export function hasAudioTrack(stream) {
  return Boolean(stream?.getAudioTracks?.().some((track) => track.readyState !== "ended"));
}

export function audioCaptureErrorMessage(error, mode) {
  if (error?.code === "SYSTEM_AUDIO_UNSUPPORTED") {
    return "当前浏览器不支持会议声音采集，请使用最新版 Chrome 或改用仅麦克风模式";
  }
  if (error?.code === "SYSTEM_AUDIO_MISSING") {
    return "没有检测到会议声音。请重新开始，选择腾讯会议窗口或整个屏幕，并开启共享音频";
  }
  if (error?.name === "NotAllowedError") {
    return mode === AUDIO_SOURCE_MEETING
      ? "未获得收音权限。请允许麦克风，并在共享窗口中开启会议声音"
      : "未获得麦克风权限，请在浏览器设置中允许访问";
  }
  if (error?.name === "NotFoundError") return "没有找到可用的麦克风或音频设备";
  return error?.message || "无法启动收音";
}

export function createCaptureError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
