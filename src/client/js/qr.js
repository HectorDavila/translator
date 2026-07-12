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
      showWarning("No LAN IP detected on the server. Set PUBLIC_HOST or access it via your network IP.");
    }
  } catch (err) {
    const fallback = `${location.protocol}//${location.host}/listener.html`;
    render(fallback);
    if (/localhost|127\.0\.0\.1/.test(location.host)) {
      showWarning("You are on localhost. Phones cannot scan this URL. Access the server via its LAN IP.");
    }
  }
}

init();
