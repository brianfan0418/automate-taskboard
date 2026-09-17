// Amendment 14 (2.0.2): the NSIS installer / uninstaller stops the launcher and AutoMate Taskboard's own
// leftover processes (install directory / codex-runtime) before it copies or deletes files, and fails
// cleanly when a file it replaces is still in use.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const windowsDirectory = fileURLToPath(new URL("../src-tauri/windows/", import.meta.url));
const hooksPath = path.join(windowsDirectory, "installer-hooks.nsh");
const stopScriptPath = path.join(windowsDirectory, "stop-app-processes.ps1");
const hooksBytes = await readFile(hooksPath);
const hooks = hooksBytes.toString("utf8").replace(/^\uFEFF/, "");
const stopScript = await readFile(stopScriptPath);
const onWindows = process.platform === "win32";
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const ping = path.join(systemRoot, "System32", "PING.EXE");
const makensis = path.join(process.env.LOCALAPPDATA ?? "", "tauri", "NSIS", "makensis.exe");
const nsisAdditionalPlugins = path.join(process.env.LOCALAPPDATA ?? "", "tauri", "NSIS", "Plugins", "x86-unicode", "additional");
const STILL_RUNNING_MESSAGE = "AutoMate Taskboard 的背景程式仍在執行，無法更新檔案： node.exe\r\n\r\n請在系統匣的 AutoMate Taskboard 圖示按右鍵選「結束」，或重新開機後，再執行一次安裝程式。";

function macroBody(name) {
  const match = hooks.match(new RegExp(`!macro ${name}(?: [A-Z_]+)?\\r?\\n([\\s\\S]*?)\\r?\\n!macroend`));
  assert.ok(match, `${name} is defined`);
  return match[1];
}

test("install and uninstall stop our processes first, with a timeout, logging and a clean failure", () => {
  assert.deepEqual([...hooksBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "the hook is UTF-8 with BOM (it has Chinese text)");
  assert.ok([...stopScript].every((byte) => byte < 0x80), "stop-app-processes.ps1 stays ASCII");
  assert.match(macroBody("NSIS_HOOK_PREINSTALL"), /!insertmacro AUTOMATE_STOP_APP_PROCESSES/);
  assert.match(macroBody("NSIS_HOOK_PREUNINSTALL"), /!insertmacro AUTOMATE_STOP_APP_PROCESSES/);
  const body = macroBody("AUTOMATE_STOP_APP_PROCESSES");
  const launcherKill = body.indexOf("nsis_tauri_utils::KillProcessCurrentUser \"${MAINBINARYNAME}.exe\"");
  const scriptRun = body.indexOf("nsExec::ExecToStack /TIMEOUT=60000");
  const lockCheck = body.indexOf("AUTOMATE_CHECK_FILE_UNLOCKED \"node.exe\"");
  assert.ok(launcherKill > 0 && scriptRun > launcherKill && lockCheck > scriptRun);
  assert.match(body, /IfSilent automate_kill_launcher 0/);
  // $INSTDIR only counts when it holds our launcher.
  assert.match(body, /\$\{If\} \$\{FileExists\} "\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe"\s*StrCpy \$R7 "\$INSTDIR"/);
  assert.match(body, /SetEnvironmentVariable\(t "AUTOMATE_STOP_INSTDIR", t "\$R7"\)/);
  assert.match(body, /-WindowStyle Hidden -File "\$PLUGINSDIR\\automate-stop-app-processes\.ps1"/);
  assert.match(body, /\$WINDIR\\Sysnative\\WindowsPowerShell/);
  assert.match(body, /DetailPrint "AutoMate Taskboard: stop leftover processes, result \$R5"/);
  assert.match(body, /SetErrorLevel \$\{AUTOMATE_STOP_EXIT_CODE\}\s*IfSilent automate_stop_failed 0\s*\$\{If\} \$PassiveMode != 1\s*MessageBox MB_ICONSTOP\|MB_OK "\$\{AUTOMATE_STILL_RUNNING_MESSAGE\}"/);
  assert.doesNotMatch(body, /(?<!nsExec::)\bExec(?:Wait)?\s|Get-CimInstance/, "no plain Exec / ExecWait, no WMI");
  assert.doesNotMatch(stopScript.toString("utf8"), /Get-CimInstance|Get-WmiObject/);
});

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "automate-installer-stop-"));
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.all(children.map((child) => waitForExit(child, 5_000)));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    async program(file) {
      await mkdir(path.dirname(file), { recursive: true });
      await copyFile(ping, file);
      return file;
    },
    async run(file) {
      await this.program(file);
      const child = spawn(file, ["-n", "120", "127.0.0.1"], { stdio: "ignore", windowsHide: true });
      children.push(child);
      return child;
    },
    settle: () => new Promise((resolve) => setTimeout(resolve, 700)),
  };
}

