// Thin wrapper over NoSleep.js (loaded as a global <script> tag): Wake Lock
// API where supported, video fallback elsewhere. Needs HTTPS on iOS.
export class ScreenWakeLock {
  constructor() {
    this.noSleep = null;
  }

  get active() {
    return !!(this.noSleep && this.noSleep.isEnabled);
  }

  async enable() {
    if (typeof NoSleep === "undefined") {
      console.warn("NoSleep.js no cargó — pantalla puede apagarse");
      return;
    }
    if (!this.noSleep) this.noSleep = new NoSleep();
    try {
      await this.noSleep.enable();
    } catch (err) {
      console.warn("NoSleep.enable() falló:", err);
    }
  }

  async disable() {
    if (!this.active) return;
    try {
      await this.noSleep.disable();
    } catch (_) {}
  }
}
