import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ActionRunner } from "../browser/actions.js";
import { launchBrowser } from "../browser/driver.js";
import { loadScript } from "../parser/parser.js";
import { isNarration, type Segment } from "../parser/types.js";
import { EdgeTts } from "../tts/edge.js";
import type { TtsClip } from "../tts/engine.js";
import { mux, type NarrationPlacement } from "../video/mux.js";
import { startRecording } from "../video/recorder.js";
import { runQueue } from "./queue.js";
import { Timeline } from "./timeline.js";

export interface PipelineConfig {
  scriptPath: string;
  url: string;
  out: string;
  voice: string;
  width: number;
  height: number;
  actionTimeoutMs: number;
  keepTemp: boolean;
  headed: boolean;
}

/**
 * Narration clips are content-addressed by text+voice, so they live outside the
 * per-run directory — otherwise every run would re-synthesize from scratch and
 * the cache would never pay off (spec §2, repeatability).
 */
const CLIP_CACHE_DIR = path.join(os.tmpdir(), "tutorialgen-clips");

/**
 * Recording continues briefly after the last segment. Without it the take ends
 * on the same frame as the final action, so whatever that action caused — a
 * submitted form, a new page — is never on screen.
 */
const TAIL_MS = 2500;

/**
 * Narration is held back this much past the instant the queue paused for it.
 *
 * Purely a feel adjustment — the timeline is anchored to the take's real zero, so
 * 0 gives exact sync. A small positive value lets the picture settle before the
 * voice comes in, which reads as more natural. Raise it to delay the audio
 * further, lower it toward 0 to tighten.
 */
const NARRATION_LAG_MS = 1000;

/**
 * The two-pass run (spec §4): synthesize every narration clip up front, then
 * record one continuous take while the queue drives the browser, then mux the
 * clips onto that take at their recorded timestamps.
 */
export async function runPipeline(
  config: PipelineConfig,
  log: (message: string) => void = () => {},
): Promise<void> {
  // Parse first: an invalid script fails before any TTS or browser work.
  const segments = await loadScript(config.scriptPath);
  const narrationCount = segments.filter(isNarration).length;
  log(
    `Parsed ${segments.length} segments ` +
      `(${segments.length - narrationCount} actions, ${narrationCount} narration).`,
  );

  const runDir = path.join(os.tmpdir(), `tutorialgen-${Date.now()}`);
  const videoDir = path.join(runDir, "video");
  await mkdir(videoDir, { recursive: true });
  await mkdir(path.dirname(config.out), { recursive: true });

  let succeeded = false;
  try {
    const clips = await synthesizeAll(segments, config.voice, log);
    const { takePath, placements, trimStartMs } = await recordTake(
      config,
      videoDir,
      segments,
      clips,
      log,
    );

    await writeFile(
      path.join(runDir, "timeline.json"),
      JSON.stringify(placements, null, 2),
    );

    log(`Muxing ${placements.length} narration clip(s) onto the take...`);
    await mux(takePath, placements, config.out, trimStartMs);

    succeeded = true;
    log(`Done. Output: ${config.out}`);
  } finally {
    // Failure policy: keep the artifacts when something went wrong, so the run
    // can be debugged from the take and the timeline.
    if (succeeded && !config.keepTemp) {
      await rm(runDir, { recursive: true, force: true });
    } else {
      log(`Temp artifacts: ${runDir}`);
    }
  }
}

/** Pass 1 — every narration clip, with its duration, before recording starts. */
async function synthesizeAll(
  segments: readonly Segment[],
  voice: string,
  log: (message: string) => void,
): Promise<Map<number, TtsClip>> {
  const narration = segments.filter(isNarration);
  const clips = new Map<number, TtsClip>();
  if (narration.length === 0) return clips;

  log(`Synthesizing ${narration.length} narration clip(s)...`);
  const tts = new EdgeTts({ voice, cacheDir: CLIP_CACHE_DIR });
  try {
    // Sequential on purpose: msedge-tts is an unofficial endpoint, and a run is
    // dominated by recording time anyway.
    for (const segment of narration) {
      const clip = await tts.synthesize(segment.text);
      clips.set(segment.line, clip);
      log(`  line ${segment.line}: ${clip.durationSec.toFixed(2)}s`);
    }
  } finally {
    await tts.close();
  }
  return clips;
}

/** Pass 2 — one continuous take, resolved against the zero it turns out to have. */
async function recordTake(
  config: PipelineConfig,
  videoDir: string,
  segments: readonly Segment[],
  clips: ReadonlyMap<number, TtsClip>,
  log: (message: string) => void,
): Promise<{ takePath: string; placements: NarrationPlacement[]; trimStartMs: number }> {
  const browser = await launchBrowser({ headed: config.headed });
  try {
    const recording = await startRecording(browser, {
      width: config.width,
      height: config.height,
      videoDir,
    });
    const { page, pageCreatedAt } = recording;

    const runner = new ActionRunner(page, {
      timeoutMs: config.actionTimeoutMs,
      width: config.width,
      height: config.height,
      // The runner binds the overlay to the context in begin(), so it is
      // re-created on every document a navigation produces.
      context: recording.context,
    });

    log(`Opening ${config.url}...`);
    await page.goto(config.url, { waitUntil: "load" });
    const loadedAt = Date.now();

    // Marks are absolute wall-clock instants: video timestamp zero is not
    // knowable yet, and is applied below once the take has been measured.
    const timeline = new Timeline();

    await runner.begin();

    log("Recording...");
    const queueStartedAt = Date.now();
    await runQueue({ segments, clips, runner, timeline, log });
    const queueEndedAt = Date.now();

    // TAIL_MS leaves the page still for well over the second Playwright's
    // recorder pads the end by, which is what makes the take's measured length
    // its real elapsed time — the property finish() recovers video zero from.
    await sleep(TAIL_MS);

    const { path: takePath, durationMs: takeMs, videoZeroMs } = await recording.finish();
    const closedAt = videoZeroMs + takeMs;

    // The head of the take — a blank frame, then the page loading — is cut in
    // the mux, so `loadedAt` is the finished video's zero, not `videoZeroMs`.
    // Resolving the marks against it is the whole of keeping narration in sync.
    const trimStartMs = loadedAt - videoZeroMs;

    const placements = timeline.placements(loadedAt, NARRATION_LAG_MS);
    // Everything needed to line the numbers up against what the take shows.
    // Each is a position in the take, in seconds — subtract `page load done`
    // from any of them to get the position in the trimmed output.
    const at = (wallMs: number): string => `${((wallMs - videoZeroMs) / 1000).toFixed(3)}s`;
    log(`Take: ${(takeMs / 1000).toFixed(3)}s of video.`);
    log(`  page created      ${at(pageCreatedAt)} (before the take began)`);
    log(`  first frame       0.000s  <- video zero, ${closedAt - videoZeroMs}ms before close`);
    log(`  page load done    ${at(loadedAt)}  <- trimmed off the front`);
    log(`  queue started     ${at(queueStartedAt)}`);
    log(`  queue ended       ${at(queueEndedAt)}`);
    log(`  recorder closed   ${at(closedAt)}`);
    for (const [i, placement] of placements.entries()) {
      log(`  narration ${String(i + 1).padStart(2)}      ${at(loadedAt + placement.startMs)}`);
    }

    return { takePath, placements, trimStartMs };
  } finally {
    await browser.close();
  }
}