function runStopScript(env) {
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return spawnSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", stopScriptPath],
    { encoding: "utf8", windowsHide: true, timeout: 90_000, env: { ...process.env, ...env } },
  );
}

test("the stop script ends only our executables, also under a Chinese path", { skip: !onWindows && "Windows only" }, async (t) => {
  const f = await fixture(t);
  const installDirectory = path.join(f.root, "中文 使用者", "AutoMate Taskboard");
  const runtimeRoot = path.join(f.root, "中文 使用者", "Roaming", "AutoMate Taskboard", "codex-runtime");
  await f.program(path.join(installDirectory, "automate-taskboard-launcher.exe"));
  const node = await f.run(path.join(installDirectory, "node.exe"));
  const conpty = await f.run(path.join(installDirectory, "bin", "ConPtyAttachSend.exe"));
  const chrome = await f.run(path.join(installDirectory, "chrome.exe"));
  const siblingNode = await f.run(path.join(f.root, "中文 使用者", "AutoMate Taskboard2", "node.exe"));
  const codex = await f.run(path.join(runtimeRoot, "codex.exe"));
  const helper = await f.run(path.join(runtimeRoot, "codex-command-runner.exe"));
  const runtimeOther = await f.run(path.join(runtimeRoot, "python.exe"));
  await f.settle();
  const result = runStopScript({
    AUTOMATE_STOP_INSTDIR: installDirectory,
    AUTOMATE_STOP_RUNTIME: runtimeRoot,
    AUTOMATE_STOP_SELF: path.join(installDirectory, "uninstall.exe"),
    AUTOMATE_STOP_LAUNCHER: "automate-taskboard-launcher.exe",
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  for (const [name, child] of Object.entries({ node, conpty, codex, helper })) {
    assert.equal(await waitForExit(child, 5_000), true, `${name} stopped`);
  }
  assert.equal(chrome.exitCode, null, "an unrelated exe in the install directory keeps running");
  assert.equal(siblingNode.exitCode, null, "a similarly named directory is untouched");
  assert.equal(runtimeOther.exitCode, null, "an unrelated exe in codex-runtime keeps running");
  assert.match(result.stdout, /stopping \d+ .*node\.exe/);
});

test("without an install directory the stop script leaves node.exe alone", { skip: !onWindows && "Windows only" }, async (t) => {
  const f = await fixture(t);
  const folder = path.join(f.root, "Program Files");
  const node = await f.run(path.join(folder, "node.exe"));
  await f.settle();
  const result = runStopScript({
    AUTOMATE_STOP_INSTDIR: "",
    AUTOMATE_STOP_RUNTIME: path.join(f.root, "none", "codex-runtime"),
    AUTOMATE_STOP_SELF: "",
    AUTOMATE_STOP_LAUNCHER: "automate-taskboard-launcher.exe",
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  await f.settle();
  assert.equal(node.exitCode, null);
});

// Compiles a tiny silent NSIS program that inserts the real hook (launcher name and product name changed
// so no real AutoMate Taskboard process is ever matched) and runs it against temporary directories.
async function buildHarness(directory, { powershellName } = {}) {
  const harness = path.join(directory, "harness.nsi");
  const output = path.join(directory, "hook-harness.exe");
  const lines = [
    "Unicode true",
    `!addplugindir "${nsisAdditionalPlugins}"`,
    "!include LogicLib.nsh",
    "!include x64.nsh",
    "!include FileFunc.nsh",
    '!define MAINBINARYNAME "automate-hooktest-launcher"',
    '!define PRODUCTNAME "AutoMate Hooktest"',
    '!define INSTALLMODE "currentUser"',
    ...(powershellName ? [`!define AUTOMATE_STOP_POWERSHELL_NAME "${powershellName}"`] : []),
    "Name HookHarness",
    `OutFile "${output}"`,
    "RequestExecutionLevel user",
    "SilentInstall silent",
    "Var PassiveMode",
    "Var UpdateMode",
    "Var NoShortcutMode",
    'LoadLanguageFile "${NSISDIR}\\Contrib\\Language files\\English.nlf"',
    'LangString appRunning ${LANG_ENGLISH} "{{product_name}} is running"',
    'LangString appRunningOkKill ${LANG_ENGLISH} "{{product_name}} is running, OK to kill"',
    `!include "${hooksPath}"`,
    "Section",
    "  ReadEnvStr $INSTDIR HOOKTEST_INSTDIR",
    '  StrCpy $R3 " node.exe"',
    '  FileOpen $0 "$EXEDIR\\message.txt" w',
    '  FileWriteUTF16LE /BOM $0 "${AUTOMATE_STILL_RUNNING_MESSAGE}"',
    "  FileClose $0",
    "  !insertmacro NSIS_HOOK_PREINSTALL",
    '  FileOpen $0 "$EXEDIR\\passed.txt" w',
    "  FileClose $0",
    "SectionEnd",
  ];
  await writeFile(harness, `\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
  const compiled = spawnSync(makensis, ["-V2", harness], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
  assert.equal(compiled.status, 0, `${compiled.stdout}${compiled.stderr}`);
  return output;
}

function runHarness(harness, env) {
  return spawnSync(harness, [], { windowsHide: true, timeout: 120_000, env: { ...process.env, ...env } });
}

const harnessSkip = (!onWindows && "Windows only") || (!existsSync(makensis) && "Tauri's NSIS (makensis) is not installed");

test("NSIS hook: stops our leftovers, skips a folder without our launcher, and aborts with code 5 when a file stays locked", {
  skip: harnessSkip,
  timeout: 300_000,
}, async (t) => {
  const f = await fixture(t);
  const buildDirectory = path.join(f.root, "build ok");
  const failingDirectory = path.join(f.root, "build failing");
  await mkdir(buildDirectory, { recursive: true });
  await mkdir(failingDirectory, { recursive: true });
  const harness = await buildHarness(buildDirectory);
  const failingHarness = await buildHarness(failingDirectory, { powershellName: "missing-powershell.exe" });
  const appData = path.join(f.root, "中文 AppData");

  // 1. Our install directory: node.exe and codex-runtime codex.exe stop, chrome.exe keeps running.
  const installDirectory = path.join(f.root, "中文 安裝", "AutoMate Hooktest");
  await f.program(path.join(installDirectory, "automate-hooktest-launcher.exe"));
  const node = await f.run(path.join(installDirectory, "node.exe"));
  const chrome = await f.run(path.join(installDirectory, "chrome.exe"));
  const codex = await f.run(path.join(appData, "AutoMate Hooktest", "codex-runtime", "codex.exe"));
  await f.settle();
  const passed = runHarness(harness, { HOOKTEST_INSTDIR: installDirectory, APPDATA: appData });
  assert.equal(passed.status, 0);
  assert.ok(existsSync(path.join(buildDirectory, "passed.txt")), "the install continued");
  assert.equal(await waitForExit(node, 5_000), true, "node.exe stopped");
  assert.equal(await waitForExit(codex, 5_000), true, "codex.exe stopped");
  assert.equal(chrome.exitCode, null, "chrome.exe in the same folder keeps running");
  const message = (await readFile(path.join(buildDirectory, "message.txt"))).toString("utf16le").replace(/^\uFEFF/, "");
  assert.equal(message, STILL_RUNNING_MESSAGE, "the Chinese message survives makensis");

  // 2. A folder that does not hold our launcher (e.g. a mistyped C:\Program Files): nothing is stopped.
  const foreignDirectory = path.join(f.root, "Program Files");
  const foreignNode = await f.run(path.join(foreignDirectory, "node.exe"));
  await rm(path.join(buildDirectory, "passed.txt"));
  await f.settle();
  const foreign = runHarness(harness, { HOOKTEST_INSTDIR: foreignDirectory, APPDATA: appData });
  assert.equal(foreign.status, 0);
  assert.ok(existsSync(path.join(buildDirectory, "passed.txt")));
  await f.settle();
  assert.equal(foreignNode.exitCode, null);

  // 3. PowerShell unavailable and node.exe still running from our install: silent abort, exit code 5.
  const lockedNode = await f.run(path.join(installDirectory, "node.exe"));
  await f.settle();
  const started = Date.now();
  const failed = runHarness(failingHarness, { HOOKTEST_INSTDIR: installDirectory, APPDATA: appData });
  assert.equal(failed.status, 5);
  assert.ok(Date.now() - started < 60_000);
  assert.equal(existsSync(path.join(failingDirectory, "passed.txt")), false, "the install stopped before copying");
  assert.equal(lockedNode.exitCode, null);
});
