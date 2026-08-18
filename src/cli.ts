#!/usr/bin/env node
/**
 * tutorialgen CLI. Parses and validates the full argument surface, then hands
 * resolved configs to the pipeline.
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
import { parsePositiveInt } from "./util/num.js";
import { evenDimension } from "./video/format.js";

interface RawOptions {
  width: string;
  height: string;
  actionTimeout: string;
  jobs?: string;
  waitForInitialLoad: boolean;
  keepTemp?: boolean;
  headed?: boolean;
}

/** Output: the script file with its extension swapped for .mp4. */
function outPath(scriptPath: string): string {
  const { dir, name } = path.parse(scriptPath);
  return path.join(dir, `${name}.mp4`);
}

async function resolveConfig(scriptPath: string, opts: RawOptions): Promise<PipelineConfig> {
  const resolvedScript = path.resolve(scriptPath);
  try {
    await access(resolvedScript);
  } catch {
    throw new Error(`Script file not found: ${resolvedScript}`);
  }

  const out = outPath(resolvedScript);
  if (out === resolvedScript) {
    throw new Error(`Output would overwrite the script file: ${out}`);
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
    out,
    width,
    height,
    actionTimeoutMs: parsePositiveInt(opts.actionTimeout, "--action-timeout"),
    waitForInitialLoad: opts.waitForInitialLoad,
    keepTemp: Boolean(opts.keepTemp),
    headed: Boolean(opts.headed),
  };
}

function makeLog(prefix: string): (message: string) => void {
  return (message) => {
    process.stderr.write(prefix ? `[${prefix}] ${message}\n` : `${message}\n`);
  };
}

/** Runs `task` over every item, at most `limit` in flight at once. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("tutorialgen")
    .description("Generate narrated tutorial videos from script files.")
    .argument("<scripts...>", "paths to tutorial script files (output: same path as .mp4)")
    .option("--width <px>", "viewport width", "1280")
    .option("--height <px>", "viewport height", "720")
    .option("--action-timeout <ms>", "per-action timeout in ms", "15000")
    .option("--jobs <n>", "max scripts processed concurrently (default: all at once)")
    .option(
      "--no-wait-for-initial-load",
      "start recording as soon as the page load event fires, without waiting for it to settle",
    )
    .option("--keep-temp", "keep temp artifacts (take.webm, clips, timeline.json)")
    .option("--headed", "run with a visible browser window (debug only)")
    .addHelpText("after", `\n${scriptHelp()}`)
    .action(async (scriptPaths: string[], opts: RawOptions) => {
      const configs = await Promise.all(scriptPaths.map((s) => resolveConfig(s, opts)));
      const jobsLimit = opts.jobs ? parsePositiveInt(opts.jobs, "--jobs") : configs.length;

      // Deferred so `--help` and argument errors never load the TTS/ffmpeg stack.
      const { runPipeline } = await import("./engine/pipeline.js");

      const failures = await mapWithLimit(configs, jobsLimit, async (config) => {
        const prefix = configs.length > 1 ? path.parse(config.scriptPath).name : "";
        try {
          await runPipeline(config, makeLog(prefix));
          return undefined;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      });

      if (configs.length > 1) {
        process.stderr.write("\n");
        for (const [config, failure] of configs.map((c, i) => [c, failures[i]] as const)) {
          const name = path.parse(config.scriptPath).name;
          process.stderr.write(failure ? `${name}: FAILED: ${failure}\n` : `${name}: ok\n`);
        }
      } else if (failures[0]) {
        process.stderr.write(`\ntutorialgen: ${failures[0]}\n`);
      }
      if (failures.some(Boolean)) {
        process.exitCode = 1;
      }
    });

  await program.parseAsync();
}

main().catch((err: unknown) => {
  process.stderr.write(`\ntutorialgen: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
