import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError } from "../shared/api-fields.mjs";
import {
  CLAUDE_AGENT_ACTOR,
  CODEX_AGENT_ACTOR,
  agentActorForProvider,
  providerForAgentActor,
} from "../server/runs/actors.mjs";
import {
  EMPTY_RESULT_TEXT,
  RESTART_INTERRUPTED_TEXT,
  STEER_NOT_DELIVERED_QUEUED,
  STEER_NOT_DELIVERED_RUN_ENDED,
  RUN_ENDED,
  STEER_INTERRUPTED_BY_RESTART,
  STEER_WAITING_PERMISSION_QUEUED,
  CLAUDE_PERMISSION_MODES,
  DEFAULT_CLAUDE_PERMISSION_MODE,
  createRunService,
  workspaceDirectoryExists,
} from "../server/runs/service.mjs";

const USER = { type: "user", id: "local-user", name: "Me", avatarUrl: null };
const ACTIVE = new Set(["starting", "running", "stopping"]);
const TERMINAL = new Set(["finished", "stopped", "failed", "interrupted"]);

// In-memory stand-in for TaskboardDatabase: C2 run/followup/automation methods plus the
// upstream task/comment methods the service uses, with the same signatures.
class FakeDatabase {
  constructor() {
    this.sequence = 0;
    this.projects = new Map();
    this.tasks = new Map();
    this.comments = [];
    this.runs = new Map();
    this.followups = new Map();
    this.automations = new Map();
    this.moveCalls = [];
  }

