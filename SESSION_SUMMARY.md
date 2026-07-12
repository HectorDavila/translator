# Church Translator — Session Summary

## Project Overview

Real-time English-to-Spanish translation app for a bilingual church (Access GT). Uses OpenAI's Realtime Translation API (`gpt-realtime-translate`) to translate sermons. Church members open a link on their phones and hear the translation + see subtitles.

## Architecture

```
Operator mic → WS (binary PCM16) → Backend (Node.js) → OpenAI Realtime API
                                                          ↓ translated PCM16
                                       ffmpeg (64kbps MP3) ──→ GET /stream ──→ <audio> on phones (plays locked)
                                       transcripts + status ──────→ WS ──────→ phones (subtitles)
```

## Current State (end of 2026-05-16 session)

### What works:
- **Backend**: connects to OpenAI, broadcasts audio + transcripts to listeners.
- **Operator page**: captures mic via AudioWorklet, PCM16 24kHz, with VAD to save API cost.
- **Listener on iPhone**: audio playback works via `AudioBufferSourceNode` chain at 24kHz; subtitles render in real time. Connect/Disconnect toggle button.
- **Wake Lock** (when HTTPS): NoSleep.js prevents screen lock during active translation.
- **QR page** (`/qr.html`): server detects LAN IP via `/api/listener-url` and generates a scannable QR pointing at `/listener.html`.
- **Branded UI** matching access.gt: dark theme `#0F0F0F` + orange accent `#ff8044` + Poppins font (300, 400, 500, 600, 700, 900).

### Open issues:
1. **Wake Lock fails on `http://192.168.0.6:3000` from iOS 17+**
   - Wake Lock API requires `isSecureContext` (HTTPS or localhost).
   - NoSleep.js video fallback is unreliable on iOS 17+ due to autoplay policy changes.
   - **No JS fix possible** — needs HTTPS via ngrok (testing) or Fly.io (production).
2. **Voice changes between utterances** (TTS voice from OpenAI varies)
   - Confirmed model limitation. Error from OpenAI: `Unknown parameter: 'session.audio.output.voice'`.
   - `gpt-realtime-translate` only accepts `language` under `audio.output` — no voice control.
   - Decision: accept the limitation for now. Code keeps only `language` in the session config.
   - If voice consistency becomes critical later: switch to hybrid (translate model for transcript + separate TTS) or to `gpt-realtime-2` voice agent with translation instructions.

## Changes made in session 2026-07-12 (fluidity / lock-screen / recovery)

Focus: no dropped words, faster delivery, survive screen lock on both roles.

### Server
- **`audio-stream.ts` — stop dropping translated audio**: the PCM queue cap was 1.5s, but OpenAI delivers each translated utterance as a burst (faster than realtime), so anything longer than 1.5s lost its start (main cause of "entrecortado"). Cap is now a 60s safety net, and when backlog exceeds 2.5s the encoder runs at 2x realtime until it drains below 0.75s — nothing dropped; clients absorb the burst and trim it via playbackRate.
- **Encoder self-healing**: ffmpeg stdin `error` handler (EPIPE no longer can crash the server) + auto-respawn 1s after unexpected exit, keeping connected clients (MP3 self-syncs).
- **Low-latency ffmpeg flags**: `-probesize 32 -analyzeduration 0 -fflags nobuffer` cut encoder time-to-first-byte from ~2.1s to ~0.1s (measured); `-reservoir 0` makes every MP3 frame self-contained so mid-stream joins decode cleanly; `-write_xing 0 -id3v2_version 0`; bitrate 48k → 64k to offset the reservoir loss.
- **/stream hardening**: `X-Accel-Buffering: no` (reverse proxies), `setNoDelay`, `error` handler per client; clients >256KB behind get destroyed so they auto-reconnect at the live edge instead of decoding a corrupt gap.
- **`openai-translator.ts`**: reconnects forever while the session is live (was: gave up after 5 attempts ≈ 31s), backoff capped at 30s; guard against duplicate sockets.
- **`session-manager.ts` — operator grace period**: operator socket drop no longer kills the session instantly; it survives 60s awaiting reconnect. Only `start_session` confirms resumption (a fresh page that never starts lets it stop). Server sends current status to the operator on connect.

### Operator client
- **VAD moved into the AudioWorklet** (audio thread): the old `requestAnimationFrame` VAD froze when the screen locked / tab backgrounded, silently stopping the broadcast. Now RMS threshold + 1.5s hangover + 300ms preroll all run on the audio thread; main thread only forwards chunks and paints the meter (no more analyser/rAF).
- **NoSleep on operator page** — device stays awake during the session; wake lock re-acquired on `visibilitychange`.
- **Auto-resume**: if the operator WS drops and reconnects while capturing, it re-sends `start_session` (pairs with the server grace period).

