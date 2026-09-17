import assert from "node:assert/strict";
import { test } from "node:test";

import { chromeExecutableCandidates, findChromeExecutable } from "./helpers/chrome.mjs";

const windowsEnv = {
  ProgramFiles: "C:\\Program Files",
  ProgramW6432: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\reviewer\\AppData\\Local",
};

test("Windows lookup covers Program Files, Program Files (x86) and LOCALAPPDATA installs", () => {
  assert.deepEqual(chromeExecutableCandidates(windowsEnv, "win32"), [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Chromium\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe",
    "C:\\Users\\reviewer\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Users\\reviewer\\AppData\\Local\\Chromium\\Application\\chrome.exe",
  ]);

  const perUser = "C:\\Users\\reviewer\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
  assert.equal(
    findChromeExecutable({ env: windowsEnv, platform: "win32", exists: (file) => file === perUser }),
    perUser,
  );
  assert.equal(findChromeExecutable({ env: windowsEnv, platform: "win32", exists: () => false }), null);
});

test("CHROME_PATH and CHROME_BIN override standard locations only when the file exists", () => {
  const standard = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const env = { ...windowsEnv, CHROME_PATH: "D:\\chrome\\chrome.exe", CHROME_BIN: "E:\\chromium\\chrome.exe" };

  assert.equal(findChromeExecutable({ env, platform: "win32", exists: () => true }), "D:\\chrome\\chrome.exe");
  assert.equal(
    findChromeExecutable({ env, platform: "win32", exists: (file) => file !== "D:\\chrome\\chrome.exe" }),
    "E:\\chromium\\chrome.exe",
  );
  assert.equal(
    findChromeExecutable({ env, platform: "win32", exists: (file) => file === standard }),
    standard,
  );
});

test("macOS and Linux lookups keep their standard locations and never fall back to Edge", () => {
  const candidates = chromeExecutableCandidates({}, "linux");
  assert.ok(candidates.includes("/usr/bin/google-chrome"));
  assert.ok(candidates.includes("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
  const everywhere = [...candidates, ...chromeExecutableCandidates(windowsEnv, "win32")];
  assert.equal(everywhere.some((candidate) => /edge/i.test(candidate)), false);
});
