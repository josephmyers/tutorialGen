/** Default Edge neural voice. Lives here so the CLI can name it in `--help`
 * without importing (and loading) a concrete engine implementation. */
export const DEFAULT_VOICE = "en-US-AriaNeural";

/**
 * Silence held after each narration clip, on top of its measured length. Covers
 * the mp3 duration estimate's under-read so consecutive clips cannot overlap,
 * and gives the viewer a beat between sentences.
 */
export const NARRATION_PAD_MS = 100;

export interface TtsClip {
  /** Absolute path to the synthesized audio clip. */
  clipPath: string;
  /** Measured clip length in seconds. */
  durationSec: number;
  /**
   * How long Pass 2 must hold the take for this clip: its measured length plus
   * NARRATION_PAD_MS. Applied here rather than by each caller so the overlap
   * guarantee cannot be lost by forgetting to add the pad.
   */
  holdMs: number;
}

/**
 * Swappable narration backend. `msedge-tts` is the default implementation, but
 * the interface keeps the pipeline independent of it (it is an unofficial API).
 */
export interface TtsEngine {
  synthesize(text: string): Promise<TtsClip>;
  close(): Promise<void>;
}
