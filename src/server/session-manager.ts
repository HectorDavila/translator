import type { WebSocket } from "ws";
import { OpenAITranslator } from "./openai-translator.js";
import { Broadcaster } from "./broadcast.js";
import type { SessionState, OperatorMessage } from "./types.js";

export class SessionManager {
  private state: SessionState = "idle";
  private translator: OpenAITranslator;
  private broadcaster: Broadcaster;
  private operatorWs: WebSocket | null = null;

  constructor(apiKey: string, targetLanguage: string) {
    this.translator = new OpenAITranslator(apiKey, targetLanguage);
    this.broadcaster = new Broadcaster();

    this.translator.onTranslatedAudio((audio) => {
      this.broadcaster.broadcastAudio(Buffer.from(audio, "base64"));
    });

    this.translator.onOriginalTranscript((text) => {
      this.broadcaster.broadcastTranscript("original", text);
    });

    this.translator.onTranslatedTranscript((text) => {
      this.broadcaster.broadcastTranscript("translated", text);
    });

    this.translator.onConnected(() => {
      this.setState("active");
    });

    this.translator.onDisconnected((reason) => {
      if (this.state === "active") {
        this.setState("error");
        console.error(`[Session] Lost OpenAI connection: ${reason}`);
      }
    });
  }

  handleOperatorConnection(ws: WebSocket): void {
    if (this.operatorWs) {
      ws.close(4001, "Another operator is already connected");
      return;
    }

    this.operatorWs = ws;
    console.log("[Session] Operator connected");

    ws.on("message", (data, isBinary) => {
      // Binary frames are raw PCM16 audio; text frames are JSON control messages.
      if (isBinary) {
        if (this.state === "active") {
          this.translator.sendAudio((data as Buffer).toString("base64"));
        }
        return;
      }

      let message: OperatorMessage;
      try {
        message = JSON.parse(data.toString());
      } catch {
        console.error("[Session] Failed to parse operator message");
        return;
      }
      this.handleOperatorMessage(message);
    });

    ws.on("close", () => {
      console.log("[Session] Operator disconnected");
      this.operatorWs = null;
      this.stopSession();
    });

    ws.on("error", (err) => {
      console.error("[Session] Operator WebSocket error:", err.message);
      this.operatorWs = null;
      this.stopSession();
    });
  }

  handleListenerConnection(ws: WebSocket): void {
    this.broadcaster.addListener(ws);

    const statusMsg = JSON.stringify({ type: "status", state: this.state });
    ws.send(statusMsg);

    console.log(
      `[Session] Listener connected (total: ${this.broadcaster.getListenerCount()})`
    );
  }

  getState(): SessionState {
    return this.state;
  }

  getListenerCount(): number {
    return this.broadcaster.getListenerCount();
  }

  private handleOperatorMessage(message: OperatorMessage): void {
    switch (message.type) {
      case "start_session":
        this.startSession();
        break;

      case "stop_session":
        this.stopSession();
        break;
    }
  }

  private startSession(): void {
    if (this.state === "active") return;

    console.log("[Session] Starting translation session");
    this.translator.connect();
  }

  private stopSession(): void {
    if (this.state === "idle") return;

    console.log("[Session] Stopping translation session");
    this.translator.disconnect();
    this.setState("idle");
  }

  private setState(newState: SessionState): void {
    this.state = newState;
    this.broadcaster.broadcastStatus(newState);

    if (this.operatorWs && this.operatorWs.readyState === this.operatorWs.OPEN) {
      this.operatorWs.send(JSON.stringify({ type: "status", state: newState }));
    }

    console.log(`[Session] State changed to: ${newState}`);
  }
}
