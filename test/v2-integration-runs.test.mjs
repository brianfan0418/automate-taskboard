// v2 integration (I-S): runs, automation and task JSON over real HTTP with fake providers.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer, describeStartupError } from "../server/index.mjs";
import { CodexAppServer } from "../server/codex-app-server.mjs";
import {
  boardRunEnvironment,
  createUnavailableRunProvider,
  resolveConptyHelperPath,
  runTransitionForStatusChange,
} from "../server/app.mjs";

const TASKCTL = { "x-taskboard-client": "taskctl" };

// node:test runs t.after hooks in registration order; remove a data directory only after the
// server that holds its SQLite files has closed.
function cleanupAfter(t, directory, ...apps) {
  t.after(async () => {
    for (const app of apps) await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
}
const quietLogger = { info() {}, warn() {}, error() {} };

function createFakeProvider(name) {
  const provider = {
    name,
    calls: [],
    startError: null,
    stopResult: { stopped: true, detail: "stopped" },
    followupResult: { delivered: true, detail: "delivered" },
    recoverResult: { status: "interrupted" },
    disposed: false,
    async available() {
      return { ok: true, version: `${name}-test` };
    },
    async start(input) {
      provider.calls.push({ method: "start", input });
      if (provider.startError) throw provider.startError;
      return name === "codex"
        ? { codexThreadId: `thread-${input.runId}`, codexTurnId: "turn-1" }
        : { claudeShortId: "short-1", claudeSessionId: "session-1", claudeBridgeSessionId: "bridge-1" };
    },
    async sendFollowup(input) {
      provider.calls.push({ method: "sendFollowup", input });
      return provider.followupResult;
    },
    async stop(input) {
      provider.calls.push({ method: "stop", input });
      return provider.stopResult;
    },
    async close(input) {
      provider.calls.push({ method: "close", input });
    },
    openUrl(run) {
      if (name === "codex") return run.codexThreadId ? `codex://threads/${run.codexThreadId}` : null;
      return run.claudeBridgeSessionId ? `claude://claude.ai/epitaxy/${run.claudeBridgeSessionId}` : null;
    },
    async recover(run) {
      provider.calls.push({ method: "recover", input: run });
      return provider.recoverResult;
    },
    async dispose() {
      provider.disposed = true;
    },
  };
  return provider;
}

async function startBoard(t, { directory, providers, ...options } = {}) {
  const dataDirectory = directory ?? await mkdtemp(path.join(os.tmpdir(), "taskboard-v2-integration-"));
  const runProviders = providers ?? { claude: createFakeProvider("claude"), codex: createFakeProvider("codex") };
  const app = createTaskboardServer({
    dataDirectory,
    runProviders,
    enableScheduler: false,
    runLogger: quietLogger,
    // Amendment 6: never read this machine's Claude settings; by default no file selects a mode.
    claudePermissionDetector: async () => ({ effectiveMode: null, source: null }),
    ...options,
  });
  const address = await app.listen({ port: 0 });
  await app.whenStarted();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
  };
  if (directory) {
    t.after(close);
  } else {
    t.after(async () => {
      await close();
      await rm(dataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
  }
  return { app, providers: runProviders, baseUrl: `http://127.0.0.1:${address.port}`, dataDirectory, close };
}

async function api(baseUrl, pathname, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function createProject(baseUrl, id = "work") {
  // W3 bug 4: runs need an existing project folder.
  await mkdir(path.join(os.tmpdir(), id), { recursive: true });
  const created = await api(baseUrl, "/api/projects", {
    method: "POST",
    body: { id, name: id, workspacePath: path.join(os.tmpdir(), id) },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.project;
}

async function createTask(baseUrl, { projectId = "work", title = "整理報表", status = "todo", assigneeTarget = "claude-agent", headers } = {}) {
  const created = await api(baseUrl, "/api/tasks", {
    method: "POST",
    headers,
    body: { projectId, title, status, ...(assigneeTarget ? { assigneeTarget } : {}) },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.task;
}

async function getTask(baseUrl, id) {
  const result = await api(baseUrl, `/api/tasks/${id}`);
  assert.equal(result.status, 200);
  return result.body.task;
}

async function comments(baseUrl, id) {
  const result = await api(baseUrl, `/api/tasks/${id}/comments`);
  assert.equal(result.status, 200);
  return result.body.comments;
}

test("S1: start → running → finished moves the card to in_review with an agent comment and latestRun", async (t) => {
  const { app, baseUrl, providers } = await startBoard(t);
  await createProject(baseUrl);
  const task = await createTask(baseUrl);
  assert.equal(task.activeRun, null);
  assert.equal(task.latestRun, null);

  const started = await api(baseUrl, `/api/tasks/${task.id}/run/start`, { method: "POST", body: {} });
  // W3 bug 3: 202 Accepted with a starting run; provider refs arrive in the background.
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal(started.body.task.status, "in_progress");
  assert.equal(started.body.run.provider, "claude");
  assert.equal(started.body.run.status, "starting");
  assert.equal(started.body.task.activeRun.id, started.body.run.id);
  await app.runService.settle();
  assert.equal((await getTask(baseUrl, task.id)).activeRun.claudeShortId, "short-1");
  const startCall = providers.claude.calls.find((call) => call.method === "start");
  assert.equal(startCall.input.cwd, path.join(os.tmpdir(), "work"));
  assert.match(startCall.input.prompt, /整理報表/);
  assert.match(startCall.input.title, /整理報表/);
  assert.equal(startCall.input.permissionMode, "bypassPermissions", "Amendment 6 default followClaude, no Claude settings → fallback");
  const startedRun = (await getTask(baseUrl, task.id)).activeRun;
  assert.deepEqual([startedRun.claudePermissionMode, startedRun.claudePermissionSource], ["bypassPermissions", "fallback"]);

  const runId = started.body.run.id;
  await app.runService.handleProviderUpdate(runId, { status: "running" });
  const listed = await api(baseUrl, "/api/tasks?projectId=work");
  const listedTask = listed.body.tasks.find((candidate) => candidate.id === task.id);
  assert.equal(listedTask.activeRun.status, "running");

  await app.runService.handleProviderUpdate(runId, { status: "finished", resultText: "報表整理好了：out/report.xlsx" });
  const finished = await getTask(baseUrl, task.id);
  assert.equal(finished.status, "in_review");
  assert.equal(finished.activeRun, null);
  assert.equal(finished.latestRun.id, runId);
  assert.equal(finished.latestRun.status, "finished");
  assert.equal(finished.latestRun.resultText, "報表整理好了：out/report.xlsx");
  const agentComment = (await comments(baseUrl, task.id)).at(-1);
  assert.equal(agentComment.authorId, "claude-agent");
  assert.equal(agentComment.authorName, "Claude");
  assert.equal(agentComment.body, "報表整理好了：out/report.xlsx");
});

test("start failure leaves a failed run, an agent comment and a blocked card", async (t) => {
  const { app, baseUrl, providers } = await startBoard(t);
  await createProject(baseUrl);
  providers.codex.startError = new Error("codex app-server exited");
  const task = await createTask(baseUrl, { assigneeTarget: "codex-agent" });
  const started = await api(baseUrl, `/api/tasks/${task.id}/run/start`, { method: "POST" });
  assert.equal(started.status, 202);
  assert.equal(started.body.run.status, "starting");
  await app.runService.settle();
  const blocked = await getTask(baseUrl, task.id);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.latestRun.status, "failed");
  const last = (await comments(baseUrl, task.id)).at(-1);
  assert.equal(last.authorId, "codex-agent");
  assert.match(last.body, /codex app-server exited/);
});

test("start requires an AI assignee and a todo card", async (t) => {
  const { baseUrl } = await startBoard(t);
  await createProject(baseUrl);
  const mine = await createTask(baseUrl, { assigneeTarget: "current-user" });
  const notAgent = await api(baseUrl, `/api/tasks/${mine.id}/run/start`, { method: "POST", body: {} });
  assert.equal(notAgent.status, 409);
  assert.equal(notAgent.body.error.code, "ASSIGNEE_NOT_AGENT");
  const backlog = await createTask(baseUrl, { status: "backlog" });
  const notTodo = await api(baseUrl, `/api/tasks/${backlog.id}/run/start`, { method: "POST", body: {} });
  assert.equal(notTodo.status, 409);
  assert.equal(notTodo.body.error.code, "TASK_NOT_TODO");
  const unknownField = await api(baseUrl, `/api/tasks/${backlog.id}/run/start`, { method: "POST", body: { version: 1 } });
  assert.equal(unknownField.status, 400);
  assert.equal(unknownField.body.error.code, "UNKNOWN_FIELD");
});

test("stop with a destination interrupts the run and moves the card", async (t) => {
  const { app, baseUrl, providers } = await startBoard(t);
  await createProject(baseUrl);
  const task = await createTask(baseUrl, { assigneeTarget: "codex-agent" });
  const started = await api(baseUrl, `/api/tasks/${task.id}/run/start`, { method: "POST", body: {} });
  await app.runService.handleProviderUpdate(started.body.run.id, { status: "running" });

  const stopped = await api(baseUrl, `/api/tasks/${task.id}/run/stop`, { method: "POST", body: { destination: "backlog" } });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.equal(stopped.body.task.status, "backlog");
  assert.equal(stopped.body.run.status, "stopped");
  assert.equal(stopped.body.task.activeRun, null);
  assert.equal(providers.codex.calls.filter((call) => call.method === "stop").length, 1);

  const invalid = await api(baseUrl, `/api/tasks/${task.id}/run/stop`, { method: "POST", body: { destination: "done" } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, "INVALID_DESTINATION");
});

test("queued follow-up waits while running and is sent when the turn finishes; the card stays in_progress", async (t) => {
  const { app, baseUrl, providers } = await startBoard(t);
  await createProject(baseUrl);
  const task = await createTask(baseUrl, { assigneeTarget: "codex-agent" });
  const started = await api(baseUrl, `/api/tasks/${task.id}/run/start`, { method: "POST", body: {} });
  const runId = started.body.run.id;
  await app.runService.handleProviderUpdate(runId, { status: "running" });

  const queued = await api(baseUrl, `/api/tasks/${task.id}/run/followup`, {
    method: "POST",
    body: { body: "順便把圖表也更新", mode: "queue" },
  });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  assert.equal(queued.body.followup.status, "pending");
  assert.equal(providers.codex.calls.filter((call) => call.method === "sendFollowup").length, 0);

  await app.runService.handleProviderUpdate(runId, { status: "finished", resultText: "第一輪完成" });
  const followupCalls = providers.codex.calls.filter((call) => call.method === "sendFollowup");
  assert.equal(followupCalls.length, 1);
  assert.equal(followupCalls[0].input.mode, "queue");
  assert.equal(followupCalls[0].input.body, "順便把圖表也更新");

  const afterFinish = await getTask(baseUrl, task.id);
  assert.equal(afterFinish.status, "in_progress");
  assert.equal(afterFinish.activeRun.id, runId);
  const runs = await api(baseUrl, `/api/tasks/${task.id}/runs`);
  assert.equal(runs.body.followups[0].status, "sent");
});

test("steer sends the follow-up into the running turn immediately", async (t) => {
  const { app, baseUrl, providers } = await startBoard(t);
  await createProject(baseUrl);
  const task = await createTask(baseUrl, { assigneeTarget: "codex-agent" });
  const started = await api(baseUrl, `/api/tasks/${task.id}/run/start`, { method: "POST", body: {} });
  await app.runService.handleProviderUpdate(started.body.run.id, { status: "running" });

  const steered = await api(baseUrl, `/api/tasks/${task.id}/run/followup`, {
    method: "POST",
    body: { body: "改用繁體中文", mode: "steer" },
  });
  assert.equal(steered.status, 202);
  assert.equal(steered.body.followup.status, "pending");
  await app.runService.settle();
  assert.equal((await api(baseUrl, `/api/tasks/${task.id}/runs`)).body.followups[0].status, "sent");
  const call = providers.codex.calls.find((entry) => entry.method === "sendFollowup");
  assert.equal(call.input.mode, "steer");

  const noRun = await createTask(baseUrl, { title: "沒有執行中", assigneeTarget: "codex-agent" });
  const rejected = await api(baseUrl, `/api/tasks/${noRun.id}/run/followup`, {
    method: "POST",
    body: { body: "x", mode: "queue" },
  });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, "RUN_NOT_ACTIVE");
});

test("continue from in_review reuses the AI session; rework returns the card to todo", async (t) => {
  const { app, baseUrl, providers } = await startBoard(t);
  await createProject(baseUrl);
  const task = await createTask(baseUrl);
  const started = await api(baseUrl, `/api/tasks/${task.id}/run/start`, { method: "POST", body: {} });
  await app.runService.handleProviderUpdate(started.body.run.id, { status: "running" });
  await app.runService.handleProviderUpdate(started.body.run.id, { status: "finished", resultText: "done" });

  const continued = await api(baseUrl, `/api/tasks/${task.id}/continue`, { method: "POST", body: { body: "再補一段摘要" } });
  assert.equal(continued.status, 202, JSON.stringify(continued.body));
  assert.equal(continued.body.task.status, "in_progress");
  assert.notEqual(continued.body.run.id, started.body.run.id);
  assert.equal(continued.body.run.claudeShortId, "short-1");
  assert.equal(continued.body.task.activeRun.id, continued.body.run.id);
  await app.runService.settle();
  const queueCall = providers.claude.calls.filter((call) => call.method === "sendFollowup").at(-1);
  assert.equal(queueCall.input.mode, "queue");
  assert.equal(queueCall.input.body, "再補一段摘要");

  await app.runService.handleProviderUpdate(continued.body.run.id, { status: "finished", resultText: "摘要補好了" });
  assert.equal((await getTask(baseUrl, task.id)).status, "in_review");

  const reworked = await api(baseUrl, `/api/tasks/${task.id}/rework`, { method: "POST", body: { body: "格式不對，請重做" } });
  assert.equal(reworked.status, 200, JSON.stringify(reworked.body));
  assert.equal(reworked.body.task.status, "todo");
  assert.equal(reworked.body.comment.body, "格式不對，請重做");
  assert.equal(reworked.body.task.latestRun.id, continued.body.run.id);
});

test("rework accepts an existing commentId: no second comment, active runs and foreign comments refused", async (t) => {
  const { app, baseUrl } = await startBoard(t);
  await createProject(baseUrl);
  const task = await createTask(baseUrl);
  const started = await api(baseUrl, `/api/tasks/${task.id}/run/start`, { method: "POST", body: {} });
  await app.runService.handleProviderUpdate(started.body.run.id, { status: "running" });
  const whileRunning = await api(baseUrl, `/api/tasks/${task.id}/comments`, { method: "POST", body: { body: "執行中留言" } });
  assert.equal(whileRunning.status, 201, JSON.stringify(whileRunning.body));
  const refused = await api(baseUrl, `/api/tasks/${task.id}/rework`, { method: "POST", body: { commentId: whileRunning.body.comment.id } });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "RUN_ALREADY_ACTIVE");
  await app.runService.handleProviderUpdate(started.body.run.id, { status: "finished", resultText: "done" });
  assert.equal((await getTask(baseUrl, task.id)).status, "in_review");

  const other = await createTask(baseUrl, { title: "other" });
  const foreign = await api(baseUrl, `/api/tasks/${other.id}/comments`, { method: "POST", body: { body: "別張卡" } });
  const wrongTask = await api(baseUrl, `/api/tasks/${task.id}/rework`, { method: "POST", body: { commentId: foreign.body.comment.id } });
  assert.equal(wrongTask.status, 404, JSON.stringify(wrongTask.body));
  assert.equal(wrongTask.body.error.code, "COMMENT_NOT_FOUND");
  const unknownKey = await api(baseUrl, `/api/tasks/${task.id}/continue`, { method: "POST", body: { commentId: foreign.body.comment.id } });
  assert.equal(unknownKey.status, 400, JSON.stringify(unknownKey.body));

  const comment = await api(baseUrl, `/api/tasks/${task.id}/comments`, { method: "POST", body: { body: "請重做，附件見留言" } });
  const before = (await api(baseUrl, `/api/tasks/${task.id}/comments`)).body.comments.length;
  const reworked = await api(baseUrl, `/api/tasks/${task.id}/rework`, { method: "POST", body: { commentId: comment.body.comment.id } });
  assert.equal(reworked.status, 200, JSON.stringify(reworked.body));
  assert.equal(reworked.body.task.status, "todo");
  assert.equal(reworked.body.comment.id, comment.body.comment.id);
  assert.equal((await api(baseUrl, `/api/tasks/${task.id}/comments`)).body.comments.length, before);
});

test("an AI agent cannot complete a card through move or PATCH; people can", async (t) => {
  const { baseUrl } = await startBoard(t);
  await createProject(baseUrl);
  const task = await createTask(baseUrl, { status: "in_review", assigneeTarget: "current-user" });

  const moved = await api(baseUrl, `/api/tasks/${task.id}/move`, {
    method: "POST",
    headers: TASKCTL,
    body: { version: task.version, status: "done" },
  });
  assert.equal(moved.status, 403);
  assert.equal(moved.body.error.code, "AGENT_CANNOT_COMPLETE");

  const patched = await api(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: TASKCTL,
    body: { version: task.version, status: "done" },
  });
  assert.equal(patched.status, 403);
  assert.equal(patched.body.error.code, "AGENT_CANNOT_COMPLETE");

  const byPerson = await api(baseUrl, `/api/tasks/${task.id}/move`, {
    method: "POST",
    body: { version: task.version, status: "done" },
  });
  assert.equal(byPerson.status, 200);
  assert.equal(byPerson.body.task.status, "done");
});

test("taskctl-created cards always start in backlog", async (t) => {
  const { baseUrl } = await startBoard(t);
  await createProject(baseUrl);
  const created = await api(baseUrl, "/api/tasks", {
    method: "POST",
    headers: TASKCTL,
    body: { projectId: "work", title: "AI 建的卡", status: "todo" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.task.status, "backlog");
  assert.equal(created.body.task.creatorId, "codex-agent");
  const byPerson = await createTask(baseUrl, { title: "人建的卡", status: "todo" });
  assert.equal(byPerson.status, "todo");
});

test("automation GET/PUT, order reset, and dragging inside todo switches to manual order", async (t) => {
  const { baseUrl } = await startBoard(t);
  await createProject(baseUrl);
  const defaults = await api(baseUrl, "/api/projects/work/automation");
  assert.equal(defaults.status, 200);
  assert.deepEqual(
    { ...defaults.body.automation, updatedAt: undefined },
    { projectId: "work", enabled: false, maxParallel: 3, claudeModel: null, codexModel: null, codexEffort: null, orderMode: "suggested", claudePermissionMode: "followClaude", updatedAt: undefined },
  );
  // Amendment 6: the GET answer also carries what Claude's own settings select (none here).
  assert.equal(defaults.body.claudeEffectivePermissionMode, null);
  assert.equal(defaults.body.claudePermissionSource, null);

  const updated = await api(baseUrl, "/api/projects/work/automation", {
    method: "PUT",
    body: { enabled: true, maxParallel: 2, claudeModel: "opus", codexEffort: "high" },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.automation.enabled, true);
  assert.equal(updated.body.automation.maxParallel, 2);
  assert.equal(updated.body.automation.claudeModel, "opus");

  const unknown = await api(baseUrl, "/api/projects/work/automation", { method: "PUT", body: { sandbox: "x" } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, "UNKNOWN_FIELD");

  // Amendment 5: per-project Claude permission mode.
  const acceptEdits = await api(baseUrl, "/api/projects/work/automation", { method: "PUT", body: { claudePermissionMode: "acceptEdits" } });
  assert.equal(acceptEdits.status, 200, JSON.stringify(acceptEdits.body));
  assert.equal(acceptEdits.body.automation.claudePermissionMode, "acceptEdits");
  assert.equal(acceptEdits.body.automation.maxParallel, 2);
  const invalidMode = await api(baseUrl, "/api/projects/work/automation", { method: "PUT", body: { claudePermissionMode: "plan" } });
  assert.equal(invalidMode.status, 400);
  assert.equal(invalidMode.body.error.code, "INVALID_FIELD");
  assert.equal((await api(baseUrl, "/api/projects/work/automation")).body.automation.claudePermissionMode, "acceptEdits");
  const follow = await api(baseUrl, "/api/projects/work/automation", { method: "PUT", body: { claudePermissionMode: "followClaude" } });
  assert.equal(follow.status, 200, JSON.stringify(follow.body));
  assert.equal(follow.body.automation.claudePermissionMode, "followClaude");
  const reverted = await api(baseUrl, "/api/projects/work/automation", { method: "PUT", body: { claudePermissionMode: "acceptEdits" } });
  assert.equal(reverted.body.automation.claudePermissionMode, "acceptEdits");

  const first = await createTask(baseUrl, { title: "A", assigneeTarget: "current-user" });
  const second = await createTask(baseUrl, { title: "B", assigneeTarget: "current-user" });
  const dragged = await api(baseUrl, `/api/tasks/${second.id}/move`, {
    method: "POST",
    body: { version: second.version, status: "todo", sortOrder: first.sortOrder + 500 },
  });
  assert.equal(dragged.status, 200, JSON.stringify(dragged.body));
  const manual = await api(baseUrl, "/api/projects/work/automation");
  assert.equal(manual.body.automation.orderMode, "manual");

  const reset = await fetch(`${baseUrl}/api/projects/work/order/reset`, { method: "POST" });
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).automation.orderMode, "suggested");
  const missing = await api(baseUrl, "/api/projects/nope/automation");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "PROJECT_NOT_FOUND");
});

test("Amendment 6: followClaude uses the detected Claude settings mode (no flag) and the GET answer previews it", async (t) => {
  const detections = [];
  let detected = {
    effectiveMode: "acceptEdits",
    source: { scope: "project", path: path.join(os.tmpdir(), "work", ".claude", "settings.json"), configuredMode: "acceptEdits" },
  };
  const { app, baseUrl, providers } = await startBoard(t, {
    claudePermissionDetector: async (input) => {
      detections.push(input);
      if (detected instanceof Error) throw detected;
      return detected;
    },
  });
  await createProject(baseUrl);
  const preview = await api(baseUrl, "/api/projects/work/automation");
  assert.equal(preview.status, 200);
  assert.equal(preview.body.automation.claudePermissionMode, "followClaude");
  assert.equal(preview.body.claudeEffectivePermissionMode, "acceptEdits");
  assert.deepEqual(preview.body.claudePermissionSource, detected.source);
  assert.deepEqual(detections.at(-1), { cwd: path.join(os.tmpdir(), "work") });

  const task = await createTask(baseUrl);
  const started = await api(baseUrl, `/api/tasks/${task.id}/run/start`, { method: "POST", body: {} });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await app.runService.settle();
  const startCall = providers.claude.calls.find((call) => call.method === "start");
  assert.equal(startCall.input.permissionMode, null, "null → the provider passes no --permission-mode");
  const runs = await api(baseUrl, `/api/tasks/${task.id}/runs`);
  assert.deepEqual(
    [runs.body.runs[0].claudePermissionMode, runs.body.runs[0].claudePermissionSource],
    ["acceptEdits", "project"],
  );

  // A settings read that fails never breaks the automation answer.
  detected = new Error("EACCES");
  const failed = await api(baseUrl, "/api/projects/work/automation");
  assert.equal(failed.status, 200);
  assert.deepEqual([failed.body.claudeEffectivePermissionMode, failed.body.claudePermissionSource], [null, null]);
  // The preview is read on every GET (a changed settings file shows up without restarting the board).
  detected ={ effectiveMode: "default", source: { scope: "user", path: "u", configuredMode: "manual" } };
  const user = await api(baseUrl, "/api/projects/work/automation");
  assert.deepEqual([user.body.claudeEffectivePermissionMode, user.body.claudePermissionSource.configuredMode], ["default", "manual"]);
});

test("runs endpoint returns openUrl per run, follow-ups and live activity of the latest run", async (t) => {
  const { app, baseUrl } = await startBoard(t);
  await createProject(baseUrl);
  const task = await createTask(baseUrl, { assigneeTarget: "codex-agent" });
  const started = await api(baseUrl, `/api/tasks/${task.id}/run/start`, { method: "POST", body: {} });
  const runId = started.body.run.id;
  await app.runService.handleProviderUpdate(runId, { status: "running" });
  await app.runService.handleProviderUpdate(runId, { activity: { kind: "command", text: "npm test" } });
  await app.runService.handleProviderUpdate(runId, { activity: { kind: "file", text: "out/report.md" } });

  const runs = await api(baseUrl, `/api/tasks/${task.id}/runs`);
  assert.equal(runs.status, 200);
  assert.equal(runs.body.runs.length, 1);
  assert.equal(runs.body.runs[0].openUrl, `codex://threads/thread-${runId}`);
  assert.deepEqual(runs.body.followups, []);
  assert.deepEqual(runs.body.activity.map(({ kind, text }) => ({ kind, text })), [
    { kind: "command", text: "npm test" },
    { kind: "file", text: "out/report.md" },
  ]);
  assert.equal(typeof runs.body.activity[0].at, "string");

  const empty = await createTask(baseUrl, { title: "還沒開工" });
  const none = await api(baseUrl, `/api/tasks/${empty.id}/runs`);
  assert.deepEqual(none.body, { runs: [], followups: [], activity: [] });
  const missing = await api(baseUrl, "/api/tasks/nope/runs");
  assert.equal(missing.status, 404);
});

test("moving todo → in_progress starts the run; moving back stops it first and keeps the card on stop failure", async (t) => {
  const { baseUrl, providers } = await startBoard(t);
  await createProject(baseUrl);
  const task = await createTask(baseUrl, { assigneeTarget: "codex-agent" });

  const stale = await api(baseUrl, `/api/tasks/${task.id}/move`, {
    method: "POST",
    body: { version: task.version + 5, status: "in_progress" },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "VERSION_CONFLICT");
  assert.equal(providers.codex.calls.length, 0);

  const moved = await api(baseUrl, `/api/tasks/${task.id}/move`, {
    method: "POST",
    body: { version: task.version, status: "in_progress", sortOrder: 10 },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.task.status, "in_progress");
  assert.equal(moved.body.task.activeRun.provider, "codex");
  assert.equal(providers.codex.calls.filter((call) => call.method === "start").length, 1);

  providers.codex.stopResult = { stopped: false, detail: "turn did not end" };
  const refused = await api(baseUrl, `/api/tasks/${task.id}/move`, {
    method: "POST",
    body: { version: moved.body.task.version, status: "todo" },
  });
  assert.equal(refused.status, 502);
  assert.equal(refused.body.error.code, "RUN_STOP_FAILED");
  const unchanged = await getTask(baseUrl, task.id);
  assert.equal(unchanged.status, "in_progress");
  assert.notEqual(unchanged.activeRun, null);

  providers.codex.stopResult = { stopped: true, detail: "ok" };
  const back = await api(baseUrl, `/api/tasks/${task.id}/move`, {
    method: "POST",
    body: { version: unchanged.version, status: "todo" },
  });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.task.status, "todo");
  assert.equal(back.body.task.activeRun, null);
  assert.equal(back.body.task.latestRun.status, "stopped");

  // A person's own card moves without any run.
  const mine = await createTask(baseUrl, { title: "自己做", assigneeTarget: "current-user" });
  const plain = await api(baseUrl, `/api/tasks/${mine.id}/move`, {
    method: "POST",
    body: { version: mine.version, status: "in_progress" },
  });
  assert.equal(plain.status, 200);
  assert.equal(plain.body.task.activeRun, null);
  assert.equal(providers.codex.calls.filter((call) => call.method === "start").length, 1);
});

test("PATCH status todo → in_progress on an AI card starts the run after applying the other changes", async (t) => {
  const { baseUrl, providers } = await startBoard(t);
  await createProject(baseUrl);
  const task = await createTask(baseUrl, { assigneeTarget: "current-user" });
  const patched = await api(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: task.version, status: "in_progress", assigneeTarget: "claude-agent", title: "交給 Claude" },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.task.status, "in_progress");
  assert.equal(patched.body.task.title, "交給 Claude");
  assert.equal(patched.body.task.assignee.id, "claude-agent");
  assert.equal(patched.body.run.provider, "claude");
  assert.equal(providers.claude.calls.filter((call) => call.method === "start").length, 1);
});

test("archive stops the active run and closes the AI session before archiving", async (t) => {
  const { app, baseUrl, providers } = await startBoard(t);
  await createProject(baseUrl);
  const task = await createTask(baseUrl);
  const started = await api(baseUrl, `/api/tasks/${task.id}/run/start`, { method: "POST", body: {} });
  await app.runService.handleProviderUpdate(started.body.run.id, { status: "running" });
  const current = await getTask(baseUrl, task.id);
  const archived = await api(baseUrl, `/api/tasks/${task.id}/archive`, {
    method: "POST",
    body: { version: current.version },
  });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.notEqual(archived.body.task.archivedAt, null);
  assert.equal(archived.body.task.activeRun, null);
  assert.deepEqual(providers.claude.calls.map((call) => call.method).slice(-2), ["stop", "close"]);
});

test("task SSE payloads carry activeRun/latestRun and run.updated / run.activity are pushed", async (t) => {
  const { app, baseUrl } = await startBoard(t);
  await createProject(baseUrl);
  const task = await createTask(baseUrl, { assigneeTarget: "codex-agent" });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  const waitFor = async (predicate) => {
    for (;;) {
      const found = events.find(predicate);
      if (found) return found;
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      buffer += decoder.decode(chunk.value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (data) events.push(JSON.parse(data.slice(6)));
      }
    }
  };

  const started = await api(baseUrl, `/api/tasks/${task.id}/run/start`, { method: "POST", body: {} });
  const runId = started.body.run.id;
  const moved = await waitFor((event) => event.type === "task.moved" && event.task.id === task.id);
  assert.equal(moved.task.status, "in_progress");
  assert.equal(Object.hasOwn(moved.task, "activeRun"), true);
  assert.equal(moved.task.activeRun.id, runId);
  const runUpdated = await waitFor((event) => event.type === "run.updated" && event.run.id === runId);
  assert.equal(runUpdated.taskId, task.id);
  assert.equal(runUpdated.projectId, "work");

  await app.runService.handleProviderUpdate(runId, { activity: { kind: "message", text: "處理中" } });
  const activity = await waitFor((event) => event.type === "run.activity");
  assert.equal(activity.runId, runId);
  assert.equal(activity.taskId, task.id);
  assert.equal(activity.activity.text, "處理中");
  await reader.cancel();
});

test("recoverOnStartup runs once after listen: a run left active is recovered by the next board", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-v2-recover-"));
  const first = await startBoard(t, { directory });
  await createProject(first.baseUrl);
  const task = await createTask(first.baseUrl, { assigneeTarget: "codex-agent" });
  const started = await api(first.baseUrl, `/api/tasks/${task.id}/run/start`, { method: "POST", body: {} });
  await first.app.runService.handleProviderUpdate(started.body.run.id, { status: "running" });
  await first.close();
  assert.equal(first.providers.codex.disposed, true);

  const providers = { claude: createFakeProvider("claude"), codex: createFakeProvider("codex") };
  providers.codex.recoverResult = { status: "finished", resultText: "重啟前已完成" };
  const app = createTaskboardServer({ dataDirectory: directory, runProviders: providers, enableScheduler: false, runLogger: quietLogger });
  cleanupAfter(t, directory, app);
  // Constructing the server does not recover; listen does.
  assert.equal(providers.codex.calls.length, 0);
  const address = await app.listen({ port: 0 });
  await app.whenStarted();
  assert.equal(providers.codex.calls.filter((call) => call.method === "recover").length, 1);
  const recovered = await getTask(`http://127.0.0.1:${address.port}`, task.id);
  assert.equal(recovered.status, "in_review");
  assert.equal(recovered.latestRun.resultText, "重啟前已完成");
});

test("scheduler auto-claims todo AI cards as the assignee agent and skips unavailable providers", async (t) => {
  const providers = { claude: createFakeProvider("claude"), codex: createFakeProvider("codex") };
  providers.claude.available = async () => ({ ok: false, reason: "CLAUDE_TOO_OLD" });
  const { app, baseUrl } = await startBoard(t, { providers });
  await createProject(baseUrl);
  const codexTask = await createTask(baseUrl, { title: "Codex 卡", assigneeTarget: "codex-agent" });
  const claudeTask = await createTask(baseUrl, { title: "Claude 卡", assigneeTarget: "claude-agent" });
  await api(baseUrl, "/api/projects/work/automation", { method: "PUT", body: { enabled: true, maxParallel: 3 } });

  const result = await app.scheduler.tick();
  assert.deepEqual(result.started, [codexTask.id]);
  const claimed = await getTask(baseUrl, codexTask.id);
  assert.equal(claimed.status, "in_progress");
  const moveActivity = (await api(baseUrl, `/api/tasks/${codexTask.id}/activities`)).body;
  assert.match(JSON.stringify(moveActivity), /codex-agent/);
  assert.equal((await getTask(baseUrl, claudeTask.id)).status, "todo");
  assert.equal(providers.claude.calls.length, 0);
});

test("GET /api/providers reports provider availability", async (t) => {
  const providers = { claude: createUnavailableRunProvider("claude", "CLAUDE_PROVIDER_MISSING"), codex: createFakeProvider("codex") };
  const { baseUrl } = await startBoard(t, { providers });
  const result = await api(baseUrl, "/api/providers");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.providers, {
    claude: { ok: false, reason: "CLAUDE_PROVIDER_MISSING" },
    codex: { ok: true, version: "codex-test" },
  });
});

test("default wiring: missing Claude module gives an unavailable provider; Codex uses its own version probe", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-v2-defaults-"));
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  await writeFile(fakeCodex, "if (process.argv[2] === '--version') { console.log('codex-cli 9.9.9-test'); } else { process.exit(3); }\n");
  const app = createTaskboardServer({
    dataDirectory: path.join(directory, "data"),
    codexExecutable: fakeCodex,
    enableScheduler: false,
    runLogger: quietLogger,
    loadClaudeProviderModule: async () => {
      throw Object.assign(new Error("Cannot find module claude-bg.mjs"), { code: "ERR_MODULE_NOT_FOUND" });
    },
  });
  cleanupAfter(t, directory, app);
  const address = await app.listen({ port: 0 });
  await app.whenStarted();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const providers = await api(baseUrl, "/api/providers");
  assert.equal(providers.body.providers.claude.ok, false);
  assert.equal(providers.body.providers.claude.reason, "CLAUDE_PROVIDER_MISSING");
  assert.deepEqual(providers.body.providers.codex, { ok: true, version: "codex-cli 9.9.9-test" });
  await assert.rejects(
    app.runProviders.claude.start({ runId: "r", cwd: "/w", prompt: "p", title: "t" }),
    (error) => error.status === 409 && error.code === "PROVIDER_UNAVAILABLE",
  );

  // A start on an unavailable provider fails closed: failed run, comment, blocked card.
  await createProject(baseUrl);
  const task = await createTask(baseUrl);
  const started = await api(baseUrl, `/api/tasks/${task.id}/run/start`, { method: "POST", body: {} });
  assert.equal(started.status, 202);
  await app.runService.settle();
  assert.equal((await getTask(baseUrl, task.id)).status, "blocked");
  assert.match((await comments(baseUrl, task.id)).at(-1).body, /PROVIDER_UNAVAILABLE|CLAUDE_PROVIDER_MISSING/);
});

test("default wiring passes promptDir and the ConPTY helper path to the Claude provider", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-v2-claude-options-"));
  const seen = [];
  const app = createTaskboardServer({
    dataDirectory: directory,
    enableScheduler: false,
    runLogger: quietLogger,
    processEnv: { ...process.env, RELAY_CONPTY_HELPER: path.join(directory, "helper.exe") },
    loadClaudeProviderModule: async () => ({
      createClaudeBgProvider(options) {
        seen.push(options);
        return { ...createFakeProvider("claude"), available: async () => ({ ok: true, version: "2.1.271" }) };
      },
    }),
  });
  cleanupAfter(t, directory, app);
  assert.deepEqual(await app.runProviders.claude.available(), { ok: true, version: "2.1.271" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].promptDir, path.join(directory, "claude-prompts"));
  assert.equal(seen[0].conptyHelperPath, path.join(directory, "helper.exe"));
  assert.equal(typeof seen[0].onUpdate, "function");
  assert.ok((await stat(path.join(directory, "claude-prompts"))).isDirectory());
});

test("review fix: a person moving a running card to done or in_review stops the run first", async (t) => {
  const { baseUrl, providers } = await startBoard(t);
  await createProject(baseUrl);
  const task = await createTask(baseUrl, { assigneeTarget: "codex-agent" });
  const started = await api(baseUrl, `/api/tasks/${task.id}/run/start`, { method: "POST" });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.notEqual(started.body.task.activeRun, null);

  const done = await api(baseUrl, `/api/tasks/${task.id}/move`, {
    method: "POST",
    body: { version: started.body.task.version, status: "done" },
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.task.status, "done");
  assert.equal(done.body.task.activeRun, null);
  assert.equal(done.body.task.latestRun.status, "stopped");
  assert.equal(providers.codex.calls.filter((call) => call.method === "stop").length, 1);

  const second = await createTask(baseUrl, { assigneeTarget: "codex-agent", title: "第二張" });
  const secondStarted = await api(baseUrl, `/api/tasks/${second.id}/run/start`, { method: "POST" });
  assert.equal(secondStarted.status, 202, JSON.stringify(secondStarted.body));
  const patched = await api(baseUrl, `/api/tasks/${second.id}`, {
    method: "PATCH",
    body: { version: secondStarted.body.task.version, status: "in_review" },
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.task.status, "in_review");
  assert.equal(patched.body.task.activeRun, null);
  assert.equal(providers.codex.calls.filter((call) => call.method === "stop").length, 2);
});

test("W3: a person moving/patching a running card to blocked/done stops first; a failed stop leaves the card and run untouched", async (t) => {
  const { baseUrl, providers } = await startBoard(t);
  await createProject(baseUrl);
  const stopCalls = () => providers.claude.calls.filter((call) => call.method === "stop").length;

  const blockedTask = await createTask(baseUrl, { title: "移到卡住" });
  const started = await api(baseUrl, `/api/tasks/${blockedTask.id}/run/start`, { method: "POST" });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const blocked = await api(baseUrl, `/api/tasks/${blockedTask.id}/move`, {
    method: "POST",
    body: { version: started.body.task.version, status: "blocked" },
  });
  assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
  assert.equal(blocked.body.task.status, "blocked");
  assert.equal(blocked.body.task.activeRun, null);
  assert.equal(blocked.body.task.latestRun.status, "stopped");
  assert.equal(stopCalls(), 1);

  const doneTask = await createTask(baseUrl, { title: "停不下來" });
  const running = await api(baseUrl, `/api/tasks/${doneTask.id}/run/start`, { method: "POST" });
  assert.equal(running.status, 202, JSON.stringify(running.body));
  providers.claude.stopResult = { stopped: false, detail: "still busy" };
  for (const [method, pathname, body] of [
    ["PATCH", `/api/tasks/${doneTask.id}`, { version: running.body.task.version, status: "done" }],
    ["POST", `/api/tasks/${doneTask.id}/move`, { version: running.body.task.version, status: "in_review" }],
    ["POST", `/api/tasks/${doneTask.id}/move`, { version: running.body.task.version, status: "blocked" }],
  ]) {
    const refused = await api(baseUrl, pathname, { method, body });
    assert.equal(refused.status, 502, `${method} ${body.status}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.error.code, "RUN_STOP_FAILED");
    const after = await getTask(baseUrl, doneTask.id);
    assert.equal(after.status, "in_progress");
    assert.notEqual(after.activeRun, null);
    assert.notEqual(after.activeRun.status, "stopped");
  }
  assert.equal(stopCalls(), 4);

  providers.claude.stopResult = { stopped: true, detail: "ok" };
  const current = await getTask(baseUrl, doneTask.id);
  const done = await api(baseUrl, `/api/tasks/${doneTask.id}`, { method: "PATCH", body: { version: current.version, status: "done" } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.task.status, "done");
  assert.equal(done.body.task.latestRun.status, "stopped");
});

test("review fix: PATCH todo -> in_progress with a missing provider writes nothing", async (t) => {
  const { baseUrl } = await startBoard(t, { providers: { claude: createFakeProvider("claude") } });
  await createProject(baseUrl);
  const task = await createTask(baseUrl, { assigneeTarget: "codex-agent" });
  const patched = await api(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: task.version, title: "改過的標題", status: "in_progress" },
  });
  assert.equal(patched.status, 503, JSON.stringify(patched.body));
  assert.equal(patched.body.error.code, "PROVIDER_UNAVAILABLE");
  const after = await getTask(baseUrl, task.id);
  assert.equal(after.title, task.title);
  assert.equal(after.status, "todo");
  assert.equal(after.version, task.version);
});

test("pure helpers: run transitions, ConPTY helper resolution, startup error text", () => {
  const todoAgent = { status: "todo", archivedAt: null, assignee: { type: "agent", id: "claude-agent" } };
  assert.equal(runTransitionForStatusChange({ task: todoAgent, status: "in_progress" }), "start");
  assert.equal(runTransitionForStatusChange({ task: { ...todoAgent, assignee: { type: "user", id: "u" } }, status: "in_progress" }), null);
  assert.equal(runTransitionForStatusChange({ task: { ...todoAgent, archivedAt: "x" }, status: "in_progress" }), null);
  const running = { status: "in_progress", archivedAt: null, assignee: todoAgent.assignee };
  for (const destination of ["backlog", "todo", "canceled"]) {
    assert.equal(runTransitionForStatusChange({ task: running, status: destination, activeRun: { id: "r" } }), "stop");
  }
  // Review fix: a person moving a running card anywhere out of in_progress stops the run; the agent itself does not.
  for (const destination of ["in_review", "done", "blocked"]) {
    assert.equal(runTransitionForStatusChange({ task: running, status: destination, activeRun: { id: "r" } }), "stop");
    assert.equal(
      runTransitionForStatusChange({ task: running, status: destination, activeRun: { id: "r" }, actor: { type: "agent", id: "codex-agent" } }),
      null,
    );
  }
  assert.equal(runTransitionForStatusChange({ task: running, status: "todo", activeRun: null }), null);

  const root = path.join(os.tmpdir(), "app");
  assert.equal(resolveConptyHelperPath({ env: { RELAY_CONPTY_HELPER: "C:/x/h.exe" }, projectRoot: root, exists: () => false }), path.resolve("C:/x/h.exe"));
  assert.equal(
    resolveConptyHelperPath({ env: {}, projectRoot: root, exists: () => false }),
    path.join(root, "src-tauri", "resources", "bin", "ConPtyAttachSend.exe"),
  );
  const packaged = path.join(root, "..", "bin", "ConPtyAttachSend.exe");
  assert.equal(resolveConptyHelperPath({ env: {}, projectRoot: root, exists: (file) => file === packaged }), packaged);
  // Amendment 3 order: env → packaged resource → dev build output (packaged wins when both exist).
  assert.equal(resolveConptyHelperPath({ env: {}, projectRoot: root, exists: () => true }), packaged);
  assert.equal(
    resolveConptyHelperPath({ env: { RELAY_CONPTY_HELPER: "C:/x/h.exe" }, projectRoot: root, exists: () => true }),
    path.resolve("C:/x/h.exe"),
  );

  const text = describeStartupError({
    code: "DB_MIGRATION_FAILED",
    message: "Database upgrade failed; backup: C:/data/backups/taskboard-1.sqlite",
    details: { backupPath: "C:/data/backups/taskboard-1.sqlite", restored: true, stage: "migrate" },
  });
  assert.match(text, /DB_MIGRATION_FAILED/);
  assert.match(text, /C:\/data\/backups\/taskboard-1\.sqlite/);
  assert.equal(describeStartupError(new Error("other")), null);
});

test("W3 bug 2: provider children get CODEX_TASKBOARD_URL for this board, including the instance-token prefix", async (t) => {
  assert.deepEqual(boardRunEnvironment({ port: null }), {});
  assert.deepEqual(boardRunEnvironment({ port: 4321 }), { CODEX_TASKBOARD_URL: "http://127.0.0.1:4321" });
  assert.deepEqual(boardRunEnvironment({ port: 4321, routePrefix: "/abc" }), { CODEX_TASKBOARD_URL: "http://127.0.0.1:4321/abc" });

  const appServer = new CodexAppServer({
    executable: "codex",
    processEnv: { KEEP: "1", CODEX_TASKBOARD_URL: "http://127.0.0.1:47833", CODEX_TASKBOARD_INSTANCE_TOKEN: "x" },
    extraEnv: () => ({ CODEX_TASKBOARD_URL: "http://127.0.0.1:5555/tok" }),
  });
  assert.deepEqual(appServer.childEnvironment(), { KEEP: "1", CODEX_TASKBOARD_URL: "http://127.0.0.1:5555/tok" });

  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-v2-board-env-"));
  const token = "relay-board-token-0001";
  const seen = [];
  const app = createTaskboardServer({
    dataDirectory: directory,
    enableScheduler: false,
    runLogger: quietLogger,
    instanceToken: token,
    instanceSecret: "0123456789abcdef0123456789abcdef",
    loadClaudeProviderModule: async () => ({
      createClaudeBgProvider(options) {
        seen.push(options);
        return createFakeProvider("claude");
      },
    }),
  });
  cleanupAfter(t, directory, app);
  assert.deepEqual(app.runChildEnvironment(), {});
  const address = await app.listen({ port: 0 });
  await app.whenStarted();
  const expected = { CODEX_TASKBOARD_URL: `http://127.0.0.1:${address.port}/${token}` };
  assert.deepEqual(app.runChildEnvironment(), expected);
  await app.runProviders.claude.available();
  assert.deepEqual(seen[0].extraEnv(), expected);
  // Import fix F3: the AI chat app-server gets the same board URL (with the token prefix).
  assert.equal(app.aiChat.appServer.childEnvironment().CODEX_TASKBOARD_URL, expected.CODEX_TASKBOARD_URL);
});

test("W3 bug 3: run/start, continue and steer answer before slow providers finish", async (t) => {
  const gates = [];
  const gate = () => new Promise((resolve) => gates.push(resolve));
  const claude = createFakeProvider("claude");
  const baseStart = claude.start;
  claude.start = async (input) => {
    await gate();
    return baseStart(input);
  };
  claude.sendFollowup = async (input) => {
    claude.calls.push({ method: "sendFollowup", input });
    await gate();
    return { delivered: true, detail: "slow ok" };
  };
  const { app, baseUrl } = await startBoard(t, { providers: { claude, codex: createFakeProvider("codex") } });
  await createProject(baseUrl);
  const task = await createTask(baseUrl);

  const timed = async (pathname, body) => {
    const began = Date.now();
    const result = await api(baseUrl, pathname, { method: "POST", body });
    return { ...result, ms: Date.now() - began };
  };
  const started = await timed(`/api/tasks/${task.id}/run/start`, {});
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.ok(started.ms < 1000, `start took ${started.ms} ms`);
  assert.equal(started.body.run.status, "starting");
  assert.equal(gates.length, 1, "provider.start is still waiting");

  const runId = started.body.run.id;
  await app.runService.handleProviderUpdate(runId, { status: "running" });
  const steer = await timed(`/api/tasks/${task.id}/run/followup`, { body: "改用 B", mode: "steer" });
  assert.equal(steer.status, 202);
  assert.ok(steer.ms < 1000, `steer took ${steer.ms} ms`);
  assert.equal(steer.body.followup.status, "pending");

  for (const release of gates.splice(0)) release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const release of gates.splice(0)) release();
  await app.runService.settle();
  assert.equal((await api(baseUrl, `/api/tasks/${task.id}/runs`)).body.followups[0].status, "sent");

  await app.runService.handleProviderUpdate(runId, { status: "finished", resultText: "done" });
  const continued = await timed(`/api/tasks/${task.id}/continue`, { body: "再做一次" });
  assert.equal(continued.status, 202, JSON.stringify(continued.body));
  assert.ok(continued.ms < 1000, `continue took ${continued.ms} ms`);
  assert.equal(continued.body.run.status, "starting");
  assert.equal(continued.body.task.status, "in_progress");
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const release of gates.splice(0)) release();
  await app.runService.settle();
});

test("W3 bug 1: an undelivered steer is queued over HTTP and sent after the turn", async (t) => {
  const { app, baseUrl, providers } = await startBoard(t);
  await createProject(baseUrl);
  const task = await createTask(baseUrl);
  const started = await api(baseUrl, `/api/tasks/${task.id}/run/start`, { method: "POST", body: {} });
  await app.runService.settle();
  const runId = started.body.run.id;
  await app.runService.handleProviderUpdate(runId, { status: "running" });
  providers.claude.followupResult = { delivered: false, detail: "NOT_CONFIRMED_IN_TRANSCRIPT" };
  const steered = await api(baseUrl, `/api/tasks/${task.id}/run/followup`, { method: "POST", body: { body: "只做到 3", mode: "steer" } });
  assert.equal(steered.status, 202);
  await app.runService.settle();
  let followup = (await api(baseUrl, `/api/tasks/${task.id}/runs`)).body.followups[0];
  assert.deepEqual([followup.mode, followup.status, followup.error], ["queue", "pending", "STEER_NOT_DELIVERED_QUEUED"]);

  providers.claude.followupResult = { delivered: true, detail: "ok" };
  await app.runService.handleProviderUpdate(runId, { status: "finished", resultText: "第一輪結果" });
  followup = (await api(baseUrl, `/api/tasks/${task.id}/runs`)).body.followups[0];
  assert.equal(followup.status, "sent");
  assert.equal((await getTask(baseUrl, task.id)).status, "in_progress");
  assert.ok((await comments(baseUrl, task.id)).some((comment) => comment.body === "第一輪結果" && comment.authorId === "claude-agent"));
});

test("W3 bug 4: run/start and continue answer 409 WORKSPACE_NOT_FOUND when the project folder is missing", async (t) => {
  const { baseUrl, providers } = await startBoard(t);
  const missingPath = path.join(os.tmpdir(), `relay-missing-${Date.now()}`, "ROOT");
  // W15: creating a project requires an existing folder; the folder disappears afterwards.
  await mkdir(missingPath, { recursive: true });
  const created = await api(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "gone", name: "gone", workspacePath: missingPath },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await rm(path.dirname(missingPath), { recursive: true, force: true });
  const task = await createTask(baseUrl, { projectId: "gone" });
  const started = await api(baseUrl, `/api/tasks/${task.id}/run/start`, { method: "POST", body: {} });
  assert.equal(started.status, 409, JSON.stringify(started.body));
  assert.equal(started.body.error.code, "WORKSPACE_NOT_FOUND");
  assert.equal(started.body.error.message, `專案資料夾不存在：${missingPath}`);
  const after = await getTask(baseUrl, task.id);
  assert.equal(after.status, "todo");
  assert.equal(after.latestRun, null);
  assert.equal(providers.claude.calls.filter((call) => call.method === "start").length, 0);

  const moved = await api(baseUrl, `/api/tasks/${task.id}/move`, { method: "POST", body: { version: after.version, status: "in_progress" } });
  assert.equal(moved.status, 409);
  assert.equal(moved.body.error.code, "WORKSPACE_NOT_FOUND");
  assert.equal((await getTask(baseUrl, task.id)).status, "todo");

  const patched = await api(baseUrl, `/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: after.version, status: "in_progress", title: "renamed" },
  });
  assert.equal(patched.status, 409, JSON.stringify(patched.body));
  assert.equal(patched.body.error.code, "WORKSPACE_NOT_FOUND");
  const unchanged = await getTask(baseUrl, task.id);
  assert.equal(unchanged.version, after.version);
  assert.equal(unchanged.status, "todo");
});

test("close waits for in-flight run work at most 4 s in total (second wait gets only the remaining budget)", async (t) => {
  let clock = 1_000_000;
  const delays = [];
  const closeClock = {
    now: () => clock,
    // Fake timer: records the bound, advances the clock past it (with some overshoot) and fires soon.
    setTimeout: (callback, ms) => {
      delays.push(ms);
      clock += ms + 200;
      return setImmediate(callback);
    },
    clearTimeout: (handle) => clearImmediate(handle),
  };
  const claude = createFakeProvider("claude");
  let disposeCalls = 0;
  claude.start = (input) => {
    claude.calls.push({ method: "start", input });
    return new Promise(() => {}); // never settles, not even after dispose
  };
  claude.dispose = async () => { disposeCalls += 1; };
  const { baseUrl, close } = await startBoard(t, {
    providers: { claude, codex: createFakeProvider("codex") },
    closeClock,
  });
  await createProject(baseUrl);
  const task = await createTask(baseUrl);
  const started = await api(baseUrl, `/api/tasks/${task.id}/run/start`, { method: "POST", body: {} });
  assert.equal(started.status, 202, JSON.stringify(started.body));

  const closing = close();
  const outcome = await Promise.race([
    closing.then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 5_000).unref()),
  ]);
  assert.equal(outcome, "closed");
  assert.equal(disposeCalls, 1);
  assert.deepEqual(delays, [3_000, 800], "first wait ≤ 3 s, second wait = budget left after the first");
  assert.ok(delays.reduce((sum, ms) => sum + ms, 0) <= 4_000);
});
