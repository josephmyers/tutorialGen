export interface NarrationSegment {
  kind: "narration";
  /** 1-based line number in the script file. */
  line: number;
  text: string;
}

interface ActionBase {
  kind: "action";
  line: number;
  /** The quoted text verbatim, kept for error messages regardless of command. */
  target: string;
}

/** Commands that resolve their target to a live DOM element. */
export interface ElementAction extends ActionBase {
  command: "click" | "doubleclick" | "hover" | "scroll to";
}

export interface TypeAction extends ActionBase {
  command: "type";
  /**
   * Present when the target parsed as a modifier combo (e.g. "Control+C"),
   * normalized to Playwright's key names. When absent, `target` is typed
   * character by character.
   */
  shortcut?: string;
}

export interface ScrollAction extends ActionBase {
  command: "scroll up" | "scroll down";
  amountPx: number;
}

export interface DragAction extends ActionBase {
  command: "drag";
  dx: number;
  dy: number;
}

/** A deliberate hold: nothing happens, and the page stays exactly as it is. */
export interface WaitAction extends ActionBase {
  command: "wait";
  durationMs: number;
}

export type ActionSegment =
  | ElementAction
  | TypeAction
  | ScrollAction
  | DragAction
  | WaitAction;
export type Segment = NarrationSegment | ActionSegment;

export function isAction(segment: Segment): segment is ActionSegment {
  return segment.kind === "action";
}

export function isNarration(segment: Segment): segment is NarrationSegment {
  return segment.kind === "narration";
}

export interface ScriptErrorDetail {
  line: number;
  message: string;
}

/**
 * Carries every parse error found in one pass, so the author sees all of them
 * at load time rather than fixing one per run (spec §6).
 */
export class ScriptError extends Error {
  constructor(
    readonly scriptPath: string,
    readonly details: readonly ScriptErrorDetail[],
  ) {
    const body = details.map((d) => `  line ${d.line}: ${d.message}`).join("\n");
    super(`${details.length} error(s) in ${scriptPath}:\n${body}`);
    this.name = "ScriptError";
  }
}
