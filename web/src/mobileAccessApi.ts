import { ApiError, resolveTaskboardUrl } from "./api";
import { newClientId } from "./clientId";

/**
 * Client for the C7 mobile-access surface, consumed by
 * `components/MobileAccessSettings.tsx`.
 *
 * Routes used that ARE defined in C7:
 *   GET/PUT  /api/local/mobile-access                       (loopback only)
 *   POST     /api/local/pairing/challenges                  (loopback only)
 *   POST     /api/local/pairing/challenges/:id/approve       (loopback only)
 *   DELETE   /api/local/pairing/challenges/:id               (loopback only; Amendment 10 revoke)
 *   POST     /api/pairing/complete                           (remote; the phone completes pairing with the
 *            QR secret `{ challengeId, challengeCode }` or the 6-digit fallback `{ shortCode }`)
 *   DELETE   /api/sessions/:id                                (loopback or the device's own paired session)
 *
 * `listPairedDevices()` calls `GET /api/local/pairing/sessions`, which C7 does NOT define
 * (C7 only defines GET/DELETE /api/sessions/:id, i.e. lookup/revoke by an already-known id —
 * there is no route to enumerate paired devices). This is flagged as an
 * integration requirement. The underlying data already exists
 * server-side (fork `MobilePairingService#listSessions()`, ported by T5), so this only needs
 * a thin route added by the integrator. Until that route exists, callers should treat a 404
 * from this method as "not available yet" rather than a hard failure (see
 * MobileAccessSettings.tsx's handling of ApiError with status 404).
 *
 * CSRF: once a phone completes `/api/pairing/complete`, further state-changing requests from
 * that phone (e.g. `revokeDevice`) must carry the `X-Relay-CSRF` header alongside the paired
 * session cookie, per C7's session model. `getRelayCsrfToken`/`setRelayCsrfToken` persist the
 * token in `sessionStorage` (ported unchanged from fork `mobileAccessApi.ts`); `mobileRequest`
 * attaches it to non-GET/HEAD requests automatically.
 */

export const RELAY_CSRF_STORAGE_KEY = "relay-taskboard.mobile.csrf";

// Amendment 13 (W12-C): the paired session lives 180 days, so its CSRF token is kept in localStorage as well
// (a home-screen web app relaunch starts with an empty sessionStorage). sessionStorage stays the first choice.
export function getRelayCsrfToken(): string | null {
  for (const storage of csrfStorages()) {
    try {
      const value = storage().getItem(RELAY_CSRF_STORAGE_KEY);
      if (value) return value;
    } catch {
      // Try the next storage.
    }
  }
  return null;
}

export function setRelayCsrfToken(value: string | null): void {
  for (const storage of csrfStorages()) {
    try {
      if (value) storage().setItem(RELAY_CSRF_STORAGE_KEY, value);
      else storage().removeItem(RELAY_CSRF_STORAGE_KEY);
    } catch {
      // Storage is an enhancement; the paired HttpOnly session cookie remains authoritative.
    }
  }
}

function csrfStorages(): Array<() => Storage> {
  return [() => window.sessionStorage, () => window.localStorage];
}

export interface MobileAccessInspection {
  enabled: boolean;
  url: string | null;
  tailnetAddress: string | null;
  reason?: string;
}

export interface PairingChallenge {
  challengeId: string;
  /** One-time QR / link secret (Amendment 10): carried only in the link's `#pair=` fragment. */
  challengeCode: string;
  /** 6-digit manual fallback code, shown large on the desktop. */
  shortCode: string;
  deviceLabel: string;
  expiresAt: string;
  approved: boolean;
  approvedAt: string | null;
}

export interface ChallengeApproval {
  challengeId: string;
  deviceLabel: string;
  expiresAt: string;
  approvedAt: string;
}

