// v2 integration (I-S): live run activity (TICKETS Amendment 2).
import assert from "node:assert/strict";
import { test } from "node:test";

import { activityForCodexItem, createCodexAppProvider } from "../server/runs/codex-app.mjs";
import { ACTIVITY_LIMIT_PER_RUN, createRunService } from "../server/runs/service.mjs";

const silentLogger = { info() {}, warn() {}, error() {} };

function createFakeAppServer() {
  const listeners = new Set();
  let turnCounter = 0;
  const fake = {
    child: undefined,
    calls: [],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify(method, params) {
      for (const listener of [...listeners]) listener({ method, params }, undefined);
    },
    async request(method, params) {
      fake.calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "thread-1" } };
      if (method === "turn/start") return { turn: { id: `turn-${++turnCounter}` } };
      return {};
    },
    startThread(params) { return fake.request("thread/start", params); },
    resumeThread(params) { return fake.request("thread/resume", params); },
    startTurn(params) { return fake.request("turn/start", params); },
    interruptTurn(params) { return fake.request("turn/interrupt", params); },
    steerTurn(params) { return fake.request("turn/steer", params); },
    async close() {},
  };
  return fake;
}

test("activityForCodexItem maps agentMessage, commandExecution, fileChange and mcpToolCall", () => {
  assert.deepEqual(activityForCodexItem({ type: "agentMessage", text: "好了" }), { kind: "message", text: "好了" });
  assert.deepEqual(activityForCodexItem({ type: "commandExecution", command: "npm test" }), { kind: "command", text: "npm test" });
  assert.deepEqual(
    activityForCodexItem({ type: "fileChange", changes: [{ path: "a.txt" }, { path: "b/c.md" }, {}] }),
    { kind: "file", text: "a.txt\nb/c.md" },
  );
  assert.deepEqual(activityForCodexItem({ type: "mcpToolCall", server: "fs", tool: "read" }), { kind: "tool", text: "fs.read" });
  assert.equal(activityForCodexItem({ type: "agentMessage", text: "   " }), null);
  assert.equal(activityForCodexItem({ type: "reasoning", text: "x" }), null);
  assert.equal(activityForCodexItem(null), null);
  const long = activityForCodexItem({ type: "commandExecution", command: "x".repeat(5000) });
  assert.equal(long.text.length, 2000);
});

test("Codex provider reports each item once from item/started or item/completed", async () => {
  const appServer = createFakeAppServer();
  const updates = [];
  const provider = createCodexAppProvider({
    appServer,
    onUpdate: (runId, update) => updates.push({ runId, update }),
    logger: silentLogger,
  });
  await provider.start({ runId: "run-1", cwd: "/w", prompt: "p", title: "t" });
  updates.length = 0;
  const base = { threadId: "thread-1", turnId: "turn-1" };
  appServer.notify("item/started", { ...base, item: { type: "commandExecution", id: "c1", command: "dir" } });
  appServer.notify("item/completed", { ...base, item: { type: "commandExecution", id: "c1", command: "dir", exitCode: 0 } });
  appServer.notify("item/started", { ...base, item: { type: "agentMessage", id: "m1", text: "" } });
  appServer.notify("item/completed", { ...base, item: { type: "agentMessage", id: "m1", text: "整理完成" } });
  appServer.notify("item/started", { ...base, item: { type: "fileChange", id: "f1", changes: [{ path: "out.md" }] } });
  appServer.notify("item/started", { ...base, item: { type: "mcpToolCall", server: "docs", tool: "search" } });
  appServer.notify("item/completed", { ...base, item: { type: "mcpToolCall", server: "docs", tool: "search" } });
  appServer.notify("item/completed", { threadId: "thread-other", turnId: "x", item: { type: "agentMessage", id: "z", text: "ignored" } });

  assert.deepEqual(updates.map(({ update }) => update.activity), [
    { kind: "command", text: "dir" },
    { kind: "message", text: "整理完成" },
    { kind: "file", text: "out.md" },
    { kind: "tool", text: "docs.search" },
  ]);
  assert.equal(updates.every(({ runId, update }) => runId === "run-1" && update.status === undefined), true);

  appServer.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
  updates.length = 0;
  // Items of an already completed turn are not reported.
  appServer.notify("item/completed", { ...base, item: { type: "agentMessage", id: "late", text: "late" } });
  assert.deepEqual(updates, []);
  await provider.dispose();
});

function fakeDatabase() {
  const tasks = new Map([["task-1", { id: "task-1", projectId: "proj", status: "in_progress" }]]);
  const runs = new Map([["run-1", { id: "run-1", taskId: "task-1", provider: "codex", status: "running" }]]);
  return {
    getTask: (id) => tasks.get(id) ?? null,
    getRun: (id) => runs.get(id) ?? null,
    updateRun: () => {
      throw new Error("activity must not write the database");
    },
  };
}

test("run service keeps the last activities per run in memory and emits run.activity", async () => {
  const events = [];
  const service = createRunService({
    database: fakeDatabase(),
    providers: {},
    emit: (type, payload) => events.push({ type, payload }),
    buildPrompt: () => "",
    now: () => "2026-09-17T00:00:00.000Z",
    logger: silentLogger,
  });
  for (let index = 0; index < ACTIVITY_LIMIT_PER_RUN + 5; index += 1) {
    await service.handleProviderUpdate("run-1", { activity: { kind: "command", text: `step ${index}` } });
  }
  const entries = service.listActivity("run-1");
  assert.equal(entries.length, ACTIVITY_LIMIT_PER_RUN);
  assert.deepEqual(entries[0], { kind: "command", text: "step 5", at: "2026-09-17T00:00:00.000Z" });
  assert.equal(entries.at(-1).text, `step ${ACTIVITY_LIMIT_PER_RUN + 4}`);
  assert.equal(events.length, ACTIVITY_LIMIT_PER_RUN + 5);
  assert.deepEqual(events[0], {
    type: "run.activity",
    payload: {
      projectId: "proj",
      taskId: "task-1",
      runId: "run-1",
      activity: { kind: "command", text: "step 0", at: "2026-09-17T00:00:00.000Z" },
    },
  });

  // Malformed activity and unknown runs are ignored; the returned list is a copy.
  await service.handleProviderUpdate("run-1", { activity: { kind: "bogus", text: "x" } });
  await service.handleProviderUpdate("run-1", { activity: { kind: "message", text: "  " } });
  await service.handleProviderUpdate("missing", { activity: { kind: "message", text: "x" } });
  assert.equal(events.length, ACTIVITY_LIMIT_PER_RUN + 5);
  entries.length = 0;
  assert.equal(service.listActivity("run-1").length, ACTIVITY_LIMIT_PER_RUN);
  assert.deepEqual(service.listActivity("missing"), []);
});
