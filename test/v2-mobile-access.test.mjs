import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  MOBILE_ACCESS_EVENT,
  buildMobileAccessUrl,
  isTailnetIpv4,
  mobileAccessStage,
  parseTailnetAddress,
} from "../shared/mobile-access-contract.mjs";
import { createMobileAccess } from "../server/mobile/index.mjs";
import { createTailnetResolver, resolveTailscaleExecutable, WINDOWS_TAILSCALE_EXECUTABLE } from "../server/mobile/tailnet.mjs";
import { TaskboardDatabase } from "../server/database.mjs";

const PORT = 47833;
const ADDRESS = "100.101.102.103";
const REMOTE_URL = `http://${ADDRESS}:${PORT}/`;
const REMOTE_ORIGIN = `http://${ADDRESS}:${PORT}`;
const LOCAL_HOST = `127.0.0.1:${PORT}`;
const REMOTE_HOST = `${ADDRESS}:${PORT}`;
const PHONE_ADDRESS = "100.70.1.2";

function request(method, url, { body, headers = {}, remoteAddress = "127.0.0.1", socket = true } = {}) {
  const payload = body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
  const stream = Readable.from(payload);
  stream.method = method;
  stream.url = url;
  if (socket) stream.socket = { remoteAddress };
  stream.headers = { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers };
  return stream;
}

