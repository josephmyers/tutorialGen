/**
 * The output format's encoding constraints, in one place. A leaf module on
 * purpose: the CLI has to honour the dimension rule while validating arguments,
 * and must not pull in the ffmpeg stack to do it.
 */

export const VIDEO_CODEC = [
  "-c:v", "libx264",
  "-preset", "veryfast",
  "-crf", "20",
  "-pix_fmt", "yuv420p",
];

/**
 * yuv420p subsamples chroma 2x2, so it cannot encode an odd width or height.
 * Rounds up to the next even number; callers compare against the input to know
 * whether to warn.
 */
export function evenDimension(n: number): number {
  return n % 2 === 0 ? n : n + 1;
}
