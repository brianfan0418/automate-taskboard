// DBG-05 regression: an /api/events stream opened by a paired phone is bound to its session and is
// destroyed on revoke (desktop or the phone itself), on expiry, and when mobile access is turned off.
// Real createTaskboardServer, EventHub, pairing service/routes, SQLite and TCP streaming. Fakes:
// tailscale execFile, run providers, the pairing clock, and the phone's socket address (a request
// whose Host is the tailnet origin is given a 100.x remoteAddress by a prepended listener).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer, EventHub } from "../server/app.mjs";

const TAILNET_ADDRESS = "100.64.0.9";
const PHONE_ADDRESS = "100.70.1.2";
const quiet = { info() {}, warn() {}, error() {}, log() {} };

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

async function boot(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-dbg05-"));
  const staticDirectory = path.join(directory, "web");
  await mkdir(staticDirectory, { recursive: true });
  await writeFile(path.join(staticDirectory, "index.html"), "<!doctype html><title>Taskboard</title>");
  const clock = { now: Date.now() };
  const app = createTaskboardServer({
    dataDirectory: directory,
    staticDirectory,
    runProviders: { claude: fakeProvider("claude"), codex: fakeProvider("codex") },
    enableScheduler: false,
    runLogger: quiet,
    mobileAccessOptions: {
      execFile: (file, args, options, callback) => callback(null, `${TAILNET_ADDRESS}\n`, ""),
      logger: quiet,
      pairingServiceOptions: { now: () => clock.now, sessionTtlMs: 60 * 60 * 1000 },
    },
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  await app.whenStarted();
  const port = address.port;
  const remoteHost = `${TAILNET_ADDRESS}:${port}`;
  app.server.prependListener("request", (request) => {
    if (request.headers.host === remoteHost) {
      Object.defineProperty(request.socket, "remoteAddress", { value: PHONE_ADDRESS, configurable: true });
    }
  });
  const streams = [];
  t.after(async () => {
    for (const stream of streams) stream.req.destroy();
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const call = ({ method = "GET", pathname, headers = {}, body }) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = http.request({
      host: "127.0.0.1",
      port,
      method,
      path: pathname,
      agent: false,
      headers: { ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}), ...headers },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        let json;
        try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
        resolve({ status: response.statusCode, headers: response.headers, body: json, text });
      });
    });
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
  const local = (options) => call({ ...options, headers: { host: `127.0.0.1:${port}`, ...(options.headers ?? {}) } });
  const openStream = (headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path: "/api/events", agent: false, headers }, (res) => {
      const stream = { status: res.statusCode, text: "", closed: false, req, res };
      res.setEncoding("utf8");
      res.on("data", (chunk) => { stream.text += chunk; });
      res.on("close", () => { stream.closed = true; });
      res.on("error", () => { stream.closed = true; });
      streams.push(stream);
      resolve(stream);
    });
    req.on("error", (error) => (streams.length ? undefined : reject(error)));
    req.end();
  });
  let pairingCount = 0;
  const pair = async (label) => {
    pairingCount += 1;
    const requestKey = `${String(pairingCount).padStart(8, "0")}-1111-4111-8111-111111111111`;
    const challenge = await local({ method: "POST", pathname: "/api/local/pairing/challenges", body: { requestKey, deviceLabel: label } });
    assert.equal(challenge.status, 201, challenge.text);
    const approved = await local({ method: "POST", pathname: `/api/local/pairing/challenges/${challenge.body.challengeId}/approve` });
    assert.equal(approved.status, 200, approved.text);
    const completed = await call({
      method: "POST",
      pathname: "/api/pairing/complete",
      headers: { host: remoteHost, origin: `http://${remoteHost}` },
      body: { challengeId: challenge.body.challengeId, challengeCode: challenge.body.challengeCode },
    });
    assert.equal(completed.status, 201, completed.text);
    return {
      sessionId: completed.body.session.id,
      cookie: String(completed.headers["set-cookie"]).split(";", 1)[0],
      csrf: completed.body.csrfToken,
    };
  };

  const enabled = await local({ method: "PUT", pathname: "/api/local/mobile-access", body: { enabled: true } });
  assert.equal(enabled.status, 200, enabled.text);
  await app.syncMobileListener();
  assert.equal((await local({ method: "POST", pathname: "/api/projects", body: { id: "work", name: "work", workspacePath: os.tmpdir() } })).status, 201);
  const task = await local({ method: "POST", pathname: "/api/tasks", body: { projectId: "work", title: "board card" } });
  assert.equal(task.status, 201, task.text);
  const comment = (body) => local({ method: "POST", pathname: `/api/tasks/${task.body.task.id}/comments`, body: { body } });

  return { app, clock, call, local, openStream, pair, comment, remoteHost };
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

