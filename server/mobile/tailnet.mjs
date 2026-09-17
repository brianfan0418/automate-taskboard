// Tailnet address discovery for v2 mobile access (replaces fork tailscale-private-access.mjs;
// no Tailscale Serve). Runs `tailscale ip -4` through an injectable execFile.
import { execFile as defaultExecFile } from "node:child_process";
import { existsSync as defaultExistsSync } from "node:fs";

import { parseTailnetAddress, parseTailscaleStatus } from "../../shared/mobile-access-contract.mjs";

export const WINDOWS_TAILSCALE_EXECUTABLE = "C:\\Program Files\\Tailscale\\tailscale.exe";
const DEFAULT_TIMEOUT_MS = 5000;

export function resolveTailscaleExecutable({ executable = null, existsSync = defaultExistsSync } = {}) {
  if (typeof executable === "string" && executable) return executable;
  try {
    if (existsSync(WINDOWS_TAILSCALE_EXECUTABLE)) return WINDOWS_TAILSCALE_EXECUTABLE;
  } catch {
    // fall through to PATH lookup
  }
  return "tailscale";
}

function runExecFile(execFile, file, args, options) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, options, (error, stdout, stderr) => {
        resolve({ error: error ?? null, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      });
    } catch (error) {
      resolve({ error, stdout: "", stderr: "" });
    }
  });
}

/**
 * @returns {{ resolve(): Promise<string|null>, cached(): string|null, status(): Promise<object> }}
 * `resolve()` never rejects: any failure (missing binary, non-zero exit, timeout, no 100.x line)
 * yields null. Concurrent calls share one in-flight command.
 */
export function createTailnetResolver({
  execFile = defaultExecFile,
  existsSync = defaultExistsSync,
  executable = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = null,
} = {}) {
  if (typeof execFile !== "function") throw new TypeError("execFile must be a function");
  let last = null;
  let inFlight = null;

  async function run() {
    const file = resolveTailscaleExecutable({ executable, existsSync });
    const result = await runExecFile(execFile, file, ["ip", "-4"], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      shell: false,
    });
    if (result.error) {
      const code = result.error?.code ?? "error";
      logger?.warn?.(`[mobile-access] tailscale ip -4 failed (${code})`);
      return null;
    }
    const address = parseTailnetAddress(result.stdout);
    if (!address) logger?.warn?.("[mobile-access] tailscale ip -4 returned no 100.x address");
    return address;
  }

  let statusInFlight = null;
  async function runStatus() {
    const file = resolveTailscaleExecutable({ executable, existsSync });
    const result = await runExecFile(execFile, file, ["status", "--json"], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      shell: false,
      maxBuffer: 4 * 1024 * 1024,
    });
    // `tailscale status` exits non-zero while logged out / stopped but still prints JSON.
    const parsed = parseTailscaleStatus(result.stdout);
    const installed = !(result.error && result.error.code === "ENOENT");
    if (result.error && !result.stdout) logger?.warn?.(`[mobile-access] tailscale status failed (${result.error?.code ?? "error"})`);
    return { installed, ...parsed };
  }

  return Object.freeze({
    /** Amendment 13: `{ installed, running, loginName, mobilePeers }` from `tailscale status --json`; never rejects. */
    status() {
      if (!statusInFlight) {
        statusInFlight = runStatus().catch(() => ({ installed: false, running: false, loginName: null, mobilePeers: [] }))
          .finally(() => { statusInFlight = null; });
      }
      return statusInFlight;
    },
    resolve() {
      if (!inFlight) {
        inFlight = run().then((address) => {
          last = address;
          return address;
        }).finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
    cached() {
      return last;
    },
  });
}