export interface PairingCompletionResult {
  /** `expiresAt` is null for a permanent pairing (Amendment 13). */
  session: { id: string; deviceLabel: string; expiresAt: string | null };
  csrfToken: string;
  /**
   * Amendment 13: single-use handoff token (15 min) for adding this page to the Home Screen. Returned by pairing and by
   * a browser-tab handoff redemption (`standalone: false`); absent when a home-screen web app redeems (`standalone: true`).
   */
  handoffToken?: string;
  handoffExpiresAt?: string;
}

/** Amendment 13: `GET /api/local/mobile-access/tailscale` (loopback only). */
export interface TailscaleStatus {
  installed: boolean;
  running: boolean;
  loginName: string | null;
  tailnetAddress: string | null;
  mobilePeers: Array<{ id: string; hostName: string; os: string; online: boolean }>;
}

export interface PairedDeviceSession {
  id: string;
  deviceLabel: string;
  /** null = never expires (Amendment 13: valid until removed on the PC). */
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  lastSeenAt: string;
  /** Amendment 13: set once the phone reported running as a home-screen web app. */
  homeScreenAt?: string | null;
  /** Amendment 13: the session this one was derived from through a handoff (null for a pairing). */
  parentSessionId?: string | null;
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

async function mobileRequest<T>(
  path: string,
  init: RequestInit = {},
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const csrf = getRelayCsrfToken();
  const method = (init.method ?? "GET").toUpperCase();
  if (csrf && method !== "GET" && method !== "HEAD") headers.set("X-Relay-CSRF", csrf);
  let response: Response;
  try {
    response = await fetcher(resolveTaskboardUrl(path), { ...init, headers, credentials: "same-origin" });
  } catch (error) {
    throw new ApiError(0, {
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: error instanceof Error ? error.message : "Service unavailable",
      },
    });
  }
  let body: T & ErrorBody;
  try {
    body = (await response.json()) as T & ErrorBody;
  } catch {
    body = {} as T & ErrorBody;
  }
  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

export interface MobileAccessApi {
  inspect(signal?: AbortSignal): Promise<MobileAccessInspection>;
  setEnabled(enabled: boolean): Promise<MobileAccessInspection>;
  createChallenge(deviceLabel: string): Promise<PairingChallenge>;
  approveChallenge(challengeId: string): Promise<ChallengeApproval>;
  /** Desktop cancels a challenge: its QR link and 6-digit code stop working. */
  revokeChallenge(challengeId: string): Promise<{ challengeId: string; revoked: boolean }>;
  /** Called by the phone after scanning/opening the pairing link. Stores the returned CSRF token. */
  completePairing(challengeId: string, challengeCode: string): Promise<PairingCompletionResult>;
  /** Manual fallback: the 6-digit code shown on the desktop. Stores the returned CSRF token. */
  completePairingWithShortCode(shortCode: string): Promise<PairingCompletionResult>;
  /**
   * Amendment 13: trade a `?handoff=` token for this page's own session (stores the CSRF token). `standalone` marks
   * a home-screen web app; a browser tab gets a fresh `handoffToken` back instead.
   */
  redeemHandoff(handoffToken: string, standalone: boolean): Promise<PairingCompletionResult>;
  /** Amendment 13: `on` or `paused` (mobile access turned off on the PC; paired phones keep their pairing). */
  availability(): Promise<{ mobileAccess: "on" | "paused" }>;
  /** Amendment 13: recover the CSRF token from the HttpOnly session cookie (stores it). */
  refreshCsrf(): Promise<{ sessionId: string; csrfToken: string }>;
  /** Amendment 13: this paired phone runs as a home-screen web app. */
  reportHomeScreen(): Promise<{ sessionId: string; homeScreenAt: string }>;
  /** Amendment 13: desktop wizard reads Tailscale state and phone peers. */
  tailscaleStatus(signal?: AbortSignal): Promise<TailscaleStatus>;
  /** See file header: this route is not yet defined in C7 (INTEGRATION_REQUIREMENT). */
  listPairedDevices(signal?: AbortSignal): Promise<PairedDeviceSession[]>;
  revokeDevice(sessionId: string): Promise<{ sessionId: string; revoked: boolean }>;
}

// The global fetch is looked up per request (not when the module loads), so a client created at import time follows
// the current global (tests stub it after import).
export function createMobileAccessApi(fetcher: typeof fetch = (input, init) => fetch(input, init)): MobileAccessApi {
  return Object.freeze({
    inspect(signal?: AbortSignal) {
      return mobileRequest<MobileAccessInspection>("/api/local/mobile-access", { signal }, fetcher);
    },
    setEnabled(enabled: boolean) {
      return mobileRequest<MobileAccessInspection>("/api/local/mobile-access", {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      }, fetcher);
    },
    async createChallenge(deviceLabel: string) {
      const raw = await mobileRequest<Omit<PairingChallenge, "approvedAt">>("/api/local/pairing/challenges", {
        method: "POST",
        body: JSON.stringify({ requestKey: newClientId(), deviceLabel }),
      }, fetcher);
      return { ...raw, approvedAt: null };
    },
    approveChallenge(challengeId: string) {
      return mobileRequest<ChallengeApproval>(
        `/api/local/pairing/challenges/${encodeURIComponent(challengeId)}/approve`,
        { method: "POST" },
        fetcher,
      );
    },
    revokeChallenge(challengeId: string) {
      return mobileRequest<{ challengeId: string; revoked: boolean }>(
        `/api/local/pairing/challenges/${encodeURIComponent(challengeId)}`,
        { method: "DELETE" },
        fetcher,
      );
    },
    async completePairing(challengeId: string, challengeCode: string) {
      const result = await mobileRequest<PairingCompletionResult>(
        "/api/pairing/complete",
        { method: "POST", body: JSON.stringify({ challengeId, challengeCode }) },
        fetcher,
      );
      setRelayCsrfToken(result.csrfToken);
      return result;
    },
    async completePairingWithShortCode(shortCode: string) {
      const result = await mobileRequest<PairingCompletionResult>(
        "/api/pairing/complete",
        { method: "POST", body: JSON.stringify({ shortCode }) },
        fetcher,
      );
      setRelayCsrfToken(result.csrfToken);
      return result;
    },
    async redeemHandoff(handoffToken: string, standalone: boolean) {
      const result = await mobileRequest<PairingCompletionResult>(
        "/api/pairing/handoff",
        { method: "POST", body: JSON.stringify({ handoffToken, standalone }) },
        fetcher,
      );
      setRelayCsrfToken(result.csrfToken);
      return result;
    },
    availability() {
      return mobileRequest<{ mobileAccess: "on" | "paused" }>("/api/pairing/availability", {}, fetcher);
    },
    async refreshCsrf() {
      const result = await mobileRequest<{ sessionId: string; csrfToken: string }>(
        "/api/pairing/csrf",
        { method: "POST" },
        fetcher,
      );
      setRelayCsrfToken(result.csrfToken);
      return result;
    },
    reportHomeScreen() {
      return mobileRequest<{ sessionId: string; homeScreenAt: string }>(
        "/api/pairing/home-screen",
        { method: "POST", body: "{}" },
        fetcher,
      );
    },
    tailscaleStatus(signal?: AbortSignal) {
      return mobileRequest<TailscaleStatus>("/api/local/mobile-access/tailscale", { signal }, fetcher);
    },
    async listPairedDevices(signal?: AbortSignal) {
      const data = await mobileRequest<{ sessions: PairedDeviceSession[] }>(
        "/api/local/pairing/sessions",
        { signal },
        fetcher,
      );
      return data.sessions;
    },
    revokeDevice(sessionId: string) {
      return mobileRequest<{ sessionId: string; revoked: boolean }>(
        `/api/sessions/${encodeURIComponent(sessionId)}`,
        { method: "DELETE" },
        fetcher,
      );
    },
  });
}
