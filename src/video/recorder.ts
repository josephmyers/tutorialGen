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
      // Video timestamp zero, recovered after the fact. The take begins at the
      // first frame the browser painted — an instant nothing on this side can
      // observe — but it ends when the recorder is closed, which we do know. So
      // the start is the end minus however long the take turned out to be.
      //
      // This holds because Playwright encodes at a constant 25fps, repeating the
      // last frame through stillness, and because the caller leaves the page
      // still for well over the 1s its recorder pads the end by: with no frame
      // arriving in that last second, the padding is the real elapsed time
      // rather than the floor, and the file ends where the recording did.
      const closedAt = Date.now();
      // The .webm is only flushed to disk when the context closes.
      await context.close();
      const path = await video.path();
      const durationMs = (await measureDurationSec(path)) * 1000;
      const videoZeroMs = closedAt - durationMs;

      // The take cannot have started before the page it is recording existed. If
      // it did, the duration or the close instant is not what this assumes, and
      // every offset derived from it is wrong by that amount — so say so rather
      // than hand back numbers that silently desync the narration.
      if (videoZeroMs < pageCreatedAt) {
        throw new Error(
          `Video zero lands ${pageCreatedAt - videoZeroMs}ms before the page was created. ` +
            `Take is ${(durationMs / 1000).toFixed(3)}s but only ` +
            `${((closedAt - pageCreatedAt) / 1000).toFixed(3)}s elapsed from page creation to close.`,
        );
      }
      return { path, durationMs, videoZeroMs };
    },
  };
}
