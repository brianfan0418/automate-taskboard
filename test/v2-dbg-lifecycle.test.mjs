// Amendment 7 regressions (DBG-02 / DBG-03 / DBG-04): the real run service, the real Claude background
// provider and the real TaskboardDatabase, with a fake `claude` CLI, ConPTY helper and transcript writer.
// No real Claude, helper or network is used.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { TaskboardDatabase } from "../server/database.mjs";
import { createTaskboardServer } from "../server/index.mjs";
import { CLAUDE_AGENT_ACTOR } from "../server/runs/actors.mjs";
import { createClaudeBgProvider } from "../server/runs/claude-bg.mjs";
import { projectSlugForCwd } from "../server/runs/claude-transcript.mjs";
import { RUN_ENDED, STEER_NOT_DELIVERED_QUEUED, createRunService } from "../server/runs/service.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/v2-claude/", import.meta.url));
const USER = { type: "user", id: "local-user", name: "Me", avatarUrl: null };
const quiet = { info() {}, warn() {}, error() {} };

function receipt(name, replacements) {
  const value = JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
  for (const [key, inner] of Object.entries(value)) {
    if (typeof inner === "string" && Object.prototype.hasOwnProperty.call(replacements, inner)) value[key] = replacements[inner];
  }
  return JSON.stringify(value);
}

const iso = () => new Date().toISOString();
const userLine = (text) => JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: text }, origin: { kind: "human" }, promptSource: "typed", uuid: `u-${Math.random()}`, timestamp: iso() });
const toolUseLine = () => JSON.stringify({ type: "assistant", isSidechain: false, message: { role: "assistant", id: `m-${Math.random()}`, content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "sleep 100" } }], stop_reason: "tool_use" }, uuid: `a-${Math.random()}`, timestamp: iso() });
const endTurnLine = (text) => JSON.stringify({ type: "assistant", isSidechain: false, message: { role: "assistant", id: `m-${Math.random()}`, content: [{ type: "text", text }], stop_reason: "end_turn" }, uuid: `a-${Math.random()}`, timestamp: iso() });
const enqueueLine = (text) => JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: iso(), content: text });

function readGate(gateFile) {
  try {
    const value = readFileSync(gateFile, "utf8").trim();
    return value === "go" || value === "abort" ? value : null;
  } catch {
    return null;
  }
}

async function waitForGate(gateFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = readGate(gateFile);
    if (value) return value;
    if (Date.now() >= deadline) return "timeout";
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeChild(work) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  Promise.resolve().then(() => work(child)).then((result = {}) => {
    if (result.stdout) child.stdout.emit("data", Buffer.from(result.stdout));
    if (result.stderr) child.stderr.emit("data", Buffer.from(result.stderr));
    child.emit("exit", result.code ?? 0, null);
    child.emit("close", result.code ?? 0, null);
  });
  return child;
}

