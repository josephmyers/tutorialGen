import { setTimeout as sleep } from "node:timers/promises";
import { utils } from "playwright-core/lib/coreBundle";
import type { Page, Request } from "playwright";

const { getComparator } = utils;

const POLL_MS = 100;

export interface CompletionOptions {
  timeoutMs: number;
  minSettledTimeMs: number;
  reactionGraceMs: number;
}

/**
 * Run an action and block until the browser is genuinely done with it (spec §4).
 *
 * Every action waits on the same thing: the page holding still. Playwright's
 * auto-waiting gates the action itself, and `load` fires on whichever document
 * commits first — on a site with a loading screen or an entry animation that is
 * not the page the viewer is meant to see. Watching the pixels covers both, and
 * covers the in-page cases (a menu opening, a lazy image arriving) that a
 * navigation check never saw at all.
 *
 * Two phases, both `holdStill` with different parameters:
 *
 * 1. Every action waits for two consecutive frames to match — the moment motion
 *    stops, whether that took one poll or fifty. An action that provoked nothing
 *    pays the reaction grace and leaves.
 * 2. A navigation additionally waits for a `minSettledTimeMs` streak of matching
 *    frames. A new document arrives in stages — first paint, webfonts, images,
 *    an entry animation — and momentary stillness between two of those stages is
 *    not arrival. Nothing else is charged for that, which is the point: the long
 *    settle used to fall on any action whose reaction was animated rather than
 *    instant.
 *
 * Phase 1 cannot return before `reactionGraceMs` is up. That gate is what makes
 * the URL below a reading taken after the page has had its chance to react, and
 * it keeps an action from being called complete before anything could have
 * happened at all.
 */
export async function withCompletion<T>(
  page: Page,
  action: () => Promise<T>,
  { timeoutMs, minSettledTimeMs, reactionGraceMs }: CompletionOptions,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  const navigations = watchNavigations(page);

  try {
    const urlBefore = page.url();
    const result = await action();

    await holdStill(page, {
      deadline,
      timeoutMs,
      stillForMs: 0,
      notBefore: Date.now() + reactionGraceMs,
      navigations,
    });

    if (page.url() !== urlBefore) {
      await holdStill(page, {
        deadline,
        timeoutMs,
        stillForMs: minSettledTimeMs,
        notBefore: 0,
        navigations,
      });
    }

    return result;
  } finally {
    navigations.stop();
  }
}

interface HoldOptions {
  /** The caller's deadline, shared by both phases so neither restarts the clock. */
  deadline: number;
  timeoutMs: number;
  /** 0 lets the first matching pair win; higher demands an unbroken streak. */
  stillForMs: number;
  /** The earliest instant the loop may return, whatever the pixels say. */
  notBefore: number;
  navigations: NavWatch;
}

/**
 * Poll until the page stops changing, or give up and say so.
 */
async function holdStill(page: Page, o: HoldOptions): Promise<void> {
  const comparator = getComparator("image/png");
  let previous = await page.screenshot();
  let lastChange = Date.now();

  for (;;) {
    await sleep(POLL_MS);

    const current = await page.screenshot();
    const changed =
      o.navigations.pending > 0 ||
      comparator(previous, current, { maxDiffPixelRatio: 0 }) !== null;
    previous = current;

    const now = Date.now();
    if (changed) lastChange = now;
    else if (now - lastChange >= o.stillForMs && now >= o.notBefore) return;

    if (now >= o.deadline) {
      throw new Error(
        `page never held still for ${o.stillForMs}ms within ${o.timeoutMs}ms at ${page.url()}`,
      );
    }
  }
}

interface NavWatch {
  /** How many main-frame navigations have been issued but not yet resolved. */
  readonly pending: number;
  stop(): void;
}

function watchNavigations(page: Page): NavWatch {
  const inFlight = new Set<Request>();

  const started = (request: Request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      inFlight.add(request);
    }
  };
  const ended = (request: Request) => inFlight.delete(request);

  page.on("request", started);
  page.on("requestfinished", ended);
  page.on("requestfailed", ended);

  return {
    get pending() {
      return inFlight.size;
    },
    stop() {
      page.off("request", started);
      page.off("requestfinished", ended);
      page.off("requestfailed", ended);
    },
  };
}
