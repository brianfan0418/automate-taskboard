import os from "node:os";

/**
 * True for RFC 1918 private IPv4 addresses (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16).
 *
 * These are the addresses the server's plain "local mode keeps LAN access" rules trust. Tailnet
 * CGNAT addresses (100.64.0.0/10) are deliberately excluded: the main listener rejects them with
 * INVALID_HOST unless v2 mobile access is enabled, so a LAN-access test must never pick one.
 */
export function isRfc1918Ipv4(address) {
  if (typeof address !== "string") return false;
  const octets = address.split(".");
  if (octets.length !== 4 || !octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)) {
    return false;
  }
  const [first, second] = octets.map(Number);
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

/**
 * First non-internal IPv4 interface address in an RFC 1918 private range, or null when this
 * machine has none (for example only loopback, a tailnet 100.x address, or a public address).
 */
export function privateLanIpv4Address(interfaces = os.networkInterfaces()) {
  return Object.values(interfaces ?? {})
    .flat()
    .find((entry) => entry?.family === "IPv4" && !entry.internal && isRfc1918Ipv4(entry.address))
    ?.address ?? null;
}

export const NO_PRIVATE_LAN_SKIP_REASON =
  "No RFC 1918 private IPv4 interface (10/8, 172.16/12, 192.168/16) is available; "
  + "loopback, tailnet 100.64.0.0/10 and public addresses cannot exercise plain LAN access";
