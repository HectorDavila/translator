const statusEl = document.getElementById("status");
const translatedTextEl = document.getElementById("translated-text");
const connectBtn = document.getElementById("connect-btn");

const STREAM_URL = "/stream";
// Latency guard tiers: catch up gently, harder if far behind, and jump
// straight to the live edge when hopelessly behind (it's a live translation —
// old audio is worthless).
const DRIFT_SOFT_S = 1.5;
const DRIFT_HARD_S = 4;
const DRIFT_JUMP_S = 8;

let ws = null;
let wsRetryTimer = null;
let player = null;
let noSleep = null;
let userDisconnected = false;
let stallTimer = null;
let latencyGuard = null;

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
  if (document.visibilityState !== "visible" || userDisconnected) return;
  if (noSleep && !noSleep.isEnabled && player && !player.paused) {
    enableNoSleep();
  }
  if (player && player.src && player.paused) {
    // iOS/Android pause media on interruptions (calls, Siri); resume the live feed.
    player.play().catch(() => showTapToResume());
  } else if (player && !player.paused && player.readyState < 3) {
    // Audio keeps playing while locked, but nudge it if it stalled in background.
    reloadStream();
  }
  // Revive the transcript socket if it died while the screen was locked
  // (only once the user has connected at least once — player exists).
  if (player && (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING)) {
    connectWebSocket();
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

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: "Traducción en vivo",
      artist: "Access GT",
    });
    navigator.mediaSession.setActionHandler("play", () => player && player.play());
    navigator.mediaSession.setActionHandler("pause", () => player && player.pause());
  } catch (_) {}
}

function createPlayer() {
  player = new Audio();
  player.preload = "none";
  player.setAttribute("playsinline", "");

  player.addEventListener("playing", () => {
    if (statusEl.textContent === "" || statusEl.classList.contains("status-error")) {
      setStatus("Conectado — esperando traducción", "idle");
    }
  });
  player.addEventListener("stalled", reloadStream);
  player.addEventListener("error", reloadStream);
  player.addEventListener("ended", reloadStream); // server restarted the stream
}

// Autoplay was blocked (no valid gesture); ask for a tap and reflect it in the button.
function showTapToResume() {
  setStatus("Toca Conectar para reanudar el audio", "error");
  connectBtn.textContent = "Conectar";
  connectBtn.classList.remove("btn-danger");
  connectBtn.classList.add("btn-primary");
}

// Reconnect to the live stream after a network drop / stall.
function reloadStream() {
  if (userDisconnected || !player) return;
  if (stallTimer) return;
  stallTimer = setTimeout(() => {
    stallTimer = null;
    if (userDisconnected || !player) return;
    player.src = STREAM_URL;
    player.play().catch(() => showTapToResume());
  }, 2000);
}

// Keep latency low: if the buffer drifts behind live, speed up (pitch is
// preserved by the browser); if hopelessly behind, seek to the live edge.
function startLatencyGuard() {
  if (latencyGuard) return;
  latencyGuard = setInterval(() => {
    if (!player || player.paused) return;
    const b = player.buffered;
    if (!b.length) return;
    const liveEdge = b.end(b.length - 1);
    const ahead = liveEdge - player.currentTime;
    if (ahead > DRIFT_JUMP_S) {
      player.currentTime = liveEdge - 1;
      player.playbackRate = 1.0;
    } else {
      player.playbackRate = ahead > DRIFT_HARD_S ? 1.2 : ahead > DRIFT_SOFT_S ? 1.08 : 1.0;
    }
  }, 1000);
}

async function connect() {
  if (!player) createPlayer();
  setupMediaSession();

  userDisconnected = false;
  connectBtn.disabled = true;
  connectBtn.textContent = "Conectando...";
  player.src = STREAM_URL; // (re)connect at the live edge
  try {
    await player.play(); // requires the user gesture we're in
  } catch (err) {
    connectBtn.disabled = false;
    connectBtn.textContent = "Conectar";
    setStatus("Toca de nuevo para activar el audio", "error");
    return;
  }
  connectBtn.disabled = false;

  await enableNoSleep();
  startLatencyGuard();
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

  if (player) {
    player.pause();
    player.removeAttribute("src");
    player.load();
  }
  if (stallTimer) {
    clearTimeout(stallTimer);
    stallTimer = null;
  }
  if (wsRetryTimer) {
    clearTimeout(wsRetryTimer);
    wsRetryTimer = null;
  }

  await disableNoSleep();

  translatedTextEl.textContent = "";
  setStatus("", "idle");
  connectBtn.textContent = "Conectar";
  connectBtn.classList.remove("btn-danger");
  connectBtn.classList.add("btn-primary");
}

function connectWebSocket() {
  if (wsRetryTimer) {
    clearTimeout(wsRetryTimer);
    wsRetryTimer = null;
  }
  if (userDisconnected) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  ws = new WebSocket(getWsUrl());

  ws.onopen = () => {};

  ws.onmessage = (event) => {
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
    wsRetryTimer = setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = () => {};
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
  if (player && !player.paused) {
    disconnect();
  } else {
    connect();
  }
});

window.addEventListener("pagehide", () => {
  disableNoSleep();
});