  #stamp() {
    this.sequence += 1;
    return new Date(Date.UTC(2026, 8, 17, 0, 0, 0, this.sequence)).toISOString();
  }

  #id(prefix) {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  addProject({ id, workspacePath }) {
    this.projects.set(id, { id, name: id, workspacePath });
  }

  addTask({ id, projectId = "p1", status = "todo", assignee = CLAUDE_AGENT_ACTOR, title = "整理報表" }) {
    const task = {
      id,
      identifier: `T-${this.tasks.size + 1}`,
      projectId,
      title,
      description: "",
      status,
      assignee: { ...assignee },
      archivedAt: null,
      version: 1,
      createdAt: this.#stamp(),
    };
    this.tasks.set(id, task);
    return structuredClone(task);
  }

  getTask(id) {
    const task = this.tasks.get(id);
    return task ? structuredClone(task) : null;
  }

  getProject(id) {
    const project = this.projects.get(id);
    return project ? structuredClone(project) : null;
  }

  moveTask(id, version, status, sortOrder, threadId, threadBinding, actor) {
    this.moveCalls.push({ id, version, status, sortOrder, threadId, threadBinding, actor });
    const task = this.tasks.get(id);
    if (!task) throw new ApiError(404, "TASK_NOT_FOUND", "missing");
    if (task.version !== version) throw new ApiError(409, "VERSION_CONFLICT", "stale");
    if (task.archivedAt !== null) throw new ApiError(409, "TASK_ARCHIVED", "archived");
    // Upstream tasks.sort_order is REAL NOT NULL and moveTask only computes a position for `undefined`.
    if (sortOrder === null) throw new Error("NOT NULL constraint failed: tasks.sort_order");
    assert.ok(actor?.type && actor?.id, "moveTask needs an actor");
    task.status = status;
    task.version += 1;
    return structuredClone(task);
  }

  createComment(taskId, input) {
    if (!this.tasks.has(taskId)) throw new ApiError(404, "TASK_NOT_FOUND", "missing");
    assert.equal(typeof input.body, "string");
    assert.ok(input.actor?.type && input.actor?.id, "createComment needs input.actor");
    const comment = {
      id: this.#id("comment"),
      taskId,
      body: input.body,
      authorType: input.actor.type,
      authorId: input.actor.id,
      authorName: input.actor.name,
      authorAvatarUrl: input.actor.avatarUrl,
      createdAt: this.#stamp(),
    };
    this.comments.push(comment);
    return structuredClone(comment);
  }

  getComment(id) {
    const comment = this.comments.find((item) => item.id === id);
    return comment ? structuredClone(comment) : null;
  }

  listComments(taskId) {
    return this.comments.filter((comment) => comment.taskId === taskId).map((comment) => structuredClone(comment));
  }

  listAttachments(taskId) {
    if (!this.tasks.has(taskId)) throw new ApiError(404, "TASK_NOT_FOUND", "missing");
    return [];
  }

  createRun({ taskId, provider }) {
    if (!this.tasks.has(taskId)) throw new ApiError(404, "TASK_NOT_FOUND", "missing");
    if (this.getActiveRun(taskId)) throw new ApiError(409, "RUN_ALREADY_ACTIVE", "active");
    const at = this.#stamp();
    const run = {
      id: this.#id("run"),
      taskId,
      provider,
      status: "starting",
      claudeShortId: null,
      claudeSessionId: null,
      claudeBridgeSessionId: null,
      codexThreadId: null,
      codexTurnId: null,
      resultText: null,
      error: null,
      startedAt: at,
      endedAt: null,
      claudePermissionMode: null,
      claudePermissionSource: null,
      createdAt: at,
      updatedAt: at,
    };
    this.runs.set(run.id, run);
    return structuredClone(run);
  }

  updateRun(id, patch) {
    const run = this.runs.get(id);
    if (!run) throw new ApiError(404, "RUN_NOT_FOUND", "missing");
    for (const key of Object.keys(patch)) {
      assert.ok(!["id", "taskId", "provider", "createdAt"].includes(key), `updateRun cannot patch ${key}`);
      assert.ok(Object.hasOwn(run, key), `updateRun unknown key ${key}`);
    }
    if (patch.status && ACTIVE.has(patch.status) && !ACTIVE.has(run.status)) {
      const other = this.getActiveRun(run.taskId);
      if (other && other.id !== id) throw new ApiError(409, "RUN_ALREADY_ACTIVE", "active");
    }
    Object.assign(run, patch, { updatedAt: this.#stamp() });
    if (TERMINAL.has(patch.status) && patch.endedAt === undefined) run.endedAt = run.updatedAt;
    return structuredClone(run);
  }

  getRun(id) {
    const run = this.runs.get(id);
    return run ? structuredClone(run) : null;
  }

  listRuns(taskId) {
    return [...this.runs.values()]
      .filter((run) => run.taskId === taskId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((run) => structuredClone(run));
  }

  getActiveRun(taskId) {
    return this.listRuns(taskId).find((run) => ACTIVE.has(run.status)) ?? null;
  }

  getLatestRun(taskId) {
    return this.listRuns(taskId)[0] ?? null;
  }

  listRunsByStatus(statuses) {
    return [...this.runs.values()].filter((run) => statuses.includes(run.status)).map((run) => structuredClone(run));
  }

  createFollowup({ taskId, runId, body, mode }) {
    const followup = {
      id: this.#id("followup"),
      taskId,
      runId,
      body,
      mode,
      status: "pending",
      error: null,
      createdAt: this.#stamp(),
      sentAt: null,
    };
    this.followups.set(followup.id, followup);
    return structuredClone(followup);
  }

  updateFollowup(id, patch) {
    const followup = this.followups.get(id);
    if (!followup) throw new ApiError(404, "FOLLOWUP_NOT_FOUND", "missing");
    for (const key of Object.keys(patch)) {
      assert.ok(["mode", "status", "error", "sentAt", "runId"].includes(key), `updateFollowup cannot patch ${key}`);
    }
    Object.assign(followup, patch);
    return structuredClone(followup);
  }

  listFollowups(taskId) {
    return [...this.followups.values()]
      .filter((followup) => followup.taskId === taskId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((followup) => structuredClone(followup));
  }

  listPendingSteerFollowups() {
    return [...this.followups.values()]
      .filter((followup) => followup.status === "pending" && followup.mode === "steer")
      .map((followup) => structuredClone(followup));
  }

  listPendingFollowups(taskId) {
    return this.listFollowups(taskId).filter((followup) => followup.status === "pending" && followup.mode === "queue");
  }

  getProjectAutomation(projectId) {
    return structuredClone(this.automations.get(projectId) ?? {
      projectId,
      enabled: false,
      maxParallel: 3,
      claudeModel: null,
      codexModel: null,
      codexEffort: null,
      orderMode: "suggested",
      updatedAt: "2026-09-17T00:00:00.000Z",
    });
  }
}

function fakeProvider(name, overrides = {}) {
  const calls = { start: [], sendFollowup: [], stop: [], close: [], recover: [] };
  return {
    name,
    calls,
    async available() {
      return { ok: true, version: "fake" };
    },
    async start(input) {
      calls.start.push(input);
      if (overrides.start) return overrides.start(input);
      return name === "claude"
        ? { claudeShortId: "short-1", claudeSessionId: "session-1", claudeBridgeSessionId: "bridge-1" }
        : { codexThreadId: "thread-1", codexTurnId: "turn-1" };
    },
    async sendFollowup(input) {
      calls.sendFollowup.push(input);
      if (overrides.sendFollowup) return overrides.sendFollowup(input);
      return { delivered: true, detail: "fake delivered" };
    },
    async stop(input) {
      calls.stop.push(input);
      if (overrides.stop) return overrides.stop(input);
      return { stopped: true, detail: "fake stopped" };
    },
    async close(input) {
      calls.close.push(input);
    },
    openUrl(run) {
      return name === "codex" ? `codex://threads/${run.codexThreadId}` : null;
    },
    async recover(run) {
      calls.recover.push(run);
      if (overrides.recover) return overrides.recover(run);
      return { status: "interrupted" };
    },
    async dispose() {},
  };
}

// Amendment 6: tests never read the real Claude settings files; by default no settings select a mode.
const NO_CLAUDE_SETTINGS = async () => ({ effectiveMode: null, source: null });

function setup({
  assignee = CLAUDE_AGENT_ACTOR,
  status = "todo",
  claude = {},
  codex = {},
  workspaceExists = () => true,
  detectClaudePermission = NO_CLAUDE_SETTINGS,
} = {}) {
  const database = new FakeDatabase();
  database.addProject({ id: "p1", workspacePath: "C:\\work\\p1" });
  const task = database.addTask({ id: "task-1", status, assignee });
  const events = [];
  const prompts = [];
  const providers = { claude: fakeProvider("claude", claude), codex: fakeProvider("codex", codex) };
  const service = createRunService({
    database,
    providers,
    emit: (type, payload) => events.push({ type, payload }),
    buildPrompt: (input) => {
      prompts.push(input);
      return `PROMPT ${input.task.identifier}`;
    },
    now: () => "2026-09-17T01:02:03.000Z",
    workspaceExists,
    detectClaudePermission,
  });
  return { database, task, events, prompts, providers, service };
}

function lastComment(database) {
  return database.comments.at(-1);
}

async function startedRunning(context) {
  const { run } = await context.service.startTask({ taskId: context.task.id, actor: USER });
  await context.service.settle();
  await context.service.handleProviderUpdate(run.id, { status: "running" });
  return context.database.getRun(run.id);
}

test("actors module exports both agent actors and maps them to providers", () => {
  assert.deepEqual({ ...CLAUDE_AGENT_ACTOR }, { type: "agent", id: "claude-agent", name: "Claude", avatarUrl: null });
  assert.deepEqual({ ...CODEX_AGENT_ACTOR }, { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null });
  assert.equal(providerForAgentActor({ type: "agent", id: "claude-agent" }), "claude");
  assert.equal(providerForAgentActor({ type: "agent", id: "codex-agent" }), "codex");
  assert.equal(providerForAgentActor(USER), null);
  assert.equal(providerForAgentActor(null), null);
  assert.equal(agentActorForProvider("claude"), CLAUDE_AGENT_ACTOR);
  assert.equal(agentActorForProvider("codex"), CODEX_AGENT_ACTOR);
});

test("startTask moves todo to in_progress, starts the provider in the project folder, and saves refs", async () => {
  const context = setup();
  context.database.automations.set("p1", { ...context.database.getProjectAutomation("p1"), claudeModel: "opus" });

  const { task, run: accepted } = await context.service.startTask({ taskId: context.task.id, actor: USER });

  // W3 bug 3: answered before the provider call; refs arrive in the background.
  assert.equal(task.status, "in_progress");
  assert.equal(accepted.status, "starting");
  assert.equal(accepted.claudeShortId, null);
  await context.service.settle();
  const run = context.database.getRun(accepted.id);
  assert.equal(run.status, "starting");
  assert.equal(run.provider, "claude");
  assert.equal(run.claudeShortId, "short-1");
  assert.equal(run.claudeSessionId, "session-1");
  assert.equal(run.claudeBridgeSessionId, "bridge-1");
  assert.deepEqual(context.providers.claude.calls.start, [{
    runId: run.id,
    cwd: "C:\\work\\p1",
    prompt: "PROMPT T-1",
    title: "T-1 整理報表",
    model: "opus",
    // Amendment 6 default followClaude; the fake detector finds no Claude settings → fallback flag.
    permissionMode: "bypassPermissions",
  }]);
  assert.equal(context.prompts.length, 1);
  assert.equal(context.prompts[0].task.status, "in_progress");
  assert.ok(Array.isArray(context.prompts[0].comments));
  assert.ok(Array.isArray(context.prompts[0].attachments));
  assert.deepEqual(context.database.moveCalls.map((call) => [call.status, call.sortOrder, call.actor.id]), [
    ["in_progress", undefined, "local-user"],
  ]);
  const types = context.events.map((event) => event.type);
  assert.ok(types.includes("run.updated"));
  assert.ok(types.includes("task.moved"));
  for (const event of context.events) {
    assert.equal(event.payload.projectId, "p1");
    assert.equal(event.payload.taskId, "task-1");
  }
  assert.equal(context.events.find((event) => event.type === "task.moved").payload.task.status, "in_progress");

  await context.service.handleProviderUpdate(run.id, { status: "running" });
  assert.equal(context.database.getRun(run.id).status, "running");
});

test("startTask passes Codex model and effort for codex-assigned tasks", async () => {
  const context = setup({ assignee: CODEX_AGENT_ACTOR });
  context.database.automations.set("p1", {
    ...context.database.getProjectAutomation("p1"),
    codexModel: "gpt-test",
    codexEffort: "high",
    claudeModel: "ignored",
  });
  const { run: accepted } = await context.service.startTask({ taskId: context.task.id, actor: USER });
  await context.service.settle();
  const run = context.database.getRun(accepted.id);
  assert.equal(run.provider, "codex");
  assert.equal(run.codexThreadId, "thread-1");
  assert.equal(context.providers.codex.calls.start[0].model, "gpt-test");
  assert.equal(context.providers.codex.calls.start[0].effort, "high");
  assert.equal(context.providers.claude.calls.start.length, 0);
});

test("startTask rejects user assignees and tasks that are not in todo", async () => {
  const userTask = setup({ assignee: USER });
  await assert.rejects(
    userTask.service.startTask({ taskId: userTask.task.id, actor: USER }),
    (error) => error.status === 409 && error.code === "ASSIGNEE_NOT_AGENT",
  );
  assert.equal(userTask.database.runs.size, 0);

  const reviewTask = setup({ status: "in_review" });
  await assert.rejects(
    reviewTask.service.startTask({ taskId: reviewTask.task.id, actor: USER }),
    (error) => error.status === 409 && error.code === "TASK_NOT_TODO",
  );
  assert.equal(reviewTask.database.runs.size, 0);

  await assert.rejects(
    reviewTask.service.startTask({ taskId: "missing", actor: USER }),
    (error) => error.status === 404 && error.code === "TASK_NOT_FOUND",
  );
});

test("provider.start failure marks the run failed, comments as the agent, and blocks the task", async () => {
  const context = setup({
    claude: {
      start: () => {
        throw new Error("claude executable not found");
      },
    },
  });

  const accepted = await context.service.startTask({ taskId: context.task.id, actor: USER });
  assert.equal(accepted.run.status, "starting");
  assert.equal(accepted.task.status, "in_progress");
  await context.service.settle();
  const run = context.database.getRun(accepted.run.id);
  const task = context.database.getTask(context.task.id);

  assert.equal(run.status, "failed");
  assert.equal(run.error, "claude executable not found");
  assert.equal(task.status, "blocked");
  const comment = lastComment(context.database);
  assert.equal(comment.authorId, "claude-agent");
  assert.match(comment.body, /claude executable not found/);
  assert.equal(context.database.getActiveRun(context.task.id), null);
  assert.ok(context.events.some((event) => event.type === "comment.created" && event.payload.comment.id === comment.id));
});

test("finished update comments the result as the agent and moves the task to in_review", async () => {
  const context = setup({ assignee: CODEX_AGENT_ACTOR });
  const run = await startedRunning(context);

  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "已建立 report.xlsx" });

  const saved = context.database.getRun(run.id);
  assert.equal(saved.status, "finished");
  assert.equal(saved.resultText, "已建立 report.xlsx");
  assert.ok(saved.endedAt);
  const comment = lastComment(context.database);
  assert.equal(comment.authorId, "codex-agent");
  assert.equal(comment.body, "已建立 report.xlsx");
  assert.equal(context.database.getTask(context.task.id).status, "in_review");
  assert.equal(context.database.moveCalls.at(-1).actor.id, "codex-agent");

  const empty = setup();
  const emptyRun = await startedRunning(empty);
  await empty.service.handleProviderUpdate(emptyRun.id, { status: "finished", resultText: "" });
  assert.equal(lastComment(empty.database).body, EMPTY_RESULT_TEXT);
  assert.equal(lastComment(empty.database).authorId, "claude-agent");
  assert.equal(empty.database.getTask(empty.task.id).status, "in_review");
});

test("finished with a pending queued follow-up sends it, keeps the task in progress, and marks it sent", async () => {
  const context = setup();
  const run = await startedRunning(context);
  const { followup } = await context.service.sendFollowup({
    taskId: context.task.id,
    body: "順便把圖表也更新",
    mode: "queue",
    actor: USER,
  });
  assert.equal(followup.status, "pending");
  assert.equal(context.providers.claude.calls.sendFollowup.length, 0);
  const commentsBefore = context.database.comments.length;

  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "第一輪完成" });

  assert.equal(context.providers.claude.calls.sendFollowup.length, 1);
  const call = context.providers.claude.calls.sendFollowup[0];
  assert.equal(call.mode, "queue");
  assert.equal(call.body, "順便把圖表也更新");
  assert.equal(call.run.id, run.id);
  const sent = context.database.followups.get(followup.id);
  assert.equal(sent.status, "sent");
  assert.equal(sent.sentAt, "2026-09-17T01:02:03.000Z");
  assert.equal(context.database.getRun(run.id).status, "running");
  assert.equal(context.database.getTask(context.task.id).status, "in_progress");
  // W3 note 5: the finished turn's result is kept as an agent comment before the queued turn starts.
  assert.equal(context.database.comments.length, commentsBefore + 1);
  assert.equal(lastComment(context.database).body, "第一輪完成");
  assert.equal(lastComment(context.database).authorId, "claude-agent");
  assert.ok(context.events.some((event) => event.type === "followup.updated" && event.payload.followup.status === "sent"));

  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "第二輪完成" });
  assert.equal(context.database.getRun(run.id).status, "finished");
  assert.equal(lastComment(context.database).body, "第二輪完成");
  assert.equal(context.database.getTask(context.task.id).status, "in_review");
});

