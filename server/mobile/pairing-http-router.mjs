// Pairing routes (C7). Ported from fork server/mobile-pairing-http-router.mjs (HEAD dae7302):
// - no instance-token / localAuthorizer gate: local = loopback socket + local Host header
// - remote boundary = exact http tailnet origin (no Serve HTTPS origin)
// - adds GET /api/sessions/:id; routes refuse remote use while mobile access is disabled
import { ApiError } from "../../shared/api-fields.mjs";
import { MOBILE_SESSION_COOKIE } from "../../shared/mobile-access-contract.mjs";
import {
  assertLocalRequest,
  assertRemoteBoundary,
  clearSessionCookie,
  isLoopbackAddress,
  isLocalHostHeader,
  parseCookies,
  sessionCookie,
  sessionFromRequest,
} from "./remote-auth.mjs";

const JSON_BODY_LIMIT = 64 * 1024;

function fail(status, code, message) {
  throw new ApiError(status, code, message);
}

function assertNoQuery(url, label) {
  if ([...url.searchParams.keys()].length) fail(400, "UNKNOWN_QUERY_PARAMETER", `${label} does not accept query parameters`);
}

function decodeSegment(value, label) {
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { fail(400, "INVALID_PATH", `${label} contains invalid encoding`); }
  if (!decoded || decoded.length > 256 || decoded.includes("\0")) fail(400, "INVALID_PATH", `${label} is invalid`);
  return decoded;
}

export async function readJsonBody(request, { limit = JSON_BODY_LIMIT, label = "Request" } = {}) {
  const type = request.headers?.["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  if (type !== "application/json") fail(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > limit) fail(413, "BODY_TOO_LARGE", `${label} JSON cannot exceed 64 KiB`);
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) fail(413, "BODY_TOO_LARGE", `${label} JSON cannot exceed 64 KiB`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) fail(400, "INVALID_JSON", "Request body cannot be empty");
  try { return JSON.parse(text); } catch { fail(400, "INVALID_JSON", "Request body must be valid JSON"); }
}

function plain(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "INVALID_BODY", "Request body must be a JSON object");
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) fail(400, "UNKNOWN_FIELD", `Unknown field(s): ${unknown.join(", ")}`);
  return body;
}

function isLocalRequest(request) {
  return isLoopbackAddress(request.socket?.remoteAddress) && isLocalHostHeader(request.headers?.host);
}

/**
 * @param {{ service, trustedOrigins: () => Iterable<string>, isEnabled: () => boolean }} options
 * `match(request, url)` → null (not a pairing route) | { allowedMethods } | { status?, headers?, result, changed? }
 * Throws ApiError for rejected requests on a pairing route.
 */
