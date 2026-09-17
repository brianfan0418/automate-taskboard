import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ApiError } from "../shared/api-fields.mjs";
import {
  MOBILE_PAIRING_CHECKSUM,
  MOBILE_PAIRING_MIGRATION,
  MOBILE_PAIRING_SHORT_CODE_CHECKSUM,
  MOBILE_PAIRING_SHORT_CODE_MIGRATION,
  assertMobilePairingSchema,
  migrateMobilePairingSchema,
} from "../server/mobile/pairing-schema.mjs";
import { MobilePairingService } from "../server/mobile/pairing-service.mjs";

function setup({ challengeTtlMs = 300_000, sessionTtlMs = 3_600_000 } = {}) {
  const db = new DatabaseSync(":memory:");
  migrateMobilePairingSchema(db);
  const clock = { now: Date.parse("2026-09-17T10:00:00.000Z") };
  let id = 0;
  const service = new MobilePairingService(db, { now: () => clock.now, randomId: () => `id-${++id}`, challengeTtlMs, sessionTtlMs });
  return { db, clock, service };
}

const KEY_A = "11111111-1111-4111-8111-111111111111";
const KEY_B = "22222222-2222-4222-8222-222222222222";

test("schema: ledger migration is idempotent and detects tampering / untracked tables", () => {
  const db = new DatabaseSync(":memory:");
  assert.throws(() => assertMobilePairingSchema(db), (e) => e instanceof ApiError && e.code === "PAIRING_SCHEMA_REQUIRED");
  assert.throws(() => new MobilePairingService(db), (e) => e.code === "PAIRING_SCHEMA_REQUIRED");
  assert.deepEqual(migrateMobilePairingSchema(db), { version: MOBILE_PAIRING_MIGRATION, applied: true, checksum: MOBILE_PAIRING_CHECKSUM, shortCodeApplied: true, handoffApplied: true });
  assert.deepEqual(migrateMobilePairingSchema(db), { version: MOBILE_PAIRING_MIGRATION, applied: false, checksum: MOBILE_PAIRING_CHECKSUM, shortCodeApplied: false, handoffApplied: false });
  assert.equal(MOBILE_PAIRING_MIGRATION, "relay_pairing_g3_01");

  db.prepare("UPDATE schema_migrations SET checksum='x' WHERE version=?").run(MOBILE_PAIRING_MIGRATION);
  assert.throws(() => migrateMobilePairingSchema(db), (e) => e.code === "MIGRATION_CHECKSUM_MISMATCH");

  const untracked = new DatabaseSync(":memory:");
  untracked.exec("CREATE TABLE paired_sessions (id TEXT)");
  assert.throws(() => migrateMobilePairingSchema(untracked), (e) => e.code === "MIGRATION_UNTRACKED_SCHEMA");
  // failed migration rolled back as a whole: not even the ledger table was left behind
  assert.equal(untracked.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='schema_migrations'").get().n, 0);

  const damaged = new DatabaseSync(":memory:");
  migrateMobilePairingSchema(damaged);
  damaged.exec("DROP INDEX paired_sessions_expiry");
  assert.throws(() => assertMobilePairingSchema(damaged), (e) => e.code === "PAIRING_SCHEMA_DAMAGED");
});

test("service: unapproved / expired / replayed challenges cannot mint a session", () => {
  const env = setup({ challengeTtlMs: 1000 });
  const first = env.service.createChallenge({ requestKey: KEY_A, deviceLabel: " phone " });
  assert.equal(first.deviceLabel, "phone");
  assert.throws(() => env.service.createChallenge({ requestKey: KEY_A, deviceLabel: "phone" }), (e) => e.status === 409 && e.code === "PAIRING_REQUEST_REPLAYED");
  assert.throws(() => env.service.completePairing({ challengeId: first.challengeId, challengeCode: first.challengeCode }), (e) => e.code === "PAIRING_APPROVAL_REQUIRED");
  env.service.approveChallenge(first.challengeId);
  env.clock.now += 1001;
  assert.throws(() => env.service.completePairing({ challengeId: first.challengeId, challengeCode: first.challengeCode }), (e) => e.status === 410 && e.code === "PAIRING_CHALLENGE_EXPIRED");
  assert.throws(() => env.service.approveChallenge(first.challengeId), (e) => e.status === 410);
  assert.deepEqual(env.service.listPendingChallenges(), [], "expired challenges are not listed");
  assert.equal(env.service.pairingState(), "unpaired");

  const second = env.service.createChallenge({ requestKey: KEY_B, deviceLabel: "phone" });
  assert.equal(env.service.pairingState(), "pending");
  env.service.approveChallenge(second.challengeId);
  const listed = env.service.listPendingChallenges();
  assert.equal(listed.length, 1);
  assert.deepEqual(Object.keys(listed[0]).sort(), ["approved", "challengeId", "createdAt", "deviceLabel", "expiresAt"]);
  assert.equal(listed[0].approved, true);
  const session = env.service.completePairing({ challengeId: second.challengeId, challengeCode: second.challengeCode });
  assert.equal(env.service.pairingState(), "paired");
  assert.throws(() => env.service.completePairing({ challengeId: second.challengeId, challengeCode: second.challengeCode }), (e) => e.status === 401 && e.code === "PAIRING_CHALLENGE_INVALID");
  assert.throws(() => env.service.approveChallenge(second.challengeId), (e) => e.code === "PAIRING_CHALLENGE_CONSUMED");
  assert.equal(env.service.getSession(session.session.id).deviceLabel, "phone");
  assert.throws(() => env.service.getSession("missing"), (e) => e.status === 404 && e.code === "SESSION_NOT_FOUND");
});

test("service: wrong codes are counted and locked out after 5 attempts", () => {
  const env = setup();
  const challenge = env.service.createChallenge({ requestKey: KEY_A, deviceLabel: "phone" });
  env.service.approveChallenge(challenge.challengeId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.throws(() => env.service.completePairing({ challengeId: challenge.challengeId, challengeCode: `wrong-${attempt}` }), (e) => e.code === "PAIRING_CHALLENGE_INVALID");
  }
  assert.throws(() => env.service.completePairing({ challengeId: challenge.challengeId, challengeCode: challenge.challengeCode }), (e) => e.status === 429 && e.code === "PAIRING_ATTEMPTS_EXCEEDED");
});

test("service: authenticate enforces CSRF on demand, expiry and revocation; secrets are stored hashed", () => {
  const env = setup();
  const challenge = env.service.createChallenge({ requestKey: KEY_A, deviceLabel: "phone" });
  env.service.approveChallenge(challenge.challengeId);
  const done = env.service.completePairing({ challengeId: challenge.challengeId, challengeCode: challenge.challengeCode });
  assert.equal(done.maxAgeSeconds, 3600);

  const stored = env.db.prepare("SELECT token_hash, csrf_hash FROM paired_sessions WHERE id=?").get(done.session.id);
  assert.notEqual(stored.token_hash, done.sessionToken);
  assert.notEqual(stored.csrf_hash, done.csrfToken);
  const codeRow = env.db.prepare("SELECT code_hash FROM pairing_challenges WHERE id=?").get(challenge.challengeId);
  assert.notEqual(codeRow.code_hash, challenge.challengeCode);

  assert.throws(() => env.service.authenticate({}), (e) => e.status === 401 && e.code === "PAIRING_REQUIRED");
  assert.throws(() => env.service.authenticate({ sessionToken: "forged" }), (e) => e.code === "SESSION_INVALID");
  assert.throws(() => env.service.authenticate({ sessionToken: done.sessionToken, requireCsrf: true }), (e) => e.status === 403 && e.code === "CSRF_INVALID");
  const principal = env.service.authenticate({ sessionToken: done.sessionToken, csrfToken: done.csrfToken, requireCsrf: true });
  assert.equal(principal.sessionId, done.session.id);
  assert.deepEqual(principal.roles, ["H"]);

  env.clock.now += 60_000;
  env.service.authenticate({ sessionToken: done.sessionToken });
  assert.equal(env.service.listSessions()[0].lastSeenAt, new Date(env.clock.now).toISOString());

  env.service.revokeSession(done.session.id);
  assert.throws(() => env.service.authenticate({ sessionToken: done.sessionToken }), (e) => e.code === "SESSION_INVALID");
  assert.equal(env.service.pairingState(), "unpaired");
  assert.throws(() => env.service.revokeSession("missing"), (e) => e.code === "SESSION_NOT_FOUND");
});

test("schema: a database migrated before Amendment 10 gains the short-code columns once", () => {
  const db = new DatabaseSync(":memory:");
  migrateMobilePairingSchema(db);
  // Simulate the g3_01-only database: drop the columns' receipt and the columns themselves.
  db.exec("ALTER TABLE pairing_challenges DROP COLUMN short_code_hash; ALTER TABLE pairing_challenges DROP COLUMN revoked_at");
  db.prepare("DELETE FROM schema_migrations WHERE version=?").run(MOBILE_PAIRING_SHORT_CODE_MIGRATION);
  assert.throws(() => assertMobilePairingSchema(db), (e) => e.code === "PAIRING_SCHEMA_REQUIRED");
  db.prepare("INSERT INTO pairing_challenges(id,request_key,code_hash,device_label,expires_at,created_at) VALUES('old','k','h','phone','2999-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run();
  assert.equal(migrateMobilePairingSchema(db).shortCodeApplied, true);
  assertMobilePairingSchema(db);
  const old = db.prepare("SELECT short_code_hash, revoked_at FROM pairing_challenges WHERE id='old'").get();
  assert.deepEqual({ ...old }, { short_code_hash: null, revoked_at: null });
  assert.equal(db.prepare("SELECT checksum FROM schema_migrations WHERE version=?").get(MOBILE_PAIRING_SHORT_CODE_MIGRATION).checksum, MOBILE_PAIRING_SHORT_CODE_CHECKSUM);

  db.prepare("UPDATE schema_migrations SET checksum='x' WHERE version=?").run(MOBILE_PAIRING_SHORT_CODE_MIGRATION);
  assert.throws(() => migrateMobilePairingSchema(db), (e) => e.code === "MIGRATION_CHECKSUM_MISMATCH");
});

test("scan-to-pair: the QR secret is single use and dies with expiry and revoke", () => {
  const env = setup({ challengeTtlMs: 1000 });
  const qr = env.service.createChallenge({ requestKey: KEY_A, deviceLabel: "iPhone" });
  assert.match(qr.challengeCode, /^[A-Za-z0-9_-]{43}$/, "32 random bytes");
  assert.match(qr.shortCode, /^[0-9]{6}$/);
  env.service.approveChallenge(qr.challengeId);
  const stored = env.db.prepare("SELECT code_hash, short_code_hash FROM pairing_challenges WHERE id=?").get(qr.challengeId);
  assert.equal(JSON.stringify(stored).includes(qr.challengeCode) || JSON.stringify(stored).includes(qr.shortCode), false, "secrets stored hashed");

  const done = env.service.completePairing({ challengeId: qr.challengeId, challengeCode: qr.challengeCode });
  assert.equal(done.session.deviceLabel, "iPhone");
  assert.throws(() => env.service.completePairing({ challengeId: qr.challengeId, challengeCode: qr.challengeCode }), (e) => e.status === 401 && e.code === "PAIRING_CHALLENGE_INVALID");
  assert.throws(() => env.service.completePairing({ shortCode: qr.shortCode }), (e) => e.status === 401, "the 6-digit code dies with the QR secret");

  const other = env.service.createChallenge({ requestKey: KEY_B, deviceLabel: "iPad" });
  env.service.approveChallenge(other.challengeId);
  assert.throws(() => env.service.completePairing({ challengeId: qr.challengeId, challengeCode: other.challengeCode }), (e) => e.code === "PAIRING_CHALLENGE_INVALID", "a secret is bound to its own challenge");
  assert.throws(() => env.service.completePairing({ challengeId: other.challengeId, challengeCode: qr.challengeCode }), (e) => e.code === "PAIRING_CHALLENGE_INVALID");

  const revoked = env.service.revokeChallenge(other.challengeId);
  assert.equal(revoked.revoked, true);
  assert.deepEqual(env.service.revokeChallenge(other.challengeId), revoked, "revoke is idempotent");
  assert.throws(() => env.service.completePairing({ challengeId: other.challengeId, challengeCode: other.challengeCode }), (e) => e.status === 401 && e.code === "PAIRING_CHALLENGE_INVALID");
  assert.throws(() => env.service.completePairing({ shortCode: other.shortCode }), (e) => e.status === 401);
  assert.throws(() => env.service.approveChallenge(other.challengeId), (e) => e.code === "PAIRING_CHALLENGE_REVOKED");
  assert.deepEqual(env.service.listPendingChallenges(), [], "revoked challenges are not listed");
  assert.throws(() => env.service.revokeChallenge(qr.challengeId), (e) => e.status === 409 && e.code === "PAIRING_CHALLENGE_CONSUMED");
  assert.throws(() => env.service.revokeChallenge("missing"), (e) => e.status === 404);

  const late = env.service.createChallenge({ requestKey: "33333333-3333-4333-8333-333333333333", deviceLabel: "late" });
  env.service.approveChallenge(late.challengeId);
  env.clock.now += 1001;
  assert.throws(() => env.service.completePairing({ challengeId: late.challengeId, challengeCode: late.challengeCode }), (e) => e.status === 410);
  assert.throws(() => env.service.completePairing({ shortCode: late.shortCode }), (e) => e.status === 401, "expired short codes no longer match");
});

test("manual fallback: 6-digit code completes pairing; 5 wrong tries lock the challenge", () => {
  const env = setup();
  const challenge = env.service.createChallenge({ requestKey: KEY_A, deviceLabel: "phone" });
  const wrong = challenge.shortCode === "000000" ? "000001" : "000000";
  assert.throws(() => env.service.completePairing({ shortCode: challenge.shortCode }), (e) => e.status === 401, "an unapproved challenge is not matched");
  env.service.approveChallenge(challenge.challengeId);
  for (const bad of ["12345", "abcdef", "1234567", 123456]) {
    assert.throws(() => env.service.completePairing({ shortCode: bad }), (e) => e.status === 400 && e.code === "INVALID_FIELD");
  }
  assert.throws(() => env.service.completePairing({ shortCode: challenge.shortCode, challengeId: challenge.challengeId }), (e) => e.status === 400);
  const attempts = () => env.db.prepare("SELECT attempts FROM pairing_challenges WHERE id=?").get(challenge.challengeId).attempts;
  // The unapproved try above counted against nothing: the challenge was not yet completable.
  assert.equal(attempts(), 0);
  for (let i = 0; i < 4; i += 1) {
    assert.throws(() => env.service.completePairing({ shortCode: wrong }), (e) => e.status === 401 && e.code === "PAIRING_CHALLENGE_INVALID");
  }
  assert.equal(attempts(), 4);
  const done = env.service.completePairing({ shortCode: ` ${challenge.shortCode} ` });
  assert.equal(done.session.deviceLabel, "phone");
  assert.throws(() => env.service.completePairing({ shortCode: challenge.shortCode }), (e) => e.status === 401, "single use");

  const locked = env.service.createChallenge({ requestKey: KEY_B, deviceLabel: "phone 2" });
  env.service.approveChallenge(locked.challengeId);
  const wrong2 = locked.shortCode === "999999" ? "999998" : "999999";
  for (let i = 0; i < 5; i += 1) {
    assert.throws(() => env.service.completePairing({ shortCode: wrong2 }), (e) => e.status === 401);
  }
  assert.throws(() => env.service.completePairing({ shortCode: locked.shortCode }), (e) => e.status === 429 && e.code === "PAIRING_ATTEMPTS_EXCEEDED");
  assert.throws(() => env.service.completePairing({ challengeId: locked.challengeId, challengeCode: locked.challengeCode }), (e) => e.status === 429, "the lock covers the QR secret too");
});

test("manual fallback: a wrong guess counts against every open challenge; codes stay unique", () => {
  let n = 0;
  const env = setup();
  const a = env.service.createChallenge({ requestKey: KEY_A, deviceLabel: "a" });
  const b = env.service.createChallenge({ requestKey: KEY_B, deviceLabel: "b" });
  env.service.approveChallenge(a.challengeId);
  env.service.approveChallenge(b.challengeId);
  assert.notEqual(a.shortCode, b.shortCode);
  let wrong = "000000";
  while (wrong === a.shortCode || wrong === b.shortCode) wrong = String(++n).padStart(6, "0");
  assert.throws(() => env.service.completePairing({ shortCode: wrong }), (e) => e.status === 401);
  const rows = env.db.prepare("SELECT id, attempts FROM pairing_challenges ORDER BY id").all().map((row) => row.attempts);
  assert.deepEqual(rows, [1, 1]);
  assert.equal(env.service.completePairing({ shortCode: b.shortCode }).session.deviceLabel, "b");
  assert.equal(env.service.completePairing({ shortCode: a.shortCode }).session.deviceLabel, "a");
});
