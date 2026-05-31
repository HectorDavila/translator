import { spawn, type ChildProcess } from "child_process";
import type { ServerResponse } from "http";
import ffmpegPath from "ffmpeg-static";

const SAMPLE_RATE = 24000;
const FRAME_MS = 20;
const BYTES_PER_FRAME = (SAMPLE_RATE * 2 * FRAME_MS) / 1000; // 960 (PCM16 mono)
const MAX_QUEUE_BYTES = SAMPLE_RATE * 2 * 1.5; // ~1.5s of audio backlog cap
const MAX_CATCHUP_FRAMES = 50; // bound work if the event loop stalls
const PRIME_BYTES = 2000; // ~0.3s of recent MP3 to start new clients fast
const MAX_HTTP_BACKLOG = 256 * 1024; // drop frames for clients this far behind

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

  start(): void {
    if (this.ffmpeg) return;
    if (!ffmpegPath) {
      console.error("[Stream] ffmpeg binary not found");
      return;
    }

    this.ffmpeg = spawn(ffmpegPath, [
      "-hide_banner", "-loglevel", "error",
      "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0",
      "-c:a", "libmp3lame", "-b:a", "48k", "-flush_packets", "1",
      "-f", "mp3", "pipe:1",
    ]);

    this.ffmpeg.stdout?.on("data", (chunk: Buffer) => this.onMp3(chunk));
    this.ffmpeg.stderr?.on("data", (d: Buffer) =>
      console.error(`[Stream] ffmpeg: ${d.toString().trim()}`)
    );
    this.ffmpeg.on("error", (err) =>
      console.error(`[Stream] ffmpeg spawn error: ${err.message}`)
    );
    this.ffmpeg.on("close", () => {
      this.ffmpeg = null;
    });

    this.startedAt = Date.now();
    this.framesProduced = 0;
    this.pacer = setInterval(() => this.tick(), FRAME_MS);
    console.log("[Stream] Encoder started");
  }

  stop(): void {
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
    // Bound the backlog so latency can't grow without limit if OpenAI bursts.
    while (this.queuedBytes > MAX_QUEUE_BYTES && this.pcmQueue.length > 1) {
      const dropped = this.pcmQueue.shift()!;
      this.queuedBytes -= dropped.length;
    }
  }

  addClient(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();
    for (const chunk of this.recentMp3) res.write(chunk);
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  getClientCount(): number {
    return this.clients.size;
  }

  private tick(): void {
    if (!this.ffmpeg) return;
    const targetFrames = Math.floor((Date.now() - this.startedAt) / FRAME_MS);
    let budget = MAX_CATCHUP_FRAMES;
    while (this.framesProduced < targetFrames && budget-- > 0) {
      this.ffmpeg.stdin?.write(this.dequeueFrame());
      this.framesProduced++;
    }
    // If we fell far behind (stall), skip ahead instead of replaying old time.
    if (this.framesProduced < targetFrames) this.framesProduced = targetFrames;
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
      if (res.writableLength > MAX_HTTP_BACKLOG) continue; // drop for slow client
      res.write(chunk);
    }
  }
}