### Listener client
- `ended` event reloads the stream (server restart no longer strands players).
- On return to foreground: resumes a paused player (call/Siri interruptions), revives a dead transcript WS, and keeps the stalled-stream nudge.
- Tiered latency guard: 1.08x past 1.5s behind, 1.2x past 4s, jump to live edge past 8s.
- If autoplay is blocked on resume, status + button now ask for a tap ("Toca Conectar…").
- WS reconnect timer is tracked/cleared (no duplicate sockets, no reconnect after manual disconnect).

### All pages
- Google Fonts stylesheet loads async (`media="print"` swap) — first paint no longer blocks on fonts over slow church Wi-Fi.

### Verified
- Streamer harness: 10s burst → fully delivered at 2x, nothing dropped; ffmpeg SIGKILL → auto-restart, same client keeps receiving.
- Integration: operator WS terminate → session survives → reconnect + `start_session` resumes → clean stop (real OpenAI session).
- Mid-stream MP3 capture decodes cleanly; `/stream` headers + 64kbps rate confirmed.

## Changes made in this session (2026-05-16)

### Audio playback (`src/client/js/listener.js`)
- Fixed schedule drift: `scheduleChunk` now bounds `nextStartTime` with both `TARGET_LEAD_S = 0.25` and `MAX_LEAD_S = 1.5`. Previously only handled "fell behind", queue could grow unbounded.
- The "repeats last word + cuts" issue was resolved by this bound.

### Wake Lock — keep screen on (`src/client/js/listener.js`, `src/client/js/nosleep.min.js`, `listener.html`)
- Downloaded NoSleep.js v0.12.0 (MIT, 16KB) as `nosleep.min.js`. Loaded via `<script>` tag before the listener module.
- `enableNoSleep()` / `disableNoSleep()` wrap the library. Wake Lock API where available, video fallback elsewhere.
- `visibilitychange` listener re-acquires lock when page returns to foreground.
- `pagehide` listener releases lock on page unload.
- **Note**: visible status badge was removed at user request — now silent (logs to console only).

### UI cleanup (`src/client/listener.html`, `src/client/operator.html`, `src/client/js/listener.js`)
- Removed Test Audio button + its 37-line handler.
- Removed "Original (English)" transcript card.
- Removed volume slider control. Gain fixed at `1.0`.
- Removed dead `<audio id="webrtc-audio">` element from abandoned WebRTC approach.
- Translation card now expands to fill viewport (`50vh` min, `65vh` max, 1.6rem font).
- Removed subtitles ("Predicación traducida al español", "Controla la sesión de traducción").
- Initial status text removed; `.status:empty { display: none }` hides the pill until needed.

### Rebrand to match access.gt (`src/client/css/styles.css`, all HTML, `manifest.json`)
- New palette via CSS variables (`:root`):
  - `--bg: #0F0F0F`, `--surface: #1a1a1a`, `--surface-2: #232323`
  - `--accent: #ff8044`, `--accent-hover: #ff6a22`, `--accent-dark: #ae3e09`
  - `--text: #FFFFFF`, `--text-muted: #8F8F8F`
  - `--danger: #df3336`
- Poppins via Google Fonts in all 4 HTML pages (`index`, `listener`, `operator`, `qr`).
- Buttons: pills (`border-radius: 999px`), uppercase, letter-spacing.
- Headings: Poppins 900 UPPERCASE with negative tracking.
- Subtitles: Poppins 300 UPPERCASE with wide tracking.
- Status pills with semantic colored borders.
- `manifest.json` theme_color → `#0F0F0F`.

### QR code page (`src/client/qr.html`, `src/client/js/qr.js`, `src/client/js/qrcode.min.js`)
- Downloaded `qrcode-generator` v1.4.4 (MIT, 20KB) — pure-JS QR generation.
- New server endpoint `GET /api/listener-url`:
  - Priority: `PUBLIC_HOST` env var → `os.networkInterfaces()` LAN IP → request host fallback.
  - Returns `{ url, source }`.
- `qr.html` shows large QR in white frame with orange border, URL pill below, conditional warning if stuck on localhost.
- Title: "¿Necesitas traducción?" — Subtitle: "Escanea el siguiente código QR".
- Link added to `index.html` role cards.

### Connect/Disconnect toggle (`src/client/js/listener.js`)
- Button now toggles: orange "Conectar" → red "Desconectar" → back.
- `disconnect()` nulls all WS event handlers before `close(1000)` to prevent the auto-reconnect path and stop the spurious "Error de conexión" status from firing.
- `userDisconnected` flag distinguishes voluntary disconnect from network drops; `onclose` no longer auto-reconnects if user disconnected.
- AudioContext stays alive between reconnects (no need to re-prompt user gesture on iOS).

