import "dotenv/config";

export interface AppConfig {
  port: number;
  openaiApiKey: string;
  targetLanguage: string;
  /** Public domain for the QR/listener URL (production); LAN IP is used if unset. */
  publicHost?: string;
}

// Reads and validates the environment once, at startup. Everything else in
// the app receives plain values — no process.env access outside this file.
export function loadConfig(): AppConfig {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    console.error("OPENAI_API_KEY environment variable is required");
    process.exit(1);
  }

  return {
    port: parseInt(process.env.PORT || "3000", 10),
    openaiApiKey,
    targetLanguage: process.env.TARGET_LANGUAGE || "es",
    publicHost: process.env.PUBLIC_HOST,
  };
}
