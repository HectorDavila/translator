const statusEl = document.getElementById("status");
const translatedTextEl = document.getElementById("translated-text");
const connectBtn = document.getElementById("connect-btn");

const SOURCE_SAMPLE_RATE = 24000;
const TARGET_LEAD_S = 0.25;
const MAX_LEAD_S = 1.5;
const AudioContextClass = window.AudioContext || window.webkitAudioContext;

let ws = null;
let audioContext = null;
let gainNode = null;
let nextStartTime = 0;
let isUnlocked = false;
let pendingChunks = [];
let noSleep = null;
let userDisconnected = false;
let silentAudio = null;

// A looping silent <audio> element promotes iOS to the "playback" audio
// session, so Web Audio plays through the speaker even with the Ring/Silent
// switch on. Must be started inside the user gesture (Conectar tap).
function createSilentWavUrl(durationSec = 0.05, sampleRate = 8000) {
  const numSamples = Math.floor(durationSec * sampleRate);
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, numSamples * 2, true);
  return URL.createObjectURL(new Blob([view], { type: "audio/wav" }));
}

function startSilentLoop() {
  if (!silentAudio) {
    silentAudio = new Audio(createSilentWavUrl());
    silentAudio.loop = true;
    silentAudio.setAttribute("playsinline", "");
  }
  const p = silentAudio.play();
  if (p && p.catch) p.catch(() => {});
}

function stopSilentLoop() {
  if (silentAudio) silentAudio.pause();
}

async function enableNoSleep() {
  if (typeof NoSleep === "undefined") {
    console.warn("NoSleep.js no cargó — pantalla puede apagarse");
    return;
  }
  if (!noSleep) noSleep = new NoSleep();
  try {
    await noSleep.enable();
  } catch (err) {
    console.warn("NoSleep.enable() falló:", err);
  }
}

async function disableNoSleep() {
  if (noSleep && noSleep.isEnabled) {
    try {
      await noSleep.disable();
    } catch (_) {}
  }
}

document.addEventListener("visibilitychange", () => {
  if (
    document.visibilityState === "visible" &&
    ws &&
    ws.readyState === WebSocket.OPEN &&
    noSleep &&
    !noSleep.isEnabled
  ) {
    enableNoSleep();
  }
});

function getWsUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws/listener`;
}

function setStatus(text, type) {
  statusEl.textContent = text;
  statusEl.className = `status status-${type}`;
}

async function connect() {
  if (!audioContext) {
    audioContext = new AudioContextClass({ sampleRate: SOURCE_SAMPLE_RATE });
    gainNode = audioContext.createGain();
    gainNode.connect(audioContext.destination);
    gainNode.gain.value = 1.0;
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  const silentBuffer = audioContext.createBuffer(1, 1, SOURCE_SAMPLE_RATE);
  const silentSource = audioContext.createBufferSource();
  silentSource.buffer = silentBuffer;
  silentSource.connect(audioContext.destination);
  silentSource.start(0);

  startSilentLoop();

  isUnlocked = true;
  nextStartTime = audioContext.currentTime;

  for (const chunk of pendingChunks) {
    scheduleChunk(chunk);
  }
  pendingChunks = [];

  await enableNoSleep();

  userDisconnected = false;
  connectWebSocket();
  connectBtn.textContent = "Desconectar";
  connectBtn.classList.remove("btn-primary");
  connectBtn.classList.add("btn-danger");
  setStatus("Audio activado — conectando...", "idle");
}

async function disconnect() {
  userDisconnected = true;

  if (ws) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.close(1000, "User disconnected");
    ws = null;
  }

  await disableNoSleep();
  stopSilentLoop();

  pendingChunks = [];
  isUnlocked = false;
  if (audioContext) {
    nextStartTime = audioContext.currentTime;
  }

  translatedTextEl.textContent = "";
  setStatus("", "idle");
  connectBtn.textContent = "Conectar";
  connectBtn.classList.remove("btn-danger");
  connectBtn.classList.add("btn-primary");
}

function connectWebSocket() {
  ws = new WebSocket(getWsUrl());
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    setStatus("Conectado — esperando traducción", "idle");
  };

  ws.onmessage = (event) => {
    // Binary frames are raw PCM16 audio; text frames are JSON control messages.
    if (typeof event.data !== "string") {
      handleAudio(event.data);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "transcript":
        if (msg.source === "translated") {
          appendText(translatedTextEl, msg.text);
        }
        break;

      case "status":
        handleStatusChange(msg.state);
        break;
    }
  };

  ws.onclose = () => {
    if (userDisconnected) return;
    setStatus("Desconectado — reconectando...", "error");
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = () => {
    setStatus("Error de conexión", "error");
  };
}

function handleAudio(arrayBuffer) {
  // PCM16 byte length must be even; guard against a truncated frame.
  const pcm16 = new Int16Array(arrayBuffer, 0, arrayBuffer.byteLength >> 1);
  const float32 = new Float32Array(pcm16.length);

  for (let i = 0; i < pcm16.length; i++) {
    float32[i] = pcm16[i] / 32768;
  }

  if (!isUnlocked) {
    pendingChunks.push(float32);
    return;
  }

  scheduleChunk(float32);
}

function scheduleChunk(float32) {
  if (!audioContext || !gainNode) return;

  const now = audioContext.currentTime;
  const lead = nextStartTime - now;

  if (lead > MAX_LEAD_S || lead < 0) {
    nextStartTime = now + TARGET_LEAD_S;
  }

  const buffer = audioContext.createBuffer(1, float32.length, SOURCE_SAMPLE_RATE);
  buffer.getChannelData(0).set(float32);

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(gainNode);

  source.start(nextStartTime);
  nextStartTime += buffer.duration;
}

function appendText(el, text) {
  el.textContent += text;

  if (el.textContent.length > 2000) {
    el.textContent = el.textContent.slice(-1600);
  }

  el.scrollTop = el.scrollHeight;
}

function handleStatusChange(state) {
  switch (state) {
    case "active":
      setStatus("Traducción en vivo", "active");
      translatedTextEl.textContent = "";
      nextStartTime = audioContext ? audioContext.currentTime : 0;
      pendingChunks = [];
      break;
    case "idle":
      setStatus("Servicio en pausa", "idle");
      break;
    case "error":
      setStatus("Error en la traducción", "error");
      break;
  }
}

connectBtn.addEventListener("click", () => {
  if (ws && ws.readyState !== WebSocket.CLOSED) {
    disconnect();
  } else {
    connect();
  }
});

window.addEventListener("pagehide", () => {
  disableNoSleep();
});

