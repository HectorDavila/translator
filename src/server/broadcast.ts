import type { WebSocket } from "ws";
import type { ListenerMessage, ConnectedListener } from "./types.js";

// Carries transcripts + status to listeners; audio goes over the /stream MP3.
export class Broadcaster {
  private listeners: Set<ConnectedListener> = new Set();

  addListener(ws: WebSocket): void {
    const listener: ConnectedListener = { ws, connectedAt: new Date() };
    this.listeners.add(listener);

    ws.on("close", () => {
      this.listeners.delete(listener);
    });

    ws.on("error", () => {
      this.listeners.delete(listener);
    });
  }

  broadcastTranscript(source: "original" | "translated", text: string): void {
    this.broadcastJson({ type: "transcript", source, text });
  }

  broadcastStatus(state: ListenerMessage["state"], language?: string): void {
    this.broadcastJson({ type: "status", state, language });
  }

  getListenerCount(): number {
    return this.listeners.size;
  }

  private broadcastJson(message: ListenerMessage): void {
    const payload = JSON.stringify(message);
    for (const listener of this.listeners) {
      if (listener.ws.readyState === listener.ws.OPEN) {
        listener.ws.send(payload);
      }
    }
  }
}