test("a finished update that arrives during queued delivery waits and does not resend the message", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const context = setup({
    claude: {
      sendFollowup: async () => {
        await gate;
        return { delivered: true, detail: "ok" };
      },
    },
  });
  const run = await startedRunning(context);
  await context.service.sendFollowup({ taskId: context.task.id, body: "排隊一", mode: "queue", actor: USER });

  const first = context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "A" });
  const second = context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "B" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.providers.claude.calls.sendFollowup.length, 1);
  release();
  await Promise.all([first, second]);

  assert.equal(context.providers.claude.calls.sendFollowup.length, 1);
  assert.equal(context.database.getRun(run.id).status, "finished");
  assert.equal(context.database.getRun(run.id).resultText, "B");
  assert.equal(context.database.getTask(context.task.id).status, "in_review");
});

test("queued follow-up delivery failure finishes the run with a visible note", async () => {
  const context = setup({ claude: { sendFollowup: () => ({ delivered: false, detail: "session gone" }) } });
  const run = await startedRunning(context);
  const { followup } = await context.service.sendFollowup({ taskId: context.task.id, body: "再加一段", mode: "queue", actor: USER });

  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "完成" });

  assert.equal(context.database.followups.get(followup.id).status, "failed");
  assert.equal(context.database.followups.get(followup.id).error, "session gone");
  assert.equal(context.database.getRun(run.id).status, "finished");
  const [resultComment, noteComment] = context.database.comments.slice(-2);
  assert.equal(resultComment.body, "完成");
  assert.match(noteComment.body, /^（排隊的追加訊息沒有送達：session gone）$/);
  assert.equal(context.database.getTask(context.task.id).status, "in_review");
});

test("steer on an active run delivers immediately and records a comment by the actor", async () => {
  const context = setup();
  const run = await startedRunning(context);

  const { followup: accepted } = await context.service.sendFollowup({ taskId: context.task.id, body: "先停下來改用 A 方案", mode: "steer", actor: USER });
  assert.equal(accepted.status, "pending");
  assert.equal(accepted.mode, "steer");
  await context.service.settle();
  const followup = context.database.followups.get(accepted.id);

  assert.equal(followup.status, "sent");
  assert.equal(followup.mode, "steer");
  assert.equal(followup.runId, run.id);
  assert.equal(followup.sentAt, "2026-09-17T01:02:03.000Z");
  assert.deepEqual(
    context.providers.claude.calls.sendFollowup.map((call) => [call.mode, call.body, call.run.id]),
    [["steer", "先停下來改用 A 方案", run.id]],
  );
  const comment = lastComment(context.database);
  assert.equal(comment.authorId, "local-user");
  assert.equal(comment.body, "先停下來改用 A 方案");

  const failing = setup({ claude: { sendFollowup: () => ({ delivered: false, detail: "no crSent" }) } });
  await startedRunning(failing);
  const failed = await failing.service.sendFollowup({ taskId: failing.task.id, body: "插嘴", mode: "steer", actor: USER });
  await failing.service.settle();
  const converted = failing.database.followups.get(failed.followup.id);
  assert.equal(converted.status, "pending");
  assert.equal(converted.mode, "queue");
  assert.equal(converted.error, STEER_NOT_DELIVERED_QUEUED);
});

test("queue or steer without an active run is rejected with 409 RUN_NOT_ACTIVE", async () => {
  const context = setup({ status: "in_review" });
  for (const mode of ["queue", "steer"]) {
    await assert.rejects(
      context.service.sendFollowup({ taskId: context.task.id, body: "hello", mode, actor: USER }),
      (error) => error.status === 409 && error.code === "RUN_NOT_ACTIVE",
    );
  }
  assert.equal(context.database.followups.size, 0);
  assert.equal(context.database.comments.length, 0);

  await assert.rejects(
    context.service.sendFollowup({ taskId: context.task.id, body: "  ", mode: "queue", actor: USER }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    context.service.sendFollowup({ taskId: context.task.id, body: "hi", mode: "later", actor: USER }),
    (error) => error.status === 400,
  );
});

test("stopTask stops the active run, cancels queued follow-ups, then moves to the destination", async () => {
  const context = setup();
  const run = await startedRunning(context);
  const { followup } = await context.service.sendFollowup({ taskId: context.task.id, body: "later", mode: "queue", actor: USER });

  const result = await context.service.stopTask({ taskId: context.task.id, destination: "todo", actor: USER });

  assert.equal(context.providers.claude.calls.stop.length, 1);
  assert.equal(context.providers.claude.calls.stop[0].run.status, "stopping");
  assert.equal(result.run.id, run.id);
  assert.equal(result.run.status, "stopped");
  assert.equal(result.task.status, "todo");
  assert.equal(context.database.moveCalls.at(-1).actor.id, "local-user");
  assert.equal(context.database.followups.get(followup.id).status, "canceled");
  const runStatuses = context.events
    .filter((event) => event.type === "run.updated" && event.payload.run.id === run.id)
    .map((event) => event.payload.run.status);
  assert.deepEqual(runStatuses.slice(-2), ["stopping", "stopped"]);

  await assert.rejects(
    context.service.stopTask({ taskId: context.task.id, destination: "done", actor: USER }),
    (error) => error.status === 400 && error.code === "INVALID_DESTINATION",
  );
});

test("stopTask without destination stops the run and leaves the task where it is", async () => {
  const context = setup();
  await startedRunning(context);
  const result = await context.service.stopTask({ taskId: context.task.id, destination: null, actor: USER });
  assert.equal(result.run.status, "stopped");
  assert.equal(result.task.status, "in_progress");
});

test("stopTask keeps the run and task when the provider cannot confirm the stop", async () => {
  const context = setup({ claude: { stop: () => ({ stopped: false, detail: "still busy after 20s" }) } });
  const run = await startedRunning(context);

  await assert.rejects(
    context.service.stopTask({ taskId: context.task.id, destination: "backlog", actor: USER }),
    (error) => error.status === 502 && error.code === "RUN_STOP_FAILED" && /still busy/.test(error.message),
  );

  assert.equal(context.database.getRun(run.id).status, "running");
  assert.equal(context.database.getTask(context.task.id).status, "in_progress");
});

test("a finished update that arrives while stopping records the run as stopped without review", async () => {
  let service;
  const context = setup({
    claude: {
      stop: async ({ run }) => {
        await service.handleProviderUpdate(run.id, { status: "finished", resultText: "做到一半" });
        return { stopped: true, detail: "ok" };
      },
    },
  });
  service = context.service;
  const run = await startedRunning(context);
  const commentsBefore = context.database.comments.length;

  const result = await context.service.stopTask({ taskId: context.task.id, destination: "backlog", actor: USER });

  assert.equal(result.run.status, "stopped");
  assert.equal(context.database.getRun(run.id).resultText, "做到一半");
  assert.equal(context.database.comments.length, commentsBefore);
  assert.equal(result.task.status, "backlog");
});

test("continueTask from in_review comments, opens a new run in the same session, and queues the message", async () => {
  const context = setup();
  const first = await startedRunning(context);
  await context.service.handleProviderUpdate(first.id, { status: "finished", resultText: "done 1" });
  assert.equal(context.database.getTask(context.task.id).status, "in_review");

  const { task, run } = await context.service.continueTask({ taskId: context.task.id, body: "請再補上摘要", actor: USER });
  await context.service.settle();

  assert.notEqual(run.id, first.id);
  assert.equal(run.provider, "claude");
  assert.equal(run.status, "starting");
  assert.equal(run.claudeShortId, "short-1");
  assert.equal(run.claudeSessionId, "session-1");
  assert.equal(run.claudeBridgeSessionId, "bridge-1");
  assert.equal(task.status, "in_progress");
  const comment = context.database.comments.find((item) => item.body === "請再補上摘要");
  assert.equal(comment.authorId, "local-user");
  assert.deepEqual(
    context.providers.claude.calls.sendFollowup.map((call) => [call.mode, call.body, call.run.id, call.run.claudeShortId]),
    [["queue", "請再補上摘要", run.id, "short-1"]],
  );
  assert.equal(context.providers.claude.calls.start.length, 1);
  assert.equal(context.database.listRuns(context.task.id).length, 2);

  await context.service.handleProviderUpdate(run.id, { status: "running" });
  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "done 2" });
  assert.equal(context.database.getTask(context.task.id).status, "in_review");
});

