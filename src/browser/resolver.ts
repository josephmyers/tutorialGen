import { setTimeout as sleep } from "node:timers/promises";
import type { Locator, Page } from "playwright";
import { truncate } from "../util/text.js";

/**
 * Roles tried first, in priority order. Playwright matches a plain-string
 * `name` case-insensitively as a substring, which is what lets a script say
 * "login" for a button labelled "Log In".
 */
const INTERACTIVE_ROLES = [
  "button",
  "link",
  "tab",
  "menuitem",
  "checkbox",
  "radio",
  "combobox",
  "textbox",
] as const;

const POLL_INTERVAL_MS = 100;
const MAX_CANDIDATES_SHOWN = 5;

interface Strategy {
  describe: string;
  locator: Locator;
}

/**
 * Resolve a target string to exactly one visible element (spec §6). Strategies
 * are tried in priority order and the first with a single visible match wins;
 * the chain is re-tried until `timeoutMs` so an element still animating in from
 * the previous action is not missed.
 *
 * Multiple visible matches abort immediately rather than guessing — the author
 * needs to tighten the target.
 */
export async function resolveTarget(
  page: Page,
  target: string,
  timeoutMs: number,
): Promise<Locator> {
  const strategies = buildStrategies(page, target);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    // Counting is read-only, so the whole chain goes out as one concurrent wave
    // rather than a dozen serial round trips per poll. Priority is decided on
    // the resolved array, so the outcome is exactly the ordered scan's.
    const counts = await Promise.all(strategies.map((s) => s.locator.count()));
    for (const [i, count] of counts.entries()) {
      const strategy = strategies[i]!;
      if (count === 1) return strategy.locator;
      if (count > 1) throw await ambiguous(target, strategy, count);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `could not find "${target}" after ${timeoutMs}ms. Tried:\n` +
          strategies.map((s) => `      ${s.describe}`).join("\n"),
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** The priority chain, highest first. Every locator is filtered to visible. */
function buildStrategies(page: Page, target: string): Strategy[] {
  const visible = (locator: Locator): Locator => locator.filter({ visible: true });

  return [
    ...INTERACTIVE_ROLES.map((role) => ({
      describe: `role=${role}[name="${target}"]`,
      locator: visible(page.getByRole(role, { name: target })),
    })),
    { describe: `label="${target}"`, locator: visible(page.getByLabel(target)) },
    { describe: `placeholder="${target}"`, locator: visible(page.getByPlaceholder(target)) },
    { describe: `text="${target}"`, locator: visible(page.getByText(target)) },
    ...["aria-label", "name", "id"].map((attr) => ({
      describe: `[${attr}="${target}" i]`,
      // The ` i` flag matters: CSS attribute matching is case-sensitive without it.
      locator: visible(page.locator(`[${attr}="${cssEscape(target)}" i]`)),
    })),
  ];
}

async function ambiguous(target: string, strategy: Strategy, count: number): Promise<Error> {
  let shown: string[];
  try {
    const texts = await strategy.locator.allTextContents();
    shown = texts
      .slice(0, MAX_CANDIDATES_SHOWN)
      .map((t, i) => `      ${i + 1}. ${truncate(t) || "(no text)"}`);
  } catch {
    shown = [];
  }
  const more = count > MAX_CANDIDATES_SHOWN ? `\n      ...and ${count - MAX_CANDIDATES_SHOWN} more` : "";
  return new Error(
    `"${target}" matched ${count} visible elements via ${strategy.describe}; ` +
      `tighten the target so it names one.\n${shown.join("\n")}${more}`,
  );
}

/** Escape for a double-quoted CSS attribute value. */
function cssEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
