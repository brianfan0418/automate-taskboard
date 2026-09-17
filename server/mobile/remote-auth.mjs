// Request boundary + paired-session authorization for v2 mobile access.
// Replaces fork server/mobile-remote-api-auth.mjs (Serve-origin based) and the boundary helpers of
// fork server/mobile-pairing-http-router.mjs. v2 remote origin = http://<tailnet IPv4>:<port>.
import { ApiError } from "../../shared/api-fields.mjs";
import { MOBILE_CSRF_HEADER, MOBILE_SESSION_COOKIE } from "../../shared/mobile-access-contract.mjs";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function fail(status, code, message) {
  throw new ApiError(status, code, message);
}

/** Loopback detection by socket address only (C7 / T5): 127.0.0.1, ::1, ::ffff:127.0.0.1. */
export function isLoopbackAddress(address) {
  return typeof address === "string" && LOOPBACK_ADDRESSES.has(address);
}

/** Missing socket information counts as remote (fail closed). */
export function isRemoteRequest(request) {
  return !isLoopbackAddress(request?.socket?.remoteAddress);
}

export function isLocalHostHeader(value) {
  if (typeof value !== "string" || !value || value !== value.trim()) return false;
  try {
    const hostname = new URL(`http://${value}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

/** Loopback socket AND a local Host header (DNS-rebinding guard kept from the fork). */
export function assertLocalRequest(request, message = "This endpoint is only available on this device") {
  if (!isLoopbackAddress(request?.socket?.remoteAddress) || !isLocalHostHeader(request?.headers?.host)) {
    fail(403, "LOCAL_ONLY", message);
  }
}

export function parseCookies(header) {
  const values = new Map();
  for (const part of String(header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    values.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return values;
}

function cookieSuffix(origin) {
  // `Secure` cookies are rejected by browsers on plain-http origins; the tailnet origin is http
  // (WireGuard-encrypted transport). Keep Secure only if an https origin is ever configured.
  return `Path=/; HttpOnly; SameSite=Strict${origin?.startsWith("https:") ? "; Secure" : ""}`;
}

export function sessionCookie(token, maxAgeSeconds, origin) {
  return `${MOBILE_SESSION_COOKIE}=${token}; Max-Age=${maxAgeSeconds}; ${cookieSuffix(origin)}`;
}

export function clearSessionCookie(origin) {
  return `${MOBILE_SESSION_COOKIE}=; Max-Age=0; ${cookieSuffix(origin)}`;
}

/**
 * Amendment 13: sliding refresh. For a request carrying a valid paired session cookie on the trusted tailnet
 * origin, the Set-Cookie value that re-issues the same token with a fresh Max-Age; null otherwise. Never throws.
 */
export function refreshedSessionCookie(service, request, trustedOrigins) {
  try {
    const origin = assertRemoteBoundary(request, trustedOrigins);
    const token = parseCookies(request.headers.cookie).get(MOBILE_SESSION_COOKIE);
    if (!token) return null;
    const renewal = service.sessionRenewal(token);
    return sessionCookie(token, renewal.maxAgeSeconds, origin);
  } catch {
    return null;
  }
}

/**
 * Validates Host (and Origin when present / required) against the exact trusted remote origins.
 * @returns {string} the matched trusted origin
 */
export function assertRemoteBoundary(request, trustedOrigins, { requireOrigin = false } = {}) {
  const host = request?.headers?.host;
  if (typeof host !== "string" || !host || host !== host.trim()) {
    fail(403, "INVALID_HOST", "Request Host is not the approved Relay mobile origin");
  }
  let matched = null;
  for (const origin of trustedOrigins) {
    let trusted;
    try { trusted = new URL(origin); } catch { continue; }
    let candidate;
    try { candidate = new URL(`${trusted.protocol}//${host}`); } catch { continue; }
    if (candidate.username || candidate.password || candidate.pathname !== "/" || candidate.search || candidate.hash) continue;
    if (candidate.origin === trusted.origin) {
      matched = trusted.origin;
      break;
    }
  }
  if (!matched) fail(403, "INVALID_HOST", "Request Host is not the approved Relay mobile origin");
  const origin = request.headers.origin;
  if (requireOrigin && !origin) fail(403, "INVALID_ORIGIN", "Request Origin is required");
  if (origin && origin !== matched) fail(403, "INVALID_ORIGIN", "Request Origin must match the approved Relay mobile origin");
  return matched;
}

/**
 * Authenticates a remote request's paired session (cookie + CSRF header for unsafe methods).
 * Throws ApiError on any failure.
 */
export function sessionFromRequest(service, request, trustedOrigins, { csrf = null } = {}) {
  const requireCsrf = csrf ?? !SAFE_METHODS.has(String(request?.method ?? "GET").toUpperCase());
  assertRemoteBoundary(request, trustedOrigins, { requireOrigin: requireCsrf });
  const token = parseCookies(request.headers.cookie).get(MOBILE_SESSION_COOKIE);
  return service.authenticate({
    sessionToken: token,
    csrfToken: request.headers[MOBILE_CSRF_HEADER],
    requireCsrf,
  });
}

/**
 * C7 `authorize(request) → Principal | null`. Never throws: every failure (disabled, wrong Host/Origin,
 * missing/expired/revoked session, missing CSRF on writes) returns null so the integrator answers
 * 401 PAIRING_REQUIRED.
 */
export function createRemoteAuthorizer({ service, trustedOrigins, isEnabled, logger = null }) {
  if (!service || typeof service.authenticate !== "function") throw new TypeError("Mobile pairing service is required");
  if (typeof trustedOrigins !== "function") throw new TypeError("trustedOrigins must be a function");
  if (typeof isEnabled !== "function") throw new TypeError("isEnabled must be a function");
  return function authorize(request) {
    if (!isEnabled()) return null;
    try {
      return sessionFromRequest(service, request, trustedOrigins());
    } catch (error) {
      if (!(error instanceof ApiError)) {
        logger?.error?.(`[mobile-access] authorization failed unexpectedly: ${error?.message ?? error}`);
      }
      return null;
    }
  };
}
