// DBG-01 regression: an unpaired private-LAN client (source mode, 0.0.0.0 listener) keeps ordinary
// task CRUD, but any write that queues a card for auto-claim or changes a queued card needs the same
// run-control authorization as a direct start (loopback or paired phone). Requests go through the
// real handleHttpRequest with forged LAN sockets; the scheduler is enabled with a recording provider.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { createTaskboardServer, isAutoClaimEligibleTask, isTailnetAddress } from "../server/app.mjs";

const LAN_ADDRESS = "192.168.50.20";
const TAILNET_PEER = "100.70.1.2";
const quiet = { info() {}, warn() {}, error() {}, log() {} };

function recordingProvider(name, starts) {
  return {
    name,
    async available() { return { ok: true }; },
    async start(input) {
      starts.push({ provider: name, prompt: input.prompt, title: input.title });
      return name === "codex"
        ? { codexThreadId: `thread-${input.runId}`, codexTurnId: "turn-1" }
        : { claudeShortId: "short-1", claudeSessionId: "session-1", claudeBridgeSessionId: "bridge-1" };
    },
    async sendFollowup() { return { delivered: true, detail: "" }; },
    async stop() { return { stopped: true, detail: "" }; },
    async close() {},
    openUrl() { return null; },
    async recover() { return { status: "interrupted" }; },
    async dispose() {},
  };
}