function response() {
  return {
    status: null,
    headers: null,
    body: "",
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(chunk) {
      this.body += chunk ?? "";
      this.writableEnded = true;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

function fakeTailscale({ stdout = `${ADDRESS}\n`, error = null } = {}) {
  const state = { stdout, error, calls: [] };
  state.execFile = (file, args, options, callback) => {
    state.calls.push({ file, args, options });
    setImmediate(() => callback(state.error, state.error ? "" : state.stdout, ""));
  };
  return state;
}

function setup(t, { tailscale = fakeTailscale() } = {}) {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "v2-mobile-access-"));
  const db = new DatabaseSync(":memory:");
  const clock = { now: Date.parse("2026-09-17T10:00:00.000Z") };
  const events = [];
  const logs = [];
  const logger = {
    info: (message) => logs.push(["info", message]),
    warn: (message) => logs.push(["warn", message]),
    error: (message) => logs.push(["error", message]),
  };
  const create = () => createMobileAccess({
    database: db,
    dataDirectory,
    port: PORT,
    emitHub: { emit: (type, payload) => events.push({ type, payload }) },
    logger,
    execFile: tailscale.execFile,
    existsSync: () => false,
    pairingServiceOptions: { now: () => clock.now, challengeTtlMs: 300_000, sessionTtlMs: 3_600_000 },
  });
  const access = create();
  t.after(async () => {
    await access.close();
    db.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  async function call(target, method, url, options) {
    const res = response();
    const handled = await target.handle(request(method, url, options), res);
    return { handled, res, status: res.status, body: res.body ? res.json() : null, headers: res.headers };
  }
  return { access, create, db, dataDirectory, clock, events, logs, tailscale, call: (...args) => call(access, ...args), callWith: call };
}

async function enable(env) {
  const result = await env.call("PUT", "/api/local/mobile-access", { headers: { host: LOCAL_HOST }, body: { enabled: true } });
  assert.equal(result.status, 200);
  return result;
}

async function pairPhone(env, deviceLabel = "Alice iPhone") {
  const created = await env.call("POST", "/api/local/pairing/challenges", {
    headers: { host: LOCAL_HOST },
    body: { requestKey: "11111111-1111-4111-8111-111111111111", deviceLabel },
  });
  assert.equal(created.status, 201);
  const approved = await env.call("POST", `/api/local/pairing/challenges/${created.body.challengeId}/approve`, {
    headers: { host: LOCAL_HOST },
  });
  assert.equal(approved.status, 200);
  const completed = await env.call("POST", "/api/pairing/complete", {
    remoteAddress: PHONE_ADDRESS,
    headers: { host: REMOTE_HOST, origin: REMOTE_ORIGIN },
    body: { challengeId: created.body.challengeId, challengeCode: created.body.challengeCode },
  });
  assert.equal(completed.status, 201, JSON.stringify(completed.body));
  const setCookie = completed.headers["set-cookie"];
  const cookie = setCookie.split(";", 1)[0];
  return { created: created.body, completed: completed.body, setCookie, cookie, csrf: completed.body.csrfToken };
}

// ---------------------------------------------------------------- tailnet parse

test("tailnet parse: first 100.x IPv4 line wins, everything else is null", () => {
  assert.equal(parseTailnetAddress(`${ADDRESS}\n`), ADDRESS);
  assert.equal(parseTailnetAddress(`\r\n  ${ADDRESS}  \r\n100.64.0.9\r\n`), ADDRESS);
  assert.equal(parseTailnetAddress("fd7a:115c:a1e0::1\n192.168.50.5\n100.64.0.9\n"), "100.64.0.9");
  assert.equal(parseTailnetAddress(""), null);
  assert.equal(parseTailnetAddress(undefined), null);
  assert.equal(parseTailnetAddress("192.168.50.5\n10.0.0.1"), null);
  assert.equal(parseTailnetAddress("100.300.1.1"), null);
  assert.equal(parseTailnetAddress("100.1.1"), null);
  assert.equal(parseTailnetAddress("100.01.1.1"), null);
  assert.equal(parseTailnetAddress("Tailscale is stopped."), null);
  assert.equal(isTailnetIpv4("100.64.0.1"), true);
  assert.equal(isTailnetIpv4("101.64.0.1"), false);
  assert.equal(buildMobileAccessUrl(ADDRESS, PORT), REMOTE_URL);
  assert.equal(buildMobileAccessUrl(null, PORT), null);
  assert.equal(buildMobileAccessUrl(ADDRESS, 0), null);
  assert.equal(mobileAccessStage({ enabled: false }), "local-only");
  assert.equal(mobileAccessStage({ enabled: true, tailnetAddress: ADDRESS }), "enabled");
  assert.equal(mobileAccessStage({ enabled: false, reason: "TAILSCALE_NOT_FOUND" }), "tailscale-not-found");
});

test("tailnet resolver runs `tailscale ip -4` hidden, without shell, preferring Program Files", async () => {
  const tailscale = fakeTailscale();
  const resolver = createTailnetResolver({ execFile: tailscale.execFile, existsSync: (file) => file === WINDOWS_TAILSCALE_EXECUTABLE });
  assert.equal(resolver.cached(), null);
  assert.equal(await resolver.resolve(), ADDRESS);
  assert.equal(resolver.cached(), ADDRESS);
  assert.equal(tailscale.calls.length, 1);
  assert.equal(tailscale.calls[0].file, "C:\\Program Files\\Tailscale\\tailscale.exe");
  assert.deepEqual(tailscale.calls[0].args, ["ip", "-4"]);
  assert.equal(tailscale.calls[0].options.windowsHide, true);
  assert.equal(tailscale.calls[0].options.shell, false);
  assert.ok(tailscale.calls[0].options.timeout > 0);

  assert.equal(resolveTailscaleExecutable({ existsSync: () => false }), "tailscale");
  assert.equal(resolveTailscaleExecutable({ existsSync: () => { throw new Error("denied"); } }), "tailscale");
  assert.equal(resolveTailscaleExecutable({ executable: "D:\\ts\\tailscale.exe", existsSync: () => true }), "D:\\ts\\tailscale.exe");
});

test("tailnet resolver returns null on missing binary, bad output or sync throw, and dedupes concurrent calls", async () => {
  const missing = fakeTailscale({ error: Object.assign(new Error("spawn tailscale ENOENT"), { code: "ENOENT" }) });
  const warnings = [];
  const resolver = createTailnetResolver({ execFile: missing.execFile, existsSync: () => false, logger: { warn: (m) => warnings.push(m) } });
  assert.equal(await resolver.resolve(), null);
  assert.match(warnings[0], /ENOENT/);

  const stopped = fakeTailscale({ stdout: "Tailscale is stopped.\n" });
  assert.equal(await createTailnetResolver({ execFile: stopped.execFile, existsSync: () => false }).resolve(), null);

  const throwing = createTailnetResolver({ execFile: () => { throw new Error("boom"); }, existsSync: () => false });
  assert.equal(await throwing.resolve(), null);

  const shared = fakeTailscale();
  const deduped = createTailnetResolver({ execFile: shared.execFile, existsSync: () => false });
  const [first, second] = await Promise.all([deduped.resolve(), deduped.resolve()]);
  assert.equal(first, ADDRESS);
  assert.equal(second, ADDRESS);
  assert.equal(shared.calls.length, 1);
});

// ---------------------------------------------------------------- settings

test("settings: enable persists url to <dataDirectory>/mobile-access.json and survives a restart", async (t) => {
  const env = setup(t);
  assert.deepEqual(env.access.settings(), { enabled: false, url: null });

  const initial = await env.call("GET", "/api/local/mobile-access", { headers: { host: LOCAL_HOST } });
  assert.equal(initial.handled, true);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.enabled, false);
  assert.equal(initial.body.url, null);
  assert.equal(initial.body.tailnetAddress, ADDRESS);
  assert.equal("reason" in initial.body, false);
  assert.equal(initial.headers["cache-control"], "private, no-store");

  const enabled = await enable(env);
  assert.deepEqual(
    { enabled: enabled.body.enabled, url: enabled.body.url, tailnetAddress: enabled.body.tailnetAddress },
    { enabled: true, url: REMOTE_URL, tailnetAddress: ADDRESS },
  );
  assert.equal(enabled.body.pairing, "unpaired");
  assert.deepEqual(enabled.body.sessions, []);
  assert.deepEqual(enabled.body.pendingChallenges, []);
  assert.deepEqual(env.access.settings(), { enabled: true, url: REMOTE_URL });
  const file = JSON.parse(readFileSync(path.join(env.dataDirectory, "mobile-access.json"), "utf8"));
  assert.deepEqual(file, { version: 1, enabled: true, url: REMOTE_URL });
  assert.ok(env.events.some((event) => event.type === MOBILE_ACCESS_EVENT));

  const restarted = env.create();
  assert.deepEqual(restarted.settings(), { enabled: true, url: REMOTE_URL });
  await restarted.close();

  const disabled = await env.call("PUT", "/api/local/mobile-access", { headers: { host: LOCAL_HOST }, body: { enabled: false } });
  assert.equal(disabled.body.enabled, false);
  assert.equal(disabled.body.url, null);
  assert.deepEqual(env.create().settings(), { enabled: false, url: null });
});

test("settings: enabling without Tailscale keeps mobile access off and reports TAILSCALE_NOT_FOUND", async (t) => {
  const tailscale = fakeTailscale({ error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) });
  const env = setup(t, { tailscale });
  const result = await env.call("PUT", "/api/local/mobile-access", { headers: { host: LOCAL_HOST }, body: { enabled: true } });
  assert.equal(result.status, 200);
  assert.equal(result.body.enabled, false);
  assert.equal(result.body.url, null);
  assert.equal(result.body.tailnetAddress, null);
  assert.equal(result.body.reason, "TAILSCALE_NOT_FOUND");
  assert.equal(mobileAccessStage(result.body), "tailscale-not-found");
  assert.deepEqual(env.access.settings(), { enabled: false, url: null });
  assert.equal(await env.access.tailnetAddress(), null);
  // one exec for the PUT, one for the explicit tailnetAddress() call
  assert.equal(tailscale.calls.length, 2);
});

test("settings: tailnet address change rewrites the persisted url; damaged file fails closed", async (t) => {
  const env = setup(t);
  await enable(env);
  env.tailscale.stdout = "100.64.0.77\n";
  assert.equal(await env.access.tailnetAddress(), "100.64.0.77");
  assert.deepEqual(env.access.settings(), { enabled: true, url: `http://100.64.0.77:${PORT}/` });

  writeFileSync(path.join(env.dataDirectory, "mobile-access.json"), "{ not json", "utf8");
  const damaged = env.create();
  assert.deepEqual(damaged.settings(), { enabled: false, url: null });
  assert.ok(env.logs.some(([level, message]) => level === "warn" && /invalid/.test(message)));
  await damaged.close();

  writeFileSync(path.join(env.dataDirectory, "mobile-access.json"), JSON.stringify({ version: 1, enabled: true, url: "https://x.example/", extra: 1 }), "utf8");
  assert.deepEqual(env.create().settings(), { enabled: false, url: null });
});

test("settings routes are loopback-only and validate input", async (t) => {
  const env = setup(t);
  const remote = await env.call("PUT", "/api/local/mobile-access", {
    remoteAddress: PHONE_ADDRESS, headers: { host: REMOTE_HOST }, body: { enabled: true },
  });
  assert.equal(remote.handled, true);
  assert.equal(remote.status, 403);
  assert.equal(remote.body.error.code, "LOCAL_ONLY");
  assert.deepEqual(env.access.settings(), { enabled: false, url: null });

  const rebinding = await env.call("GET", "/api/local/mobile-access", { headers: { host: "evil.example" } });
  assert.equal(rebinding.status, 403);
  assert.equal(rebinding.body.error.code, "LOCAL_ONLY");

  const ipv6 = await env.call("GET", "/api/local/mobile-access", { remoteAddress: "::1", headers: { host: `[::1]:${PORT}` } });
  assert.equal(ipv6.status, 200);
  const mapped = await env.call("GET", "/api/local/mobile-access", { remoteAddress: "::ffff:127.0.0.1", headers: { host: `localhost:${PORT}` } });
  assert.equal(mapped.status, 200);

  const badBody = await env.call("PUT", "/api/local/mobile-access", { headers: { host: LOCAL_HOST }, body: { enabled: "yes" } });
  assert.equal(badBody.status, 400);
  assert.equal(badBody.body.error.code, "INVALID_BODY");

  const extra = await env.call("PUT", "/api/local/mobile-access", { headers: { host: LOCAL_HOST }, body: { enabled: true, url: "x" } });
  assert.equal(extra.status, 400);

  const wrongMethod = await env.call("POST", "/api/local/mobile-access", { headers: { host: LOCAL_HOST } });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, "GET, PUT");
});

