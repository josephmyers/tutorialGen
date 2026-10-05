import { readFile } from "node:fs/promises";
import { PHRASES, RECORD_KEYWORD, type CommandSpec, type TargetKind } from "./vocabulary.js";
import {
  ScriptError,
  isNarration,
  isRecord,
  type ActionSegment,
  type LoadedScript,
  type ParsedScript,
  type ScriptMetadata,
  type Segment,
  type ScriptErrorDetail,
} from "./types.js";
import { toPositiveInt } from "../util/num.js";
import { DEFAULT_VOICE } from "../tts/engine.js";

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

const RECORD_PHRASE = RECORD_KEYWORD.toLowerCase();

/**
 * Read a script file and resolve everything a run needs from it. The URL lives
 * in the script's own metadata line, so a missing one is a load-time error here
 * — before any TTS or browser work starts.
 */
export async function loadScript(scriptPath: string): Promise<LoadedScript> {
  const source = await readFile(scriptPath, "utf8");
  const { metadata, segments } = parseScript(source, scriptPath);
  if (metadata.url === undefined) {
    throw new ScriptError(scriptPath, [
      {
        line: 1,
        message:
          "missing --url: the first line of a script must set the target page, " +
          'e.g. `--url http://localhost:3000`',
      },
    ]);
  }

  if (metadata.voice) console.log(`Running with voice ${metadata.voice}...`);

  const recordIndex = segments.findIndex(isRecord);
  const segmentsToRun = segments.filter(
    (segment, index) => !(isNarration(segment) && index < recordIndex),
  );
  const skippedNarrationCount = segments.length - segmentsToRun.length;
  if (skippedNarrationCount > 0) {
    console.log(`Skipping ${skippedNarrationCount} narration line(s) before #${RECORD_KEYWORD}.`);
  }

  return { url: metadata.url, voice: metadata.voice ?? DEFAULT_VOICE, segments: segmentsToRun };
}

/**
 * Split a script into its metadata and its ordered segments. Every problem found
 * is collected and thrown together as one ScriptError, so the author sees the
 * whole list at load time instead of one error per run (spec §6).
 *
 * Metadata is optional at this level: `loadScript` is what requires a URL, which
 * keeps this function a pure syntax check over any fragment of a script.
 */
export function parseScript(source: string, scriptPath = "<script>"): ParsedScript {
  const segments: Segment[] = [];
  const errors: ScriptErrorDetail[] = [];
  let metadata: Partial<ScriptMetadata> = {};
  let seenContent = false;
  let recordLine: number | undefined;

  source.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const text = raw.trim();
    if (text.length === 0) return;

    // Only the first non-blank line can be metadata; anywhere else a leading
    // `--` is ordinary narration.
    if (!seenContent && text.startsWith("--")) {
      seenContent = true;
      metadata = parseMetadataLine(text, line, errors);
      return;
    }
    seenContent = true;

    if (!text.startsWith("#")) {
      segments.push({ kind: "narration", line, text });
      return;
    }

    const body = text.slice(1).trim();

    // #Record takes no target, so anything after the keyword is ignored.
    if (startsWithWord(body, RECORD_PHRASE)) {
      if (recordLine === undefined) {
        recordLine = line;
        segments.push({ kind: "record", line });
      } else {
        errors.push({
          line,
          message: `#${RECORD_KEYWORD} appears more than once (first on line ${recordLine})`,
        });
      }
      return;
    }

    const action = parseActionLine(body, line);
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
  return { metadata, segments };
}

/** Metadata keys, with the field each one fills. */
const METADATA_KEYS = new Map<string, keyof ScriptMetadata>([
  ["--url", "url"],
  ["--voice", "voice"],
]);

/** `localhost:8888` is a natural thing to write, but page.goto needs a scheme. */
function normalizeUrl(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`;
}

/**
 * Read the leading flag line into metadata, appending a detail to `errors` for
 * every problem on the line rather than stopping at the first.
 */
function parseMetadataLine(
  text: string,
  line: number,
  errors: ScriptErrorDetail[],
): Partial<ScriptMetadata> {
  const metadata: Partial<ScriptMetadata> = {};
  const fail = (message: string) => errors.push({ line, message });
  // Values may be quoted, so that a setting containing spaces stays one token.
  const tokens = text.match(/"[^"]*"|\S+/g) ?? [];

  for (let i = 0; i < tokens.length; i += 1) {
    const key = tokens[i] ?? "";
    const field = METADATA_KEYS.get(key.toLowerCase());
    if (!field) {
      fail(`unknown setting "${key}" (known: ${[...METADATA_KEYS.keys()].join(", ")})`);
      continue;
    }

    const raw = tokens[i + 1];
    if (raw === undefined || METADATA_KEYS.has(raw.toLowerCase())) {
      fail(`${key} needs a value`);
      continue;
    }
    i += 1;

    if (metadata[field] !== undefined) {
      fail(`${key} is set more than once`);
      continue;
    }
    const value = raw.startsWith('"') ? raw.slice(1, -1) : raw;
    if (value.length === 0) {
      fail(`${key} needs a value`);
      continue;
    }
    metadata[field] = field === "url" ? normalizeUrl(value) : value;
  }

  return metadata;
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
 * "click".
 */
function matchPhrase(body: string): PhraseMatch | null {
  for (const { phrase, spec } of PHRASES) {
    if (startsWithWord(body, phrase)) {
      return { spec, rest: body.slice(phrase.length).trim() };
    }
  }
  return null;
}

/**
 * True when `text` begins with the lowercase `word` as a whole word.
 */
function startsWithWord(text: string, word: string): boolean {
  if (!text.toLowerCase().startsWith(word)) return false;
  const nextChar = text.charAt(word.length);
  return nextChar === "" || /[\s"]/.test(nextChar);
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