test("continueTask rejects tasks outside in_review/blocked and blocks when delivery fails", async () => {
  const todo = setup();
  await assert.rejects(
    todo.service.continueTask({ taskId: todo.task.id, body: "go", actor: USER }),
    (error) => error.status === 409 && error.code === "TASK_NOT_CONTINUABLE",
  );

  const context = setup({ claude: { sendFollowup: () => ({ delivered: false, detail: "attach failed" }) } });
  const first = await startedRunning(context);
  await context.service.handleProviderUpdate(first.id, { status: "failed", error: "boom" });
  assert.equal(context.database.getTask(context.task.id).status, "blocked");

  const accepted = await context.service.continueTask({ taskId: context.task.id, body: "retry", actor: USER });
  assert.equal(accepted.run.status, "starting");
  assert.equal(accepted.task.status, "in_progress");
  await context.service.settle();
  const run = context.database.getRun(accepted.run.id);
  const task = context.database.getTask(context.task.id);
  assert.equal(run.status, "failed");
  assert.match(run.error, /attach failed/);
  assert.equal(task.status, "blocked");
  assert.equal(lastComment(context.database).authorId, "claude-agent");
});

test("reworkTask comments and moves the task back to todo in one call", async () => {
  const context = setup();
  const run = await startedRunning(context);
  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "v1" });

  const { task, comment } = await context.service.reworkTask({ taskId: context.task.id, body: "格式不對，請重做", actor: USER });

  assert.equal(task.status, "todo");
  assert.equal(comment.body, "格式不對，請重做");
  assert.equal(comment.authorId, "local-user");
  assert.equal(context.database.moveCalls.at(-1).status, "todo");
  assert.equal(context.database.moveCalls.at(-1).sortOrder, undefined);
  assert.ok(context.events.some((event) => event.type === "comment.created" && event.payload.comment.id === comment.id));

  const active = setup();
  await startedRunning(active);
  await assert.rejects(
    active.service.reworkTask({ taskId: active.task.id, body: "x", actor: USER }),
    (error) => error.status === 409 && error.code === "RUN_ALREADY_ACTIVE",
  );
});

test("reworkTask with commentId uses the existing comment and still checks for an active run first", async () => {
  const context = setup();
  const run = await startedRunning(context);
  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "v1" });
  const existing = context.database.createComment(context.task.id, { body: "附件在留言裡", actor: USER });
  const commentsBefore = context.database.comments.length;

  const { task, comment } = await context.service.reworkTask({ taskId: context.task.id, commentId: existing.id, actor: USER });

  assert.equal(task.status, "todo");
  assert.equal(comment.id, existing.id);
  assert.equal(context.database.comments.length, commentsBefore, "no second comment is created");
  assert.equal(context.events.some((event) => event.type === "comment.created" && event.payload.comment.id === existing.id), false);

  // Invalid combinations and foreign / missing comments are rejected before the card moves.
  const other = setup();
  const otherRun = await startedRunning(other);
  await other.service.handleProviderUpdate(otherRun.id, { status: "finished", resultText: "v1" });
  const moveCallsBefore = other.database.moveCalls.length;
  await assert.rejects(
    other.service.reworkTask({ taskId: other.task.id, commentId: "missing", actor: USER }),
    (error) => error.status === 404 && error.code === "COMMENT_NOT_FOUND",
  );
  await assert.rejects(
    other.service.reworkTask({ taskId: other.task.id, commentId: existing.id, body: "x", actor: USER }),
    (error) => error.status === 400 && error.code === "INVALID_BODY",
  );
  await assert.rejects(
    other.service.reworkTask({ taskId: other.task.id, commentId: "", actor: USER }),
    (error) => error.status === 400 && error.code === "INVALID_BODY",
  );
  assert.equal(other.database.moveCalls.length, moveCallsBefore);

  const active = setup();
  await startedRunning(active);
  const activeComment = active.database.createComment(active.task.id, { body: "x", actor: USER });
  await assert.rejects(
    active.service.reworkTask({ taskId: active.task.id, commentId: activeComment.id, actor: USER }),
    (error) => error.status === 409 && error.code === "RUN_ALREADY_ACTIVE",
  );
});

test("failed and interrupted updates comment the error and move the task to blocked", async () => {
  for (const status of ["failed", "interrupted"]) {
    const context = setup({ assignee: CODEX_AGENT_ACTOR });
    const run = await startedRunning(context);

    await context.service.handleProviderUpdate(run.id, { status, error: `${status} because of X` });

    const saved = context.database.getRun(run.id);
    assert.equal(saved.status, status);
    assert.equal(saved.error, `${status} because of X`);
    const comment = lastComment(context.database);
    assert.equal(comment.authorId, "codex-agent");
    assert.match(comment.body, new RegExp(`${status} because of X`));
    assert.equal(context.database.getTask(context.task.id).status, "blocked");
  }
});

test("stopped update only updates the run, and updates for ended runs are ignored", async () => {
  const context = setup();
  const run = await startedRunning(context);
  await context.service.handleProviderUpdate(run.id, { status: "stopped" });
  assert.equal(context.database.getRun(run.id).status, "stopped");
  assert.equal(context.database.getTask(context.task.id).status, "in_progress");

  const commentsBefore = context.database.comments.length;
  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "late" });
  await context.service.handleProviderUpdate(run.id, { status: "running" });
  await context.service.handleProviderUpdate("missing-run", { status: "finished", resultText: "x" });
  assert.equal(context.database.getRun(run.id).status, "stopped");
  assert.equal(context.database.comments.length, commentsBefore);
  assert.equal(context.database.getTask(context.task.id).status, "in_progress");
});

test("recoverOnStartup maps provider.recover results onto active runs", async () => {
  const database = new FakeDatabase();
  database.addProject({ id: "p1", workspacePath: "C:\\work\\p1" });
  const outcomes = {
    "task-running": { status: "running" },
    "task-finished": { status: "finished", resultText: "restart result" },
    "task-interrupted": { status: "interrupted" },
    "task-throws": new Error("agents --json failed"),
    "task-stopping": { status: "running" },
  };
  const runIds = {};
  for (const taskId of Object.keys(outcomes)) {
    database.addTask({ id: taskId, status: "in_progress" });
    const run = database.createRun({ taskId, provider: "claude" });
    runIds[taskId] = run.id;
    database.updateRun(run.id, { status: taskId === "task-stopping" ? "stopping" : "running", claudeShortId: `s-${taskId}` });
  }

  const claude = fakeProvider("claude", {
    recover: (run) => {
      const outcome = outcomes[run.taskId];
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  });
  const service = createRunService({
    database,
    providers: { claude, codex: fakeProvider("codex") },
    emit: () => {},
    buildPrompt: () => "unused",
  });

  await service.recoverOnStartup();

  assert.equal(claude.calls.recover.length, 5);
  assert.equal(database.getRun(runIds["task-running"]).status, "running");
  assert.equal(database.getTask("task-running").status, "in_progress");

  assert.equal(database.getRun(runIds["task-finished"]).status, "finished");
  assert.equal(database.getRun(runIds["task-finished"]).resultText, "restart result");
  assert.equal(database.getTask("task-finished").status, "in_review");

  for (const taskId of ["task-interrupted", "task-throws"]) {
    const run = database.getRun(runIds[taskId]);
    assert.equal(run.status, "interrupted");
    assert.equal(run.error, RESTART_INTERRUPTED_TEXT);
    assert.equal(database.getTask(taskId).status, "blocked");
    const comment = database.comments.filter((item) => item.taskId === taskId).at(-1);
    assert.equal(comment.authorId, "claude-agent");
    assert.match(comment.body, /看板重新啟動/);
  }

  assert.equal(database.getRun(runIds["task-stopping"]).status, "running");
  assert.equal(database.getTask("task-stopping").status, "in_progress");
});

test("archiveTask stops an active run and closes each AI session of the task once", async () => {
  const context = setup();
  const { database, service, providers } = context;
  const oldRun = database.createRun({ taskId: context.task.id, provider: "claude" });
  database.updateRun(oldRun.id, { status: "finished", claudeShortId: "short-old" });
  const earlierTurn = database.createRun({ taskId: context.task.id, provider: "claude" });
  database.updateRun(earlierTurn.id, { status: "finished", claudeShortId: "short-new" });
  const active = database.createRun({ taskId: context.task.id, provider: "claude" });
  database.updateRun(active.id, { status: "running", claudeShortId: "short-new" });
  const { followup } = await service.sendFollowup({ taskId: context.task.id, body: "queued", mode: "queue", actor: USER });

  const result = await service.archiveTask({ taskId: context.task.id, actor: USER });

  assert.equal(providers.claude.calls.stop.length, 1);
  assert.equal(database.getRun(active.id).status, "stopped");
  assert.equal(database.followups.get(followup.id).status, "canceled");
  assert.deepEqual(providers.claude.calls.close.map((call) => call.run.claudeShortId), ["short-new", "short-old"]);
  assert.equal(providers.claude.calls.close[0].run.id, active.id);
  assert.equal(result.run.id, active.id);
  assert.equal(database.getTask(context.task.id).archivedAt, null, "archiveTask must not archive the task itself");

  const noRuns = setup();
  const empty = await noRuns.service.archiveTask({ taskId: noRuns.task.id, actor: USER });
  assert.equal(empty.run, null);
  assert.equal(noRuns.providers.claude.calls.close.length, 0);
});

test("openUrl delegates to the run's provider and returns null for unknown runs", async () => {
  const context = setup({ assignee: CODEX_AGENT_ACTOR });
  const { run } = await context.service.startTask({ taskId: context.task.id, actor: USER });
  await context.service.settle();
  assert.equal(context.service.openUrl(run.id), "codex://threads/thread-1");
  assert.equal(context.service.openUrl("missing"), null);

  const claude = setup();
  const claudeRun = await claude.service.startTask({ taskId: claude.task.id, actor: USER });
  assert.equal(claude.service.openUrl(claudeRun.run.id), null);
});

test("service methods work when destructured from the service object", async () => {
  const context = setup();
  const { startTask, archiveTask } = context.service;
  await startTask({ taskId: context.task.id, actor: USER });
  const { run } = await archiveTask({ taskId: context.task.id, actor: USER });
  assert.equal(run.status, "stopped");
  assert.equal(context.providers.claude.calls.close.length, 1);
});

// W3 (INTEGRATION Amendment 3) run service follow-ups.
test("a status-less update persists refs only and leaves the run status alone", async () => {
  const context = setup();
  const { run } = await context.service.startTask({ taskId: context.task.id, actor: USER });
  await context.service.settle();
  assert.equal(context.database.getRun(run.id).status, "starting");

  await context.service.handleProviderUpdate(run.id, { refs: { claudeBridgeSessionId: "bridge-late" } });

  const saved = context.database.getRun(run.id);
  assert.equal(saved.status, "starting");
  assert.equal(saved.claudeBridgeSessionId, "bridge-late");
  assert.equal(saved.claudeShortId, "short-1");
  assert.ok(context.events.some((event) => event.type === "run.updated" && event.payload.run.claudeBridgeSessionId === "bridge-late"));

  // Refs still land on a run that has already ended (no status change).
  await context.service.handleProviderUpdate(run.id, { status: "running" });
  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "ok" });
  await context.service.handleProviderUpdate(run.id, { refs: { claudeSessionId: "session-2" } });
  const ended = context.database.getRun(run.id);
  assert.equal(ended.status, "finished");
  assert.equal(ended.claudeSessionId, "session-2");
});

