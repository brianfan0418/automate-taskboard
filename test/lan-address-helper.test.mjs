// Regression cover for the LAN-access test helper: on a Windows machine running Tailscale,
// os.networkInterfaces() lists the tailnet adapter (100.x) before Wi-Fi, and the old
// "first non-internal IPv4" helper picked it. The main listener rejects a tailnet Host with
// INVALID_HOST (mobile access disabled), so the cloud LAN test failed before reaching LOCAL_ONLY.
import assert from "node:assert/strict";
import test from "node:test";

import { isRfc1918Ipv4, privateLanIpv4Address } from "./helpers/lan-address.mjs";

const TAILSCALE_FIRST_INTERFACES = {
  Tailscale: [
    { family: "IPv6", address: "fd7a:115c:a1e0::3f01:7bcd", internal: false },
    { family: "IPv6", address: "fe80::1e4d:41e4:f828:d837", internal: false },
    { family: "IPv4", address: "100.101.102.103", internal: false },
  ],
  "Wi-Fi": [
    { family: "IPv6", address: "fe80::a430:dc13:7db4:7958", internal: false },
    { family: "IPv4", address: "192.168.50.23", internal: false },
  ],
  "Loopback Pseudo-Interface 1": [
    { family: "IPv6", address: "::1", internal: true },
    { family: "IPv4", address: "127.0.0.1", internal: true },
  ],
  "vEthernet (Default Switch)": [
    { family: "IPv4", address: "172.21.32.1", internal: false },
  ],
};

test("private LAN helper skips a tailnet interface listed before the Wi-Fi LAN address", () => {
  assert.equal(privateLanIpv4Address(TAILSCALE_FIRST_INTERFACES), "192.168.50.23");
});

test("private LAN helper returns null when only loopback, tailnet, link-local or public IPv4 exist", () => {
  assert.equal(privateLanIpv4Address({
    lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    tailscale0: [{ family: "IPv4", address: "100.64.0.9", internal: false }],
    apipa: [{ family: "IPv4", address: "169.254.10.20", internal: false }],
    wan: [{ family: "IPv4", address: "203.0.113.7", internal: false }],
    v6only: [{ family: "IPv6", address: "fd00::1", internal: false }],
  }), null);
  assert.equal(privateLanIpv4Address({}), null);
  assert.equal(privateLanIpv4Address(null), null);
});

test("private LAN helper ignores internal interfaces even when they carry a private address", () => {
  assert.equal(privateLanIpv4Address({
    internalBridge: [{ family: "IPv4", address: "10.0.0.5", internal: true }],
    lan: [{ family: "IPv4", address: "10.1.2.3", internal: false }],
  }), "10.1.2.3");
});

test("RFC 1918 classification covers exactly 10/8, 172.16/12 and 192.168/16", () => {
  for (const address of ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.254", "192.168.50.23"]) {
    assert.equal(isRfc1918Ipv4(address), true, address);
  }
  for (const address of [
    "100.64.0.1",
    "100.101.102.103",
    "100.127.255.254",
    "172.15.255.255",
    "172.32.0.1",
    "192.169.0.1",
    "169.254.1.1",
    "127.0.0.1",
    "8.8.8.8",
    "10.0.0",
    "10.0.0.256",
    "fd00::1",
    "",
    undefined,
  ]) {
    assert.equal(isRfc1918Ipv4(address), false, String(address));
  }
});
