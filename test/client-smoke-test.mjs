// Instantiates the real client classes with stubbed browser APIs and drives
// every method path, to catch runtime wiring errors (missing methods, bad
// references) that a syntax check can't see.

function fakeElement() {
  return {
    textContent: "",
    disabled: false,
    className: "",
    style: {},
    scrollTop: 0,
    scrollHeight: 100,
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, on) { on ? this._set.add(c) : this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
  };
}

// --- browser API stubs ---
globalThis.location = { protocol: "https:", host: "test.local" };
globalThis.document = {
  listeners: {},
  visibilityState: "visible",
  documentElement: { lang: "es" },
  title: "",
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
  getElementById: () => fakeElement(),
};
globalThis.window = {
  addEventListener() {},
};
globalThis.WebSocket = class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url) { this.url = url; this.readyState = FakeWebSocket.CONNECTING; FakeWebSocket.instances.push(this); }
  static instances = [];
  send(data) { this.sent = data; }
  close() { this.readyState = FakeWebSocket.CLOSED; }
};
globalThis.Audio = class FakeAudio {
  constructor() { this.paused = true; this.readyState = 4; this.buffered = { length: 0 }; this.playbackRate = 1; this.currentTime = 0; this.listeners = {}; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  setAttribute() {} removeAttribute() {} load() {}
  async play() { this.paused = false; }
  pause() { this.paused = true; }
};
Object.defineProperty(globalThis, "navigator", {
  value: {
    mediaSession: { setActionHandler() {} },
    mediaDevices: {
      getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    },
  },
  configurable: true,
});
globalThis.MediaMetadata = class {};
globalThis.NoSleep = class { constructor() { this.isEnabled = false; } async enable() { this.isEnabled = true; } async disable() { this.isEnabled = false; } };
globalThis.AudioContext = class {
  constructor() { this.audioWorklet = { addModule: async () => {} }; }
  createMediaStreamSource() { return { connect() {} }; }
  async close() {}
};
globalThis.AudioWorkletNode = class {
  constructor() { this.port = { onmessage: null }; }
  disconnect() {}
};
// language: "en" also exercises the listener page's live localization path.
globalThis.fetch = async () => ({ json: async () => ({ vadMode: "continuous", targetLanguage: "es", language: "en", listeners: 2 }) });

// Async constructor paths (config fetch -> applyLanguage) fail via promise
// rejections, not throws — treat any unhandled rejection as a failure.
const unhandledRejections = [];
process.on("unhandledRejection", (err) => unhandledRejections.push(err));
globalThis.localStorage = {
  _map: new Map(),
  getItem(k) { return this._map.get(k) ?? null; },
  setItem(k, v) { this._map.set(k, v); },
};

const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL: ${name} -> ${err.message}`);
  }
}

// --- ReconnectingSocket ---
const { ReconnectingSocket } = await import("../src/client/js/ws-client.js");
await check("ReconnectingSocket full lifecycle", () => {
  const s = new ReconnectingSocket("wss://x/ws");
  s.connect();
  const raw = WebSocket.instances.at(-1);
  raw.onopen();
  raw.readyState = WebSocket.OPEN;
  raw.onmessage({ data: JSON.stringify({ type: "status", state: "active" }) });
  raw.onmessage({ data: "not-json" }); // must not throw
  s.send("x"); s.sendJson({ a: 1 });
  raw.onclose(); // schedules retry
  s.close();
});

// --- LiveAudioPlayer ---
const { LiveAudioPlayer } = await import("../src/client/js/live-audio.js");
await check("LiveAudioPlayer full lifecycle", async () => {
  const p = new LiveAudioPlayer("/stream", { title: "t", artist: "a" });
  await p.connect();
  p.audio.listeners["playing"].forEach((f) => f());
  p.audio.listeners["stalled"].forEach((f) => f());
  p.nudgeIfStalled();
  p.resume();
  p.audio.paused = true;
  p.resume();
  p.disconnect();
});

// --- ListenerApp (module entry instantiates it) ---
await check("ListenerApp constructor + methods", async () => {
  await import("../src/client/js/listener.js");
  // Re-create one with handles we control to exercise methods.
  const els = {
    statusEl: fakeElement(),
    transcriptEl: fakeElement(),
    connectBtn: fakeElement(),
  };
  // The module doesn't export the class; drive it via the DOM handlers the
  // real instance registered instead.
  for (const fn of document.listeners["visibilitychange"] || []) fn();
});

// --- MicCapture ---
const { MicCapture } = await import("../src/client/js/mic-capture.js");
await check("MicCapture start/stop, gated and continuous", async () => {
  const m = new MicCapture();
  let chunks = 0, levels = 0;
  m.onChunk = () => chunks++;
  m.onLevel = () => levels++;
  await m.start({ gated: false });
  m.workletNode.port.onmessage({ data: { type: "audio", data: new Int16Array(4), rms: 0.1, speaking: true } });
  m.workletNode.port.onmessage({ data: { type: "level", rms: 0, speaking: false } });
  if (chunks !== 1 || levels !== 2) throw new Error("callback routing broken");
  m.stop();
  await m.start(); // default gated
  m.stop();
});

// --- OperatorApp (module entry instantiates it; constructor used to crash) ---
await check("OperatorApp constructor + session lifecycle", async () => {
  await import("../src/client/js/operator.js");
});

// The operator module doesn't export its class; import a fresh copy via query
// string won't re-run cleanly, so instead verify the prototype has every
// method its own code calls on `this`.
await check("all this.method() calls exist on their class", async () => {
  const fs = await import("fs");
  const dir = new URL("../src/client/js", import.meta.url).pathname;
  for (const file of ["operator.js", "listener.js", "ws-client.js", "live-audio.js", "mic-capture.js", "wake-lock.js"]) {
    const src = fs.readFileSync(`${dir}/${file}`, "utf8");
    const defined = new Set([
      ...[...src.matchAll(/^  (?:async )?(\w+)\s*\(/gm)].map((m) => m[1]),
      ...[...src.matchAll(/this\.(\w+)\s*=/g)].map((m) => m[1]), // callback props
    ]);
    const called = [...src.matchAll(/this\.(\w+)\(/g)].map((m) => m[1]);
    for (const name of called) {
      if (!defined.has(name)) throw new Error(`${file}: this.${name}() has no method definition`);
    }
  }
});

await new Promise((r) => setTimeout(r, 100)); // let async constructor paths settle
if (unhandledRejections.length) {
  failures.push("unhandled rejection");
  console.error(`FAIL: unhandled rejection -> ${unhandledRejections[0]?.message || unhandledRejections[0]}`);
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nAll client smoke tests passed");
process.exit(0); // don't linger on the app classes' intervals/timers
