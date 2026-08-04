import { describe, expect, it } from "vitest";
import { parseScript } from "../src/parser/parser.js";
import { ScriptError } from "../src/parser/types.js";
import { COMMANDS } from "../src/parser/vocabulary.js";

/** Parse a script expected to be valid. */
function parse(source: string) {
  return parseScript(source, "test.txt");
}

/** Parse a script expected to fail, returning the collected error details. */
function parseErrors(source: string) {
  try {
    parseScript(source, "test.txt");
  } catch (err) {
    if (err instanceof ScriptError) return err.details;
    throw err;
  }
  throw new Error("expected a ScriptError, but parsing succeeded");
}

describe("line classification", () => {
  it("splits narration and action lines in order", () => {
    const segments = parse(['#Click "login"', "Welcome to the demo.", '#Type "user1234"'].join("\n"));

    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({ kind: "action", command: "click", target: "login", line: 1 });
    expect(segments[1]).toMatchObject({ kind: "narration", text: "Welcome to the demo.", line: 2 });
    expect(segments[2]).toMatchObject({ kind: "action", command: "type", line: 3 });
  });

  it("skips blank lines but keeps line numbers accurate", () => {
    const segments = parse('\n\n#Click "login"\n   \nNarration here.');

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ line: 3 });
    expect(segments[1]).toMatchObject({ line: 5 });
  });

  it("rejects a script with no segments", () => {
    expect(() => parse("\n   \n\n")).toThrow(/no narration or action lines/);
  });
});

describe("vocabulary", () => {
  // Every canonical name and every synonym must parse to its command.
  for (const spec of COMMANDS) {
    for (const phrase of [spec.command, ...spec.synonyms]) {
      it(`maps "${phrase}" to ${spec.command}`, () => {
        const argument = argumentFor(spec.targetKind);
        const [segment] = parse(`#${phrase} ${argument}`);
        expect(segment).toMatchObject({ kind: "action", command: spec.command });
      });
    }
  }

  it("matches verb phrases case-insensitively", () => {
    const segments = parse('#CLICK "a"\n#Select "b"\n#dOuBlE cLiCk "c"');
    expect(segments.map((s) => "command" in s && s.command)).toEqual([
      "click",
      "click",
      "doubleclick",
    ]);
  });

  it("prefers the longest matching phrase", () => {
    // "double click" must win over "click"; "scroll to" over nothing shorter.
    expect(parse('#double click "x"')[0]).toMatchObject({ command: "doubleclick" });
    expect(parse('#scroll to "x"')[0]).toMatchObject({ command: "scroll to" });
    expect(parse('#scroll up "100"')[0]).toMatchObject({ command: "scroll up" });
  });

  it("does not match a verb that is only a prefix of a longer word", () => {
    expect(parseErrors('#typewriter "x"')).toEqual([
      { line: 1, message: expect.stringContaining("unknown command") },
    ]);
  });
});

describe("targets", () => {
  it("takes the quoted text verbatim, including inner spaces and case", () => {
    expect(parse('#Click "Sign In"')[0]).toMatchObject({ target: "Sign In" });
  });

  it("ignores trailing text after the quoted target", () => {
    expect(parse('#Click "login" to expand the sign-in form')[0]).toMatchObject({
      command: "click",
      target: "login",
    });
  });

  it("reports a missing quoted target for element commands", () => {
    expect(parseErrors("#Click login")).toEqual([
      { line: 1, message: expect.stringContaining("missing quoted target") },
    ]);
  });

  it("rejects an empty target", () => {
    expect(parseErrors('#Click ""')).toEqual([
      { line: 1, message: expect.stringContaining("empty") },
    ]);
  });
});

describe("amounts", () => {
  it("parses a quoted pixel amount", () => {
    expect(parse('#scroll down "500"')[0]).toMatchObject({ command: "scroll down", amountPx: 500 });
  });

  it("tolerates an unquoted pixel amount", () => {
    expect(parse("#scroll up 250")[0]).toMatchObject({ command: "scroll up", amountPx: 250 });
  });

  it("rejects a non-numeric or non-positive amount", () => {
    expect(parseErrors('#scroll down "lots"')[0]?.message).toMatch(/positive whole number/);
    expect(parseErrors('#scroll down "0"')[0]?.message).toMatch(/positive whole number/);
    expect(parseErrors('#scroll down "12.5"')[0]?.message).toMatch(/positive whole number/);
  });

  it("parses a drag offset pair, including negatives", () => {
    expect(parse('#drag by "100,-50"')[0]).toMatchObject({ command: "drag", dx: 100, dy: -50 });
  });

  it("rejects a malformed drag offset", () => {
    expect(parseErrors('#drag by "100"')[0]?.message).toMatch(/dx,dy/);
    expect(parseErrors('#drag by "a,b"')[0]?.message).toMatch(/dx,dy/);
  });

  it("parses a wait duration, quoted or bare", () => {
    expect(parse('#Wait "2000"')[0]).toMatchObject({ command: "wait", durationMs: 2000 });
    expect(parse("#pause 500")[0]).toMatchObject({ command: "wait", durationMs: 500 });
  });

  it("rejects a non-numeric or non-positive wait duration", () => {
    expect(parseErrors('#wait "a while"')[0]?.message).toMatch(/positive whole number/);
    expect(parseErrors('#wait "0"')[0]?.message).toMatch(/positive whole number/);
    expect(parseErrors('#wait "1.5"')[0]?.message).toMatch(/positive whole number/);
  });
});

describe("type vs keyboard shortcut", () => {
  it("treats a modifier combo as a shortcut, normalized to Playwright key names", () => {
    expect(parse('#Type "Ctrl+C"')[0]).toMatchObject({ command: "type", shortcut: "Control+C" });
    expect(parse('#Type "cmd+shift+p"')[0]).toMatchObject({ shortcut: "Meta+Shift+p" });
  });

  it("accepts named keys in a shortcut", () => {
    expect(parse('#Type "Ctrl+Enter"')[0]).toMatchObject({ shortcut: "Control+Enter" });
    expect(parse('#Type "Alt+ArrowLeft"')[0]).toMatchObject({ shortcut: "Alt+ArrowLeft" });
  });

  it("treats text that merely contains + as literal text", () => {
    const segment = parse('#Type "1+1=2"')[0];
    expect(segment).toMatchObject({ command: "type", target: "1+1=2" });
    expect(segment && "shortcut" in segment && segment.shortcut).toBeFalsy();
  });

  it("rejects an unknown key at load time", () => {
    expect(parseErrors('#Type "Ctrl+Squiggle"')[0]?.message).toMatch(/unknown key/);
  });
});

describe("error collection", () => {
  it("reports every error in one pass, with line numbers", () => {
    const details = parseErrors(
      ['#Click "ok"', "#Frobnicate \"x\"", "Narration.", "#Click login", '#scroll down "nope"'].join("\n"),
    );

    expect(details.map((d) => d.line)).toEqual([2, 4, 5]);
  });
});

/** A syntactically valid argument for each kind of target. */
function argumentFor(kind: string): string {
  switch (kind) {
    case "amount":
      return '"100"';
    case "offset":
      return '"10,20"';
    default:
      return '"something"';
  }
}
