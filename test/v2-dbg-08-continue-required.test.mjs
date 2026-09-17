// DBG-08 regression (BLUEPRINT §4.2): an AI card with a previous run in in_review / blocked cannot
// be moved or patched to in_progress without a continue message. Move / PATCH (desktop drag, context
// menu, detail status picker, mobile long-press, Ctrl+Z undo) answer 409 CONTINUE_MESSAGE_REQUIRED
// before anything is written; POST /api/tasks/:id/continue stays the way back to in_progress.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { assertNoSilentContinue, createTaskboardServer } from "../server/app.mjs";

const quiet = { info() {}, warn() {}, error() {} };

function fakeProvider(name) {
  const provider = {
    name,
    calls: [],
    startError: null,
    async available() { return { ok: true, version: `${name}-test` }; },
    async start(input) {
      provider.calls.push({ method: "start", input });
      if (provider.startError) throw provider.startError;
      return { claudeShortId: "short-1", claudeSessionId: "session-1", claudeBridgeSessionId: "bridge-1" };
    },
    async sendFollowup(input) { provider.calls.push({ method: "sendFollowup", input }); return { delivered: true, detail: "ok" }; },
    async stop(input) { provider.calls.push({ method: "stop", input }); return { stopped: true }; },
    async close(input) { provider.calls.push({ method: "close", input }); },
    openUrl() { return null; },
    async recover() { return { status: "interrupted" }; },
    async dispose() {},
  };
  return provider;
}

