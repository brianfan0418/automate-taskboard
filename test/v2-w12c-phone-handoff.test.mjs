// W12-C (CONTRACTS Amendment 13): home-screen handoff token, 「已加到主畫面」 report, permanent paired session,
// Tailscale status for the desktop wizard and the web manifest start_url.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { createTaskboardServer, manifestWithHandoff } from "../server/app.mjs";
import {
  MOBILE_PAIRING_HANDOFF_CHECKSUM,
  MOBILE_PAIRING_HANDOFF_MIGRATION,
  assertMobilePairingSchema,
  migrateMobilePairingSchema,
} from "../server/mobile/pairing-schema.mjs";
import { MAX_SESSION_COOKIE_AGE_SECONDS, MobilePairingService, deriveCsrfToken } from "../server/mobile/pairing-service.mjs";
import { createTailnetResolver } from "../server/mobile/tailnet.mjs";
import { parseTailscaleStatus } from "../shared/mobile-access-contract.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const KEY_A = "11111111-1111-4111-8111-111111111111";
const KEY_B = "22222222-2222-4222-8222-222222222222";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function setup(options = {}) {
  const db = new DatabaseSync(":memory:");
  migrateMobilePairingSchema(db);
  const clock = { now: Date.parse("2026-09-17T10:00:00.000Z") };
  let id = 0;
  const service = new MobilePairingService(db, { now: () => clock.now, randomId: () => `id-${++id}`, ...options });
  return { db, clock, service };
}

function pair(service, key = KEY_A, label = "iPhone") {
  const challenge = service.createChallenge({ requestKey: key, deviceLabel: label });
  service.approveChallenge(challenge.challengeId);
  return { challenge, done: service.completePairing({ challengeId: challenge.challengeId, challengeCode: challenge.challengeCode }) };
}

test("permanent pairing: no server-side expiry, 400-day cookie, revocation still ends it at once", () => {
  assert.equal(MAX_SESSION_COOKIE_AGE_SECONDS, 34_560_000, "RFC 6265bis / Chrome 104+ cap: 400 days");
  const env = setup();
  const { done } = pair(env.service);
  assert.equal(done.maxAgeSeconds, 34_560_000);
  assert.equal(done.session.expiresAt, null);
  assert.equal(env.db.prepare("SELECT expires_at FROM paired_sessions WHERE id=?").get(done.session.id).expires_at, "never");
  env.clock.now += 5 * 365 * DAY_MS;
  assert.equal(env.service.authenticate({ sessionToken: done.sessionToken }).sessionId, done.session.id);
  assert.equal(env.service.isSessionActive(done.session.id), true);
  assert.equal(env.service.pairingState(), "paired");
  assert.equal(env.service.getSession(done.session.id).expiresAt, null);
  assert.equal(env.service.sessionRenewal(done.sessionToken).maxAgeSeconds, 34_560_000);
  env.service.revokeSession(done.session.id);
  assert.throws(() => env.service.authenticate({ sessionToken: done.sessionToken }), (e) => e.code === "SESSION_INVALID");
  assert.throws(() => env.service.sessionRenewal(done.sessionToken), (e) => e.code === "SESSION_INVALID");

  // The TTL seam still works (integrators / tests): the cookie follows the remaining lifetime.
  const later = setup({ sessionTtlMs: 3_600_000 });
  const second = pair(later.service).done;
  assert.equal(second.maxAgeSeconds, 3600);
  later.clock.now += 1_800_000;
  assert.equal(later.service.sessionRenewal(second.sessionToken).maxAgeSeconds, 1800);
  later.clock.now += 1_800_000;
  assert.throws(() => later.service.authenticate({ sessionToken: second.sessionToken }), (e) => e.code === "SESSION_INVALID");
});

test("CSRF: derived from the session token, recoverable without rotation; legacy random tokens still accepted", () => {
  const env = setup();
  const { done } = pair(env.service);
  assert.equal(done.csrfToken, deriveCsrfToken(done.sessionToken));
  const stored = env.db.prepare("SELECT csrf_hash FROM paired_sessions WHERE id=?").get(done.session.id);
  assert.notEqual(stored.csrf_hash, done.csrfToken);
  const renewal = env.service.sessionRenewal(done.sessionToken);
  assert.equal(renewal.csrfToken, done.csrfToken, "recovery returns the same token (no rotation)");
  assert.equal(env.service.authenticate({ sessionToken: done.sessionToken, csrfToken: renewal.csrfToken, requireCsrf: true }).sessionId, done.session.id);
  assert.throws(() => env.service.authenticate({ sessionToken: done.sessionToken, csrfToken: "wrong", requireCsrf: true }), (e) => e.code === "CSRF_INVALID");
  assert.throws(() => env.service.sessionRenewal(undefined), (e) => e.code === "PAIRING_REQUIRED");

  // A session minted before Amendment 13 (random CSRF token, only its hash stored) keeps its old token and
  // can also recover the derived one.
  const legacy = "legacy-random-csrf-token-value";
  env.db.prepare("UPDATE paired_sessions SET csrf_hash=? WHERE id=?").run(sha256(legacy), done.session.id);
  assert.equal(env.service.authenticate({ sessionToken: done.sessionToken, csrfToken: legacy, requireCsrf: true }).sessionId, done.session.id);
  assert.equal(env.service.authenticate({ sessionToken: done.sessionToken, csrfToken: deriveCsrfToken(done.sessionToken), requireCsrf: true }).sessionId, done.session.id);
});

