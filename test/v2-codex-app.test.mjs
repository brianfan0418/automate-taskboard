import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { CodexAppServer, CodexHostAppServer } from "../server/codex-app-server.mjs";
import { createCodexAppProvider } from "../server/runs/codex-app.mjs";

const silentLogger = { info() {}, warn() {}, error() {} };

function createFakeAppServer({ child = undefined } = {}) {
  const listeners = new Set();
  let threadCounter = 0;
  let turnCounter = 0;
  const defaults = {
    "thread/start": () => ({ thread: { id: `thread-${++threadCounter}` } }),
    "thread/resume": (params) => ({ thread: { id: params.threadId } }),
    "turn/start": () => ({ turn: { id: `turn-${++turnCounter}`, status: "inProgress", items: [] } }),
    "turn/interrupt": () => ({}),
    "turn/steer": (params) => ({ turnId: params.expectedTurnId }),
  };
  const fake = {
    child,
    calls: [],
    handlers: {},
    closed: false,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listenerCount() {
      return listeners.size;
    },
    notify(method, params, emitChild = fake.child) {
      for (const listener of [...listeners]) listener({ method, params }, emitChild);
    },
    async request(method, params) {
      fake.calls.push({ method, params });
      const handler = fake.handlers[method] ?? defaults[method];
      return handler ? handler(params) : undefined;
    },
    startThread(params) { return fake.request("thread/start", params); },
    resumeThread(params) { return fake.request("thread/resume", params); },
    startTurn(params) { return fake.request("turn/start", params); },
    interruptTurn(params) { return fake.request("turn/interrupt", params); },
    steerTurn(params) { return fake.request("turn/steer", params); },
    async close() { fake.closed = true; },
  };
  fake.methods = () => fake.calls.map((call) => call.method);
  return fake;
}

function setup(extra = {}) {
  const appServer = extra.appServer ?? createFakeAppServer();
  const updates = [];
  const onUpdate = extra.onUpdate ?? ((runId, update) => updates.push({ runId, update }));
  const provider = createCodexAppProvider({
    appServer,
    onUpdate,
    logger: silentLogger,
    ...extra.options,
  });
  return { appServer, updates, provider };
}

