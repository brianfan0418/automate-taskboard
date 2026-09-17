// Ported from fork server/mobile-pairing-schema.mjs (HEAD dae7302). SQL bytes, version and
// checksum are kept identical so a database already carrying relay_pairing_g3_01 stays valid.
import { createHash } from 'node:crypto';
import { ApiError } from '../../shared/api-fields.mjs';

export const MOBILE_PAIRING_MIGRATION = 'relay_pairing_g3_01';
const LEDGER_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
 version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
)`;
const TABLES_SQL = `
CREATE TABLE pairing_challenges (
 id TEXT PRIMARY KEY,
 request_key TEXT NOT NULL UNIQUE,
 code_hash TEXT NOT NULL UNIQUE,
 device_label TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 approved_at TEXT,
 consumed_at TEXT,
 created_at TEXT NOT NULL
);
CREATE INDEX pairing_challenges_expiry ON pairing_challenges(expires_at);
CREATE TABLE paired_sessions (
 id TEXT PRIMARY KEY,
 token_hash TEXT NOT NULL UNIQUE,
 csrf_hash TEXT NOT NULL,
 device_label TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 revoked_at TEXT,
 created_at TEXT NOT NULL,
 last_seen_at TEXT NOT NULL
);
CREATE INDEX paired_sessions_expiry ON paired_sessions(expires_at);
`;
export const MOBILE_PAIRING_CHECKSUM = createHash('sha256')
  .update(LEDGER_SQL + TABLES_SQL).digest('hex');

// Amendment 10 (scan-to-pair): 6-digit manual fallback code + desktop revoke of a challenge.
export const MOBILE_PAIRING_SHORT_CODE_MIGRATION = 'relay_pairing_g3_02_short_code';
const SHORT_CODE_SQL = `
ALTER TABLE pairing_challenges ADD COLUMN short_code_hash TEXT;
ALTER TABLE pairing_challenges ADD COLUMN revoked_at TEXT;
`;
export const MOBILE_PAIRING_SHORT_CODE_CHECKSUM = createHash('sha256').update(SHORT_CODE_SQL).digest('hex');
const SHORT_CODE_COLUMNS = ['short_code_hash', 'revoked_at'];

// Amendment 13 (W12-C): single-use home-screen handoff tokens + the phone's 「已加到主畫面」 report; sessions still
// active when it runs become permanent (expires_at 'never', product owner decision: pairing does not expire).
export const MOBILE_PAIRING_HANDOFF_MIGRATION = 'relay_pairing_g3_03_handoff';
const HANDOFF_SQL = `
CREATE TABLE pairing_handoffs (
 id TEXT PRIMARY KEY,
 token_hash TEXT NOT NULL UNIQUE,
 session_id TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 consumed_at TEXT,
 created_at TEXT NOT NULL
);
CREATE INDEX pairing_handoffs_expiry ON pairing_handoffs(expires_at);
ALTER TABLE paired_sessions ADD COLUMN home_screen_at TEXT;
ALTER TABLE paired_sessions ADD COLUMN parent_session_id TEXT;
UPDATE paired_sessions SET expires_at='never'
 WHERE revoked_at IS NULL AND expires_at <> 'never' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now');
