// W14 (CONTRACTS Amendment 15): the product owner's installed database (one permanent pairing, expires_at 'never',
// several approved-but-unconsumed challenges, one unconsumed handoff) must read as 「paired」 on the desktop.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { createTaskboardServer } from "../server/app.mjs";

const TAILNET_ADDRESS = "100.64.0.9";
const quietLogger = { info() {}, warn() {}, error() {} };
const SESSION_ID = "5e5510a0-0000-4000-8000-000000000001";

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

async function startBoard(directory) {
  const staticDirectory = path.join(directory, "web");
  await mkdir(staticDirectory, { recursive: true });
  await writeFile(path.join(staticDirectory, "index.html"), "<!doctype html><title>Taskboard</title>");
  const app = createTaskboardServer({
    dataDirectory: directory,
    staticDirectory,
    runProviders: { claude: fakeProvider("claude"), codex: fakeProvider("codex") },
    enableScheduler: false,
    runLogger: quietLogger,
    mobileAccessOptions: { execFile: (file, args, options, callback) => callback(null, `${TAILNET_ADDRESS}\n`, ""), logger: quietLogger },
  });
  const address = await app.listen({ port: 0 });
  await app.whenStarted();
  return { app, port: address.port };
}

async function getJson(port, pathname) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
  return { status: response.status, body: await response.json() };
}

test("product owner database: permanent pairing reads as paired, with expiresAt null, in every desktop view", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-w14-paired-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {}));

  // First start creates and migrates the database; then the rows are written like the installed 2.0.1 left them.
  const first = await startBoard(directory);
  await first.app.close();
  const db = new DatabaseSync(path.join(directory, "taskboard.sqlite"));
  const now = Date.now();
  const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
  db.prepare(`INSERT INTO paired_sessions(id,token_hash,csrf_hash,device_label,expires_at,revoked_at,created_at,last_seen_at,home_screen_at,parent_session_id)
    VALUES(?,?,?,?,'never',NULL,?,?,?,NULL)`)
    .run(SESSION_ID, "a".repeat(64), "b".repeat(64), "我的手機", iso(-32 * 60_000), iso(-60_000), iso(-30 * 60_000));
  for (let index = 0; index < 8; index += 1) {
    db.prepare(`INSERT INTO pairing_challenges(id,request_key,code_hash,device_label,expires_at,attempts,approved_at,consumed_at,created_at,short_code_hash,revoked_at)
      VALUES(?,?,?,?,?,0,?,NULL,?,?,NULL)`)
      .run(`challenge-${index}`, `key-${index}`, `${index}c`.repeat(32), "我的手機", iso(-40 * 60_000 + index), index % 2 ? iso(-45 * 60_000) : null, iso(-45 * 60_000), `${index}`.repeat(64));
  }
  db.prepare("INSERT INTO pairing_handoffs(id,token_hash,session_id,expires_at,consumed_at,created_at) VALUES(?,?,?,?,NULL,?)")
    .run("handoff-1", "d".repeat(64), SESSION_ID, iso(-17 * 60_000), iso(-32 * 60_000));
  db.close();
  await writeFile(path.join(directory, "mobile-access.json"), JSON.stringify({ version: 1, enabled: true, url: `http://${TAILNET_ADDRESS}:47833/` }));

  const { app, port } = await startBoard(directory);
  try {

    const expected = {
      id: SESSION_ID,
      deviceLabel: "我的手機",
      expiresAt: null,
      revokedAt: null,
      parentSessionId: null,
    };
    const inspection = await getJson(port, "/api/local/mobile-access");
    assert.equal(inspection.status, 200);
    assert.equal(inspection.body.pairing, "paired");
    assert.equal(inspection.body.sessions.length, 1);
    assert.deepEqual(
      Object.fromEntries(Object.keys(expected).map((key) => [key, inspection.body.sessions[0][key]])),
      expected,
    );
    assert.equal(typeof inspection.body.sessions[0].homeScreenAt, "string");
    assert.deepEqual(inspection.body.pendingChallenges, [], "expired challenges are not pending");

    const listed = await getJson(port, "/api/local/pairing/sessions");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.sessions.length, 1);
    assert.equal(listed.body.sessions[0].expiresAt, null);
    assert.equal(listed.body.sessions[0].parentSessionId, null);

    const single = await getJson(port, `/api/sessions/${SESSION_ID}`);
    assert.equal(single.status, 200);
    assert.equal((single.body.session ?? single.body).expiresAt, null);
  } finally {
    await app.close();
  }
});
