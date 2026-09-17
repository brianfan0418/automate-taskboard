import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ARGV_PROMPT_LIMIT,
  claudeLaunchToken,
  createClaudeBgProvider,
  pasteUnsafeReason,
  resolveClaudeExecutable,
  runProcess,
  sanitizeFollowupMessage,
  scrubClaudeEnv,
} from "../server/runs/claude-bg.mjs";
import {
  analyzeTranscript,
  findMessageSince,
  findNewHumanMessage,
  parseTranscriptLines,
  projectSlugForCwd,
} from "../server/runs/claude-transcript.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/v2-claude/", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

function fixture(name, replacements = {}) {
  let text = readFileSync(path.join(FIXTURES, name), "utf8");
  for (const [key, value] of Object.entries(replacements)) text = text.split(key).join(value);
  return text;
}

function jsonFixture(name, replacements = {}) {
  const value = JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
  const replace = (item) => {
    if (typeof item === "string") return Object.prototype.hasOwnProperty.call(replacements, item) ? replacements[item] : item;
    if (Array.isArray(item)) return item.map(replace);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, replace(inner)]));
    return item;
  };
  return replace(value);
}

function userLine(text) {
  return JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: text }, origin: { kind: "human" }, promptSource: "typed", uuid: `u-${Math.random()}` });
}

function queuedLine(text) {
  return JSON.stringify({ type: "attachment", isSidechain: false, attachment: { type: "queued_command", prompt: text, commandMode: "prompt", origin: { kind: "human" } }, uuid: `q-${Math.random()}` });
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function toolResultLine(toolUseId = "toolu_9") {
  return JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] }, toolUseResult: {}, uuid: `t-${Math.random()}` });
}

function assistantLine(text, stopReason = "end_turn") {
  return JSON.stringify({ type: "assistant", isSidechain: false, message: { role: "assistant", id: "msg_x", content: [{ type: "text", text }], stop_reason: stopReason }, uuid: `a-${Math.random()}` });
}

function fakeChild(run) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  Promise.resolve()
    .then(run)
    .then((result = {}) => {
      if (result.error) {
        child.emit("error", result.error);
        return;
      }
      if (result.stdout) child.stdout.emit("data", Buffer.from(result.stdout));
      if (result.stderr) child.stderr.emit("data", Buffer.from(result.stderr));
      child.emit("exit", result.code ?? 0, null);
      child.emit("close", result.code ?? 0, null);
    });
  return child;
}

async function createHarness(t, { options = {}, agents = [] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2-claude-bg-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "work");
  const promptDir = path.join(root, "prompts");
  const tempDir = path.join(root, "tmp");
  const exe = path.join(root, "bin", "claude.exe");
  const helper = path.join(root, "bin", "ConPtyAttachSend.exe");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(cwd, { recursive: true }), mkdir(path.dirname(exe), { recursive: true })]);
  await Promise.all([writeFile(exe, ""), writeFile(helper, "")]);

  const h = {
    root, home, cwd, promptDir, tempDir, exe, helper,
    agents: [...agents],
    calls: [],
    updates: [],
    logs: [],
    version: "2.1.271 (Claude Code)\n",
    nextShortId: 0xabc00001,
    bgStdoutWithId: true,
    helperCalls: [],
    helperResponder: null,
    transcriptPath(sessionId, sessionCwd = cwd) {
      return path.join(home, ".claude", "projects", projectSlugForCwd(sessionCwd), `${sessionId}.jsonl`);
    },
    async writeTranscript(sessionId, text, sessionCwd = cwd) {
      const filePath = h.transcriptPath(sessionId, sessionCwd);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, text, "utf8");
    },
    async appendTranscript(sessionId, ...lines) {
      await appendFile(h.transcriptPath(sessionId), `${lines.join("\n")}\n`, "utf8");
    },
    async writeState(shortId, sessionId) {
      const directory = path.join(home, ".claude", "jobs", shortId);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "state.json"), fixture("state.json", { __SESSION__: sessionId }), "utf8");
    },
    entry(shortId) {
      return h.agents.find((item) => item.id === shortId);
    },
    updatesFor(runId) {
      return h.updates.filter((item) => item.runId === runId).map((item) => item.update);
    },
  };

  const spawn = (file, args, spawnOptions) => {
    h.calls.push({ file, args: [...args], options: spawnOptions });
    if (h.beforeCommand) h.beforeCommand(args);
    return fakeChild(async () => {
      if (file === helper) {
        const messageText = readFileSync(args[2], "utf8");
        const call = { args: [...args], messageText, mode: args[args.indexOf("--mode") + 1], cwd: spawnOptions.cwd };
        h.helperCalls.push(call);
        const result = h.helperResponder ? await h.helperResponder(call) : { receipt: "receipt-typed-ok.json" };
        const gateFile = args.includes("--gate-file") ? args[args.indexOf("--gate-file") + 1] : null;
        const receipt = jsonFixture(result.receipt, { __SHORT__: args[1], __FILE__: args[2], __OUT__: args[3], __GATE__: gateFile });
        return { stdout: `helper log line\n${JSON.stringify(receipt)}\n`, code: result.code ?? 0 };
      }
      if (args[0] === "--version") return { stdout: h.version };
      if (args[0] === "agents") return { stdout: JSON.stringify(h.agents) };
      if (args[0] === "stop") return { stdout: `stopped ${args[1]}\n` };
      if (args[0] === "--bg") {
        const name = args[args.indexOf("-n") + 1];
        const shortId = (h.nextShortId++).toString(16);
        const sessionId = `${shortId}-1111-4222-8333-444455556666`;
        if (h.onBg) await h.onBg({ shortId, sessionId, name, cwd: spawnOptions.cwd, args });
        else h.agents.push({ pid: 5000, id: shortId, cwd: spawnOptions.cwd, kind: "background", startedAt: Date.now(), sessionId, name, status: "busy", state: "working" });
        return { stdout: h.bgStdoutWithId ? `backgrounded · ${shortId} · ${name}\n  claude attach ${shortId}    open in this terminal\n` : "", stderr: "Starting background service…\n" };
      }
      return { code: 1, stderr: "unexpected command" };
    });
  };

  h.provider = createClaudeBgProvider({
    onUpdate: (runId, update) => h.updates.push({ runId, update }),
    logger: {
      info: (...args) => h.logs.push(["info", ...args]),
      warn: (...args) => h.logs.push(["warn", ...args]),
      error: (...args) => h.logs.push(["error", ...args]),
    },
    claudeExecutable: exe,
    env: { PATH: "", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "claude-desktop", MCP_CONNECTION_NONBLOCKING: "1", AI_AGENT: "claude", ANTHROPIC_BASE_URL: "https://api.example.invalid", KEEP_ME: "yes" },
    spawn,
    homedir: () => home,
    conptyHelperPath: helper,
    tempDir,
    promptDir,
    autoPoll: false,
    discoveryIntervalMs: 1,
    discoveryTimeoutMs: 150,
    deliveryIntervalMs: 2,
    deliveryTimeoutMs: 150,
    stopIntervalMs: 2,
    stopTimeoutMs: 80,
    ...options,
  });

  t.after(async () => {
    await h.provider.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return h;
}

async function startRun(h, { runId = "run-1", title = "REL-7", prompt = "REL-7 請建立 a.txt，內容 ok", ...rest } = {}) {
  const refs = await h.provider.start({ runId, cwd: h.cwd, prompt, title, ...rest });
  // Amendment 9 (BUG-W8-2): the launch token is emitted (and awaited) before `claude --bg`; asserted once here.
  const tokenIndex = h.updates.findIndex((item) => item.runId === runId && item.update.refs?.claudeLaunchToken
    && Object.keys(item.update).length === 1 && Object.keys(item.update.refs).length === 1);
  if (claudeLaunchToken(runId)) {
    assert.ok(tokenIndex >= 0, "start emits the launch token before claude --bg");
    assert.equal(h.updates[tokenIndex].update.refs.claudeLaunchToken, claudeLaunchToken(runId));
    h.updates.splice(tokenIndex, 1);
  }
  if (h.bgStdoutWithId) {
    // Amendment 7 (DBG-03): the --bg short id is emitted as a refs update before discovery; the start tests
    // below assert that once here, and the remaining assertions only look at later updates.
    const index = h.updates.findIndex((item) => item.runId === runId && item.update.refs?.claudeShortId === refs.claudeShortId
      && Object.keys(item.update).length === 1);
    assert.ok(index >= 0, "start emits the --bg short id as refs before discovery");
    h.updates.splice(index, 1);
  }
  return { runId, refs, row: { id: runId, claudeShortId: refs.claudeShortId, claudeSessionId: refs.claudeSessionId, claudeBridgeSessionId: refs.claudeBridgeSessionId ?? null } };
}

test("scrubClaudeEnv drops Claude session, MCP and AI_AGENT variables but keeps ANTHROPIC settings", () => {
  const scrubbed = scrubClaudeEnv({
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
    claude_code_session_id: "x",
    CLAUDE_AGENT_SDK_VERSION: "1",
    CLAUDE_PID: "9",
    CLAUDE_PREVIEW_CLASSIFIER_FLOOR: "1",
    MCP_SERVER_CONNECTION_BATCH_SIZE: "3",
    AI_AGENT: "claude",
    ANTHROPIC_BASE_URL: "https://api.example.invalid",
    ANTHROPIC_API_KEY: "key",
    CLAUDE_EXECUTABLE: "C:\\claude.exe",
    CLAUDE_CONFIG_DIR: "C:\\cfg",
    PATH: "C:\\bin",
  });
  assert.deepEqual(Object.keys(scrubbed).sort(), ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "CLAUDE_EXECUTABLE", "PATH"]);
});