// Fake `claude` CLI + ConPTY helper shared by every provider instance of one test (sessions survive a restart).
async function createFakeCli(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "v2-dbg-lifecycle-"));
  const cli = {
    root,
    // Closed (newest first) before the folder is removed: SQLite files cannot be deleted while open.
    cleanups: [],
    home: path.join(root, "home"),
    cwd: path.join(root, "work"),
    promptDir: path.join(root, "prompts"),
    tempDir: path.join(root, "tmp"),
    exe: path.join(root, "bin", "claude.exe"),
    helper: path.join(root, "bin", "ConPtyAttachSend.exe"),
    agents: [],
    calls: [],
    helperCalls: [],
    agentsCalls: 0,
    agentsBroken: false,
    bgDelayMs: 0,
    // async (call) => { receipt?, writeTranscript?, markBusy? } for queue/steer; the default types, writes a user line, marks busy.
    helperResponder: null,
    // { at, entered, release }: pause one `claude agents` call (see pauseAgentsCall).
    agentsPause: null,
    nextShortId: 0xd0000001,
    entry(shortId) {
      return cli.agents.find((item) => item.id === shortId);
    },
    transcriptPath(sessionId) {
      return path.join(cli.home, ".claude", "projects", projectSlugForCwd(cli.cwd), `${sessionId}.jsonl`);
    },
    async append(sessionId, ...lines) {
      await mkdir(path.dirname(cli.transcriptPath(sessionId)), { recursive: true });
      await appendFile(cli.transcriptPath(sessionId), `${lines.join("\n")}\n`, "utf8");
    },
    // Messages submitted to the session (typed AND Enter pressed).
    typedMessages() {
      return cli.helperCalls.filter((call) => call.mode !== "interrupt" && call.crSent).map((call) => call.messageText);
    },
    // Messages typed into the input box and erased at the pre-Enter gate.
    erasedMessages() {
      return cli.helperCalls.filter((call) => call.mode !== "interrupt" && call.typed && !call.crSent).map((call) => call.messageText);
    },
    interrupts() {
      return cli.helperCalls.filter((call) => call.mode === "interrupt").length;
    },
    pauseAgentsCall(atCall) {
      const entered = deferred();
      const release = deferred();
      cli.agentsPause = { at: cli.agentsCalls + atCall, entered, release };
      return { entered: entered.promise, release: release.resolve };
    },
  };
  t.after(async () => {
    for (const cleanup of cli.cleanups.reverse()) await cleanup();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await Promise.all([mkdir(cli.home, { recursive: true }), mkdir(cli.cwd, { recursive: true }), mkdir(path.dirname(cli.exe), { recursive: true })]);
  await Promise.all([writeFile(cli.exe, ""), writeFile(cli.helper, "")]);

  cli.spawn = (file, args, options) => {
    cli.calls.push({ file, args: [...args] });
    return fakeChild(async (child) => {
      if (file === cli.helper) {
        const messageText = readFileSync(args[2], "utf8");
        const mode = args[args.indexOf("--mode") + 1];
        const gateFile = args.includes("--gate-file") ? args[args.indexOf("--gate-file") + 1] : null;
        // typed: text reached the input box; crSent: Enter was pressed (the message reached the session).
        const call = { mode, messageText, typed: false, crSent: false, gateFile, gateResult: null };
        cli.helperCalls.push(call);
        const replacements = { __SHORT__: args[1], __FILE__: args[2], __OUT__: args[3], __GATE__: gateFile };
        if (mode === "interrupt") {
          const entry = cli.entry(args[1]);
          if (entry) Object.assign(entry, { status: "idle", state: "blocked" });
          return { stdout: `log\n${receipt("receipt-interrupt-ok.json", replacements)}\n` };
        }
        // Amendment 9 gate protocol, like ConPtyAttachSend: `abort` already written → type nothing.
        if (gateFile && readGate(gateFile) === "abort") {
          call.gateResult = "abort";
          return { stdout: `log\n${receipt("receipt-gate-abort-before-type.json", replacements)}\n`, code: 5 };
        }
        const response = cli.helperResponder ? await cli.helperResponder(call) : {};
        if (response.receipt === "receipt-not-typed.json") {
          return { stdout: `log\n${receipt("receipt-not-typed.json", replacements)}\n`, code: 5 };
        }
        call.typed = true;
        if (gateFile) {
          if (response.emitTyped !== false) child.stdout.emit("data", Buffer.from("TYPED\r\n"));
          call.gateResult = await waitForGate(gateFile, response.gateTimeoutMs ?? 2_000);
          if (call.gateResult !== "go") {
            // The typed text is erased and Enter is never pressed.
            const name = call.gateResult === "abort" ? "receipt-gate-abort.json" : "receipt-gate-timeout.json";
            return { stdout: `log\n${receipt(name, replacements)}\n`, code: 5 };
          }
        }
        call.crSent = true;
        if (response.afterEnter) await response.afterEnter();
        if (response.writeTranscript !== false) {
          const entry = cli.entry(args[1]);
          await cli.append(entry.sessionId, userLine(messageText));
          if (response.markBusy !== false) Object.assign(entry, { status: "busy", state: "working" });
        }
        return { stdout: `log\n${receipt("receipt-typed-ok.json", replacements)}\n` };
      }
      if (args[0] === "--version") return { stdout: "2.1.271 (Claude Code)\n" };
      if (args[0] === "agents") {
        cli.agentsCalls += 1;
        if (cli.onAgents) cli.onAgents(cli.agentsCalls);
        const pause = cli.agentsPause;
        if (pause && cli.agentsCalls === pause.at) {
          cli.agentsPause = null;
          pause.entered.resolve();
          await pause.release.promise;
        }
        if (cli.agentsBroken) return { code: 1, stderr: "daemon not responding\n" };
        return { stdout: JSON.stringify(cli.agents) };
      }
      if (args[0] === "stop") {
        const entry = cli.entry(args[1]);
        if (entry) {
          delete entry.pid;
          delete entry.status;
          entry.state = "stopped";
        }
        return { stdout: `stopped ${args[1]}\n` };
      }
      if (args[0] === "--bg") {
        if (cli.bgDelayMs) await new Promise((resolve) => setTimeout(resolve, cli.bgDelayMs));
        const name = args[args.indexOf("-n") + 1];
        const shortId = (cli.nextShortId++).toString(16);
        const sessionId = `${shortId}-1111-4222-8333-444455556666`;
        cli.agents.push({ pid: 5000, id: shortId, cwd: options.cwd, kind: "background", startedAt: Date.now(), sessionId, name, status: "busy", state: "working" });
        await cli.append(sessionId, userLine(args.at(-1)));
        if (cli.onBg) cli.onBg({ shortId, sessionId });
        // BUG-W8-2: `--bg` registered the session but the board is killed before it prints the id.
        if (cli.bgHang) await cli.bgHang.promise;
        return { stdout: `backgrounded · ${shortId} · ${name}\n` };
      }
      return { code: 1, stderr: "unexpected command" };
    });
  };
  return cli;
}

function createProvider(cli, onUpdate, options = {}) {
  return createClaudeBgProvider({
    onUpdate,
    logger: quiet,
    claudeExecutable: cli.exe,
    env: { PATH: "" },
    spawn: cli.spawn,
    homedir: () => cli.home,
    conptyHelperPath: cli.helper,
    tempDir: cli.tempDir,
    promptDir: cli.promptDir,
    autoPoll: false,
    discoveryIntervalMs: 1,
    discoveryTimeoutMs: 150,
    deliveryIntervalMs: 2,
    deliveryTimeoutMs: 150,
    stopIntervalMs: 2,
    stopTimeoutMs: 150,
    recoverLookupAttempts: 3,
    recoverLookupIntervalMs: 5,
    ...options,
  });
}

// One board "process": database + provider + run service. `wrapProvider` can decorate the provider the service sees.
function createBoard(cli, { databasePath, providerOptions, wrapProvider } = {}) {
  const board = { followupHistory: new Map() };
  board.database = new TaskboardDatabase(databasePath ?? path.join(cli.root, "taskboard.sqlite"));
  board.provider = createProvider(cli, (runId, update) => board.service.handleProviderUpdate(runId, update), providerOptions);
  board.service = createRunService({
    database: board.database,
    providers: { claude: wrapProvider ? wrapProvider(board.provider) : board.provider },
    buildPrompt: async ({ task }) => `${task.title} 請開始`,
    detectClaudePermission: async () => ({ effectiveMode: null, source: null }),
    emit: (type, payload) => {
      if (type !== "followup.updated") return;
      const history = board.followupHistory.get(payload.followup.id) ?? [];
      history.push(payload.followup.status);
      board.followupHistory.set(payload.followup.id, history);
    },
  });
  let closed = false;
  board.close = async () => {
    if (closed) return;
    closed = true;
    await board.provider.dispose();
    await board.service.settle();
    board.database.close();
  };
  cli.cleanups.push(board.close);
  return board;
}

function createClaudeTask(board, cli, projectId = "p1") {
  if (!board.database.getProject(projectId)) board.database.createProject({ id: projectId, name: projectId, workspacePath: cli.cwd });
  return board.database.createTask({
    projectId, title: "整理報表", description: "", status: "todo", priority: "none", labels: [], threadId: null,
    actor: USER, assignee: CLAUDE_AGENT_ACTOR, developmentContext: null, startDate: null, dueDate: null, recurrence: null,
  });
}

async function startRunning(board, cli, task) {
  const { run } = await board.service.startTask({ taskId: task.id, actor: USER });
  await board.service.settle();
  await board.provider.pollNow();
  await board.service.settle();
  const current = board.database.getRun(run.id);
  assert.equal(current.status, "running");
  return current;
}

async function finishTurn(board, cli, run, text = "第一輪完成") {
  await cli.append(run.claudeSessionId, endTurnLine(text));
  Object.assign(cli.entry(run.claudeShortId), { status: "idle", state: "blocked" });
}

// ---------------------------------------------------------------- DBG-02

test("DBG-02: stop while a queued follow-up delivery is paused before typing → nothing typed, follow-up canceled, run stopped", async (t) => {
  const cli = await createFakeCli(t);
  const board = createBoard(cli);
  const task = createClaudeTask(board, cli);
  const run = await startRunning(board, cli, task);
  const { followup } = await board.service.sendFollowup({ taskId: task.id, body: "請接著把 legacy 資料夾刪掉", mode: "queue", actor: USER });
  await finishTurn(board, cli, run);

  // agents call 1 = this poll; call 2 = the queued delivery's pre-typing session lookup (paused).
  const pause = cli.pauseAgentsCall(2);
  const polling = board.provider.pollNow();
  await pause.entered;
  assert.equal(board.database.getRun(run.id).status, "running");

  const stopping = board.service.stopTask({ taskId: task.id, destination: "todo", actor: USER });
  await waitFor(() => board.database.getRun(run.id).status === "stopping");
  await new Promise((resolve) => setImmediate(resolve));
  let stopAnswered = false;
  stopping.then(() => { stopAnswered = true; }, () => { stopAnswered = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopAnswered, false, "stop waits for the delivery that is still in flight");

  pause.release();
  const stopped = await stopping;
  await polling;
  await board.service.settle();
  // Later polls must not revive the canceled message either.
  await board.provider.pollNow();
  await board.service.settle();

  assert.deepEqual(cli.typedMessages(), [], "the canceled message never reaches the session");
  assert.equal(cli.interrupts(), 0, "nothing was typed, so the idle session needs no interrupt");
  assert.equal(stopped.run.status, "stopped");
  assert.equal(stopped.task.status, "todo");
  assert.equal(board.database.getRun(run.id).status, "stopped");
  assert.equal(board.database.getActiveRun(task.id), null);
  const saved = board.database.getFollowup(followup.id);
  assert.equal(saved.status, "canceled");
  assert.equal(saved.error, RUN_ENDED);
  assert.equal(saved.sentAt, null);
  assert.equal(board.followupHistory.get(followup.id).includes("sent"), false, board.followupHistory.get(followup.id).join(">"));
});

// BUG-W8-1 (W8 live retest L1): the stop lands while the helper is typing the queued message.
test("BUG-W8-1: stop while the helper is typing (before the pre-Enter gate) → gate abort, no Enter, follow-up canceled, no new turn, no interrupt", async (t) => {
  const cli = await createFakeCli(t);
  const board = createBoard(cli);
  const task = createClaudeTask(board, cli);
  const run = await startRunning(board, cli, task);
  const { followup } = await board.service.sendFollowup({ taskId: task.id, body: "再加一段摘要", mode: "queue", actor: USER });
  await finishTurn(board, cli, run);
  const transcriptBefore = readFileSync(cli.transcriptPath(run.claudeSessionId), "utf8");

  const entered = deferred();
  const release = deferred();
  let gateSeenByHelper = null;
  cli.helperResponder = async (call) => {
    entered.resolve();
    await release.promise; // still typing
    gateSeenByHelper = readGate(call.gateFile);
    return {};
  };
  const polling = board.provider.pollNow();
  await entered.promise;
  const stopping = board.service.stopTask({ taskId: task.id, destination: "backlog", actor: USER });
  await waitFor(() => board.database.getRun(run.id).status === "stopping");
  const gateFile = cli.helperCalls.at(-1).gateFile;
  await waitFor(() => readGate(gateFile) === "abort", 2_000);
  release.resolve();
  const stopped = await stopping;
  await polling;
  await board.service.settle();
  await board.provider.pollNow();
  await board.service.settle();

  assert.equal(gateSeenByHelper, "abort", "stop wrote abort at once, before the helper reported TYPED");
  assert.deepEqual(cli.erasedMessages(), ["再加一段摘要"], "typed into the box, then erased");
  assert.deepEqual(cli.typedMessages(), [], "Enter was never pressed");
  assert.equal(cli.helperCalls.at(-1).gateResult, "abort");
  assert.equal(cli.interrupts(), 0, "nothing was submitted, so the idle session needs no interrupt");
  assert.equal(readFileSync(cli.transcriptPath(run.claudeSessionId), "utf8"), transcriptBefore, "no new user message / turn");
  assert.equal(cli.entry(run.claudeShortId).status, "idle");
  assert.equal(stopped.run.status, "stopped");
  assert.equal(stopped.task.status, "backlog");
  const saved = board.database.getFollowup(followup.id);
  assert.equal(saved.status, "canceled");
  assert.equal(saved.error, RUN_ENDED);
  assert.equal(saved.sentAt, null);
  assert.equal(board.followupHistory.get(followup.id).includes("sent"), false);
  assert.deepEqual(await readdir(cli.tempDir), [], "message / gate files removed");
});

test("BUG-W8-1: the gate said go (Enter pressed, agents still idle) and then stop → stop still interrupts", async (t) => {
  const cli = await createFakeCli(t);
  const board = createBoard(cli);
  const task = createClaudeTask(board, cli);
  const run = await startRunning(board, cli, task);
  const { followup } = await board.service.sendFollowup({ taskId: task.id, body: "再加一段摘要", mode: "queue", actor: USER });
  await finishTurn(board, cli, run);

  const entered = deferred();
  const release = deferred();
  cli.helperResponder = async () => ({
    markBusy: false, // `claude agents` lags and still reports idle after the message was submitted
    afterEnter: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const polling = board.provider.pollNow();
  await entered.promise;
  const stopping = board.service.stopTask({ taskId: task.id, destination: null, actor: USER });
  await waitFor(() => board.database.getRun(run.id).status === "stopping");
  await new Promise((resolve) => setTimeout(resolve, 20));
  release.resolve();
  const stopped = await stopping;
  await polling;
  await board.service.settle();

  assert.equal(cli.helperCalls.find((call) => call.mode === "queue").gateResult, "go");
  assert.equal(cli.typedMessages().length, 1);
  assert.equal(cli.interrupts(), 1, "stop does not answer ALREADY_IDLE for a session that was just typed into");
  assert.equal(stopped.run.status, "stopped");
  assert.equal(board.database.getRun(run.id).status, "stopped");
  assert.equal(board.database.getFollowup(followup.id).status, "canceled");
  assert.equal(board.followupHistory.get(followup.id).includes("sent"), false);
});

test("BUG-W8-1: steer during a running turn — stop before Enter aborts the gate; the turn is still interrupted once", async (t) => {
  const cli = await createFakeCli(t);
  const board = createBoard(cli);
  const task = createClaudeTask(board, cli);
  const run = await startRunning(board, cli, task);
  await cli.append(run.claudeSessionId, toolUseLine());

  const entered = deferred();
  const release = deferred();
  cli.helperResponder = async () => {
    entered.resolve();
    await release.promise;
    return {};
  };
  const { followup } = await board.service.sendFollowup({ taskId: task.id, body: "改成只處理 A 區", mode: "steer", actor: USER });
  await entered.promise;
  const stopping = board.service.stopTask({ taskId: task.id, destination: null, actor: USER });
  await waitFor(() => readGate(cli.helperCalls.at(-1).gateFile) === "abort", 2_000);
  release.resolve();
  const stopped = await stopping;
  await board.service.settle();

  assert.deepEqual(cli.typedMessages(), []);
  assert.deepEqual(cli.erasedMessages(), ["改成只處理 A 區"]);
  assert.equal(cli.interrupts(), 1, "the running turn itself is interrupted (agents said busy)");
  assert.equal(stopped.run.status, "stopped");
  assert.notEqual(board.database.getFollowup(followup.id).status, "sent");
});

// BUG-W8-3 (W8 live retest 2, M1b): the stop lands while the helper is typing a `continue` message.
test("BUG-W8-3: stop while a continue message is typed (before the pre-Enter gate) → gate abort, no Enter, run stopped, no new turn, stop answers promptly", async (t) => {
  const cli = await createFakeCli(t);
  const board = createBoard(cli);
  const task = createClaudeTask(board, cli);
  const first = await startRunning(board, cli, task);
  await finishTurn(board, cli, first);
  await board.provider.pollNow();
  await board.service.settle();
  assert.equal(board.database.getTask(task.id).status, "in_review");
  const transcriptBefore = readFileSync(cli.transcriptPath(first.claudeSessionId), "utf8");

  const typed = deferred();
  const release = deferred();
  let gateSeenByHelper = null;
  cli.helperResponder = async (call) => {
    typed.resolve();
    await release.promise; // text is in the input box; TYPED not yet reported
    gateSeenByHelper = readGate(call.gateFile);
    return {};
  };
  const { run } = await board.service.continueTask({ taskId: task.id, body: "請再補一張圖表", actor: USER });
  await typed.promise;

  let stopAnswered = false;
  const stopping = board.service.stopTask({ taskId: task.id, destination: null, actor: USER });
  stopping.then(() => { stopAnswered = true; }, () => { stopAnswered = true; });
  await waitFor(() => board.database.getRun(run.id).status === "stopping");
  const gateFile = cli.helperCalls.at(-1).gateFile;
  // Before the fix the stop waited for the whole delivery, so `abort` was never written while typing.
  await waitFor(() => readGate(gateFile) === "abort", 2_000);
  assert.equal(stopAnswered, false, "the stop still waits for the in-flight delivery to end");
  const releasedAt = Date.now();
  release.resolve();
  const stopped = await stopping;
  assert.ok(Date.now() - releasedAt < 1_000, "stop answers as soon as the aborted delivery ends");
  await board.service.settle();
  await board.provider.pollNow();
  await board.service.settle();

  assert.equal(gateSeenByHelper, "abort");
  assert.equal(cli.helperCalls.at(-1).gateResult, "abort");
  assert.deepEqual(cli.erasedMessages(), ["請再補一張圖表"], "typed into the box, then erased");
  assert.deepEqual(cli.typedMessages(), [], "Enter was never pressed");
  assert.equal(cli.interrupts(), 0, "nothing was submitted, so the idle session needs no interrupt");
  assert.equal(readFileSync(cli.transcriptPath(first.claudeSessionId), "utf8"), transcriptBefore, "no new user message / turn");
  assert.equal(stopped.run.id, run.id);
  assert.equal(stopped.run.status, "stopped");
  assert.equal(board.database.getRun(run.id).status, "stopped");
  assert.equal(board.database.getActiveRun(task.id), null);
  assert.equal(board.database.listPendingFollowups(task.id).length, 0, "no follow-up left pending");
  assert.equal(board.database.listComments(task.id).some((comment) => comment.body.startsWith("AI 執行失敗")), false, "not reported as a failure");
  assert.deepEqual(await readdir(cli.tempDir), [], "message / gate files removed");
});

test("BUG-W8-1: gate timeout (no answer) → nothing submitted, not delivered, and a later stop on the idle session sends no interrupt", async (t) => {
  const cli = await createFakeCli(t);
  const board = createBoard(cli);
  const task = createClaudeTask(board, cli);
  const run = await startRunning(board, cli, task);
  await finishTurn(board, cli, run);
  // The provider never sees TYPED (e.g. an unflushed stdout), so nobody answers the gate.
  const provider = board.provider;
  cli.helperResponder = async () => ({ emitTyped: false, gateTimeoutMs: 30 });
  const result = await provider.sendFollowup({ run: board.database.getRun(run.id), body: "再做一次", mode: "queue" });
  assert.equal(result.delivered, false);
  assert.equal(result.stopRequested, undefined);
  assert.match(result.detail, /^NOT_TYPED .*gate=timeout/);
  assert.deepEqual(cli.typedMessages(), []);
  const stopped = await provider.stop({ run: board.database.getRun(run.id) });
  assert.deepEqual(stopped, { stopped: true, detail: "ALREADY_IDLE" });
  assert.equal(cli.interrupts(), 0);
});

test("DBG-02: updateFollowup ifStatus only writes while the follow-up still has that status", async (t) => {
  const cli = await createFakeCli(t);
  const board = createBoard(cli);
  const task = createClaudeTask(board, cli);
  const run = board.database.createRun({ taskId: task.id, provider: "claude" });
  const followup = board.database.createFollowup({ taskId: task.id, runId: run.id, body: "x", mode: "queue" });
  board.database.updateFollowup(followup.id, { status: "canceled", error: RUN_ENDED });
  assert.equal(board.database.updateFollowup(followup.id, { status: "sent" }, { ifStatus: "pending" }), null);
  assert.equal(board.database.getFollowup(followup.id).status, "canceled");
  const other = board.database.createFollowup({ taskId: task.id, runId: run.id, body: "y", mode: "queue" });
  assert.equal(board.database.updateFollowup(other.id, { status: "sent" }, { ifStatus: "pending" }).status, "sent");
});

// ---------------------------------------------------------------- DBG-03

test("DBG-03: --bg returned a short id but agents lookups fail → the run keeps its refs, stays active, and stop/archive reach the session", async (t) => {
  const cli = await createFakeCli(t);
  cli.onBg = () => { cli.agentsBroken = true; };
  const board = createBoard(cli);
  const task = createClaudeTask(board, cli);
  const { run } = await board.service.startTask({ taskId: task.id, actor: USER });
  await board.service.settle();

  const saved = board.database.getRun(run.id);
  assert.equal(saved.status, "starting", "not a clean failure: the session may be running");
  assert.equal(saved.claudeShortId, "d0000001");
  assert.equal(board.database.getTask(task.id).status, "in_progress");
  assert.equal(board.database.getActiveRun(task.id)?.id, run.id, "the card keeps its active run (no duplicate start)");
  assert.equal(board.database.listComments(task.id).some((comment) => comment.body.startsWith("AI 無法開始工作")), false);

  // agents recovers: stop reaches the session by its short id.
  cli.agentsBroken = false;
  const stopped = await board.service.stopTask({ taskId: task.id, destination: "todo", actor: USER });
  assert.equal(stopped.run.status, "stopped");
  assert.equal(cli.interrupts(), 1);
  await board.service.archiveTask({ taskId: task.id, actor: USER });
  assert.ok(cli.calls.some((call) => call.args[0] === "stop" && call.args[1] === "d0000001"), "archive runs claude stop <shortId>");
});

test("DBG-03: provider disposed during discovery → run stays starting with refs and is recovered on restart", async (t) => {
  const cli = await createFakeCli(t);
  const databasePath = path.join(cli.root, "restart.sqlite");
  cli.onBg = () => { cli.agentsBroken = true; };
  const first = createBoard(cli, { databasePath, providerOptions: { discoveryTimeoutMs: 30_000, discoveryIntervalMs: 10 } });
  const task = createClaudeTask(first, cli);
  const { run } = await first.service.startTask({ taskId: task.id, actor: USER });
  await waitFor(() => first.database.getRun(run.id).claudeShortId !== null);
  const t0 = Date.now();
  await first.close();
  assert.ok(Date.now() - t0 < 2_000, "dispose cuts discovery short");

  cli.agentsBroken = false;
  const second = createBoard(cli, { databasePath });
  const left = second.database.getRun(run.id);
  assert.equal(left.status, "starting");
  assert.equal(left.claudeShortId, "d0000001");
  await second.service.recoverOnStartup();
  await second.service.settle();
  assert.equal(second.database.getRun(run.id).status, "running");
  assert.equal(second.database.getTask(task.id).status, "in_progress");
  assert.equal(cli.agents.filter((entry) => entry.pid !== undefined).length, 1, "no second session was started");
});

test("DBG-03: board close settles an in-flight start before disposing the Claude provider", async (t) => {
  const cli = await createFakeCli(t);
  cli.bgDelayMs = 150;
  const dataDirectory = path.join(cli.root, "data");
  const codex = {
    name: "codex",
    async available() { return { ok: true }; },
    async start() { return {}; },
    async sendFollowup() { return { delivered: false }; },
    async stop() { return { stopped: true }; },
    async close() {},
    openUrl() { return null; },
    async recover() { return { status: "interrupted" }; },
    async dispose() {},
  };
  const boot = () => {
    let app = null;
    const claude = createProvider(cli, (runId, update) => app.runService.handleProviderUpdate(runId, update));
    app = createTaskboardServer({
      dataDirectory,
      runProviders: { claude, codex },
      enableScheduler: false,
      runLogger: quiet,
      claudePermissionDetector: async () => ({ effectiveMode: null, source: null }),
    });
    return app;
  };
  const app = boot();
  let appClosed = false;
  cli.cleanups.push(async () => { if (!appClosed) await app.close(); });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  await app.whenStarted();
  const api = async (pathname, body) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await api("/api/projects", { id: "w", name: "w", workspacePath: cli.cwd })).status, 201);
  const created = await api("/api/tasks", { projectId: "w", title: "T", status: "todo", assigneeTarget: "claude-agent" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const started = await api(`/api/tasks/${created.body.task.id}/run/start`, {});
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run.id;
  await app.close();
  appClosed = true;

  const database = new TaskboardDatabase(path.join(dataDirectory, "taskboard.sqlite"));
  cli.cleanups.push(() => database.close());
  const saved = database.getRun(runId);
  assert.notEqual(saved.status, "failed", saved.error ?? "");
  assert.equal(saved.claudeShortId, "d0000001");
  assert.equal(saved.claudeSessionId, "d0000001-1111-4222-8333-444455556666", "discovery completed before dispose");
});

// ---------------------------------------------------------------- DBG-04

const DBG04_BODIES = {
  short: "請另外建立 extra.txt，內容一行 OK",
  long: "請在 log.txt 追加一行 APPENDED。".padEnd(501, "補"),
  multiline: Array.from({ length: 21 }, (_, index) => `第 ${index + 1} 步：在 log.txt 追加一行`).join("\n"),
  leadingSlash: "/ 開頭的說明：請在 log.txt 追加一行 APPENDED",
};

// The steer reaches the session but its transcript confirmation arrives late (after the delivery window).
// `lateLine` is written right before the queued resend reads the transcript.
function lateConfirmationWrapper(cli, calls, { lateLine = enqueueLine } = {}) {
  return (provider) => ({
    ...provider,
    async sendFollowup(input) {
      calls.push({ ...input, run: undefined });
      if (input.mode === "queue" && cli.helperCalls.length > 0) {
        const first = cli.helperCalls[0];
        const entry = cli.entry(input.run.claudeShortId);
        await cli.append(entry.sessionId, lateLine(first.messageText));
      }
      return provider.sendFollowup(input);
    },
  });
}

for (const [label, body] of Object.entries(DBG04_BODIES)) {
  for (const steerOutcome of ["unconfirmed", "not-typed"]) {
    test(`DBG-04: ${label} follow-up with delayed transcript confirmation (${steerOutcome} steer) is typed at most once`, async (t) => {
      const cli = await createFakeCli(t);
      const calls = [];
      const board = createBoard(cli, { wrapProvider: lateConfirmationWrapper(cli, calls) });
      const task = createClaudeTask(board, cli);
      const run = await startRunning(board, cli, task);
      await cli.append(run.claudeSessionId, toolUseLine());

      cli.helperResponder = async () => (steerOutcome === "not-typed"
        ? { receipt: "receipt-not-typed.json" }
        : { writeTranscript: false });
      const { followup } = await board.service.sendFollowup({ taskId: task.id, body, mode: "steer", actor: USER });
      await board.service.settle();
      const converted = board.database.getFollowup(followup.id);
      assert.deepEqual([converted.mode, converted.status, converted.error], ["queue", "pending", STEER_NOT_DELIVERED_QUEUED]);

      cli.helperResponder = null;
      await finishTurn(board, cli, run);
      await board.provider.pollNow();
      await board.service.settle();

      assert.ok(cli.helperCalls.filter((call) => call.mode !== "interrupt").length <= 1, "the helper types the message at most once");
      assert.equal(board.database.getFollowup(followup.id).status, "sent");
      assert.equal(board.database.getRun(run.id).status, "finished");
      const queueCall = calls.find((call) => call.mode === "queue");
      assert.equal(queueCall.followupId, followup.id);
      assert.equal(calls.find((call) => call.mode === "steer").followupId, followup.id);
      if (label !== "short") {
        const files = (await readdir(cli.promptDir)).filter((name) => name.includes("followup"));
        assert.deepEqual(files, [`followup-${followup.id}.md`], "one stable file per follow-up");
      }
    });
  }
}

test("DBG-04: continuation path (turn ended during steer confirmation) passes followupId and does not retype a file-mode message", async (t) => {
  const cli = await createFakeCli(t);
  const calls = [];
  const board = createBoard(cli, { wrapProvider: lateConfirmationWrapper(cli, calls) });
  const task = createClaudeTask(board, cli);
  const run = await startRunning(board, cli, task);
  await cli.append(run.claudeSessionId, toolUseLine());

  const body = DBG04_BODIES.long;
  cli.helperResponder = async () => {
    // The turn finishes while the steer is still waiting for its confirmation.
    board.service.handleProviderUpdate(run.id, { status: "finished", resultText: "第一輪完成" });
    return { writeTranscript: false };
  };
  const { followup } = await board.service.sendFollowup({ taskId: task.id, body, mode: "steer", actor: USER });
  await board.service.settle();

  assert.equal(cli.helperCalls.filter((call) => call.mode !== "interrupt").length, 1, "typed once (the steer)");
  const queueCall = calls.find((call) => call.mode === "queue");
  assert.ok(queueCall, "the converted steer continued the session");
  assert.equal(queueCall.followupId, followup.id);
  assert.equal(queueCall.since, followup.createdAt);
  assert.equal(board.database.getFollowup(followup.id).status, "sent");
  assert.deepEqual((await readdir(cli.promptDir)).filter((name) => name.includes("followup")), [`followup-${followup.id}.md`]);
});

// ---------------------------------------------------------------- BUG-W8-2

// Windows desktop stop = TerminateProcess of node: nothing after `claude --bg` started runs, no settle, no dispose.
async function killDuringStart(cli, { databasePath }) {
  cli.bgHang = deferred();
  // W9 flaky fix: wait until the fake `--bg` has registered the session AND written its first transcript line.
  // Waiting only for `cli.agents.length === 1` let a test's own transcript append race that first line, so the
  // end_turn line could land before the prompt line (turn not complete → recovered as interrupted).
  const registered = deferred();
  cli.onBg = () => registered.resolve();
  const killed = createBoard(cli, { databasePath });
  const task = createClaudeTask(killed, cli);
  const { run } = await killed.service.startTask({ taskId: task.id, actor: USER });
  await registered.promise;
  cli.onBg = null;
  assert.equal(cli.agents.length, 1);
  const saved = killed.database.getRun(run.id);
  assert.equal(saved.status, "starting");
  assert.equal(saved.claudeShortId, null, "killed before the short id was known");
  assert.equal(saved.claudeLaunchToken, run.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 8), "token saved before claude --bg");
  const bg = cli.calls.find((call) => call.args[0] === "--bg");
  assert.equal(bg.args[bg.args.indexOf("-n") + 1], `${task.identifier} 整理報表 · r${saved.claudeLaunchToken}`);
  // The dead process never hears back from --bg; its late output must not be mistaken for the new board's work.
  cli.cleanups.push(async () => cli.bgHang.resolve());
  return { task, run: saved };
}

test("BUG-W8-2: force-kill before the short id was saved → restart finds the session by launch token, adopts refs, run stays controllable", async (t) => {
  const cli = await createFakeCli(t);
  const databasePath = path.join(cli.root, "killed.sqlite");
  const { task, run } = await killDuringStart(cli, { databasePath });
  const session = cli.agents[0];
  // Right after the crash `claude agents` does not list the session yet (first lookup).
  const listed = [...cli.agents];
  cli.agents.length = 0;
  let lookups = 0;
  cli.onAgents = () => {
    lookups += 1;
    if (lookups === 2) cli.agents.push(...listed);
  };

  const restarted = createBoard(cli, { databasePath });
  await restarted.service.recoverOnStartup();
  await restarted.service.settle();
  cli.onAgents = null;
  assert.ok(lookups >= 2, "the first lookup missed the session; a bounded retry found it");

  const recovered = restarted.database.getRun(run.id);
  assert.equal(recovered.status, "running");
  assert.equal(recovered.claudeShortId, session.id);
  assert.equal(recovered.claudeSessionId, session.sessionId);
  assert.equal(restarted.database.getTask(task.id).status, "in_progress");
  assert.equal(restarted.database.listComments(task.id).some((comment) => comment.body.includes("任務中斷")), false);
  assert.equal(cli.calls.filter((call) => call.args[0] === "--bg").length, 1, "no second session was started");

  const stopped = await restarted.service.stopTask({ taskId: task.id, destination: "todo", actor: USER });
  assert.equal(stopped.run.status, "stopped");
  assert.equal(cli.interrupts(), 1, "stop reached the adopted session");
  await restarted.service.archiveTask({ taskId: task.id, actor: USER });
  assert.ok(cli.calls.some((call) => call.args[0] === "stop" && call.args[1] === session.id), "archive runs claude stop <adopted id>");
});

test("BUG-W8-2: adopted session that already finished its turn → run finished with the result and refs", async (t) => {
  const cli = await createFakeCli(t);
  const databasePath = path.join(cli.root, "killed-finished.sqlite");
  const { task, run } = await killDuringStart(cli, { databasePath });
  const session = cli.agents[0];
  await cli.append(session.sessionId, endTurnLine("報表已整理"));
  Object.assign(session, { status: "idle", state: "done" });

  const restarted = createBoard(cli, { databasePath });
  await restarted.service.recoverOnStartup();
  await restarted.service.settle();

  const recovered = restarted.database.getRun(run.id);
  assert.equal(recovered.status, "finished");
  assert.equal(recovered.claudeShortId, session.id);
  assert.equal(recovered.resultText, "報表已整理");
  assert.equal(restarted.database.getTask(task.id).status, "in_review");
});

test("BUG-W8-2: no session with the launch token (or only one in another folder) after bounded retries → interrupted as before", async (t) => {
  const cli = await createFakeCli(t);
  const databasePath = path.join(cli.root, "killed-missing.sqlite");
  const { task, run } = await killDuringStart(cli, { databasePath });
  const session = cli.agents[0];
  session.cwd = path.join(cli.root, "other-folder");
  cli.agents.push({ pid: 5001, id: "e0000001", cwd: cli.cwd, kind: "background", startedAt: Date.now(), sessionId: "e0000001-x", name: "別的卡 · rzzzzzzzz", status: "busy", state: "working" });

  const restarted = createBoard(cli, { databasePath });
  const agentsBefore = cli.agentsCalls;
  await restarted.service.recoverOnStartup();
  await restarted.service.settle();

  assert.equal(cli.agentsCalls - agentsBefore, 3, "looked up recoverLookupAttempts times");
  const saved = restarted.database.getRun(run.id);
  assert.equal(saved.status, "interrupted");
  assert.equal(saved.claudeShortId, null);
  assert.equal(restarted.database.getTask(task.id).status, "blocked");
});
