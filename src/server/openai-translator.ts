import WebSocket from "ws";
import type { OpenAIEvent } from "./types.js";

const OPENAI_REALTIME_URL =
  "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate";

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 1000;

export class OpenAITranslator {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private targetLanguage: string;
  private reconnectAttempts = 0;
  private shouldReconnect = false;

  private onAudioCallback: ((base64Pcm: string) => void) | null = null;
  private onOriginalTranscriptCallback: ((text: string) => void) | null = null;
  private onTranslatedTranscriptCallback: ((text: string) => void) | null =
    null;
  private onConnectedCallback: (() => void) | null = null;
  private onDisconnectedCallback: ((reason: string) => void) | null = null;

  constructor(apiKey: string, targetLanguage: string) {
    this.apiKey = apiKey;
    this.targetLanguage = targetLanguage;
  }

  connect(): void {
    this.shouldReconnect = true;
    this.createConnection();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.reconnectAttempts = 0;
    if (this.ws) {
      this.ws.close(1000, "Session ended");
      this.ws = null;
    }
  }

  sendAudio(base64Pcm: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(
      JSON.stringify({
        type: "session.input_audio_buffer.append",
        audio: base64Pcm,
      })
    );
  }

  onTranslatedAudio(callback: (base64Pcm: string) => void): void {
    this.onAudioCallback = callback;
  }

  onOriginalTranscript(callback: (text: string) => void): void {
    this.onOriginalTranscriptCallback = callback;
  }

  onTranslatedTranscript(callback: (text: string) => void): void {
    this.onTranslatedTranscriptCallback = callback;
  }

  onConnected(callback: () => void): void {
    this.onConnectedCallback = callback;
  }

  onDisconnected(callback: (reason: string) => void): void {
    this.onDisconnectedCallback = callback;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private createConnection(): void {
    this.ws = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    this.ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.configureSession();
      this.onConnectedCallback?.();
      console.log("[OpenAI] Connected to Realtime Translation API");
    });

    this.ws.on("message", (data) => {
      this.handleMessage(data.toString());
    });

    this.ws.on("close", (code, reason) => {
      const reasonStr = reason.toString() || `code ${code}`;
      console.log(`[OpenAI] Disconnected: ${reasonStr}`);
      this.onDisconnectedCallback?.(reasonStr);
      this.attemptReconnect();
    });

    this.ws.on("error", (error) => {
      console.error("[OpenAI] WebSocket error:", error.message);
    });
  }

  private configureSession(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          audio: {
            output: {
              language: this.targetLanguage,
            },
          },
        },
      })
    );
    // Note: gpt-realtime-translate does not support a fixed `voice` parameter
    // (returns "unknown_parameter" error). Voice consistency requires a different approach.
    console.log(`[OpenAI] Session configured: language=${this.targetLanguage}`);
  }

  private handleMessage(raw: string): void {
    const event: OpenAIEvent = JSON.parse(raw);

    switch (event.type) {
      case "session.output_audio.delta":
        if (event.delta) {
          this.onAudioCallback?.(event.delta as string);
        }
        break;

      case "session.output_transcript.delta":
        if (event.delta) {
          this.onTranslatedTranscriptCallback?.(event.delta as string);
        }
        break;

      case "session.input_transcript.delta":
        if (event.delta) {
          this.onOriginalTranscriptCallback?.(event.delta as string);
        }
        break;

      case "session.created":
      case "session.updated":
        console.log(`[OpenAI] ${event.type}:`, JSON.stringify(event, null, 2));
        break;

      case "error":
        console.error("[OpenAI] API error:", JSON.stringify(event));
        break;

      default:
        if (!event.type.includes("delta")) {
          console.log(`[OpenAI] event:`, event.type);
        }
        break;
    }
  }

  private attemptReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error("[OpenAI] Max reconnection attempts reached");
      this.onDisconnectedCallback?.("Max reconnection attempts reached");
      return;
    }

    this.reconnectAttempts++;
    const delay =
      BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1);
    console.log(
      `[OpenAI] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`
    );

    setTimeout(() => {
      if (this.shouldReconnect) {
        this.createConnection();
      }
    }, delay);
  }
}