async function startBoard(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-dbg08-"));
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
  const workspacePath = path.join(directory, "workspace");
  await mkdir(workspacePath, { recursive: true });
  assert.equal((await api("/api/projects", { method: "POST", body: { id: "work", name: "work", workspacePath } })).status, 201);
  const createTask = async (title, assigneeTarget = "claude-agent") => {
    const created = await api("/api/tasks", {
      method: "POST",
      body: { projectId: "work", title, status: "todo", assigneeTarget },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.task;
  };
  const getTask = async (id) => (await api(`/api/tasks/${id}`)).body.task;
  const providerCalls = () => providers.claude.calls.length + providers.codex.calls.length;
  return { app, api, providers, createTask, getTask, providerCalls };
}

async function inReviewCard(board, title) {
  const task = await board.createTask(title);
  const started = await board.api(`/api/tasks/${task.id}/run/start`, { method: "POST", body: {} });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await board.app.runService.settle();
  await board.app.runService.handleProviderUpdate(started.body.run.id, { status: "running" });
  await board.app.runService.handleProviderUpdate(started.body.run.id, { status: "finished", resultText: "done" });
  const current = await board.getTask(task.id);
  assert.equal(current.status, "in_review");
  assert.equal(current.activeRun, null);
  return current;
}

async function assertUnchanged(board, before) {
  await board.app.runService.settle();
  const after = await board.getTask(before.id);
  assert.equal(after.status, before.status);
  assert.equal(after.version, before.version);
  assert.equal(after.title, before.title);
  assert.equal(after.activeRun, null);
  assert.equal(after.latestRun?.id, before.latestRun?.id);
}

test("DBG-08: move in_review -> in_progress of an AI card with a previous run is 409 before any write", async (t) => {
  const board = await startBoard(t);
  const card = await inReviewCard(board, "A in_review");
  const callsBefore = board.providerCalls();
  const moved = await board.api(`/api/tasks/${card.id}/move`, { method: "POST", body: { version: card.version, status: "in_progress" } });
  assert.equal(moved.status, 409, JSON.stringify(moved.body));
  assert.equal(moved.body.error.code, "CONTINUE_MESSAGE_REQUIRED");
  await assertUnchanged(board, card);
  assert.equal(board.providerCalls(), callsBefore);

  // The continue endpoint is the way back to in_progress and continues the same session.
  const continued = await board.api(`/api/tasks/${card.id}/continue`, { method: "POST", body: { body: "請繼續" } });
  assert.equal(continued.status, 202, JSON.stringify(continued.body));
  assert.equal(continued.body.task.status, "in_progress");
  await board.app.runService.settle();
  assert.equal(board.providers.claude.calls.filter((call) => call.method === "sendFollowup").length, 1);
});

test("DBG-08: PATCH blocked -> in_progress (status picker) is 409 and other PATCH fields are not written", async (t) => {
  const board = await startBoard(t);
  const task = await board.createTask("B blocked");
  const started = await board.api(`/api/tasks/${task.id}/run/start`, { method: "POST", body: {} });
  await board.app.runService.settle();
  // The session started (refs saved), then the run failed → blocked with a session to continue.
  await board.app.runService.handleProviderUpdate(started.body.run.id, { status: "failed", error: "fake failure" });
  const blocked = await board.getTask(task.id);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.latestRun.claudeShortId, "short-1");
  const callsBefore = board.providerCalls();

  const patched = await board.api(`/api/tasks/${task.id}`, {
    method: "PATCH",
    body: { version: blocked.version, status: "in_progress", title: "改過的標題" },
  });
  assert.equal(patched.status, 409, JSON.stringify(patched.body));
  assert.equal(patched.body.error.code, "CONTINUE_MESSAGE_REQUIRED");
  await assertUnchanged(board, blocked);
  assert.equal(board.providerCalls(), callsBefore);

  // Other status changes and plain edits of the blocked card keep working.
  const renamed = await board.api(`/api/tasks/${task.id}`, { method: "PATCH", body: { version: blocked.version, title: "只改標題" } });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  const toReview = await board.api(`/api/tasks/${task.id}/move`, { method: "POST", body: { version: renamed.body.task.version, status: "in_review" } });
  assert.equal(toReview.status, 200, JSON.stringify(toReview.body));
});

test("DBG-08 follow-up: a blocked card whose launch never reached a session is 409 REWORK_REQUIRED (move, PATCH, continue); rework works", async (t) => {
  const board = await startBoard(t);
  board.providers.claude.startError = new Error("fake launch failure");
  const task = await board.createTask("L launch failed");
  await board.api(`/api/tasks/${task.id}/run/start`, { method: "POST", body: {} });
  await board.app.runService.settle();
  board.providers.claude.startError = null;
  const blocked = await board.getTask(task.id);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.latestRun.claudeShortId, null);
  assert.equal(blocked.latestRun.claudeSessionId, null);
  const callsBefore = board.providerCalls();

  const moved = await board.api(`/api/tasks/${task.id}/move`, { method: "POST", body: { version: blocked.version, status: "in_progress" } });
  assert.equal(moved.status, 409, JSON.stringify(moved.body));
  assert.equal(moved.body.error.code, "REWORK_REQUIRED");
  assert.equal(moved.body.error.message, "上一次沒有成功開工，請改用「退回重做」");
  const patched = await board.api(`/api/tasks/${task.id}`, { method: "PATCH", body: { version: blocked.version, status: "in_progress", title: "x" } });
  assert.equal(patched.status, 409, JSON.stringify(patched.body));
  assert.equal(patched.body.error.code, "REWORK_REQUIRED");
  const continued = await board.api(`/api/tasks/${task.id}/continue`, { method: "POST", body: { body: "請繼續" } });
  assert.equal(continued.status, 409, JSON.stringify(continued.body));
  assert.equal(continued.body.error.code, "REWORK_REQUIRED");
  await assertUnchanged(board, blocked);
  assert.equal(board.providerCalls(), callsBefore);

  const reworked = await board.api(`/api/tasks/${task.id}/rework`, { method: "POST", body: { body: "重新開工" } });
  assert.equal(reworked.status, 200, JSON.stringify(reworked.body));
  assert.equal(reworked.body.task.status, "todo");
});

test("DBG-08: undo after dragging a running card to in_review cannot recreate a fake in_progress", async (t) => {
  const board = await startBoard(t);
  const task = await board.createTask("U undo");
  const started = await board.api(`/api/tasks/${task.id}/run/start`, { method: "POST", body: {} });
  await board.app.runService.settle();
  await board.app.runService.handleProviderUpdate(started.body.run.id, { status: "running" });
  const running = await board.getTask(task.id);
  const toReview = await board.api(`/api/tasks/${task.id}/move`, { method: "POST", body: { version: running.version, status: "in_review" } });
  assert.equal(toReview.status, 200, JSON.stringify(toReview.body));
  assert.equal(toReview.body.task.status, "in_review");
  const reviewed = await board.getTask(task.id);

  const undo = await board.api(`/api/tasks/${task.id}/move`, { method: "POST", body: { version: reviewed.version, status: "in_progress" } });
  assert.equal(undo.status, 409, JSON.stringify(undo.body));
  assert.equal(undo.body.error.code, "CONTINUE_MESSAGE_REQUIRED");
  await assertUnchanged(board, reviewed);
});