function runRow(overrides = {}) {
  return {
    id: "run-1",
    taskId: "task-1",
    provider: "codex",
    status: "running",
    claudeShortId: null,
    claudeSessionId: null,
    claudeBridgeSessionId: null,
    codexThreadId: "thread-1",
    codexTurnId: "turn-1",
    resultText: null,
    error: null,
    ...overrides,
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("CodexAppServer.steerTurn sends a turn/steer JSON-RPC request with exact params", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-v2-codex-steer-"));
  const executable = path.join(directory, "fake-codex.mjs");
  await writeFile(executable, `
const args = process.argv.slice(2);
if (args[0] !== "app-server") process.exit(2);
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    } else if (message.method === "turn/steer") {
      process.stdout.write(JSON.stringify({
        id: message.id,
        result: { turnId: message.params.expectedTurnId, echoMethod: message.method, echoParams: message.params },
      }) + "\\n");
    } else {
      process.stdout.write(JSON.stringify({ id: message.id, error: { message: "unexpected " + message.method } }) + "\\n");
    }
  }
});
`);
  const appServer = new CodexAppServer({ executable, requestTimeoutMs: 10_000 });
  try {
    const input = [{ type: "text", text: "請改用繁體中文" }];
    const result = await appServer.steerTurn({
      threadId: "thread-a",
      input,
      expectedTurnId: "turn-a",
    });
    assert.equal(result.turnId, "turn-a");
    assert.equal(result.echoMethod, "turn/steer");
    assert.deepEqual(result.echoParams, { threadId: "thread-a", input, expectedTurnId: "turn-a" });
  } finally {
    await appServer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CodexHostAppServer.steerTurn forwards turn/steer through the host bridge", async () => {
  let handler;
  const sent = [];
  const ipc = {
    connected: true,
    on(event, listener) { if (event === "message") handler = listener; },
    off() {},
    send(message, callback) {
      sent.push(message);
      callback?.();
    },
  };
  const host = new CodexHostAppServer({ hostId: "host-1", ipc, requestTimeoutMs: 5_000 });
  const input = [{ type: "text", text: "steer" }];
  const pending = host.steerTurn({ threadId: "thread-h", input, expectedTurnId: "turn-h" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "turn/steer");
  assert.deepEqual(sent[0].params, { threadId: "thread-h", input, expectedTurnId: "turn-h" });
  handler({
    type: "taskboard:codex-app-server-response",
    hostId: "host-1",
    requestId: sent[0].requestId,
    result: { turnId: "turn-h" },
  });
  assert.deepEqual(await pending, { turnId: "turn-h" });
  await host.close();
});

test("start creates a workspace-write/never thread, starts a text turn, and returns refs", async () => {
  const { appServer, updates, provider } = setup();
  assert.equal(provider.name, "codex");
  const refs = await provider.start({
    runId: "run-1",
    cwd: "C:\\work\\project",
    prompt: "做這個任務",
    model: "gpt-5.5",
    effort: "high",
    title: "TB-1 任務",
  });
  assert.deepEqual(refs, { codexThreadId: "thread-1", codexTurnId: "turn-1" });
  assert.deepEqual(appServer.calls, [
    {
      method: "thread/start",
      params: {
        model: "gpt-5.5",
        cwd: "C:\\work\\project",
        approvalPolicy: "never",
      },
    },
    {
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "做這個任務" }],
        effort: "high",
      },
    },
  ]);
  assert.deepEqual(updates, [{
    runId: "run-1",
    update: { status: "running", refs: { codexThreadId: "thread-1", codexTurnId: "turn-1" } },
  }]);
  await provider.dispose();
});

test("start omits model/effort when not given and emits running only once", async () => {
  const { appServer, updates, provider } = setup();
  appServer.handlers["turn/start"] = async () => {
    // turn/started delivered before the turn/start response.
    appServer.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-x" } });
    return { turn: { id: "turn-x" } };
  };
  await provider.start({ runId: "run-1", cwd: "/w", prompt: "p", title: "t" });
  assert.deepEqual(appServer.calls[0].params, { cwd: "/w", approvalPolicy: "never" });
  assert.deepEqual(appServer.calls[1].params, { threadId: "thread-1", input: [{ type: "text", text: "p" }] });
  assert.equal(updates.filter(({ update }) => update.status === "running").length, 1);
  await provider.dispose();
});

test("turn notifications: turn/started updates turn id, last agentMessage becomes resultText", async () => {
  const { appServer, updates, provider } = setup();
  await provider.start({ runId: "run-1", cwd: "/w", prompt: "p", title: "t" });
  updates.length = 0;

  appServer.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-9" } });
  appServer.notify("item/completed", { threadId: "thread-1", turnId: "turn-9", item: { type: "agentMessage", id: "i1", text: "第一段" } });
  appServer.notify("item/completed", { threadId: "thread-1", turnId: "turn-9", item: { type: "commandExecution", id: "i2", command: "ls" } });
  appServer.notify("item/completed", { threadId: "thread-1", turnId: "turn-9", item: { type: "agentMessage", id: "i3", text: "最後結果" } });
  // Other threads are ignored.
  appServer.notify("item/completed", { threadId: "thread-other", turnId: "turn-z", item: { type: "agentMessage", text: "x" } });
  appServer.notify("turn/completed", { threadId: "thread-other", turn: { id: "turn-z", status: "completed" } });
  appServer.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-9", status: "completed", items: [] } });

  assert.deepEqual(updates, [
    { runId: "run-1", update: { refs: { codexTurnId: "turn-9" } } },
    { runId: "run-1", update: { activity: { kind: "message", text: "第一段" } } },
    { runId: "run-1", update: { activity: { kind: "command", text: "ls" } } },
    { runId: "run-1", update: { activity: { kind: "message", text: "最後結果" } } },
    { runId: "run-1", update: { status: "finished", resultText: "最後結果" } },
  ]);
  // Duplicate completion is ignored.
  appServer.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-9", status: "completed" } });
  assert.equal(updates.length, 5);
  await provider.dispose();
});

