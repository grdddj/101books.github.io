// The browser tests silently skipped on this machine because Chromium only
// exists inside Playwright's cache, and a skipped alignment test is how a
// board-rendering regression reached production. Fall back to Playwright's own
// download before giving up.
import { access } from "node:fs/promises";
import { createRequire } from "node:module";

function playwrightChromium() {
  for (const base of [import.meta.url, `file://${process.env.HOME}/package.json`]) {
    try {
      return createRequire(base)("playwright").chromium.executablePath();
    } catch {
      // Fall through to the next resolution root.
    }
  }
  return null;
}

export async function findChromium() {
  for (const candidate of [
    process.env.CHROMIUM_BINARY,
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
    playwrightChromium(),
  ]) {
    if (!candidate) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue looking for a supported local Chromium binary.
    }
  }
  return null;
}