test("handoff: minted with pairing, hashed at rest, single use, gives the web app its own session", () => {
  const env = setup();
  const { done } = pair(env.service);
  assert.match(done.handoffToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(done.handoffExpiresAt, new Date(env.clock.now + 15 * 60 * 1000).toISOString());
  const rows = env.db.prepare("SELECT * FROM pairing_handoffs").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, sha256(done.handoffToken));
  assert.equal(JSON.stringify(rows).includes(done.handoffToken), false, "the raw token is never stored");
  assert.equal(rows[0].session_id, done.session.id);

  const redeemed = env.service.redeemHandoff({ handoffToken: done.handoffToken, standalone: true });
  assert.notEqual(redeemed.session.id, done.session.id);
  assert.notEqual(redeemed.sessionToken, done.sessionToken);
  assert.equal(redeemed.session.deviceLabel, "iPhone · 主畫面");
  assert.equal(redeemed.maxAgeSeconds, 34_560_000);
  assert.equal("handoffToken" in redeemed, false, "a handoff session does not mint another handoff");
  assert.equal(env.service.authenticate({ sessionToken: redeemed.sessionToken }).sessionId, redeemed.session.id);
  // The browser session keeps working too.
  assert.equal(env.service.authenticate({ sessionToken: done.sessionToken }).sessionId, done.session.id);
  const sessions = env.service.listSessions();
  assert.equal(sessions.find((row) => row.id === redeemed.session.id).homeScreenAt, new Date(env.clock.now).toISOString());
  assert.equal(sessions.find((row) => row.id === done.session.id).homeScreenAt, null);

  assert.throws(() => env.service.redeemHandoff({ handoffToken: done.handoffToken }), (e) => e.status === 401 && e.code === "PAIRING_HANDOFF_INVALID");
  assert.throws(() => env.service.redeemHandoff({ handoffToken: "x".repeat(43) }), (e) => e.status === 401 && e.code === "PAIRING_HANDOFF_INVALID");
  assert.throws(() => env.service.redeemHandoff({ handoffToken: "bad token" }), (e) => e.status === 400 && e.code === "INVALID_FIELD");
  assert.throws(() => env.service.redeemHandoff({}), (e) => e.code === "INVALID_FIELD");
  assert.throws(() => env.service.redeemHandoff({ handoffToken: "y".repeat(43), standalone: "yes" }), (e) => e.code === "INVALID_FIELD");
});

