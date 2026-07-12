import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { networkInterfaces } from "os";
import { loadConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import { AudioStreamer } from "./audio-stream.js";

function getLanIp(): string | null {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const config = loadConfig();

const app = express();
const server = createServer(app);

const clientPath = join(__dirname, "../client");
app.use(express.static(clientPath));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    session: sessionManager.getState(),
    listeners: sessionManager.getListenerCount(),
  });
});

app.get("/api/listener-url", (req, res) => {
  const protocol = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  if (config.publicHost) {
    res.json({ url: `${protocol}://${config.publicHost}/listener.html`, source: "env" });
    return;
  }
  const lanIp = getLanIp();
  if (lanIp) {
    res.json({ url: `http://${lanIp}:${config.port}/listener.html`, source: "lan" });
    return;
  }
  res.json({ url: `${protocol}://${req.get("host")}/listener.html`, source: "fallback" });
});

const audioStreamer = new AudioStreamer();
audioStreamer.start();

// Continuous MP3 stream — played via <audio> so it survives a locked screen.
app.get("/stream", (_req, res) => {
  audioStreamer.addClient(res);
});

const sessionManager = new SessionManager(
  config.openaiApiKey,
  config.targetLanguage,
  audioStreamer
);

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const path = req.url || "";

  (ws as any).isAlive = true;
  ws.on("pong", () => {
    (ws as any).isAlive = true;
  });

  if (path === "/ws/operator") {
    sessionManager.handleOperatorConnection(ws);
  } else if (path === "/ws/listener") {
    sessionManager.handleListenerConnection(ws);
  } else {
    ws.close(4000, "Invalid path. Use /ws/operator or /ws/listener");
  }
});

// Heartbeat: keep idle connections alive through NAT/proxy and drop dead ones.
const HEARTBEAT_MS = 15000;
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if ((ws as any).isAlive === false) {
      ws.terminate();
      continue;
    }
    (ws as any).isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

wss.on("close", () => clearInterval(heartbeat));

server.listen(config.port, () => {
  console.log(`[Server] Running on http://localhost:${config.port}`);
  console.log(`[Server] Target language: ${config.targetLanguage}`);
  console.log(`[Server] Operator: http://localhost:${config.port}/operator.html`);
  console.log(`[Server] Listener: http://localhost:${config.port}/listener.html`);
});
