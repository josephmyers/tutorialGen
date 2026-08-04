import { setTimeout as sleep } from "node:timers/promises";
import { beforeEach, describe, expect, it } from "vitest";
import type { BrowserContext, Page } from "playwright";
import { ActionRunner, TEST_PACE } from "../src/browser/actions.js";
import { CURSOR_ELEMENT_ID as CURSOR_ID } from "../src/browser/cursor.js";
import { action, serveTwoPageSite, TWO_PAGE_SITE, useBrowser, VIEWPORT } from "./helpers.js";

const { browser, fixtureHtml } = useBrowser();
let context: BrowserContext;
let page: Page;
let runner: ActionRunner;

/** Where the overlay is currently drawn, per its own recorded coordinates. */
async function cursorPoint(): Promise<{ x: number; y: number } | null> {
  return page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el || el.style.visibility === "hidden") return null;
    return { x: Number(el.dataset.x), y: Number(el.dataset.y) };
  }, CURSOR_ID);
}

beforeEach(async () => {
  await context?.close();
  context = await browser.value.newContext({ viewport: VIEWPORT });
  page = await context.newPage();
  runner = new ActionRunner(page, { timeoutMs: 5000, ...VIEWPORT, pace: TEST_PACE, context });
  await page.setContent(fixtureHtml.value);
  // Keep the form from navigating away, so assertions can still look at the
  // element that was clicked.
  await page.evaluate(() => {
    document.querySelector("form")?.addEventListener("submit", (e) => e.preventDefault());
  });
  await runner.begin();
});

describe("cursor overlay", () => {
  it("is drawn at viewport center before anything happens", async () => {
    expect(await cursorPoint()).toEqual({ x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 });
  });

  it("does not receive pointer events itself", async () => {
    const pointerEvents = await page.evaluate(
      (id) => getComputedStyle(document.getElementById(id)!).pointerEvents,
      CURSOR_ID,
    );
    expect(pointerEvents).toBe("none");
  });

  it("lands on the element it clicks", async () => {
    await runner.run(action('#Click "Sign In"'));

    const drawn = await cursorPoint();
    const box = (await page.getByRole("button", { name: "Sign In" }).boundingBox())!;
    expect(drawn!.x).toBeCloseTo(box.x + box.width / 2, 0);
    expect(drawn!.y).toBeCloseTo(box.y + box.height / 2, 0);
  });

  it("stays put while typing", async () => {
    await runner.run(action('#Click "username"'));
    const before = await cursorPoint();
    await runner.run(action('#Type "user1234"'));

    expect(await cursorPoint()).toEqual(before);
    expect(await page.inputValue("#username")).toBe("user1234");
  });

  it("moves between targets rather than jumping", async () => {
    await runner.run(action('#Click "login"'));
    const start = (await cursorPoint())!;

    // Sample for the whole action, not a fixed number of polls — a fixed count
    // finishes long before the tween even begins. Throttled, so the sampler is
    // not saturating the protocol against the very tween it is measuring; the
    // interval still yields several samples across a TEST_PACE tween.
    const samples: Array<{ x: number; y: number }> = [];
    let running = true;
    const sampling = (async () => {
      while (running) {
        const p = await cursorPoint();
        if (p) samples.push(p);
        await sleep(5);
      }
    })();
    await runner.run(action('#Click "Sign In"'));
    running = false;
    await sampling;

    const end = (await cursorPoint())!;
    const intermediate = samples.filter(
      (p) => (p.x !== start.x || p.y !== start.y) && (p.x !== end.x || p.y !== end.y),
    );
    expect(intermediate.length).toBeGreaterThan(0);
  });

  it("does not touch the element until the cursor has arrived", async () => {
    // Record where the overlay is drawn at the instant the button is entered.
    // Anything the page does in response to the pointer must happen with the
    // cursor already on the target, not while it is still travelling there.
    await page.evaluate((id) => {
      window.__hoverCursorAt = null;
      document.querySelector("form button")?.addEventListener("mouseover", () => {
        const el = document.getElementById(id);
        window.__hoverCursorAt = el
          ? { x: Number(el.dataset.x), y: Number(el.dataset.y) }
          : null;
      });
    }, CURSOR_ID);

    await runner.run(action('#Hover "Sign In"'));

    const hoveredAt = await page.evaluate(() => window.__hoverCursorAt);
    const box = (await page.getByRole("button", { name: "Sign In" }).boundingBox())!;
    expect(hoveredAt).not.toBeNull();
    expect(hoveredAt!.x).toBeCloseTo(box.x + box.width / 2, 0);
    expect(hoveredAt!.y).toBeCloseTo(box.y + box.height / 2, 0);
  });

  it("is re-created after a navigation wipes the document", async () => {
    await page.route("**/*", serveTwoPageSite);
    await page.goto(TWO_PAGE_SITE);
    await runner.begin();

    await runner.run(action('#Click "Go Somewhere"'));
    await expect(page.textContent("h1")).resolves.toBe("Next page");

    // The new document wiped the old overlay; it must be drawn again, where the
    // click left it.
    expect(await cursorPoint()).toEqual(runner.cursor.position);
  });
});