test("finished resultText falls back to turn items, then to empty string", async () => {
  const { appServer, updates, provider } = setup();
  await provider.start({ runId: "run-a", cwd: "/w", prompt: "p", title: "t" });
  appServer.notify("turn/completed", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "completed", items: [{ type: "agentMessage", text: "from items" }, { type: "fileChange" }] },
  });
  await provider.start({ runId: "run-b", cwd: "/w", prompt: "p", title: "t" });
  appServer.notify("turn/completed", { threadId: "thread-2", turn: { id: "turn-2", status: "completed" } });
  const finished = updates.filter(({ update }) => update.status === "finished");
  assert.deepEqual(finished, [
    { runId: "run-a", update: { status: "finished", resultText: "from items" } },
    { runId: "run-b", update: { status: "finished", resultText: "" } },
  ]);
  await provider.dispose();
});

test("turn/completed interrupted → stopped; failed → failed with error", async () => {
  const { appServer, updates, provider } = setup();
  await provider.start({ runId: "run-a", cwd: "/w", prompt: "p", title: "t" });
  await provider.start({ runId: "run-b", cwd: "/w", prompt: "p", title: "t" });
  await provider.start({ runId: "run-c", cwd: "/w", prompt: "p", title: "t" });
  updates.length = 0;
  appServer.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } });
  appServer.notify("turn/completed", { threadId: "thread-2", turn: { id: "turn-2", status: "failed", error: { message: "quota exceeded" } } });
  appServer.notify("turn/completed", { threadId: "thread-3", turn: { id: "turn-3", status: "failed", error: null } });
  assert.deepEqual(updates, [
    { runId: "run-a", update: { status: "stopped" } },
    { runId: "run-b", update: { status: "failed", error: "quota exceeded" } },
    { runId: "run-c", update: { status: "failed", error: "Codex reported a failed turn" } },
  ]);
  await provider.dispose();
});

test("app-server/terminated interrupts running runs only; next queue resumes the thread", async () => {
  const { appServer, updates, provider } = setup();
  await provider.start({ runId: "run-a", cwd: "/w", prompt: "p", model: "m1", effort: "low", title: "t" });
  await provider.start({ runId: "run-b", cwd: "/w2", prompt: "p", title: "t" });
  appServer.notify("turn/completed", { threadId: "thread-2", turn: { id: "turn-2", status: "completed" } });
  updates.length = 0;

  appServer.notify("app-server/terminated", { message: "Codex app-server exited (1)" });
  assert.deepEqual(updates, [
    { runId: "run-a", update: { status: "interrupted", error: "Codex app-server exited (1)" } },
  ]);

  appServer.calls.length = 0;
  const result = await provider.sendFollowup({
    run: runRow({ id: "run-a", codexThreadId: "thread-1", codexTurnId: "turn-1" }),
    body: "繼續",
    mode: "queue",
  });
  assert.equal(result.delivered, true);
  assert.deepEqual(appServer.calls, [
    {
      method: "thread/resume",
      params: { threadId: "thread-1", model: "m1", cwd: "/w", approvalPolicy: "never" },
    },
    {
      method: "turn/start",
      params: { threadId: "thread-1", input: [{ type: "text", text: "繼續" }], effort: "low" },
    },
  ]);
  await provider.dispose();
});

test("terminated from an older app-server child does not interrupt runs on the current child", async () => {
  const oldChild = { pid: 1 };
  const newChild = { pid: 2 };
  const appServer = createFakeAppServer({ child: newChild });
  const { updates, provider } = setup({ appServer });
  await provider.start({ runId: "run-a", cwd: "/w", prompt: "p", title: "t" });
  updates.length = 0;
  appServer.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }, oldChild);
  appServer.notify("app-server/terminated", { message: "old exited" }, oldChild);
  assert.deepEqual(updates, []);
  appServer.notify("app-server/terminated", { message: "current exited" }, newChild);
  assert.deepEqual(updates, [{ runId: "run-a", update: { status: "interrupted", error: "current exited" } }]);
  await provider.dispose();
});

