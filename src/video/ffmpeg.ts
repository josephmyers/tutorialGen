import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import ffprobeStatic from "ffprobe-static";

/**
 * ffmpeg-static is CommonJS and sets `module.exports` to the path string itself,
 * but ships a declaration written as `export default`. Under NodeNext that
 * declares a `.default` property the package does not have, so the idiomatic
 * import is typed as something it never is at runtime. Requiring it is how the
 * module is actually built to be loaded.
 */
const cjs = createRequire(import.meta.url);
const ffmpegStatic: string | null = cjs("ffmpeg-static");

function requireBin(p: string | null | undefined, pkg: string): string {
  if (!p) {
    throw new Error(`${pkg} did not resolve a binary path for this platform.`);
  }
  return p;
}

const ffmpegPath = requireBin(ffmpegStatic, "ffmpeg-static");
const ffprobePath = requireBin(ffprobeStatic.path, "ffprobe-static");

/** Only the tail of stderr is retained — enough to explain a failure, bounded
 * regardless of how long the encode runs. */
const STDERR_TAIL_CHARS = 8192;

/**
 * Spawn a bundled binary with an argument array — never a shell string, so
 * filter_complex graphs and C:\ paths survive without cmd.exe mangling.
 * Resolves with stdout; stderr is kept only to build the failure message.
 */
function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = "";
    let stderrTail = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-STDERR_TAIL_CHARS);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${bin} exited with code ${code}\n${stderrTail.trim()}`));
      }
    });
  });
}

export const ffmpeg = (args: string[]): Promise<string> => run(ffmpegPath, args);
export const ffprobe = (args: string[]): Promise<string> => run(ffprobePath, args);