// ---------------------------------------------------------------- pairing flow

test("pairing: challenge → approve → complete → authorize, then revoke", async (t) => {
  const env = setup(t);
  await enable(env);
  const created = await env.call("POST", "/api/local/pairing/challenges", {
    headers: { host: LOCAL_HOST },
    body: { requestKey: "22222222-2222-4222-8222-222222222222", deviceLabel: "Phone A" },
  });
  assert.equal(created.status, 201);
  assert.equal(typeof created.body.challengeCode, "string");

  const pending = await env.call("GET", "/api/local/mobile-access", { headers: { host: LOCAL_HOST } });
  assert.equal(pending.body.pairing, "pending");
  assert.equal(pending.body.pendingChallenges.length, 1);
  assert.equal(pending.body.pendingChallenges[0].challengeId, created.body.challengeId);
  assert.equal(pending.body.pendingChallenges[0].approved, false);
  assert.equal(JSON.stringify(pending.body).includes(created.body.challengeCode), false);

  const tooEarly = await env.call("POST", "/api/pairing/complete", {
    remoteAddress: PHONE_ADDRESS,
    headers: { host: REMOTE_HOST, origin: REMOTE_ORIGIN },
    body: { challengeId: created.body.challengeId, challengeCode: created.body.challengeCode },
  });
  assert.equal(tooEarly.status, 409);
  assert.equal(tooEarly.body.error.code, "PAIRING_APPROVAL_REQUIRED");

  const approved = await env.call("POST", `/api/local/pairing/challenges/${created.body.challengeId}/approve`, { headers: { host: LOCAL_HOST } });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.challengeId, created.body.challengeId);

  const completed = await env.call("POST", "/api/pairing/complete", {
    remoteAddress: PHONE_ADDRESS,
    headers: { host: REMOTE_HOST, origin: REMOTE_ORIGIN },
    body: { challengeId: created.body.challengeId, challengeCode: created.body.challengeCode },
  });
  assert.equal(completed.status, 201);
  const setCookie = completed.headers["set-cookie"];
  assert.match(setCookie, /^relay_session=[A-Za-z0-9_-]+; Max-Age=3600; Path=\/; HttpOnly; SameSite=Strict$/);
  assert.equal(/Secure/.test(setCookie), false, "http tailnet origin cannot use Secure cookies");
  const cookie = setCookie.split(";", 1)[0];
  const csrf = completed.body.csrfToken;
  const sessionId = completed.body.session.id;
  assert.equal(completed.body.session.deviceLabel, "Phone A");

  const row = env.db.prepare("SELECT token_hash, csrf_hash FROM paired_sessions WHERE id=?").get(sessionId);
  assert.notEqual(row.token_hash, cookie.split("=")[1]);
  assert.notEqual(row.csrf_hash, csrf);

  const read = env.access.authorize(request("GET", "/api/projects", {
    remoteAddress: PHONE_ADDRESS, headers: { host: REMOTE_HOST, cookie },
  }));
  assert.ok(read);
  assert.equal(read.sessionId, sessionId);
  assert.equal(read.principalType, "human");
  assert.equal(read.principalId, `paired-session:${sessionId}`);
  assert.equal(read.deviceLabel, "Phone A");

  const write = env.access.authorize(request("POST", "/api/tasks", {
    remoteAddress: PHONE_ADDRESS, headers: { host: REMOTE_HOST, origin: REMOTE_ORIGIN, cookie, "x-relay-csrf": csrf },
  }));
  assert.equal(write?.sessionId, sessionId);

  const paired = await env.call("GET", "/api/local/mobile-access", { headers: { host: LOCAL_HOST } });
  assert.equal(paired.body.pairing, "paired");
  assert.equal(paired.body.sessions.length, 1);
  assert.equal(paired.body.sessions[0].id, sessionId);
  assert.deepEqual(paired.body.pendingChallenges, []);

  const own = await env.call("GET", `/api/sessions/${sessionId}`, { remoteAddress: PHONE_ADDRESS, headers: { host: REMOTE_HOST, cookie } });
  assert.equal(own.status, 200);
  assert.equal(own.body.session.id, sessionId);
  assert.equal(own.body.session.revokedAt, null);

  const other = await env.call("GET", "/api/sessions/someone-else", { remoteAddress: PHONE_ADDRESS, headers: { host: REMOTE_HOST, cookie } });
  assert.equal(other.status, 403);
  assert.equal(other.body.error.code, "FORBIDDEN");

  const replay = await env.call("POST", "/api/pairing/complete", {
    remoteAddress: PHONE_ADDRESS,
    headers: { host: REMOTE_HOST, origin: REMOTE_ORIGIN },
    body: { challengeId: created.body.challengeId, challengeCode: created.body.challengeCode },
  });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error.code, "PAIRING_CHALLENGE_INVALID");

  const eventsBeforeRevoke = env.events.length;
  const revoked = await env.call("DELETE", `/api/sessions/${sessionId}`, {
    remoteAddress: PHONE_ADDRESS, headers: { host: REMOTE_HOST, origin: REMOTE_ORIGIN, cookie, "x-relay-csrf": csrf },
  });
  assert.equal(revoked.status, 200);
  assert.deepEqual(revoked.body, { sessionId, revoked: true });
  assert.match(revoked.headers["set-cookie"], /^relay_session=; Max-Age=0;/);
  assert.equal(env.events.length, eventsBeforeRevoke + 1);

  assert.equal(env.access.authorize(request("GET", "/api/projects", {
    remoteAddress: PHONE_ADDRESS, headers: { host: REMOTE_HOST, cookie },
  })), null);
});