test("sendFollowup steer calls turn/steer with expectedTurnId = run.codexTurnId", async () => {
  const { appServer, provider } = setup();
  await provider.start({ runId: "run-1", cwd: "/w", prompt: "p", title: "t" });
  appServer.calls.length = 0;

  const run = runRow({ codexTurnId: "turn-1" });
  const delivered = await provider.sendFollowup({ run, body: "改成藍色", mode: "steer" });
  assert.deepEqual(delivered, { delivered: true, detail: "Steered Codex turn turn-1" });
  assert.deepEqual(appServer.calls, [{
    method: "turn/steer",
    params: { threadId: "thread-1", input: [{ type: "text", text: "改成藍色" }], expectedTurnId: "turn-1" },
  }]);

  appServer.handlers["turn/steer"] = async () => {
    throw new Error("Codex app-server rejected 'turn/steer': expected turn mismatch");
  };
  const rejected = await provider.sendFollowup({ run, body: "again", mode: "steer" });
  assert.equal(rejected.delivered, false);
  assert.match(rejected.detail, /expected turn mismatch/);

  const noTurn = await provider.sendFollowup({
    run: runRow({ id: "unknown", codexThreadId: "thread-x", codexTurnId: null }),
    body: "x",
    mode: "steer",
  });
  assert.deepEqual(noTurn, { delivered: false, detail: "No Codex turn to steer" });
  await assert.rejects(provider.sendFollowup({ run, body: "x", mode: "bogus" }), /mode/);
  await provider.dispose();
});

test("sendFollowup queue: rejected while running, starts next turn in the same thread when idle", async () => {
  const { appServer, updates, provider } = setup();
  await provider.start({ runId: "run-1", cwd: "/w", prompt: "p", effort: "medium", title: "t" });
  appServer.calls.length = 0;

  const busy = await provider.sendFollowup({ run: runRow(), body: "下一步", mode: "queue" });
  assert.deepEqual(busy, { delivered: false, detail: "Codex turn is still running; use steer" });
  assert.deepEqual(appServer.calls, []);

  appServer.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
  updates.length = 0;
  const queued = await provider.sendFollowup({ run: runRow(), body: "下一步", mode: "queue" });
  assert.deepEqual(queued, { delivered: true, detail: "Started Codex turn turn-2" });
  // Thread is still loaded on this app-server: no thread/resume.
  assert.deepEqual(appServer.methods(), ["turn/start"]);
  assert.deepEqual(appServer.calls[0].params, {
    threadId: "thread-1",
    input: [{ type: "text", text: "下一步" }],
    effort: "medium",
  });
  assert.deepEqual(updates, [{
    runId: "run-1",
    update: { status: "running", refs: { codexThreadId: "thread-1", codexTurnId: "turn-2" } },
  }]);

  appServer.notify("item/completed", { threadId: "thread-1", turnId: "turn-2", item: { type: "agentMessage", text: "done 2" } });
  appServer.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-2", status: "completed" } });
  assert.deepEqual(updates.at(-1), { runId: "run-1", update: { status: "finished", resultText: "done 2" } });

  appServer.handlers["turn/start"] = async () => { throw new Error("boom"); };
  const failed = await provider.sendFollowup({ run: runRow({ codexTurnId: "turn-2" }), body: "x", mode: "queue" });
  assert.equal(failed.delivered, false);
  assert.match(failed.detail, /boom/);
  await provider.dispose();
});

