import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { DEFAULT_VOICE, NARRATION_PAD_MS, type TtsClip, type TtsEngine } from "./engine.js";
import { measureDurationSec } from "../video/probe.js";
import { truncate } from "../util/text.js";

export interface EdgeTtsOptions {
  /** Edge neural voice ShortName (e.g. en-US-AriaNeural). */
  voice?: string;
  /** Directory where clips are synthesized and cached. */
  cacheDir: string;
  /** Per-clip synthesis attempts (unofficial WebSocket endpoint). */
  retries?: number;
}

/** Edge neural-voice TTS via the unofficial Read-Aloud WebSocket API. */
export class EdgeTts implements TtsEngine {
  private readonly voice: string;
  private readonly cacheDir: string;
  private readonly retries: number;
  /** Memoized cacheDir creation — once per process, not once per clip. */
  private cacheDirReady?: Promise<unknown>;

  constructor(opts: EdgeTtsOptions) {
    this.voice = opts.voice ?? DEFAULT_VOICE;
    this.cacheDir = opts.cacheDir;
    this.retries = opts.retries ?? 3;
  }

  async synthesize(text: string): Promise<TtsClip> {
    this.cacheDirReady ??= mkdir(this.cacheDir, { recursive: true });
    await this.cacheDirReady;

    // Cache by content: identical text+voice reuses the clip across runs (repeatability).
    const key = createHash("sha1").update(`${this.voice}\n${text}`).digest("hex").slice(0, 16);
    const clipPath = path.join(this.cacheDir, `${key}.mp3`);

    if (!existsSync(clipPath)) {
      await this.synthesizeToPath(text, clipPath);
    }
    const durationSec = await measureDurationSec(clipPath);
    return { clipPath, durationSec, holdMs: Math.round(durationSec * 1000) + NARRATION_PAD_MS };
  }

  private async synthesizeToPath(text: string, clipPath: string): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      const tts = new MsEdgeTTS();
      try {
        await tts.setMetadata(this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
        // toFile writes to a random name inside the dir; move it onto the deterministic cache path.
        const { audioFilePath } = await tts.toFile(this.cacheDir, text);
        try {
          await rename(audioFilePath, clipPath);
        } catch (err) {
          // A concurrent run synthesizing the same text can win the rename;
          // on Windows renaming onto an existing file throws. Their clip is ours too.
          if (!existsSync(clipPath)) throw err;
          await rm(audioFilePath, { force: true });
        }
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < this.retries) {
          await sleep(250 * 2 ** (attempt - 1));
        }
      } finally {
        tts.close();
      }
    }
    throw new Error(
      `TTS synthesis failed after ${this.retries} attempt(s) for: "${truncate(text)}"\n${String(lastErr)}`,
    );
  }

  async close(): Promise<void> {
    // Each synthesize() uses a short-lived connection closed in synthesizeToPath.
  }
}