test("pairing: desktop can list and revoke any session locally", async (t) => {
  const env = setup(t);
  await enable(env);
  const phone = await pairPhone(env);
  const sessionId = phone.completed.session.id;
  const local = await env.call("GET", `/api/sessions/${sessionId}`, { headers: { host: LOCAL_HOST } });
  assert.equal(local.status, 200);
  const revoked = await env.call("DELETE", `/api/sessions/${sessionId}`, { headers: { host: LOCAL_HOST } });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.headers["set-cookie"], undefined);
  assert.equal(env.access.authorize(request("GET", "/api/projects", {
    remoteAddress: PHONE_ADDRESS, headers: { host: REMOTE_HOST, cookie: phone.cookie },
  })), null);
  const missing = await env.call("DELETE", "/api/sessions/does-not-exist", { headers: { host: LOCAL_HOST } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "SESSION_NOT_FOUND");
});

// ---------------------------------------------------------------- remote unauthorized

test("remote unauthorized: authorize returns null without a valid paired session", async (t) => {
  const env = setup(t);
  await enable(env);
  const phone = await pairPhone(env);
  const remote = (method, headers) => request(method, "/api/tasks", { remoteAddress: PHONE_ADDRESS, headers });

  assert.equal(env.access.authorize(remote("GET", { host: REMOTE_HOST })), null, "no cookie");
  assert.equal(env.access.authorize(remote("GET", { host: REMOTE_HOST, cookie: "relay_session=forged" })), null, "forged cookie");
  assert.equal(env.access.authorize(remote("GET", { host: "evil.example", cookie: phone.cookie })), null, "wrong host");
  assert.equal(env.access.authorize(remote("GET", { host: REMOTE_HOST, origin: "http://evil.example", cookie: phone.cookie })), null, "wrong origin");
  assert.equal(env.access.authorize(remote("POST", { host: REMOTE_HOST, origin: REMOTE_ORIGIN, cookie: phone.cookie })), null, "write without csrf");
  assert.equal(env.access.authorize(remote("POST", { host: REMOTE_HOST, cookie: phone.cookie, "x-relay-csrf": phone.csrf })), null, "write without origin");
  assert.equal(env.access.authorize(remote("POST", { host: REMOTE_HOST, origin: REMOTE_ORIGIN, cookie: phone.cookie, "x-relay-csrf": "nope" })), null, "bad csrf");
  assert.equal(env.access.authorize(request("GET", "/api/tasks", { headers: { host: LOCAL_HOST, cookie: phone.cookie } })), null, "loopback host is not the remote origin");
  assert.ok(env.access.authorize(remote("GET", { host: REMOTE_HOST, cookie: phone.cookie })), "control: valid session");

  env.clock.now += 3_600_001;
  assert.equal(env.access.authorize(remote("GET", { host: REMOTE_HOST, cookie: phone.cookie })), null, "expired session");
});

