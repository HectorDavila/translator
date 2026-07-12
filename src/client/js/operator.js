const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const statusEl = document.getElementById("status");
const levelEl = document.getElementById("audio-level");
const listenerCountEl = document.getElementById("listener-count");
const vadIndicator = document.getElementById("vad-indicator");

let ws = null;
let audioContext = null;
let workletNode = null;
let mediaStream = null;
let noSleep = null;
let wantSession = false; // pressed Iniciar and hasn't pressed Detener

function getWsUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws/operator`;
}

function setStatus(text, type) {
  statusEl.textContent = text;
  statusEl.className = `status status-${type}`;
}

async function enableNoSleep() {
  if (typeof NoSleep === "undefined") return;
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

function connectWebSocket() {
  ws = new WebSocket(getWsUrl());

  ws.onopen = () => {
    setStatus("Conectado al servidor", "idle");
    startBtn.disabled = false;
    // If we were mid-session when the socket dropped, resume it: the server
    // keeps the translation alive during a grace period.
    if (wantSession && mediaStream) {
      ws.send(JSON.stringify({ type: "start_session" }));
      startBtn.disabled = true;
      stopBtn.disabled = false;
    }
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "status") {
      if (msg.state === "active") {
        setStatus("Traduciendo en vivo", "active");
      } else if (msg.state === "error") {
        setStatus("Error en la traducción", "error");
      }
    }
  };

  ws.onclose = () => {
    setStatus("Reconectando al servidor...", "error");
    startBtn.disabled = true;
    stopBtn.disabled = true;
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = () => {
    setStatus("Error de conexión", "error");
  };
}

async function startSession() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 48000,
      },
    });

    audioContext = new AudioContext({ sampleRate: 48000 });
    await audioContext.audioWorklet.addModule("/js/audio-worklet.js");

    const source = audioContext.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioContext, "pcm-capture-processor");
    source.connect(workletNode);

    // The worklet does VAD + preroll on the audio thread (immune to screen
    // lock); here we only forward chunks and paint the meter.
    workletNode.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "audio" && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(msg.data); // binary PCM16 frame
      }
      updateMeter(msg.rms ?? 0, msg.speaking === true);
    };

    wantSession = true;
    ws?.send(JSON.stringify({ type: "start_session" }));
    await enableNoSleep(); // keep the operator device awake during the service

    startBtn.disabled = true;
    stopBtn.disabled = false;
  } catch (err) {
    setStatus(`Error: ${err.message}`, "error");
  }
}

function stopSession() {
  wantSession = false;
  ws?.send(JSON.stringify({ type: "stop_session" }));

  workletNode?.disconnect();
  workletNode = null;

  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;

  audioContext?.close();
  audioContext = null;

  disableNoSleep();

  updateMeter(0, false);
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus("Sesión detenida", "idle");
}

// Meter updates arrive every ~100ms from the worklet — no rAF needed.
function updateMeter(rms, speaking) {
  levelEl.style.width = `${Math.min(100, Math.round(rms * 700))}%`;
  if (vadIndicator) {
    vadIndicator.textContent = speaking ? "Enviando audio" : "En silencio (pausado)";
    vadIndicator.className = speaking ? "vad-status vad-active" : "vad-status vad-silent";
  }
}

// Re-acquire the wake lock when returning to the foreground mid-session.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (wantSession && noSleep && !noSleep.isEnabled) enableNoSleep();
});

setInterval(async () => {
  try {
    const res = await fetch("/health");
    const data = await res.json();
    listenerCountEl.textContent = data.listeners.toString();
  } catch {
    // ignore
  }
}, 5000);

startBtn.addEventListener("click", startSession);
stopBtn.addEventListener("click", stopSession);

setStatus("Conectando...", "idle");
connectWebSocket();
