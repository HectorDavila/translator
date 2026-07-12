import { spawn, type ChildProcess } from "child_process";
import type { ServerResponse } from "http";
import ffmpegPath from "ffmpeg-static";

const SAMPLE_RATE = 24000;
const FRAME_MS = 20;
const BYTES_PER_FRAME = (SAMPLE_RATE * 2 * FRAME_MS) / 1000; // 960 (PCM16 mono)
const MP3_BITRATE_KBPS = 64;
// OpenAI delivers each translated utterance as a burst (faster than realtime),
// so the queue legitimately holds several seconds mid-utterance. The cap is a
// safety net only — dropping from it cuts words, so it must never be hit in
// normal operation.
const MAX_QUEUE_BYTES = SAMPLE_RATE * 2 * 60;
// When the backlog crosses HIGH, encode at 2x realtime until it drains below
// LOW. Nothing is dropped: clients buffer the burst and their latency guard
// trims it with a slightly faster playbackRate.
const CATCHUP_HIGH_BYTES = SAMPLE_RATE * 2 * 2.5;
const CATCHUP_LOW_BYTES = SAMPLE_RATE * 2 * 0.75;
const MAX_CATCHUP_FRAMES = 50; // bound work if the event loop stalls
// Recent MP3 replayed instantly to each new client. Browsers won't start a
// live <audio> stream until they've buffered ~3s; priming that much from
// history makes playback start immediately instead of sitting silent while
// realtime data trickles in. It does not add latency: the client would end up
// ~3s behind live either way, and the latency guard then trims toward live.
const PRIME_BYTES = Math.round(((MP3_BITRATE_KBPS * 1000) / 8) * 3.5);
const MAX_HTTP_BACKLOG = 256 * 1024; // kick clients this far behind; they reconnect at the live edge
const RESTART_DELAY_MS = 1000;

// Continuously encodes the translated audio to a single MP3 stream and fans it
// out to HTTP listeners. One ffmpeg process for everyone; the pacer keeps a
// gapless realtime timeline (silence when no one is speaking) so the stream
// never stalls — which is what lets it play on a locked iOS/Android screen.
export class AudioStreamer {
  private ffmpeg: ChildProcess | null = null;
  private clients = new Set<ServerResponse>();
  private pcmQueue: Buffer[] = [];
  private queuedBytes = 0;
  private pacer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private framesProduced = 0;
  private recentMp3: Buffer[] = [];
  private recentBytes = 0;
  private catchingUp = false;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;

