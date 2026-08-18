import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll } from "vitest";
import { chromium, type Browser, type Route } from "playwright";
import { parseScript } from "../src/parser/parser.js";
import { isAction, type ActionSegment } from "../src/parser/types.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "login.html");

export const VIEWPORT = { width: 1280, height: 720 };

/** Parse a single script line into the action it produces. */
export function action(scriptLine: string): ActionSegment {
  const segment = parseScript(scriptLine).segments[0];
  if (!segment || !isAction(segment)) {
    throw new Error(`"${scriptLine}" did not parse to an action`);
  }
  return segment;
}

/**
 * A genuine cross-document navigation, served by request interception: the root
 * serves a link, `/next` serves the page it leads to. (A data: URL would not do
 * — Chromium blocks top-level navigation to one.)
 */
export const TWO_PAGE_SITE = "http://tutorialgen.test/";

export function serveTwoPageSite(route: Route): Promise<void> {
  const body = route.request().url().endsWith("/next")
    ? "<h1>Next page</h1>"
    : '<a href="/next">Go Somewhere</a>';
  return route.fulfill({ contentType: "text/html", body });
}

/**
 * Registers the chromium lifecycle hooks and hands back lazily-populated
 * handles — a suite reads `browser.value` / `fixtureHtml.value` inside its own
 * hooks and tests, by which point both are set.
 */
export function useBrowser(): {
  browser: { value: Browser };
  fixtureHtml: { value: string };
} {
  const browser = {} as { value: Browser };
  const fixtureHtml = {} as { value: string };

  beforeAll(async () => {
    browser.value = await chromium.launch();
    fixtureHtml.value = await readFile(FIXTURE, "utf8");
  }, 60_000);

  afterAll(async () => {
    await browser.value?.close();
  });

  return { browser, fixtureHtml };
}
