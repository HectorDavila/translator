import { MicCapture } from "./mic-capture.js";
import { ReconnectingSocket } from "./ws-client.js";
import { ScreenWakeLock } from "./wake-lock.js";

const HEALTH_POLL_MS = 5000;
const METER_GAIN = 700; // rms ≈ 0.14 paints the level bar full

// Operator page: streams mic audio (already VAD-gated by the worklet) to the
// server and controls the translation session. Survives its own network
// blips: the server keeps the session in a grace period and we re-send
// start_session on reconnect.
class OperatorApp {
  constructor({ startBtn, stopBtn, statusEl, levelEl, listenerCountEl, vadIndicator }) {
    this.startBtn = startBtn;
    this.stopBtn = stopBtn;
    this.statusEl = statusEl;
    this.levelEl = levelEl;
    this.listenerCountEl = listenerCountEl;
    this.vadIndicator = vadIndicator;
    this.wantSession = false; // pressed Iniciar and hasn't pressed Detener

    this.wakeLock = new ScreenWakeLock();

    this.socket = new ReconnectingSocket(this.wsUrl());
    this.socket.onOpen = () => this.handleOpen();
    this.socket.onClose = () => this.handleClose();
    this.socket.onError = () => this.setStatus("Error de conexión", "error");
    this.socket.onMessage = (msg) => this.handleMessage(msg);

    this.mic = new MicCapture();
    this.mic.onChunk = (pcm16) => this.socket.send(pcm16); // binary PCM16 frame
    this.mic.onLevel = ({ rms, speaking }) => this.updateMeter(rms, speaking);

    this.startBtn.addEventListener("click", () => this.startSession());
    this.stopBtn.addEventListener("click", () => this.stopSession());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      if (this.wantSession && !this.wakeLock.active) this.wakeLock.enable();
    });

    setInterval(() => this.pollListenerCount(), HEALTH_POLL_MS);

    this.setStatus("Conectando...", "idle");
    this.socket.connect();
  }

  wsUrl() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}/ws/operator`;
  }

  async startSession() {
    try {
      await this.mic.start();
    } catch (err) {
      this.setStatus(`Error: ${err.message}`, "error");
      return;
    }
    this.wantSession = true;
    this.socket.sendJson({ type: "start_session" });
    await this.wakeLock.enable(); // keep the operator device awake
    this.startBtn.disabled = true;
    this.stopBtn.disabled = false;
  }

  stopSession() {
    this.wantSession = false;
    this.socket.sendJson({ type: "stop_session" });
    this.mic.stop();
    this.wakeLock.disable();
    this.updateMeter(0, false);
    this.startBtn.disabled = false;
    this.stopBtn.disabled = true;
    this.setStatus("Sesión detenida", "idle");
  }

  handleOpen() {
    this.setStatus("Conectado al servidor", "idle");
    this.startBtn.disabled = false;
    // Mid-session reconnect: resume before the server's grace period ends.
    if (this.wantSession && this.mic.active) {
      this.socket.sendJson({ type: "start_session" });
      this.startBtn.disabled = true;
      this.stopBtn.disabled = false;
    }
  }

  handleClose() {
    this.setStatus("Reconectando al servidor...", "error");
    this.startBtn.disabled = true;
    this.stopBtn.disabled = true;
  }

  handleMessage(msg) {
    if (msg.type !== "status") return;
    if (msg.state === "active") {
      this.setStatus("Traduciendo en vivo", "active");
    } else if (msg.state === "error") {
      this.setStatus("Error en la traducción", "error");
    }
  }

  // Driven by worklet messages every ~100ms — works with the screen locked.
  updateMeter(rms, speaking) {
    this.levelEl.style.width = `${Math.min(100, Math.round(rms * METER_GAIN))}%`;
    if (this.vadIndicator) {
      this.vadIndicator.textContent = speaking ? "Enviando audio" : "En silencio (pausado)";
      this.vadIndicator.className = speaking ? "vad-status vad-active" : "vad-status vad-silent";
    }
  }

  async pollListenerCount() {
    try {
      const res = await fetch("/health");
      const data = await res.json();
      this.listenerCountEl.textContent = data.listeners.toString();
    } catch {
      // transient — next poll will retry
    }
  }
}

new OperatorApp({
  startBtn: document.getElementById("start-btn"),
  stopBtn: document.getElementById("stop-btn"),
  statusEl: document.getElementById("status"),
  levelEl: document.getElementById("audio-level"),
  listenerCountEl: document.getElementById("listener-count"),
  vadIndicator: document.getElementById("vad-indicator"),
});
