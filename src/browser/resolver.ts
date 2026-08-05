import { setTimeout as sleep } from "node:timers/promises";
import type { Locator, Page } from "playwright";

/**
 * Roles whose accessible name is matched.
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

/** A named locator in the priority chain. */
type Strategy = [describe: string, locator: Locator];

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
    for (const [describe, locator] of strategies) {
      const count = await locator.count();
      if (count === 1) return locator;
      if (count > 1) {
        throw new Error(
          `"${target}" matched ${count} visible elements via ${describe}; ` +
            `tighten the target so it names one.`,
        );
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `could not find "${target}" after ${timeoutMs}ms. Tried:\n` +
          strategies.map(([describe]) => `      ${describe}`).join("\n"),
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** The priority chain, highest first. Every locator is filtered to visible. */
function buildStrategies(page: Page, target: string): Strategy[] {
  const visible = (describe: string, locator: Locator): Strategy => [
    describe,
    locator.filter({ visible: true }),
  ];
  // JSON quoting escapes backslashes and quotes exactly as a CSS string needs;
  // the ` i` flag matters, since attribute matching is case-sensitive without it.
  const attr = (name: string): Strategy => {
    const selector = `[${name}=${JSON.stringify(target)} i]`;
    return visible(selector, page.locator(selector));
  };
  const byRole = INTERACTIVE_ROLES.map((role) => page.getByRole(role, { name: target })).reduce(
    (a, b) => a.or(b),
  );

  return [
    attr("aria-label"),
    visible(`role=[${INTERACTIVE_ROLES.join("|")}][name="${target}"]`, byRole),
    visible(`label="${target}"`, page.getByLabel(target)),
    visible(`placeholder="${target}"`, page.getByPlaceholder(target)),
    visible(`text="${target}"`, page.getByText(target)),
    attr("name"),
    attr("id"),
  ];
}
