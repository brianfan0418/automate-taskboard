import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const launcherSource = await readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
const prepareSource = await readFile(new URL("../scripts/prepare-tauri-app.mjs", import.meta.url), "utf8");
const tauriConfig = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const releaseWorkflow = await readFile(new URL("../.github/workflows/release-macos.yml", import.meta.url), "utf8");
const checkWorkflow = await readFile(new URL("../.github/workflows/check.yml", import.meta.url), "utf8");

test("the launcher keeps CDP random and prefers the Taskboard port with a fallback", () => {
  assert.match(launcherSource, /libc::flock/);
  assert.match(launcherSource, /lifecycle: Mutex/);
  assert.match(launcherSource, /generation: AtomicU64/);
  assert.match(
    launcherSource,
    /fn loopback_listener\(\)[\s\S]*?TcpListener::bind\(\("127\.0\.0\.1", 0\)\)/,
  );
  assert.match(launcherSource, /const TASKBOARD_PREFERRED_PORT: u16 = 47833;/);
  assert.match(
    launcherSource,
    /fn taskboard_loopback_listener\(\)[\s\S]*?TcpListener::bind\(\("127\.0\.0\.1", TASKBOARD_PREFERRED_PORT\)\)[\s\S]*?\.or_else\(\|_\| TcpListener::bind\(\("127\.0\.0\.1", 0\)\)\)/,
  );
  assert.equal(
    launcherSource.match(
      /fn taskboard_listener\([^)]*\)[\s\S]*?taskboard_loopback_listener\(\)\?/g,
    )?.length,
    2,
  );
  assert.match(launcherSource, /codex_port: Mutex<Option<u16>>/);
  assert.match(
    launcherSource,
    /fn codex_port\([\s\S]*?let listener = loopback_listener\(\)\?;/,
  );
  assert.match(
    launcherSource,
    /#\[cfg\(any\(target_os = "macos", target_os = "windows"\)\)\]\s+command\.args\(\["--launch", "--watch", "--port", &codex_port\]\);/,
  );
  assert.match(
    launcherSource,
    /#\[cfg\(target_os = "linux"\)\]\s+command\.args\(\["--launch", "--watch", "--cdp-pipe"\]\);/,
  );
  // Amendment 12: the launcher never auto-opens the Codex side panel; the board window is the default surface.
  assert.doesNotMatch(launcherSource, /"--open"/);
  assert.doesNotMatch(launcherSource, /const LAUNCHER_PORT/);
});

