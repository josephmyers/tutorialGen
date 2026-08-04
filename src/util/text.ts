/**
 * Collapse whitespace and shorten to `max` characters for an error message.
 * One rule, so the resolver's candidate list and the TTS failure message can
 * never disagree about how a snippet of text is shown.
 */
export function truncate(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}
