// Amendment 14 (2.0.2, product owner: 「三個黑視窗跳出來」): the packaged launcher is a GUI process and
// starts the board service without a console, so every console program the service starts gets
// its own visible console window unless the spawn hides it. This test statically scans the
// runtime sources that ship in the app and requires `windowsHide: true` on every child_process
// call, and CREATE_NO_WINDOW on every Windows `StdCommand` in the Rust launcher.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHILD_PROCESS_FUNCTIONS = new Set([
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
]);

// Calls that may lack windowsHide, each with the reason. `file` + `snippet` (text inside the call)
// identify the call; a stale entry fails the test.
const ALLOWLIST = [
  {
    file: "scripts/codex-injector.mjs",
    snippet: "\"explorer.exe\"",
    reason: "explorer.exe is a GUI-subsystem program (never gets a console); it only hands a codex:// or file URL to the shell, and SW_HIDE must not reach the opened window.",
  },
  {
    file: "scripts/codex-injector.mjs",
    snippet: "spawn(executable, args, {",
    reason: "launchCodexWithPipe starts the Codex GUI app itself (Linux --cdp-pipe path); hiding it would hide the Codex window.",
  },
  {
    file: "server/mobile/tailnet.mjs",
    snippet: "execFile(file, args, options,",
    reason: "runExecFile forwards the caller's options; every runExecFile call is checked below to pass windowsHide: true.",
    forwardedBy: "runExecFile",
  },
];

async function listFiles(directory, extensions) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(relative, extensions)));
    else if (extensions.some((extension) => entry.name.endsWith(extension))) files.push(relative);
  }
  return files;
}

async function packagedScripts() {
  const prepare = await readFile(path.join(root, "scripts", "prepare-tauri-app.mjs"), "utf8");
  const list = prepare.match(/for \(const fileName of \[([\s\S]*?)\]\)/);
  assert.ok(list, "prepare-tauri-app.mjs lists the packaged scripts");
  const names = [...list[1].matchAll(/"([^"]+\.mjs)"/g)].map((match) => `scripts/${match[1]}`);
  assert.ok(names.includes("scripts/update-check.mjs"));
  assert.ok(names.includes("scripts/codex-injector.mjs"));
  return names;
}

async function runtimeSourceFiles() {
  return [
    ...(await listFiles("server", [".mjs", ".js", ".cjs"])),
    ...(await listFiles("shared", [".mjs", ".js", ".cjs"])),
    ...(await listFiles("inject", [".js", ".mjs"])),
    "cli/taskctl.mjs",
    ...(await packagedScripts()),
  ];
}

// Index just past the matching ")" for the "(" at `open`, skipping string and comment contents.
function closingParen(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\"" || character === "'" || character === "`") {
      index += 1;
      while (index < source.length && source[index] !== character) {
        if (source[index] === "\\") index += 1;
        index += 1;
      }
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index);
      if (index < 0) break;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new Error(`Unbalanced call at ${open}`);
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

