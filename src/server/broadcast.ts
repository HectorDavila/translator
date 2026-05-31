import type { WebSocket } from "ws";
import type { ListenerMessage, ConnectedListener } from "./types.js";

// Drop audio frames once a listener's send buffer exceeds this (~4s backlog).
const MAX_AUDIO_BUFFER_BYTES = 256 * 1024;

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

  // Audio is sent as raw binary PCM16 frames (no base64/JSON overhead).
  broadcastAudio(pcm: Buffer): void {
    for (const listener of this.listeners) {
      if (listener.ws.readyState !== listener.ws.OPEN) continue;
      if (listener.ws.bufferedAmount > MAX_AUDIO_BUFFER_BYTES) continue;
      listener.ws.send(pcm, { binary: true });
    }
  }

  broadcastTranscript(source: "original" | "translated", text: string): void {
    this.broadcastJson({ type: "transcript", source, text });
  }

  broadcastStatus(state: ListenerMessage["state"]): void {
    this.broadcastJson({ type: "status", state });
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
