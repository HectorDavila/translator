import "dotenv/config";

export type VadMode = "gated" | "continuous";

export interface AppConfig {
  port: number;
  openaiApiKey: string;
  targetLanguage: string;
  /** Public domain for the QR/listener URL (production); LAN IP is used if unset. */
  publicHost?: string;
  /**
   * gated: the operator's mic only streams while speech is detected (cheaper —
   * silence isn't billed). continuous: stream everything, per OpenAI's
   * recommendation; utterance cuts at VAD pauses encourage the translation
   * voice to change, so continuous keeps the voice more stable.
   */
  vadMode: VadMode;
}

// Reads and validates the environment once, at startup. Everything else in
// the app receives plain values — no process.env access outside this file.
export function loadConfig(): AppConfig {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    console.error("OPENAI_API_KEY environment variable is required");
    process.exit(1);
  }

  const vadMode = process.env.VAD_MODE === "continuous" ? "continuous" : "gated";

  return {
    port: parseInt(process.env.PORT || "3000", 10),
    openaiApiKey,
    targetLanguage: process.env.TARGET_LANGUAGE || "es",
    publicHost: process.env.PUBLIC_HOST,
    vadMode,
  };
}
