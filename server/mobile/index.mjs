// v2 mobile access (CONTRACTS C7): pairing + paired-session authorization + tailnet address,
// without Tailscale Serve and without the fork's `schema.mode === "contract"` gate.
import path from "node:path";

import { ApiError } from "../../shared/api-fields.mjs";
import {
  MOBILE_ACCESS_EVENT,
  MOBILE_ACCESS_SETTINGS_FILE,
  buildMobileAccessUrl,
  mobileAccessView,
} from "../../shared/mobile-access-contract.mjs";
import { createMobileAccessHttpRouter } from "./access-http-router.mjs";
import { createMobilePairingHttpRouter } from "./pairing-http-router.mjs";
import { migrateMobilePairingSchema } from "./pairing-schema.mjs";
import { MobilePairingService } from "./pairing-service.mjs";
import {
  assertRemoteBoundary,
  createRemoteAuthorizer,
  refreshedSessionCookie,
  isRemoteRequest as isRemoteSocketRequest,
} from "./remote-auth.mjs";
import { createMobileAccessSettingsStore } from "./settings.mjs";
import { createTailnetResolver } from "./tailnet.mjs";

function rawDatabaseHandle(database, db) {
  const candidate = db ?? (typeof database?.prepare === "function" ? database : database?.database);
  if (!candidate || typeof candidate.prepare !== "function" || typeof candidate.exec !== "function") {
    throw new TypeError("createMobileAccess requires a TaskboardDatabase (with .database) or a DatabaseSync handle");
  }
  return candidate;
}

function sendJson(response, status, value, headers = {}) {
  if (response.headersSent || response.writableEnded) return;
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "private, no-store",
    ...headers,
  });
  response.end(body);
}

function originOf(url) {
  if (typeof url !== "string" || !url) return null;
  try { return new URL(url).origin; } catch { return null; }
}

/**
 * @param {object} options
 * @param {object} options.database      TaskboardDatabase (uses its public `.database` DatabaseSync) or a DatabaseSync
 * @param {string} options.dataDirectory settings live at <dataDirectory>/mobile-access.json
 * @param {number} options.port          board HTTP port used for the phone URL
 * @param {object} [options.emitHub]     EventHub-compatible `{ emit(type, payload) }`
 * @param {object} [options.logger]
 * Local injectables (tests / integrator): db, execFile, existsSync, tailscaleExecutable,
 * tailscaleTimeoutMs, settingsPath, settingsFs, pairingServiceOptions.
 */
