const statusEl = document.getElementById("status");
const translatedTextEl = document.getElementById("translated-text");
const connectBtn = document.getElementById("connect-btn");

const STREAM_URL = "/stream";
const MAX_DRIFT_S = 1.5; // speed up slightly if buffered further behind live than this

let ws = null;
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
  if (document.visibilityState !== "visible") return;
  if (noSleep && !noSleep.isEnabled && player && !player.paused) {
    enableNoSleep();
  }
  // Audio keeps playing while locked, but nudge it if it stalled in background.
  if (player && !userDisconnected && player.paused === false && player.readyState < 3) {
    reloadStream();
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
}

// Reconnect to the live stream after a network drop / stall.
function reloadStream() {
  if (userDisconnected || !player) return;
  if (stallTimer) return;
  stallTimer = setTimeout(() => {
    stallTimer = null;
    if (userDisconnected || !player) return;
    player.src = STREAM_URL;
    player.play().catch(() => {});
  }, 2000);
}

// Keep latency low: if the buffer drifts too far behind live, speed up gently.
function startLatencyGuard() {
  if (latencyGuard) return;
  latencyGuard = setInterval(() => {
    if (!player || player.paused) return;
    const b = player.buffered;
    if (!b.length) return;
    const ahead = b.end(b.length - 1) - player.currentTime;
    player.playbackRate = ahead > MAX_DRIFT_S ? 1.08 : 1.0;
  }, 1000);
}

async function connect() {
  if (!player) createPlayer();
  setupMediaSession();

  userDisconnected = false;
  player.src = STREAM_URL; // (re)connect at the live edge
  try {
    await player.play(); // requires the user gesture we're in
  } catch (err) {
    setStatus("Toca de nuevo para activar el audio", "error");
    return;
  }

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

  await disableNoSleep();

  translatedTextEl.textContent = "";
  setStatus("", "idle");
  connectBtn.textContent = "Conectar";
  connectBtn.classList.remove("btn-danger");
  connectBtn.classList.add("btn-primary");
}

function connectWebSocket() {
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
    setTimeout(connectWebSocket, 3000);
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