test("WAITING_FOR_PERMISSION error is surfaced while running and cleared by the next plain running update", async () => {
  const context = setup();
  const run = await startedRunning(context);

  await context.service.handleProviderUpdate(run.id, { status: "running", error: "WAITING_FOR_PERMISSION: Bash" });
  let saved = context.database.getRun(run.id);
  assert.equal(saved.status, "running");
  assert.equal(saved.error, "WAITING_FOR_PERMISSION: Bash");
  assert.equal(context.database.getTask(context.task.id).status, "in_progress");

  await context.service.handleProviderUpdate(run.id, { status: "running" });
  saved = context.database.getRun(run.id);
  assert.equal(saved.status, "running");
  assert.equal(saved.error, null);

  // Waiting again, then finishing, also clears it.
  await context.service.handleProviderUpdate(run.id, { status: "running", error: "WAITING_FOR_PERMISSION: Edit" });
  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "done" });
  saved = context.database.getRun(run.id);
  assert.equal(saved.status, "finished");
  assert.equal(saved.error, null);
});

test("a plain running update does not clear an unrelated run error", async () => {
  const context = setup();
  const run = await startedRunning(context);
  context.database.runs.get(run.id).error = "something else";
  await context.service.handleProviderUpdate(run.id, { status: "running" });
  assert.equal(context.database.getRun(run.id).error, "something else");
});

test("stopTask with stopped:false never persists stopped and surfaces the provider detail", async () => {
  const context = setup({ codex: { stop: () => ({ stopped: false, detail: "turn/interrupt timed out" }) }, assignee: CODEX_AGENT_ACTOR });
  const run = await startedRunning(context);
  await assert.rejects(
    context.service.stopTask({ taskId: context.task.id, destination: null, actor: USER }),
    (error) => error.status === 502 && error.code === "RUN_STOP_FAILED" && /turn\/interrupt timed out/.test(error.message),
  );
  const statuses = context.events
    .filter((event) => event.type === "run.updated" && event.payload.run.id === run.id)
    .map((event) => event.payload.run.status);
  assert.ok(!statuses.includes("stopped"), `stopped must not be persisted: ${statuses.join(",")}`);
  assert.equal(context.database.getRun(run.id).status, "running");
  assert.equal(context.database.getRun(run.id).endedAt, null);
});

test("continueTask copies Codex thread refs into the new run", async () => {
  const context = setup({ assignee: CODEX_AGENT_ACTOR });
  const first = await startedRunning(context);
  await context.service.handleProviderUpdate(first.id, { status: "finished", resultText: "done" });

  const { run } = await context.service.continueTask({ taskId: context.task.id, body: "再改一下", actor: USER });
  await context.service.settle();

  assert.equal(run.provider, "codex");
  assert.equal(run.codexThreadId, "thread-1");
  assert.equal(run.codexTurnId, "turn-1");
  assert.equal(run.claudeShortId, null);
  assert.deepEqual(
    context.providers.codex.calls.sendFollowup.map((call) => [call.mode, call.run.id, call.run.codexThreadId]),
    [["queue", run.id, "thread-1"]],
  );
});

// ---- W4 fixes (W3 live smoke bugs 1, 3, 4 and note 5) ----

test("W3 bug 3: startTask answers before provider.start resolves; stop waits for the launch", async () => {
  let releaseStart;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  const context = setup({
    claude: {
      start: async () => {
        await startGate;
        return { claudeShortId: "short-slow", claudeSessionId: "session-slow" };
      },
    },
  });
  const { task, run } = await context.service.startTask({ taskId: context.task.id, actor: USER });
  assert.equal(task.status, "in_progress");
  assert.equal(run.status, "starting");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.providers.claude.calls.start.length, 1, "provider.start was called in the background");

  const stopping = context.service.stopTask({ taskId: context.task.id, destination: "backlog", actor: USER });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.providers.claude.calls.stop.length, 0, "stop waits for the in-flight launch");
  releaseStart();
  const stopped = await stopping;
  assert.equal(context.providers.claude.calls.stop.length, 1);
  assert.equal(context.providers.claude.calls.stop[0].run.claudeShortId, "short-slow");
  assert.equal(stopped.run.status, "stopped");
  assert.equal(stopped.task.status, "backlog");
});

test("W3 bug 3: a steer answers pending at once; delivery happens in the background", async () => {
  let releaseSteer;
  const steerGate = new Promise((resolve) => {
    releaseSteer = resolve;
  });
  const context = setup({
    claude: {
      sendFollowup: async () => {
        await steerGate;
        return { delivered: true, detail: "ok" };
      },
    },
  });
  await startedRunning(context);
  const { followup } = await context.service.sendFollowup({ taskId: context.task.id, body: "改用 B", mode: "steer", actor: USER });
  assert.equal(followup.status, "pending");
  assert.equal(lastComment(context.database).body, "改用 B");
  releaseSteer();
  await context.service.settle();
  assert.equal(context.database.followups.get(followup.id).status, "sent");
  const statuses = context.events
    .filter((event) => event.type === "followup.updated" && event.payload.followup.id === followup.id)
    .map((event) => event.payload.followup.status);
  assert.deepEqual(statuses, ["pending", "sent"]);
});

test("W3 bug 1: an unconfirmed steer is converted to a queued follow-up and sent when the turn finishes", async () => {
  const context = setup({
    claude: {
      sendFollowup: ({ mode }) => (mode === "steer"
        ? { delivered: false, detail: "NOT_CONFIRMED_IN_TRANSCRIPT rc=0 typed=true crSent=true" }
        : { delivered: true, detail: "queued turn started" }),
    },
  });
  const run = await startedRunning(context);
  const { followup } = await context.service.sendFollowup({ taskId: context.task.id, body: "只做到 3 就停", mode: "steer", actor: USER });
  await context.service.settle();

  let saved = context.database.followups.get(followup.id);
  assert.deepEqual([saved.mode, saved.status, saved.error], ["queue", "pending", STEER_NOT_DELIVERED_QUEUED]);
  assert.equal(context.database.getRun(run.id).status, "running");
  assert.equal(context.database.comments.filter((comment) => comment.body === "只做到 3 就停").length, 1);

  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "COUNT-DONE" });
  saved = context.database.followups.get(followup.id);
  assert.equal(saved.status, "sent");
  assert.equal(saved.error, STEER_NOT_DELIVERED_QUEUED, "the conversion stays recorded");
  assert.deepEqual(
    context.providers.claude.calls.sendFollowup.map((call) => [call.mode, call.body]),
    [["steer", "只做到 3 就停"], ["queue", "只做到 3 就停"]],
  );
  assert.equal(context.database.getTask(context.task.id).status, "in_progress");
  assert.equal(lastComment(context.database).body, "COUNT-DONE");
});

test("W3 bug 1: Codex turn/steer failure falls back to a queued follow-up too", async () => {
  const context = setup({
    assignee: CODEX_AGENT_ACTOR,
    codex: {
      sendFollowup: ({ mode }) => {
        if (mode === "steer") throw new Error("Codex turn/steer failed: no active turn");
        return { delivered: true, detail: "turn/start" };
      },
    },
  });
  const run = await startedRunning(context);
  const { followup } = await context.service.sendFollowup({ taskId: context.task.id, body: "補一句", mode: "steer", actor: USER });
  await context.service.settle();
  const saved = context.database.followups.get(followup.id);
  assert.deepEqual([saved.mode, saved.status, saved.error], ["queue", "pending", STEER_NOT_DELIVERED_QUEUED]);
  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "第一輪" });
  assert.equal(context.database.followups.get(followup.id).status, "sent");
});