### Voice config attempt (reverted)
- Added `voice` param to OpenAI `session.update` → OpenAI returned `invalid_request_error: unknown_parameter`.
- Removed the param and all plumbing (`OPENAI_VOICE` env, constructor params).
- Added logging for `session.created`, `session.updated`, errors, and non-delta events in `openai-translator.ts` for future debugging — kept that.

### Audio fluidity tuning (`src/client/js/listener.js`)
- `TARGET_LEAD_S` 0.12 → **0.25**
- `MAX_LEAD_S` 0.6 → **1.5**
- Tradeoff: ~150ms more latency, much less likely to hit the resync-and-drop path.
- (Tried edge fades on each chunk but reverted — would create 50Hz amplitude wobble.)

## Tech Stack

- **Backend**: Node.js + TypeScript + Express + `ws`
- **Frontend**: Vanilla JS modules, static-served by Express
- **API**: OpenAI Realtime Translation (`wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate`)
- **Dev**: `tsx watch`
- **Deploy target**: Fly.io (Dockerfile exists, not deployed yet)

## Key Files

| File | Purpose |
|------|---------|
| `src/server/index.ts` | Express + WS server, routes, `/api/listener-url`, LAN IP detection |
| `src/server/openai-translator.ts` | OpenAI WS connection, session.update (language only), event handlers + logging |
| `src/server/session-manager.ts` | Session state coordination |
| `src/server/broadcast.ts` | Broadcasts audio + transcripts to listeners |
| `src/client/js/operator.js` | Mic capture, PCM16 encoding, VAD |
| `src/client/js/audio-worklet.js` | Worklet that resamples to 24kHz PCM16 |
| `src/client/js/listener.js` | Receives audio, schedules via `AudioBufferSourceNode`, Wake Lock, toggle connect |
| `src/client/js/nosleep.min.js` | Third-party (MIT) — Wake Lock + video fallback |
| `src/client/js/qr.js` + `qrcode.min.js` | QR page logic + library |
| `src/client/css/styles.css` | All styling with CSS variables |
| `src/client/{index,listener,operator,qr}.html` | All pages |

## OpenAI API Protocol

### Session config (only `language` is accepted):
```json
{ "type": "session.update", "session": { "audio": { "output": { "language": "es" } } } }
```

### Sending audio:
```json
{ "type": "session.input_audio_buffer.append", "audio": "<base64 PCM16 24kHz>" }
```

### Receiving:
- `session.output_audio.delta` → `event.delta` = base64 PCM16 translated audio
- `session.output_transcript.delta` → translated text
- `session.input_transcript.delta` → original text

## WebSocket Protocol (Backend ↔ Clients)

Same as before — see git history if needed.

## Running Locally

```bash
cd /Users/hdavila/Projects/church-translator
cp .env.example .env  # Add OPENAI_API_KEY
npm run dev           # http://localhost:3000
```

Endpoints:
- Home: `http://localhost:3000/`
- Operator: `http://localhost:3000/operator.html` (use IP from phone)
- Listener: `http://192.168.0.6:3000/listener.html`
- QR: `http://192.168.0.6:3000/qr.html`

### Env vars (`.env`)
- `OPENAI_API_KEY` (required)
- `PORT` (default 3000)
- `TARGET_LANGUAGE` (default `es`)
- `PUBLIC_HOST` (optional, for QR — set to public domain in production)

## Known Cleanup Still Pending

1. `werift` + `@discordjs/opus` still in `package.json` — unused, can be removed.
2. `src/server/webrtc-broadcaster.ts` + `src/server/opus.d.ts` — dead code from abandoned WebRTC approach.

## Next Steps (priority order for next session)

1. **Set up HTTPS** — blocking Wake Lock from working on iPhones in the field.
   - **Easiest**: `ngrok http 3000` → use the `https://...ngrok-free.app` URL on the iPhone. Verify Wake Lock works (screen stays on).
   - **Production**: deploy to Fly.io. Dockerfile already exists. Need to set `OPENAI_API_KEY` + `PUBLIC_HOST` in fly secrets.
2. **Verify Wake Lock actually works once on HTTPS** — that confirms the diagnosis. If screen still locks, investigate further.
3. **Cleanup** — uninstall `werift` and `@discordjs/opus`; delete `webrtc-broadcaster.ts` and `opus.d.ts`.
4. **Test audio fluidity** with the new `TARGET_LEAD_S=0.25 / MAX_LEAD_S=1.5` over a real 30+ min sermon.
5. **Production hardening**: error UX in Spanish, reconnection states, optional church logo in QR center.

## Decisions parked / not pursued

- **Fix inconsistent voice** — user accepted the limitation for now. Future options: hybrid TTS (OpenAI or ElevenLabs) or switch to `gpt-realtime-2`.
- **AudioWorklet rewrite of listener** — would give truly continuous output (no buffer boundaries). Reserved for if jitter buffer fix isn't enough.
- **Operator VAD tuning** — reserved for if cuts persist after testing the new buffer values.