test("resolveClaudeExecutable order: option, CLAUDE_EXECUTABLE, MSIX LocalCache, APPDATA, PATH (highest version)", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2-claude-exe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const localAppData = path.join(root, "Local");
  const appData = path.join(root, "Roaming");
  const pathDir = path.join(root, "pathbin");
  const makeExe = async (filePath) => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "");
  };
  const msixBase = path.join(localAppData, "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude", "claude-code");
  const appDataBase = path.join(appData, "Claude", "claude-code");
  const env = { LOCALAPPDATA: localAppData, APPDATA: appData, PATH: pathDir };
  const resolve = (extra = {}) => resolveClaudeExecutable({ env: { ...env, ...extra }, homedir: () => root, platform: "win32" });

  assert.equal(await resolve(), null);
  await makeExe(path.join(pathDir, "claude.exe"));
  assert.equal(await resolve(), path.join(pathDir, "claude.exe"));

  await makeExe(path.join(appDataBase, "2.1.99", "claude.exe"));
  await makeExe(path.join(appDataBase, "2.1.271", "claude.exe"));
  await mkdir(path.join(appDataBase, "2.1.300"), { recursive: true }); // no claude.exe inside → ignored
  assert.equal(await resolve(), path.join(appDataBase, "2.1.271", "claude.exe"));

  await makeExe(path.join(msixBase, "2.1.270", "claude.exe"));
  assert.equal(await resolve(), path.join(msixBase, "2.1.270", "claude.exe"));

  assert.equal(await resolve({ CLAUDE_EXECUTABLE: "D:\\env\\claude.exe" }), "D:\\env\\claude.exe");
  assert.equal(
    await resolveClaudeExecutable({ explicit: "E:\\option\\claude.exe", env: { ...env, CLAUDE_EXECUTABLE: "D:\\env\\claude.exe" }, platform: "win32" }),
    "E:\\option\\claude.exe",
  );
});

test("available() checks --version against the 2.1.271 minimum with a scrubbed, hidden, shell-less spawn", async (t) => {
  const h = await createHarness(t);
  assert.deepEqual(await h.provider.available(), { ok: true, version: "2.1.271" });
  const call = h.calls.at(-1);
  assert.equal(call.file, h.exe);
  assert.deepEqual(call.args, ["--version"]);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.shell, false);
  assert.deepEqual(Object.keys(call.options.env).sort(), ["ANTHROPIC_BASE_URL", "KEEP_ME", "PATH"]);

  h.version = "2.1.270 (Claude Code)\n";
  assert.deepEqual(await h.provider.available(), { ok: false, reason: "CLAUDE_TOO_OLD", version: "2.1.270" });

  const missing = createClaudeBgProvider({ onUpdate() {}, env: { PATH: "", LOCALAPPDATA: h.root, APPDATA: h.root }, homedir: () => h.root, platform: "win32", spawn: () => { throw new Error("must not spawn"); } });
  assert.deepEqual(await missing.available(), { ok: false, reason: "CLAUDE_NOT_FOUND" });
  await missing.dispose();
});

test("start runs claude --bg with add-dir, name, permission mode and model, then discovers refs and bridge id", async (t) => {
  const h = await createHarness(t);
  h.agents = jsonFixture("agents-before-start.json", { __CWD__: h.cwd, __TITLE__: "REL-7" });
  h.onBg = async ({ shortId, sessionId, name, cwd }) => {
    await h.writeState(shortId, sessionId);
    h.agents.push({ pid: 5000, id: shortId, cwd, kind: "background", startedAt: 1, sessionId, name, status: "busy", state: "working" });
  };
  const { refs } = await startRun(h, { model: "haiku" });

  const bg = h.calls.find((call) => call.args[0] === "--bg");
  assert.deepEqual(bg.args, ["--bg", "--add-dir", h.promptDir, "-n", "REL-7 · rrun1", "--permission-mode", "acceptEdits", "--model", "haiku", "REL-7 請建立 a.txt，內容 ok"]);
  assert.equal(bg.options.cwd, h.cwd);
  assert.equal(bg.options.shell, false);
  assert.equal(bg.options.windowsHide, true);
  assert.equal(bg.options.env.CLAUDECODE, undefined);
  assert.equal(bg.options.env.ANTHROPIC_BASE_URL, "https://api.example.invalid");
  assert.deepEqual(refs, { claudeShortId: "abc00001", claudeSessionId: "abc00001-1111-4222-8333-444455556666", claudeBridgeSessionId: "cse_01TestBridgeSession" });

  const allCommands = JSON.stringify(h.calls.map((call) => call.args));
  assert.equal(allCommands.includes("--resume"), false);
  assert.equal(JSON.stringify(h.logs).includes("SECRET"), false);
  assert.equal(h.provider.openUrl({ id: "run-1", ...refs }), "claude://claude.ai/epitaxy/cse_01TestBridgeSession");
});

