// 聚满 2048 样本（48kHz 下约 43ms）再发一次，避免每个 128 样本量子
// 都触发一次跨线程 postMessage；缓冲区以 transferable 转移，主线程零拷贝。
const BATCH_SAMPLES = 2048;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(BATCH_SAMPLES);
    this.offset = 0;
  }

  process(inputs) {
    const channels = inputs[0] || [];
    if (!channels.length || !channels[0]?.length) return true;
    const frames = channels[0].length;
    for (let index = 0; index < frames; index += 1) {
      let sum = 0;
      for (const channel of channels) sum += channel[index];
      this.buffer[this.offset] = sum / channels.length;
      this.offset += 1;
      if (this.offset === BATCH_SAMPLES) {
        const chunk = this.buffer;
        this.port.postMessage(chunk, [chunk.buffer]);
        this.buffer = new Float32Array(BATCH_SAMPLES);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
