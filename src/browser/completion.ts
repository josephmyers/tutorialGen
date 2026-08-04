import { setTimeout as sleep } from "node:timers/promises";
import type { Frame, Page, Request } from "playwright";

const POLL_MS = 25;

export interface CompletionOptions {
  /** Budget for a navigation once one has started. */
  timeoutMs: number;
  /**
   * How long the page gets to *begin* reacting before the action is complete. A
   * click's consequences are asynchronous — the handler runs, the form submits,
   * the request goes out — so nothing is observable at the instant the click
   * returns. This is not a budget for the navigation itself.
   */
  reactionGraceMs: number;
}

/**
 * Run an action and block until the browser is genuinely done with it (spec §4).
 *
 * Playwright's actionability auto-wait gates the *next* action, so the signal
 * this adds is navigation. Two are watched, because one alone is not enough:
 *
 * - the navigation **request**, which is the earliest sign a click is taking us
 *   somewhere (the commit can be seconds later, behind a slow server), and
 * - **framenavigated**, the commit itself, which is the only thing that fires
 *   for a same-document navigation such as `history.pushState`.
 *
 * Both are filtered to the main frame, so iframe and ad churn is ignored, and
 * `networkidle` is deliberately never used — chatty or polling sites never
 * reach it.
 */
export async function withCompletion<T>(
  page: Page,
  action: () => Promise<T>,
  { timeoutMs, reactionGraceMs }: CompletionOptions,
): Promise<T> {
  let requested = false;
  let committed = false;

  const onRequest = (req: Request): void => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) requested = true;
  };
  const onNavigated = (frame: Frame): void => {
    if (frame === page.mainFrame()) committed = true;
  };

  page.on("request", onRequest);
  page.on("framenavigated", onNavigated);
  try {
    const result = await action();

    await until(() => requested || committed, reactionGraceMs);
    if (requested || committed) {
      // `waitForLoadState` reports on whichever document is current, so the new
      // one has to have committed before asking — otherwise it answers about the
      // page we are leaving, which is already loaded.
      await until(() => committed, timeoutMs);
      await page.waitForLoadState("load", { timeout: timeoutMs });
    }
    return result;
  } finally {
    page.off("request", onRequest);
    page.off("framenavigated", onNavigated);
  }
}

/** Poll until `condition` holds or the budget runs out. */
async function until(condition: () => boolean, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!condition() && Date.now() < deadline) {
    await sleep(POLL_MS);
  }
}
