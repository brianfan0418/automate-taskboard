// GET/PUT /api/local/mobile-access (C7). Replaces fork server/mobile-access-http-router.mjs +
// mobile-access-runtime.mjs: no Serve setup route, no Serve cleanup; loopback only.
import { ApiError } from "../../shared/api-fields.mjs";
import { assertLocalRequest } from "./remote-auth.mjs";
import { readJsonBody } from "./pairing-http-router.mjs";

function fail(status, code, message) {
  throw new ApiError(status, code, message);
}

function assertNoQuery(url, label) {
  if ([...url.searchParams.keys()].length) fail(400, "UNKNOWN_QUERY_PARAMETER", `${label} does not accept query parameters`);
}

function enabledBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "INVALID_BODY", "Request body must be a JSON object");
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "enabled" || typeof value.enabled !== "boolean") {
    fail(400, "INVALID_BODY", "Mobile access update requires exactly one boolean 'enabled' field");
  }
  return value.enabled;
}

/**
 * @param {{ inspect(): Promise<object>, setEnabled(enabled: boolean): Promise<object>, tailscaleStatus?(): Promise<object> }} options.access
 */
export function createMobileAccessHttpRouter({ access } = {}) {
  if (typeof access?.inspect !== "function" || typeof access?.setEnabled !== "function") {
    throw new TypeError("mobile access inspect()/setEnabled() are required");
  }
  return Object.freeze({
    async match(request, url) {
      // Amendment 13: phone-setup wizard polls this while waiting for the phone to join the tailnet.
      if (url.pathname === "/api/local/mobile-access/tailscale" && typeof access.tailscaleStatus === "function") {
        if (request.method !== "GET") return { allowedMethods: ["GET"] };
        assertNoQuery(url, "Tailscale status");
        assertLocalRequest(request, "Mobile access settings are only available on this device");
        return { result: await access.tailscaleStatus() };
      }
      if (url.pathname !== "/api/local/mobile-access") return null;
      const message = "Mobile access settings are only available on this device";
      if (request.method === "GET") {
        assertNoQuery(url, "Mobile access status");
        assertLocalRequest(request, message);
        return { result: await access.inspect() };
      }
      if (request.method === "PUT") {
        assertNoQuery(url, "Mobile access settings");
        assertLocalRequest(request, message);
        const enabled = enabledBody(await readJsonBody(request, { label: "Mobile access" }));
        return { result: await access.setEnabled(enabled), changed: true };
      }
      return { allowedMethods: ["GET", "PUT"] };
    },
  });
}