test("DBG-08: controls — todo -> in_progress still starts; cards without an AI run or with a person assignee move normally", async (t) => {
  const board = await startBoard(t);
  const todo = await board.createTask("C todo");
  const moved = await board.api(`/api/tasks/${todo.id}/move`, { method: "POST", body: { version: todo.version, status: "in_progress" } });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.run.status, "starting");

  // An AI card that never ran: in_review -> in_progress is a plain move.
  const neverRan = await board.createTask("never ran");
  const toReview = await board.api(`/api/tasks/${neverRan.id}/move`, { method: "POST", body: { version: neverRan.version, status: "in_review" } });
  assert.equal(toReview.status, 200);
  const back = await board.api(`/api/tasks/${neverRan.id}/move`, { method: "POST", body: { version: toReview.body.task.version, status: "in_progress" } });
  assert.equal(back.status, 200, JSON.stringify(back.body));

  // A person's card: plain move.
  const created = await board.api("/api/tasks", { method: "POST", body: { projectId: "work", title: "person", status: "blocked" } });
  assert.equal(created.status, 201);
  const personMove = await board.api(`/api/tasks/${created.body.task.id}/move`, { method: "POST", body: { version: created.body.task.version, status: "in_progress" } });
  assert.equal(personMove.status, 200, JSON.stringify(personMove.body));
});

test("DBG-08 helper: only in_review/blocked -> in_progress of a card with a previous run, no active run, AI assignee", () => {
  const agent = { type: "agent", id: "claude-agent" };
  const person = { type: "user", id: "local-user" };
  const latestRun = { id: "r1", status: "finished", claudeShortId: "short-1", claudeSessionId: null, codexThreadId: null };
  const refusedWith = (input) => {
    try {
      assertNoSilentContinue(input);
      return null;
    } catch (error) {
      assert.equal(error.status, 409);
      return error.code;
    }
  };
  const refused = (input) => {
    const code = refusedWith(input);
    if (code !== null) assert.equal(code, "CONTINUE_MESSAGE_REQUIRED");
    return code !== null;
  };
  for (const status of ["in_review", "blocked"]) {
    const task = { status, archivedAt: null, assignee: agent };
    assert.equal(refused({ task, status: "in_progress", latestRun }), true);
    assert.equal(refused({ task, status: "in_progress", latestRun: null }), false);
    assert.equal(refused({ task, status: "in_progress", latestRun, activeRun: { id: "r2" } }), false);
    assert.equal(refused({ task, status: "done", latestRun }), false);
    assert.equal(refused({ task: { ...task, archivedAt: "x" }, status: "in_progress", latestRun }), false);
    assert.equal(refused({ task: { ...task, assignee: person }, status: "in_progress", latestRun }), false);
    assert.equal(refused({ task: { ...task, assignee: person }, assignees: [person, agent], status: "in_progress", latestRun }), true);
  }
  assert.equal(refused({ task: { status: "todo", archivedAt: null, assignee: agent }, status: "in_progress", latestRun }), false);
  // No session refs on the latest run → REWORK_REQUIRED; any single ref is enough to continue.
  const noRefs = { id: "r0", status: "failed", claudeShortId: null, claudeSessionId: null, codexThreadId: null };
  const blockedTask = { status: "blocked", archivedAt: null, assignee: agent };
  assert.equal(refusedWith({ task: blockedTask, status: "in_progress", latestRun: noRefs }), "REWORK_REQUIRED");
  assert.equal(refusedWith({ task: blockedTask, status: "in_progress", latestRun: { ...noRefs, claudeSessionId: "s" } }), "CONTINUE_MESSAGE_REQUIRED");
  assert.equal(refusedWith({ task: blockedTask, status: "in_progress", latestRun: { ...noRefs, codexThreadId: "t" } }), "CONTINUE_MESSAGE_REQUIRED");
  assert.equal(refusedWith({ task: blockedTask, status: "in_progress", latestRun: noRefs, activeRun: { id: "r2" } }), null);
  assert.equal(refusedWith({ task: { ...blockedTask, assignee: person }, status: "in_progress", latestRun: noRefs }), null);
});
