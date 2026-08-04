import { ffmpeg } from "./ffmpeg.js";
import { VIDEO_CODEC } from "./format.js";

export interface NarrationPlacement {
  clipPath: string;
  /** Onset offset from the start of the take, in milliseconds. */
  startMs: number;
}

/** Nothing reads ffmpeg's progress stream; suppressing it keeps a long encode
 * from emitting a stderr line twice a second for its whole duration. */
const QUIET = ["-nostats", "-loglevel", "error"];

/**
 * Mux narration clips onto the silent take at their recorded timestamps,
 * transcoding the VP8 webm to h264 mp4 in the same pass.
 *
 * - 0 clips  -> transcode video only, no audio track.
 * - N clips  -> `adelay` each, then `amix` with normalize=0 (valid at N=1).
 *
 * No `-shortest`: audio ends at its last clip while the video governs length.
 *
 * `trimStartMs` drops that much off the front of the take. The `-ss` goes before
 * `-i` so ffmpeg seeks the input and rebases its timestamps to zero — the take
 * is being decoded and re-encoded either way, so the seek is exact and free. It
 * applies to input 0 only; clip offsets are already relative to the new start.
 */
export async function mux(
  takePath: string,
  clips: readonly NarrationPlacement[],
  outPath: string,
  trimStartMs = 0,
): Promise<void> {
  const inputs: string[] = [...QUIET, "-y"];
  if (trimStartMs > 0) {
    inputs.push("-ss", (trimStartMs / 1000).toFixed(3));
  }
  inputs.push("-i", takePath);
  for (const clip of clips) {
    inputs.push("-i", clip.clipPath);
  }

  if (clips.length === 0) {
    await ffmpeg([...inputs, "-map", "0:v", "-an", ...VIDEO_CODEC, outPath]);
    return;
  }

  // Input 0 is the video take, so clip i is input i+1 and carries label [ai].
  const delayed = clips.map((clip, i) => {
    // Timeline.placements guarantees these are non-negative.
    const ms = Math.round(clip.startMs);
    return `[${i + 1}:a]adelay=${ms}:all=1[a${i}]`;
  });

  const mixInputs = clips.map((_, i) => `[a${i}]`).join("");
  const filter =
    `${delayed.join(";")};${mixInputs}amix=inputs=${clips.length}:normalize=0[aout]`;

  await ffmpeg([
    ...inputs,
    "-filter_complex", filter,
    "-map", "0:v",
    "-map", "[aout]",
    ...VIDEO_CODEC,
    "-c:a", "aac",
    outPath,
  ]);
}