test("remote unauthorized: disabled mobile access rejects everything remote, even valid sessions", async (t) => {
  const env = setup(t);
  await enable(env);
  const phone = await pairPhone(env);
  await env.call("PUT", "/api/local/mobile-access", { headers: { host: LOCAL_HOST }, body: { enabled: false } });

  assert.equal(env.access.authorize(request("GET", "/api/tasks", {
    remoteAddress: PHONE_ADDRESS, headers: { host: REMOTE_HOST, cookie: phone.cookie },
  })), null);
  const complete = await env.call("POST", "/api/pairing/complete", {
    remoteAddress: PHONE_ADDRESS, headers: { host: REMOTE_HOST, origin: REMOTE_ORIGIN }, body: { challengeId: "x", challengeCode: "y" },
  });
  assert.equal(complete.status, 403);
  assert.equal(complete.body.error.code, "MOBILE_ACCESS_DISABLED");
  const session = await env.call("GET", `/api/sessions/${phone.completed.session.id}`, {
    remoteAddress: PHONE_ADDRESS, headers: { host: REMOTE_HOST, cookie: phone.cookie },
  });
  assert.equal(session.status, 403);
  assert.equal(session.body.error.code, "MOBILE_ACCESS_DISABLED");
});

test("remote unauthorized: local pairing routes reject remote callers; completion rejects local hosts", async (t) => {
  const env = setup(t);
  await enable(env);
  const remoteChallenge = await env.call("POST", "/api/local/pairing/challenges", {
    remoteAddress: PHONE_ADDRESS, headers: { host: REMOTE_HOST }, body: { requestKey: "33333333-3333-4333-8333-333333333333", deviceLabel: "x" },
  });
  assert.equal(remoteChallenge.status, 403);
  assert.equal(remoteChallenge.body.error.code, "LOCAL_ONLY");

  const remoteApprove = await env.call("POST", "/api/local/pairing/challenges/abc/approve", {
    remoteAddress: PHONE_ADDRESS, headers: { host: LOCAL_HOST },
  });
  assert.equal(remoteApprove.status, 403);
  assert.equal(remoteApprove.body.error.code, "LOCAL_ONLY");

  const created = await env.call("POST", "/api/local/pairing/challenges", {
    headers: { host: LOCAL_HOST }, body: { requestKey: "44444444-4444-4444-8444-444444444444", deviceLabel: "x" },
  });
  await env.call("POST", `/api/local/pairing/challenges/${created.body.challengeId}/approve`, { headers: { host: LOCAL_HOST } });
  const fromLoopback = await env.call("POST", "/api/pairing/complete", {
    headers: { host: LOCAL_HOST, origin: `http://${LOCAL_HOST}` },
    body: { challengeId: created.body.challengeId, challengeCode: created.body.challengeCode },
  });
  assert.equal(fromLoopback.status, 403);
  assert.equal(fromLoopback.body.error.code, "INVALID_HOST");

  const noOrigin = await env.call("POST", "/api/pairing/complete", {
    remoteAddress: PHONE_ADDRESS, headers: { host: REMOTE_HOST },
    body: { challengeId: created.body.challengeId, challengeCode: created.body.challengeCode },
  });
  assert.equal(noOrigin.status, 403);
  assert.equal(noOrigin.body.error.code, "INVALID_ORIGIN");

  const wrongCode = await env.call("POST", "/api/pairing/complete", {
    remoteAddress: PHONE_ADDRESS, headers: { host: REMOTE_HOST, origin: REMOTE_ORIGIN },
    body: { challengeId: created.body.challengeId, challengeCode: "wrong" },
  });
  assert.equal(wrongCode.status, 401);
  assert.equal(wrongCode.body.error.code, "PAIRING_CHALLENGE_INVALID");
});

