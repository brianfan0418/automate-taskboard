/*
 * DBG-10: client-generated ids (temporary project ids, request keys, list keys).
 * `crypto.randomUUID` exists only in a secure context (HTTPS or loopback). The phone reaches the board
 * over plain `http://<tailnet-IP>:<port>`, where it is missing, so fall back to a UUID v4 built from
 * `crypto.getRandomValues` (available in any context).
 */
type ClientIdCrypto = {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView | null>(array: T) => T;
};

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function newClientId(source: ClientIdCrypto | undefined = globalThis.crypto as ClientIdCrypto | undefined): string {
  if (typeof source?.randomUUID === "function") {
    try {
      return source.randomUUID();
    } catch {
      // Some browsers expose the method but throw outside a secure context; fall through.
    }
  }
  const bytes = new Uint8Array(16);
  if (typeof source?.getRandomValues === "function") {
    source.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const value = hex(bytes);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
