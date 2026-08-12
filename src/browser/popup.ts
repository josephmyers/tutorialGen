import type { Page } from "playwright";

/** How long the popup sits at full opacity before it starts to leave. */
const HOLD_MS = 800;
/** The fade-out. There is deliberately no fade in: the press is instant. */
const FADE_MS = 200;

export const KEYCAP_ELEMENT_ID = "__tutorialgen_keycap";

/**
 * Show a popup with the given label, resolving once it is gone again.
 */
export function showPopup(page: Page, label: string): Promise<void> {
  return page.evaluate(
    (args) =>
      new Promise<void>((resolve) => {
        document.getElementById(args.id)?.remove();

        const el = document.createElement("div");
        el.id = args.id;
        el.style.cssText = `position:fixed;left:50%;bottom:40px;transform:translateX(-50%);
          padding:10px 18px;border-radius:10px;
          background:rgba(17,17,17,0.88);color:#fff;
          font:600 20px/1 ui-monospace,Menlo,Consolas,monospace;
          white-space:nowrap;pointer-events:none;opacity:1;
          transition:opacity ${args.fadeMs}ms linear;z-index:2147483646`;
        el.textContent = args.label;
        (document.body ?? document.documentElement).appendChild(el);

        setTimeout(() => {
          el.style.opacity = "0";
          setTimeout(() => {
            el.remove();
            resolve();
          }, args.fadeMs);
        }, args.holdMs);
      }),
    { id: KEYCAP_ELEMENT_ID, label, holdMs: HOLD_MS, fadeMs: FADE_MS },
  );
}
