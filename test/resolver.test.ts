import { beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { resolveTarget } from "../src/browser/resolver.js";
import { useBrowser } from "./helpers.js";

/** Short, since the not-found tests deliberately wait it out. */
const TIMEOUT_MS = 1000;

const { browser, fixtureHtml } = useBrowser();
let page: Page;

beforeAll(async () => {
  page = await browser.value.newPage();
  await page.setContent(fixtureHtml.value);
});

/** The element the target resolved to, as a lowercase tag plus useful attributes. */
async function describeMatch(target: string): Promise<string> {
  const locator = await resolveTarget(page, target, TIMEOUT_MS);
  return locator.evaluate((el) => {
    const id = el.id ? `#${el.id}` : "";
    return `${el.tagName.toLowerCase()}${id}`;
  });
}

describe("priority chain", () => {
  it("resolves a button by its accessible name", async () => {
    expect(await describeMatch("Login")).toBe("button#login");
  });

  it("matches accessible names case-insensitively, as a substring", async () => {
    // The §3 example script says "login" for a button labelled "Login".
    expect(await describeMatch("login")).toBe("button#login");
  });

  it("resolves a form field by its label", async () => {
    expect(await describeMatch("Username")).toBe("input#username");
  });

  it("resolves a form field by its placeholder", async () => {
    expect(await describeMatch("Your password")).toBe("input#password");
  });

  it("resolves the submit button from the §3 example", async () => {
    expect(await describeMatch("Sign In")).toBe("button");
  });

  it("falls back to aria-label", async () => {
    expect(await describeMatch("Get help")).toBe("a");
  });

  it("falls back to visible body text", async () => {
    expect(await describeMatch("descriptive body text")).toBe("p");
  });
});

describe("failures", () => {
  it("aborts with the strategies tried when nothing matches", async () => {
    await expect(resolveTarget(page, "Nonexistent Widget", TIMEOUT_MS)).rejects.toThrow(
      /could not find "Nonexistent Widget".*Tried:/s,
    );
  });

  it("ignores hidden elements", async () => {
    await expect(resolveTarget(page, "Hidden Action", TIMEOUT_MS)).rejects.toThrow(/could not find/);
  });

  it("aborts with the candidate list when the target is ambiguous", async () => {
    await expect(resolveTarget(page, "Duplicate", TIMEOUT_MS)).rejects.toThrow(
      /matched 2 visible elements.*tighten the target/s,
    );
  });
});

describe("waiting", () => {
  it("resolves an element that appears after the call starts", async () => {
    const appearing = await browser.value.newPage();
    try {
      await appearing.setContent("<div id='host'></div>");
      // Injected well after resolveTarget begins polling.
      void appearing.evaluate(() => {
        setTimeout(() => {
          const button = document.createElement("button");
          button.textContent = "Delayed";
          document.body.append(button);
        }, 300);
      });

      const locator = await resolveTarget(appearing, "Delayed", 5000);
      await expect(locator.textContent()).resolves.toBe("Delayed");
    } finally {
      await appearing.close();
    }
  });
});
