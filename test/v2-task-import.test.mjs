// Amendment 11 (F4): loopback-only taskctl import may create done cards; everything else stays as before.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { main } from "../cli/taskctl.mjs";
import {
  assertTaskImportRequest,
  createTaskboardServer,
  importedTaskStatus,
} from "../server/app.mjs";

const TAILNET_ADDRESS = "100.64.0.9";
const PHONE_ADDRESS = "100.70.1.2";
const quietLogger = { info() {}, warn() {}, error() {} };
const TASKCTL = { "x-taskboard-client": "taskctl" };

function fakeProvider(name, starts) {
  return {
    name,
    async available() { return { ok: true }; },
    async start(input) { starts.push({ name, input }); return {}; },
    async sendFollowup() { return { delivered: true, detail: "" }; },
    async stop() { return { stopped: true, detail: "" }; },
    async close() {},
    openUrl() { return null; },
    async recover() { return { status: "interrupted" }; },
    async dispose() {},
  };
}

async function startBoard(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-v2-import-"));
  const staticDirectory = path.join(directory, "web");
  await mkdir(staticDirectory, { recursive: true });
  await writeFile(path.join(staticDirectory, "index.html"), "<!doctype html><title>Taskboard</title>");
  const starts = [];
  const app = createTaskboardServer({
    dataDirectory: directory,
    staticDirectory,
    runProviders: { claude: fakeProvider("claude", starts), codex: fakeProvider("codex", starts) },
    enableScheduler: true,
    runLogger: quietLogger,
    mobileAccessOptions: {
      execFile: (file, args, opts, callback) => callback(null, `${TAILNET_ADDRESS}\n`, ""),
      logger: quietLogger,
    },
    ...options,
  });
  const address = await app.listen({ port: 0 });
  await app.whenStarted();
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const port = address.port;
  const workspace = path.join(directory, "work");
  await mkdir(workspace, { recursive: true });
  const project = await local(port, "/api/projects", {
    method: "POST",
    body: { id: "work", name: "work", workspacePath: workspace },
  });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  return { app, port, starts };
}

