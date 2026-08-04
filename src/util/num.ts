/**
 * A strictly positive integer, or null if the text is not one. The single
 * definition of "a valid positive whole number" — the CLI and the script parser
 * both check against this rather than spelling the test out again.
 */
export function toPositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Parse a CLI string as a strictly positive integer, or throw with a labelled message. */
export function parsePositiveInt(raw: string, label: string): number {
  const n = toPositiveInt(raw);
  if (n === null) {
    throw new Error(`${label} must be a positive integer (got "${raw}").`);
  }
  return n;
}
