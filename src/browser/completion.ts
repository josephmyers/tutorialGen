import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";

/** How often the settle loop re-reads the page. */
const POLL_MS = 200;

export interface CompletionOptions {
  /** Budget for a navigation, once one has started. */
  timeoutMs: number;
  /** How long the page gets to *begin* navigating before we call it done. */
  reactionGraceMs: number;
  /** How long the page must go unchanged before a changed page counts as settled. */
  htmlUnchangedMs: number;
}

/**
 * Run an action and block until the browser is genuinely done with it (spec §4).
 *
 * Playwright's own auto-waiting already gates an ordinary action, so nothing is
 * added for one that stays on the page. Navigation is the gap: `load` fires on
 * whichever document commits first, which on a site with a loading screen or an
 * entry animation is not the page the viewer is meant to see. So when the URL
 * changes, wait for the page to hold still instead.
 */
export async function withCompletion<T>(
  page: Page,
  action: () => Promise<T>,
  { timeoutMs, reactionGraceMs, htmlUnchangedMs }: CompletionOptions,
): Promise<T> {
  const from = page.url();
  const result = await action();

  // A click's consequences are asynchronous — the handler runs, the request goes
  // out — so nothing has happened yet at the instant it returns. This is the
  // window for a navigation to *start*, not a budget for the navigation itself,
  // which is why the wait stops at the commit.
  try {
    await page.waitForURL((url) => url.href !== from, {
      timeout: reactionGraceMs,
      waitUntil: "commit",
    });
  } catch {
    if (page.url() === from) return result; // Went nowhere; the action is done.
  }

  await page.waitForLoadState("load", { timeout: timeoutMs }).catch(() => {});
  await settle(page, timeoutMs, htmlUnchangedMs);
  return result;
}

/** Poll until the page stops changing, or give up and say so. */
async function settle(page: Page, timeoutMs: number, htmlUnchangedMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous: string | undefined;
  let lastChange = Date.now();

  for (;;) {
    const current = await snapshot(page, deadline - Date.now());
    if (current === undefined || current !== previous) lastChange = Date.now();
    previous = current;

    if (Date.now() - lastChange >= htmlUnchangedMs) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `page never held still for ${htmlUnchangedMs}ms within ${timeoutMs}ms at ${page.url()}`,
      );
    }
    await sleep(POLL_MS);
  }
}

/**
 * The page as one comparable string.
 *
 * Pixels, not markup. A CSS animation — the progress bar on a loading screen is
 * the case that matters — never rewrites the DOM: the keyframes drive computed
 * style, so serialized HTML is byte-identical from frame to frame and a page
 * that is visibly still moving reads as settled. A screenshot measures what the
 * viewer actually sees, which also covers canvas, video, and shadow DOM.
 *
 * A page that never stops moving therefore never settles, and fails on the
 * caller's deadline. That is the intended outcome, not a shortcoming: the
 * recording of such a page has no correct moment to move on from.
 *
 * The URL rides along so that a follow-on navigation to a visually identical
 * page still counts as a change. `undefined` means the page could not be read —
 * a document being torn down mid-navigation is the ordinary way that happens,
 * and it is a change rather than a failure. It also makes the next successful
 * read differ, since the page that one belongs to was never compared.
 */
async function snapshot(page: Page, timeout: number): Promise<string | undefined> {
  try {
    const pixels = await page.screenshot({ timeout: Math.max(timeout, 0) });
    return `${page.url()}\n${createHash("sha1").update(pixels).digest("hex")}`;
  } catch {
    return undefined;
  }
}