async function local(port, pathname, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

// Dispatches a request with a forged socket address through the real server handler.
async function remote(app, pathname, { method = "GET", body, headers = {}, remoteAddress } = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  request.method = method;
  request.url = pathname;
  request.socket = { remoteAddress };
  request.headers = { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers };
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const response = {
    statusCode: null,
    headers: {},
    body: "",
    headersSent: false,
    writableEnded: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(status, values = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(values)) this.headers[name.toLowerCase()] = value;
      this.headersSent = true;
      return this;
    },
    write(chunk) { this.body += chunk; return true; },
    end(chunk) {
      if (chunk) this.body += chunk;
      this.writableEnded = true;
      finish();
    },
    destroy(error) { this.destroyed = error ?? true; finish(); },
  };
  app.server.emit("request", request, response);
  await done;
  let parsed;
  try { parsed = response.body ? JSON.parse(response.body) : undefined; } catch { parsed = undefined; }
  return { status: response.statusCode, headers: response.headers, body: parsed, text: response.body };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

test("status mapping keeps only done; every other source status becomes backlog", () => {
  assert.equal(importedTaskStatus("done"), "done");
  for (const status of ["backlog", "todo", "in_progress", "in_review", "blocked", "canceled"]) {
    assert.equal(importedTaskStatus(status), "backlog", status);
  }
});

test("guard helper: import needs loopback + taskctl and rejects phones, LAN and trusted origins", () => {
  const loopback = { socket: { remoteAddress: "127.0.0.1" }, headers: TASKCTL };
  assert.equal(assertTaskImportRequest(loopback), undefined);
  const rejects = (request, options, code) => assert.throws(
    () => assertTaskImportRequest(request, options),
    (error) => error.status === 403 && error.code === code,
  );
  rejects({ socket: { remoteAddress: "192.168.50.20" }, headers: TASKCTL }, {}, "IMPORT_LOOPBACK_REQUIRED");
  rejects({ socket: { remoteAddress: PHONE_ADDRESS }, headers: TASKCTL }, { mobileRemote: true, mobilePrincipal: { sessionId: "s" } }, "IMPORT_LOOPBACK_REQUIRED");
  rejects(loopback, { mobilePrincipal: { sessionId: "s" } }, "IMPORT_LOOPBACK_REQUIRED");
  rejects(loopback, { configuredTrustedRequest: true }, "IMPORT_LOOPBACK_REQUIRED");
  rejects({ socket: { remoteAddress: "127.0.0.1" }, headers: {} }, {}, "IMPORT_TASKCTL_REQUIRED");
});

test("loopback taskctl import creates done and backlog cards and never starts or queues AI work", async (t) => {
  const { app, port, starts } = await startBoard(t);
  const imported = [];
  for (const status of ["done", "in_progress", "todo", "backlog", "in_review"]) {
    const result = await local(port, "/api/tasks/import", {
      method: "POST",
      headers: TASKCTL,
      body: { projectId: "work", title: `匯入 ${status}`, status, assigneeTarget: "codex-agent" },
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.import.requestedStatus, status);
    assert.equal(result.body.task.status, status === "done" ? "done" : "backlog");
    assert.equal(result.body.task.activeRun, null);
    imported.push(result.body.task);
  }
  await settle();
  assert.deepEqual(starts, []);
  for (const task of imported) {
    const current = await local(port, `/api/tasks/${task.id}`);
    assert.ok(["done", "backlog"].includes(current.body.task.status), current.body.task.status);
    assert.equal(current.body.task.latestRun, null);
  }
  const all = await local(port, "/api/tasks?projectId=work");
  assert.equal(all.body.tasks.some((task) => task.status === "todo" || task.status === "in_progress"), false);

  // The import route is not a task id and only accepts POST.
  const get = await local(port, "/api/tasks/import", { headers: TASKCTL });
  assert.equal(get.status, 405);
  // Without the taskctl identity the import route is refused.
  const browser = await local(port, "/api/tasks/import", {
    method: "POST",
    body: { projectId: "work", title: "x", status: "done" },
  });
  assert.equal(browser.status, 403);
  assert.equal(browser.body.error.code, "IMPORT_TASKCTL_REQUIRED");
  assert.equal(app.server.listening, true);
});

test("private-LAN import is rejected", async (t) => {
  const { app, port } = await startBoard(t);
  const lan = await remote(app, "/api/tasks/import", {
    method: "POST",
    remoteAddress: "192.168.50.20",
    headers: { host: `192.168.50.5:${port}`, ...TASKCTL },
    body: { projectId: "work", title: "LAN 匯入", status: "done" },
  });
  assert.equal(lan.status, 403, lan.text);
  assert.equal(lan.body.error.code, "IMPORT_LOOPBACK_REQUIRED");
  const tasks = await local(port, "/api/tasks?projectId=work");
  assert.equal(tasks.body.tasks.length, 0);
});

test("a paired phone cannot import", async (t) => {
  const { app, port } = await startBoard(t);
  const remoteHost = `${TAILNET_ADDRESS}:${port}`;
  const remoteOrigin = `http://${remoteHost}`;
  const enabled = await local(port, "/api/local/mobile-access", { method: "PUT", body: { enabled: true } });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  await app.syncMobileListener();
  const challenge = await local(port, "/api/local/pairing/challenges", {
    method: "POST",
    body: { requestKey: "22222222-2222-4222-8222-222222222222", deviceLabel: "Phone" },
  });
  assert.equal(challenge.status, 201, JSON.stringify(challenge.body));
  const approved = await local(port, `/api/local/pairing/challenges/${challenge.body.challengeId}/approve`, { method: "POST" });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const completed = await remote(app, "/api/pairing/complete", {
    method: "POST",
    remoteAddress: PHONE_ADDRESS,
    headers: { host: remoteHost, origin: remoteOrigin },
    body: { challengeId: challenge.body.challengeId, challengeCode: challenge.body.challengeCode },
  });
  assert.equal(completed.status, 201, completed.text);
  const cookie = String(completed.headers["set-cookie"]).split(";", 1)[0];
  const phone = await remote(app, "/api/tasks/import", {
    method: "POST",
    remoteAddress: PHONE_ADDRESS,
    headers: { host: remoteHost, origin: remoteOrigin, cookie, "x-relay-csrf": completed.body.csrfToken, ...TASKCTL },
    body: { projectId: "work", title: "手機匯入", status: "done" },
  });
  assert.equal(phone.status, 403, phone.text);
  assert.equal(phone.body.error.code, "IMPORT_LOOPBACK_REQUIRED");
  const tasks = await local(port, "/api/tasks?projectId=work");
  assert.equal(tasks.body.tasks.length, 0);
});

test("normal agent create is still forced to backlog and agent done is still 403", async (t) => {
  const { port } = await startBoard(t);
  const created = await local(port, "/api/tasks", {
    method: "POST",
    headers: TASKCTL,
    body: { projectId: "work", title: "一般 agent 卡", status: "done" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.task.status, "backlog");
  const task = created.body.task;
  const moved = await local(port, `/api/tasks/${task.id}/move`, {
    method: "POST",
    headers: TASKCTL,
    body: { version: task.version, status: "done" },
  });
  assert.equal(moved.status, 403, JSON.stringify(moved.body));
  assert.equal(moved.body.error.code, "AGENT_CANNOT_COMPLETE");
  const patched = await local(port, `/api/tasks/${task.id}`, {
    method: "PATCH",
    headers: TASKCTL,
    body: { version: task.version, status: "done" },
  });
  assert.equal(patched.status, 403, JSON.stringify(patched.body));
  assert.equal(patched.body.error.code, "AGENT_CANNOT_COMPLETE");
});

test("taskctl issue create --import posts to the import route; without it the normal route", async () => {
  const calls = [];
  const fetchImplementation = async (url, init) => {
    calls.push({ url: url.toString(), init });
    return new Response(JSON.stringify({ task: { id: "WORK-1" } }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };
  const io = () => ({ write() {} });
  const options = { fetch: fetchImplementation, stdout: io(), stderr: io(), env: { CODEX_THREAD_ID: "thread-current" } };
  assert.equal(await main(["issue", "create", "--import", "--project", "work", "--title", "A", "--status", "done"], options), 0);
  assert.equal(await main(["issue", "create", "--project", "work", "--title", "B"], options), 0);
  assert.equal(calls[0].url, "http://127.0.0.1:47833/api/tasks/import");
  assert.equal(JSON.parse(calls[0].init.body).status, "done");
  assert.equal(calls[0].init.headers["x-taskboard-client"], "taskctl");
  assert.equal(calls[1].url, "http://127.0.0.1:47833/api/tasks");
  assert.equal(await main(["issue", "create", "--import=yes", "--project", "work", "--title", "C"], options), 2);
});

test("cloud mode: import is handled locally (loopback + taskctl) and creates done/backlog cards in the cloud", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-v2-import-cloud-"));
  const upstreamCalls = [];
  const upstream = createServer((request, response) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      upstreamCalls.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body: text });
      if (request.method === "POST" && request.url === "/api/tasks") {
        const body = JSON.parse(text);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ task: { id: `c-${upstreamCalls.length}`, projectId: body.projectId, title: body.title, status: body.status } }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Route not found" } }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const app = createTaskboardServer({
    dataDirectory: directory,
    runLogger: quietLogger,
    cloudConfigStore: {
      async read() {
        return {
          remoteUrl: `http://127.0.0.1:${upstream.address().port}`,
          actorName: "Cloud actor",
          sharedKey: "cloud-shared-key",
          projectMappings: {},
        };
      },
    },
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const port = address.port;

  for (const status of ["done", "in_progress"]) {
    const result = await local(port, "/api/tasks/import", {
      method: "POST",
      headers: TASKCTL,
      body: { projectId: "work", title: `雲端匯入 ${status}`, status },
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.task.status, status === "done" ? "done" : "backlog");
    assert.deepEqual(result.body.import, { requestedStatus: status, status: result.body.task.status });
  }
  assert.deepEqual(upstreamCalls.map((call) => `${call.method} ${call.url}`), ["POST /api/tasks", "POST /api/tasks"]);
  assert.deepEqual(upstreamCalls.map((call) => JSON.parse(call.body).status), ["done", "backlog"]);
  assert.match(upstreamCalls[0].authorization, /^Basic /);

  // The guard still applies before anything reaches the cloud.
  const browser = await local(port, "/api/tasks/import", {
    method: "POST",
    body: { projectId: "work", title: "x", status: "done" },
  });
  assert.equal(browser.status, 403);
  assert.equal(browser.body.error.code, "IMPORT_TASKCTL_REQUIRED");
  const lan = await remote(app, "/api/tasks/import", {
    method: "POST",
    remoteAddress: "192.168.50.20",
    headers: { host: `192.168.50.5:${port}`, ...TASKCTL },
    body: { projectId: "work", title: "LAN", status: "done" },
  });
  assert.equal(lan.status, 403, lan.text);
  assert.equal(upstreamCalls.length, 2);
});