`;
export const MOBILE_PAIRING_HANDOFF_CHECKSUM = createHash('sha256').update(HANDOFF_SQL).digest('hex');

function schemaError(code, message) { return new ApiError(409, code, message); }
function hasObject(db, type, name) {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_schema WHERE type=? AND name=?').get(type, name));
}
function challengeColumns(db) {
  return new Set(db.prepare('PRAGMA table_info(pairing_challenges)').all().map((column) => column.name));
}

export function assertMobilePairingSchema(db) {
  if (!hasObject(db, 'table', 'schema_migrations')) {
    throw schemaError('PAIRING_SCHEMA_REQUIRED', 'Mobile pairing migration has not run');
  }
  const row = db.prepare('SELECT checksum FROM schema_migrations WHERE version=?').get(MOBILE_PAIRING_MIGRATION);
  if (!row) throw schemaError('PAIRING_SCHEMA_REQUIRED', 'Mobile pairing migration has not run');
  if (row.checksum !== MOBILE_PAIRING_CHECKSUM) {
    throw schemaError('MIGRATION_CHECKSUM_MISMATCH', 'Mobile pairing migration bytes differ from the applied version');
  }
  for (const [type, name] of [
    ['table', 'pairing_challenges'], ['index', 'pairing_challenges_expiry'],
    ['table', 'paired_sessions'], ['index', 'paired_sessions_expiry'],
  ]) {
    if (!hasObject(db, type, name)) throw schemaError('PAIRING_SCHEMA_DAMAGED', `Migrated schema object missing: ${name}`);
  }
  const shortCode = db.prepare('SELECT checksum FROM schema_migrations WHERE version=?').get(MOBILE_PAIRING_SHORT_CODE_MIGRATION);
  if (!shortCode) throw schemaError('PAIRING_SCHEMA_REQUIRED', 'Mobile pairing short-code migration has not run');
  if (shortCode.checksum !== MOBILE_PAIRING_SHORT_CODE_CHECKSUM) {
    throw schemaError('MIGRATION_CHECKSUM_MISMATCH', 'Mobile pairing short-code migration bytes differ from the applied version');
  }
  const columns = challengeColumns(db);
  for (const name of SHORT_CODE_COLUMNS) {
    if (!columns.has(name)) throw schemaError('PAIRING_SCHEMA_DAMAGED', `Migrated schema column missing: pairing_challenges.${name}`);
  }
  const handoff = db.prepare('SELECT checksum FROM schema_migrations WHERE version=?').get(MOBILE_PAIRING_HANDOFF_MIGRATION);
  if (!handoff) throw schemaError('PAIRING_SCHEMA_REQUIRED', 'Mobile pairing handoff migration has not run');
  if (handoff.checksum !== MOBILE_PAIRING_HANDOFF_CHECKSUM) {
    throw schemaError('MIGRATION_CHECKSUM_MISMATCH', 'Mobile pairing handoff migration bytes differ from the applied version');
  }
  for (const [type, name] of [['table', 'pairing_handoffs'], ['index', 'pairing_handoffs_expiry']]) {
    if (!hasObject(db, type, name)) throw schemaError('PAIRING_SCHEMA_DAMAGED', `Migrated schema object missing: ${name}`);
  }
  for (const name of ['home_screen_at', 'parent_session_id']) {
    if (!sessionColumns(db).has(name)) {
      throw schemaError('PAIRING_SCHEMA_DAMAGED', `Migrated schema column missing: paired_sessions.${name}`);
    }
  }
}

function sessionColumns(db) {
  return new Set(db.prepare('PRAGMA table_info(paired_sessions)').all().map((column) => column.name));
}

/** Applies relay_pairing_g3_03_handoff inside the caller's open transaction. */
function migrateHandoff(db) {
  const existing = db.prepare('SELECT checksum FROM schema_migrations WHERE version=?').get(MOBILE_PAIRING_HANDOFF_MIGRATION);
  if (existing) {
    if (existing.checksum !== MOBILE_PAIRING_HANDOFF_CHECKSUM) {
      throw schemaError('MIGRATION_CHECKSUM_MISMATCH', 'Mobile pairing handoff migration bytes differ from the applied version');
    }
    return false;
  }
  const columns = sessionColumns(db);
  if (hasObject(db, 'table', 'pairing_handoffs') || columns.has('home_screen_at') || columns.has('parent_session_id')) {
    throw schemaError('MIGRATION_UNTRACKED_SCHEMA', 'Pairing handoff schema exists without the expected migration receipt');
  }
  db.exec(HANDOFF_SQL);
  db.prepare('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)')
    .run(MOBILE_PAIRING_HANDOFF_MIGRATION, MOBILE_PAIRING_HANDOFF_CHECKSUM, new Date().toISOString());
  return true;
}

/** Applies relay_pairing_g3_02_short_code inside the caller's open transaction. */
function migrateShortCode(db) {
  const existing = db.prepare('SELECT checksum FROM schema_migrations WHERE version=?').get(MOBILE_PAIRING_SHORT_CODE_MIGRATION);
  if (existing) {
    if (existing.checksum !== MOBILE_PAIRING_SHORT_CODE_CHECKSUM) {
      throw schemaError('MIGRATION_CHECKSUM_MISMATCH', 'Mobile pairing short-code migration bytes differ from the applied version');
    }
    return false;
  }
  const columns = challengeColumns(db);
  if (SHORT_CODE_COLUMNS.some((name) => columns.has(name))) {
    throw schemaError('MIGRATION_UNTRACKED_SCHEMA', 'Pairing short-code columns exist without the expected migration receipt');
  }
  db.exec(SHORT_CODE_SQL);
  db.prepare('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)')
    .run(MOBILE_PAIRING_SHORT_CODE_MIGRATION, MOBILE_PAIRING_SHORT_CODE_CHECKSUM, new Date().toISOString());
  return true;
}

export function migrateMobilePairingSchema(db) {
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(LEDGER_SQL);
    const existing = db.prepare('SELECT checksum FROM schema_migrations WHERE version=?').get(MOBILE_PAIRING_MIGRATION);
    if (existing) {
      if (existing.checksum !== MOBILE_PAIRING_CHECKSUM) {
        throw schemaError('MIGRATION_CHECKSUM_MISMATCH', 'Mobile pairing migration bytes differ from the applied version');
      }
      const shortCodeApplied = migrateShortCode(db);
      const handoffApplied = migrateHandoff(db);
      db.exec('COMMIT');
      assertMobilePairingSchema(db);
      return { version: MOBILE_PAIRING_MIGRATION, applied: false, checksum: MOBILE_PAIRING_CHECKSUM, shortCodeApplied, handoffApplied };
    }
    if (hasObject(db, 'table', 'pairing_challenges') || hasObject(db, 'table', 'paired_sessions')) {
      throw schemaError('MIGRATION_UNTRACKED_SCHEMA', 'Pairing tables exist without the expected migration receipt');
    }
    db.exec(TABLES_SQL);
    const time = new Date().toISOString();
    db.prepare('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)')
      .run(MOBILE_PAIRING_MIGRATION, MOBILE_PAIRING_CHECKSUM, time);
    const shortCodeApplied = migrateShortCode(db);
    const handoffApplied = migrateHandoff(db);
    db.exec('COMMIT');
    return { version: MOBILE_PAIRING_MIGRATION, applied: true, checksum: MOBILE_PAIRING_CHECKSUM, shortCodeApplied, handoffApplied };
  } catch (cause) {
    db.exec('ROLLBACK');
    throw cause;
  }
}
