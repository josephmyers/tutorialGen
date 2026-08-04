import { beforeEach, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { ActionRunner, TEST_PACE } from "../src/browser/actions.js";
import { action, serveTwoPageSite, TWO_PAGE_SITE, useBrowser, VIEWPORT } from "./helpers.js";

const { browser, fixtureHtml } = useBrowser();
let page: Page;

function newRunner(): ActionRunner {
  // TEST_PACE: these test what the actions do, not how long they linger.
  return new ActionRunner(page, { timeoutMs: 5000, ...VIEWPORT, pace: TEST_PACE });
}

beforeEach(async () => {
  await page?.close();
  page = await browser.value.newPage({ viewport: VIEWPORT });
  await page.setContent(fixtureHtml.value);
  // Record every click, and keep form submission from navigating so these tests
  // isolate "did the click land" from what the page does afterwards.
  await page.evaluate(() => {
    window.__clicks = [];
    document.addEventListener("click", (e) => {
      window.__clicks.push((e.target as HTMLElement).textContent?.trim() ?? "");
    });
    document.querySelector("form")?.addEventListener("submit", (e) => e.preventDefault());
  });
});

async function clicks(): Promise<string[]> {
  return page.evaluate(() => window.__clicks);
}

describe("clicking", () => {
  it("clicks a submit button via the 'select' synonym", async () => {
    const runner = newRunner();
    await runner.begin();
    await runner.run(action('#Select "Sign In"'));

    expect(await clicks()).toContain("Sign In");
  });

  it("clicks a plain button", async () => {
    const runner = newRunner();
    await runner.begin();
    await runner.run(action('#Click "login"'));

    expect(await clicks()).toContain("Login");
  });

  it("runs the whole example script's actions in order", async () => {
    const runner = newRunner();
    await runner.begin();
    for (const line of [
      '#Click "login" to expand the sign-in form',
      '#Click "username"',
      '#Type "user1234"',
      '#Click "password"',
      '#Enter "test1234"',
      '#Select "Sign In"',
    ]) {
      await runner.run(action(line));
    }

    expect(await clicks()).toEqual(["Login", "", "", "Sign In"]);
    expect(await page.inputValue("#username")).toBe("user1234");
    expect(await page.inputValue("#password")).toBe("test1234");
  });
});

describe("clicks that navigate", () => {
  it("survives a click that replaces the document", async () => {
    await page.route("**/*", serveTwoPageSite);
    await page.goto(TWO_PAGE_SITE);

    const runner = newRunner();
    await runner.begin();
    // Must not fail: the element the pointer was tracking is gone after this.
    await runner.run(action('#Click "Go Somewhere"'));

    await expect(page.textContent("h1")).resolves.toBe("Next page");
  });

  it("does not return until a slow new page has actually loaded", async () => {
    // The server stalls, so the navigation commits long after the click event
    // has been dispatched. The action must not be reported complete before then,
    // or the queue advances into narration over a page that is still blank.
    await page.route("**/*", async (route) => {
      if (route.request().url().endsWith("/next")) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        return route.fulfill({ contentType: "text/html", body: "<h1>Arrived</h1>" });
      }
      return route.fulfill({
        contentType: "text/html",
        body: '<a href="/next">Go Somewhere</a>',
      });
    });
    await page.goto(TWO_PAGE_SITE);

    const runner = newRunner();
    await runner.begin();
    await runner.run(action('#Click "Go Somewhere"'));

    // Deliberately no waiting below: these read the state as it is the instant
    // run() returns.
    expect(page.url()).toBe("http://tutorialgen.test/next");
    expect(await page.evaluate(() => document.readyState)).toBe("complete");
  }, 20_000);
});

describe("waiting", () => {
  it("holds for the requested time without touching the page", async () => {
    const runner = newRunner();
    await runner.begin();

    const before = Date.now();
    await runner.run(action("#wait 50"));

    // A real hold — the one action TEST_PACE does not scale down, because the
    // duration is the author's, not the pace's.
    expect(Date.now() - before).toBeGreaterThanOrEqual(50);
    expect(await clicks()).toEqual([]);
  });
});