export function createMobileAccess({
  database,
  dataDirectory,
  port,
  emitHub = null,
  logger = null,
  db = null,
  execFile,
  existsSync,
  tailscaleExecutable = null,
  tailscaleTimeoutMs,
  settingsPath = null,
  settingsFs,
  pairingServiceOptions = {},
} = {}) {
  const raw = rawDatabaseHandle(database, db);
  if (!settingsPath && (typeof dataDirectory !== "string" || !dataDirectory)) {
    throw new TypeError("dataDirectory is required");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("port must be an integer from 1 to 65535");

  migrateMobilePairingSchema(raw);
  const service = new MobilePairingService(raw, pairingServiceOptions);
  const store = createMobileAccessSettingsStore({
    configPath: settingsPath ?? path.join(dataDirectory, MOBILE_ACCESS_SETTINGS_FILE),
    logger,
    ...(settingsFs ? { fs: settingsFs } : {}),
  });
  const tailnet = createTailnetResolver({
    ...(execFile ? { execFile } : {}),
    ...(existsSync ? { existsSync } : {}),
    executable: tailscaleExecutable,
    ...(tailscaleTimeoutMs ? { timeoutMs: tailscaleTimeoutMs } : {}),
    logger,
  });
  let closed = false;

  const isEnabled = () => !closed && store.read().enabled;

  function trustedOrigins() {
    const current = store.read();
    const origins = new Set();
    if (closed || !current.enabled) return origins;
    const persisted = originOf(current.url);
    if (persisted) origins.add(persisted);
    const live = originOf(buildMobileAccessUrl(tailnet.cached(), port));
    if (live) origins.add(live);
    return origins;
  }

  function syncUrl(address) {
    const current = store.read();
    if (address && current.enabled) {
      const url = buildMobileAccessUrl(address, port);
      if (url && url !== current.url) {
        store.write({ enabled: true, url });
        logger?.info?.("[mobile-access] tailnet address changed; phone URL updated");
      }
    }
    return address;
  }

  async function tailnetAddress() {
    return syncUrl(await tailnet.resolve());
  }

  async function inspect(resolvedAddress) {
    const address = resolvedAddress === undefined ? await tailnetAddress() : syncUrl(resolvedAddress);
    const current = store.read();
    return mobileAccessView({
      enabled: current.enabled,
      url: current.url,
      tailnetAddress: address,
      pairing: service.pairingState(),
      sessions: service.listSessions(),
      pendingChallenges: service.listPendingChallenges(),
    });
  }

  async function setEnabled(enabled) {
    if (!enabled) {
      store.write({ enabled: false, url: null });
      // Amendment 13: a pause, not an unpairing — phones resume when it is turned back on; handoff tokens are voided.
      service.voidOutstandingHandoffs();
      return inspect();
    }
    const address = await tailnet.resolve();
    const url = buildMobileAccessUrl(address, port);
    // Without a tailnet address nothing is persisted: the response carries reason TAILSCALE_NOT_FOUND.
    if (url) store.write({ enabled: true, url });
    return inspect(address);
  }

  async function tailscaleStatus() {
    const status = await tailnet.status();
    return { ...status, tailnetAddress: tailnet.cached() };
  }

  const accessRouter = createMobileAccessHttpRouter({ access: { inspect: () => inspect(), setEnabled, tailscaleStatus } });
  const pairingRouter = createMobilePairingHttpRouter({ service, trustedOrigins, isEnabled });
  const authorize = createRemoteAuthorizer({ service, trustedOrigins, isEnabled, logger });

  function emitChanged() {
    if (typeof emitHub?.emit !== "function") return;
    try {
      emitHub.emit(MOBILE_ACCESS_EVENT, {});
    } catch (error) {
      logger?.warn?.(`[mobile-access] event emit failed: ${error?.message ?? error}`);
    }
  }

  async function handle(request, response) {
    if (closed) return false;
    let url;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      return false;
    }
    if (!url.pathname.startsWith("/api/")) return false;
    let routed = null;
    try {
      routed = await accessRouter.match(request, url) ?? await pairingRouter.match(request, url);
      if (!routed) return false;
      if (routed.allowedMethods) {
        sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } }, {
          allow: routed.allowedMethods.join(", "),
        });
        return true;
      }
      sendJson(response, routed.status ?? 200, routed.result, routed.headers ?? {});
      if (routed.changed) emitChanged();
      return true;
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(response, error.status, {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        });
      } else {
        logger?.error?.(`[mobile-access] request failed: ${error?.message ?? error}`);
        sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
      }
      return true;
    }
  }

  return Object.freeze({
    handle,
    authorize,
    isRemoteRequest: isRemoteSocketRequest,
    tailnetAddress,
    /** True while mobile access is turned on (and access is not closed). */
    isEnabled,
    settings() {
      const current = store.read();
      return { enabled: current.enabled, url: current.url };
    },
    /**
     * DBG-05: re-validates a principal's session for long-lived connections (event streams):
     * false once the session is revoked or expired, mobile access is turned off, or access closed.
     */
    isSessionActive(sessionId) {
      if (!isEnabled()) return false;
      try {
        return service.isSessionActive(sessionId);
      } catch (error) {
        logger?.error?.(`[mobile-access] session check failed: ${error?.message ?? error}`);
        return false;
      }
    },
    /** Amendment 13: Set-Cookie value re-issuing a valid paired session cookie (sliding), or null. */
    refreshSessionCookie(request) {
      if (!isEnabled()) return null;
      return refreshedSessionCookie(service, request, trustedOrigins());
    },
    /** Additive helper: true when Host (and Origin, if sent) match the enabled tailnet origin. No session check. */
    isTrustedRemoteHost(request) {
      try {
        assertRemoteBoundary(request, trustedOrigins());
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      closed = true;
    },
  });
}

export { MOBILE_ACCESS_EVENT } from "../../shared/mobile-access-contract.mjs";
