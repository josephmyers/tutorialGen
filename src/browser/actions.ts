import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserContext, Locator, Page } from "playwright";
import type { ActionSegment } from "../parser/types.js";
import { withCompletion } from "./completion.js";
import { Cursor, NATURAL_CURSOR, type CursorPace, type Point } from "./cursor.js";
import { resolveTarget } from "./resolver.js";

/** A wheel scroll is chunked so it reads as motion, not a jump. */
const SCROLL_CHUNKS = 10;
/** Steps in a drag, so the path is visible. */
const DRAG_STEPS = 24;
/** How far an element may shift during the tween before we re-aim. */
const SHIFT_TOLERANCE_PX = 2;

/**
 * The pointer commands, as the pair they actually differ by: which Locator
 * method performs the actionability check, and which mouse method dispatches.
 * The three cases are otherwise identical.
 */
const POINTER_COMMANDS = {
  click: { trial: "click", dispatch: "click" },
  doubleclick: { trial: "dblclick", dispatch: "dblclick" },
  hover: { trial: "hover", dispatch: "move" },
} as const;

type PointerCommand = keyof typeof POINTER_COMMANDS;

/**
 * Everything that exists to make the recording watchable rather than correct.
 *
 * Injectable so tests are not forced to sit through animation they are not
 * testing: a six-action script at the natural pace takes seconds, almost all of
 * it deliberate waiting.
 */
export interface Pace extends CursorPace {
  /** Char-by-char typing rather than an instant field fill (spec §8). */
  typeDelayMs: number;
  /** Pause between wheel chunks and drag steps. */
  stepMs: number;
  /** Time for a smooth `scroll to` to finish before the next segment starts. */
  scrollSettleMs: number;
  /** How long a page gets to begin reacting before an action is complete. */
  reactionGraceMs: number;
  /** How long a changed page's HTML must go unchanged before it counts as settled. */
  htmlUnchangedMs: number;
}

export const NATURAL_PACE: Pace = {
  ...NATURAL_CURSOR,
  typeDelayMs: 45,
  stepMs: 25,
  scrollSettleMs: 500,
  reactionGraceMs: 500,
  htmlUnchangedMs: 1000,
};

/**
 * For tests: the same behaviour scaled down to milliseconds. Deliberately not
 * zero — the tween and the reaction window still have to occur, or a test could
 * not observe that they occur at all.
 */
export const TEST_PACE: Pace = {
  minTweenMs: 60,
  maxTweenMs: 60,
  msPerPx: 0,
  hopMs: 20,
  typeDelayMs: 1,
  stepMs: 1,
  scrollSettleMs: 20,
  reactionGraceMs: 50,
  htmlUnchangedMs: 100,
};

export interface ActionRunnerOptions {
  timeoutMs: number;
  width: number;
  height: number;
  pace?: Pace;
  /**
   * The page's context. Supplying it lets `begin()` bind the overlay so every
   * document — including ones created by navigations we never see — draws it.
   */
  context?: BrowserContext;
}

/**
 * Performs parsed actions against a live page, with the human-like affordances
 * of spec §8: the drawn cursor glides to each target before the synthetic event
 * is dispatched at those exact coordinates.
 */
export class ActionRunner {
  private readonly page: Page;
  private readonly timeoutMs: number;
  private readonly pace: Pace;
  private readonly context: BrowserContext | undefined;
  readonly cursor: Cursor;

  constructor(page: Page, opts: ActionRunnerOptions) {
    this.page = page;
    this.timeoutMs = opts.timeoutMs;
    this.pace = opts.pace ?? NATURAL_PACE;
    this.context = opts.context;
    this.cursor = new Cursor(
      page,
      { x: Math.floor(opts.width / 2), y: Math.floor(opts.height / 2) },
      this.pace,
    );
  }

  /**
   * Put the overlay and the virtual pointer on the same point before the first
   * action. Playwright's mouse begins at (0,0), so without this the drawn cursor
   * and the real input would disagree the first time one is dispatched.
   *
   * Binding the overlay to the context happens here rather than at the call
   * site, so the runner's invariant — drawn cursor and dispatched coordinate are
   * the same point — is not left to the caller to sequence correctly.
   */
  async begin(): Promise<void> {
    if (this.context) await this.cursor.install(this.context);
    const { x, y } = this.cursor.position;
    await this.page.mouse.move(x, y);
    await this.cursor.place(x, y);
  }