test("Amendment 10 over HTTP: 6-digit fallback, wrong-code lockout, desktop revoke (loopback only)", async (t) => {
  const env = setup(t);
  await enable(env);
  const phone = { remoteAddress: PHONE_ADDRESS, headers: { host: REMOTE_HOST, origin: REMOTE_ORIGIN } };
  const createApproved = async (requestKey, deviceLabel) => {
    const created = await env.call("POST", "/api/local/pairing/challenges", { headers: { host: LOCAL_HOST }, body: { requestKey, deviceLabel } });
    assert.equal(created.status, 201);
    assert.match(created.body.shortCode, /^[0-9]{6}$/);
    const approved = await env.call("POST", `/api/local/pairing/challenges/${created.body.challengeId}/approve`, { headers: { host: LOCAL_HOST } });
    assert.equal(approved.status, 200);
    return created.body;
  };

  const first = await createApproved("55555555-5555-4555-8555-555555555555", "Numeric phone");
  const inspection = await env.call("GET", "/api/local/mobile-access", { headers: { host: LOCAL_HOST } });
  assert.equal(JSON.stringify(inspection.body).includes(first.shortCode), false, "the inspection never exposes the 6-digit code");
  const wrong = first.shortCode === "000000" ? "000001" : "000000";
  const bad = await env.call("POST", "/api/pairing/complete", { ...phone, body: { shortCode: wrong } });
  assert.equal(bad.status, 401);
  const numeric = await env.call("POST", "/api/pairing/complete", { ...phone, body: { shortCode: first.shortCode } });
  assert.equal(numeric.status, 201, JSON.stringify(numeric.body));
  assert.match(numeric.headers["set-cookie"], /^relay_session=[A-Za-z0-9_-]+; Max-Age=3600; Path=\/; HttpOnly; SameSite=Strict$/);
  assert.equal(typeof numeric.body.csrfToken, "string");
  assert.equal(numeric.body.session.deviceLabel, "Numeric phone");
  const reused = await env.call("POST", "/api/pairing/complete", { ...phone, body: { shortCode: first.shortCode } });
  assert.equal(reused.status, 401);

  const noOrigin = await env.call("POST", "/api/pairing/complete", {
    remoteAddress: PHONE_ADDRESS, headers: { host: REMOTE_HOST }, body: { shortCode: "123456" },
  });
  assert.equal(noOrigin.status, 403, "the 6-digit path keeps the Host/Origin boundary");

  const locked = await createApproved("66666666-6666-4666-8666-666666666666", "Locked phone");
  const wrong2 = locked.shortCode === "999999" ? "999998" : "999999";
  for (let i = 0; i < 5; i += 1) {
    const attempt = await env.call("POST", "/api/pairing/complete", { ...phone, body: { shortCode: wrong2 } });
    assert.equal(attempt.status, 401);
  }
  const afterLock = await env.call("POST", "/api/pairing/complete", { ...phone, body: { shortCode: locked.shortCode } });
  assert.equal(afterLock.status, 429);
  assert.equal(afterLock.body.error.code, "PAIRING_ATTEMPTS_EXCEEDED");

  const revokable = await createApproved("77777777-7777-4777-8777-777777777777", "Revoked phone");
  const remoteRevoke = await env.call("DELETE", `/api/local/pairing/challenges/${revokable.challengeId}`, { remoteAddress: PHONE_ADDRESS, headers: { host: LOCAL_HOST } });
  assert.equal(remoteRevoke.status, 403);
  assert.equal(remoteRevoke.body.error.code, "LOCAL_ONLY");
  const wrongMethod = await env.call("POST", `/api/local/pairing/challenges/${revokable.challengeId}`, { headers: { host: LOCAL_HOST } });
  assert.equal(wrongMethod.status, 405);
  const eventsBefore = env.events.length;
  const revoked = await env.call("DELETE", `/api/local/pairing/challenges/${revokable.challengeId}`, { headers: { host: LOCAL_HOST } });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.revoked, true);
  assert.equal(env.events.length, eventsBefore + 1, "revoke emits a mobile-access change");
  const viaQr = await env.call("POST", "/api/pairing/complete", { ...phone, body: { challengeId: revokable.challengeId, challengeCode: revokable.challengeCode } });
  assert.equal(viaQr.status, 401);
  const viaDigits = await env.call("POST", "/api/pairing/complete", { ...phone, body: { shortCode: revokable.shortCode } });
  assert.notEqual(viaDigits.status, 201);
  const unknownField = await env.call("POST", "/api/pairing/complete", { ...phone, body: { shortCode: "123456", extra: 1 } });
  assert.equal(unknownField.status, 400);
});

