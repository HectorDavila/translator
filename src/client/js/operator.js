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
let analyser = null;
let animationFrame = null;

// VAD settings
const VAD_THRESHOLD = 15; // minimum average frequency level to consider "speech"
const VAD_SILENCE_DELAY_MS = 1500; // keep sending for 1.5s after last speech detected
let isSpeaking = false;
let lastSpeechTime = 0;

// Pre-roll: buffer the most recent silent chunks (~100ms each) and flush them
// when speech starts, so the onset of each utterance isn't clipped.
const PREROLL_CHUNKS = 3;
let prerollChunks = [];
let sending = false;

function getWsUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws/operator`;
}

function setStatus(text, type) {
  statusEl.textContent = text;
  statusEl.className = `status status-${type}`;
}

function connectWebSocket() {
  ws = new WebSocket(getWsUrl());

  ws.onopen = () => {
    setStatus("Conectado al servidor", "idle");
    startBtn.disabled = false;
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
    setStatus("Desconectado del servidor", "error");
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

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    workletNode = new AudioWorkletNode(audioContext, "pcm-capture-processor");
    source.connect(workletNode);

    workletNode.port.onmessage = (event) => {
      if (event.data.type !== "audio") return;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const pcm16 = event.data.data;

      if (isSpeaking) {
        if (!sending) {
          sending = true;
          for (const chunk of prerollChunks) ws.send(chunk);
          prerollChunks = [];
        }
        ws.send(pcm16); // binary PCM16 frame
      } else {
        sending = false;
        prerollChunks.push(pcm16);
        if (prerollChunks.length > PREROLL_CHUNKS) prerollChunks.shift();
      }
    };

    prerollChunks = [];
    sending = false;
    ws?.send(JSON.stringify({ type: "start_session" }));

    startBtn.disabled = true;
    stopBtn.disabled = false;
    startAudioLevelMonitor();
  } catch (err) {
    setStatus(`Error: ${err.message}`, "error");
  }
}

function stopSession() {
  ws?.send(JSON.stringify({ type: "stop_session" }));

  if (animationFrame) {
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }

  workletNode?.disconnect();
  workletNode = null;

  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;

  audioContext?.close();
  audioContext = null;
  analyser = null;

  levelEl.style.width = "0%";
  isSpeaking = false;
  updateVadIndicator();
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus("Sesión detenida", "idle");
}

function startAudioLevelMonitor() {
  if (!analyser) return;

  const dataArray = new Uint8Array(analyser.frequencyBinCount);

  function updateLevel() {
    analyser.getByteFrequencyData(dataArray);
    const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
    const level = Math.min(100, (average / 128) * 100);
    levelEl.style.width = `${level}%`;

    // VAD logic
    const now = Date.now();
    if (average > VAD_THRESHOLD) {
      lastSpeechTime = now;
      if (!isSpeaking) {
        isSpeaking = true;
        updateVadIndicator();
      }
    } else if (isSpeaking && now - lastSpeechTime > VAD_SILENCE_DELAY_MS) {
      isSpeaking = false;
      updateVadIndicator();
    }

    animationFrame = requestAnimationFrame(updateLevel);
  }

  updateLevel();
}

function updateVadIndicator() {
  if (vadIndicator) {
    vadIndicator.textContent = isSpeaking ? "Enviando audio" : "En silencio (pausado)";
    vadIndicator.className = isSpeaking ? "vad-status vad-active" : "vad-status vad-silent";
  }
}

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
