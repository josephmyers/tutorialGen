/**
 * Types for the one piece of playwright-core's private API we reach into.
 *
 * `getComparator` is the image differ behind `toHaveScreenshot`, and there is no
 * public export of it. playwright-core 1.62 ships as a bundle: `lib/utils` does
 * not exist on disk, and the package's `exports` map admits only a handful of
 * subpaths, of which `./lib/coreBundle` is the one that re-exports the comparator
 * (under `utils`). The bundle carries no declarations, hence this file.
 *
 * Private API: not covered by semver. The dependency is pinned to an exact
 * version in package.json so a patch bump cannot silently move it, and these
 * types are hand-transcribed from `packages/utils/comparators.ts` in that build
 * — if the pin moves, re-check them against the new bundle.
 */
declare module "playwright-core/lib/coreBundle" {
  interface ImageComparatorOptions {
    /** Defaults to "pixelmatch". */
    comparator?: "pixelmatch" | "ssim-cie94";
    /** Per-pixel colour tolerance, 0-1. pixelmatch only; defaults to 0.2. */
    threshold?: number;
    /** Differing pixels tolerated before the images count as different. */
    maxDiffPixels?: number;
    /** Same, as a fraction of the total pixel count. Combined with
     *  `maxDiffPixels` by taking the stricter of the two. */
    maxDiffPixelRatio?: number;
  }

  /** `null` means the images matched. */
  interface ComparatorResult {
    errorMessage: string;
    /** A PNG marking up what differed. Absent when the compare threw early. */
    diff?: Buffer;
  }

  type ImageComparator = (
    actual: Buffer,
    expected: Buffer,
    options?: ImageComparatorOptions,
  ) => ComparatorResult | null;

  const utils: {
    getComparator(mimeType: "image/png" | "image/jpeg" | "image/webp"): ImageComparator;
  };
}
