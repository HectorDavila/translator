const qrEl = document.getElementById("qr-code");
const urlEl = document.getElementById("qr-url");
const warningEl = document.getElementById("qr-warning");

function render(url) {
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  qrEl.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
  urlEl.textContent = url.replace(/^https?:\/\//, "");
}

function showWarning(text) {
  warningEl.textContent = text;
  warningEl.hidden = false;
}

async function init() {
  try {
    const res = await fetch("/api/listener-url");
    const { url, source } = await res.json();
    render(url);

    if (source === "fallback" && /localhost|127\.0\.0\.1/.test(url)) {
      showWarning("Servidor sin LAN IP detectada. Configura PUBLIC_HOST o accede vía la IP de tu red.");
    }
  } catch (err) {
    const fallback = `${location.protocol}//${location.host}/listener.html`;
    render(fallback);
    if (/localhost|127\.0\.0\.1/.test(location.host)) {
      showWarning("Estás en localhost. Los celulares no pueden escanear esta URL. Accede al servidor desde la IP de la LAN.");
    }
  }
}

init();
