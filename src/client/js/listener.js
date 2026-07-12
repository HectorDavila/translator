import { LiveAudioPlayer } from "./live-audio.js";
import { ReconnectingSocket } from "./ws-client.js";
import { ScreenWakeLock } from "./wake-lock.js";

const MAX_TRANSCRIPT_CHARS = 2000;
const TRIMMED_TRANSCRIPT_CHARS = 1600;

// Listener page: translated audio via LiveAudioPlayer (/stream MP3) plus
// subtitles/status over a ReconnectingSocket. This class owns user intent
// (connect/disconnect) and everything visible; transport and recovery
// details live in the imported modules.
class ListenerApp {
  constructor({ statusEl, transcriptEl, connectBtn }) {
    this.statusEl = statusEl;
    this.transcriptEl = transcriptEl;
    this.connectBtn = connectBtn;
    this.userDisconnected = false;
    this.hasConnectedOnce = false;

    this.wakeLock = new ScreenWakeLock();

    this.player = new LiveAudioPlayer("/stream", {
      title: "Traducción en vivo",
      artist: "Access GT",
    });
    this.player.onPlaying = () => this.handlePlaying();
    this.player.onAutoplayBlocked = () => this.showTapToResume();

    this.socket = new ReconnectingSocket(this.wsUrl());
    this.socket.onMessage = (msg) => this.handleMessage(msg);

    this.connectBtn.addEventListener("click", () => {
      if (this.player.playing) this.disconnect();
      else this.connect();
    });
    document.addEventListener("visibilitychange", () => this.handleVisibilityChange());
    window.addEventListener("pagehide", () => this.wakeLock.disable());
  }

  wsUrl() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}/ws/listener`;
  }

  async connect() {
    this.userDisconnected = false;
    this.setButton("connecting");
    try {
      await this.player.connect(); // needs the user gesture we're in
    } catch (_) {
      this.setButton("connect");
      this.setStatus("Toca de nuevo para activar el audio", "error");
      return;
    }
    this.hasConnectedOnce = true;
    await this.wakeLock.enable();
    this.socket.connect();
    this.setButton("disconnect");
    this.setStatus("Audio activado — conectando...", "idle");
  }

  async disconnect() {
    this.userDisconnected = true;
    this.socket.close();
    this.player.disconnect();
    await this.wakeLock.disable();
    this.transcriptEl.textContent = "";
    this.setStatus("", "idle");
    this.setButton("connect");
  }

  handleVisibilityChange() {
    if (document.visibilityState !== "visible" || this.userDisconnected) return;
    if (this.player.playing && !this.wakeLock.active) this.wakeLock.enable();
    if (this.player.interrupted) {
      // iOS/Android pause media on interruptions (calls, Siri); resume the feed.
      this.player.resume();
    } else {
      this.player.nudgeIfStalled();
    }
    // Revive the transcript socket if it died while the screen was locked
    // (no-op while it's healthy; only once the user has connected before).
    if (this.hasConnectedOnce) this.socket.connect();
  }

  handleMessage(msg) {
    switch (msg.type) {
      case "transcript":
        if (msg.source === "translated") this.appendTranscript(msg.text);
        break;
      case "status":
        this.handleStatusChange(msg.state);
        break;
    }
  }

  handleStatusChange(state) {
    switch (state) {
      case "active":
        this.setStatus("Traducción en vivo", "active");
        this.transcriptEl.textContent = "";
        break;
      case "idle":
        this.setStatus("Servicio en pausa", "idle");
        break;
      case "error":
        this.setStatus("Error en la traducción", "error");
        break;
    }
  }

  handlePlaying() {
    if (
      this.statusEl.textContent === "" ||
      this.statusEl.classList.contains("status-error")
    ) {
      this.setStatus("Conectado — esperando traducción", "idle");
    }
    // Playback can (re)start from a recovery path; keep the button truthful.
    if (!this.userDisconnected) this.setButton("disconnect");
  }

  // Autoplay was blocked (no valid gesture); ask for a tap to resume.
  showTapToResume() {
    this.setStatus("Toca Conectar para reanudar el audio", "error");
    this.setButton("connect");
  }

  appendTranscript(text) {
    this.transcriptEl.textContent += text;
    if (this.transcriptEl.textContent.length > MAX_TRANSCRIPT_CHARS) {
      this.transcriptEl.textContent =
        this.transcriptEl.textContent.slice(-TRIMMED_TRANSCRIPT_CHARS);
    }
    this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  }

  setStatus(text, type) {
    this.statusEl.textContent = text;
    this.statusEl.className = `status status-${type}`;
  }

  setButton(state) {
    this.connectBtn.disabled = state === "connecting";
    if (state === "connecting") {
      this.connectBtn.textContent = "Conectando...";
      return;
    }
    const disconnect = state === "disconnect";
    this.connectBtn.textContent = disconnect ? "Desconectar" : "Conectar";
    this.connectBtn.classList.toggle("btn-danger", disconnect);
    this.connectBtn.classList.toggle("btn-primary", !disconnect);
  }
}

new ListenerApp({
  statusEl: document.getElementById("status"),
  transcriptEl: document.getElementById("translated-text"),
  connectBtn: document.getElementById("connect-btn"),
});
