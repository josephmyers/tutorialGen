/**
 * The closed command vocabulary (spec §7). This table is the single source of
 * truth: the parser matches against it and `help.ts` prints it, so the two can
 * never drift.
 */

export type Command =
  | "click"
  | "doubleclick"
  | "type"
  | "hover"
  | "scroll up"
  | "scroll down"
  | "scroll to"
  | "drag"
  | "wait";

/** What kind of argument a command takes — drives both parsing and help. */
export type TargetKind = "element" | "text" | "amount" | "offset";

export interface CommandSpec {
  command: Command;
  /** Extra phrases that normalize to this command (the canonical name is implicit). */
  synonyms: string[];
  targetKind: TargetKind;
  /** Human description of the target, for the help table. */
  targetHelp: string;
  note?: string;
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    command: "click",
    synonyms: ["select", "press", "tap"],
    targetKind: "element",
    targetHelp: "quoted element",
  },
  {
    command: "doubleclick",
    synonyms: ["double-click", "double click"],
    targetKind: "element",
    targetHelp: "quoted element",
  },
  {
    command: "type",
    synonyms: ["enter", "input", "write", "hit"],
    targetKind: "text",
    targetHelp: "quoted text",
    note: "Types into whichever field a preceding click focused. A target like \"Control+C\" is sent as a keyboard shortcut instead.",
  },
  {
    command: "hover",
    synonyms: ["mouse over", "move to", "point at"],
    targetKind: "element",
    targetHelp: "quoted element",
  },
  {
    command: "scroll up",
    synonyms: [],
    targetKind: "amount",
    targetHelp: "an amount in pixels",
  },
  {
    command: "scroll down",
    synonyms: [],
    targetKind: "amount",
    targetHelp: "an amount in pixels",
  },
  {
    command: "scroll to",
    synonyms: [],
    targetKind: "element",
    targetHelp: "quoted element",
  },
  {
    command: "drag",
    synonyms: ["drag by"],
    targetKind: "offset",
    targetHelp: "an amount as \"dx,dy\" in pixels",
    note: "Drags from the current pointer location. Use after a hover.",
  },
  {
    command: "wait",
    synonyms: ["pause"],
    targetKind: "amount",
    targetHelp: "a duration in milliseconds",
  },
];

export const RECORD_KEYWORD = "Record";

interface Phrase {
  phrase: string;
  spec: CommandSpec;
}

/**
 * Every verb phrase (canonical names plus synonyms), longest first. Order is
 * load-bearing: "double click" must be tried before "click", and "scroll up"
 * before any shorter phrase that prefixes it.
 */
export const PHRASES: readonly Phrase[] = COMMANDS.flatMap((spec) =>
  [spec.command, ...spec.synonyms].map((phrase) => ({ phrase, spec })),
).sort((a, b) => b.phrase.length - a.phrase.length);
