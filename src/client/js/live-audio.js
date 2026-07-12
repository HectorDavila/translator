// Latency guard tiers: catch up gently, harder if far behind, and jump
// straight to the live edge when hopelessly behind (it's a live translation —
// old audio is worthless). playbackRate preserves pitch in browsers.
const DRIFT_SOFT_S = 1.5;
const DRIFT_HARD_S = 4;
const DRIFT_JUMP_S = 8;
const RELOAD_DELAY_MS = 2000;
const GUARD_INTERVAL_MS = 1000;

// Plays the server's continuous MP3 stream through an <audio> element — the
// one playback mechanism iOS/Android keep running on a locked screen. Owns
// stall/drop recovery and the latency guard; the page owns user intent,
// button state, and status text via the callbacks.
export class LiveAudioPlayer {
  constructor(streamUrl, mediaMetadata) {
    this.streamUrl = streamUrl;
    this.mediaMetadata = mediaMetadata; // { title, artist } for the lock screen
    this.audio = null;
    this.active = false; // user wants playback (between connect and disconnect)
    this.stallTimer = null;
    this.guardTimer = null;

    // Assign these before connect(); both are optional.
    this.onPlaying = () => {};
    this.onAutoplayBlocked = () => {}; // resume needs a fresh user gesture
  }

  get playing() {
    return !!this.audio && !this.audio.paused;
  }

  // Paused without the user disconnecting — e.g. iOS/Android pausing media
  // for a phone call or Siri.
  get interrupted() {
    return this.active && !!this.audio && this.audio.paused;
  }

  // Must be called from a user gesture (autoplay policy). Throws if blocked.
  async connect() {
    this.ensureAudio();
    this.setupMediaSession();
    this.active = true;
    this.audio.src = this.streamUrl; // (re)join at the live edge
    await this.audio.play();
    this.startLatencyGuard();
  }

  disconnect() {
    this.active = false;
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    if (this.guardTimer) {
      clearInterval(this.guardTimer);
      this.guardTimer = null;
    }
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
    }
  }

  resume() {
    if (!this.interrupted) return;
    this.audio.play().catch(() => this.onAutoplayBlocked());
  }

  // Kick a playback that stalled while the page was in the background.
  nudgeIfStalled() {
    if (this.playing && this.audio.readyState < 3) this.scheduleReload();
  }

  ensureAudio() {
    if (this.audio) return;
    this.audio = new Audio();
    this.audio.preload = "none";
    this.audio.setAttribute("playsinline", "");
    this.audio.addEventListener("playing", () => this.onPlaying());
    const reload = () => this.scheduleReload();
    this.audio.addEventListener("stalled", reload);
    this.audio.addEventListener("error", reload);
    this.audio.addEventListener("ended", reload); // server restarted the stream
  }

  // Debounced reconnect after a stall/drop; rejoins at the live edge.
  scheduleReload() {
    if (!this.active || this.stallTimer) return;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (!this.active) return;
      this.audio.src = this.streamUrl;
      this.audio.play().catch(() => this.onAutoplayBlocked());
    }, RELOAD_DELAY_MS);
  }

  startLatencyGuard() {
    if (this.guardTimer) return;
    this.guardTimer = setInterval(() => {
      if (!this.playing) return;
      const buffered = this.audio.buffered;
      if (!buffered.length) return;
      const liveEdge = buffered.end(buffered.length - 1);
      const behind = liveEdge - this.audio.currentTime;
      if (behind > DRIFT_JUMP_S) {
        this.audio.currentTime = liveEdge - 1;
        this.audio.playbackRate = 1.0;
      } else {
        this.audio.playbackRate =
          behind > DRIFT_HARD_S ? 1.2 : behind > DRIFT_SOFT_S ? 1.08 : 1.0;
      }
    }, GUARD_INTERVAL_MS);
  }

  setMediaMetadata(mediaMetadata) {
    this.mediaMetadata = mediaMetadata;
    if (this.audio) this.setupMediaSession();
  }

  // Lock-screen metadata and controls.
  setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata(this.mediaMetadata);
      navigator.mediaSession.setActionHandler("play", () => this.audio?.play());
      navigator.mediaSession.setActionHandler("pause", () => this.audio?.pause());
    } catch (_) {}
  }
}