export function childProcessCalls(source) {
  const names = new Set();
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/g)) {
    for (const part of match[1].split(",")) {
      const [imported, local] = part.trim().split(/\s+as\s+/);
      if (CHILD_PROCESS_FUNCTIONS.has(imported)) names.add((local ?? imported).trim());
    }
  }
  assert.doesNotMatch(
    source,
    /import\s+(?:\*\s+as\s+\w+|\w+)\s+from\s*["'](?:node:)?child_process["']|require\(["'](?:node:)?child_process["']\)/,
    "use named child_process imports so the scan can follow them",
  );
  if (names.size === 0) return [];
  // Follow aliases: `const execFileAsync = promisify(execFile)`, `run = spawnSync`,
  // `spawn: spawnImpl = nodeSpawn`, `const run = overrides.spawn ?? spawn`.
  let grew = true;
  while (grew) {
    grew = false;
    for (const match of source.matchAll(/([A-Za-z_$][\w$]*)\s*=(?![=>])\s*([^;\n]*)/g)) {
      const [, alias, rightSide] = match;
      if (names.has(alias)) continue;
      const value = rightSide.trim().replace(/[\s,;){]+$/, "");
      const references = [...names].some((name) => {
        const escaped = name.replace(/\$/g, "\\$");
        return new RegExp(
          `^(?:${escaped}|promisify\\(\\s*${escaped}|[\\w$.?]+\\s*(?:\\?\\?|\\|\\|)\\s*${escaped})$`,
        ).test(value);
      });
      if (references) {
        names.add(alias);
        grew = true;
      }
    }
  }
  const calls = [];
  for (const name of names) {
    const pattern = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*\\(`, "g");
    for (const match of source.matchAll(pattern)) {
      const before = source.slice(Math.max(0, match.index - 20), match.index);
      if (/function\s+$/.test(before)) continue;
      const open = source.indexOf("(", match.index);
      const text = source.slice(match.index, closingParen(source, open));
      calls.push({ name, text, line: lineOf(source, match.index) });
    }
  }
  return calls;
}

function hidesWindow(call) {
  if (/windowsHide\s*:\s*true/.test(call.text)) return true;
  // A literal POSIX absolute executable (/bin/ps, /usr/bin/open, …) never runs on Windows.
  return /^[\w$]+\s*\(\s*["']\/(?:bin|usr|sbin|opt)\//.test(call.text);
}

test("every child process started by the packaged runtime hides its console window on Windows", async () => {
  const unhidden = [];
  const usedAllowlist = new Set();
  let scanned = 0;
  for (const file of await runtimeSourceFiles()) {
    const source = await readFile(path.join(root, file), "utf8");
    for (const call of childProcessCalls(source)) {
      scanned += 1;
      if (hidesWindow(call)) continue;
      const allowed = ALLOWLIST.find((entry) => entry.file === file && call.text.includes(entry.snippet));
      if (allowed) {
        usedAllowlist.add(allowed);
        if (allowed.forwardedBy) {
          const forwarders = [...source.matchAll(new RegExp(`(?<![\\w$.])${allowed.forwardedBy}\\s*\\(`, "g"))]
            .filter((match) => !/function\s+$/.test(source.slice(Math.max(0, match.index - 20), match.index)));
          assert.ok(forwarders.length > 0, `${file}: ${allowed.forwardedBy} has callers`);
          for (const match of forwarders) {
            const text = source.slice(match.index, closingParen(source, source.indexOf("(", match.index)));
            assert.match(text, /windowsHide\s*:\s*true/, `${file}:${lineOf(source, match.index)} ${allowed.forwardedBy} must pass windowsHide: true`);
          }
        }
        continue;
      }
      unhidden.push(`${file}:${call.line} ${call.text.split("\n")[0]}`);
    }
  }
  assert.ok(scanned >= 20, `scanned ${scanned} child process calls`);
  assert.deepEqual(unhidden, [], "child process calls without windowsHide: true");
  for (const entry of ALLOWLIST) {
    assert.ok(usedAllowlist.has(entry), `stale allowlist entry ${entry.file} ${entry.snippet}`);
  }
});

test("the scan follows aliases and reports a missing windowsHide", () => {
  const source = [
    "import { execFile as run, spawn } from \"node:child_process\";",
    "const runAsync = promisify(run);",
    "function start(spawnImpl = spawn) {",
    "  return spawnImpl(\"git\", [], { windowsHide: true });",
    "}",
    "await runAsync(\"tailscale\", [\"status\"], { timeout: 1 });",
    "spawn(\"/usr/bin/open\", [\"x\"]);",
  ].join("\n");
  const calls = childProcessCalls(source);
  assert.deepEqual(calls.map((call) => [call.name, call.line, hidesWindow(call)]).sort(), [
    ["runAsync", 6, false],
    ["spawn", 7, true],
    ["spawnImpl", 4, true],
  ]);
});

test("every Windows StdCommand in the launcher is created without a console window", async () => {
  const launcher = await readFile(path.join(root, "src-tauri", "src", "main.rs"), "utf8");
  const helper = launcher.match(/fn windows_command\([^)]*\)\s*->\s*StdCommand\s*\{([\s\S]*?)\n\}/);
  assert.ok(helper, "main.rs defines windows_command");
  assert.match(helper[1], /creation_flags\(CREATE_NO_WINDOW\.0\)/);
  const offenders = [];
  for (const match of launcher.matchAll(/StdCommand::new\(([^)]*)\)/g)) {
    if (match.index > helper.index && match.index < helper.index + helper[0].length) continue;
    const argument = match[1].trim();
    // macOS / Linux only programs.
    if (/^"(?:\/|sh"|xdg-open")/.test(argument) || argument === "&destination_executable") continue;
    const lineStart = launcher.lastIndexOf("\n", match.index);
    const previousLine = launcher.slice(0, lineStart).trimEnd().split("\n").at(-1).trim();
    if (/^#\[cfg\(any\(target_os = "macos", target_os = "linux"\)\)\]$/.test(previousLine)) continue;
    offenders.push(`${lineOf(launcher, match.index)}: StdCommand::new(${argument})`);
  }
  assert.deepEqual(offenders, [], "Windows programs must be started through windows_command()");
  for (const program of ["powershell.exe", "taskkill.exe", "rundll32.exe"]) {
    assert.match(launcher, new RegExp(`windows_command\\("${program.replace(".", "\\.")}"\\)`));
  }
  assert.match(launcher, /windows_command\(&node_path\)/);
});
