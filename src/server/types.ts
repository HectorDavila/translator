import type { WebSocket } from "ws";

export type SessionState = "idle" | "active" | "error";

// Operator audio is sent as binary frames; only control messages are JSON.
export interface OperatorMessage {
  type: "start_session" | "stop_session" | "set_language";
  /** Output language for the broadcast (start_session / set_language). */
  language?: string;
}

// Listener audio is sent as binary frames; only transcript/status are JSON.
export interface ListenerMessage {
  type: "transcript" | "status";
  source?: "original" | "translated";
  text?: string;
  state?: SessionState;
}

export interface OpenAIEvent {
  type: string;
  delta?: string;
  [key: string]: unknown;
}

export interface ConnectedListener {
  ws: WebSocket;
  connectedAt: Date;
}
