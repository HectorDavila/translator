import type { WebSocket } from "ws";
import { OpenAITranslator } from "./openai-translator.js";
import { Broadcaster } from "./broadcast.js";
import type { AudioStreamer } from "./audio-stream.js";
import type { SessionState, OperatorMessage } from "./types.js";

// Keep translating this long after the operator's socket drops, so a network
// blip on the operator's device doesn't cut the sermon for every listener.
const OPERATOR_GRACE_MS = 60_000;

// The 13 output languages gpt-realtime-translate can speak (input is
// auto-detected, so only the output side is configurable).
export const OUTPUT_LANGUAGES = new Set([
  "en", "es", "pt", "fr", "de", "it", "ru", "zh", "ja", "ko", "hi", "id", "vi",
]);

export class SessionManager {
  private state: SessionState = "idle";
  private translator: OpenAITranslator;
  private broadcaster: Broadcaster;
  private audioStreamer: AudioStreamer;
  private operatorWs: WebSocket | null = null;
  private operatorGraceTimer: NodeJS.Timeout | null = null;

  constructor(
    apiKey: string,
    targetLanguage: string,
    audioStreamer: AudioStreamer
  ) {
    this.translator = new OpenAITranslator(apiKey, targetLanguage);
    this.broadcaster = new Broadcaster();
    this.audioStreamer = audioStreamer;

    this.translator.onTranslatedAudio((audio) => {
      this.audioStreamer.pushPcm(Buffer.from(audio, "base64"));
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
    if (this.operatorGraceTimer) {
      // Keep the grace timer running: only a fresh start_session confirms the
      // session; otherwise a page that never starts would leak it forever.
      console.log("[Session] Operator reconnected — awaiting start_session");
    } else {
      console.log("[Session] Operator connected");
    }
    ws.send(JSON.stringify({ type: "status", state: this.state }));

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
      if (this.operatorWs !== ws) return;
      this.operatorWs = null;
      console.log("[Session] Operator disconnected");
      this.scheduleGraceStop();
    });

    ws.on("error", (err) => {
      console.error("[Session] Operator WebSocket error:", err.message);
    });
  }

  handleListenerConnection(ws: WebSocket): void {
    this.broadcaster.addListener(ws);

    const statusMsg = JSON.stringify({
      type: "status",
      state: this.state,
      language: this.getTargetLanguage(),
    });
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

  getTargetLanguage(): string {
    return this.translator.getTargetLanguage();
  }

  private handleOperatorMessage(message: OperatorMessage): void {
    switch (message.type) {
      case "start_session":
        this.applyLanguage(message.language);
        this.startSession();
        break;

      case "stop_session":
        this.stopSession();
        break;

      case "set_language":
        this.applyLanguage(message.language);
        break;
    }
  }

  private applyLanguage(language: string | undefined): void {
    if (!language) return;
    if (!OUTPUT_LANGUAGES.has(language)) {
      console.error(`[Session] Ignoring unsupported output language: ${language}`);
      return;
    }
    console.log(`[Session] Output language: ${language}`);
    this.translator.setTargetLanguage(language);
    // Listeners localize their UI to the broadcast language — tell them now.
    this.broadcaster.broadcastStatus(this.state, language);
  }

  private startSession(): void {
    if (this.operatorGraceTimer) {
      clearTimeout(this.operatorGraceTimer);
      this.operatorGraceTimer = null;
      console.log("[Session] Session resumed within grace period");
    }
    if (this.state === "active") return;

    console.log("[Session] Starting translation session");
    this.translator.connect();
  }

  private stopSession(): void {
    if (this.operatorGraceTimer) {
      clearTimeout(this.operatorGraceTimer);
      this.operatorGraceTimer = null;
    }
    if (this.state === "idle") return;

    console.log("[Session] Stopping translation session");
    this.translator.disconnect();
    this.setState("idle");
  }

  private scheduleGraceStop(): void {
    if (this.state === "idle" || this.operatorGraceTimer) return;
    console.log(
      `[Session] Keeping session alive ${OPERATOR_GRACE_MS / 1000}s awaiting operator reconnect`
    );
    this.operatorGraceTimer = setTimeout(() => {
      this.operatorGraceTimer = null;
      this.stopSession();
    }, OPERATOR_GRACE_MS);
  }

  private setState(newState: SessionState): void {
    this.state = newState;
    this.broadcaster.broadcastStatus(newState, this.getTargetLanguage());

    if (this.operatorWs && this.operatorWs.readyState === this.operatorWs.OPEN) {
      this.operatorWs.send(JSON.stringify({ type: "status", state: newState }));
    }

    console.log(`[Session] State changed to: ${newState}`);
  }
}