async function pairedStream(env, label) {
  const phone = await env.pair(label);
  const stream = await env.openStream({ host: env.remoteHost, cookie: phone.cookie });
  assert.equal(stream.status, 200);
  const marker = `BEFORE_${label.replace(/\W/g, "_")}`;
  assert.equal((await env.comment(marker)).status, 201);
  await settle();
  assert.equal(stream.text.includes(marker), true, "control: the paired stream receives events");
  return { phone, stream };
}

test("DBG-05: desktop revoke destroys the phone's already-open event stream; other phones keep theirs", async (t) => {
  const env = await boot(t);
  const { phone, stream } = await pairedStream(env, "Lost iPhone");
  const other = await pairedStream(env, "Other phone");
  const localStream = await env.openStream({ host: "127.0.0.1" });
  assert.equal(localStream.status, 200);

  const revoked = await env.local({ method: "DELETE", pathname: `/api/sessions/${phone.sessionId}` });
  assert.equal(revoked.status, 200, revoked.text);
  assert.equal((await env.comment("AFTER_REVOCATION_MARKER")).status, 201);
  await settle();

  assert.equal(stream.closed, true, "revoked stream is closed");
  assert.equal(stream.text.includes("AFTER_REVOCATION_MARKER"), false);
  assert.equal(other.stream.closed, false);
  assert.equal(other.stream.text.includes("AFTER_REVOCATION_MARKER"), true);
  assert.equal(localStream.closed, false);
  assert.equal(localStream.text.includes("AFTER_REVOCATION_MARKER"), true);
  const again = await env.call({ pathname: "/api/events", headers: { host: env.remoteHost, cookie: phone.cookie } });
  assert.equal(again.status, 401);
});

test("DBG-05: a phone revoking its own session loses its open stream", async (t) => {
  const env = await boot(t);
  const { phone, stream } = await pairedStream(env, "Phone B");
  const selfRevoke = await env.call({
    method: "DELETE",
    pathname: `/api/sessions/${phone.sessionId}`,
    headers: { host: env.remoteHost, origin: `http://${env.remoteHost}`, cookie: phone.cookie, "x-relay-csrf": phone.csrf },
  });
  assert.equal(selfRevoke.status, 200, selfRevoke.text);
  await env.comment("AFTER_SELF_REVOKE_MARKER");
  await settle();
  assert.equal(stream.closed, true);
  assert.equal(stream.text.includes("AFTER_SELF_REVOKE_MARKER"), false);
});

test("DBG-05: an expired session's open stream receives nothing more", async (t) => {
  const env = await boot(t);
  const { stream } = await pairedStream(env, "Phone C");
  env.clock.now += 2 * 60 * 60 * 1000; // TTL is 1 hour
  await env.comment("AFTER_EXPIRY_MARKER");
  await settle();
  assert.equal(stream.closed, true);
  assert.equal(stream.text.includes("AFTER_EXPIRY_MARKER"), false);
});

test("DBG-05: turning mobile access off destroys paired streams on the main listener", async (t) => {
  const env = await boot(t);
  const { stream } = await pairedStream(env, "Phone D");
  const off = await env.local({ method: "PUT", pathname: "/api/local/mobile-access", body: { enabled: false } });
  assert.equal(off.status, 200, off.text);
  await env.comment("AFTER_DISABLE_MARKER");
  await settle();
  assert.equal(stream.closed, true);
  assert.equal(stream.text.includes("AFTER_DISABLE_MARKER"), false);
});

test("DBG-05 unit: EventHub re-validates session-bound streams on keep-alive and emit", () => {
  const active = new Set(["s1"]);
  const hub = new EventHub({ isSessionActive: (sessionId) => active.has(sessionId) });
  t_cleanup(hub);
  const fakeStream = () => {
    const request = { once() {} };
    const response = {
      text: "",
      destroyed: false,
      writeHead() {},
      write(chunk) { this.text += chunk; return true; },
      end() {},
      destroy() { this.destroyed = true; },
    };
    return { request, response };
  };
  const phone = fakeStream();
  const lan = fakeStream();
  hub.connect(phone.request, phone.response, { sessionId: "s1" });
  hub.connect(lan.request, lan.response);
  hub.emit("task.updated", { task: { id: "t", projectId: "p" } });
  assert.match(phone.response.text, /task\.updated/);
  active.delete("s1");
  hub.write(": keep-alive\n\n");
  assert.equal(phone.response.destroyed, true);
  assert.equal(phone.response.text.includes("keep-alive"), false);
  assert.equal(lan.response.text.includes("keep-alive"), true);
  assert.equal(hub.clients.size, 1);

  // A session-bound stream without a validator is never written to.
  const strict = new EventHub();
  t_cleanup(strict);
  const orphan = fakeStream();
  strict.connect(orphan.request, orphan.response, { sessionId: "s2" });
  strict.emit("task.updated", { task: { id: "t" } });
  assert.equal(orphan.response.destroyed, true);
  assert.equal(orphan.response.text.includes("task.updated"), false);
});

function t_cleanup(hub) {
  clearInterval(hub.keepAlive);
}
