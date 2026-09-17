// Ported from fork server/mobile-pairing-service.mjs (HEAD dae7302).
// v2 additions: getSession(), listPendingChallenges() (read-only, never expose codes/tokens).
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../../shared/api-fields.mjs';
import { assertMobilePairingSchema } from './pairing-schema.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;
// Amendment 13 (W12-C, product owner: pairing is permanent): a paired phone's session has no server-side expiry;
// it lasts until it is revoked on the PC (or by the phone). `sessionTtlMs` stays as a test / integrator seam.
const DEFAULT_SESSION_TTL_MS = null;
/** Stored in paired_sessions.expires_at for a session without expiry (the column is NOT NULL). */
export const SESSION_NEVER_EXPIRES = 'never';
/** Browsers cap cookie lifetime at 400 days (RFC 6265bis; Chrome 104+). The cookie is re-issued on use. */
export const MAX_SESSION_COOKIE_AGE_SECONDS = 400 * 24 * 60 * 60;
const CSRF_DERIVATION_LABEL = 'relay-csrf-v1';
// Amendment 13: single-use handoff token that lets a home-screen web app obtain its own session.
const DEFAULT_HANDOFF_TTL_MS = 15 * 60 * 1000;
const HOME_SCREEN_LABEL_SUFFIX = ' · 主畫面';
const BROWSER_TAB_LABEL_SUFFIX = ' · 瀏覽器';
/** Label of a session derived through a handoff: the phone's name plus where it runs (never stacked). */
function derivedLabel(sourceLabel, suffix) {
  let base = sourceLabel;
  for (const known of [HOME_SCREEN_LABEL_SUFFIX, BROWSER_TAB_LABEL_SUFFIX]) {
    if (base.endsWith(known)) base = base.slice(0, -known.length);
  }
  return `${base.slice(0, DEVICE_LABEL_MAX - suffix.length)}${suffix}`;
}
const DEVICE_LABEL_MAX = 120;
const MAX_ATTEMPTS = 5;
const SHORT_CODE = /^[0-9]{6}$/;
const SHORT_CODE_TRIES = 20;

const hash = (value) => createHash('sha256').update(value).digest('hex');
const iso = (ms) => new Date(ms).toISOString();
const expired = (timestamp, nowMs) => Date.parse(timestamp) <= nowMs;
const sessionExpired = (expiresAt, nowMs) => expiresAt !== SESSION_NEVER_EXPIRES && expired(expiresAt, nowMs);
const publicExpiry = (expiresAt) => (expiresAt === SESSION_NEVER_EXPIRES ? null : expiresAt);
/**
 * Amendment 13: the CSRF token is derived from the session token (HMAC), so a phone whose script storage was
 * cleared (iOS ITP) recovers it from its HttpOnly cookie without re-pairing and without rotating other copies.
 */
