const TARGET_SAMPLE_RATE = 24000;

class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.bufferLength = 0;
    this.resampleRatio = TARGET_SAMPLE_RATE / sampleRate;
    this.chunkSize = 2400; // ~100ms at 24kHz
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    const resampled = this.resample(input);
    this.buffer.push(resampled);
    this.bufferLength += resampled.length;

    if (this.bufferLength >= this.chunkSize) {
      const pcm16 = this.flushBuffer();
      this.port.postMessage({ type: "audio", data: pcm16 }, [pcm16.buffer]);
    }

    return true;
  }

  resample(input) {
    if (this.resampleRatio === 1) return input;

    const outputLength = Math.round(input.length * this.resampleRatio);
    const output = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i / this.resampleRatio;
      const srcIndexFloor = Math.floor(srcIndex);
      const srcIndexCeil = Math.min(srcIndexFloor + 1, input.length - 1);
      const frac = srcIndex - srcIndexFloor;
      output[i] = input[srcIndexFloor] * (1 - frac) + input[srcIndexCeil] * frac;
    }

    return output;
  }

  flushBuffer() {
    const combined = new Float32Array(this.bufferLength);
    let offset = 0;
    for (const chunk of this.buffer) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    const samplesToSend = Math.min(combined.length, this.chunkSize);
    const pcm16 = new Int16Array(samplesToSend);
    for (let i = 0; i < samplesToSend; i++) {
      const sample = Math.max(-1, Math.min(1, combined[i]));
      pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    if (combined.length > this.chunkSize) {
      const remaining = combined.slice(this.chunkSize);
      this.buffer = [remaining];
      this.bufferLength = remaining.length;
    } else {
      this.buffer = [];
      this.bufferLength = 0;
    }

    return pcm16;
  }
}

registerProcessor("pcm-capture-processor", PCMCaptureProcessor);