  /** Run one action to completion, failing with its script line number. */
  async run(action: ActionSegment): Promise<void> {
    try {
      await withCompletion(this.page, () => this.dispatch(action), {
        timeoutMs: this.timeoutMs,
        reactionGraceMs: this.pace.reactionGraceMs,
        htmlUnchangedMs: this.pace.htmlUnchangedMs,
      });
    } catch (err) {
      throw new Error(`line ${action.line}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async dispatch(action: ActionSegment): Promise<void> {
    switch (action.command) {
      case "click":
      case "doubleclick":
      case "hover": {
        const { trial, dispatch } = POINTER_COMMANDS[action.command];
        const { x, y } = await this.approach(action.target, trial);
        await this.page.mouse[dispatch](x, y);
        return;
      }

      case "scroll to": {
        const locator = await this.locate(action.target);
        await locator.evaluate((el) => {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        });
        await sleep(this.pace.scrollSettleMs);
        return;
      }

      case "type": {
        // Typing goes to whatever a preceding click focused, so the cursor stays.
        if (action.shortcut) {
          await this.page.keyboard.press(action.shortcut);
        } else {
          await this.page.keyboard.type(action.target, { delay: this.pace.typeDelayMs });
        }
        return;
      }

      case "scroll up":
      case "scroll down": {
        const total = action.command === "scroll up" ? -action.amountPx : action.amountPx;
        await this.wheel(total);
        return;
      }

      case "drag": {
        await this.drag(action.dx, action.dy);
        return;
      }

      case "wait": {
        // Nothing is dispatched and the cursor stays put: the point is the hold.
        await sleep(action.durationMs);
        return;
      }
    }
  }

  /**
   * Bring the cursor to an element and return the exact point to dispatch at.
   *
   * Order matters here. A trial run is not passive — it moves the virtual mouse
   * onto the element, so the page sees `pointerover`/`mouseover` the moment it
   * runs. Doing it first lit elements up while the cursor was still travelling
   * towards them. So the element is scrolled on screen and measured with calls
   * that make no pointer contact, the cursor travels, and only then does the
   * actionability check run — by which time the pointer arriving is exactly
   * what the viewer is watching happen.
   */
  private async approach(
    target: string,
    trial: (typeof POINTER_COMMANDS)[PointerCommand]["trial"],
  ): Promise<Point> {
    const locator = await this.locate(target);

    // Neither of these dispatches anything, and the scroll is what makes the
    // box viewport coordinates we can actually dispatch at.
    await locator.scrollIntoViewIfNeeded({ timeout: this.timeoutMs });
    const aim = await this.centerOf(locator, target);

    await this.cursor.moveTo(aim.x, aim.y);

    // Playwright's own actionability wait: attached, visible, stable,
    // receives-events, and enabled for the two click variants. Kept distinct
    // because hover does not require the element to be enabled. This is the
    // only thing checking any of that — page.mouse.* checks nothing — so a
    // disabled or covered target fails loudly here instead of silently later.
    await locator[trial]({ trial: true, timeout: this.timeoutMs });

    // The page can shift while the cursor travels; re-aim rather than click air.
    const settled = await this.centerOf(locator, target);
    if (Math.hypot(settled.x - aim.x, settled.y - aim.y) > SHIFT_TOLERANCE_PX) {
      await this.cursor.moveTo(settled.x, settled.y, this.pace.hopMs);
    }
    return settled;
  }

  private async centerOf(locator: Locator, target: string): Promise<Point> {
    const box = await locator.boundingBox({ timeout: this.timeoutMs });
    if (!box) {
      throw new Error(`"${target}" resolved but has no visible box to click`);
    }
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  private locate(target: string): Promise<Locator> {
    return resolveTarget(this.page, target, this.timeoutMs);
  }

  private async wheel(totalPx: number): Promise<void> {
    const step = totalPx / SCROLL_CHUNKS;
    for (let i = 0; i < SCROLL_CHUNKS; i++) {
      await this.page.mouse.wheel(0, step);
      await sleep(this.pace.stepMs);
    }
  }

  /** Drag from wherever the cursor is, keeping overlay and pointer in lockstep. */
  private async drag(dx: number, dy: number): Promise<void> {
    const { x, y } = this.cursor.position;
    await this.page.mouse.down();
    for (let step = 1; step <= DRAG_STEPS; step++) {
      const progress = step / DRAG_STEPS;
      const nx = x + dx * progress;
      const ny = y + dy * progress;
      await this.page.mouse.move(nx, ny);
      await this.cursor.place(nx, ny);
      await sleep(this.pace.stepMs);
    }
    await this.page.mouse.up();
  }
}