test("Amendment 14: starting the launcher never launches or restarts the Codex App", async () => {
  const injectorSource = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
  // Launcher: manual start, login start, Dock reopen and the board window use start_launcher (attach only);
  // crash recovery and update fallbacks attach only; only 「重新開啟 Codex」 (restart_launcher) relaunches.
  assert.match(launcherSource, /command\.args\(injector_codex_args\(codex_start\)\);/);
  assert.match(launcherSource, /CodexStart::AttachOnly => &\["--launch-on-request"\]/);
  assert.match(launcherSource, /CodexStart::Relaunch => &\[\]/);
  assert.match(launcherSource, /fn start_launcher\([\s\S]*?start_launcher_locked\(app, state, CodexStart::AttachOnly\)\s*\}/);
  assert.match(launcherSource, /fn restart_launcher\([\s\S]*?start_launcher_locked\(app, state, CodexStart::Relaunch\);/);
  assert.equal(launcherSource.match(/CodexStart::Relaunch\)/g)?.length, 2, "restart_launcher and the Rust unit test");
  assert.match(launcherSource, /start_launcher_locked\(&event_app, &event_state, CodexStart::AttachOnly\)/);
  assert.equal(launcherSource.match(/start_launcher_locked\(app, state, CodexStart::AttachOnly\)\.err\(\)/g)?.length, 2);
  // The 「需要重新啟動 Codex」 question and the Codex quit exist only on the relaunch path; canceling keeps the service.
  const relaunchBlock = launcherSource.match(/if codex_start == CodexStart::Relaunch \{([\s\S]*?)\n    \}\n/);
  assert.ok(relaunchBlock);
  assert.match(relaunchBlock[1], /ordinary_codex_process/);
  assert.match(relaunchBlock[1], /需要重新啟動 Codex 才能顯示任務面板/);
  assert.match(relaunchBlock[1], /quit_codex_normally\(codex_pid\)\?/);
  assert.match(relaunchBlock[1], /codex_start = CodexStart::AttachOnly;/);
  assert.equal(launcherSource.match(/quit_codex_normally\(codex_pid\)/g)?.length, 1);
  assert.equal(launcherSource.match(/需要重新啟動 Codex 才能顯示任務面板/g)?.length, 1);
  assert.doesNotMatch(launcherSource, /任務面板未注入/);
  assert.match(launcherSource, /LauncherEvent::CodexNotAttached => \{\s*snapshot\.phase = "running"\.into\(\);\s*snapshot\.message = CODEX_NOT_ATTACHED_MESSAGE\.into\(\);/);
  assert.match(launcherSource, /沒有自動開啟 Codex；需要 Codex 側欄時請從選單「在 Codex 開啟任務面板」。/);

  // Injector: --launch-on-request attaches to a Codex that already has a reachable CDP renderer and
  // otherwise starts Codex only for an explicit open request (tray 「在 Codex 開啟任務面板」).
  assert.match(injectorSource, /else if \(arg === "--launch-on-request"\) options\.launchOnRequest = true;/);
  const startManaged = injectorSource.match(/const startManagedCodex = async \(allowLaunch = true\) => \{([\s\S]*?)\n  \};/);
  assert.ok(startManaged);
  const attachIndex = startManaged[1].indexOf("reusedCodexPid");
  const gateIndex = startManaged[1].indexOf("if (!allowLaunch) return false;");
  assert.ok(attachIndex > 0 && gateIndex > attachIndex, "attach to a debuggable Codex before the launch gate");
  assert.ok(gateIndex < startManaged[1].indexOf("importCodexBrowserProfile"));
  assert.ok(gateIndex < startManaged[1].indexOf("launchCodexWithLaunchServices"));
  assert.ok(gateIndex < startManaged[1].indexOf("launchCodexWithPipe"));
  assert.match(
    injectorSource,
    /const allowLaunch = !options\.launchOnRequest \|\| hasOpenPending\(\);\s*idleAfterNormalExit = !\(await startManagedCodex\(allowLaunch\)\) && !nativeCodexBrowser;/,
  );
  assert.match(injectorSource, /if \(!hasOpenPending\(\)\) continue;\s*const launchRequestGeneration = openRequestGeneration;\s*try \{\s*if \(!\(await startManagedCodex\(\)\)\)/);
  assert.match(injectorSource, /else if \(options\.launchOnRequest && \(idleAfterNormalExit \|\| nativeCodexBrowser\)\) \{\s*emitLauncherEvent\("codexNotAttached"\);/);
});

test("the packaged injector includes its Windows Store activation module", () => {
  assert.match(prepareSource, /"windows-codex\.mjs"/);
});

test("release signing is tag-only and PR CI builds the real unsigned app bundle", () => {
  assert.doesNotMatch(releaseWorkflow, /workflow_dispatch/);
  assert.match(releaseWorkflow, /git merge-base --is-ancestor/);
  assert.match(releaseWorkflow, /package\.json/);
  assert.match(releaseWorkflow, /Cargo\.toml/);
  assert.match(releaseWorkflow, /tauri\.conf\.json/);
  assert.match(releaseWorkflow, /TAG_FORCED/);
  assert.match(releaseWorkflow, /sign-macos-app\.mjs/);
  assert.match(releaseWorkflow, /notarytool submit/);
  assert.match(releaseWorkflow, /stapler validate/);
  assert.match(checkWorkflow, /tauri -- build/);
  assert.match(checkWorkflow, /--bundles app/);
  assert.match(checkWorkflow, /--no-sign/);
});

test("Windows CI runs the Node suite and the Windows launcher updates from the shared folder", () => {
  assert.match(
    checkWorkflow,
    /windows-launcher:[\s\S]*?run: npm test[\s\S]*?run: npm run app:build:windows/,
  );
  // Amendment 11: signed shared-folder updates replace the old Windows early return.
  assert.doesNotMatch(launcherSource, /Windows 版本暫不支援自動更新/);
  assert.match(
    launcherSource,
    /cfg!\(target_os = "windows"\)[\s\S]*?offer_shared_folder_update\(app, state, check_update, quit, show_current_version\)/,
  );
  assert.match(launcherSource, /const SHARED_UPDATE_FIRST_CHECK_DELAY: Duration = Duration::from_secs\(30\);/);
  assert.match(
    launcherSource,
    /#\[cfg\(target_os = "windows"\)\]\s+const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs\(6 \* 60 \* 60\);/,
  );
  assert.match(launcherSource, /有新版本 \{version\}（目前 \{shown_current\}）。要現在更新嗎？/);
  assert.match(launcherSource, /\.args\(\["\/P", "\/R", "\/UPDATE"\]\)/);
  assert.match(launcherSource, /app"\)\.join\("scripts"\)\.join\("update-check\.mjs"\)/);
  assert.match(prepareSource, /"update-check\.mjs"/);
  assert.match(prepareSource, /update-source\.json/);
});

test("Windows CI uploads the NSIS installer with the pinned Node 24 artifact action", () => {
  assert.match(
    checkWorkflow,
    /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/,
  );
  assert.doesNotMatch(checkWorkflow, /actions\/upload-artifact@[^\s]+ # v4/);
});

test("the launcher minimum system version matches the current Codex client requirement", () => {
  assert.equal(tauriConfig.bundle.macOS.minimumSystemVersion, "14.0");
});
