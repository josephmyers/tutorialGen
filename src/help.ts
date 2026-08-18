import { COMMANDS } from "./parser/vocabulary.js";
import { DEFAULT_VOICE } from "./tts/engine.js";

/** The §3 example, verbatim — enough to see the shape of a script. */
const EXAMPLE = `--url http://localhost:3000/login --voice ${DEFAULT_VOICE}
#Click "login" to expand the sign-in form
Hello, and welcome to the training video. Today we'll show you how to log in.
#Click "username"
#Type "user1234"
#Click "password"
#Enter "test1234"
Here, you can see we've entered our username and password. Now, let's log in.
#Select "Sign In"`;

/**
 * Built-in script-format help (spec §10): enough to write a valid script, no
 * more. The command table is generated from the vocabulary, so adding a synonym
 * updates the help automatically.
 */
export function scriptHelp(): string {
  return [
    "SCRIPT FORMAT",
    "",
    "  A plain-text file with two kinds of line. Line order is execution order.",
    "",
    "    #Click \"Sign In\"     action line  — performed in the browser",
    "    Welcome to the demo.  narration line — spoken aloud",
    "",
    "  Each action line is exactly one command and one quoted target. Any text",
    "  after the quoted target is an author comment and is ignored.",
    "",
    "SCRIPT METADATA",
    "",
    "  The first line is the metadata, written as flags:",
    "",
    "    --url http://localhost:3000 --voice en-GB-SoniaNeural",
    "",
    "    --url    target page URL (required; a bare host gets http:// added)",
    `    --voice  optional Edge voice ShortName (default: ${DEFAULT_VOICE})`,
    "",
    "  For accepted voice values, see https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts#text-to-speech-voices.",
    "",
    "COMMANDS",
    "",
    commandTable(),
    "",
    notes(),
    "",
    "EXAMPLE",
    "",
    EXAMPLE.split("\n").map((l) => `  ${l}`).join("\n"),
  ].join("\n");
}

function commandTable(): string {
  const rows = COMMANDS.map((spec) => ({
    command: spec.command,
    synonyms: spec.synonyms.join(", ") || "—",
    target: spec.targetHelp,
  }));

  const width = (pick: (r: (typeof rows)[number]) => string, heading: string): number =>
    Math.max(heading.length, ...rows.map((r) => pick(r).length));

  const wCommand = width((r) => r.command, "Command");
  const wSynonyms = width((r) => r.synonyms, "Also written as");

  const line = (a: string, b: string, c: string): string =>
    `  ${a.padEnd(wCommand)}  ${b.padEnd(wSynonyms)}  ${c}`;

  return [
    line("Command", "Also written as", "Target"),
    line("-".repeat(wCommand), "-".repeat(wSynonyms), "------"),
    ...rows.map((r) => line(r.command, r.synonyms, r.target)),
  ].join("\n");
}

function notes(): string {
  const noted = COMMANDS.filter((spec) => spec.note !== undefined);
  return ["NOTES", "", ...noted.map((spec) => `  ${spec.command}: ${spec.note}`)].join("\n");
}
