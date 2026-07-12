const TARGET_SAMPLE_RATE = 24000;

// Voice activity detection lives here, on the audio rendering thread, because
// it keeps running when the screen locks or the tab is backgrounded — main
// thread rAF/timers get throttled or suspended and would freeze the VAD,
// silently stopping the broadcast.
const VAD_RMS_THRESHOLD = 0.006; // ~-44 dBFS; raise if room noise leaks through
const HANGOVER_CHUNKS = 15; // keep sending ~1.5s after speech stops
const PREROLL_CHUNKS = 3; // ~300ms flushed retroactively so onsets aren't clipped

class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // gated (default): only stream while speech is detected — silence isn't
    // billed. Continuous: stream everything, per OpenAI's guidance; the
    // utterance cuts that gating creates encourage translation voice changes.
    const opts = (options && options.processorOptions) || {};
    this.gated = opts.gated !== false;
    this.buffer = [];
    this.bufferLength = 0;
    this.resampleRatio = TARGET_SAMPLE_RATE / sampleRate;
    this.chunkSize = 2400; // ~100ms at 24kHz
    this.preroll = [];
    this.silentChunks = HANGOVER_CHUNKS;
    this.speaking = false;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    const resampled = this.resample(input);
    this.buffer.push(resampled);
    this.bufferLength += resampled.length;

    if (this.bufferLength >= this.chunkSize) {
      this.emit(this.flushBuffer());
    }

    return true;
  }

  emit(pcm16) {
    const rms = this.rms(pcm16);
    this.silentChunks = rms >= VAD_RMS_THRESHOLD ? 0 : this.silentChunks + 1;
    const speaking = this.silentChunks <= HANGOVER_CHUNKS;

    if (!this.gated) {
      // Continuous mode: everything is sent; speaking/rms still feed the UI.
      this.port.postMessage({ type: "audio", data: pcm16, rms, speaking }, [
        pcm16.buffer,
      ]);
    } else if (speaking) {
      if (!this.speaking) {
        for (const chunk of this.preroll) {
          this.port.postMessage({ type: "audio", data: chunk, rms, speaking }, [
            chunk.buffer,
          ]);
        }
        this.preroll = [];
      }
      this.port.postMessage({ type: "audio", data: pcm16, rms, speaking }, [
        pcm16.buffer,
      ]);
    } else {
      this.preroll.push(pcm16);
      if (this.preroll.length > PREROLL_CHUNKS) this.preroll.shift();
      this.port.postMessage({ type: "level", rms, speaking });
    }
    this.speaking = speaking;
  }

  rms(pcm16) {
    let sum = 0;
    for (let i = 0; i < pcm16.length; i++) {
      const s = pcm16[i] / 32768;
      sum += s * s;
    }
    return Math.sqrt(sum / pcm16.length);
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