test("start without an id in --bg output discovers by name and cwd, skipping sessions known before start", async (t) => {
  const h = await createHarness(t);
  h.bgStdoutWithId = false;
  h.agents = jsonFixture("agents-before-start.json", { __CWD__: h.cwd, __TITLE__: "REL-9" });
  let agentsCallsAfterBg = 0;
  h.onBg = async ({ shortId, sessionId, name, cwd }) => {
    // The new entry only appears on the second agents poll; the pre-existing "REL-9" entry must not match.
    const pending = { pid: 5001, id: shortId, cwd: cwd.toUpperCase(), kind: "background", startedAt: 2, sessionId, name, status: "busy", state: "working" };
    h.beforeCommand = (args) => {
      if (args[0] !== "agents") return;
      agentsCallsAfterBg += 1;
      if (agentsCallsAfterBg === 2) h.agents.push(pending);
    };
  };
  const { refs } = await startRun(h, { runId: "run-9", title: "REL-9" });
  assert.equal(refs.claudeShortId, "abc00001");
  assert.equal(refs.claudeBridgeSessionId, undefined);
  assert.ok(agentsCallsAfterBg >= 2);
});

test("start writes prompts longer than 20,000 characters to <promptDir>/<runId>-prompt.md and passes a short line", async (t) => {
  const h = await createHarness(t);
  const longPrompt = `第001行：繁體中文「引號」 "quotes" % & | ^\n${"長".repeat(ARGV_PROMPT_LIMIT)}`;
  await startRun(h, { runId: "run-long", prompt: longPrompt, permissionMode: "bypassPermissions" });
  const bg = h.calls.find((call) => call.args[0] === "--bg");
  const promptFile = path.join(h.promptDir, "run-long-prompt.md");
  assert.equal(await readFile(promptFile, "utf8"), longPrompt);
  assert.equal(bg.args.at(-1), `請先完整讀取這個檔案中的任務說明並照做：${promptFile}`);
  assert.equal(bg.args[bg.args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(bg.args.includes("--model"), false);
});

test("Amendment 6: permissionMode null starts claude --bg without --permission-mode; invalid modes are refused", async (t) => {
  const h = await createHarness(t);
  h.agents = jsonFixture("agents-before-start.json", { __CWD__: h.cwd, __TITLE__: "REL-7" });
  h.onBg = async ({ shortId, sessionId, name, cwd }) => {
    await h.writeState(shortId, sessionId);
    h.agents.push({ pid: 5000, id: shortId, cwd, kind: "background", startedAt: 1, sessionId, name, status: "busy", state: "working" });
  };
  await startRun(h, { permissionMode: null });
  const bg = h.calls.find((call) => call.args[0] === "--bg");
  assert.deepEqual(bg.args, ["--bg", "--add-dir", h.promptDir, "-n", "REL-7 · rrun1", "REL-7 請建立 a.txt，內容 ok"]);
  assert.equal(bg.args.includes("--permission-mode"), false);

  const before = h.calls.length;
  for (const permissionMode of ["accept edits", "--dangerously-skip-permissions", 7]) {
    await assert.rejects(startRun(h, { runId: "run-bad", permissionMode }), /CLAUDE_INVALID_PERMISSION_MODE/);
  }
  assert.equal(h.calls.slice(before).some((call) => call.args[0] === "--bg"), false);
});

test("DBG-03: a session that never appears in agents stays controllable by its --bg short id; without an id discovery still fails", async (t) => {
  const h = await createHarness(t);
  h.onBg = async () => {};
  // Amendment 7: `--bg` printed a short id, so the session exists; start resolves with that ref (unconfirmed).
  const { runId, refs, row } = await startRun(h);
  assert.deepEqual(refs, { claudeShortId: "abc00001", claudeSessionId: null, unconfirmed: true });
  assert.equal(h.logs.some(([level, message]) => level === "warn" && /not confirmed by claude agents/.test(message)), true);

  // stop / close reach it by the short id.
  const stopped = await h.provider.stop({ run: row });
  assert.equal(stopped.stopped, true, stopped.detail);
  assert.equal(stopped.detail, "ALREADY_SESSION_NOT_LISTED");
  await h.provider.close({ run: row });
  assert.deepEqual(h.calls.at(-1).args, ["stop", "abc00001"]);

  // A second start that is never listed: the next poll reports it interrupted (refs already persisted).
  const second = await startRun(h, { runId: "run-2", title: "REL-8" });
  assert.equal(second.refs.unconfirmed, true);
  await h.provider.pollNow();
  assert.deepEqual(h.updatesFor("run-2"), [{ status: "interrupted", error: "CLAUDE_SESSION_NOT_LISTED" }]);
  assert.deepEqual(h.updatesFor(runId), []);

  // No id in the --bg output: nothing can reach the session, so the start still fails.
  h.bgStdoutWithId = false;
  await assert.rejects(startRun(h, { runId: "run-3", title: "REL-9" }), (error) => error.code === "CLAUDE_BG_DISCOVERY_TIMEOUT");
});

test("DBG-03: --bg short id + failing agents lookups → refs emitted first, polled as running once agents recovers", async (t) => {
  const h = await createHarness(t);
  const listed = [];
  let agentsBroken = false;
  h.onBg = async ({ shortId, sessionId, name, cwd }) => {
    listed.push({ pid: 5000, id: shortId, cwd, kind: "background", startedAt: 1, sessionId, name, status: "busy", state: "working" });
    agentsBroken = true;
  };
  // `claude agents` answers unparseable output from the moment the session was created.
  h.beforeCommand = (args) => {
    if (args[0] === "agents") h.agents = agentsBroken ? "daemon not responding" : listed;
  };
  const { runId, refs } = await startRun(h);
  assert.deepEqual(refs, { claudeShortId: "abc00001", claudeSessionId: null, unconfirmed: true });

  // Still failing within the grace period: no status change.
  await h.provider.pollNow();
  assert.deepEqual(h.updatesFor(runId), []);
  // agents recovers: the session is found and reported running.
  agentsBroken = false;
  await h.provider.pollNow();
  assert.deepEqual(h.updatesFor(runId), [{ status: "running" }]);
});

test("DBG-03: agents failing past the unconfirmed grace period → interrupted with CLAUDE_BG_SESSION_UNCONFIRMED", async (t) => {
  let clock = 1_000_000;
  const h = await createHarness(t, { options: { now: () => clock, unconfirmedStartGraceMs: 60_000, discoveryTimeoutMs: 0 } });
  h.onBg = async () => {};
  h.beforeCommand = (args) => {
    if (args[0] === "agents" && h.calls.some((call) => call.args[0] === "--bg")) h.agents = "broken";
  };
  const { runId } = await startRun(h);
  await h.provider.pollNow();
  assert.deepEqual(h.updatesFor(runId), []);
  clock += 60_001;
  await h.provider.pollNow();
  assert.deepEqual(h.updatesFor(runId), [{ status: "interrupted", error: "CLAUDE_BG_SESSION_UNCONFIRMED" }]);
});

test("DBG-03: dispose during discovery rejects CLAUDE_BG_START_INTERRUPTED carrying the refs (session may be running)", async (t) => {
  const h = await createHarness(t, { options: { discoveryTimeoutMs: 30_000, discoveryIntervalMs: 20 } });
  h.onBg = async () => {};
  const started = h.provider.start({ runId: "run-d", cwd: h.cwd, prompt: "work", title: "REL-1" });
  await waitFor(() => h.calls.filter((call) => call.args[0] === "agents").length >= 2);
  const t0 = Date.now();
  await h.provider.dispose();
  const error = await started.then(() => null, (reason) => reason);
  assert.ok(error, "start rejects after dispose");
  assert.equal(error.code, "CLAUDE_BG_START_INTERRUPTED");
  assert.deepEqual(error.refs, { claudeShortId: "abc00001" });
  assert.equal(error.sessionMayBeRunning, true);
  assert.ok(Date.now() - t0 < 1_000, "dispose does not wait for the discovery deadline");
  assert.deepEqual(h.updatesFor("run-d"), [{ refs: { claudeLaunchToken: "rund" } }, { refs: { claudeShortId: "abc00001" } }]);
});

test("polling: busy → running once, waiting → running with WAITING_FOR_PERMISSION, idle after running → finished with transcript text", async (t) => {
  const h = await createHarness(t);
  const { runId, refs } = await startRun(h);
  await h.writeTranscript(refs.claudeSessionId, fixture("transcript-complete.jsonl", { __SESSION__: refs.claudeSessionId }));
  const entry = h.entry(refs.claudeShortId);

  await h.provider.pollNow();
  await h.provider.pollNow();
  assert.deepEqual(h.updatesFor(runId), [{ status: "running" }]);

  Object.assign(entry, { status: "waiting", waitingFor: "permission prompt", state: "blocked" });
  await h.provider.pollNow();
  await h.provider.pollNow();
  Object.assign(entry, { status: "busy", state: "working" });
  delete entry.waitingFor;
  await h.provider.pollNow();
  Object.assign(entry, { status: "idle", state: "blocked" });
  await h.provider.pollNow();
  await h.provider.pollNow();

  assert.deepEqual(h.updatesFor(runId), [
    { status: "running" },
    { status: "running", error: "WAITING_FOR_PERMISSION: permission prompt" },
    { status: "running" },
    { status: "finished", resultText: "已建立 a.txt。" },
  ]);
});

test("polling: idle is not finished until running was observed or the turn is complete; unknown status keeps previous status", async (t) => {
  const h = await createHarness(t);
  const { runId, refs } = await startRun(h);
  const entry = h.entry(refs.claudeShortId);
  Object.assign(entry, { status: "idle", state: "done" });
  await h.writeTranscript(refs.claudeSessionId, `${userLine("REL-7 請建立 a.txt，內容 ok")}\n`);
  await h.provider.pollNow();
  assert.deepEqual(h.updatesFor(runId), []);

  Object.assign(entry, { status: "compacting" });
  await h.provider.pollNow();
  await h.provider.pollNow();
  assert.deepEqual(h.updatesFor(runId), []);
  assert.equal(h.logs.filter((log) => log[0] === "warn" && JSON.stringify(log).includes("status:compacting")).length, 1);

  Object.assign(entry, { status: "idle" });
  await h.appendTranscript(refs.claudeSessionId, assistantLine("完成：a.txt"));
  await h.provider.pollNow();
  assert.deepEqual(h.updatesFor(runId), [{ status: "finished", resultText: "完成：a.txt" }]);
});

test("polling: process gone maps stopped/done/blocked via transcript; a missing entry is interrupted", async (t) => {
  const h = await createHarness(t);
  const runs = [];
  for (const runId of ["run-stopped", "run-done", "run-midturn", "run-missing"]) runs.push(await startRun(h, { runId, title: runId }));
  const [stopped, done, midturn, missing] = runs;
  Object.assign(h.entry(stopped.refs.claudeShortId), { pid: undefined, status: undefined, state: "stopped" });
  Object.assign(h.entry(done.refs.claudeShortId), { pid: undefined, status: undefined, state: "blocked" });
  Object.assign(h.entry(midturn.refs.claudeShortId), { pid: undefined, status: undefined, state: "done" });
  h.agents = h.agents.filter((entry) => entry.id !== missing.refs.claudeShortId);
  await h.writeTranscript(done.refs.claudeSessionId, fixture("transcript-complete.jsonl"));
  await h.writeTranscript(midturn.refs.claudeSessionId, fixture("transcript-midturn.jsonl"));

  await h.provider.pollNow();
  await h.provider.pollNow();
  assert.deepEqual(h.updatesFor("run-stopped"), [{ status: "stopped" }]);
  assert.deepEqual(h.updatesFor("run-done"), [{ status: "finished", resultText: "已建立 a.txt。" }]);
  assert.deepEqual(h.updatesFor("run-midturn"), [{ status: "interrupted", error: "CLAUDE_SESSION_PROCESS_ENDED" }]);
  assert.deepEqual(h.updatesFor("run-missing"), [{ status: "interrupted", error: "CLAUDE_SESSION_NOT_LISTED" }]);
});

test("polling emits the bridge session id as a refs update once state.json has it", async (t) => {
  const h = await createHarness(t);
  const { runId, refs } = await startRun(h);
  assert.equal(refs.claudeBridgeSessionId, undefined);
  await h.provider.pollNow();
  await h.writeState(refs.claudeShortId, refs.claudeSessionId);
  await h.provider.pollNow();
  await h.provider.pollNow();
  assert.deepEqual(h.updatesFor(runId), [{ status: "running" }, { refs: { claudeBridgeSessionId: "cse_01TestBridgeSession" } }]);
  assert.equal(JSON.stringify(h.logs).includes("SECRET"), false);
});

test("sendFollowup queue: pastes a short body through the helper and confirms the new transcript user message", async (t) => {
  const h = await createHarness(t);
  const { runId, refs, row } = await startRun(h);
  await h.writeTranscript(refs.claudeSessionId, fixture("transcript-complete.jsonl"));
  Object.assign(h.entry(refs.claudeShortId), { status: "idle", state: "done" });
  await h.provider.pollNow();
  assert.deepEqual(h.updatesFor(runId).at(-1), { status: "finished", resultText: "已建立 a.txt。" });

  h.helperResponder = async (call) => {
    await h.appendTranscript(refs.claudeSessionId, userLine(call.messageText));
    Object.assign(h.entry(refs.claudeShortId), { status: "busy", state: "working" });
    return { receipt: "receipt-typed-ok.json" };
  };
  const body = `${String.fromCharCode(0xfeff)}  請再建立 b.txt\r\n內容 ok2${String.fromCharCode(0x1a)}  `;
  const result = await h.provider.sendFollowup({ run: row, body, mode: "queue" });
  assert.equal(result.delivered, true, result.detail);
  assert.match(result.detail, /^DELIVERED via user-message/);

  const call = h.helperCalls.at(-1);
  assert.equal(call.messageText, "請再建立 b.txt\n內容 ok2");
  assert.deepEqual(call.args.slice(0, 2), [h.exe, refs.claudeShortId]);
  assert.deepEqual(call.args.slice(4, 8), ["60000", "120000", "--mode", "queue"]);
  // Amendment 9: queue / steer deliveries pass a pre-Enter gate file next to the message file.
  assert.equal(call.args[8], "--gate-file");
  assert.equal(call.args[9], call.args[2].replace(/\.txt$/, ".gate"));
  assert.equal(call.args.length, 10);
  assert.equal(call.cwd, h.cwd);
  assert.deepEqual(await readdir(h.tempDir), [], "temporary message/output/gate files are removed");
  assert.deepEqual(h.updatesFor(runId).at(-1), { status: "running" });

  Object.assign(h.entry(refs.claudeShortId), { status: "idle", state: "done" });
  await h.appendTranscript(refs.claudeSessionId, assistantLine("b.txt 已建立"));
  await h.provider.pollNow();
  assert.deepEqual(h.updatesFor(runId).at(-1), { status: "finished", resultText: "b.txt 已建立" });
});

test("sendFollowup routes long, many-line or command-like bodies through <promptDir>/<runId>-followup-<n>.md", async (t) => {
  assert.equal(pasteUnsafeReason("x".repeat(500)), null);
  assert.equal(pasteUnsafeReason("x".repeat(501)), "too-long");
  assert.equal(pasteUnsafeReason(Array(21).fill("a").join("\n")), "too-many-lines");
  assert.equal(pasteUnsafeReason("/clear"), "leading-command-character");
  assert.equal(sanitizeFollowupMessage(`a\rb${String.fromCharCode(0x7f)}\tc`), "a\nb\tc");

  const h = await createHarness(t);
  const { refs, row } = await startRun(h);
  await h.writeTranscript(refs.claudeSessionId, fixture("transcript-complete.jsonl"));
  h.helperResponder = async (call) => {
    await h.appendTranscript(refs.claudeSessionId, userLine(call.messageText));
    return { receipt: "receipt-typed-ok.json" };
  };
  const longBody = "補充說明：".repeat(120);
  const first = await h.provider.sendFollowup({ run: row, body: longBody, mode: "queue" });
  assert.equal(first.delivered, true, first.detail);
  const firstFile = path.join(h.promptDir, "run-1-followup-1.md");
  assert.equal(await readFile(firstFile, "utf8"), longBody);
  assert.equal(h.helperCalls.at(-1).messageText, `請讀取這個檔案中的補充說明並照做：${firstFile}`);

  const second = await h.provider.sendFollowup({ run: row, body: "/clear 不要清除，請照做", mode: "queue" });
  assert.equal(second.delivered, true, second.detail);
  assert.equal(h.helperCalls.at(-1).messageText, `請讀取這個檔案中的補充說明並照做：${path.join(h.promptDir, "run-1-followup-2.md")}`);
});

test("sendFollowup is not delivered when the helper did not type or the transcript never shows the message", async (t) => {
  const h = await createHarness(t);
  const { runId, refs, row } = await startRun(h);
  await h.writeTranscript(refs.claudeSessionId, fixture("transcript-complete.jsonl"));
  const before = h.updatesFor(runId).length;

  h.helperResponder = async () => ({ receipt: "receipt-not-typed.json", code: 5 });
  const notTyped = await h.provider.sendFollowup({ run: row, body: "請繼續", mode: "queue" });
  assert.equal(notTyped.delivered, false);
  assert.match(notTyped.detail, /^NOT_TYPED rc=5 typed=false crSent=false abort=fatal-screen-state/);

  h.helperResponder = async () => ({ receipt: "receipt-typed-ok.json" });
  const unconfirmed = await h.provider.sendFollowup({ run: row, body: "請繼續", mode: "queue" });
  assert.equal(unconfirmed.delivered, false);
  assert.match(unconfirmed.detail, /^NOT_CONFIRMED_IN_TRANSCRIPT/);

  // An older identical message already in the transcript does not count as delivery.
  await h.appendTranscript(refs.claudeSessionId, userLine("請再做一次"));
  const stale = await h.provider.sendFollowup({ run: row, body: "請再做一次", mode: "queue" });
  assert.equal(stale.delivered, false);
  assert.equal(h.updatesFor(runId).length, before);
});

test("sendFollowup steer on a running turn is confirmed by a queued_command attachment and does not re-emit running", async (t) => {
  const h = await createHarness(t);
  const { runId, refs, row } = await startRun(h);
  await h.writeTranscript(refs.claudeSessionId, fixture("transcript-midturn.jsonl"));
  await h.provider.pollNow();
  assert.deepEqual(h.updatesFor(runId), [{ status: "running" }]);

  h.helperResponder = async (call) => {
    await h.appendTranscript(refs.claudeSessionId, queuedLine(call.messageText));
    return { receipt: "receipt-typed-ok.json" };
  };
  const result = await h.provider.sendFollowup({ run: row, body: "改成只建立 f.txt", mode: "steer" });
  assert.equal(result.delivered, true, result.detail);
  assert.match(result.detail, /^DELIVERED via queued-command/);
  assert.equal(h.helperCalls.at(-1).mode, "steer");
  assert.deepEqual(h.updatesFor(runId), [{ status: "running" }]);

  // A brief idle before the steered prompt has an answer must not finish the run.
  Object.assign(h.entry(refs.claudeShortId), { status: "idle" });
  await h.provider.pollNow();
  assert.deepEqual(h.updatesFor(runId), [{ status: "running" }]);
  await h.appendTranscript(refs.claudeSessionId, assistantLine("已改為只建立 f.txt"));
  await h.provider.pollNow();
  assert.deepEqual(h.updatesFor(runId).at(-1), { status: "finished", resultText: "已改為只建立 f.txt" });
});

test("stop sends an interrupt with an empty message file, confirms idle, and the run is not reported finished afterwards", async (t) => {
  const h = await createHarness(t);
  const { runId, refs, row } = await startRun(h);
  await h.writeTranscript(refs.claudeSessionId, fixture("transcript-midturn.jsonl"));
  await h.provider.pollNow();

  h.helperResponder = async (call) => {
    Object.assign(h.entry(refs.claudeShortId), { status: "idle", state: "blocked" });
    return { receipt: "receipt-interrupt-ok.json" };
  };
  const result = await h.provider.stop({ run: row });
  assert.equal(result.stopped, true, result.detail);
  assert.match(result.detail, /^IDLE rc=0/);
  const call = h.helperCalls.at(-1);
  assert.equal(call.mode, "interrupt");
  assert.equal(call.messageText, "");

  await h.provider.pollNow();
  assert.deepEqual(h.updatesFor(runId), [{ status: "running" }]);
});

test("stop reports stopped=false when the session stays busy, and skips the helper when nothing is running", async (t) => {
  const h = await createHarness(t);
  const busy = await startRun(h, { runId: "run-busy", title: "busy" });
  h.helperResponder = async () => ({ receipt: "receipt-interrupt-ok.json" });
  const stillBusy = await h.provider.stop({ run: busy.row });
  assert.equal(stillBusy.stopped, false);
  assert.match(stillBusy.detail, /^STILL_BUSY_AFTER_INTERRUPT/);

  const idle = await startRun(h, { runId: "run-idle", title: "idle" });
  Object.assign(h.entry(idle.refs.claudeShortId), { status: "idle", state: "done" });
  const helperCallsBefore = h.helperCalls.length;
  assert.deepEqual(await h.provider.stop({ run: idle.row }), { stopped: true, detail: "ALREADY_IDLE" });
  assert.equal(h.helperCalls.length, helperCallsBefore);
});

test("close runs `claude stop <shortId>`; openUrl uses only the bridge session id", async (t) => {
  const h = await createHarness(t);
  const { row, refs } = await startRun(h);
  await h.provider.close({ run: row });
  assert.deepEqual(h.calls.at(-1).args, ["stop", refs.claudeShortId]);
  assert.equal(h.provider.openUrl({ id: "x", claudeShortId: "abc", claudeBridgeSessionId: null }), null);
  assert.equal(h.provider.openUrl({ id: "x", claudeBridgeSessionId: "cse_01Abc" }), "claude://claude.ai/epitaxy/cse_01Abc");
  assert.equal(h.provider.openUrl({ id: "x", claudeBridgeSessionId: "bad/../id" }), null);
});

test("recover maps agents and transcript state and resumes polling for running sessions", async (t) => {
  const h = await createHarness(t);
  const sessions = {};
  for (const name of ["busy", "idle-complete", "gone-midturn", "missing"]) {
    const shortId = `f00${Object.keys(sessions).length}0000`;
    const sessionId = `${shortId}-aaaa-4bbb-8ccc-dddddddddddd`;
    sessions[name] = { id: `run-${name}`, claudeShortId: shortId, claudeSessionId: sessionId, claudeBridgeSessionId: null };
    if (name !== "missing") h.agents.push({ pid: 7000, id: shortId, cwd: h.cwd, kind: "background", sessionId, name, status: "busy", state: "working" });
  }
  Object.assign(h.entry(sessions["idle-complete"].claudeShortId), { status: "idle", state: "done" });
  Object.assign(h.entry(sessions["gone-midturn"].claudeShortId), { pid: undefined, status: undefined, state: "done" });
  await h.writeTranscript(sessions["busy"].claudeSessionId, fixture("transcript-midturn.jsonl"));
  await h.writeTranscript(sessions["idle-complete"].claudeSessionId, fixture("transcript-complete.jsonl"));
  await h.writeTranscript(sessions["gone-midturn"].claudeSessionId, fixture("transcript-midturn.jsonl"));

  assert.deepEqual(await h.provider.recover(sessions.busy), { status: "running" });
  assert.deepEqual(await h.provider.recover(sessions["idle-complete"]), { status: "finished", resultText: "已建立 a.txt。" });
  assert.deepEqual(await h.provider.recover(sessions["gone-midturn"]), { status: "interrupted" });
  assert.deepEqual(await h.provider.recover(sessions.missing), { status: "interrupted" });
  assert.deepEqual(await h.provider.recover({ id: "run-none", claudeShortId: null }), { status: "interrupted" });

  Object.assign(h.entry(sessions.busy.claudeShortId), { status: "idle", state: "done" });
  await h.appendTranscript(sessions.busy.claudeSessionId, toolResultLine(), assistantLine("兩個檔案都建立好了"));
  await h.provider.pollNow();
  assert.deepEqual(h.updatesFor("run-busy"), [{ status: "finished", resultText: "兩個檔案都建立好了" }]);
  assert.deepEqual(h.updatesFor("run-idle-complete"), []);
});

test("Amendment 9: recover of a run without a short id matches `r<token>` in the name and the project cwd; ambiguity adopts nothing", async (t) => {
  const h = await createHarness(t, { options: { recoverLookupAttempts: 2, recoverLookupIntervalMs: 1 } });
  assert.equal(claudeLaunchToken("1f2e3d4c-5b6a-4789-8abc-def012345678"), "1f2e3d4c");
  assert.equal(claudeLaunchToken("a-b"), null);
  const sessionId = "c0ffee01-aaaa-4bbb-8ccc-dddddddddddd";
  h.agents.push(
    { pid: 7001, id: "c0ffee01", cwd: h.cwd, kind: "background", sessionId, name: "REL-9 整理 · r1f2e3d4c", status: "busy", state: "working" },
    { pid: 7002, id: "c0ffee02", cwd: path.join(h.root, "elsewhere"), kind: "background", sessionId: "x-2", name: "REL-9 整理 · r9999aaaa", status: "busy", state: "working" },
    { pid: 7003, id: "c0ffee03", cwd: h.cwd, kind: "background", sessionId: "x-3", name: "REL-5 · r1f2e3d4c0", status: "busy", state: "working" },
  );
  await h.writeState("c0ffee01", sessionId);
  const row = { id: "1f2e3d4c-5b6a-4789-8abc-def012345678", claudeShortId: null, claudeSessionId: null, claudeLaunchToken: "1f2e3d4c" };
  assert.deepEqual(await h.provider.recover(row, { cwd: h.cwd }), {
    status: "running",
    refs: { claudeShortId: "c0ffee01", claudeSessionId: sessionId, claudeBridgeSessionId: "cse_01TestBridgeSession" },
  });
  await h.provider.close({ run: { id: row.id, claudeShortId: "c0ffee01" } });

  // Wrong folder → not adopted.
  const elsewhere = { id: "9999aaaa-0000", claudeShortId: null, claudeLaunchToken: "9999aaaa" };
  assert.deepEqual(await h.provider.recover(elsewhere, { cwd: h.cwd }), { status: "interrupted" });

  // Two sessions carry the token → none is adopted.
  h.agents.push({ pid: 7004, id: "c0ffee04", cwd: h.cwd, kind: "background", sessionId: "x-4", name: "copy · r1f2e3d4c", status: "busy", state: "working" });
  assert.deepEqual(await h.provider.recover(row, { cwd: h.cwd }), { status: "interrupted" });
  assert.ok(h.logs.some((entry) => String(entry[1]).includes("several background sessions carry the launch token")));

  // No token → old behaviour without any lookup.
  const agentsCalls = h.calls.filter((call) => call.args[0] === "agents").length;
  assert.deepEqual(await h.provider.recover({ id: "run-none", claudeShortId: null }), { status: "interrupted" });
  assert.equal(h.calls.filter((call) => call.args[0] === "agents").length, agentsCalls);
});

test("transcript analysis: human prompts, queued prompts, sidechains, tool results and turn completion", () => {
  const complete = analyzeTranscript(parseTranscriptLines(fixture("transcript-complete.jsonl")));
  assert.equal(complete.humanMessages.length, 1);
  assert.equal(complete.turnComplete, true);
  assert.equal(complete.resultText, "已建立 a.txt。");

  const midturn = analyzeTranscript(parseTranscriptLines(fixture("transcript-midturn.jsonl")));
  assert.equal(midturn.assistantAfterLastHuman, true);
  assert.equal(midturn.turnComplete, false);

  const lines = parseTranscriptLines([
    fixture("transcript-midturn.jsonl").trim(),
    queuedLine("改成只建立 f.txt"),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
    "{ partial line",
  ].join("\n"));
  const withQueued = analyzeTranscript(lines);
  assert.equal(withQueued.humanMessages.length, 2);
  assert.equal(findNewHumanMessage(withQueued, 1, "改成只建立 f.txt\r\n").source, "queued-command");
  assert.equal(findNewHumanMessage(withQueued, 2, "改成只建立 f.txt"), null);
  assert.equal(projectSlugForCwd("C:\\work\\_probes\\p5\\a"), "C--work--probes-p5-a");
});

test("ConPtyAttachSend.cs keeps the receipt and uses the v2 exit-code rule", () => {
  const source = readFileSync(path.join(REPO_ROOT, "tools", "conpty", "ConPtyAttachSend.cs"), "utf8");
  assert.match(source, /bool succeeded = childStarted\s+&& abortReason == null\s+&& !AnyFatal\(stateMarkers\)\s+&& \(mode == "interrupt" \|\| \(typed && crSent\)\);/);
  assert.match(source, /int rc = succeeded \? 0 : 5;/);
  assert.match(source, /if \(message\.Length == 0 && mode != "interrupt"\)/);
  for (const field of ["typed", "crSent", "abortReason", "stateMarkers", "stages", "detachedCleanly", "turnStartedEvidence", "gateFile", "gateResult", "gateWaitMs", "inputCleared", "clearMethod"]) {
    assert.ok(source.includes(`\\"${field}\\":`), `receipt field ${field}`);
  }
  // Amendment 9 pre-Enter gate: TYPED marker, bounded 5 s wait, CR only on go, erase with DEL (never ESC).
  assert.match(source, /Console\.WriteLine\("TYPED"\);\s+Console\.Out\.Flush\(\);/);
  assert.match(source, /const int GATE_TIMEOUT_MS = 5000;/);
  assert.match(source, /if \(gateResult == null \|\| gateResult == "go"\) \{\s+long preCrOffset = CapturedBytes\(\);\s+Send\("\\r"\);/);
  assert.match(source, /Send\(new string\(\(char\)0x7F, n\)\);/);
});

test("runProcess reports complete stdout lines (CRLF, split chunks) while the child runs", async () => {
  const lines = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const done = runProcess(() => child, "helper.exe", [], { onStdoutLine: (line) => lines.push(line) });
  child.stdout.emit("data", Buffer.from("log\r\nTY"));
  assert.deepEqual(lines, ["log"]);
  child.stdout.emit("data", Buffer.from("PED\r\n{\"typed\":true}\r\n"));
  assert.deepEqual(lines, ["log", "TYPED", "{\"typed\":true}"]);
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
  const result = await done;
  assert.equal(result.stdout, "log\r\nTYPED\r\n{\"typed\":true}\r\n");
});

test("autoPoll drives status polling by itself and stops polling once no run is active", async (t) => {
  const h = await createHarness(t, { options: { autoPoll: true, pollIntervalMs: 5 } });
  const { runId, refs } = await startRun(h);
  await h.writeTranscript(refs.claudeSessionId, fixture("transcript-complete.jsonl"));
  await waitFor(() => h.updatesFor(runId).length >= 1);
  assert.deepEqual(h.updatesFor(runId), [{ status: "running" }]);
  Object.assign(h.entry(refs.claudeShortId), { status: "idle", state: "done" });
  await waitFor(() => h.updatesFor(runId).some((update) => update.status === "finished"));
  const agentsCalls = () => h.calls.filter((call) => call.args[0] === "agents").length;
  const settled = agentsCalls();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(agentsCalls(), settled);
  assert.deepEqual(h.updatesFor(runId), [{ status: "running" }, { status: "finished", resultText: "已建立 a.txt。" }]);
});

test("runProcess resolves after exit even when a detached grandchild (like a cold-started daemon) holds the pipes", async () => {
  const script = [
    "const { spawn } = require('node:child_process');",
    "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { detached: true, stdio: 'inherit', windowsHide: true }).unref();",
    "console.log('backgrounded · abcd1234 · demo');",
  ].join(" ");
  const started = Date.now();
  const result = await runProcess(nodeSpawn, process.execPath, ["-e", script], { timeoutMs: 15_000 });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /abcd1234/);
  assert.ok(Date.now() - started < 3000, `resolved after ${Date.now() - started} ms`);
});

test("W3 bug 2: extraEnv (read per spawn) adds CODEX_TASKBOARD_URL to every Claude child", async (t) => {
  let boardUrl = "http://127.0.0.1:1111";
  const h = await createHarness(t, { options: { extraEnv: () => ({ CODEX_TASKBOARD_URL: boardUrl }) } });
  await h.provider.available();
  assert.equal(h.calls.at(-1).options.env.CODEX_TASKBOARD_URL, "http://127.0.0.1:1111");
  assert.equal(h.calls.at(-1).options.env.CLAUDECODE, undefined);
  boardUrl = "http://127.0.0.1:2222/token-prefix";
  await startRun(h);
  const bg = h.calls.find((call) => call.args[0] === "--bg");
  assert.equal(bg.options.env.CODEX_TASKBOARD_URL, "http://127.0.0.1:2222/token-prefix");
});

// ---- W5: W4 live retest bugs A (permission prompt) and B (absorbed steer) ----

const STEER_TEXT = "如果你看到這則訊息：請建立 steer.txt，內容只有一行 STEERED";

function steerFixtureLines(sessionId, { through = null } = {}) {
  const lines = fixture("transcript-steer-absorbed.jsonl", { __SESSION__: sessionId, __STEER__: STEER_TEXT }).trim().split("\n");
  if (through === null) return lines;
  const index = lines.findIndex((line) => line.includes(`"operation":"${through}"`));
  return lines.slice(0, index + 1);
}

test("W5 bug B: transcript fixture (sanitized R2d shapes) — enqueue proves receipt before the queued_command attachment exists", () => {
  const enqueued = analyzeTranscript(parseTranscriptLines(steerFixtureLines("s-1", { through: "enqueue" }).join("\n")));
  assert.equal(enqueued.humanMessages.length, 1);
  assert.equal(enqueued.queuedPrompts.length, 1);
  assert.equal(enqueued.turnComplete, false);
  const match = findNewHumanMessage(enqueued, { human: 1, queued: 0 }, `${STEER_TEXT}\r\n`);
  assert.equal(match?.source, "queue-enqueue");
  assert.equal(findNewHumanMessage(enqueued, { human: 1, queued: 1 }, STEER_TEXT), null, "an older enqueue is not a new delivery");
  assert.equal(findNewHumanMessage(enqueued, 1, STEER_TEXT), null, "a numeric baseline keeps the old human-only meaning");

  const absorbed = analyzeTranscript(parseTranscriptLines(steerFixtureLines("s-1").join("\n")));
  assert.equal(absorbed.humanMessages.length, 2);
  assert.equal(absorbed.humanMessages[1].source, "queued-command");
  assert.equal(absorbed.turnComplete, true);
  assert.equal(absorbed.resultText, "STEERED\n\nLOOP-DONE");
  assert.equal(findNewHumanMessage(absorbed, { human: 1, queued: 0 }, STEER_TEXT)?.source, "queued-command");
  assert.equal(findMessageSince(absorbed, Date.parse("2026-09-17T05:51:53.000Z"), STEER_TEXT)?.source, "queued-command");
  assert.equal(findMessageSince(absorbed, Date.parse("2026-09-17T05:55:00.000Z"), STEER_TEXT), null);
});

test("W5 bug B: a steer typed during a long tool call is delivered once the enqueue line appears (no attachment yet)", async (t) => {
  const h = await createHarness(t);
  const { runId, refs, row } = await startRun(h);
  const prefix = steerFixtureLines(refs.claudeSessionId, { through: "enqueue" });
  await h.writeTranscript(refs.claudeSessionId, `${prefix.slice(0, -1).join("\n")}\n`);
  await h.provider.pollNow();
  h.helperResponder = async (call) => {
    assert.equal(call.messageText, STEER_TEXT);
    await h.appendTranscript(refs.claudeSessionId, prefix.at(-1));
    return { receipt: "receipt-typed-ok.json" };
  };
  const result = await h.provider.sendFollowup({ run: row, body: STEER_TEXT, mode: "steer" });
  assert.equal(result.delivered, true, result.detail);
  assert.match(result.detail, /^DELIVERED via queue-enqueue/);
  assert.deepEqual(h.updatesFor(runId), [{ status: "running" }]);
});

test("W5 bug B: a converted steer that the session already absorbed is not typed again (since)", async (t) => {
  const h = await createHarness(t);
  const { refs, row } = await startRun(h);
  await h.writeTranscript(refs.claudeSessionId, `${steerFixtureLines(refs.claudeSessionId).join("\n")}\n`);
  Object.assign(h.entry(refs.claudeShortId), { status: "idle", state: "done" });
  const result = await h.provider.sendFollowup({ run: row, body: STEER_TEXT, mode: "queue", since: "2026-09-17T05:51:53.000Z" });
  assert.deepEqual([result.delivered, result.alreadyInTranscript], [true, true]);
  assert.match(result.detail, /^ALREADY_IN_TRANSCRIPT/);
  assert.equal(h.helperCalls.length, 0);

  // Sent after that point in time → typed normally.
  h.helperResponder = async (call) => {
    await h.appendTranscript(refs.claudeSessionId, userLine(call.messageText));
    return { receipt: "receipt-typed-ok.json" };
  };
  const later = await h.provider.sendFollowup({ run: row, body: STEER_TEXT, mode: "queue", since: "2026-09-17T06:30:00.000Z" });
  assert.equal(later.delivered, true, later.detail);
  assert.equal(later.alreadyInTranscript, undefined);
  assert.equal(h.helperCalls.length, 1);
});

test("W5 bug A: nothing is typed while agents shows a permission prompt; the run is reported running + waiting", async (t) => {
  const h = await createHarness(t);
  const { runId, refs, row } = await startRun(h);
  await h.writeTranscript(refs.claudeSessionId, fixture("transcript-midturn.jsonl"));
  Object.assign(h.entry(refs.claudeShortId), { status: "waiting", waitingFor: "permission prompt", state: "blocked" });
  for (const mode of ["steer", "queue"]) {
    const result = await h.provider.sendFollowup({ run: row, body: "改成只做到 3", mode });
    assert.equal(result.delivered, false);
    assert.equal(result.waitingForPermission, true);
    assert.equal(result.detail, "WAITING_FOR_PERMISSION: permission prompt");
  }
  assert.equal(h.helperCalls.length, 0, "the helper is never invoked");
  assert.deepEqual(h.updatesFor(runId), [{ status: "running", error: "WAITING_FOR_PERMISSION: permission prompt" }]);

  // The prompt was answered in the App: the next poll clears the waiting state and a later idle finishes.
  Object.assign(h.entry(refs.claudeShortId), { status: "busy", state: "working", waitingFor: undefined });
  await h.provider.pollNow();
  assert.deepEqual(h.updatesFor(runId).at(-1), { status: "running" });
});

test("W5 bug A: when the agents check itself fails, the helper is not invoked", async (t) => {
  const h = await createHarness(t);
  const { refs, row } = await startRun(h);
  await h.writeTranscript(refs.claudeSessionId, fixture("transcript-midturn.jsonl"));
  h.beforeCommand = (args) => {
    if (args[0] === "agents") throw new Error("agents exploded");
  };
  const result = await h.provider.sendFollowup({ run: row, body: "補一句", mode: "steer" });
  assert.equal(result.delivered, false);
  assert.match(result.detail, /^AGENTS_CHECK_FAILED/);
  assert.equal(h.helperCalls.length, 0);
});

test("follow-up fix: within 2x the poll interval after a delivery, stop does not trust idle and interrupts (fake clock)", async (t) => {
  // Injected clock: real time plus a manually advanced offset (loops with deadlines still end).
  let clock = 0;
  const h = await createHarness(t, { options: { now: () => Date.now() + clock, pollIntervalMs: 5_000 } });
  const { refs, row } = await startRun(h);
  await h.writeTranscript(refs.claudeSessionId, fixture("transcript-complete.jsonl"));
  Object.assign(h.entry(refs.claudeShortId), { status: "idle", state: "done" });

  // Delivered; `claude agents` keeps reporting idle (lagging behind the typed message).
  h.helperResponder = async (call) => {
    if (call.mode === "interrupt") return { receipt: "receipt-interrupt-ok.json" };
    await h.appendTranscript(h.entry(call.args[1]).sessionId, userLine(call.messageText));
    return { receipt: "receipt-typed-ok.json" };
  };
  const delivered = await h.provider.sendFollowup({ run: row, body: "請再建立 c.txt", mode: "queue" });
  assert.equal(delivered.delivered, true, delivered.detail);

  clock += 2 * 5_000 - 1_000; // still inside the 2x poll interval window
  const helperCallsBefore = h.helperCalls.length;
  const stopped = await h.provider.stop({ run: row });
  assert.equal(stopped.stopped, true, stopped.detail);
  assert.match(stopped.detail, /^IDLE /, "interrupt was sent, then idle confirmed");
  assert.equal(h.helperCalls.length, helperCallsBefore + 1);
  assert.equal(h.helperCalls.at(-1).mode, "interrupt");

  // Past the window an idle session is trusted again: no interrupt is typed.
  const again = await startRun(h, { runId: "run-2", title: "second" });
  Object.assign(h.entry(again.refs.claudeShortId), { status: "idle", state: "done" });
  await h.writeTranscript(again.refs.claudeSessionId, fixture("transcript-complete.jsonl"));
  const deliveredAgain = await h.provider.sendFollowup({ run: again.row, body: "請再建立 d.txt", mode: "queue" });
  assert.equal(deliveredAgain.delivered, true, deliveredAgain.detail);
  clock += 2 * 5_000 + 1;
  const callsBeforeLate = h.helperCalls.length;
  assert.deepEqual(await h.provider.stop({ run: again.row }), { stopped: true, detail: "ALREADY_IDLE" });
  assert.equal(h.helperCalls.length, callsBeforeLate);
});

test("follow-up fix: session controls are dropped on release, close and dispose", async (t) => {
  const h = await createHarness(t);
  assert.equal(h.provider.sessionControlCount(), 0);

  // Stop (release after success) with no recent delivery → control dropped.
  const first = await startRun(h, { runId: "run-a", title: "a" });
  Object.assign(h.entry(first.refs.claudeShortId), { status: "idle", state: "done" });
  await h.provider.stop({ run: first.row });
  assert.equal(h.provider.sessionControlCount(), 0, "released after stop");

  // close → dropped even right after a delivery.
  const second = await startRun(h, { runId: "run-b", title: "b" });
  await h.writeTranscript(second.refs.claudeSessionId, fixture("transcript-complete.jsonl"));
  Object.assign(h.entry(second.refs.claudeShortId), { status: "idle", state: "done" });
  h.helperResponder = async (call) => {
    await h.appendTranscript(second.refs.claudeSessionId, userLine(call.messageText));
    return { receipt: "receipt-typed-ok.json" };
  };
  assert.equal((await h.provider.sendFollowup({ run: second.row, body: "hi", mode: "queue" })).delivered, true);
  assert.equal(h.provider.sessionControlCount(), 1, "kept while the run is tracked");
  await h.provider.close({ run: second.row });
  assert.equal(h.provider.sessionControlCount(), 0, "dropped on close");

  // A delivery that fails on a run the provider no longer tracks → dropped once nothing holds it.
  const third = await startRun(h, { runId: "run-c", title: "c" });
  Object.assign(h.entry(third.refs.claudeShortId), { status: "idle", state: "done" });
  await h.provider.stop({ run: third.row });
  h.helperResponder = async () => ({ receipt: "receipt-not-typed.json" });
  const failed = await h.provider.sendFollowup({ run: third.row, body: "nope", mode: "queue" });
  assert.equal(failed.delivered, false);
  assert.equal(h.provider.sessionControlCount(), 0, "released after an untyped delivery");

  // dispose clears whatever is left (a tracked run's control).
  const fourth = await startRun(h, { runId: "run-d", title: "d" });
  await h.writeTranscript(fourth.refs.claudeSessionId, fixture("transcript-complete.jsonl"));
  h.helperResponder = async (call) => {
    await h.appendTranscript(fourth.refs.claudeSessionId, userLine(call.messageText));
    return { receipt: "receipt-typed-ok.json" };
  };
  assert.equal((await h.provider.sendFollowup({ run: fourth.row, body: "hello", mode: "queue" })).delivered, true);
  assert.equal(h.provider.sessionControlCount(), 1);
  await h.provider.dispose();
  assert.equal(h.provider.sessionControlCount(), 0, "dropped on dispose");
});
