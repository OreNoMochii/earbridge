// Runs on the audio rendering thread. Collects microphone samples into ~50 ms chunks
// and hands them to the main thread, which resamples them to 16 kHz and sends them on.
// Plain JavaScript because it is loaded as-is with audioWorklet.addModule().

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = Math.round(sampleRate / 20);
    this.buffer = new Float32Array(this.chunkSize);
    this.filled = 0;
  }

  process(inputs) {
    // The node down-mixes to one channel; no channels means no input is connected yet.
    const samples = inputs[0] && inputs[0][0];
    if (!samples) return true;
    let offset = 0;
    while (offset < samples.length) {
      const count = Math.min(samples.length - offset, this.chunkSize - this.filled);
      this.buffer.set(samples.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === this.chunkSize) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(this.chunkSize);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
