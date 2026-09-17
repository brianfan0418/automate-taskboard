// v2 integration (I-S): mobile access wiring in the board server (CONTRACTS C7).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import {
  assertAutoClaimWriteRequest,
  assertMobileRemoteAuthorized,
  assertRunControlRequest,
  createTaskboardServer,
  isMobileRemoteRequest,
} from "../server/app.mjs";

const TAILNET_ADDRESS = "100.64.0.9";
const PHONE_ADDRESS = "100.70.1.2";
const INSTANCE_TOKEN = "relay-instance-token-0001";
const INSTANCE_SECRET = "0123456789abcdef0123456789abcdef";
const quietLogger = { info() {}, warn() {}, error() {} };

function fakeTailscale(stdout = `${TAILNET_ADDRESS}\n`) {
  const calls = [];
  const execFile = (file, args, options, callback) => {
    calls.push({ file, args });
    callback(null, stdout, "");
  };
  return { execFile, calls };
}

function fakeProvider(name) {
  return {
    name,
    async available() { return { ok: true }; },
    async start() { return {}; },
    async sendFollowup() { return { delivered: true, detail: "" }; },
    async stop() { return { stopped: true, detail: "" }; },
    async close() {},
    openUrl() { return null; },
    async recover() { return { status: "interrupted" }; },
    async dispose() {},
  };
}

async function startBoard(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-v2-mobile-"));
  const staticDirectory = path.join(directory, "web");
  await mkdir(staticDirectory, { recursive: true });
  await writeFile(path.join(staticDirectory, "index.html"), "<!doctype html><title>Taskboard</title>");
  const tailscale = fakeTailscale();
  const app = createTaskboardServer({
    dataDirectory: directory,
    staticDirectory,
    runProviders: { claude: fakeProvider("claude"), codex: fakeProvider("codex") },
    enableScheduler: false,
    runLogger: quietLogger,
    mobileAccessOptions: { execFile: tailscale.execFile, logger: quietLogger },
    ...options,
  });
  const address = await app.listen({ port: 0 });
  await app.whenStarted();
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { app, port: address.port, tailscale };
}