test("finished handler can synchronously queue the next follow-up (re-entrant onUpdate)", async () => {
  const appServer = createFakeAppServer();
  const updates = [];
  const deliveries = [];
  let provider;
  const onUpdate = (runId, update) => {
    updates.push({ runId, update });
    if (update.status === "finished" && deliveries.length === 0) {
      deliveries.push(provider.sendFollowup({ run: runRow({ id: runId }), body: "排隊的追問", mode: "queue" }));
    }
  };
  ({ provider } = setup({ appServer, onUpdate }));
  await provider.start({ runId: "run-1", cwd: "/w", prompt: "p", title: "t" });
  appServer.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
  assert.deepEqual(await deliveries[0], { delivered: true, detail: "Started Codex turn turn-2" });
  assert.deepEqual(updates.at(-1), {
    runId: "run-1",
    update: { status: "running", refs: { codexThreadId: "thread-1", codexTurnId: "turn-2" } },
  });
  await provider.dispose();
});

test("continue with a new run row rebinds the thread so updates go to the new run", async () => {
  const { appServer, updates, provider } = setup();
  await provider.start({ runId: "run-old", cwd: "/w", prompt: "p", title: "t" });
  appServer.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
  updates.length = 0;

  const newRun = runRow({ id: "run-new", codexThreadId: "thread-1", codexTurnId: "turn-1", status: "starting" });
  const result = await provider.sendFollowup({ run: newRun, body: "再改一下", mode: "queue" });
  assert.equal(result.delivered, true);
  appServer.notify("item/completed", { threadId: "thread-1", turnId: "turn-2", item: { type: "agentMessage", text: "改好了" } });
  appServer.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-2", status: "completed" } });
  assert.deepEqual(updates, [
    { runId: "run-new", update: { status: "running", refs: { codexThreadId: "thread-1", codexTurnId: "turn-2" } } },
    { runId: "run-new", update: { activity: { kind: "message", text: "改好了" } } },
    { runId: "run-new", update: { status: "finished", resultText: "改好了" } },
  ]);
  assert.equal(provider.openUrl(newRun), "codex://threads/thread-1");
  await provider.dispose();
});

test("stop sends turn/interrupt and resolves when the turn ends", async () => {
  const { appServer, updates, provider } = setup();
  await provider.start({ runId: "run-1", cwd: "/w", prompt: "p", title: "t" });
  appServer.calls.length = 0;
  updates.length = 0;

  const stopping = provider.stop({ run: runRow() });
  await flush();
  assert.deepEqual(appServer.calls, [{ method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } }]);
  appServer.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } });
  const result = await stopping;
  assert.equal(result.stopped, true);
  assert.match(result.detail, /turn-1 ended \(interrupted\)/);
  assert.deepEqual(updates, [{ runId: "run-1", update: { status: "stopped" } }]);

  appServer.calls.length = 0;
  assert.deepEqual(await provider.stop({ run: runRow() }), { stopped: true, detail: "No Codex turn is running" });
  assert.deepEqual(appServer.calls, []);
  await provider.dispose();
});

test("stop handles completion racing the interrupt response, rejection, and timeout", async () => {
  const { appServer, provider } = setup({ options: { stopTimeoutMs: 20 } });
  await provider.start({ runId: "run-a", cwd: "/w", prompt: "p", title: "t" });
  appServer.handlers["turn/interrupt"] = async (params) => {
    appServer.notify("turn/completed", { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } });
    return {};
  };
  const raced = await provider.stop({ run: runRow({ id: "run-a" }) });
  assert.equal(raced.stopped, true);

  await provider.start({ runId: "run-b", cwd: "/w", prompt: "p", title: "t" });
  appServer.handlers["turn/interrupt"] = async () => { throw new Error("no active turn"); };
  const rejected = await provider.stop({ run: runRow({ id: "run-b", codexThreadId: "thread-2", codexTurnId: "turn-2" }) });
  assert.equal(rejected.stopped, false);
  assert.match(rejected.detail, /no active turn/);

  appServer.handlers["turn/interrupt"] = async () => ({});
  const timedOut = await provider.stop({ run: runRow({ id: "run-b", codexThreadId: "thread-2", codexTurnId: "turn-2" }) });
  assert.equal(timedOut.stopped, false);
  assert.match(timedOut.detail, /did not end within 20ms/);
  await provider.dispose();
});