test("handoff in a browser tab: no 「已加到主畫面」, label 「· 瀏覽器」, a fresh handoff for that tab", () => {
  const env = setup();
  const { done } = pair(env.service);
  const tab = env.service.redeemHandoff({ handoffToken: done.handoffToken, standalone: false });
  assert.equal(tab.session.deviceLabel, "iPhone · 瀏覽器");
  assert.equal(env.service.getSession(tab.session.id).homeScreenAt, null);
  assert.match(tab.handoffToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(tab.handoffToken, done.handoffToken);
  assert.equal(env.db.prepare("SELECT parent_session_id FROM paired_sessions WHERE id=?").get(tab.session.id).parent_session_id, done.session.id);
  // Default is browser mode too.
  const again = pair(env.service, KEY_B).done;
  assert.equal(env.service.redeemHandoff({ handoffToken: again.handoffToken }).session.deviceLabel, "iPhone · 瀏覽器");
  // The tab's own handoff later becomes the home-screen web app (suffixes are not stacked).
  const app = env.service.redeemHandoff({ handoffToken: tab.handoffToken, standalone: true });
  assert.equal(app.session.deviceLabel, "iPhone · 主畫面");
  const tabOfTab = env.service.redeemHandoff({ handoffToken: env.service.redeemHandoff({ handoffToken: pair(env.service, "44444444-4444-4444-8444-444444444444").done.handoffToken }).handoffToken });
  assert.equal(tabOfTab.session.deviceLabel, "iPhone · 瀏覽器");
  assert.ok(env.service.getSession(app.session.id).homeScreenAt);
});

test("revocation cascades to sessions derived through handoffs and voids their handoff tokens", () => {
  const env = setup();
  const { done } = pair(env.service);
  const tab = env.service.redeemHandoff({ handoffToken: done.handoffToken, standalone: false });
  const app = env.service.redeemHandoff({ handoffToken: tab.handoffToken, standalone: true });
  const other = pair(env.service, KEY_B, "Pixel").done;
  // A later tab of the root, with a still-unused handoff.
  const tabHandoff = env.db.prepare("SELECT COUNT(*) AS n FROM pairing_handoffs WHERE consumed_at IS NULL").get().n;
  assert.equal(tabHandoff, 1, "only the second pairing's handoff is unused");
  assert.deepEqual(env.service.revokeSession(done.session.id), { sessionId: done.session.id, revoked: true });
  for (const minted of [done, tab, app]) {
    assert.throws(() => env.service.authenticate({ sessionToken: minted.sessionToken }), (e) => e.code === "SESSION_INVALID");
  }
  assert.equal(env.service.authenticate({ sessionToken: other.sessionToken }).deviceLabel, "Pixel", "other phones are untouched");
  assert.equal(env.service.pairingState(), "paired");
  // Without cascade (a phone logging itself out) only that session ends.
  const third = pair(env.service, "55555555-5555-4555-8555-555555555555", "Galaxy").done;
  const thirdTab = env.service.redeemHandoff({ handoffToken: third.handoffToken, standalone: false });
  const thirdApp = env.service.redeemHandoff({ handoffToken: thirdTab.handoffToken, standalone: true });
  env.service.revokeSession(third.session.id, { cascade: false });
  assert.throws(() => env.service.authenticate({ sessionToken: third.sessionToken }), (e) => e.code === "SESSION_INVALID");
  assert.equal(env.service.authenticate({ sessionToken: thirdTab.sessionToken }).deviceLabel, "Galaxy · 瀏覽器");
  assert.equal(env.service.authenticate({ sessionToken: thirdApp.sessionToken }).deviceLabel, "Galaxy · 主畫面");
  // Revoking a derived session alone leaves its parent working.
  const again = pair(env.service, "33333333-3333-4333-8333-333333333333", "iPad").done;
  const child = env.service.redeemHandoff({ handoffToken: again.handoffToken, standalone: true });
  env.service.revokeSession(child.session.id);
  assert.equal(env.service.authenticate({ sessionToken: again.sessionToken }).deviceLabel, "iPad");
});

test("mobile access off voids outstanding handoffs; used and expired handoff rows are cleaned up", () => {
  const env = setup();
  const first = pair(env.service).done;
  assert.equal(env.service.voidOutstandingHandoffs(), 1);
  assert.throws(() => env.service.redeemHandoff({ handoffToken: first.handoffToken }), (e) => e.code === "PAIRING_HANDOFF_INVALID");
  // Sessions are paused, not removed.
  assert.equal(env.service.authenticate({ sessionToken: first.sessionToken }).sessionId, first.session.id);
  env.clock.now += 1000;
  pair(env.service, KEY_B);
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM pairing_handoffs").get().n, 1, "the voided row was deleted when the next pairing minted a token");
});

test("handoff: expires after 15 minutes and dies with its revoked session", () => {
  const env = setup();
  const first = pair(env.service).done;
  env.clock.now += 15 * 60 * 1000;
  assert.throws(() => env.service.redeemHandoff({ handoffToken: first.handoffToken }), (e) => e.status === 410 && e.code === "PAIRING_HANDOFF_EXPIRED");

  const second = pair(env.service, KEY_B).done;
  env.service.revokeSession(second.session.id);
  assert.throws(() => env.service.redeemHandoff({ handoffToken: second.handoffToken }), (e) => e.status === 401 && e.code === "PAIRING_HANDOFF_INVALID");
  // Revocation voids the session's outstanding handoff tokens.
  assert.notEqual(env.db.prepare("SELECT consumed_at FROM pairing_handoffs WHERE session_id=?").get(second.session.id).consumed_at, null);
});

test("handoff: lockout interplay with the 6-digit code", () => {
  const env = setup();
  // A live 6-digit code: wrong handoff tokens must not count against it (no way to lock someone else's code).
  const live = env.service.createChallenge({ requestKey: KEY_A, deviceLabel: "Android" });
  env.service.approveChallenge(live.challengeId);
  for (let i = 0; i < 10; i += 1) {
    assert.throws(() => env.service.redeemHandoff({ handoffToken: `wrong-token-${i}-xxxxxxxxxxxxxxxx` }), (e) => e.code === "PAIRING_HANDOFF_INVALID");
  }
  assert.equal(env.db.prepare("SELECT attempts FROM pairing_challenges WHERE id=?").get(live.challengeId).attempts, 0);
  const viaCode = env.service.completePairing({ shortCode: live.shortCode });
  assert.match(viaCode.handoffToken, /^[A-Za-z0-9_-]{43}$/, "the 6-digit completion mints a handoff too");

  // A code locked after 5 wrong tries does not block a valid handoff.
  const locked = env.service.createChallenge({ requestKey: KEY_B, deviceLabel: "Other" });
  env.service.approveChallenge(locked.challengeId);
  const wrong = locked.shortCode === "000000" ? "000001" : "000000";
  for (let i = 0; i < 5; i += 1) assert.throws(() => env.service.completePairing({ shortCode: wrong }));
  assert.throws(() => env.service.completePairing({ shortCode: locked.shortCode }), (e) => e.code === "PAIRING_ATTEMPTS_EXCEEDED");
  const redeemed = env.service.redeemHandoff({ handoffToken: viaCode.handoffToken, standalone: true });
  assert.equal(redeemed.session.deviceLabel, "Android · 主畫面");
});

test("home-screen report: idempotent per session, unknown session 404", () => {
  const env = setup();
  const { done } = pair(env.service);
  const first = env.service.markHomeScreen(done.session.id);
  assert.equal(first.changed, true);
  env.clock.now += 1000;
  const again = env.service.markHomeScreen(done.session.id);
  assert.equal(again.changed, false);
  assert.equal(again.homeScreenAt, first.homeScreenAt);
  assert.equal(env.service.getSession(done.session.id).homeScreenAt, first.homeScreenAt);
  assert.throws(() => env.service.markHomeScreen("missing"), (e) => e.code === "SESSION_NOT_FOUND");
});

test("schema: relay_pairing_g3_03_handoff applies once to an Amendment 10 database and detects drift", () => {
  const db = new DatabaseSync(":memory:");
  migrateMobilePairingSchema(db);
  db.exec("DROP TABLE pairing_handoffs; ALTER TABLE paired_sessions DROP COLUMN home_screen_at; ALTER TABLE paired_sessions DROP COLUMN parent_session_id");
  // Sessions of the old 7-day era: still active → permanent; already expired or revoked → unchanged.
  const insertSession = db.prepare("INSERT INTO paired_sessions(id,token_hash,csrf_hash,device_label,expires_at,revoked_at,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?)");
  insertSession.run("active", "h1", "c1", "phone", "2999-01-01T00:00:00.000Z", null, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  insertSession.run("expired", "h2", "c2", "phone", "2020-01-01T00:00:00.000Z", null, "2019-12-25T00:00:00.000Z", "2019-12-25T00:00:00.000Z");
  insertSession.run("revoked", "h3", "c3", "phone", "2999-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  db.prepare("DELETE FROM schema_migrations WHERE version=?").run(MOBILE_PAIRING_HANDOFF_MIGRATION);
  assert.throws(() => assertMobilePairingSchema(db), (e) => e.code === "PAIRING_SCHEMA_REQUIRED");
  const result = migrateMobilePairingSchema(db);
  assert.equal(result.handoffApplied, true);
  assert.equal(result.shortCodeApplied, false);
  const expiries = Object.fromEntries(db.prepare("SELECT id, expires_at FROM paired_sessions").all().map((row) => [row.id, row.expires_at]));
  assert.deepEqual(expiries, { active: "never", expired: "2020-01-01T00:00:00.000Z", revoked: "2999-01-01T00:00:00.000Z" });
  assertMobilePairingSchema(db);
  assert.equal(db.prepare("SELECT checksum FROM schema_migrations WHERE version=?").get(MOBILE_PAIRING_HANDOFF_MIGRATION).checksum, MOBILE_PAIRING_HANDOFF_CHECKSUM);
  assert.equal(migrateMobilePairingSchema(db).handoffApplied, false);

  const untracked = new DatabaseSync(":memory:");
  migrateMobilePairingSchema(untracked);
  untracked.prepare("DELETE FROM schema_migrations WHERE version=?").run(MOBILE_PAIRING_HANDOFF_MIGRATION);
  assert.throws(() => migrateMobilePairingSchema(untracked), (e) => e.code === "MIGRATION_UNTRACKED_SCHEMA");

  db.prepare("UPDATE schema_migrations SET checksum='x' WHERE version=?").run(MOBILE_PAIRING_HANDOFF_MIGRATION);
  assert.throws(() => migrateMobilePairingSchema(db), (e) => e.code === "MIGRATION_CHECKSUM_MISMATCH");
});

test("tailscale status: this account's phone peers only, login name, no addresses; missing binary reads as not installed", async () => {
  const status = {
    BackendState: "Running",
    Self: { ID: "self", HostName: "desk", OS: "windows", UserID: 7, TailscaleIPs: ["100.64.0.9"] },
    User: { 7: { LoginName: "alice@example.com" } },
    Peer: {
      "nodekey:a": { ID: "n1", HostName: "iPhone", OS: "iOS", Online: true, UserID: 7, TailscaleIPs: ["100.70.1.2"] },
      "nodekey:b": { ID: "n2", HostName: "pixel", OS: "android", Online: false, UserID: 7 },
      "nodekey:c": { ID: "n3", HostName: "laptop", OS: "macOS", Online: true, UserID: 7 },
      "nodekey:d": { ID: "n4", HostName: "friends-iphone", OS: "iOS", Online: true, UserID: 99 },
      "nodekey:e": { ID: "n5", HostName: "desk-2", OS: "windows", Online: true, UserID: 7 },
      "nodekey:f": { ID: "n6", HostName: "server", OS: "linux", Online: true, UserID: 7 },
      "nodekey:g": { ID: "n7", HostName: "mystery-phone", OS: "", Online: true, UserID: 7 },
      "nodekey:h": { ID: "n8", HostName: "unknown-os", OS: "unknown", Online: false, UserID: 7 },
      "nodekey:i": { ID: "n9", HostName: "", Online: true, UserID: 7 },
      "nodekey:j": { ID: "n10", HostName: "friends-device", OS: "", Online: true, UserID: 99 },
      "nodekey:k": { ID: "n11", HostName: "mini", OS: "darwin", Online: true, UserID: 7 },
      "nodekey:l": { ID: "n12", HostName: "bsd", OS: "freebsd", Online: true, UserID: 7 },
    },
  };
  const parsed = parseTailscaleStatus(JSON.stringify(status));
  assert.deepEqual(parsed, {
    running: true,
    loginName: "alice@example.com",
    mobilePeers: [
      { id: "n1", hostName: "iPhone", os: "iOS", online: true },
      { id: "n2", hostName: "pixel", os: "android", online: false },
      { id: "n7", hostName: "mystery-phone", os: "", online: true },
      { id: "n8", hostName: "unknown-os", os: "", online: false },
    ],
  });
  assert.equal(JSON.stringify(parsed).includes("100."), false);
  assert.deepEqual(parseTailscaleStatus("not json"), { running: false, loginName: null, mobilePeers: [] });

  const missing = createTailnetResolver({
    execFile: (file, args, options, callback) => callback(Object.assign(new Error("spawn"), { code: "ENOENT" }), "", ""),
    existsSync: () => false,
  });
  assert.deepEqual(await missing.status(), { installed: false, running: false, loginName: null, mobilePeers: [] });
  const stopped = createTailnetResolver({
    execFile: (file, args, options, callback) => callback(Object.assign(new Error("exit 1"), { code: 1 }), JSON.stringify({ BackendState: "Stopped" }), ""),
    existsSync: () => false,
  });
  assert.deepEqual(await stopped.status(), { installed: true, running: false, loginName: null, mobilePeers: [] });
});

test("manifest: start_url carries a well-formed handoff token only", () => {
  const base = JSON.stringify({ name: "AutoMate", start_url: "./", display: "standalone" });
  const token = "A".repeat(43);
  assert.equal(JSON.parse(manifestWithHandoff(base, token)).start_url, `./?handoff=${token}`);
  assert.equal(JSON.parse(manifestWithHandoff(base, "<script>")).start_url, "./");
  assert.equal(JSON.parse(manifestWithHandoff(base, null)).start_url, "./");
});

// ---- HTTP (real createTaskboardServer, fake tailscale, forged tailnet socket) ----

const TAILNET_ADDRESS = "100.64.0.9";
const PHONE_ADDRESS = "100.70.1.2";
const quietLogger = { info() {}, warn() {}, error() {} };

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

async function startBoard(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-w12c-"));
  const staticDirectory = path.join(directory, "web");
  await mkdir(staticDirectory, { recursive: true });
  await writeFile(path.join(staticDirectory, "index.html"), "<!doctype html><title>Taskboard</title>");
  await writeFile(path.join(staticDirectory, "manifest.webmanifest"), JSON.stringify({ name: "AutoMate", start_url: "./", display: "standalone" }));
  const execFile = (file, args, options, callback) => {
    if (args[0] === "status") {
      callback(null, JSON.stringify({ BackendState: "Running", Self: { UserID: 1 }, User: { 1: { LoginName: "me@example.com" } }, Peer: { a: { ID: "p1", HostName: "iPhone", OS: "iOS", Online: true, UserID: 1 } } }), "");
      return;
    }
    callback(null, `${TAILNET_ADDRESS}\n`, "");
  };
  const app = createTaskboardServer({
    dataDirectory: directory,
    staticDirectory,
    runProviders: { claude: fakeProvider("claude"), codex: fakeProvider("codex") },
    enableScheduler: false,
    runLogger: quietLogger,
    mobileAccessOptions: { execFile, logger: quietLogger },
  });
  const address = await app.listen({ port: 0 });
  await app.whenStarted();
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { app, port: address.port };
}

async function local(port, pathname, { method = "GET", body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  return { status: response.status, headers: response.headers, body: parsed, text };
}

async function remote(app, pathname, { method = "GET", body, headers = {}, remoteAddress = PHONE_ADDRESS } = {}) {
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
    destroy() { finish(); },
  };
  app.server.emit("request", request, response);
  await done;
  let parsed;
  try { parsed = response.body ? JSON.parse(response.body) : undefined; } catch { parsed = undefined; }
  return { status: response.statusCode, headers: response.headers, body: parsed, text: response.body };
}

function openLocalEvents(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path: "/api/events", agent: false }, (res) => {
      const stream = { text: "", close: () => req.destroy() };
      res.setEncoding("utf8");
      res.on("data", (chunk) => { stream.text += chunk; });
      res.on("error", () => {});
      resolve(stream);
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

test("HTTP: pairing returns a handoff; /api/pairing/handoff keeps the tailnet boundary; standalone report reaches the desktop event stream", async (t) => {
  const { app, port } = await startBoard(t);
  const remoteHost = `${TAILNET_ADDRESS}:${port}`;
  const remoteOrigin = `http://${remoteHost}`;

  // Mobile access still off: the handoff route refuses remote use.
  const disabled = await remote(app, "/api/pairing/handoff", {
    method: "POST", headers: { host: remoteHost, origin: remoteOrigin }, body: { handoffToken: "A".repeat(43) },
  });
  assert.equal(disabled.status, 403);

  assert.equal((await local(port, "/api/local/mobile-access", { method: "PUT", body: { enabled: true } })).status, 200);
  const challenge = await local(port, "/api/local/pairing/challenges", { method: "POST", body: { requestKey: KEY_A, deviceLabel: "Alice iPhone" } });
  assert.equal((await local(port, `/api/local/pairing/challenges/${challenge.body.challengeId}/approve`, { method: "POST" })).status, 200);
  const completed = await remote(app, "/api/pairing/complete", {
    method: "POST",
    headers: { host: remoteHost, origin: remoteOrigin },
    body: { challengeId: challenge.body.challengeId, challengeCode: challenge.body.challengeCode },
  });
  assert.equal(completed.status, 201, completed.text);
  assert.match(String(completed.headers["set-cookie"]), /Max-Age=34560000;/);
  assert.match(String(completed.headers["set-cookie"]), /HttpOnly; SameSite=Strict/);
  const handoffToken = completed.body.handoffToken;
  assert.match(handoffToken, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(Date.parse(completed.body.handoffExpiresAt) > Date.now());
  // Never listed on the desktop inspection.
  const inspection = await local(port, "/api/local/mobile-access");
  assert.equal(inspection.text.includes(handoffToken), false);

  // Not usable from this PC's own origin, a LAN origin, or without the exact Origin.
  const fromLoopback = await local(port, "/api/pairing/handoff", { method: "POST", body: { handoffToken } });
  assert.equal(fromLoopback.status, 403);
  assert.equal(fromLoopback.body.error.code, "INVALID_HOST");
  const fromLan = await remote(app, "/api/pairing/handoff", {
    method: "POST", remoteAddress: "192.168.50.20", headers: { host: `192.168.50.5:${port}`, origin: `http://192.168.50.5:${port}` }, body: { handoffToken },
  });
  assert.equal(fromLan.status, 403);
  const noOrigin = await remote(app, "/api/pairing/handoff", { method: "POST", headers: { host: remoteHost }, body: { handoffToken } });
  assert.equal(noOrigin.status, 403);
  assert.equal(noOrigin.body.error.code, "INVALID_ORIGIN");
  const foreignOrigin = await remote(app, "/api/pairing/handoff", {
    method: "POST", headers: { host: remoteHost, origin: "http://evil.example" }, body: { handoffToken },
  });
  assert.equal(foreignOrigin.status, 403);
  const withQuery = await remote(app, "/api/pairing/handoff?x=1", { method: "POST", headers: { host: remoteHost, origin: remoteOrigin }, body: { handoffToken } });
  assert.equal(withQuery.status, 400);

  const events = await openLocalEvents(port);
  t.after(() => events.close());

  const redeemed = await remote(app, "/api/pairing/handoff", { method: "POST", headers: { host: remoteHost, origin: remoteOrigin }, body: { handoffToken, standalone: true } });
  assert.equal(redeemed.status, 201, redeemed.text);
  assert.match(String(redeemed.headers["set-cookie"]), /^relay_session=[A-Za-z0-9_-]+; Max-Age=34560000; Path=\/; HttpOnly; SameSite=Strict$/);
  assert.equal(redeemed.body.session.deviceLabel, "Alice iPhone · 主畫面");
  assert.equal("handoffToken" in redeemed.body, false);
  const appCookie = String(redeemed.headers["set-cookie"]).split(";", 1)[0];
  const tasks = await remote(app, "/api/tasks", { headers: { host: remoteHost, cookie: appCookie } });
  assert.equal(tasks.status, 200, tasks.text);
  // Sliding cookie: every authorized API response re-issues the same token with the full Max-Age.
  assert.equal(tasks.headers["set-cookie"], `${appCookie}; Max-Age=34560000; Path=/; HttpOnly; SameSite=Strict`);
  const unauthorized = await remote(app, "/api/tasks", { headers: { host: remoteHost } });
  assert.equal(unauthorized.headers["set-cookie"], undefined);

  // CSRF recovery from the cookie (script storage cleared): same token, Origin required, cookie re-issued.
  const recovered = await remote(app, "/api/pairing/csrf", { method: "POST", headers: { host: remoteHost, origin: remoteOrigin, cookie: appCookie } });
  assert.equal(recovered.status, 200, recovered.text);
  assert.equal(recovered.body.csrfToken, redeemed.body.csrfToken);
  assert.equal(recovered.body.sessionId, redeemed.body.session.id);
  assert.equal(recovered.headers["set-cookie"], `${appCookie}; Max-Age=34560000; Path=/; HttpOnly; SameSite=Strict`);
  const recoverNoOrigin = await remote(app, "/api/pairing/csrf", { method: "POST", headers: { host: remoteHost, cookie: appCookie } });
  assert.equal(recoverNoOrigin.status, 403);
  const recoverForeign = await remote(app, "/api/pairing/csrf", { method: "POST", headers: { host: remoteHost, origin: "http://evil.example", cookie: appCookie } });
  assert.equal(recoverForeign.status, 403);
  const recoverNoCookie = await remote(app, "/api/pairing/csrf", { method: "POST", headers: { host: remoteHost, origin: remoteOrigin } });
  assert.equal(recoverNoCookie.status, 401);
  const recoverGet = await remote(app, "/api/pairing/csrf", { headers: { host: remoteHost, cookie: appCookie } });
  assert.equal(recoverGet.status, 405);
  const recoverLocal = await local(port, "/api/pairing/csrf", { method: "POST" });
  assert.equal(recoverLocal.status, 403);
  const reused = await remote(app, "/api/pairing/handoff", { method: "POST", headers: { host: remoteHost, origin: remoteOrigin }, body: { handoffToken } });
  assert.equal(reused.status, 401);
  assert.equal(reused.body.error.code, "PAIRING_HANDOFF_INVALID");

  // Standalone report from the browser session: needs its CSRF token, then the desktop sees homeScreenAt.
  const browserCookie = String(completed.headers["set-cookie"]).split(";", 1)[0];
  const noCsrf = await remote(app, "/api/pairing/home-screen", { method: "POST", headers: { host: remoteHost, origin: remoteOrigin, cookie: browserCookie }, body: {} });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.error.code, "CSRF_INVALID");
  const unpaired = await remote(app, "/api/pairing/home-screen", { method: "POST", headers: { host: remoteHost, origin: remoteOrigin }, body: {} });
  assert.equal(unpaired.status, 401);
  const before = events.text.split("mobile-access.updated").length;
  const report = await remote(app, "/api/pairing/home-screen", {
    method: "POST",
    headers: { host: remoteHost, origin: remoteOrigin, cookie: browserCookie, "x-relay-csrf": completed.body.csrfToken },
    body: {},
  });
  assert.equal(report.status, 200, report.text);
  assert.equal(report.body.sessionId, completed.body.session.id);
  assert.equal(await waitFor(() => events.text.split("mobile-access.updated").length > before), true, "desktop stream got the change event");
  const afterReport = await local(port, "/api/local/mobile-access");
  const browserSession = afterReport.body.sessions.find((session) => session.id === completed.body.session.id);
  assert.equal(browserSession.homeScreenAt, report.body.homeScreenAt);
  const appSession = afterReport.body.sessions.find((session) => session.id === redeemed.body.session.id);
  assert.ok(appSession.homeScreenAt);
  const fromPc = await local(port, "/api/pairing/home-screen", { method: "POST", body: {} });
  assert.equal(fromPc.status, 403);

  // Revoking the home-screen app session alone (its parent, the browser session, keeps working).
  const revoke = await local(port, `/api/sessions/${redeemed.body.session.id}`, { method: "DELETE" });
  assert.equal(revoke.status, 200);
  const afterRevoke = await remote(app, "/api/tasks", { headers: { host: remoteHost, cookie: appCookie } });
  assert.equal(afterRevoke.status, 401);
  const recoverRevoked = await remote(app, "/api/pairing/csrf", { method: "POST", headers: { host: remoteHost, origin: remoteOrigin, cookie: appCookie } });
  assert.equal(recoverRevoked.status, 401);
  assert.equal((await remote(app, "/api/tasks", { headers: { host: remoteHost, cookie: browserCookie } })).status, 200);
});

test("HTTP: browser-tab handoff, concurrent redemption, disable → enable pause, revoke cascade, phone refused the Tailscale API", async (t) => {
  const { app, port } = await startBoard(t);
  const remoteHost = `${TAILNET_ADDRESS}:${port}`;
  const remoteOrigin = `http://${remoteHost}`;
  const phoneHeaders = (extra = {}) => ({ host: remoteHost, origin: remoteOrigin, ...extra });
  assert.equal((await local(port, "/api/local/mobile-access", { method: "PUT", body: { enabled: true } })).status, 200);
  const pairPhone = async (key) => {
    const challenge = await local(port, "/api/local/pairing/challenges", { method: "POST", body: { requestKey: key, deviceLabel: "我的手機" } });
    await local(port, `/api/local/pairing/challenges/${challenge.body.challengeId}/approve`, { method: "POST" });
    const completed = await remote(app, "/api/pairing/complete", {
      method: "POST", headers: phoneHeaders(), body: { challengeId: challenge.body.challengeId, challengeCode: challenge.body.challengeCode },
    });
    assert.equal(completed.status, 201, completed.text);
    return { ...completed.body, cookie: String(completed.headers["set-cookie"]).split(";", 1)[0] };
  };
  const phone = await pairPhone(KEY_A);

  // A paired phone cannot read the desktop's Tailscale status.
  const tailscaleFromPhone = await remote(app, "/api/local/mobile-access/tailscale", { headers: { host: remoteHost, cookie: phone.cookie } });
  assert.equal(tailscaleFromPhone.status, 403);
  assert.equal(tailscaleFromPhone.body.error.code, "LOCAL_ONLY");

  // Browser tab: no home-screen tick, a new handoff for the tab.
  const tab = await remote(app, "/api/pairing/handoff", { method: "POST", headers: phoneHeaders(), body: { handoffToken: phone.handoffToken, standalone: false } });
  assert.equal(tab.status, 201, tab.text);
  assert.match(tab.body.handoffToken, /^[A-Za-z0-9_-]{43}$/);
  const tabCookie = String(tab.headers["set-cookie"]).split(";", 1)[0];
  let sessions = (await local(port, "/api/local/mobile-access")).body.sessions;
  assert.equal(sessions.find((session) => session.id === tab.body.session.id).homeScreenAt, null);
  assert.equal(sessions.find((session) => session.id === tab.body.session.id).expiresAt, null);
  const badStandalone = await remote(app, "/api/pairing/handoff", { method: "POST", headers: phoneHeaders(), body: { handoffToken: tab.body.handoffToken, standalone: 1 } });
  assert.equal(badStandalone.status, 400);

  // Concurrent redemption of one token: exactly one wins.
  const racers = await Promise.all([1, 2, 3].map(() => remote(app, "/api/pairing/handoff", {
    method: "POST", headers: phoneHeaders(), body: { handoffToken: tab.body.handoffToken, standalone: true },
  })));
  assert.deepEqual(racers.map((response) => response.status).sort(), [201, 401, 401]);
  const appSession = racers.find((response) => response.status === 201);
  const appCookie = String(appSession.headers["set-cookie"]).split(";", 1)[0];

  // Disable = pause: phones get nothing, outstanding handoffs are voided; enable again = phones resume.
  const second = await pairPhone(KEY_B);
  assert.deepEqual((await remote(app, "/api/pairing/availability", { headers: { host: remoteHost } })).body, { mobileAccess: "on" });
  assert.equal((await remote(app, "/api/pairing/availability", { method: "POST", headers: phoneHeaders(), body: {} })).status, 405);
  assert.equal((await local(port, "/api/local/mobile-access", { method: "PUT", body: { enabled: false } })).status, 200);
  assert.deepEqual((await local(port, "/api/pairing/availability")).body, { mobileAccess: "paused" });
  const whileOff = await remote(app, "/api/tasks", { headers: { host: remoteHost, cookie: phone.cookie } });
  assert.notEqual(whileOff.status, 200);
  const offList = await local(port, "/api/local/mobile-access");
  assert.equal(offList.body.sessions.filter((session) => !session.revokedAt).length, 4, "the PC still lists paired phones while off");
  assert.equal((await local(port, "/api/local/mobile-access", { method: "PUT", body: { enabled: true } })).status, 200);
  for (const cookie of [phone.cookie, tabCookie, appCookie, second.cookie]) {
    assert.equal((await remote(app, "/api/tasks", { headers: { host: remoteHost, cookie } })).status, 200);
  }
  const staleHandoff = await remote(app, "/api/pairing/handoff", { method: "POST", headers: phoneHeaders(), body: { handoffToken: second.handoffToken, standalone: true } });
  assert.equal(staleHandoff.status, 401);
  assert.equal(staleHandoff.body.error.code, "PAIRING_HANDOFF_INVALID");

  // A browser tab logging itself out ends only that tab: its home-screen app child keeps working.
  const selfLogout = await remote(app, `/api/sessions/${tab.body.session.id}`, {
    method: "DELETE", headers: phoneHeaders({ cookie: tabCookie, "x-relay-csrf": tab.body.csrfToken }),
  });
  assert.equal(selfLogout.status, 200, selfLogout.text);
  assert.equal((await remote(app, "/api/tasks", { headers: { host: remoteHost, cookie: tabCookie } })).status, 401);
  assert.equal((await remote(app, "/api/tasks", { headers: { host: remoteHost, cookie: appCookie } })).status, 200);

  // Removing the phone on the PC removes its browser tab and home-screen app sessions; the other phone stays.
  assert.equal((await local(port, `/api/sessions/${phone.session.id}`, { method: "DELETE" })).status, 200);
  for (const cookie of [phone.cookie, tabCookie, appCookie]) {
    assert.equal((await remote(app, "/api/tasks", { headers: { host: remoteHost, cookie } })).status, 401);
  }
  assert.equal((await remote(app, "/api/tasks", { headers: { host: remoteHost, cookie: second.cookie } })).status, 200);
  sessions = (await local(port, "/api/local/mobile-access")).body.sessions;
  assert.equal(sessions.filter((session) => session.revokedAt).length, 3);
});

test("HTTP: tailscale status is loopback only; the manifest is served with its handoff start_url", async (t) => {
  const { app, port } = await startBoard(t);
  const status = await local(port, "/api/local/mobile-access/tailscale");
  assert.equal(status.status, 200, status.text);
  assert.equal(status.body.installed, true);
  assert.equal(status.body.running, true);
  assert.equal(status.body.loginName, "me@example.com");
  assert.deepEqual(status.body.mobilePeers, [{ id: "p1", hostName: "iPhone", os: "iOS", online: true }]);
  const post = await local(port, "/api/local/mobile-access/tailscale", { method: "POST", body: {} });
  assert.equal(post.status, 405);
  assert.equal((await local(port, "/api/local/mobile-access")).status, 200);
  const phone = await remote(app, "/api/local/mobile-access/tailscale", { headers: { host: `192.168.50.5:${port}` }, remoteAddress: "192.168.50.20" });
  assert.equal(phone.status, 403);
  assert.equal(phone.body.error.code, "LOCAL_ONLY");

  const plain = await local(port, "/manifest.webmanifest");
  assert.equal(plain.status, 200);
  assert.match(plain.headers.get("content-type"), /^application\/manifest\+json/);
  assert.equal(plain.headers.get("cache-control"), "no-cache");
  assert.equal(plain.body.start_url, "./");
  const token = "B".repeat(43);
  const withHandoff = await local(port, `/manifest.webmanifest?handoff=${token}`);
  assert.equal(withHandoff.body.start_url, `./?handoff=${token}`);
  assert.equal(withHandoff.headers.get("cache-control"), "no-store");
  const hostile = await local(port, `/manifest.webmanifest?handoff=${encodeURIComponent("\"><script>")}`);
  assert.equal(hostile.body.start_url, "./");
});
