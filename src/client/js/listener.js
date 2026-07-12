import { LiveAudioPlayer } from "./live-audio.js";
import { ReconnectingSocket } from "./ws-client.js";
import { ScreenWakeLock } from "./wake-lock.js";
import { messagesFor } from "./i18n.js";

const MAX_TRANSCRIPT_CHARS = 2000;
const TRIMMED_TRANSCRIPT_CHARS = 1600;

// Status pill styling per status key (text comes from i18n.js).
const STATUS_TYPES = {
  none: "idle",
  audioOn: "idle",
  waiting: "idle",
  live: "active",
  paused: "idle",
  error: "error",
  tapActivate: "error",
  tapResume: "error",
};

// Listener page: translated audio via LiveAudioPlayer (/stream MP3) plus
// subtitles/status over a ReconnectingSocket. The whole UI localizes itself
// to the broadcast language, which the server includes in status messages.
class ListenerApp {
  constructor({ statusEl, transcriptEl, connectBtn, titleEl, labelEl }) {
    this.statusEl = statusEl;
    this.transcriptEl = transcriptEl;
    this.connectBtn = connectBtn;
    this.titleEl = titleEl;
    this.labelEl = labelEl;
    this.userDisconnected = false;
    this.hasConnectedOnce = false;
    // Must match the static text in listener.html; applyLanguage() re-renders
    // as soon as the real broadcast language is known.
    this.lang = "en";
    this.t = messagesFor("en");
    this.statusKey = "none";
    this.buttonState = "connect";

    this.wakeLock = new ScreenWakeLock();

    this.player = new LiveAudioPlayer("/stream", {
      title: this.t.live,
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

    this.loadInitialLanguage();
  }

  wsUrl() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}/ws/listener`;
  }

  // Before the WS connects (user hasn't tapped yet), take the live broadcast
  // language from the server so the first paint is already localized.
  async loadInitialLanguage() {
    let cfg;
    try {
      const res = await fetch("/api/config");
      cfg = await res.json();
    } catch {
      return; // keep the default; the WS status message will correct it later
    }
    this.applyLanguage(cfg.language || cfg.targetLanguage);
  }

  applyLanguage(lang) {
    if (!lang || lang === this.lang) return;
    const t = messagesFor(lang);
    if (!t) return; // unknown code — keep current UI
    this.lang = lang;
    this.t = t;
    document.documentElement.lang = lang;
    document.title = t.title;
    this.titleEl.textContent = t.title;
    this.labelEl.textContent = t.label;
    this.player.setMediaMetadata({ title: t.live, artist: "Access GT" });
    this.renderStatus();
    this.renderButton();
  }

  async connect() {
    this.userDisconnected = false;
    this.setButton("connecting");
    try {
      await this.player.connect(); // needs the user gesture we're in
    } catch (_) {
      this.setButton("connect");
      this.setStatus("tapActivate");
      return;
    }
    this.hasConnectedOnce = true;
    await this.wakeLock.enable();
    this.socket.connect();
    this.setButton("disconnect");
    this.setStatus("audioOn");
  }

  async disconnect() {
    this.userDisconnected = true;
    this.socket.close();
    this.player.disconnect();
    await this.wakeLock.disable();
    this.transcriptEl.textContent = "";
    this.setStatus("none");
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
        this.applyLanguage(msg.language);
        this.handleStatusChange(msg.state);
        break;
    }
  }

  handleStatusChange(state) {
    switch (state) {
      case "active":
        this.setStatus("live");
        this.transcriptEl.textContent = "";
        break;
      case "idle":
        this.setStatus("paused");
        break;
      case "error":
        this.setStatus("error");
        break;
    }
  }

  handlePlaying() {
    if (this.statusKey === "none" || STATUS_TYPES[this.statusKey] === "error") {
      this.setStatus("waiting");
    }
    // Playback can (re)start from a recovery path; keep the button truthful.
    if (!this.userDisconnected) this.setButton("disconnect");
  }

  // Autoplay was blocked (no valid gesture); ask for a tap to resume.
  showTapToResume() {
    this.setStatus("tapResume");
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

  setStatus(key) {
    this.statusKey = key;
    this.renderStatus();
  }

  renderStatus() {
    this.statusEl.textContent = this.statusKey === "none" ? "" : this.t[this.statusKey];
    this.statusEl.className = `status status-${STATUS_TYPES[this.statusKey]}`;
  }

  setButton(state) {
    this.buttonState = state;
    this.renderButton();
  }

  renderButton() {
    const state = this.buttonState;
    this.connectBtn.disabled = state === "connecting";
    if (state === "connecting") {
      this.connectBtn.textContent = this.t.connecting;
      return;
    }
    const disconnect = state === "disconnect";
    this.connectBtn.textContent = disconnect ? this.t.disconnect : this.t.connect;
    this.connectBtn.classList.toggle("btn-danger", disconnect);
    this.connectBtn.classList.toggle("btn-primary", !disconnect);
  }
}

new ListenerApp({
  statusEl: document.getElementById("status"),
  transcriptEl: document.getElementById("translated-text"),
  connectBtn: document.getElementById("connect-btn"),
  titleEl: document.getElementById("page-title"),
  labelEl: document.getElementById("transcript-label"),
});
