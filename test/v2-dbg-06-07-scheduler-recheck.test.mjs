// DBG-06 / DBG-07 regressions: the auto-claim callback re-reads the project automation (enabled)
// and the active-run count after the provider availability await, right before starting a run.
// Real createTaskboardServer wiring (scheduler callback + runService + SQLite), fake providers whose
// available() can be held open, loopback HTTP only. Manual starts stay unlimited (D9).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/app.mjs";
import { createScheduler } from "../server/runs/scheduler.mjs";

const quiet = { info() {}, warn() {}, error() {} };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate, label) {
  for (let index = 0; index < 2000; index += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(`timeout waiting for ${label}`);
}

function fakeProvider(name) {
  const provider = {
    name,
    starts: [],
    availableCalls: 0,
    gate: null,
    async available() {
      provider.availableCalls += 1;
      if (provider.gate) await provider.gate.promise;
      return { ok: true, version: `${name}-test` };
    },
    async start(input) {
      provider.starts.push(input.runId);
      return name === "codex"
        ? { codexThreadId: `thread-${input.runId}`, codexTurnId: "turn-1" }
        : { claudeShortId: "short-1", claudeSessionId: "session-1", claudeBridgeSessionId: "bridge-1" };
    },
    async sendFollowup() { return { delivered: true }; },
    async stop() { return { stopped: true }; },
    async close() {},
    openUrl() { return null; },
    async recover() { return { status: "interrupted" }; },
    async dispose() {},
  };
  return provider;
}

async function startBoard(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-dbg0607-"));
  const providers = { claude: fakeProvider("claude"), codex: fakeProvider("codex") };
  const app = createTaskboardServer({
    dataDirectory: path.join(directory, "data"),
    runProviders: providers,
    enableScheduler: false,
    runLogger: quiet,
    mobileAccess: false,
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  await app.whenStarted();
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const api = async (pathname, { method = "GET", body } = {}) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  const project = async (id) => {
    const workspacePath = path.join(directory, "ws", id);
    await mkdir(workspacePath, { recursive: true });
    const created = await api("/api/projects", { method: "POST", body: { id, name: id, workspacePath } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
  };
  const task = async (projectId, title, assigneeTarget = "codex-agent", priority = "none") => {
    const created = await api("/api/tasks", {
      method: "POST",
      body: { projectId, title, status: "todo", assigneeTarget, priority },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.task;
  };
  const getTask = async (id) => (await api(`/api/tasks/${id}`)).body.task;
  return { app, api, providers, project, task, getTask };
}

test("DBG-06: turning auto-claim off while the scheduler awaits provider availability dispatches nothing", async (t) => {
  const board = await startBoard(t);
  await board.project("work");
  const a = await board.task("work", "card a", "codex-agent", "urgent");
  const b = await board.task("work", "card b", "codex-agent", "high");
  const enabled = await board.api("/api/projects/work/automation", { method: "PUT", body: { enabled: true, maxParallel: 3 } });
  assert.equal(enabled.status, 200);

  board.providers.codex.gate = deferred();
  const ticking = board.app.scheduler.tick();
  await until(() => board.providers.codex.availableCalls === 1, "availability probe");
  const off = await board.api("/api/projects/work/automation", { method: "PUT", body: { enabled: false } });
  assert.equal(off.status, 200);
  assert.equal(off.body.automation.enabled, false);
  board.providers.codex.gate.resolve();
  const result = await ticking;
  await board.app.runService.settle();

  assert.deepEqual(result.started, []);
  assert.equal(board.providers.codex.starts.length, 0);
  for (const card of [a, b]) {
    const current = await board.getTask(card.id);
    assert.equal(current.status, "todo");
    assert.equal(current.latestRun, null);
  }
});

test("scheduler recheck: a dependency added while the scheduler awaits provider availability blocks the claim", async (t) => {
  const board = await startBoard(t);
  await board.project("work");
  const card = await board.task("work", "card blocked later", "codex-agent", "urgent");
  const enabled = await board.api("/api/projects/work/automation", { method: "PUT", body: { enabled: true, maxParallel: 3 } });
  assert.equal(enabled.status, 200);

  board.providers.codex.gate = deferred();
  const ticking = board.app.scheduler.tick();
  await until(() => board.providers.codex.availableCalls === 1, "availability probe");
  const blocker = await board.api("/api/tasks", { method: "POST", body: { projectId: "work", title: "blocker", status: "backlog" } });
  assert.equal(blocker.status, 201, JSON.stringify(blocker.body));
  const related = await board.api(`/api/tasks/${blocker.body.task.id}/relations/blocks/${card.id}`, {
    method: "POST",
    body: { version: blocker.body.task.version },
  });
  assert.equal(related.status, 200, JSON.stringify(related.body));
  board.providers.codex.gate.resolve();
  const result = await ticking;
  await board.app.runService.settle();

  assert.deepEqual(result.started, []);
  assert.equal(board.providers.codex.starts.length, 0);
  const current = await board.getTask(card.id);
  assert.equal(current.status, "todo");
  assert.equal(current.latestRun, null);

  // Once the blocker is done the card is claimed as usual.
  const blockerNow = await board.getTask(blocker.body.task.id);
  const done = await board.api(`/api/tasks/${blockerNow.id}/move`, { method: "POST", body: { version: blockerNow.version, status: "done" } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const later = await board.app.scheduler.tick();
  await board.app.runService.settle();
  assert.deepEqual(later.started, [card.id]);
});

test("DBG-06: a stale snapshot of another project (turned off during the first project's probe) is not dispatched", async (t) => {
  const board = await startBoard(t);
  await board.project("alpha");
  await board.project("beta");
  const alphaCard = await board.task("alpha", "alpha claude card", "claude-agent");
  const betaCard = await board.task("beta", "beta codex card", "codex-agent");
  await board.api("/api/projects/alpha/automation", { method: "PUT", body: { enabled: true } });
  await board.api("/api/projects/beta/automation", { method: "PUT", body: { enabled: true } });

  board.providers.claude.gate = deferred();
  const ticking = board.app.scheduler.tick();
  await until(() => board.providers.claude.availableCalls === 1, "claude probe");
  const off = await board.api("/api/projects/beta/automation", { method: "PUT", body: { enabled: false } });
  assert.equal(off.status, 200);
  board.providers.claude.gate.resolve();
  const result = await ticking;
  await board.app.runService.settle();

  assert.deepEqual(result.started, [alphaCard.id]);
  assert.equal(board.providers.codex.starts.length, 0);
  const beta = await board.getTask(betaCard.id);
  assert.equal(beta.status, "todo");
  assert.equal(beta.latestRun, null);
});

test("DBG-07: a manual start that fills maxParallel during the availability probe stops the auto dispatch", async (t) => {
  const board = await startBoard(t);
  await board.project("work");
  const auto = await board.task("work", "A auto candidate", "codex-agent", "urgent");
  const manual = await board.task("work", "B manual", "codex-agent", "low");
  await board.api("/api/projects/work/automation", { method: "PUT", body: { enabled: true, maxParallel: 1, orderMode: "suggested" } });

  board.providers.codex.gate = deferred();
  const ticking = board.app.scheduler.tick();
  await until(() => board.providers.codex.availableCalls === 1, "availability probe");
  // The scheduler is starting the urgent card; a person starts the other card meanwhile.
  const manualStart = await board.api(`/api/tasks/${manual.id}/run/start`, { method: "POST", body: {} });
  assert.equal(manualStart.status, 202, JSON.stringify(manualStart.body));
  board.providers.codex.gate.resolve();
  const result = await ticking;
  await board.app.runService.settle();

  const tasks = (await board.api("/api/tasks?projectId=work")).body.tasks;
  const active = tasks.filter((task) => task.activeRun);
  assert.equal(active.length, 1, JSON.stringify(active.map((task) => task.title)));
  assert.equal(active[0].id, manual.id);
  assert.deepEqual(result.started, []);
  assert.equal((await board.getTask(auto.id)).status, "todo");
});

test("DBG-07 / D9: manual start still answers 202 when auto-claim already filled maxParallel", async (t) => {
  const board = await startBoard(t);
  await board.project("work");
  const first = await board.task("work", "auto card", "codex-agent", "urgent");
  const second = await board.task("work", "manual card", "codex-agent", "low");
  await board.api("/api/projects/work/automation", { method: "PUT", body: { enabled: true, maxParallel: 1 } });

  const result = await board.app.scheduler.tick();
  assert.deepEqual(result.started, [first.id]);
  const manualStart = await board.api(`/api/tasks/${second.id}/run/start`, { method: "POST", body: {} });
  assert.equal(manualStart.status, 202, JSON.stringify(manualStart.body));
  await board.app.runService.settle();
  const tasks = (await board.api("/api/tasks?projectId=work")).body.tasks;
  assert.equal(tasks.filter((task) => task.activeRun).length, 2);

  // The next tick does not add a third run.
  const third = await board.task("work", "third card");
  const next = await board.app.scheduler.tick();
  assert.deepEqual(next.started, []);
  assert.equal((await board.getTask(third.id)).status, "todo");
});

test("scheduler: AUTOMATION_DISABLED / PARALLEL_LIMIT_REACHED from startTask end the project's loop without a warning", async () => {
  for (const code of ["AUTOMATION_DISABLED", "PARALLEL_LIMIT_REACHED"]) {
    const attempts = [];
    const warnings = [];
    const scheduler = createScheduler({
      listEnabledAutomations: () => [{ projectId: "p", enabled: true, maxParallel: 5, orderMode: "manual" }],
      countActiveRuns: () => 0,
      listTodoTasks: () => ["a", "b", "c"].map((id, index) => ({
        id,
        projectId: "p",
        status: "todo",
        archivedAt: null,
        sortOrder: index,
        priority: "none",
        createdAt: "2026-09-01T00:00:00.000Z",
        assignee: { type: "agent", id: "codex-agent" },
        relations: { blockedBy: [], blocks: [] },
      })),
      startTask: async (id) => {
        attempts.push(id);
        throw Object.assign(new Error("skip"), { code });
      },
      logger: { warn: (message) => warnings.push(message) },
    });
    const result = await scheduler.tick();
    assert.deepEqual(result.started, []);
    assert.deepEqual(attempts, ["a"], code);
    assert.deepEqual(warnings, [], code);
  }
});
