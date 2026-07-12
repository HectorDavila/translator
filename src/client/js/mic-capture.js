const CAPTURE_SAMPLE_RATE = 48000;

// Captures the microphone into 24kHz PCM16 chunks via the worklet in
// audio-worklet.js. The worklet also runs VAD + preroll on the audio thread,
// so capture keeps working while the screen locks or the tab backgrounds.
export class MicCapture {
  constructor() {
    this.stream = null;
    this.context = null;
    this.workletNode = null;

    // Assign these before start(); both are optional.
    this.onChunk = () => {}; // (Int16Array) speech chunk ready to send
    this.onLevel = () => {}; // ({ rms, speaking }) every ~100ms, for the UI
  }

  get active() {
    return this.stream !== null;
  }

  // options.gated=false streams continuously (no VAD cuts); default is gated.
  async start({ gated = true } = {}) {
    if (this.active) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: CAPTURE_SAMPLE_RATE,
        },
      });
      this.context = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
      await this.context.audioWorklet.addModule("/js/audio-worklet.js");

      const source = this.context.createMediaStreamSource(this.stream);
      this.workletNode = new AudioWorkletNode(this.context, "pcm-capture-processor", {
        processorOptions: { gated },
      });
      source.connect(this.workletNode);

      this.workletNode.port.onmessage = (event) => {
        const msg = event.data;
        if (msg.type === "audio") this.onChunk(msg.data);
        this.onLevel({ rms: msg.rms ?? 0, speaking: msg.speaking === true });
      };
    } catch (err) {
      this.stop(); // don't leave a half-open capture (mic indicator on, etc.)
      throw err;
    }
  }

  stop() {
    this.workletNode?.disconnect();
    this.workletNode = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.context?.close();
    this.context = null;
  }
}
