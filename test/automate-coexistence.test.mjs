import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { DEFAULT_API_URL } from "../cli/taskctl.mjs";
import {
  isForeignProfileCodex,
} from "../scripts/codex-profile-ownership.mjs";
import { applyAutomateTaskboardEnvAliases } from "../shared/automate-env.mjs";
import { withoutTaskboardLauncherEnvironment } from "../shared/codex-environment.mjs";
import { buildTaskboardAutomationName } from "../shared/taskboard-automation.mjs";

const root = new URL("../", import.meta.url);
const read = (relative) => readFile(new URL(relative, root), "utf8");

// Identity of the Dashi Taskboard ("Codex Taskboard") that must keep working on the same machine.
// Values come from upstream chuspeeism/dashi-taskboard c346e8e.
const DASHI = Object.freeze({
  productName: "Codex Taskboard",
  version: "1.1.23",
  identifier: "com.chuspeeism.codex-taskboard",
  cargoPackage: "codex-taskboard-launcher",
  npmPackage: "codex-taskboard",
  dataDirectoryName: "Codex Taskboard",
  serverPort: 47823,
  devCdpPort: 9231,
  injectorDefaultCdpPort: 9229,
  skillName: "manage-taskboard",
  automationName: "Taskboard 自动认领 · local",
  domPrefix: "codex-taskboard-",
  sentinel: "__codexTaskboardInjection__",
  hostBinding: "__codexTaskboardHostV1",
  healthProduct: "codex-taskboard",
  challengeHeader: "x-codex-taskboard-challenge",
  userscript: "codex-taskboard.user.js",
  macosTaskctlLink: "/opt/homebrew/bin/taskctl",
  updaterRepository: "chuspeeism/dashi-taskboard",
});

const AUTOMATE = Object.freeze({
  productName: "AutoMate Taskboard",
  version: "2.0.4",
  identifier: "io.github.automate-taskboard",
  cargoPackage: "automate-taskboard-launcher",
  npmPackage: "automate-taskboard",
  dataDirectoryName: "AutoMate Taskboard",
  serverPort: 47833,
  devCdpPort: 9241,
  injectorDefaultCdpPort: 9239,
  skillName: "manage-automate-taskboard",
  automationName: "AutoMate Taskboard 自动认领 · local",
  domPrefix: "automate-taskboard-",
  sentinel: "__automateTaskboardInjection__",
  hostBinding: "__automateTaskboardHostV1",
  healthProduct: "automate-taskboard",
  challengeHeader: "x-automate-taskboard-challenge",
  userscript: "automate-taskboard.user.js",
  macosTaskctlLink: "/opt/homebrew/bin/automate-taskctl",
});

function assertDistinct(actual, dashiValue, label) {
  assert.notEqual(actual, dashiValue, `${label} must differ from Dashi Taskboard`);
}

test("identity constants differ from Dashi Taskboard in every place Windows keys an install", async () => {
  const tauri = JSON.parse(await read("src-tauri/tauri.conf.json"));
  const tauriWindows = JSON.parse(await read("src-tauri/tauri.windows.conf.json"));
  const cargo = await read("src-tauri/Cargo.toml");
  const packageJson = JSON.parse(await read("package.json"));
  const packageLock = JSON.parse(await read("package-lock.json"));
  const cargoName = cargo.match(/^\[package\][\s\S]*?^name = "([^"]+)"/m)?.[1];
  const cargoVersion = cargo.match(/^\[package\][\s\S]*?^version = "([^"]+)"/m)?.[1];

  // productName keys the NSIS install dir, uninstall registry key, Start menu shortcut, and the
  // HKCU Run autostart value; identifier keys the WebView/app data dirs; the Cargo package is the
  // main binary the NSIS installer looks for (and closes) before installing.
  assert.equal(tauri.productName, AUTOMATE.productName);
  assert.equal(tauri.identifier, AUTOMATE.identifier);
  assert.equal(tauri.version, AUTOMATE.version);
  assert.equal(cargoName, AUTOMATE.cargoPackage);
  assert.equal(cargoVersion, AUTOMATE.version);
  assert.equal(packageJson.name, AUTOMATE.npmPackage);
  assert.equal(packageJson.version, AUTOMATE.version);
  assert.equal(packageLock.name, AUTOMATE.npmPackage);
  assert.equal(packageLock.version, AUTOMATE.version);
  assertDistinct(tauri.productName, DASHI.productName, "productName");
  assertDistinct(tauri.identifier, DASHI.identifier, "identifier");
  assertDistinct(cargoName, DASHI.cargoPackage, "Cargo package / main binary");
  assertDistinct(packageJson.name, DASHI.npmPackage, "npm package");
  assert.equal(tauriWindows.productName, undefined, "Windows config must not override productName");
  assert.equal(tauriWindows.identifier, undefined, "Windows config must not override identifier");
  for (const endpoint of tauri.plugins.updater.endpoints) {
    assert.equal(endpoint.includes(DASHI.updaterRepository), false, "updater must not install Dashi releases");
  }
});

