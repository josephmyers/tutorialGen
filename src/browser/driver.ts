import { chromium, type Browser } from "playwright";

export interface LaunchOptions {
  /** Debug only — the recording is identical either way (spec §5). */
  headed?: boolean;
}

export function launchBrowser(opts: LaunchOptions = {}): Promise<Browser> {
  return chromium.launch({ headless: !opts.headed });
}