test("W3 bug 1: when the turn ended during steer confirmation, the message continues the same session", async () => {
  let service;
  let runId;
  const context = setup({
    claude: {
      sendFollowup: async ({ mode }) => {
        if (mode === "steer") {
          // The AI finishes while the board is still waiting for the transcript confirmation.
          await service.handleProviderUpdate(runId, { status: "finished", resultText: "第一輪結果" });
          return { delivered: false, detail: "NOT_CONFIRMED_IN_TRANSCRIPT" };
        }
        return { delivered: true, detail: "attached" };
      },
    },
  });
  service = context.service;
  const first = await startedRunning(context);
  runId = first.id;
  const { followup } = await context.service.sendFollowup({ taskId: context.task.id, body: "再加一行", mode: "steer", actor: USER });
  await context.service.settle();

  assert.equal(context.database.getRun(first.id).status, "finished");
  const runs = context.database.listRuns(context.task.id);
  assert.equal(runs.length, 2);
  const next = runs[0];
  assert.equal(next.status, "starting");
  assert.equal(next.claudeShortId, "short-1");
  const saved = context.database.followups.get(followup.id);
  assert.deepEqual([saved.mode, saved.status, saved.error, saved.runId], ["queue", "sent", STEER_NOT_DELIVERED_QUEUED, next.id]);
  assert.equal(context.database.getTask(context.task.id).status, "in_progress");
  assert.ok(context.database.comments.some((comment) => comment.body === "第一輪結果"));
  assert.deepEqual(context.providers.claude.calls.sendFollowup.at(-1).mode, "queue");
});

test("W3 bug 1: a steer that could not be delivered to a stopped run is marked failed, not left pending", async () => {
  let service;
  let runId;
  const context = setup({
    claude: {
      sendFollowup: async () => {
        await service.handleProviderUpdate(runId, { status: "failed", error: "session crashed" });
        return { delivered: false, detail: "gone" };
      },
    },
  });
  service = context.service;
  runId = (await startedRunning(context)).id;
  const { followup } = await context.service.sendFollowup({ taskId: context.task.id, body: "x", mode: "steer", actor: USER });
  await context.service.settle();
  const saved = context.database.followups.get(followup.id);
  assert.deepEqual([saved.status, saved.error], ["failed", STEER_NOT_DELIVERED_RUN_ENDED]);
  assert.equal(context.database.listRuns(context.task.id).length, 1);
});

test("W3 bug 4: start and continue refuse a missing project folder with 409 WORKSPACE_NOT_FOUND", async () => {
  const context = setup({ workspaceExists: () => false });
  await assert.rejects(
    context.service.startTask({ taskId: context.task.id, actor: USER }),
    (error) => error.status === 409 && error.code === "WORKSPACE_NOT_FOUND" && error.message === "專案資料夾不存在：C:\\work\\p1",
  );
  assert.equal(context.database.runs.size, 0);
  assert.equal(context.database.getTask(context.task.id).status, "todo");
  assert.equal(context.providers.claude.calls.start.length, 0);

  let exists = true;
  const later = setup({ workspaceExists: () => exists });
  const first = await startedRunning(later);
  await later.service.handleProviderUpdate(first.id, { status: "finished", resultText: "ok" });
  exists = false;
  await assert.rejects(
    later.service.continueTask({ taskId: later.task.id, body: "再做", actor: USER }),
    (error) => error.status === 409 && error.code === "WORKSPACE_NOT_FOUND",
  );
  assert.equal(later.database.listRuns(later.task.id).length, 1);
  assert.equal(later.database.getTask(later.task.id).status, "in_review");

  const noFolder = setup();
  noFolder.database.projects.get("p1").workspacePath = null;
  await assert.rejects(
    noFolder.service.startTask({ taskId: noFolder.task.id, actor: USER }),
    (error) => error.status === 409 && error.code === "WORKSPACE_NOT_FOUND",
  );
});

test("workspaceDirectoryExists accepts directories only", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const directory = await mkdtemp(path.join(os.tmpdir(), "run-service-workspace-"));
  try {
    const file = path.join(directory, "a.txt");
    await writeFile(file, "x");
    assert.equal(workspaceDirectoryExists(directory), true);
    assert.equal(workspaceDirectoryExists(file), false);
    assert.equal(workspaceDirectoryExists(path.join(directory, "missing")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ---- W5: W4 live retest bugs A-D and W4 review lows ----

const WAITING = "WAITING_FOR_PERMISSION: permission prompt";

test("W5 bug A: a steer while the run waits for permission never calls the provider and is queued with STEER_WAITING_PERMISSION_QUEUED", async () => {
  const context = setup();
  const run = await startedRunning(context);
  await context.service.handleProviderUpdate(run.id, { status: "running", error: WAITING });
  assert.equal(context.database.getRun(run.id).error, WAITING);

  const { followup } = await context.service.sendFollowup({ taskId: context.task.id, body: "先停一下", mode: "steer", actor: USER });
  await context.service.settle();
  assert.equal(context.providers.claude.calls.sendFollowup.length, 0, "nothing is typed into the permission prompt");
  let saved = context.database.followups.get(followup.id);
  assert.deepEqual([saved.mode, saved.status, saved.error], ["queue", "pending", STEER_WAITING_PERMISSION_QUEUED]);

  // The person approves in the App; the turn finishes; the message is sent as the next turn.
  await context.service.handleProviderUpdate(run.id, { status: "running" });
  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "第一輪" });
  saved = context.database.followups.get(followup.id);
  assert.equal(saved.status, "sent");
  assert.deepEqual(context.providers.claude.calls.sendFollowup.map((call) => [call.mode, call.body]), [["queue", "先停一下"]]);
});

test("W5 bug A: the provider's own waiting check (agents at send time) also converts the steer", async () => {
  const context = setup({
    claude: {
      sendFollowup: ({ mode }) => (mode === "steer"
        ? { delivered: false, waitingForPermission: true, detail: WAITING }
        : { delivered: true, detail: "ok" }),
    },
  });
  await startedRunning(context);
  const { followup } = await context.service.sendFollowup({ taskId: context.task.id, body: "補一句", mode: "steer", actor: USER });
  await context.service.settle();
  const saved = context.database.followups.get(followup.id);
  assert.deepEqual([saved.mode, saved.status, saved.error], ["queue", "pending", STEER_WAITING_PERMISSION_QUEUED]);
});

test("W5 bug A: a queued send that finds the session waiting for permission keeps the message pending until the next finish", async () => {
  let waiting = true;
  const context = setup({
    claude: {
      sendFollowup: () => (waiting
        ? { delivered: false, waitingForPermission: true, detail: WAITING }
        : { delivered: true, detail: "ok" }),
    },
  });
  const run = await startedRunning(context);
  const { followup } = await context.service.sendFollowup({ taskId: context.task.id, body: "之後再做這個", mode: "queue", actor: USER });

  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "R1" });
  assert.equal(context.database.followups.get(followup.id).status, "pending");
  assert.equal(context.database.getRun(run.id).status, "running");
  assert.equal(context.database.getTask(context.task.id).status, "in_progress");
  assert.ok(!context.database.comments.some((comment) => /沒有送達/.test(comment.body)));

  waiting = false;
  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "R2" });
  assert.equal(context.database.followups.get(followup.id).status, "sent");
  assert.equal(context.providers.claude.calls.sendFollowup.length, 2);
});

test("W5 bug A: continue while the session waits for permission keeps the run active and queues the message", async () => {
  let waiting = true;
  const context = setup({
    status: "in_review",
    claude: {
      sendFollowup: () => (waiting
        ? { delivered: false, waitingForPermission: true, detail: WAITING }
        : { delivered: true, detail: "ok" }),
    },
  });
  const previous = context.database.createRun({ taskId: context.task.id, provider: "claude" });
  context.database.updateRun(previous.id, { status: "finished", claudeShortId: "short-1" });

  const { run } = await context.service.continueTask({ taskId: context.task.id, body: "再補一段", actor: USER });
  await context.service.settle();
  assert.ok(ACTIVE.has(context.database.getRun(run.id).status), "the run is not failed");
  assert.equal(context.database.getTask(context.task.id).status, "in_progress");
  const queued = context.database.listPendingFollowups(context.task.id);
  assert.deepEqual(queued.map((item) => [item.body, item.runId]), [["再補一段", run.id]]);

  waiting = false;
  await context.service.handleProviderUpdate(run.id, { status: "running" });
  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "done" });
  assert.equal(context.database.followups.get(queued[0].id).status, "sent");
});

test("W5 bug B: a converted steer is sent with since=createdAt; if the session already absorbed it, it is not re-sent", async () => {
  const context = setup({
    claude: {
      sendFollowup: ({ mode, since }) => {
        if (mode === "steer") return { delivered: false, detail: "NOT_CONFIRMED_IN_TRANSCRIPT" };
        return since
          ? { delivered: true, alreadyInTranscript: true, detail: "ALREADY_IN_TRANSCRIPT via queued-command" }
          : { delivered: true, detail: "typed" };
      },
    },
  });
  const run = await startedRunning(context);
  const { followup } = await context.service.sendFollowup({ taskId: context.task.id, body: "建立 steer.txt", mode: "steer", actor: USER });
  await context.service.settle();
  assert.equal(context.database.followups.get(followup.id).error, STEER_NOT_DELIVERED_QUEUED);

  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "STEERED LOOP-DONE" });
  const queueCall = context.providers.claude.calls.sendFollowup.at(-1);
  assert.equal(queueCall.mode, "queue");
  assert.equal(queueCall.since, followup.createdAt);
  const saved = context.database.followups.get(followup.id);
  assert.equal(saved.status, "sent");
  assert.equal(context.database.getRun(run.id).status, "finished");
  assert.equal(context.database.getTask(context.task.id).status, "in_review");
  assert.equal(context.database.comments.filter((comment) => comment.body.includes("STEERED LOOP-DONE")).length, 1);
});

