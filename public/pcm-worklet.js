class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input?.length) {
      this.port.postMessage(input.slice(0));
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
