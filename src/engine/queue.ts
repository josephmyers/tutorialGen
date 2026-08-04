import { setTimeout as sleep } from "node:timers/promises";
import type { ActionRunner } from "../browser/actions.js";
import type { Segment } from "../parser/types.js";
import type { TtsClip } from "../tts/engine.js";
import type { Timeline } from "./timeline.js";

export interface QueueOptions {
  segments: readonly Segment[];
  /** Pass 1 output, keyed by the narration segment's script line. */
  clips: ReadonlyMap<number, TtsClip>;
  runner: ActionRunner;
  timeline: Timeline;
  log?: (message: string) => void;
}

/**
 * Pass 2: run every segment sequentially, each blocking until it is genuinely
 * complete (spec §4). Nothing overlaps, so there is no synchronization problem
 * to solve — a narration segment holds the page still for exactly its clip's
 * length, and the same duration drives both that hold and the later placement.
 */
export async function runQueue(opts: QueueOptions): Promise<void> {
  const { segments, clips, runner, timeline, log } = opts;

  for (const segment of segments) {
    if (segment.kind === "action") {
      log?.(`  line ${segment.line}: ${segment.command} "${segment.target}"`);
      await runner.run(segment);
      continue;
    }

    const clip = clips.get(segment.line);
    if (!clip) {
      // Pass 1 synthesizes one clip per narration segment, so this is a bug.
      throw new Error(`No narration clip was synthesized for line ${segment.line}.`);
    }

    timeline.mark(clip.clipPath);
    log?.(`  line ${segment.line}: narration (${clip.holdMs}ms hold)`);
    await sleep(clip.holdMs);
  }
}