test("W5 bug B: ordinary queued messages are sent without since", async () => {
  const context = setup();
  const run = await startedRunning(context);
  await context.service.sendFollowup({ taskId: context.task.id, body: "普通排隊", mode: "queue", actor: USER });
  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "R" });
  assert.equal(context.providers.claude.calls.sendFollowup.at(-1).since, undefined);
});

test("W5 review: recoverOnStartup fails leftover pending steers with STEER_INTERRUPTED_BY_RESTART; queued ones stay pending", async () => {
  const database = new FakeDatabase();
  database.addProject({ id: "p1", workspacePath: "C:\\work\\p1" });
  database.addTask({ id: "task-1", status: "in_progress" });
  const run = database.createRun({ taskId: "task-1", provider: "claude" });
  database.updateRun(run.id, { status: "running", claudeShortId: "s-1" });
  const steer = database.createFollowup({ taskId: "task-1", runId: run.id, body: "插嘴", mode: "steer" });
  const queued = database.createFollowup({ taskId: "task-1", runId: run.id, body: "排隊", mode: "queue" });
  const events = [];
  const service = createRunService({
    database,
    providers: { claude: fakeProvider("claude", { recover: () => ({ status: "running" }) }), codex: fakeProvider("codex") },
    emit: (type, payload) => events.push({ type, payload }),
    buildPrompt: () => "unused",
  });

  await service.recoverOnStartup();

  const savedSteer = database.followups.get(steer.id);
  assert.deepEqual([savedSteer.status, savedSteer.error], ["failed", STEER_INTERRUPTED_BY_RESTART]);
  assert.equal(database.followups.get(queued.id).status, "pending");
  assert.equal(database.getRun(run.id).status, "running");
  assert.ok(events.some((event) => event.type === "followup.updated" && event.payload.followup.id === steer.id));
});

test("W5 review: a run that ends failed / interrupted / stopped cancels its queued follow-ups with RUN_ENDED", async () => {
  for (const status of ["failed", "interrupted", "stopped"]) {
    const context = setup();
    const run = await startedRunning(context);
    const { followup } = await context.service.sendFollowup({ taskId: context.task.id, body: `排隊-${status}`, mode: "queue", actor: USER });
    await context.service.handleProviderUpdate(run.id, { status, error: `${status} X` });
    const saved = context.database.followups.get(followup.id);
    assert.deepEqual([saved.status, saved.error], ["canceled", RUN_ENDED], status);
  }
});

test("W5 review: a canceled queued message is not sent to a later continuation", async () => {
  const context = setup();
  const run = await startedRunning(context);
  const { followup } = await context.service.sendFollowup({ taskId: context.task.id, body: "舊的排隊訊息", mode: "queue", actor: USER });
  await context.service.handleProviderUpdate(run.id, { status: "failed", error: "crashed" });
  assert.equal(context.database.getTask(context.task.id).status, "blocked");

  const { run: next } = await context.service.continueTask({ taskId: context.task.id, body: "繼續", actor: USER });
  await context.service.settle();
  await context.service.handleProviderUpdate(next.id, { status: "running" });
  await context.service.handleProviderUpdate(next.id, { status: "finished", resultText: "OK" });
  assert.deepEqual(context.providers.claude.calls.sendFollowup.map((call) => call.body), ["繼續"]);
  assert.equal(context.database.followups.get(followup.id).status, "canceled");
  assert.equal(context.database.getTask(context.task.id).status, "in_review");
});

test("W5 review: stopTask cancels pending follow-ups with RUN_ENDED", async () => {
  const context = setup();
  await startedRunning(context);
  const { followup } = await context.service.sendFollowup({ taskId: context.task.id, body: "later", mode: "queue", actor: USER });
  await context.service.stopTask({ taskId: context.task.id, destination: null, actor: USER });
  const saved = context.database.followups.get(followup.id);
  assert.deepEqual([saved.status, saved.error], ["canceled", RUN_ENDED]);
});

test("W5 review: a start failure cancels queued follow-ups with RUN_ENDED", async () => {
  let rejectStart;
  const context = setup({ claude: { start: () => new Promise((resolve, reject) => { rejectStart = reject; }) } });
  const { run } = await context.service.startTask({ taskId: context.task.id, actor: USER });
  await new Promise((resolve) => setImmediate(resolve));
  const followup = context.database.createFollowup({ taskId: context.task.id, runId: run.id, body: "排隊", mode: "queue" });
  rejectStart(new Error("CLAUDE_BG_START_FAILED"));
  await context.service.settle();
  assert.equal(context.database.getRun(run.id).status, "failed");
  const saved = context.database.followups.get(followup.id);
  assert.deepEqual([saved.status, saved.error], ["canceled", RUN_ENDED]);
});

test("W5 review: restart with a 'starting' run that has no refs → interrupted and the card is blocked", async () => {
  const database = new FakeDatabase();
  database.addProject({ id: "p1", workspacePath: "C:\\work\\p1" });
  for (const [taskId, provider] of [["task-claude", "claude"], ["task-codex", "codex"]]) {
    database.addTask({ id: taskId, status: "in_progress", assignee: provider === "claude" ? CLAUDE_AGENT_ACTOR : CODEX_AGENT_ACTOR });
    database.createRun({ taskId, provider });
  }
  // recover behaves like the real providers: no session refs → interrupted.
  const recoverByRefs = (run) => (run.claudeShortId || run.codexThreadId ? { status: "running" } : { status: "interrupted" });
  const claude = fakeProvider("claude", { recover: recoverByRefs });
  const codex = fakeProvider("codex", { recover: recoverByRefs });
  const service = createRunService({ database, providers: { claude, codex }, emit: () => {}, buildPrompt: () => "unused" });

  await service.recoverOnStartup();

  assert.equal(claude.calls.recover.length, 1);
  assert.equal(codex.calls.recover.length, 1);
  assert.equal(claude.calls.recover[0].status, "starting");
  for (const [taskId, actorId] of [["task-claude", "claude-agent"], ["task-codex", "codex-agent"]]) {
    const run = database.listRuns(taskId)[0];
    assert.equal(run.status, "interrupted");
    assert.equal(run.error, RESTART_INTERRUPTED_TEXT);
    assert.ok(run.endedAt);
    assert.equal(database.getTask(taskId).status, "blocked");
    const comment = database.comments.filter((item) => item.taskId === taskId).at(-1);
    assert.equal(comment.authorId, actorId);
    assert.match(comment.body, /看板重新啟動/);
  }
});

test("W5 Amendment 5: Claude start uses the project's claudePermissionMode; Codex gets none", async () => {
  const context = setup();
  context.database.automations.set("p1", { ...context.database.getProjectAutomation("p1"), claudePermissionMode: "acceptEdits" });
  await context.service.startTask({ taskId: context.task.id, actor: USER });
  await context.service.settle();
  assert.equal(context.providers.claude.calls.start[0].permissionMode, "acceptEdits");

  const codex = setup({ assignee: CODEX_AGENT_ACTOR });
  await codex.service.startTask({ taskId: codex.task.id, actor: USER });
  await codex.service.settle();
  assert.equal(Object.hasOwn(codex.providers.codex.calls.start[0], "permissionMode"), false);
});

// ---- Amendment 6: followClaude ----

test("Amendment 6: followClaude is the default and the mode list has three choices", () => {
  assert.deepEqual([...CLAUDE_PERMISSION_MODES], ["followClaude", "acceptEdits", "bypassPermissions"]);
  assert.equal(DEFAULT_CLAUDE_PERMISSION_MODE, "followClaude");
});

test("Amendment 6: followClaude with a Claude settings mode starts without a flag and records the effective mode", async () => {
  const detections = [];
  const context = setup({
    detectClaudePermission: async (input) => {
      detections.push(input);
      return {
        effectiveMode: "acceptEdits",
        source: { scope: "project", path: "C:\\work\\p1\\.claude\\settings.json", configuredMode: "acceptEdits" },
      };
    },
  });
  const { run } = await context.service.startTask({ taskId: context.task.id, actor: USER });
  await context.service.settle();
  assert.deepEqual(detections, [{ cwd: "C:\\work\\p1" }]);
  const start = context.providers.claude.calls.start[0];
  assert.equal(Object.hasOwn(start, "permissionMode"), true);
  assert.equal(start.permissionMode, null, "null = no --permission-mode flag");
  const saved = context.database.getRun(run.id);
  assert.deepEqual([saved.claudePermissionMode, saved.claudePermissionSource], ["acceptEdits", "project"]);
  assert.ok(
    context.events.some((event) => event.type === "run.updated" && event.payload.run.claudePermissionSource === "project"),
    "the permission record is emitted before the session starts",
  );
});

