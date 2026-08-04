import type { BrowserContext, Disposable, Page } from "playwright";

export interface Point {
  x: number;
  y: number;
}

/**
 * How the cursor moves. Real runs use the spec §8 feel; tests override it so
 * they are not forced to sit through the animation they are not testing.
 */
export interface CursorPace {
  /** Tween bounds; the actual duration scales with distance between targets. */
  minTweenMs: number;
  maxTweenMs: number;
  msPerPx: number;
  /** A correction hop after the page shifts under us should be quick. */
  hopMs: number;
}

export const NATURAL_CURSOR: CursorPace = {
  minTweenMs: 300,
  maxTweenMs: 700,
  msPerPx: 1.1,
  hopMs: 120,
};

/**
 * The drawn cursor (spec §8).
 *
 * Automation dispatches synthetic events and never moves the OS pointer, so no
 * pointer appears in captured frames — headed or not. This injects one into the
 * page and animates it.
 *
 * This class is the single source of the pointer coordinate: the overlay is
 * moved to a point and the synthetic mouse event is then dispatched at that same
 * point, so the drawn cursor and the real interaction cannot disagree.
 */
export class Cursor {
  private point: Point;
  private context: BrowserContext | null = null;
  /** The standing "paint yourself here" order given to every future document. */
  private standingOrder: Disposable | null = null;

  constructor(
    private readonly page: Page,
    start: Point,
    private readonly pace: CursorPace = NATURAL_CURSOR,
  ) {
    this.point = start;
  }

  get position(): Point {
    return this.point;
  }

  /**
   * Bind to the context so every document — including one created by a
   * navigation we never see — draws the cursor where it currently is.
   */
  async install(context: BrowserContext): Promise<void> {
    this.context = context;
    await this.restate();
  }

  /** Jump the overlay to a point with no animation (used per drag step). */
  async place(x: number, y: number): Promise<void> {
    await this.settle({ x, y, tweenMs: 0 });
  }

  /** Glide the overlay to a point, resolving once it has arrived. */
  async moveTo(x: number, y: number, durationMs = this.tweenMs(x, y)): Promise<void> {
    await this.settle({ x, y, tweenMs: durationMs });
  }

  /**
   * Move the cursor in the current document, then restate the standing order so
   * the next document starts from the same place.
   *
   * These two cover every document exactly once: `evaluate` the one that exists,
   * `addInitScript` every one that does not exist yet. Neither can race the
   * other, because `addInitScript` does not touch the live page.
   */
  private async settle(args: PaintArgs): Promise<void> {
    this.point = { x: args.x, y: args.y };
    await this.page.evaluate(paintCursorSource(args));
    await this.restate();
  }

  private async restate(): Promise<void> {
    if (!this.context) return;
    await this.standingOrder?.dispose();
    this.standingOrder = await this.context.addInitScript({
      content: paintCursorSource({ ...this.point, tweenMs: 0 }),
    });
  }

  /** Short hops stay snappy; long ones take longer, but never more than the cap. */
  private tweenMs(x: number, y: number): number {
    const { minTweenMs, maxTweenMs, msPerPx } = this.pace;
    const distance = Math.hypot(x - this.point.x, y - this.point.y);
    return Math.round(Math.min(maxTweenMs, Math.max(minTweenMs, distance * msPerPx)));
  }
}

export interface PaintArgs extends Point {
  /** 0 draws immediately; anything higher animates from the current position. */
  tweenMs: number;
}

export const CURSOR_ELEMENT_ID = "__tutorialgen_cursor";

/**
 * The overlay's in-page code, as source text rather than a function.
 *
 * It has to be text: Playwright ships a function into the page by calling
 * `toString()` on it, but our build (esbuild, via tsx) rewrites named inner
 * functions to reference a `__name` helper that exists only in Node. The
 * serialized copy would then throw `__name is not defined` in the browser.
 * Source text is passed through untouched, so it runs the same under `tsx`,
 * under `vitest`, and from compiled output.
 *
 * Create-or-move, and self-contained: the same text is used by `addInitScript`
 * for documents that do not exist yet and by `evaluate` for the one that does.
 */
export function paintCursorSource(args: PaintArgs): string {
  return `(function (args) {
  var ID = ${JSON.stringify(CURSOR_ELEMENT_ID)};
  var ARROW = '<svg width="22" height="30" viewBox="0 0 22 30" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M2 1.5 L2 22 L7.2 17.2 L10.6 25.4 L14.2 23.8 L10.9 15.9 L18 15.6 Z" '
    + 'fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';

  return new Promise(function (resolve) {
    function paint() {
      // At document-creation time there may be nothing to append to yet.
      var host = document.body || document.documentElement;
      if (!host) {
        document.addEventListener("DOMContentLoaded", paint, { once: true });
        return;
      }

      var el = document.getElementById(ID);
      if (!el) {
        el = document.createElement("div");
        el.id = ID;
        el.style.cssText = "position:fixed;left:0;top:0;width:22px;height:30px;"
          + "pointer-events:none;z-index:2147483647;will-change:transform";
        el.innerHTML = ARROW;
        host.appendChild(el);
      }

      function draw(px, py) {
        el.dataset.x = String(px);
        el.dataset.y = String(py);
        el.style.transform = "translate(" + px + "px, " + py + "px)";
      }

      var fromX = el.dataset.x === undefined ? args.x : Number(el.dataset.x);
      var fromY = el.dataset.y === undefined ? args.y : Number(el.dataset.y);
      if (args.tweenMs <= 0 || (fromX === args.x && fromY === args.y)) {
        draw(args.x, args.y);
        resolve();
        return;
      }

      var started = performance.now();
      // ease-in-out: accelerate away, settle onto the target.
      function ease(t) {
        return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      }

      function step(now) {
        var progress = Math.min(1, (now - started) / args.tweenMs);
        var eased = ease(progress);
        draw(fromX + (args.x - fromX) * eased, fromY + (args.y - fromY) * eased);
        if (progress < 1) {
          requestAnimationFrame(step);
        } else {
          draw(args.x, args.y);
          resolve();
        }
      }
      requestAnimationFrame(step);
    }

    paint();
  });
})(${JSON.stringify(args)})`;
}
