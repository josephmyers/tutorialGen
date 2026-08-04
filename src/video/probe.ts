import { ffprobe } from "./ffmpeg.js";

/**
 * Container-reported media length.
 *
 * For an mp3 narration clip this is a bitrate estimate that can under-read the
 * true length by a few tens of ms, so callers must not treat it as sample-exact;
 * TtsClip.holdMs carries the slack that makes it safe to schedule against.
 *
 * For the take it is dependable, and load-bearing: Playwright encodes the
 * screencast at a constant 25fps, repeating the last frame through stillness, so
 * the duration is a whole number of frames and equals the wall-clock span of the
 * recording. That is what lets the pipeline recover video timestamp zero.
 */
export async function measureDurationSec(mediaPath: string): Promise<number> {
  const stdout = await ffprobe([
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "json",
    mediaPath,
  ]);

  const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
  const durationSec = Number(parsed.format?.duration);

  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`ffprobe could not measure duration for ${mediaPath}`);
  }
  return durationSec;
}