test("isRemoteRequest, route ownership and close()", async (t) => {
  const env = setup(t);
  const at = (remoteAddress, socket = true) => request("GET", "/api/tasks", { remoteAddress, socket, headers: { host: LOCAL_HOST } });
  assert.equal(env.access.isRemoteRequest(at("127.0.0.1")), false);
  assert.equal(env.access.isRemoteRequest(at("::1")), false);
  assert.equal(env.access.isRemoteRequest(at("::ffff:127.0.0.1")), false);
  assert.equal(env.access.isRemoteRequest(at(PHONE_ADDRESS)), true);
  assert.equal(env.access.isRemoteRequest(at("192.168.50.20")), true);
  assert.equal(env.access.isRemoteRequest(at(undefined, false)), true, "missing socket fails closed");

  for (const [method, url] of [["GET", "/api/tasks"], ["GET", "/"], ["GET", "/assets/app.js"], ["GET", "/api/events"], ["POST", "/api/local/ai/threads"]]) {
    const result = await env.call(method, url, { headers: { host: LOCAL_HOST } });
    assert.equal(result.handled, false, `${method} ${url} is not a mobile route`);
    assert.equal(result.status, null);
  }

  await enable(env);
  assert.equal(env.access.isTrustedRemoteHost(request("GET", "/", { remoteAddress: PHONE_ADDRESS, headers: { host: REMOTE_HOST } })), true);
  assert.equal(env.access.isTrustedRemoteHost(request("GET", "/", { remoteAddress: PHONE_ADDRESS, headers: { host: "evil.example" } })), false);

  const phone = await pairPhone(env);
  await env.access.close();
  assert.equal(env.access.authorize(request("GET", "/api/tasks", { remoteAddress: PHONE_ADDRESS, headers: { host: REMOTE_HOST, cookie: phone.cookie } })), null);
  const afterClose = await env.call("GET", "/api/local/mobile-access", { headers: { host: LOCAL_HOST } });
  assert.equal(afterClose.handled, false);
});

test("createMobileAccess uses TaskboardDatabase's public DatabaseSync handle", async (t) => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "v2-mobile-db-"));
  const database = new TaskboardDatabase(path.join(dataDirectory, "taskboard.sqlite"));
  const tailscale = fakeTailscale();
  const access = createMobileAccess({ database, dataDirectory, port: PORT, execFile: tailscale.execFile, existsSync: () => false });
  t.after(async () => {
    await access.close();
    database.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  const tables = database.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('pairing_challenges','paired_sessions','schema_migrations') ORDER BY name").all();
  assert.deepEqual(tables.map((row) => row.name), ["paired_sessions", "pairing_challenges", "schema_migrations"]);
  // idempotent on a second construction against the same database
  const again = createMobileAccess({ database, dataDirectory, port: PORT, execFile: tailscale.execFile, existsSync: () => false });
  await again.close();
  assert.throws(() => createMobileAccess({ database: {}, dataDirectory, port: PORT }), TypeError);
  assert.throws(() => createMobileAccess({ database, dataDirectory, port: "47833" }), TypeError);
});