async function local(port, pathname, { method = "GET", body, prefix = "" } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${prefix}${pathname}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

// Dispatches a request with a forged non-loopback socket through the real server handler.
async function remote(app, pathname, { method = "GET", body, headers = {}, remoteAddress = PHONE_ADDRESS } = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const request = Readable.from(payload);
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

test("tailnet requests need a paired session for /api; the web UI, pairing completion and LAN rules keep working", async (t) => {
  const { app, port, tailscale } = await startBoard(t, { instanceToken: INSTANCE_TOKEN, instanceSecret: INSTANCE_SECRET });
  const prefix = `/${INSTANCE_TOKEN}`;
  const remoteHost = `${TAILNET_ADDRESS}:${port}`;
  const remoteOrigin = `http://${remoteHost}`;

  // Before mobile access is enabled a tailnet peer is not a phone: it follows the ordinary launcher
  // rules (token prefix required, and the tailnet Host is not a trusted private-network Host).
  const disabled = await remote(app, "/api/tasks", { headers: { host: remoteHost } });
  assert.equal(disabled.status, 404);
  assert.equal(disabled.body.error.code, "NOT_FOUND");
  const disabledPrefixed = await remote(app, `${prefix}/api/tasks`, { headers: { host: remoteHost } });
  assert.equal(disabledPrefixed.status, 403);
  assert.equal(disabledPrefixed.body.error.code, "INVALID_HOST");
  assert.equal(tailscale.calls.length, 0);

  const enabled = await local(port, "/api/local/mobile-access", { method: "PUT", body: { enabled: true }, prefix });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  assert.equal(enabled.body.enabled, true);
  assert.equal(enabled.body.url, `http://${TAILNET_ADDRESS}:${port}/`);
  // The extra listener cannot bind a fake 100.x address here; the failure is logged, not fatal.
  await app.syncMobileListener();
  assert.equal(app.tailnetAddress, null);

  const unpaired = await remote(app, "/api/tasks", { headers: { host: remoteHost } });
  assert.equal(unpaired.status, 401);
  assert.equal(unpaired.body.error.code, "PAIRING_REQUIRED");
  const unpairedEvents = await remote(app, "/api/events", { headers: { host: remoteHost } });
  assert.equal(unpairedEvents.status, 401);

  // The phone loads the web UI without the launcher token and without a session.
  const page = await remote(app, "/", { headers: { host: remoteHost } });
  assert.equal(page.status, 200);
  assert.match(page.text, /Taskboard/);

  // Pairing: desktop creates + approves, phone completes (no session yet).
  const challenge = await local(port, "/api/local/pairing/challenges", {
    method: "POST",
    body: { requestKey: "11111111-1111-4111-8111-111111111111", deviceLabel: "Alice iPhone" },
    prefix,
  });
  assert.equal(challenge.status, 201, JSON.stringify(challenge.body));
  const approved = await local(port, `/api/local/pairing/challenges/${challenge.body.challengeId}/approve`, { method: "POST", prefix });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const completed = await remote(app, "/api/pairing/complete", {
    method: "POST",
    headers: { host: remoteHost, origin: remoteOrigin },
    body: { challengeId: challenge.body.challengeId, challengeCode: challenge.body.challengeCode },
  });
  assert.equal(completed.status, 201, completed.text);
  const cookie = String(completed.headers["set-cookie"]).split(";", 1)[0];
  const csrf = completed.body.csrfToken;

  const tasks = await remote(app, "/api/tasks", { headers: { host: remoteHost, cookie } });
  assert.equal(tasks.status, 200, tasks.text);
  assert.equal(Array.isArray(tasks.body.tasks), true);

  const writeWithoutCsrf = await remote(app, "/api/tasks", {
    method: "POST",
    headers: { host: remoteHost, origin: remoteOrigin, cookie },
    body: { title: "手機建的卡" },
  });
  assert.equal(writeWithoutCsrf.status, 401);
  assert.equal(writeWithoutCsrf.body.error.code, "PAIRING_REQUIRED");
  const write = await remote(app, "/api/tasks", {
    method: "POST",
    headers: { host: remoteHost, origin: remoteOrigin, cookie, "x-relay-csrf": csrf },
    body: { title: "手機建的卡" },
  });
  assert.equal(write.status, 201, write.text);
  assert.equal(write.body.task.activeRun, null);

  // Review fix: a paired phone may start an AI run (it passed pairing + CSRF).
  await mkdir(path.join(os.tmpdir(), "work"), { recursive: true }); // runs need an existing folder (W3 bug 4)
  const project = await local(port, "/api/projects", {
    method: "POST",
    body: { id: "work", name: "work", workspacePath: path.join(os.tmpdir(), "work") },
    prefix,
  });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  const agentTask = await local(port, "/api/tasks", {
    method: "POST",
    body: { projectId: "work", title: "手機開工", status: "todo", assigneeTarget: "codex-agent" },
    prefix,
  });
  assert.equal(agentTask.status, 201, JSON.stringify(agentTask.body));
  const phoneStart = await remote(app, `/api/tasks/${agentTask.body.task.id}/run/start`, {
    method: "POST",
    headers: { host: remoteHost, origin: remoteOrigin, cookie, "x-relay-csrf": csrf },
  });
  assert.equal(phoneStart.status, 202, phoneStart.text);
  assert.equal(phoneStart.body.task.status, "in_progress");

  // Device-local routes stay local even for a paired phone.
  const localOnly = await remote(app, "/api/local/pairing/sessions", { headers: { host: remoteHost, cookie } });
  assert.equal(localOnly.status, 403);
  assert.equal(localOnly.body.error.code, "LOCAL_ONLY");
  const settingsFromPhone = await remote(app, "/api/local/mobile-access", { headers: { host: remoteHost, cookie } });
  assert.equal(settingsFromPhone.status, 403);

  // T10: the desktop lists paired devices.
  const sessions = await local(port, "/api/local/pairing/sessions", { prefix });
  assert.equal(sessions.status, 200, JSON.stringify(sessions.body));
  assert.equal(sessions.body.sessions.length, 1);
  assert.equal(sessions.body.sessions[0].deviceLabel, "Alice iPhone");

  // Local requests still require the launcher token prefix.
  const noPrefix = await local(port, "/api/tasks");
  assert.equal(noPrefix.status, 404);

  // A private-LAN client (not tailnet) keeps the upstream LAN behaviour.
  const lan = await remote(app, "/health", { remoteAddress: "192.168.50.20", headers: { host: `192.168.50.5:${port}` } });
  assert.equal(lan.status, 401);
  assert.equal(lan.body.error.code, "INVALID_INSTANCE_CHALLENGE");

  // Turning mobile access off makes the tailnet origin untrusted again, even with a session.
  const off = await local(port, "/api/local/mobile-access", { method: "PUT", body: { enabled: false }, prefix });
  assert.equal(off.status, 200);
  const afterOff = await remote(app, "/api/tasks", { headers: { host: remoteHost, cookie } });
  assert.equal(afterOff.status, 404);
  assert.equal(afterOff.body.error.code, "NOT_FOUND");
  const afterOffPrefixed = await remote(app, `${prefix}/api/tasks`, { headers: { host: remoteHost, cookie } });
  assert.equal(afterOffPrefixed.status, 403);
  assert.equal(afterOffPrefixed.body.error.code, "INVALID_HOST");
});

test("private LAN requests on a 0.0.0.0-style listener keep upstream access without pairing", async (t) => {
  const { app, port } = await startBoard(t);
  const lan = await remote(app, "/api/projects", { remoteAddress: "192.168.50.20", headers: { host: `192.168.50.5:${port}` } });
  assert.equal(lan.status, 200, lan.text);
});

test("review fix: private-LAN clients cannot start or control AI runs; ordinary task edits stay available", async (t) => {
  const { app, port } = await startBoard(t);
  const lan = (pathname, options = {}) => remote(app, pathname, {
    remoteAddress: "192.168.50.20",
    ...options,
    headers: { host: `192.168.50.5:${port}`, ...(options.headers ?? {}) },
  });
  await mkdir(path.join(os.tmpdir(), "work"), { recursive: true }); // runs need an existing folder (W3 bug 4)
  const project = await local(port, "/api/projects", {
    method: "POST",
    body: { id: "work", name: "work", workspacePath: path.join(os.tmpdir(), "work") },
  });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  const created = await local(port, "/api/tasks", {
    method: "POST",
    body: { projectId: "work", title: "AI 卡", status: "todo", assigneeTarget: "codex-agent" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const task = created.body.task;

  for (const [pathname, body] of [
    [`/api/tasks/${task.id}/run/start`, undefined],
    [`/api/tasks/${task.id}/run/stop`, undefined],
    [`/api/tasks/${task.id}/run/followup`, { body: "hi", mode: "queue" }],
    [`/api/tasks/${task.id}/continue`, { body: "hi" }],
    [`/api/tasks/${task.id}/rework`, { body: "hi" }],
  ]) {
    const result = await lan(pathname, { method: "POST", body });
    assert.equal(result.status, 403, `${pathname} ${result.text}`);
    assert.equal(result.body.error.code, "LOCAL_AI_LOOPBACK_REQUIRED");
  }
  const moved = await lan(`/api/tasks/${task.id}/move`, { method: "POST", body: { version: task.version, status: "in_progress" } });
  assert.equal(moved.status, 403, moved.text);
  // A move that would start the AI keeps the direct run-control code.
  assert.equal(moved.body.error.code, "LOCAL_AI_LOOPBACK_REQUIRED");
  const patchedStart = await lan(`/api/tasks/${task.id}`, { method: "PATCH", body: { version: task.version, status: "in_progress" } });
  assert.equal(patchedStart.status, 403, patchedStart.text);
  const automation = await lan("/api/projects/work/automation", { method: "PUT", body: { enabled: true } });
  assert.equal(automation.status, 403, automation.text);
  assert.equal((await local(port, "/api/projects/work/automation")).body.automation.enabled, false);
  const unchanged = await local(port, `/api/tasks/${task.id}`);
  assert.equal(unchanged.body.task.status, "todo");
  assert.equal(unchanged.body.task.latestRun, null);

  // Reading runs keeps the upstream LAN behaviour. DBG-01: editing a card in the auto-claim queue
  // (todo + AI assignee) needs run control; ordinary cards stay editable (see v2-dbg-01 tests).
  assert.equal((await lan(`/api/tasks/${task.id}/runs`)).status, 200);
  const renamed = await lan(`/api/tasks/${task.id}`, { method: "PATCH", body: { version: task.version, title: "改名" } });
  assert.equal(renamed.status, 403, renamed.text);
  assert.equal(renamed.body.error.code, "AUTO_CLAIM_WRITE_REQUIRES_LOCAL");
  const backlog = await local(port, "/api/tasks", {
    method: "POST",
    body: { projectId: "work", title: "一般卡", status: "backlog", assigneeTarget: "codex-agent" },
  });
  assert.equal(backlog.status, 201, JSON.stringify(backlog.body));
  const renamedBacklog = await lan(`/api/tasks/${backlog.body.task.id}`, {
    method: "PATCH",
    body: { version: backlog.body.task.version, title: "改名" },
  });
  assert.equal(renamedBacklog.status, 200, renamedBacklog.text);

  // Loopback still starts the run.
  const started = await local(port, `/api/tasks/${task.id}/run/start`, { method: "POST" });
  assert.equal(started.status, 202, JSON.stringify(started.body));
});

test("review fix: configured trusted origins cannot start AI runs", async (t) => {
  const { app, port } = await startBoard(t, {
    processEnv: { ...process.env, CODEX_TASKBOARD_TRUSTED_ORIGINS: "https://board.example.com" },
  });
  await mkdir(path.join(os.tmpdir(), "work"), { recursive: true }); // runs need an existing folder (W3 bug 4)
  const project = await local(port, "/api/projects", {
    method: "POST",
    body: { id: "work", name: "work", workspacePath: path.join(os.tmpdir(), "work") },
  });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  const created = await local(port, "/api/tasks", {
    method: "POST",
    body: { projectId: "work", title: "AI 卡", status: "todo", assigneeTarget: "codex-agent" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const trusted = { host: "board.example.com", origin: "https://board.example.com" };
  const start = await remote(app, `/api/tasks/${created.body.task.id}/run/start`, {
    method: "POST",
    remoteAddress: "127.0.0.1",
    headers: trusted,
  });
  assert.equal(start.status, 409, start.text);
  assert.equal(start.body.error.code, "LOCAL_COMPANION_REQUIRED");
  const automation = await remote(app, "/api/projects/work/automation", {
    method: "PUT",
    remoteAddress: "127.0.0.1",
    headers: trusted,
    body: { enabled: true },
  });
  assert.equal(automation.status, 409, automation.text);
  assert.equal(automation.body.error.code, "LOCAL_COMPANION_REQUIRED");
});

test("guard helper: run control needs loopback or a paired phone and rejects trusted origins", () => {
  const lanRequest = { socket: { remoteAddress: "192.168.50.20" } };
  const loopbackRequest = { socket: { remoteAddress: "127.0.0.1" } };
  assert.throws(() => assertRunControlRequest(lanRequest), (error) => error.status === 403 && error.code === "LOCAL_AI_LOOPBACK_REQUIRED");
  assert.equal(assertRunControlRequest(loopbackRequest), undefined);
  assert.equal(assertRunControlRequest({ socket: { remoteAddress: PHONE_ADDRESS } }, { mobilePrincipal: { sessionId: "s" } }), undefined);
  assert.throws(
    () => assertRunControlRequest(loopbackRequest, { configuredTrustedRequest: true }),
    (error) => error.status === 409 && error.code === "LOCAL_COMPANION_REQUIRED",
  );
  // DBG-01 queue writes: same authorization, own code and Traditional Chinese copy.
  assert.throws(
    () => assertAutoClaimWriteRequest(lanRequest),
    (error) => error.status === 403 && error.code === "AUTO_CLAIM_WRITE_REQUIRES_LOCAL"
      && error.message === "這張卡已排入 AI 自動處理；只能在這台電腦或已配對的手機上建立或修改",
  );
  assert.equal(assertAutoClaimWriteRequest(loopbackRequest), undefined);
  assert.equal(assertAutoClaimWriteRequest({ socket: { remoteAddress: PHONE_ADDRESS } }, { mobilePrincipal: { sessionId: "s" } }), undefined);
  assert.throws(
    () => assertAutoClaimWriteRequest(loopbackRequest, { configuredTrustedRequest: true }),
    (error) => error.status === 409 && error.code === "LOCAL_COMPANION_REQUIRED",
  );
});

test("mobile routes answer 503 when mobile access could not be created", async (t) => {
  const { port } = await startBoard(t, { mobileAccess: false });
  const result = await local(port, "/api/local/mobile-access");
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, "MOBILE_ACCESS_UNAVAILABLE");
});

test("guard helpers: tailnet listener requests are remote; /api needs a principal", () => {
  const loopback = { socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:1" } };
  const trusting = { isTrustedRemoteHost: () => true, authorize: () => null };
  assert.equal(isMobileRemoteRequest(loopback, { listenerKind: "tailnet" }), true);
  assert.equal(isMobileRemoteRequest(loopback, { mobileAccess: trusting }), false);
  assert.equal(isMobileRemoteRequest({ socket: { remoteAddress: PHONE_ADDRESS }, headers: {} }, { mobileAccess: trusting }), true);
  // A tailnet source address alone is not a phone: with mobile access off (or unavailable) a
  // Tailscale / CGNAT peer keeps the private-network rules (colleagues, taskctl on another machine).
  const tailnetPeer = { socket: { remoteAddress: PHONE_ADDRESS }, headers: {} };
  assert.equal(isMobileRemoteRequest(tailnetPeer, { mobileAccess: null }), false);
  assert.equal(
    isMobileRemoteRequest(tailnetPeer, { mobileAccess: { isTrustedRemoteHost: () => false, isEnabled: () => false } }),
    false,
  );
  assert.equal(
    isMobileRemoteRequest({ socket: { remoteAddress: `::ffff:${PHONE_ADDRESS}` }, headers: {} }, { mobileAccess: { isTrustedRemoteHost: () => false, settings: () => ({ enabled: false }) } }),
    false,
  );
  // DBG-01 anti-spoof: with mobile access on, a tailnet peer is a mobile request whatever Host it sends.
  assert.equal(
    isMobileRemoteRequest(tailnetPeer, { mobileAccess: { isTrustedRemoteHost: () => false, isEnabled: () => true } }),
    true,
  );
  assert.equal(
    isMobileRemoteRequest({ socket: { remoteAddress: `::ffff:${PHONE_ADDRESS}` }, headers: {} }, { mobileAccess: { isTrustedRemoteHost: () => false, settings: () => ({ enabled: true }) } }),
    true,
  );
  // Mobile access on: a non-tailnet source carrying the approved tailnet Host is a mobile request too.
  assert.equal(
    isMobileRemoteRequest({ socket: { remoteAddress: "192.168.50.20" }, headers: {} }, { mobileAccess: { isTrustedRemoteHost: () => true, isEnabled: () => true } }),
    true,
  );
  const lanRequest = { socket: { remoteAddress: "192.168.50.20" }, headers: {} };
  assert.equal(isMobileRemoteRequest(lanRequest, { mobileAccess: null }), false);
  assert.equal(isMobileRemoteRequest(lanRequest, { mobileAccess: { isTrustedRemoteHost: () => false } }), false);

  assert.equal(assertMobileRemoteAuthorized({}, "/index.html", trusting), null);
  assert.throws(
    () => assertMobileRemoteAuthorized({}, "/api/tasks", trusting),
    (error) => error.status === 401 && error.code === "PAIRING_REQUIRED",
  );
  assert.throws(
    () => assertMobileRemoteAuthorized({}, "/api/tasks", null),
    (error) => error.status === 401 && error.code === "PAIRING_REQUIRED",
  );
  const principal = { sessionId: "s" };
  assert.equal(assertMobileRemoteAuthorized({}, "/api/tasks", { authorize: () => principal }), principal);
});

test("W15 review M1: a paired phone creates projects only without a folder and cannot set a folder by any route", async (t) => {
  const picks = [];
  const { app, port } = await startBoard(t, {
    instanceToken: INSTANCE_TOKEN,
    instanceSecret: INSTANCE_SECRET,
    folderPicker: { supported: true, async pick(input) { picks.push(input); return { path: os.tmpdir(), canceled: false }; } },
  });
  const prefix = `/${INSTANCE_TOKEN}`;
  const remoteHost = `${TAILNET_ADDRESS}:${port}`;
  const remoteOrigin = `http://${remoteHost}`;
  assert.equal((await local(port, "/api/local/mobile-access", { method: "PUT", body: { enabled: true }, prefix })).status, 200);
  const challenge = await local(port, "/api/local/pairing/challenges", {
    method: "POST",
    body: { requestKey: "22222222-2222-4222-8222-222222222222", deviceLabel: "Bob phone" },
    prefix,
  });
  await local(port, `/api/local/pairing/challenges/${challenge.body.challengeId}/approve`, { method: "POST", prefix });
  const completed = await remote(app, "/api/pairing/complete", {
    method: "POST",
    headers: { host: remoteHost, origin: remoteOrigin },
    body: { challengeId: challenge.body.challengeId, challengeCode: challenge.body.challengeCode },
  });
  assert.equal(completed.status, 201, completed.text);
  const cookie = String(completed.headers["set-cookie"]).split(";", 1)[0];
  const phone = (pathname, method, body) => remote(app, pathname, {
    method,
    body,
    headers: { host: remoteHost, origin: remoteOrigin, cookie, "x-relay-csrf": completed.body.csrfToken },
  });

  const folder = path.join(os.tmpdir(), "w15-phone-folder");
  await mkdir(folder, { recursive: true });
  t.after(() => rm(folder, { recursive: true, force: true }));
  const withFolder = await phone("/api/projects", "POST", { id: "temp-phone", name: "手機", workspacePath: folder });
  assert.equal(withFolder.status, 403, withFolder.text);
  assert.equal(withFolder.body.error.code, "LOCAL_ONLY");
  const withoutFolder = await phone("/api/projects", "POST", { id: "temp-phone", name: "手機", workspacePath: null });
  assert.equal(withoutFolder.status, 201, withoutFolder.text);

  for (const [method, pathname, body] of [
    ["PATCH", "/api/projects/temp-phone", { workspacePath: folder }],
    ["POST", "/api/local/pick-folder", {}],
    ["PUT", "/api/local/project-mappings/temp-phone", { workspacePath: folder }],
  ]) {
    const result = await phone(pathname, method, body);
    assert.equal(result.status, 403, `${method} ${pathname} ${result.text}`);
  }
  assert.equal(picks.length, 0, "no folder dialog was opened");
  const project = (await local(port, "/api/projects", { prefix })).body.projects.find((candidate) => candidate.id === "temp-phone");
  assert.equal(project.workspacePath, null);
  // The phone's run on that project is refused for the missing folder (it cannot choose one).
  const task = await phone("/api/tasks", "POST", { projectId: "temp-phone", title: "手機卡", status: "todo", assigneeTarget: "claude-agent" });
  assert.equal(task.status, 201, task.text);
  const start = await phone(`/api/tasks/${task.body.task.id}/run/start`, "POST");
  assert.equal(start.status, 409, start.text);
  assert.equal(start.body.error.code, "WORKSPACE_NOT_FOUND");
});