test("launcher data, logs, port, skill, and taskctl locations are AutoMate-owned", async () => {
  const launcher = await read("src-tauri/src/main.rs");
  const prepare = await read("scripts/prepare-tauri-app.mjs");
  const app = await read("server/app.mjs");

  assert.match(launcher, new RegExp(`const TASKBOARD_PREFERRED_PORT: u16 = ${AUTOMATE.serverPort};`));
  assertDistinct(AUTOMATE.serverPort, DASHI.serverPort, "preferred Taskboard port");
  assert.match(app, new RegExp(`CODEX_TASKBOARD_PORT \\?\\? "${AUTOMATE.serverPort}"`));
  assert.equal(DEFAULT_API_URL, `http://127.0.0.1:${AUTOMATE.serverPort}`);

  assert.match(launcher, /\.ok_or_else\(\|\| std::io::Error::other\("APPDATA is unavailable"\)\)\?\s*\.join\("AutoMate Taskboard"\);/);
  assert.match(launcher, /\.join\("AutoMate Taskboard\/Logs"\);/);
  assert.doesNotMatch(launcher, /\.join\("Codex Taskboard/);
  assert.doesNotMatch(launcher, /\.tooltip\("Codex Taskboard"\)/);
  assert.match(launcher, /\.tooltip\("AutoMate Taskboard"\)/);
  assert.match(prepare, /CODEX_TASKBOARD_DATA_DIR=%APPDATA%\\\\AutoMate Taskboard/);
  assert.doesNotMatch(prepare, /Codex Taskboard/);

  assert.match(launcher, new RegExp(`\\.agents/skills/${AUTOMATE.skillName}"`));
  assert.match(launcher, new RegExp(`app/skills/${AUTOMATE.skillName}"`));
  assert.match(launcher, new RegExp(`\\.codex/skills/${AUTOMATE.skillName}"`));
  assert.doesNotMatch(launcher, /skills\/manage-taskboard"/);
  assert.equal(existsSync(new URL(`skills/${AUTOMATE.skillName}/SKILL.md`, root)), true);
  assert.equal(existsSync(new URL(`skills/${DASHI.skillName}`, root)), false);
  const skill = await read(`skills/${AUTOMATE.skillName}/SKILL.md`);
  assert.match(skill, new RegExp(`^---\\nname: ${AUTOMATE.skillName}\\n`));

  assert.match(launcher, new RegExp(`PathBuf::from\\("${AUTOMATE.macosTaskctlLink}"\\)`));
  assert.doesNotMatch(launcher, new RegExp(`PathBuf::from\\("${DASHI.macosTaskctlLink}"\\)`));
});

test("Codex embedding identifiers cannot collide with Dashi's injection", async () => {
  const userscript = await read(`inject/${AUTOMATE.userscript}`);
  const injector = await read("scripts/codex-injector.mjs");
  const packageJson = JSON.parse(await read("package.json"));
  const app = await read("server/app.mjs");

  assert.equal(existsSync(new URL(`inject/${DASHI.userscript}`, root)), false);
  for (const constant of ["ENTRY_ID", "PAGE_ID", "FRAME_ID", "STATUS_ID", "STYLE_ID"]) {
    const value = userscript.match(new RegExp(`const ${constant} = "([^"]+)"`))?.[1];
    assert.ok(value?.startsWith(AUTOMATE.domPrefix), `${constant} uses the AutoMate prefix`);
    assert.equal(value.startsWith(DASHI.domPrefix), false);
  }
  assert.match(userscript, new RegExp(`const SENTINEL_KEY = "${AUTOMATE.sentinel}"`));
  assert.doesNotMatch(userscript, new RegExp(DASHI.sentinel));
  assert.doesNotMatch(userscript, /codex-taskboard|__codexTaskboard|__CODEX_TASKBOARD_/);
  assert.match(injector, new RegExp(`const hostBindingName = "${AUTOMATE.hostBinding}"`));
  assert.doesNotMatch(injector, /__codexTaskboard|__CODEX_TASKBOARD_|x-codex-taskboard-/);
  assert.match(injector, new RegExp(`body\\.product === "${AUTOMATE.healthProduct}"`));
  assert.match(app, new RegExp(`product: "${AUTOMATE.healthProduct}"`));
  assert.match(app, new RegExp(AUTOMATE.challengeHeader));
  assert.doesNotMatch(app, new RegExp(DASHI.challengeHeader));

  assert.match(injector, new RegExp(`const defaultCodexDebuggingPort = ${AUTOMATE.injectorDefaultCdpPort};`));
  assertDistinct(AUTOMATE.injectorDefaultCdpPort, DASHI.injectorDefaultCdpPort, "injector default CDP port");
  assert.match(packageJson.scripts.codex, new RegExp(`--port ${AUTOMATE.devCdpPort}$`));
  assertDistinct(AUTOMATE.devCdpPort, DASHI.devCdpPort, "npm run codex CDP port");

  const automationName = buildTaskboardAutomationName({ taskboardProjectId: "local" });
  assert.equal(automationName, AUTOMATE.automationName);
  assertDistinct(automationName, DASHI.automationName, "Codex automation name");
});

test("a Codex started by another taskboard launcher is foreign and never reused", async () => {
  const injector = await read("scripts/codex-injector.mjs");
  const prepare = await read("scripts/prepare-tauri-app.mjs");
  assert.match(
    injector,
    /const runningCodex = codexAppProcesses\(options\.appPath\)\.filter\(\(record\) => \(\s*!launcherOwnsCodexProfile\s*\|\| !isForeignProfileCodex\(record\.command, independentCodexProfilePath\)/,
  );
  assert.match(prepare, /"codex-profile-ownership\.mjs",/);

  const codexExe = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_1.0.0.0_x64__abc\app\Codex.exe`;
  const ownProfile = String.raw`C:\Users\alice\AppData\Roaming\AutoMate Taskboard\codex-profile`;
  const dashiProfile = String.raw`C:\Users\alice\AppData\Roaming\Codex Taskboard\codex-profile`;
  const windowsCommand = (profile) => `"${codexExe}" --user-data-dir="${profile}" --remote-debugging-address=127.0.0.1 --remote-debugging-port=51234`;

  assert.equal(isForeignProfileCodex(windowsCommand(dashiProfile), ownProfile, "win32"), true);
  assert.equal(isForeignProfileCodex(windowsCommand(ownProfile), ownProfile, "win32"), false);
  assert.equal(isForeignProfileCodex(`"${codexExe}"`, ownProfile, "win32"), false);
  assert.equal(isForeignProfileCodex(windowsCommand(dashiProfile), "", "win32"), false);

  const macExe = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
  const macOwn = "/Users/alice/Library/Application Support/AutoMate Taskboard/codex-profile";
  const macDashi = "/Users/alice/Library/Application Support/Codex Taskboard/codex-profile";
  assert.equal(isForeignProfileCodex(`${macExe} --user-data-dir=${macDashi} --remote-debugging-port=51234`, macOwn, "darwin"), true);
  assert.equal(isForeignProfileCodex(`${macExe} --user-data-dir=${macOwn} --remote-debugging-port=51234`, macOwn, "darwin"), false);
  assert.equal(isForeignProfileCodex(`${macExe} --user-data-dir=${macOwn}`, macOwn, "darwin"), false);
});

test("AUTOMATE_TASKBOARD_* aliases fill unset CODEX_TASKBOARD_* values and never reach Codex", () => {
  const environment = {
    AUTOMATE_TASKBOARD_URL: "http://127.0.0.1:50000",
    AUTOMATE_TASKBOARD_PORT: "50001",
    CODEX_TASKBOARD_PORT: "47833",
    PATH: "/usr/bin",
  };
  applyAutomateTaskboardEnvAliases(environment);
  assert.equal(environment.CODEX_TASKBOARD_URL, "http://127.0.0.1:50000");
  assert.equal(environment.CODEX_TASKBOARD_PORT, "47833", "launcher-provided values win");
  assert.deepEqual(withoutTaskboardLauncherEnvironment(environment), { PATH: "/usr/bin" });
});