test("start failures reject and leave no tracked run", async () => {
  const { appServer, updates, provider } = setup();
  appServer.handlers["thread/start"] = async () => { throw new Error("not logged in"); };
  await assert.rejects(provider.start({ runId: "run-1", cwd: "/w", prompt: "p", title: "t" }), /not logged in/);

  appServer.handlers["thread/start"] = async () => ({ thread: {} });
  await assert.rejects(provider.start({ runId: "run-1", cwd: "/w", prompt: "p", title: "t" }), /thread id/);

  appServer.handlers["thread/start"] = async () => ({ thread: { id: "thread-f" } });
  appServer.handlers["turn/start"] = async () => { throw new Error("model not found"); };
  await assert.rejects(provider.start({ runId: "run-1", cwd: "/w", prompt: "p", title: "t" }), /model not found/);
  appServer.notify("turn/completed", { threadId: "thread-f", turn: { id: "turn-f", status: "completed" } });
  assert.deepEqual(updates, []);

  await assert.rejects(provider.start({ runId: "run-2", cwd: "", prompt: "p", title: "t" }), /cwd/);
  await provider.dispose();
});

test("openUrl, recover, close, available", async () => {
  const { appServer, provider } = setup({ options: { codexVersion: async () => "codex-cli 0.147.0\n" } });
  assert.equal(provider.openUrl(runRow({ codexThreadId: "019a-thread" })), "codex://threads/019a-thread");
  assert.equal(provider.openUrl(runRow({ codexThreadId: null })), null);
  assert.deepEqual(await provider.recover(runRow()), { status: "interrupted" });
  assert.equal(await provider.close({ run: runRow() }), undefined);
  assert.deepEqual(appServer.calls, []);
  assert.deepEqual(await provider.available(), { ok: true, version: "codex-cli 0.147.0" });

  const missing = createCodexAppProvider({ appServer, onUpdate() {}, logger: silentLogger, codexVersion: async () => null });
  assert.deepEqual(await missing.available(), { ok: false, reason: "Codex CLI was not found" });
  const failing = createCodexAppProvider({
    appServer,
    onUpdate() {},
    logger: silentLogger,
    codexVersion: async () => { throw new Error("spawn codex ENOENT"); },
  });
  assert.deepEqual(await failing.available(), { ok: false, reason: "spawn codex ENOENT" });
  const unconfigured = createCodexAppProvider({ appServer, onUpdate() {}, logger: silentLogger });
  assert.equal((await unconfigured.available()).ok, false);
  await provider.dispose();
});

test("app-server ownership: injected instance is not closed; factory instance is lazy and closed", async () => {
  const injected = createFakeAppServer();
  const { provider } = setup({ appServer: injected });
  await provider.start({ runId: "run-1", cwd: "/w", prompt: "p", title: "t" });
  assert.equal(injected.listenerCount(), 1);
  await provider.dispose();
  assert.equal(injected.listenerCount(), 0);
  assert.equal(injected.closed, false);

  let created = 0;
  let factoryServer;
  const owned = createCodexAppProvider({
    onUpdate() {},
    logger: silentLogger,
    appServerFactory: () => {
      created += 1;
      factoryServer = createFakeAppServer();
      return factoryServer;
    },
  });
  assert.equal(created, 0);
  await owned.start({ runId: "run-1", cwd: "/w", prompt: "p", title: "t" });
  await owned.start({ runId: "run-2", cwd: "/w", prompt: "p", title: "t" });
  assert.equal(created, 1);
  await owned.dispose();
  assert.equal(factoryServer.closed, true);
  await assert.rejects(owned.start({ runId: "run-3", cwd: "/w", prompt: "p", title: "t" }), /disposed/);

  assert.throws(() => createCodexAppProvider({ appServer: injected }), /onUpdate/);
  assert.throws(() => createCodexAppProvider({ onUpdate() {} }), /appServer/);
});
