#!/usr/bin/env node
/**
 * tutorialgen CLI. Parses and validates the full argument surface, then hands a
 * resolved config to the pipeline.
 *
 * Imports stay dependency-light on purpose: nothing here should pull in the TTS
 * or ffmpeg stack, so `--help` and argument errors cost nothing. The pipeline
 * modules are loaded inside runPipeline.
 */
import { access } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import type { PipelineConfig } from "./engine/pipeline.js";
import { scriptHelp } from "./help.js";
import { DEFAULT_VOICE } from "./tts/engine.js";
import { parsePositiveInt } from "./util/num.js";
import { evenDimension } from "./video/format.js";

interface RawOptions {
  url: string;
  out?: string;
  voice: string;
  width: string;
  height: string;
  actionTimeout: string;
  keepTemp?: boolean;
  headed?: boolean;
}

/** Default output: the script file with its extension swapped for .mp4. */
function defaultOutPath(scriptPath: string): string {
  const { dir, name } = path.parse(scriptPath);
  return path.join(dir, `${name}.mp4`);
}

/** `localhost:8888` is a natural thing to type, but page.goto needs a scheme. */
function normalizeUrl(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`;
}

async function resolveConfig(scriptPath: string, opts: RawOptions): Promise<PipelineConfig> {
  const resolvedScript = path.resolve(scriptPath);
  try {
    await access(resolvedScript);
  } catch {
    throw new Error(`Script file not found: ${resolvedScript}`);
  }

  const out = opts.out ? path.resolve(opts.out) : defaultOutPath(resolvedScript);
  if (out === resolvedScript) {
    throw new Error(`--out would overwrite the script file: ${out}`);
  }

  const rawWidth = parsePositiveInt(opts.width, "--width");
  const rawHeight = parsePositiveInt(opts.height, "--height");
  const width = evenDimension(rawWidth);
  const height = evenDimension(rawHeight);
  if (width !== rawWidth || height !== rawHeight) {
    process.stderr.write(
      `Note: viewport rounded up to even ${width}x${height} for yuv420p.\n`,
    );
  }

  return {
    scriptPath: resolvedScript,
    url: normalizeUrl(opts.url),
    out,
    voice: opts.voice,
    width,
    height,
    actionTimeoutMs: parsePositiveInt(opts.actionTimeout, "--action-timeout"),
    keepTemp: Boolean(opts.keepTemp),
    headed: Boolean(opts.headed),
  };
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("tutorialgen")
    .description("Generate a narrated tutorial video from a script file.")
    .argument("<script>", "path to the tutorial script file")
    .requiredOption("--url <url>", "target page URL")
    .option("--out <file>", "output mp4 path (default: the script file, as .mp4)")
    .option("--voice <name>", "Edge neural voice ShortName", DEFAULT_VOICE)
    .option("--width <px>", "viewport width", "1280")
    .option("--height <px>", "viewport height", "720")
    .option("--action-timeout <ms>", "per-action timeout in ms", "15000")
    .option("--keep-temp", "keep temp artifacts (take.webm, clips, timeline.json)")
    .option("--headed", "run with a visible browser window (debug only)")
    .addHelpText("after", `\n${scriptHelp()}`)
    .action(async (scriptPath: string, opts: RawOptions) => {
      const config = await resolveConfig(scriptPath, opts);
      // Deferred so `--help` and argument errors never load the TTS/ffmpeg stack.
      const { runPipeline } = await import("./engine/pipeline.js");
      await runPipeline(config, log);
    });

  await program.parseAsync();
}

main().catch((err: unknown) => {
  process.stderr.write(`\ntutorialgen: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
