import { readFile } from "node:fs/promises";
import { PHRASES, type CommandSpec, type TargetKind } from "./vocabulary.js";
import {
  ScriptError,
  type ActionSegment,
  type Segment,
  type ScriptErrorDetail,
} from "./types.js";
import { toPositiveInt } from "../util/num.js";

/** Modifier spellings accepted in a shortcut, normalized to Playwright's names. */
const MODIFIERS = new Map<string, string>([
  ["ctrl", "Control"],
  ["control", "Control"],
  ["alt", "Alt"],
  ["option", "Alt"],
  ["shift", "Shift"],
  ["meta", "Meta"],
  ["cmd", "Meta"],
  ["command", "Meta"],
]);

/** Named keys Playwright accepts, beyond single printable characters. */
const NAMED_KEYS = [
  "Enter", "Escape", "Tab", "Backspace", "Delete", "Insert",
  "Home", "End", "PageUp", "PageDown", "Space",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
];
const KEYS_BY_LOWER = new Map(NAMED_KEYS.map((k) => [k.toLowerCase(), k]));

export async function loadScript(scriptPath: string): Promise<Segment[]> {
  const source = await readFile(scriptPath, "utf8");
  return parseScript(source, scriptPath);
}

/**
 * Split a script into ordered segments. Every problem found is collected and
 * thrown together as one ScriptError, so the author sees the whole list at load
 * time instead of one error per run (spec §6).
 */
export function parseScript(source: string, scriptPath = "<script>"): Segment[] {
  const segments: Segment[] = [];
  const errors: ScriptErrorDetail[] = [];

  source.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const text = raw.trim();
    if (text.length === 0) return;

    if (!text.startsWith("#")) {
      segments.push({ kind: "narration", line, text });
      return;
    }

    const action = parseActionLine(text.slice(1).trim(), line);
    if (typeof action === "string") {
      errors.push({ line, message: action });
    } else {
      segments.push(action);
    }
  });

  if (errors.length > 0) {
    throw new ScriptError(scriptPath, errors);
  }
  if (segments.length === 0) {
    throw new Error(`Script contains no narration or action lines: ${scriptPath}`);
  }
  return segments;
}

/** Returns the parsed action, or an error message describing what went wrong. */
function parseActionLine(body: string, line: number): ActionSegment | string {
  const matched = matchPhrase(body);
  if (!matched) {
    const verb = body.split(/\s+/)[0] ?? "";
    return `unknown command "${verb}" (see \`tutorialgen --help\` for the command list)`;
  }
  const { spec, rest } = matched;

  const argument = extractArgument(rest, spec.targetKind);
  if (typeof argument === "string") {
    return `${spec.command}: ${argument}`;
  }
  return buildAction(spec, argument.value, line);
}

interface PhraseMatch {
  spec: CommandSpec;
  rest: string;
}

/**
 * Match the leading verb phrase, longest first so "double click" wins over
 * "click". The phrase must end at a word boundary, so "typewriter" is not read
 * as the `type` command.
 */
function matchPhrase(body: string): PhraseMatch | null {
  const lower = body.toLowerCase();
  for (const { phrase, spec } of PHRASES) {
    if (!lower.startsWith(phrase)) continue;
    const next = body.charAt(phrase.length);
    if (next !== "" && !/[\s"]/.test(next)) continue;
    return { spec, rest: body.slice(phrase.length).trim() };
  }
  return null;
}

/**
 * Pull the command's argument out of the text after the verb. Quoted text wins
 * anywhere on the line (everything after it is an author comment, spec §3);
 * amounts may also be written bare.
 */
function extractArgument(rest: string, kind: TargetKind): { value: string } | string {
  const quoted = rest.match(/"([^"]*)"/);
  if (quoted) {
    return { value: quoted[1] ?? "" };
  }
  if (kind === "amount" || kind === "offset") {
    const bare = rest.split(/\s+/)[0];
    if (bare) return { value: bare };
  }
  return "missing quoted target";
}

function buildAction(spec: CommandSpec, value: string, line: number): ActionSegment | string {
  switch (spec.command) {
    case "click":
    case "doubleclick":
    case "hover":
    case "scroll to": {
      if (value.length === 0) return `${spec.command}: target is empty`;
      return { kind: "action", line, command: spec.command, target: value };
    }

    case "type": {
      if (value.length === 0) return `${spec.command}: target is empty`;
      const parsed = parseShortcut(value);
      switch (parsed.kind) {
        case "error":
          return `type: ${parsed.message}`;
        case "literal":
          return { kind: "action", line, command: "type", target: value };
        case "shortcut":
          return { kind: "action", line, command: "type", target: value, shortcut: parsed.shortcut };
      }
    }

    case "scroll up":
    case "scroll down": {
      const amountPx = toPositiveInt(value);
      if (amountPx === null) {
        return `${spec.command}: amount must be a positive whole number of pixels (got "${value}")`;
      }
      return { kind: "action", line, command: spec.command, target: value, amountPx };
    }

    case "drag": {
      const parts = value.split(",");
      const dx = Number(parts[0]);
      const dy = Number(parts[1]);
      if (parts.length !== 2 || !Number.isInteger(dx) || !Number.isInteger(dy)) {
        return `drag: amount must be two whole numbers as "dx,dy" (got "${value}")`;
      }
      return { kind: "action", line, command: "drag", target: value, dx, dy };
    }

    case "wait": {
      const durationMs = toPositiveInt(value);
      if (durationMs === null) {
        return `wait: duration must be a positive whole number of milliseconds (got "${value}")`;
      }
      return { kind: "action", line, command: "wait", target: value, durationMs };
    }
  }
}

type ShortcutResult =
  | { kind: "literal" }
  | { kind: "shortcut"; shortcut: string }
  | { kind: "error"; message: string };

/**
 * Read a target as a modifier combo. Text that is not shortcut-shaped is
 * "literal" (typed character by character); text that looks like a shortcut but
 * names a key Playwright would reject becomes a load-time error rather than a
 * run-time surprise.
 */
function parseShortcut(target: string): ShortcutResult {
  const parts = target.split("+");
  if (parts.length < 2) return { kind: "literal" };

  const modifiers: string[] = [];
  for (const part of parts.slice(0, -1)) {
    const normalized = MODIFIERS.get(part.trim().toLowerCase());
    if (!normalized) return { kind: "literal" }; // Plain text like "1+1".
    modifiers.push(normalized);
  }

  const rawKey = (parts[parts.length - 1] ?? "").trim();
  const key = rawKey.length === 1 ? rawKey : KEYS_BY_LOWER.get(rawKey.toLowerCase());
  if (!key) {
    return { kind: "error", message: `unknown key "${rawKey}" in shortcut "${target}"` };
  }
  return { kind: "shortcut", shortcut: [...modifiers, key].join("+") };
}