  start(): void {
    this.stopping = false;
    this.spawnEncoder();
    if (!this.pacer) this.pacer = setInterval(() => this.tick(), FRAME_MS);
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.pacer) clearInterval(this.pacer);
    this.pacer = null;
    if (this.ffmpeg) {
      this.ffmpeg.stdin?.end();
      this.ffmpeg.kill("SIGTERM");
      this.ffmpeg = null;
    }
    this.pcmQueue = [];
    this.queuedBytes = 0;
    this.recentMp3 = [];
    this.recentBytes = 0;
    for (const res of this.clients) res.end();
    this.clients.clear();
  }

  // Translated PCM16 from OpenAI; queued for the pacer to emit at realtime rate.
  pushPcm(pcm: Buffer): void {
    this.pcmQueue.push(pcm);
    this.queuedBytes += pcm.length;
    while (this.queuedBytes > MAX_QUEUE_BYTES && this.pcmQueue.length > 1) {
      const dropped = this.pcmQueue.shift()!;
      this.queuedBytes -= dropped.length;
      console.error("[Stream] PCM queue overflow — dropping audio (should not happen)");
    }
  }

  addClient(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // keep reverse proxies from buffering the live stream
    });
    res.flushHeaders?.();
    res.socket?.setNoDelay(true);
    for (const chunk of this.recentMp3) res.write(chunk);
    this.clients.add(res);
    const drop = () => this.clients.delete(res);
    res.on("close", drop);
    res.on("error", drop);
  }

  getClientCount(): number {
    return this.clients.size;
  }

  private spawnEncoder(): void {
    if (this.ffmpeg) return;
    if (!ffmpegPath) {
      console.error("[Stream] ffmpeg binary not found");
      return;
    }

    this.ffmpeg = spawn(ffmpegPath, [
      "-hide_banner", "-loglevel", "error",
      // Skip input probing/buffering: cuts time-to-first-byte from ~2.1s to
      // ~0.1s (measured), which is the recovery gap after an encoder restart.
      "-probesize", "32", "-analyzeduration", "0", "-fflags", "nobuffer",
      "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0",
      "-c:a", "libmp3lame", "-b:a", `${MP3_BITRATE_KBPS}k`,
      // No bit reservoir: every frame is self-contained, so clients joining
      // mid-stream (or resyncing after a drop) decode cleanly.
      "-reservoir", "0",
      // No Xing/ID3 headers — meaningless for an endless live stream.
      "-write_xing", "0", "-id3v2_version", "0",
      "-flush_packets", "1",
      "-f", "mp3", "pipe:1",
    ]);

    // EPIPE on stdin (encoder died mid-write) must not crash the server.
    this.ffmpeg.stdin?.on("error", (err) =>
      console.error(`[Stream] ffmpeg stdin: ${err.message}`)
    );
    this.ffmpeg.stdout?.on("data", (chunk: Buffer) => this.onMp3(chunk));
    this.ffmpeg.stderr?.on("data", (d: Buffer) =>
      console.error(`[Stream] ffmpeg: ${d.toString().trim()}`)
    );
    this.ffmpeg.on("error", (err) => {
      console.error(`[Stream] ffmpeg spawn error: ${err.message}`);
      if (!this.ffmpeg?.pid) {
        this.ffmpeg = null;
        this.scheduleRestart();
      }
    });
    this.ffmpeg.on("close", (code) => {
      this.ffmpeg = null;
      if (this.stopping) return;
      console.error(`[Stream] ffmpeg exited (code ${code}) — restarting encoder`);
      this.scheduleRestart();
    });

    this.startedAt = Date.now();
    this.framesProduced = 0;
    console.log("[Stream] Encoder started");
  }

  // Keep connected clients: MP3 is self-syncing, so once the new encoder is
  // producing, the same responses simply carry on.
  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnEncoder();
    }, RESTART_DELAY_MS);
  }

  private tick(): void {
    if (!this.ffmpeg || !this.ffmpeg.stdin?.writable) return;
    const targetFrames = Math.floor((Date.now() - this.startedAt) / FRAME_MS);
    let budget = MAX_CATCHUP_FRAMES;
    while (this.framesProduced < targetFrames && budget-- > 0) {
      this.ffmpeg.stdin.write(this.dequeueFrame());
      this.framesProduced++;
    }
    // If we fell far behind (stall), skip ahead instead of replaying old time.
    if (this.framesProduced < targetFrames) this.framesProduced = targetFrames;

    if (this.catchingUp) {
      if (this.queuedBytes <= CATCHUP_LOW_BYTES) this.catchingUp = false;
    } else if (this.queuedBytes >= CATCHUP_HIGH_BYTES) {
      this.catchingUp = true;
      console.log(
        `[Stream] Backlog ${(this.queuedBytes / (SAMPLE_RATE * 2)).toFixed(1)}s — encoding at 2x to catch up`
      );
    }
    // One extra (uncounted) frame per tick = 2x realtime while backlogged.
    if (this.catchingUp && this.queuedBytes >= BYTES_PER_FRAME) {
      this.ffmpeg.stdin.write(this.dequeueFrame());
    }
  }

  // Assemble exactly one frame of PCM, padding with silence when the queue runs dry.
  private dequeueFrame(): Buffer {
    const out = Buffer.alloc(BYTES_PER_FRAME); // zero = silence
    let filled = 0;
    while (filled < BYTES_PER_FRAME && this.pcmQueue.length > 0) {
      const head = this.pcmQueue[0];
      const need = BYTES_PER_FRAME - filled;
      if (head.length <= need) {
        head.copy(out, filled);
        filled += head.length;
        this.queuedBytes -= head.length;
        this.pcmQueue.shift();
      } else {
        head.copy(out, filled, 0, need);
        this.pcmQueue[0] = head.subarray(need);
        this.queuedBytes -= need;
        filled += need;
      }
    }
    return out;
  }

  private onMp3(chunk: Buffer): void {
    this.recentMp3.push(chunk);
    this.recentBytes += chunk.length;
    while (this.recentBytes > PRIME_BYTES && this.recentMp3.length > 1) {
      this.recentBytes -= this.recentMp3.shift()!.length;
    }
    for (const res of this.clients) {
      if (res.writableLength > MAX_HTTP_BACKLOG) {
        // Hopelessly behind (~30s+): kill the socket so the client's stall
        // handler reconnects at the live edge instead of decoding a gap.
        res.destroy();
        continue;
      }
      res.write(chunk);
    }
  }
}