export function createMobilePairingHttpRouter({ service, trustedOrigins, isEnabled } = {}) {
  if (!service || typeof service.createChallenge !== "function") throw new TypeError("Mobile pairing service is required");
  if (typeof trustedOrigins !== "function") throw new TypeError("trustedOrigins must be a function");
  if (typeof isEnabled !== "function") throw new TypeError("isEnabled must be a function");

  function assertRemoteEnabled() {
    if (!isEnabled()) fail(403, "MOBILE_ACCESS_DISABLED", "Mobile access is turned off on this PC");
  }

  return Object.freeze({
    async match(request, url) {
      const pathname = url.pathname;

      if (pathname === "/api/local/pairing/challenges") {
        if (request.method !== "POST") return { allowedMethods: ["POST"] };
        assertNoQuery(url, "Pairing challenge");
        assertLocalRequest(request);
        const body = plain(await readJsonBody(request, { label: "Pairing" }), ["requestKey", "deviceLabel"]);
        return { status: 201, result: service.createChallenge(body), changed: true };
      }

      let match = pathname.match(/^\/api\/local\/pairing\/challenges\/([^/]+)$/);
      if (match) {
        if (request.method !== "DELETE") return { allowedMethods: ["DELETE"] };
        assertNoQuery(url, "Pairing challenge revoke");
        assertLocalRequest(request);
        const challengeId = decodeSegment(match[1], "challengeId");
        return { result: service.revokeChallenge(challengeId), changed: true };
      }

      match = pathname.match(/^\/api\/local\/pairing\/challenges\/([^/]+)\/approve$/);
      if (match) {
        if (request.method !== "POST") return { allowedMethods: ["POST"] };
        assertNoQuery(url, "Pairing approval");
        assertLocalRequest(request);
        const challengeId = decodeSegment(match[1], "challengeId");
        return { result: service.approveChallenge(challengeId), changed: true };
      }

      if (pathname === "/api/pairing/complete") {
        if (request.method !== "POST") return { allowedMethods: ["POST"] };
        assertNoQuery(url, "Pairing completion");
        assertRemoteEnabled();
        const origin = assertRemoteBoundary(request, trustedOrigins(), { requireOrigin: true });
        const body = plain(await readJsonBody(request, { label: "Pairing" }), ["challengeId", "challengeCode", "shortCode"]);
        const completed = service.completePairing(body);
        const maxAge = Math.max(1, completed.maxAgeSeconds);
        return {
          status: 201,
          headers: { "set-cookie": sessionCookie(completed.sessionToken, maxAge, origin) },
          // Amendment 13: the single-use handoff token goes into the phone's address bar (?handoff=) so a
          // home-screen web app saved from it can obtain its own session.
          result: {
            session: completed.session,
            csrfToken: completed.csrfToken,
            handoffToken: completed.handoffToken,
            handoffExpiresAt: completed.handoffExpiresAt,
          },
          changed: true,
        };
      }

      // Amendment 13: home-screen web app trades its single-use handoff token for its own session.
      if (pathname === "/api/pairing/handoff") {
        if (request.method !== "POST") return { allowedMethods: ["POST"] };
        assertNoQuery(url, "Pairing handoff");
        assertRemoteEnabled();
        const origin = assertRemoteBoundary(request, trustedOrigins(), { requireOrigin: true });
        const body = plain(await readJsonBody(request, { label: "Pairing" }), ["handoffToken", "standalone"]);
        const redeemed = service.redeemHandoff(body);
        return {
          status: 201,
          headers: { "set-cookie": sessionCookie(redeemed.sessionToken, Math.max(1, redeemed.maxAgeSeconds), origin) },
          result: {
            session: redeemed.session,
            csrfToken: redeemed.csrfToken,
            ...(redeemed.handoffToken ? { handoffToken: redeemed.handoffToken, handoffExpiresAt: redeemed.handoffExpiresAt } : {}),
          },
          changed: true,
        };
      }

      // Amendment 13: lets an unpaired-looking phone page tell 「電腦已暫停手機存取」 from 「需要配對」. No secrets; only
      // reachable where pairing routes are (loopback, or the tailnet origin — whose listener is closed while paused
      // in the packaged app, so a paused phone usually cannot reach the PC at all).
      if (pathname === "/api/pairing/availability") {
        if (request.method !== "GET") return { allowedMethods: ["GET"] };
        assertNoQuery(url, "Mobile access availability");
        return { result: { mobileAccess: isEnabled() ? "on" : "paused" } };
      }

      // Amendment 13: recover the CSRF token from the HttpOnly session cookie (script storage may have been cleared,
      // e.g. iOS ITP's 7-day cap in Safari). Same token as issued at pairing (derived, not rotated); the cookie is
      // re-issued. Needs the exact tailnet Host and Origin; the SameSite=Strict cookie is not sent cross-site.
      if (pathname === "/api/pairing/csrf") {
        if (request.method !== "POST") return { allowedMethods: ["POST"] };
        assertNoQuery(url, "CSRF recovery");
        assertRemoteEnabled();
        const origin = assertRemoteBoundary(request, trustedOrigins(), { requireOrigin: true });
        const token = parseCookies(request.headers?.cookie).get(MOBILE_SESSION_COOKIE);
        const renewal = service.sessionRenewal(token);
        return {
          headers: { "set-cookie": sessionCookie(token, renewal.maxAgeSeconds, origin) },
          result: { sessionId: renewal.sessionId, csrfToken: renewal.csrfToken },
        };
      }

      // Amendment 13: a paired phone running as a home-screen web app (display-mode standalone) reports it,
      // so the desktop wizard ticks 「已加到主畫面」. Needs the phone's own session + CSRF.
      if (pathname === "/api/pairing/home-screen") {
        if (request.method !== "POST") return { allowedMethods: ["POST"] };
        assertNoQuery(url, "Home screen report");
        assertRemoteEnabled();
        const principal = sessionFromRequest(service, request, trustedOrigins());
        const marked = service.markHomeScreen(principal.sessionId);
        return { result: { sessionId: marked.sessionId, homeScreenAt: marked.homeScreenAt }, changed: marked.changed };
      }

      match = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (match) {
        if (request.method !== "GET" && request.method !== "DELETE") return { allowedMethods: ["GET", "DELETE"] };
        assertNoQuery(url, "Relay session");
        const sessionId = decodeSegment(match[1], "sessionId");
        const local = isLocalRequest(request);
        let origin = null;
        if (!local) {
          assertRemoteEnabled();
          const principal = sessionFromRequest(service, request, trustedOrigins());
          if (principal.sessionId !== sessionId) fail(403, "FORBIDDEN", "A remote device may only access its own Relay session");
          origin = assertRemoteBoundary(request, trustedOrigins());
        }
        if (request.method === "GET") {
          return { result: { session: service.getSession(sessionId) } };
        }
        // Removal on the PC cascades to derived sessions; a phone logging itself out ends only its own session.
        const result = service.revokeSession(sessionId, { cascade: local });
        return {
          result,
          ...(local ? {} : { headers: { "set-cookie": clearSessionCookie(origin) } }),
          changed: true,
        };
      }

      return null;
    },
  });
}