test("Amendment 6: followClaude without any Claude settings passes bypassPermissions and records the fallback", async () => {
  const context = setup();
  const { run } = await context.service.startTask({ taskId: context.task.id, actor: USER });
  await context.service.settle();
  assert.equal(context.providers.claude.calls.start[0].permissionMode, "bypassPermissions");
  const saved = context.database.getRun(run.id);
  assert.deepEqual([saved.claudePermissionMode, saved.claudePermissionSource], ["bypassPermissions", "fallback"]);
});

test("Amendment 6: project auto (built-in default) starts without a flag and records a null mode", async () => {
  const context = setup({
    detectClaudePermission: async () => ({
      effectiveMode: null,
      source: { scope: "projectLocal", path: "C:\\work\\p1\\.claude\\settings.local.json", configuredMode: "auto" },
    }),
  });
  const { run } = await context.service.startTask({ taskId: context.task.id, actor: USER });
  await context.service.settle();
  assert.equal(context.providers.claude.calls.start[0].permissionMode, null);
  const saved = context.database.getRun(run.id);
  assert.deepEqual([saved.claudePermissionMode, saved.claudePermissionSource], [null, "projectLocal"]);
});

test("Amendment 6: a settings read that throws falls back to bypassPermissions", async () => {
  const context = setup({ detectClaudePermission: async () => { throw new Error("EACCES"); } });
  const { run } = await context.service.startTask({ taskId: context.task.id, actor: USER });
  await context.service.settle();
  assert.equal(context.providers.claude.calls.start[0].permissionMode, "bypassPermissions");
  assert.equal(context.database.getRun(run.id).claudePermissionSource, "fallback");
  assert.equal(context.database.getRun(run.id).status, "starting");
});

test("Amendment 6: an unknown detection scope falls back; an unknown effective mode is recorded as null", async () => {
  const unknownScope = setup({ detectClaudePermission: async () => ({ effectiveMode: "plan", source: { scope: "registry" } }) });
  const first = await unknownScope.service.startTask({ taskId: unknownScope.task.id, actor: USER });
  await unknownScope.service.settle();
  assert.equal(unknownScope.providers.claude.calls.start[0].permissionMode, "bypassPermissions");
  assert.equal(unknownScope.database.getRun(first.run.id).claudePermissionSource, "fallback");

  const unknownMode = setup({ detectClaudePermission: async () => ({ effectiveMode: "yolo", source: { scope: "user" } }) });
  const second = await unknownMode.service.startTask({ taskId: unknownMode.task.id, actor: USER });
  await unknownMode.service.settle();
  assert.equal(unknownMode.providers.claude.calls.start[0].permissionMode, null);
  const saved = unknownMode.database.getRun(second.run.id);
  assert.deepEqual([saved.claudePermissionMode, saved.claudePermissionSource], [null, "user"]);
  assert.equal(saved.status, "starting");
});

test("Amendment 6: an explicit board choice never reads Claude settings; Codex records nothing", async () => {
  for (const mode of ["acceptEdits", "bypassPermissions"]) {
    let detections = 0;
    const context = setup({ detectClaudePermission: async () => { detections += 1; return { effectiveMode: "plan", source: { scope: "user" } }; } });
    context.database.automations.set("p1", { ...context.database.getProjectAutomation("p1"), claudePermissionMode: mode });
    const { run } = await context.service.startTask({ taskId: context.task.id, actor: USER });
    await context.service.settle();
    assert.equal(detections, 0);
    assert.equal(context.providers.claude.calls.start[0].permissionMode, mode);
    const saved = context.database.getRun(run.id);
    assert.deepEqual([saved.claudePermissionMode, saved.claudePermissionSource], [mode, "board"]);
  }
  const codex = setup({ assignee: CODEX_AGENT_ACTOR, detectClaudePermission: async () => { throw new Error("must not be called"); } });
  const { run } = await codex.service.startTask({ taskId: codex.task.id, actor: USER });
  await codex.service.settle();
  const saved = codex.database.getRun(run.id);
  assert.deepEqual([saved.claudePermissionMode, saved.claudePermissionSource], [null, null]);
});

test("Amendment 6: a continuation run keeps the session's permission record", async () => {
  const context = setup({
    detectClaudePermission: async () => ({ effectiveMode: "acceptEdits", source: { scope: "user", path: "u", configuredMode: "acceptEdits" } }),
  });
  const first = await startedRunning(context);
  await context.service.handleProviderUpdate(first.id, { status: "finished", resultText: "done" });
  const { run } = await context.service.continueTask({ taskId: context.task.id, body: "再做一次", actor: USER });
  await context.service.settle();
  const saved = context.database.getRun(run.id);
  assert.notEqual(saved.id, first.id);
  assert.deepEqual([saved.claudePermissionMode, saved.claudePermissionSource], ["acceptEdits", "user"]);
});

test("W6: a converted steer whose continuation fails to deliver is recorded failed, not canceled RUN_ENDED", async () => {
  let service;
  let runId;
  const context = setup({
    claude: {
      sendFollowup: async ({ mode }) => {
        if (mode === "steer") {
          await service.handleProviderUpdate(runId, { status: "finished", resultText: "第一輪結果" });
          return { delivered: false, detail: "NOT_CONFIRMED_IN_TRANSCRIPT" };
        }
        return { delivered: false, detail: "session gone" };
      },
    },
  });
  service = context.service;
  const first = await startedRunning(context);
  runId = first.id;
  const { followup } = await context.service.sendFollowup({ taskId: context.task.id, body: "再加一行", mode: "steer", actor: USER });
  await context.service.settle();

  const runs = context.database.listRuns(context.task.id);
  assert.equal(runs.length, 2);
  const next = runs[0];
  assert.equal(next.status, "failed");
  const saved = context.database.followups.get(followup.id);
  assert.deepEqual([saved.mode, saved.status, saved.error, saved.runId], ["queue", "failed", "session gone", next.id]);
  assert.notEqual(saved.error, RUN_ENDED);
  assert.equal(context.database.getTask(context.task.id).status, "blocked");
});

test("W6: other queued follow-ups are still canceled RUN_ENDED when the converted steer's continuation fails", async () => {
  let service;
  let runId;
  let otherId;
  const context = setup({
    claude: {
      sendFollowup: async ({ mode }) => {
        if (mode === "steer") {
          await service.handleProviderUpdate(runId, { status: "finished", resultText: "第一輪結果" });
          return { delivered: false, detail: "NOT_CONFIRMED_IN_TRANSCRIPT" };
        }
        // The continuation run is open: queue another message on it before the delivery fails.
        const active = context.database.getActiveRun(context.task.id);
        otherId = context.database.createFollowup({ taskId: context.task.id, runId: active.id, body: "later", mode: "queue" }).id;
        return { delivered: false, detail: "session gone" };
      },
    },
  });
  service = context.service;
  runId = (await startedRunning(context)).id;
  const { followup } = await context.service.sendFollowup({ taskId: context.task.id, body: "steer", mode: "steer", actor: USER });
  await context.service.settle();

  assert.deepEqual(
    [context.database.followups.get(followup.id).status, context.database.followups.get(followup.id).error],
    ["failed", "session gone"],
  );
  const other = context.database.followups.get(otherId);
  assert.deepEqual([other.status, other.error], ["canceled", RUN_ENDED]);
});

test("W6: applyFinished never posts the same result twice for the same run", async () => {
  const context = setup();
  const run = await startedRunning(context);
  await context.service.sendFollowup({ taskId: context.task.id, body: "排隊訊息", mode: "queue", actor: USER });

  // First finish: the result is posted and the queued message starts the next turn in the same run.
  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "同一份結果" });
  assert.equal(context.database.getRun(run.id).status, "running");
  // The provider reports the same result again for the same run.
  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "同一份結果" });
  await context.service.settle();

  const posted = context.database.comments.filter((comment) => comment.body === "同一份結果");
  assert.equal(posted.length, 1);
  assert.equal(context.database.getRun(run.id).status, "finished");
  assert.equal(context.database.getTask(context.task.id).status, "in_review");
});

test("W6: a duplicate result is not re-posted while a different result of the same run still is", async () => {
  const context = setup({
    claude: { sendFollowup: async () => ({ delivered: false, waitingForPermission: true, detail: "prompt" }) },
  });
  const run = await startedRunning(context);
  await context.service.sendFollowup({ taskId: context.task.id, body: "排隊訊息", mode: "queue", actor: USER });

  // Waiting for permission keeps the run active and the message queued; each finish retries.
  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "結果一" });
  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "結果一" });
  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "結果二" });
  await context.service.settle();

  assert.equal(context.database.comments.filter((comment) => comment.body === "結果一").length, 1);
  assert.equal(context.database.comments.filter((comment) => comment.body === "結果二").length, 1);
});

test("W6b: the same result text from a later turn (after a running update) is posted again", async () => {
  const context = setup();
  const run = await startedRunning(context);
  await context.service.sendFollowup({ taskId: context.task.id, body: "排隊訊息", mode: "queue", actor: USER });
  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "OK" });
  assert.equal(context.database.getRun(run.id).status, "running");
  await context.service.handleProviderUpdate(run.id, { status: "running" });
  await context.service.handleProviderUpdate(run.id, { status: "finished", resultText: "OK" });
  await context.service.settle();
  const posted = context.database.comments.filter((comment) => comment.body === "OK");
  assert.equal(posted.length, 2);
});