async function startBoard(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-dbg01-"));
  const staticDirectory = path.join(directory, "web");
  await mkdir(staticDirectory, { recursive: true });
  await writeFile(path.join(staticDirectory, "index.html"), "<!doctype html><title>Taskboard</title>");
  const workspacePath = path.join(directory, "workspace");
  const otherWorkspacePath = path.join(directory, "other");
  await mkdir(workspacePath, { recursive: true });
  await mkdir(otherWorkspacePath, { recursive: true });
  const starts = [];
  const app = createTaskboardServer({
    dataDirectory: path.join(directory, "data"),
    staticDirectory,
    runProviders: { claude: recordingProvider("claude", starts), codex: recordingProvider("codex", starts) },
    runLogger: quiet,
    mobileAccessOptions: {
      execFile: (file, args, options, callback) => callback(null, "100.64.0.9\n", ""),
      logger: quiet,
    },
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  await app.whenStarted();
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const port = address.port;

  const local = async (pathname, { method = "GET", body, raw, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
  };
  // Forged non-loopback socket through the real request handler (as in v2-integration-mobile).
  const lan = async (pathname, { method = "GET", body, raw, headers = {}, remoteAddress = LAN_ADDRESS } = {}) => {
    const payload = raw !== undefined ? [Buffer.from(raw)] : body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const request = Readable.from(payload);
    request.method = method;
    request.url = pathname;
    request.socket = { remoteAddress };
    request.headers = {
      host: `192.168.50.5:${port}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    };
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const response = {
      statusCode: null,
      body: "",
      headersSent: false,
      writableEnded: false,
      setHeader() {},
      writeHead(status) { this.statusCode = status; this.headersSent = true; return this; },
      write(chunk) { this.body += chunk; return true; },
      end(chunk) { if (chunk) this.body += chunk; this.writableEnded = true; finish(); },
      destroy() { finish(); },
    };
    app.server.emit("request", request, response);
    await done;
    let parsed;
    try { parsed = response.body ? JSON.parse(response.body) : undefined; } catch { parsed = undefined; }
    return { status: response.statusCode, body: parsed, text: response.body };
  };

  for (const [id, folder] of [["work", workspacePath], ["other", otherWorkspacePath]]) {
    const project = await local("/api/projects", { method: "POST", body: { id, name: id, workspacePath: folder } });
    assert.equal(project.status, 201, project.text);
  }
  const createTask = async (fields) => {
    const created = await local("/api/tasks", { method: "POST", body: { projectId: "work", ...fields } });
    assert.equal(created.status, 201, created.text);
    return created.body.task;
  };
  const getTask = async (id) => (await local(`/api/tasks/${id}`)).body.task;
  const block = async (blocker, blocked) => {
    const current = await getTask(blocker.id);
    const result = await local(`/api/tasks/${blocker.id}/relations/blocks/${blocked.id}`, {
      method: "POST",
      body: { version: current.version },
    });
    assert.equal(result.status, 200, result.text);
  };
  const upload = (via, route, filename) => via(route, {
    method: "POST",
    raw: "file-content",
    headers: {
      "content-type": "text/plain",
      "x-taskboard-filename": encodeURIComponent(filename),
      "x-taskboard-attachment-kind": "attachment",
    },
  });
  const tick = async () => {
    const result = await app.scheduler.tick();
    await app.runService.settle();
    return result;
  };
  return { app, local, lan, createTask, getTask, block, upload, tick, starts };
}

function assertDenied(result, label) {
  assert.equal(result.status, 403, `${label}: ${result.text}`);
  assert.equal(result.body.error.code, "AUTO_CLAIM_WRITE_REQUIRES_LOCAL", label);
  assert.equal(result.body.error.message, "這張卡已排入 AI 自動處理；只能在這台電腦或已配對的手機上建立或修改", label);
}

test("DBG-01: LAN writes that queue a card or change a queued card are 403 and never reach provider.start; loopback still works", async (t) => {
  const board = await startBoard(t);
  const { local, lan, createTask, getTask, block, upload, tick, starts } = board;

  // Queued cards whose content the LAN client tries to change stay blocked by a person's card, so the
  // owner's own cards are not claimed during the test; eligibility for the guard ignores blocks.
  const holder = await createTask({ title: "holder", status: "backlog" });
  const queued = await createTask({ title: "queued", description: "owner text", status: "todo", assigneeTarget: "claude-agent" });
  await block(holder, queued);
  const queuedComment = await local(`/api/tasks/${queued.id}/comments`, { method: "POST", body: { body: "owner comment" } });
  assert.equal(queuedComment.status, 201, queuedComment.text);
  const queuedAttachment = await upload(local, `/api/tasks/${queued.id}/attachments`, "owner.txt");
  assert.equal(queuedAttachment.status, 201, queuedAttachment.text);

  // Not queued yet: a change would make them claimable immediately.
  const backlogAi = await createTask({ title: "backlog ai", status: "backlog", assigneeTarget: "codex-agent" });
  const personTodo = await createTask({ title: "person todo", status: "todo" });
  const archivedTodo = await createTask({ title: "archived todo ai", status: "todo", assigneeTarget: "codex-agent" });
  const blockerA = await createTask({ title: "blocker a", status: "backlog" });
  const freedA = await createTask({ title: "freed by relation delete", status: "todo", assigneeTarget: "codex-agent" });
  await block(blockerA, freedA);
  const blockerB = await createTask({ title: "blocker b", status: "backlog" });
  const freedB = await createTask({ title: "freed by blocked_by delete", status: "todo", assigneeTarget: "codex-agent" });
  await block(blockerB, freedB);
  const blockerC = await createTask({ title: "blocker c", status: "in_review" });
  const freedC = await createTask({ title: "freed by done move", status: "todo", assigneeTarget: "codex-agent" });
  await block(blockerC, freedC);
  const blockerD = await createTask({ title: "blocker d", status: "in_review" });
  const freedD = await createTask({ title: "freed by done patch", status: "todo", assigneeTarget: "codex-agent" });
  await block(blockerD, freedD);
  const blockerE = await createTask({ title: "blocker e", status: "backlog" });
  const freedE = await createTask({ title: "freed by delete", status: "todo", assigneeTarget: "codex-agent" });
  await block(blockerE, freedE);

  // Archive what must be archived before auto-claim can see it.
  for (const card of [archivedTodo, blockerE]) {
    const current = await getTask(card.id);
    const archived = await local(`/api/tasks/${card.id}/archive`, { method: "POST", body: { version: current.version } });
    assert.equal(archived.status, 200, archived.text);
  }

  const enabled = await local("/api/projects/work/automation", { method: "PUT", body: { enabled: true, maxParallel: 10 } });
  assert.equal(enabled.status, 200, enabled.text);
  const initial = await tick();
  assert.deepEqual(initial.started, [], "setup leaves nothing claimable");
  assert.equal(starts.length, 0);

  const q = await getTask(queued.id);
  const denied = [
    ["create todo AI card", () => lan("/api/tasks", { method: "POST", body: { projectId: "work", title: "LAN card", description: "LAN-INJECTED", status: "todo", assigneeTarget: "claude-agent" } })],
    ["move backlog AI card to todo", async () => lan(`/api/tasks/${backlogAi.id}/move`, { method: "POST", body: { version: (await getTask(backlogAi.id)).version, status: "todo" } })],
    ["reorder a queued card", () => lan(`/api/tasks/${queued.id}/move`, { method: "POST", body: { version: q.version, status: "todo", sortOrder: 99 } })],
    ["move a queued card out of todo", () => lan(`/api/tasks/${queued.id}/move`, { method: "POST", body: { version: q.version, status: "backlog" } })],
    ["PATCH backlog AI card to todo", async () => lan(`/api/tasks/${backlogAi.id}`, { method: "PATCH", body: { version: (await getTask(backlogAi.id)).version, status: "todo" } })],
    ["PATCH person todo card to an AI assignee", () => lan(`/api/tasks/${personTodo.id}`, { method: "PATCH", body: { version: personTodo.version, assigneeTarget: "claude-agent" } })],
    ["PATCH queued description", () => lan(`/api/tasks/${queued.id}`, { method: "PATCH", body: { version: q.version, description: "LAN-REWRITTEN" } })],
    ["PATCH queued title", () => lan(`/api/tasks/${queued.id}`, { method: "PATCH", body: { version: q.version, title: "LAN title" } })],
    ["PATCH queued assignee", () => lan(`/api/tasks/${queued.id}`, { method: "PATCH", body: { version: q.version, assigneeTarget: "codex-agent" } })],
    ["PATCH queued project", () => lan(`/api/tasks/${queued.id}`, { method: "PATCH", body: { version: q.version, projectId: "other" } })],
    ["PATCH queued status", () => lan(`/api/tasks/${queued.id}`, { method: "PATCH", body: { version: q.version, status: "backlog" } })],
    ["comment on a queued card", () => lan(`/api/tasks/${queued.id}/comments`, { method: "POST", body: { body: "LAN-COMMENT" } })],
    ["edit a queued card's comment", () => lan(`/api/comments/${queuedComment.body.comment.id}`, { method: "PATCH", body: { version: queuedComment.body.comment.version, body: "LAN-EDIT" } })],
    ["delete a queued card's comment", () => lan(`/api/comments/${queuedComment.body.comment.id}`, { method: "DELETE", body: { version: queuedComment.body.comment.version } })],
    ["upload a task attachment to a queued card", () => upload(lan, `/api/tasks/${queued.id}/attachments`, "lan.txt")],
    ["upload a comment attachment to a queued card", () => upload(lan, `/api/comments/${queuedComment.body.comment.id}/attachments`, "lan.txt")],
    ["delete a queued card's attachment", () => lan(`/api/attachments/${queuedAttachment.body.attachment.id}`, { method: "DELETE" })],
    ["restore an archived todo AI card", async () => lan(`/api/tasks/${archivedTodo.id}/restore`, { method: "POST", body: { version: (await getTask(archivedTodo.id)).version } })],
    ["delete a blocks relation", async () => lan(`/api/tasks/${blockerA.id}/relations/blocks/${freedA.id}`, { method: "DELETE", body: { version: (await getTask(blockerA.id)).version } })],
    ["delete a blocked_by relation", async () => lan(`/api/tasks/${freedB.id}/relations/blocked_by/${blockerB.id}`, { method: "DELETE", body: { version: (await getTask(freedB.id)).version } })],
    ["move a blocker to done", async () => lan(`/api/tasks/${blockerC.id}/move`, { method: "POST", body: { version: (await getTask(blockerC.id)).version, status: "done" } })],
    ["PATCH a blocker to done", async () => lan(`/api/tasks/${blockerD.id}`, { method: "PATCH", body: { version: (await getTask(blockerD.id)).version, status: "done" } })],
    ["delete an archived blocker", async () => lan(`/api/tasks/${blockerE.id}`, { method: "DELETE", body: { version: (await getTask(blockerE.id)).version } })],
    ["reset the claim order", () => lan("/api/projects/work/order/reset", { method: "POST" })],
  ];
  for (const [label, attempt] of denied) assertDenied(await attempt(), label);

  const afterLan = await tick();
  assert.deepEqual(afterLan.started, []);
  assert.equal(starts.length, 0, JSON.stringify(starts));
  const unchanged = await getTask(queued.id);
  assert.equal(unchanged.version, q.version);
  assert.equal(unchanged.description, "owner text");
  assert.equal(unchanged.projectId, "work");
  assert.equal((await local(`/api/tasks/${queued.id}/comments`)).body.comments.length, 1);
  assert.equal((await local(`/api/tasks?projectId=work`)).body.tasks.some((task) => task.title === "LAN card"), false);
  assert.equal((await getTask(backlogAi.id)).status, "backlog");
  assert.equal((await getTask(personTodo.id)).assignee.type, "user");
  assert.notEqual((await getTask(archivedTodo.id)).archivedAt, null);

  // Ordinary LAN edits of cards outside the queue keep the upstream behaviour.
  const holderNow = await getTask(holder.id);
  const renamed = await lan(`/api/tasks/${holder.id}`, { method: "PATCH", body: { version: holderNow.version, title: "renamed by LAN" } });
  assert.equal(renamed.status, 200, renamed.text);
  const backlogComment = await lan(`/api/tasks/${backlogAi.id}/comments`, { method: "POST", body: { body: "LAN note on backlog" } });
  assert.equal(backlogComment.status, 201, backlogComment.text);
  const lanBacklogCard = await lan("/api/tasks", { method: "POST", body: { projectId: "work", title: "LAN backlog", status: "backlog", assigneeTarget: "claude-agent" } });
  assert.equal(lanBacklogCard.status, 201, lanBacklogCard.text);
  const personMove = await lan(`/api/tasks/${personTodo.id}/move`, { method: "POST", body: { version: personTodo.version, status: "in_review" } });
  assert.equal(personMove.status, 200, personMove.text);
  assert.equal((await tick()).started.length, 0);
  assert.equal(starts.length, 0);

  // Loopback equivalents still work (and do queue work for the AI).
  const allowed = [
    ["comment on a queued card", () => local(`/api/tasks/${queued.id}/comments`, { method: "POST", body: { body: "owner comment 2" } })],
    ["upload an attachment to a queued card", () => upload(local, `/api/tasks/${queued.id}/attachments`, "owner-2.txt")],
    ["PATCH queued description", async () => local(`/api/tasks/${queued.id}`, { method: "PATCH", body: { version: (await getTask(queued.id)).version, description: "owner edit" } })],
    ["reset the claim order", () => local("/api/projects/work/order/reset", { method: "POST" })],
    ["create todo AI card", () => local("/api/tasks", { method: "POST", body: { projectId: "work", title: "owner todo card", status: "todo", assigneeTarget: "claude-agent" } })],
    ["move backlog AI card to todo", async () => local(`/api/tasks/${backlogAi.id}/move`, { method: "POST", body: { version: (await getTask(backlogAi.id)).version, status: "todo" } })],
    ["restore an archived todo AI card", async () => local(`/api/tasks/${archivedTodo.id}/restore`, { method: "POST", body: { version: (await getTask(archivedTodo.id)).version } })],
    ["delete a blocks relation", async () => local(`/api/tasks/${blockerA.id}/relations/blocks/${freedA.id}`, { method: "DELETE", body: { version: (await getTask(blockerA.id)).version } })],
    ["move a blocker to done", async () => local(`/api/tasks/${blockerC.id}/move`, { method: "POST", body: { version: (await getTask(blockerC.id)).version, status: "done" } })],
  ];
  for (const [label, attempt] of allowed) {
    const result = await attempt();
    assert.ok(result.status >= 200 && result.status < 300, `${label}: ${result.status} ${result.text}`);
  }
  const claimed = await tick();
  assert.equal(claimed.started.length, 5, JSON.stringify(claimed.started));
  assert.equal(starts.length, 5);
  assert.equal(starts.some((start) => /LAN-/.test(start.prompt)), false);
});

test("DBG-01: mobile access off, a tailnet peer keeps LAN rules; mobile access on, a forged private-LAN Host is still a mobile request", async (t) => {
  const board = await startBoard(t);
  const { lan, local, starts, tick } = board;
  const spoofed = (options) => lan("/api/tasks", { method: "POST", remoteAddress: TAILNET_PEER, body: { projectId: "work", title: "tailnet card", status: "todo", assigneeTarget: "claude-agent" }, ...options });

  // Mobile access off: a Tailscale / CGNAT peer (colleague, taskctl elsewhere) is not over-blocked;
  // reads, static files and ordinary CRUD follow the private-network rules, which still cannot queue AI work.
  for (const remoteAddress of [TAILNET_PEER, `::ffff:${TAILNET_PEER}`]) {
    const read = await lan("/api/tasks?projectId=work", { remoteAddress });
    assert.equal(read.status, 200, read.text);
    const page = await lan("/", { remoteAddress });
    assert.equal(page.status, 200, page.text);
    const plain = await lan("/api/tasks", { method: "POST", remoteAddress, body: { projectId: "work", title: `peer card ${remoteAddress}`, status: "backlog" } });
    assert.equal(plain.status, 201, plain.text);
  }
  const disabled = await spoofed();
  assert.equal(disabled.status, 403, disabled.text);
  assert.equal(disabled.body.error.code, "AUTO_CLAIM_WRITE_REQUIRES_LOCAL");
  await tick();
  assert.equal(starts.length, 0);

  const enabled = await local("/api/local/mobile-access", { method: "PUT", body: { enabled: true } });
  assert.equal(enabled.status, 200, enabled.text);
  const automation = await local("/api/projects/work/automation", { method: "PUT", body: { enabled: true } });
  assert.equal(automation.status, 200, automation.text);
  for (const remoteAddress of [TAILNET_PEER, `::ffff:${TAILNET_PEER}`]) {
    const result = await spoofed({ remoteAddress });
    assert.equal(result.status, 403, result.text);
    assert.equal(result.body.error.code, "INVALID_HOST");
    const read = await lan("/api/tasks", { remoteAddress });
    assert.equal(read.status, 403, read.text);
  }
  await tick();
  assert.equal(starts.length, 0);
  assert.deepEqual((await local("/api/tasks?projectId=work")).body.tasks.filter((task) => task.title === "tailnet card"), []);
});

test("DBG-01 helpers: auto-claim eligibility and tailnet source addresses", () => {
  const agent = { type: "agent", id: "claude-agent" };
  assert.equal(isAutoClaimEligibleTask({ status: "todo", archivedAt: null, assignee: agent }), true);
  assert.equal(isAutoClaimEligibleTask({ status: "todo", archivedAt: null, assignee: { type: "agent", id: "codex-agent" } }), true);
  assert.equal(isAutoClaimEligibleTask({ status: "backlog", archivedAt: null, assignee: agent }), false);
  assert.equal(isAutoClaimEligibleTask({ status: "todo", archivedAt: "2026-09-17T00:00:00.000Z", assignee: agent }), false);
  assert.equal(isAutoClaimEligibleTask({ status: "todo", archivedAt: null, assignee: { type: "user", id: "local-user" } }), false);
  assert.equal(isAutoClaimEligibleTask(null), false);

  for (const address of ["100.64.0.1", "100.100.100.100", "100.127.255.255", "::ffff:100.70.1.2"]) {
    assert.equal(isTailnetAddress(address), true, address);
  }
  for (const address of ["100.63.255.255", "100.128.0.1", "192.168.50.20", "127.0.0.1", "::1", "fd7a::1", "", undefined]) {
    assert.equal(isTailnetAddress(address), false, String(address));
  }
});
