import assert from "node:assert/strict";
import { test } from "node:test";

import { createScheduler, isSchedulerCandidate } from "../server/runs/scheduler.mjs";

const CODEX = { type: "agent", id: "codex-agent", name: "Codex", avatarUrl: null };
const CLAUDE = { type: "agent", id: "claude-agent", name: "Claude", avatarUrl: null };
const USER = { type: "user", id: "local-user", name: "Me", avatarUrl: null };

function todo(id, overrides = {}) {
  return {
    id,
    projectId: "p1",
    status: "todo",
    priority: "none",
    dueDate: null,
    sortOrder: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    archivedAt: null,
    assignee: CODEX,
    relations: { parent: null, subIssues: [], blockedBy: [], blocks: [], related: [] },
    ...overrides,
  };
}

function automation(projectId, overrides = {}) {
  return { projectId, enabled: true, maxParallel: 3, orderMode: "suggested", ...overrides };
}

function fakeLogger() {
  const messages = [];
  return {
    messages,
    warn: (message) => messages.push(String(message)),
    error: (message) => messages.push(String(message)),
    log: (message) => messages.push(String(message)),
  };
}

/** In-memory board: active runs per project (manual + automatic), todo tasks per project. */
function fakeBoard({ automations, tasks, active = {} }) {
  const state = {
    automations,
    tasks: [...tasks],
    active: { ...active },
    startCalls: [],
    countCalls: 0,
    listCalls: 0,
    failIds: new Set(),
  };
  const deps = {
    listEnabledAutomations: () => state.automations,
    countActiveRuns: async (projectId) => {
      state.countCalls += 1;
      return state.active[projectId] ?? 0;
    },
    listTodoTasks: async (projectId) => {
      state.listCalls += 1;
      return state.tasks.filter((item) => item.projectId === projectId);
    },
    startTask: async (taskId) => {
      state.startCalls.push(taskId);
      if (state.failIds.has(taskId)) throw Object.assign(new Error("provider exploded"), { code: "PROVIDER_START_FAILED" });
      const item = state.tasks.find((candidate) => candidate.id === taskId);
      item.status = "in_progress";
      state.active[item.projectId] = (state.active[item.projectId] ?? 0) + 1;
      return { task: item, run: { id: `run-${taskId}` } };
    },
  };
  return { state, deps };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("tick starts candidates in suggested order up to maxParallel", async () => {
  const { state, deps } = fakeBoard({
    automations: [automation("p1", { maxParallel: 2 })],
    tasks: [
      todo("low", { priority: "low" }),
      todo("urgent", { priority: "urgent", assignee: CLAUDE }),
      todo("high", { priority: "high" }),
    ],
  });
  const scheduler = createScheduler({ ...deps, logger: fakeLogger() });
  const result = await scheduler.tick();
  assert.deepEqual(result, { started: ["urgent", "high"] });
  assert.deepEqual(state.startCalls, ["urgent", "high"]);
  assert.equal(state.active.p1, 2);
});

test("tick uses manual order when orderMode is manual", async () => {
  const { deps } = fakeBoard({
    automations: [automation("p1", { maxParallel: 2, orderMode: "manual" })],
    tasks: [
      todo("urgent-bottom", { priority: "urgent", sortOrder: 3000 }),
      todo("low-top", { priority: "low", sortOrder: 1000 }),
      todo("none-middle", { sortOrder: 2000 }),
    ],
  });
  const scheduler = createScheduler({ ...deps, logger: fakeLogger() });
  assert.deepEqual(await scheduler.tick(), { started: ["low-top", "none-middle"] });
});

test("maxParallel counts manual runs already active in the project", async () => {
  const { state, deps } = fakeBoard({
    automations: [automation("p1", { maxParallel: 3 })],
    tasks: [todo("a"), todo("b"), todo("c")],
    active: { p1: 2 },
  });
  const scheduler = createScheduler({ ...deps, logger: fakeLogger() });
  assert.deepEqual(await scheduler.tick(), { started: ["a"] });

  // Project at capacity: no todo listing, no starts.
  state.listCalls = 0;
  assert.deepEqual(await scheduler.tick(), { started: [] });
  assert.equal(state.listCalls, 0);
  assert.deepEqual(state.startCalls, ["a"]);
});

test("a manual run started during the tick is re-counted before the next start", async () => {
  const { state, deps } = fakeBoard({
    automations: [automation("p1", { maxParallel: 2 })],
    tasks: [todo("a"), todo("b")],
  });
  const startTask = async (taskId) => {
    await deps.startTask(taskId);
    state.active.p1 += 1; // user pressed 開工 on another card meanwhile
  };
  const scheduler = createScheduler({ ...deps, startTask, logger: fakeLogger() });
  assert.deepEqual(await scheduler.tick(), { started: ["a"] });
  assert.deepEqual(state.startCalls, ["a"]);
});

test("skips user-assigned, unassigned, blocked, archived and non-todo tasks", async () => {
  const tasks = [
    todo("user", { assignee: USER, priority: "urgent" }),
    todo("nobody", { assignee: null, priority: "urgent" }),
    todo("blocked", { priority: "urgent", relations: { blockedBy: [{ id: "x", status: "in_progress" }] } }),
    todo("archived", { priority: "urgent", archivedAt: "2026-09-10T00:00:00.000Z" }),
    todo("review", { priority: "urgent", status: "in_review" }),
    todo("deps-done", { priority: "low", relations: { blockedBy: [{ id: "y", status: "done" }] } }),
    todo("no-relations", { priority: "none", relations: undefined, assignee: CLAUDE }),
  ];
  assert.deepEqual(
    tasks.map((item) => isSchedulerCandidate(item)),
    [false, false, false, false, false, true, true],
  );
  const { state, deps } = fakeBoard({ automations: [automation("p1", { maxParallel: 10 })], tasks });
  const scheduler = createScheduler({ ...deps, logger: fakeLogger() });
  assert.deepEqual(await scheduler.tick(), { started: ["deps-done", "no-relations"] });
  assert.deepEqual(state.startCalls, ["deps-done", "no-relations"]);
});

test("continues with the next candidate after a startTask error", async () => {
  const logger = fakeLogger();
  const { state, deps } = fakeBoard({
    automations: [automation("p1", { maxParallel: 2 })],
    tasks: [todo("a", { priority: "urgent" }), todo("b", { priority: "high" }), todo("c", { priority: "medium" }), todo("d")],
  });
  state.failIds.add("a");
  const scheduler = createScheduler({ ...deps, logger });
  assert.deepEqual(await scheduler.tick(), { started: ["b", "c"] });
  assert.deepEqual(state.startCalls, ["a", "b", "c"]);
  assert.equal(logger.messages.length, 1);
  assert.match(logger.messages[0], /startTask a failed: PROVIDER_START_FAILED: provider exploded/);
});

test("a failed start that left an active run behind still counts toward maxParallel", async () => {
  const { state, deps } = fakeBoard({
    automations: [automation("p1", { maxParallel: 1 })],
    tasks: [todo("a", { priority: "urgent" }), todo("b")],
  });
  const startTask = async (taskId) => {
    state.startCalls.push(taskId);
    state.active.p1 = (state.active.p1 ?? 0) + 1; // run row created, then start threw
    throw new Error("start timed out");
  };
  const scheduler = createScheduler({ ...deps, startTask, logger: fakeLogger() });
  assert.deepEqual(await scheduler.tick(), { started: [] });
  assert.deepEqual(state.startCalls, ["a"]);
});

test("never runs two ticks concurrently", async () => {
  const { state, deps } = fakeBoard({
    automations: [automation("p1", { maxParallel: 3 })],
    tasks: [todo("a"), todo("b")],
  });
  const gate = deferred();
  const startTask = async (taskId) => {
    await gate.promise;
    return deps.startTask(taskId);
  };
  const scheduler = createScheduler({ ...deps, startTask, logger: fakeLogger() });
  const first = scheduler.tick();
  const second = scheduler.tick();
  assert.equal(second, first);
  await flush();
  assert.equal(state.startCalls.length, 0);
  gate.resolve();
  assert.deepEqual(await first, { started: ["a", "b"] });
  assert.deepEqual(await second, { started: ["a", "b"] });
  assert.deepEqual(state.startCalls, ["a", "b"]);

  // After the tick settles, a new tick runs again (nothing left to start).
  const third = scheduler.tick();
  assert.notEqual(third, first);
  assert.deepEqual(await third, { started: [] });
});

test("handles several projects independently and survives per-project errors", async () => {
  const logger = fakeLogger();
  const { state, deps } = fakeBoard({
    automations: [automation("broken"), automation("p1", { maxParallel: 1 }), automation("p2", { maxParallel: 2 })],
    tasks: [todo("p1-a"), todo("p1-b"), todo("p2-a", { projectId: "p2" }), todo("p2-b", { projectId: "p2" })],
  });
  const listTodoTasks = async (projectId) => {
    if (projectId === "broken") throw new Error("database is locked");
    return deps.listTodoTasks(projectId);
  };
  const scheduler = createScheduler({ ...deps, listTodoTasks, logger });
  assert.deepEqual(await scheduler.tick(), { started: ["p1-a", "p2-a", "p2-b"] });
  assert.equal(state.active.p1, 1);
  assert.equal(state.active.p2, 2);
  assert.ok(logger.messages.some((message) => /project broken: database is locked/.test(message)));
});

test("skips disabled or invalid automations and survives listEnabledAutomations failure", async () => {
  const logger = fakeLogger();
  const { state, deps } = fakeBoard({
    automations: [
      automation("p1", { enabled: false }),
      automation("p1", { maxParallel: 0 }),
      automation("p1", { maxParallel: "many" }),
    ],
    tasks: [todo("a")],
  });
  const scheduler = createScheduler({ ...deps, logger });
  assert.deepEqual(await scheduler.tick(), { started: [] });
  assert.deepEqual(state.startCalls, []);

  const failing = createScheduler({
    ...deps,
    listEnabledAutomations: async () => { throw new Error("no such table"); },
    logger,
  });
  assert.deepEqual(await failing.tick(), { started: [] });
  assert.ok(logger.messages.some((message) => /listEnabledAutomations failed: no such table/.test(message)));
});

test("start() ticks every intervalMs; stop() clears the interval", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { state, deps } = fakeBoard({
    automations: [automation("p1", { maxParallel: 1 })],
    tasks: [todo("a", { priority: "urgent" }), todo("b")],
  });
  let ticks = 0;
  const listEnabledAutomations = () => {
    ticks += 1;
    return state.automations;
  };
  const scheduler = createScheduler({ ...deps, listEnabledAutomations, intervalMs: 1000, logger: fakeLogger() });
  scheduler.start();
  scheduler.start(); // idempotent
  t.mock.timers.tick(999);
  await flush();
  assert.equal(ticks, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(ticks, 1);
  assert.deepEqual(state.startCalls, ["a"]);

  state.active.p1 = 0; // run "a" finished
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(ticks, 2);
  assert.deepEqual(state.startCalls, ["a", "b"]);

  await scheduler.stop();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(ticks, 2);
});

test("stop() prevents further starts in the in-flight tick and waits for it", async () => {
  const { state, deps } = fakeBoard({
    automations: [automation("p1", { maxParallel: 3 })],
    tasks: [todo("a", { priority: "urgent" }), todo("b"), todo("c")],
  });
  const gate = deferred();
  const startTask = async (taskId) => {
    const result = await deps.startTask(taskId);
    if (taskId === "a") await gate.promise;
    return result;
  };
  const scheduler = createScheduler({ ...deps, startTask, logger: fakeLogger() });
  const running = scheduler.tick();
  await flush();
  assert.deepEqual(state.startCalls, ["a"]);

  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await flush();
  assert.equal(stopped, false);
  gate.resolve();
  await stopping;
  assert.deepEqual(await running, { started: ["a"] });
  assert.deepEqual(state.startCalls, ["a"]);

  // A later manual tick still works after stop().
  assert.deepEqual(await scheduler.tick(), { started: ["b", "c"] });
});

test("synchronous injected functions are accepted", async () => {
  const started = [];
  const scheduler = createScheduler({
    listEnabledAutomations: () => [automation("p1", { maxParallel: 1 })],
    countActiveRuns: () => 0,
    listTodoTasks: () => [todo("a")],
    startTask: (taskId) => { started.push(taskId); },
    logger: fakeLogger(),
  });
  assert.deepEqual(await scheduler.tick(), { started: ["a"] });
  assert.deepEqual(started, ["a"]);
});

test("createScheduler rejects missing dependencies", () => {
  assert.throws(() => createScheduler({}), /listEnabledAutomations must be a function/);
  assert.throws(() => createScheduler({
    listEnabledAutomations: () => [],
    countActiveRuns: () => 0,
    listTodoTasks: () => [],
    startTask: () => {},
    intervalMs: 0,
  }), /intervalMs must be a positive number/);
});
