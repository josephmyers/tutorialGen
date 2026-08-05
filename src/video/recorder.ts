import type { Browser, BrowserContext, Page } from "playwright";
import { measureDurationSec } from "./probe.js";

export interface RecorderOptions {
  width: number;
  height: number;
  /** Directory Playwright writes the .webm into (finalized on context close). */
  videoDir: string;
}

export interface FinishedTake {
  /** Path to the saved .webm. */
  path: string;
  /** Measured take length, in milliseconds. */
  durationMs: number;
  /**
   * Wall-clock instant of the take's first frame, i.e. what video timestamp
   * zero corresponds to. Every offset the pipeline computes is relative to this.
   */
  videoZeroMs: number;
}

export interface Recording {
  context: BrowserContext;
  page: Page;
  /** Wall-clock instant the recorded page was created — an upper bound on video zero. */
  pageCreatedAt: number;
  /** Close the context (finalizing the video) and measure what was recorded. */
  finish(): Promise<FinishedTake>;
}

/**
 * Start one continuous recording via Playwright's built-in recordVideo. The
 * session is captured continuously — screencast, encoding, and idle-frame
 * padding are handled internally, so a narration hold is just `await sleep`
 * while the page sits static and the video keeps rolling.
 *
 * The take begins at the first frame the browser paints, which nothing here can
 * observe or predict; `finish()` recovers it after the fact from the finished
 * file's duration, since that is a fact about this recorder's encoder rather
 * than about whatever is being recorded.
 */
export async function startRecording(browser: Browser, opts: RecorderOptions): Promise<Recording> {
  const size = { width: opts.width, height: opts.height };
  const context = await browser.newContext({
    viewport: size,
    deviceScaleFactor: 1,
    recordVideo: { dir: opts.videoDir, size },
  });
  const page = await context.newPage();
  const pageCreatedAt = Date.now();
  // Checked up front: a missing handle is a misconfiguration in this function,
  // so it should not surface only after a full take has been recorded.
  const video = page.video();
  if (!video) {
    await context.close();
    throw new Error("recordVideo produced no video handle (recording was not enabled).");
  }

  return {
    context,
    page,
    pageCreatedAt,
    async finish(): Promise<FinishedTake> {
      // The recorder keeps capturing until the close resolves, and the .webm is
      // only flushed to disk at that point — so this is the instant recording
      // actually stopped. Stamping it any earlier understates the video.
      await context.close();
      const recordingStoppedAt = Date.now();

      const videoPath = await video.path();
      const videoDurationMs = (await measureDurationSec(videoPath)) * 1000;

      // When the first recorded frame was painted, recovered after the fact.
      // Nothing on this side can observe that instant directly, but we do know
      // when recording stopped — so the start is the stop minus however long the
      // video turned out to be.
      //
      // This holds because Playwright encodes at a constant 25fps, repeating the
      // last frame through stillness, and because the caller leaves the page
      // still for well over the 1s its recorder pads the end by: with no frame
      // arriving in that last second, the padding is the real elapsed time
      // rather than the floor, and the file ends where the recording did.
      const firstFrameAt = recordingStoppedAt - videoDurationMs;

      // The page is created blank and paints nothing until it is navigated, so
      // recording opens on a stretch of dead time this long. It cannot be
      // negative — the recorder cannot have filmed a page that did not exist
      // yet. If it is, either the duration or the stop instant is not what this
      // assumes, and every offset derived from the first frame is wrong by that
      // much, so say so rather than hand back numbers that silently desync the
      // narration.
      if (Math.abs(firstFrameAt - pageCreatedAt) > 500) {
        console.log(`There is a discrepancy between when `)
        console.log(`First frame at: ${firstFrameAt}`);
        console.log(`Page created at: ${pageCreatedAt}`);
      }

      return { path: videoPath, durationMs: videoDurationMs, videoZeroMs: firstFrameAt };
    },
  };
}
