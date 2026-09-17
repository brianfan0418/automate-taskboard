// v2 mobile access contract (CONTRACTS C7). Pure helpers shared by the server
// mobile module and (optionally) the web settings page. No I/O here.
//
// v2 has NO Tailscale Serve: the board listens on the machine's tailnet IPv4
// address and the phone opens `http://<100.x.y.z>:<port>/` over the WireGuard
// tunnel. Every remote /api request must carry a paired Relay session.

export const MOBILE_ACCESS_SETTINGS_FILE = "mobile-access.json";
export const MOBILE_ACCESS_SETTINGS_VERSION = 1;

export const MOBILE_SESSION_COOKIE = "relay_session";
export const MOBILE_CSRF_HEADER = "x-relay-csrf";

/** Emitted on the EventHub whenever settings, challenges or paired sessions change. */
export const MOBILE_ACCESS_EVENT = "mobile-access.updated";

export const MOBILE_ACCESS_REASONS = Object.freeze({
  /** `tailscale ip -4` could not run or returned no 100.x address. */
  TAILSCALE_NOT_FOUND: "TAILSCALE_NOT_FOUND",
});

const IPV4_OCTET = /^(?:0|[1-9][0-9]{0,2})$/;

/** True for a dotted IPv4 string whose first octet is 100 (Tailscale CGNAT space). */
export function isTailnetIpv4(value) {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "100") return false;
  return parts.every((part) => IPV4_OCTET.test(part) && Number(part) <= 255);
}

/** First 100.x IPv4 line of `tailscale ip -4` output, or null. */
export function parseTailnetAddress(stdout) {
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const candidate = line.trim();
    if (isTailnetIpv4(candidate)) return candidate;
  }
  return null;
}

/** Phone-facing URL for a tailnet address + board port, e.g. `http://100.64.0.1:47833/`. */
export function buildMobileAccessUrl(tailnetAddress, port) {
  if (!isTailnetIpv4(tailnetAddress)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return new URL(`http://${tailnetAddress}:${port}/`).toString();
}

/**
 * Response body of GET/PUT /api/local/mobile-access.
 * Contract fields: enabled, url, tailnetAddress, reason?
 * Additive (for the desktop settings page): pairing, sessions, pendingChallenges.
 */
export function mobileAccessView({
  enabled,
  url,
  tailnetAddress,
  pairing = "unpaired",
  sessions = [],
  pendingChallenges = [],
}) {
  return {
    enabled: Boolean(enabled),
    url: enabled ? url ?? null : null,
    tailnetAddress: tailnetAddress ?? null,
    ...(tailnetAddress ? {} : { reason: MOBILE_ACCESS_REASONS.TAILSCALE_NOT_FOUND }),
    pairing,
    sessions,
    pendingChallenges,
  };
}

/**
 * UI stage for the desktop settings page:
 * - "local-only"          僅限本機
 * - "enabled"             手機存取已開啟
 * - "tailscale-not-found" 找不到 Tailscale（請先安裝並登入 Tailscale）
 */
export function mobileAccessStage(view) {
  if (view?.reason === MOBILE_ACCESS_REASONS.TAILSCALE_NOT_FOUND) return "tailscale-not-found";
  return view?.enabled ? "enabled" : "local-only";
}

/** Amendment 13 (W12-C): Tailscale peer OS values that are phones / tablets. */
const MOBILE_PEER_OS = new Set(["ios", "android"]);

/**
 * Amendment 13: summary of `tailscale status --json` for the desktop phone-setup wizard.
 * Returns `{ running, loginName, mobilePeers: [{ id, hostName, os, online }] }` (never keys or addresses);
 * `mobilePeers` = same-user peers with OS iOS / android, plus same-user peers with an unknown OS (`os: ""`, non-empty host name).
 * Unparseable output → `{ running: false, loginName: null, mobilePeers: [] }`.
 */
export function parseTailscaleStatus(stdout) {
  let status;
  try {
    status = JSON.parse(String(stdout ?? ""));
  } catch {
    return { running: false, loginName: null, mobilePeers: [] };
  }
  if (!status || typeof status !== "object") return { running: false, loginName: null, mobilePeers: [] };
  const running = status.BackendState === "Running";
  const users = status.User && typeof status.User === "object" ? status.User : {};
  const selfUser = status.Self?.UserID;
  const loginName = selfUser !== undefined && typeof users[String(selfUser)]?.LoginName === "string"
    ? users[String(selfUser)].LoginName
    : null;
  const mobilePeers = [];
  // Only this account's own devices: nodes shared into the tailnet by other users are ignored.
  const peers = status.Peer && typeof status.Peer === "object" ? Object.values(status.Peer) : [];
  for (const peer of peers) {
    if (!peer || typeof peer !== "object") continue;
    const rawOs = typeof peer.OS === "string" ? peer.OS.trim() : "";
    const hostName = typeof peer.HostName === "string" ? peer.HostName.trim().slice(0, 120) : "";
    // This PC may not learn a peer's OS: a same-user peer with an empty / "unknown" OS counts as a possible phone
    // (reported with `os: ""`) when it has a host name. Known desktop / server OSes (windows, macOS, linux, …) never do.
    const unknownOs = rawOs === "" || rawOs.toLowerCase() === "unknown";
    if (unknownOs ? !hostName : !MOBILE_PEER_OS.has(rawOs.toLowerCase())) continue;
    if (selfUser !== undefined && selfUser !== null && String(peer.UserID) !== String(selfUser)) continue;
    const id = typeof peer.ID === "string" || typeof peer.ID === "number" ? String(peer.ID) : null;
    if (!id) continue;
    mobilePeers.push({
      id,
      hostName,
      os: unknownOs ? "" : rawOs,
      online: peer.Online === true,
    });
  }
  return { running, loginName, mobilePeers };
}