export function deriveCsrfToken(sessionToken) {
  return createHmac('sha256', sessionToken).update(CSRF_DERIVATION_LABEL).digest('base64url');
}
function safeEqualText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}
function fail(status, code, message, details) { throw new ApiError(status, code, message, details); }
function nonempty(value, label, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    fail(400, 'INVALID_FIELD', `${label} must be a nonempty string (maximum ${max})`);
  }
  return value.trim();
}
function requestKey(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(400, 'INVALID_FIELD', 'requestKey must be a UUID');
  return value;
}
function safeHashEqual(candidate, savedHex) {
  const left = Buffer.from(hash(candidate), 'hex');
  const right = Buffer.from(savedHex, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
function token() { return randomBytes(32).toString('base64url'); }
function newShortCode() { return String(randomInt(0, 1_000_000)).padStart(6, '0'); }
// The 6-digit code is salted with its challenge id, so equal codes of different challenges hash differently.
const shortCodeInput = (challengeId, code) => `${challengeId}:${code}`;
function sessionView(row) {
  return { id: row.id, deviceLabel: row.device_label, expiresAt: publicExpiry(row.expires_at),
    revokedAt: row.revoked_at, createdAt: row.created_at, lastSeenAt: row.last_seen_at,
    homeScreenAt: row.home_screen_at ?? null, parentSessionId: row.parent_session_id ?? null };
}

export class MobilePairingService {
  #db; #now; #randomId; #challengeTtlMs; #sessionTtlMs; #handoffTtlMs;
  constructor(database, {
    now = () => Date.now(), randomId = randomUUID,
    challengeTtlMs = DEFAULT_CHALLENGE_TTL_MS, sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    handoffTtlMs = DEFAULT_HANDOFF_TTL_MS,
  } = {}) {
    assertMobilePairingSchema(database);
    if (typeof now !== 'function' || typeof randomId !== 'function') throw new TypeError('Pairing time/id seams must be functions');
    if (!Number.isSafeInteger(challengeTtlMs) || challengeTtlMs < 1) throw new TypeError('challengeTtlMs must be a positive integer');
    if (sessionTtlMs !== null && (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1)) throw new TypeError('sessionTtlMs must be null or a positive integer');
    if (!Number.isSafeInteger(handoffTtlMs) || handoffTtlMs < 1) throw new TypeError('handoffTtlMs must be a positive integer');
    this.#db = database; this.#now = now; this.#randomId = randomId;
    this.#challengeTtlMs = challengeTtlMs; this.#sessionTtlMs = sessionTtlMs; this.#handoffTtlMs = handoffTtlMs;
  }

  createChallenge({ requestKey: key, deviceLabel }) {
    requestKey(key); const label = nonempty(deviceLabel, 'deviceLabel');
    const existing = this.#db.prepare('SELECT id,expires_at,approved_at,consumed_at,device_label FROM pairing_challenges WHERE request_key=?').get(key);
    if (existing) {
      fail(409, 'PAIRING_REQUEST_REPLAYED', 'Pairing challenge already exists for this requestKey', {
        challengeId: existing.id, expiresAt: existing.expires_at, approved: Boolean(existing.approved_at), consumed: Boolean(existing.consumed_at),
      });
    }
    const challengeId = this.#randomId();
    const challengeCode = token();
    const nowMs = this.#now();
    const expiresAt = iso(nowMs + this.#challengeTtlMs);
    // A 6-digit code must be unambiguous among the challenges a phone could still complete.
    const active = this.#activeShortCodeRows(nowMs);
    let shortCode = newShortCode();
    for (let tries = 1; active.some((row) => safeHashEqual(shortCodeInput(row.id, shortCode), row.short_code_hash)); tries += 1) {
      if (tries >= SHORT_CODE_TRIES) fail(503, 'PAIRING_CODE_UNAVAILABLE', 'Could not allocate a unique pairing code; try again');
      shortCode = newShortCode();
    }
    this.#db.prepare(`INSERT INTO pairing_challenges
      (id,request_key,code_hash,device_label,expires_at,attempts,approved_at,consumed_at,created_at,short_code_hash,revoked_at)
      VALUES(?,?,?,?,?,0,NULL,NULL,?,?,NULL)`)
      .run(challengeId, key, hash(challengeCode), label, expiresAt, iso(nowMs), hash(shortCodeInput(challengeId, shortCode)));
    return { challengeId, challengeCode, shortCode, deviceLabel: label, expiresAt, approved: false };
  }

  #activeShortCodeRows(nowMs) {
    return this.#db.prepare(`SELECT id,short_code_hash,expires_at,attempts,approved_at FROM pairing_challenges
      WHERE consumed_at IS NULL AND revoked_at IS NULL AND short_code_hash IS NOT NULL`).all()
      .filter((row) => !expired(row.expires_at, nowMs));
  }

  /** Desktop cancels a challenge: its QR link and 6-digit code stop working at once. Idempotent. */
  revokeChallenge(challengeId) {
    const id = nonempty(challengeId, 'challengeId', 256);
    const row = this.#db.prepare('SELECT id,consumed_at,revoked_at FROM pairing_challenges WHERE id=?').get(id);
    if (!row) fail(404, 'PAIRING_CHALLENGE_NOT_FOUND', 'Pairing challenge was not found');
    if (row.consumed_at) fail(409, 'PAIRING_CHALLENGE_CONSUMED', 'Pairing challenge was already consumed');
    const revokedAt = row.revoked_at ?? iso(this.#now());
    if (!row.revoked_at) this.#db.prepare('UPDATE pairing_challenges SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(revokedAt, id);
    return { challengeId: id, revoked: true, revokedAt };
  }

  approveChallenge(challengeId) {
    const id = nonempty(challengeId, 'challengeId', 256);
    const row = this.#db.prepare('SELECT * FROM pairing_challenges WHERE id=?').get(id);
    if (!row) fail(404, 'PAIRING_CHALLENGE_NOT_FOUND', 'Pairing challenge was not found');
    const nowMs = this.#now();
    if (row.consumed_at) fail(409, 'PAIRING_CHALLENGE_CONSUMED', 'Pairing challenge was already consumed');
    if (row.revoked_at) fail(410, 'PAIRING_CHALLENGE_REVOKED', 'Pairing challenge was revoked');
    if (expired(row.expires_at, nowMs)) fail(410, 'PAIRING_CHALLENGE_EXPIRED', 'Pairing challenge expired');
    const approvedAt = row.approved_at ?? iso(nowMs);
    if (!row.approved_at) this.#db.prepare('UPDATE pairing_challenges SET approved_at=? WHERE id=? AND approved_at IS NULL').run(approvedAt, id);
    return { challengeId: id, deviceLabel: row.device_label, expiresAt: row.expires_at, approvedAt };
  }

  /**
   * Two ways to complete (CONTRACTS Amendment 10):
   * - `{ challengeId, challengeCode }`: the QR / link secret (single use, bound to its challenge);
   * - `{ shortCode }`: the 6-digit manual fallback. A wrong guess counts against every challenge that
   *   could still be completed with a short code, so each one locks after MAX_ATTEMPTS wrong tries.
   */
  completePairing({ challengeId, challengeCode, shortCode } = {}) {
    if (shortCode !== undefined) {
      if (challengeId !== undefined || challengeCode !== undefined) {
        fail(400, 'INVALID_FIELD', 'shortCode cannot be combined with challengeId / challengeCode');
      }
      return this.#completeWithShortCode(shortCode);
    }
    const id = nonempty(challengeId, 'challengeId', 256);
    const code = nonempty(challengeCode, 'challengeCode', 256);
    const nowMs = this.#now();
    this.#db.exec('BEGIN IMMEDIATE');
    let transactionOpen = true;
    try {
      const row = this.#db.prepare('SELECT * FROM pairing_challenges WHERE id=?').get(id);
      if (!row) fail(401, 'PAIRING_CHALLENGE_INVALID', 'Pairing challenge is invalid');
      if (row.consumed_at || row.revoked_at) fail(401, 'PAIRING_CHALLENGE_INVALID', 'Pairing challenge is invalid');
      if (expired(row.expires_at, nowMs)) fail(410, 'PAIRING_CHALLENGE_EXPIRED', 'Pairing challenge expired');
      if (!row.approved_at) fail(409, 'PAIRING_APPROVAL_REQUIRED', 'Desktop approval is required before pairing completes');
      if (row.attempts >= MAX_ATTEMPTS) fail(429, 'PAIRING_ATTEMPTS_EXCEEDED', 'Pairing challenge attempt limit exceeded');
      if (!safeHashEqual(code, row.code_hash)) {
        this.#db.prepare('UPDATE pairing_challenges SET attempts=attempts+1 WHERE id=?').run(id);
        this.#db.exec('COMMIT');
        transactionOpen = false;
        fail(401, 'PAIRING_CHALLENGE_INVALID', 'Pairing challenge is invalid');
      }
      const result = this.#consume(row, nowMs);
      this.#db.exec('COMMIT');
      transactionOpen = false;
      return result;
    } catch (cause) {
      if (transactionOpen) this.#db.exec('ROLLBACK');
      throw cause;
    }
  }

  #completeWithShortCode(value) {
    if (typeof value !== 'string' || !SHORT_CODE.test(value.trim())) {
      fail(400, 'INVALID_FIELD', 'shortCode must be 6 digits');
    }
    const code = value.trim();
    const nowMs = this.#now();
    this.#db.exec('BEGIN IMMEDIATE');
    let transactionOpen = true;
    try {
      const candidates = this.#activeShortCodeRows(nowMs).filter((row) => row.approved_at);
      const open = candidates.filter((row) => row.attempts < MAX_ATTEMPTS);
      if (candidates.length && !open.length) fail(429, 'PAIRING_ATTEMPTS_EXCEEDED', 'Pairing challenge attempt limit exceeded');
      // Every open row is compared (no early exit), so timing does not reveal which challenge matched.
      let matched = null;
      for (const row of open) {
        if (safeHashEqual(shortCodeInput(row.id, code), row.short_code_hash) && !matched) matched = row;
      }
      if (!matched) {
        const bump = this.#db.prepare('UPDATE pairing_challenges SET attempts=attempts+1 WHERE id=?');
        for (const row of open) bump.run(row.id);
        this.#db.exec('COMMIT');
        transactionOpen = false;
        fail(401, 'PAIRING_CHALLENGE_INVALID', 'Pairing challenge is invalid');
      }
      const row = this.#db.prepare('SELECT * FROM pairing_challenges WHERE id=?').get(matched.id);
      const result = this.#consume(row, nowMs);
      this.#db.exec('COMMIT');
      transactionOpen = false;
      return result;
    } catch (cause) {
      if (transactionOpen) this.#db.exec('ROLLBACK');
      throw cause;
    }
  }

  /**
   * Marks the challenge consumed (its QR secret and 6-digit code die together), mints the phone's own session and
   * a single-use home-screen handoff token bound to that session (Amendment 13). Caller holds the transaction.
   */
  #consume(row, nowMs) {
    const createdAt = iso(nowMs);
    // Housekeeping: used or expired handoff rows are never needed again.
    this.#db.prepare('DELETE FROM pairing_handoffs WHERE consumed_at IS NOT NULL OR expires_at <= ?').run(createdAt);
    const consumed = this.#db.prepare('UPDATE pairing_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND revoked_at IS NULL').run(createdAt, row.id);
    if (consumed.changes !== 1) fail(401, 'PAIRING_CHALLENGE_INVALID', 'Pairing challenge is invalid');
    const minted = this.#mintSession(row.device_label, nowMs);
    return { ...minted, ...this.#mintHandoff(minted.session.id, nowMs) };
  }

  #mintHandoff(sessionId, nowMs) {
    const handoffToken = token();
    const handoffExpiresAt = iso(nowMs + this.#handoffTtlMs);
    this.#db.prepare('INSERT INTO pairing_handoffs(id,token_hash,session_id,expires_at,consumed_at,created_at) VALUES(?,?,?,?,NULL,?)')
      .run(this.#randomId(), hash(handoffToken), sessionId, handoffExpiresAt, iso(nowMs));
    return { handoffToken, handoffExpiresAt };
  }

  #mintSession(deviceLabel, nowMs, parentSessionId = null) {
    const sessionId = this.#randomId();
    const sessionToken = token();
    const csrfToken = deriveCsrfToken(sessionToken);
    const createdAt = iso(nowMs);
    const expiresAt = this.#sessionTtlMs === null ? SESSION_NEVER_EXPIRES : iso(nowMs + this.#sessionTtlMs);
    this.#db.prepare(`INSERT INTO paired_sessions
      (id,token_hash,csrf_hash,device_label,expires_at,revoked_at,created_at,last_seen_at,parent_session_id)
      VALUES(?,?,?,?,?,NULL,?,?,?)`)
      .run(sessionId, hash(sessionToken), hash(csrfToken), deviceLabel, expiresAt, createdAt, createdAt, parentSessionId);
    return { session: { id: sessionId, deviceLabel, expiresAt: publicExpiry(expiresAt) }, sessionToken, csrfToken, maxAgeSeconds: this.#cookieMaxAge(expiresAt, nowMs) };
  }

  #cookieMaxAge(expiresAt, nowMs) {
    if (expiresAt === SESSION_NEVER_EXPIRES) return MAX_SESSION_COOKIE_AGE_SECONDS;
    return Math.max(1, Math.min(MAX_SESSION_COOKIE_AGE_SECONDS, Math.floor((Date.parse(expiresAt) - nowMs) / 1000)));
  }

  /**
   * Amendment 13: a page opened from `?handoff=<token>` trades the token for its own session (child of the session
   * the token was issued to, so revoking the phone revokes it too). Single use, short-lived, hashed at rest, and only
   * while the parent session is still active. A wrong token never touches the pairing challenges' attempt counters.
   * - `standalone: true` (home-screen web app): label ` · 主畫面`, 「已加到主畫面」 marked, no further handoff.
   * - otherwise (a browser tab): same label, nothing marked, and a fresh handoff token for that tab, so adding it to
   *   the Home Screen afterwards still works.
   */
  redeemHandoff({ handoffToken, standalone = false } = {}) {
    if (typeof handoffToken !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(handoffToken)) {
      fail(400, 'INVALID_FIELD', 'handoffToken must be a token string');
    }
    if (typeof standalone !== 'boolean') fail(400, 'INVALID_FIELD', 'standalone must be a boolean');
    const nowMs = this.#now();
    this.#db.exec('BEGIN IMMEDIATE');
    let transactionOpen = true;
    try {
      const row = this.#db.prepare('SELECT * FROM pairing_handoffs WHERE token_hash=?').get(hash(handoffToken));
      if (!row || row.consumed_at) fail(401, 'PAIRING_HANDOFF_INVALID', 'Handoff token is invalid or already used');
      if (expired(row.expires_at, nowMs)) fail(410, 'PAIRING_HANDOFF_EXPIRED', 'Handoff token expired');
      const source = this.#db.prepare('SELECT device_label,revoked_at,expires_at FROM paired_sessions WHERE id=?').get(row.session_id);
      if (!source || source.revoked_at || sessionExpired(source.expires_at, nowMs)) {
        fail(401, 'PAIRING_HANDOFF_INVALID', 'Handoff token is invalid or already used');
      }
      const used = this.#db.prepare('UPDATE pairing_handoffs SET consumed_at=? WHERE id=? AND consumed_at IS NULL').run(iso(nowMs), row.id);
      if (used.changes !== 1) fail(401, 'PAIRING_HANDOFF_INVALID', 'Handoff token is invalid or already used');
      const label = derivedLabel(source.device_label, standalone ? HOME_SCREEN_LABEL_SUFFIX : BROWSER_TAB_LABEL_SUFFIX);
      const minted = this.#mintSession(label, nowMs, row.session_id);
      let result = minted;
      if (standalone) {
        // Launched as a home-screen web app: 「已加到主畫面」 is known at once.
        this.#db.prepare('UPDATE paired_sessions SET home_screen_at=? WHERE id=?').run(iso(nowMs), minted.session.id);
      } else {
        result = { ...minted, ...this.#mintHandoff(minted.session.id, nowMs) };
      }
      this.#db.exec('COMMIT');
      transactionOpen = false;
      return result;
    } catch (cause) {
      if (transactionOpen) this.#db.exec('ROLLBACK');
      throw cause;
    }
  }

  /** Amendment 13: the phone reports it runs as a home-screen web app (display-mode standalone). Idempotent. */
  markHomeScreen(sessionId) {
    const id = nonempty(sessionId, 'sessionId', 256);
    const row = this.#db.prepare('SELECT id,home_screen_at FROM paired_sessions WHERE id=?').get(id);
    if (!row) fail(404, 'SESSION_NOT_FOUND', 'Relay session was not found');
    const changed = !row.home_screen_at;
    const homeScreenAt = row.home_screen_at ?? iso(this.#now());
    if (changed) this.#db.prepare('UPDATE paired_sessions SET home_screen_at=? WHERE id=? AND home_screen_at IS NULL').run(homeScreenAt, id);
    return { sessionId: id, homeScreenAt, changed };
  }

  authenticate({ sessionToken, csrfToken = null, requireCsrf = false }) {
    if (typeof sessionToken !== 'string' || !sessionToken) fail(401, 'PAIRING_REQUIRED', 'A paired Relay session is required');
    const row = this.#db.prepare('SELECT * FROM paired_sessions WHERE token_hash=?').get(hash(sessionToken));
    const nowMs = this.#now();
    if (!row || row.revoked_at || sessionExpired(row.expires_at, nowMs)) fail(401, 'SESSION_INVALID', 'Relay session is expired or revoked');
    if (requireCsrf) {
      // The stored hash (sessions minted before Amendment 13 had a random token) or the derived token.
      const valid = typeof csrfToken === 'string' && csrfToken
        && (safeHashEqual(csrfToken, row.csrf_hash) || safeEqualText(csrfToken, deriveCsrfToken(sessionToken)));
      if (!valid) fail(403, 'CSRF_INVALID', 'A valid Relay CSRF token is required');
    }
    this.#db.prepare('UPDATE paired_sessions SET last_seen_at=? WHERE id=?').run(iso(nowMs), row.id);
    return Object.freeze({
      principalId: `paired-session:${row.id}`,
      principalType: 'human',
      roles: Object.freeze(['H']),
      sessionId: row.id,
      deviceLabel: row.device_label,
      source: 'relay-pairing',
    });
  }

  /**
   * Amendment 13: for a valid session cookie, the CSRF token to use again (derived, not rotated) and the cookie
   * Max-Age to re-issue it with (sliding). Throws 401 SESSION_INVALID / PAIRING_REQUIRED like authenticate().
   */
  sessionRenewal(sessionToken) {
    const principal = this.authenticate({ sessionToken });
    const row = this.#db.prepare('SELECT expires_at FROM paired_sessions WHERE id=?').get(principal.sessionId);
    return {
      sessionId: principal.sessionId,
      csrfToken: deriveCsrfToken(sessionToken),
      maxAgeSeconds: this.#cookieMaxAge(row.expires_at, this.#now()),
    };
  }

  /** DBG-05: true while the session exists, is not revoked and has not expired (no side effects). */
  isSessionActive(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const row = this.#db.prepare('SELECT revoked_at,expires_at FROM paired_sessions WHERE id=?').get(sessionId);
    return Boolean(row && !row.revoked_at && !sessionExpired(row.expires_at, this.#now()));
  }

  /**
   * Revokes a session and voids its outstanding handoff tokens. Amendment 13: with `cascade` (default; removal on
   * the PC) every session derived from it through a handoff (e.g. 「我的手機 · 主畫面」, at any depth) goes too.
   * A phone logging itself out passes `cascade: false`: only that browser tab / web app session ends.
   */
  revokeSession(sessionId, { cascade = true } = {}) {
    const id = nonempty(sessionId, 'sessionId', 256);
    const row = this.#db.prepare('SELECT id,revoked_at FROM paired_sessions WHERE id=?').get(id);
    if (!row) fail(404, 'SESSION_NOT_FOUND', 'Relay session was not found');
    const nowIso = iso(this.#now());
    const children = this.#db.prepare('SELECT id FROM paired_sessions WHERE parent_session_id=?');
    const revoke = this.#db.prepare('UPDATE paired_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL');
    const voidHandoffs = this.#db.prepare('UPDATE pairing_handoffs SET consumed_at=? WHERE session_id=? AND consumed_at IS NULL');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const seen = new Set();
      const queue = [id];
      while (queue.length) {
        const current = queue.shift();
        if (seen.has(current)) continue;
        seen.add(current);
        revoke.run(nowIso, current);
        voidHandoffs.run(nowIso, current);
        if (cascade) for (const child of children.all(current)) queue.push(child.id);
      }
      this.#db.exec('COMMIT');
    } catch (cause) {
      this.#db.exec('ROLLBACK');
      throw cause;
    }
    return { sessionId: id, revoked: true };
  }

  /**
   * Amendment 13: turning mobile access off pauses paired phones (their sessions stay and work again once it is
   * turned back on) but voids every outstanding handoff token. Returns how many were voided.
   */
  voidOutstandingHandoffs() {
    return Number(this.#db.prepare('UPDATE pairing_handoffs SET consumed_at=? WHERE consumed_at IS NULL').run(iso(this.#now())).changes);
  }

  listSessions() {
    return this.#db.prepare('SELECT id,device_label,expires_at,revoked_at,created_at,last_seen_at,home_screen_at,parent_session_id FROM paired_sessions ORDER BY created_at DESC').all()
      .map(sessionView);
  }

  getSession(sessionId) {
    const id = nonempty(sessionId, 'sessionId', 256);
    const row = this.#db.prepare('SELECT id,device_label,expires_at,revoked_at,created_at,last_seen_at,home_screen_at,parent_session_id FROM paired_sessions WHERE id=?').get(id);
    if (!row) fail(404, 'SESSION_NOT_FOUND', 'Relay session was not found');
    return sessionView(row);
  }

  listPendingChallenges() {
    const nowMs = this.#now();
    return this.#db.prepare('SELECT id,device_label,expires_at,approved_at,created_at FROM pairing_challenges WHERE consumed_at IS NULL AND revoked_at IS NULL ORDER BY created_at ASC').all()
      .filter((row) => !expired(row.expires_at, nowMs))
      .map((row) => ({ challengeId: row.id, deviceLabel: row.device_label, expiresAt: row.expires_at,
        approved: Boolean(row.approved_at), createdAt: row.created_at }));
  }

  pairingState() {
    const nowMs = this.#now();
    const sessions = this.#db.prepare('SELECT expires_at,revoked_at FROM paired_sessions').all();
    if (sessions.some((row) => !row.revoked_at && !sessionExpired(row.expires_at, nowMs))) return 'paired';
    const challenges = this.#db.prepare('SELECT expires_at,consumed_at,revoked_at FROM pairing_challenges').all();
    if (challenges.some((row) => !row.consumed_at && !row.revoked_at && !expired(row.expires_at, nowMs))) return 'pending';
    return 'unpaired';
  }
}