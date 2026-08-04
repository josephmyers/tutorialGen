import type { NarrationPlacement } from "../video/mux.js";

/**
 * Where each narration clip belongs on the finished video (spec §5).
 *
 * Marks are absolute wall-clock instants, not offsets. They have to be: the take
 * begins at the first frame the browser paints, and nothing on this side can see
 * that happen or predict when it will. Video timestamp zero is only known once
 * the take is finished and measured, so the subtraction is deferred to
 * `placements` rather than done as each mark is taken.
 *
 * Offsets come out in milliseconds, which is all the mux needs — clips are placed
 * with `adelay`, so this never has to know the frame rate.
 */
export class Timeline {
  private readonly marks: { clipPath: string; atMs: number }[] = [];

  /** Record that `clipPath` should begin now. */
  mark(clipPath: string): void {
    this.marks.push({ clipPath, atMs: Date.now() });
  }

  /**
   * Resolve every mark against the take's zero, holding each clip back by
   * `lagMs` (see NARRATION_LAG_MS — a feel adjustment, not a correction).
   *
   * A negative offset means a clip was marked before the video began, which
   * cannot happen in a correct run — the queue does not start until the page is
   * up, and the page cannot be up before it has painted. It means the measured
   * zero is wrong, so it throws rather than quietly clamping a clip to 0 and
   * shipping a video that is out of sync by an unknown amount.
   */
  placements(videoZeroMs: number, lagMs = 0): NarrationPlacement[] {
    return this.marks.map(({ clipPath, atMs }) => {
      const startMs = atMs - videoZeroMs + lagMs;
      if (startMs < 0) {
        throw new Error(
          `Narration clip ${clipPath} lands ${-startMs}ms before the take starts. ` +
            `The measured video zero (${videoZeroMs}) is wrong.`,
        );
      }
      return { clipPath, startMs };
    });
  }
}
