import { existsSync } from "node:fs";
import path from "node:path";

// Locates a Chrome or Chromium binary for the headless browser tests.
// CHROME_PATH / CHROME_BIN take precedence over the standard install locations when they point at an
// existing file. Chromium-based Edge is deliberately not a candidate: these tests target Chrome/Chromium.
export function chromeExecutableCandidates(env = process.env, platform = process.platform) {
  const candidates = [env.CHROME_PATH, env.CHROME_BIN];
  if (platform === "win32") {
    // Per-machine installs land in %ProgramFiles% (ProgramW6432 is the 64-bit root even from a
    // 32-bit process) or %ProgramFiles(x86)%; per-user installs land in %LOCALAPPDATA%.
    for (const root of [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"], env.LOCALAPPDATA]) {
      if (!root) continue;
      candidates.push(
        path.win32.join(root, "Google", "Chrome", "Application", "chrome.exe"),
        path.win32.join(root, "Chromium", "Application", "chrome.exe"),
      );
    }
  } else {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    );
  }
  return [...new Set(candidates.filter(Boolean))];
}

export function findChromeExecutable({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
} = {}) {
  return chromeExecutableCandidates(env, platform).find((candidate) => exists(candidate)) ?? null;
}
