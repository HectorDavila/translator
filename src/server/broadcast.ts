import type { WebSocket } from "ws";
import type { ListenerMessage, ConnectedListener } from "./types.js";

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

  broadcastAudio(base64Pcm: string): void {
    const message: ListenerMessage = { type: "audio", data: base64Pcm };
    this.broadcast(message);
  }

  broadcastTranscript(source: "original" | "translated", text: string): void {
    const message: ListenerMessage = { type: "transcript", source, text };
    this.broadcast(message);
  }

  broadcastStatus(state: ListenerMessage["state"]): void {
    const message: ListenerMessage = { type: "status", state };
    this.broadcast(message);
  }

  getListenerCount(): number {
    return this.listeners.size;
  }

  private broadcast(message: ListenerMessage): void {
    const payload = JSON.stringify(message);
    for (const listener of this.listeners) {
      if (listener.ws.readyState === listener.ws.OPEN) {
        listener.ws.send(payload);
      }
    }
  }
}
