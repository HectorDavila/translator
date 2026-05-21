import type { WebSocket } from "ws";

export type SessionState = "idle" | "active" | "error";

export interface OperatorMessage {
  type: "audio" | "start_session" | "stop_session";
  data?: string;
}

export interface ListenerMessage {
  type: "audio" | "transcript" | "status";
  data?: string;
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
