import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { networkInterfaces } from "os";
import { SessionManager } from "./session-manager.js";

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

const PORT = parseInt(process.env.PORT || "3000", 10);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TARGET_LANGUAGE = process.env.TARGET_LANGUAGE || "es";

if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY environment variable is required");
  process.exit(1);
}

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
  const publicHost = process.env.PUBLIC_HOST;
  const protocol = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  if (publicHost) {
    res.json({ url: `${protocol}://${publicHost}/listener.html`, source: "env" });
    return;
  }
  const lanIp = getLanIp();
  if (lanIp) {
    res.json({ url: `http://${lanIp}:${PORT}/listener.html`, source: "lan" });
    return;
  }
  res.json({ url: `${protocol}://${req.get("host")}/listener.html`, source: "fallback" });
});

const sessionManager = new SessionManager(OPENAI_API_KEY, TARGET_LANGUAGE);

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const path = req.url || "";

  if (path === "/ws/operator") {
    sessionManager.handleOperatorConnection(ws);
  } else if (path === "/ws/listener") {
    sessionManager.handleListenerConnection(ws);
  } else {
    ws.close(4000, "Invalid path. Use /ws/operator or /ws/listener");
  }
});

server.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
  console.log(`[Server] Target language: ${TARGET_LANGUAGE}`);
  console.log(`[Server] Operator: http://localhost:${PORT}/operator.html`);
  console.log(`[Server] Listener: http://localhost:${PORT}/listener.html`);
});
