import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import nodeFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  claudeConfigDirectory,
  deliveryBaseline,
  findMessageSince,
  findNewHumanMessage,
  findTranscriptPath,
  readTranscriptAnalysis,
} from "./claude-transcript.mjs";

// Claude background-session provider (CONTRACTS C3, TICKETS T3 + "Amendments from Wave 0 probes").
// Never uses `claude://resume` URLs and never runs `--bg --resume` (attach wakes stopped sessions itself).

export const MIN_CLAUDE_VERSION = "2.1.271";
export const ARGV_PROMPT_LIMIT = 20_000;
export const PASTE_MAX_CHARS = 500;
export const PASTE_MAX_LINES = 20;
export const DEFAULT_PERMISSION_MODE = "acceptEdits";

const DEFAULT_APP_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const ENV_DROP_EXACT = new Set([
  "CLAUDECODE",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_PID",
  "CLAUDE_PREVIEW_CLASSIFIER_FLOOR",
  "AI_AGENT",
]);
const ENV_DROP_PREFIXES = ["CLAUDE_CODE_", "MCP_"];
const SHORT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BRIDGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const LAUNCH_TOKEN_PATTERN = /^[A-Za-z0-9]{4,32}$/;

export class ClaudeProviderError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ClaudeProviderError";
    this.code = code;
  }
}

export function scrubClaudeEnv(env = process.env) {
  const result = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (ENV_DROP_EXACT.has(upper)) continue;
    if (ENV_DROP_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue;
    result[key] = value;
  }
  return result;
}

export function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ""));
  return match ? match.slice(1, 4).map(Number) : null;
}

export function compareVersions(left, right) {
  const a = Array.isArray(left) ? left : parseVersion(left);
  const b = Array.isArray(right) ? right : parseVersion(right);
  if (!a || !b) return Number.NaN;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function envValue(env, name) {
  if (!env) return undefined;
  if (env[name] !== undefined) return env[name];
  const upper = name.toUpperCase();
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === upper);
  return key === undefined ? undefined : env[key];
}

async function isFile(fs, filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(fs, filePath) {
  try {
    return (await fs.stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

async function highestVersionExecutable(fs, claudeCodeDirs, exeName) {
  let best = null;
  for (const directory of claudeCodeDirs) {
    let names = [];
    try {
      names = await fs.readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      const version = /^\d+\.\d+\.\d+$/.test(String(name)) ? parseVersion(name) : null;
      if (!version) continue;
      const candidate = path.join(directory, String(name), exeName);
      if (!(await isFile(fs, candidate))) continue;
      if (!best || compareVersions(version, best.version) > 0) best = { version, path: candidate };
    }
  }
  return best?.path ?? null;
}

// Order (amended): option → CLAUDE_EXECUTABLE → highest under the MSIX LocalCache physical path
// → highest under %APPDATA%\Claude\claude-code → `claude` on PATH.
export async function resolveClaudeExecutable({
  explicit,
  env = process.env,
  fs = nodeFs,
  homedir = os.homedir,
  platform = process.platform,
} = {}) {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const fromEnv = envValue(env, "CLAUDE_EXECUTABLE");
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();

  const exeName = platform === "win32" ? "claude.exe" : "claude";
  const home = typeof homedir === "function" ? homedir() : homedir;
  const localAppData = envValue(env, "LOCALAPPDATA") || path.join(home, "AppData", "Local");
  const appData = envValue(env, "APPDATA") || path.join(home, "AppData", "Roaming");

  const packagesDir = path.join(localAppData, "Packages");
  let packageNames = [];
  try {
    packageNames = (await fs.readdir(packagesDir)).map(String).filter((name) => name.startsWith("Claude_"));
  } catch {
    packageNames = [];
  }
  const msixDirs = packageNames.map((name) => path.join(packagesDir, name, "LocalCache", "Roaming", "Claude", "claude-code"));
  const fromMsix = await highestVersionExecutable(fs, msixDirs, exeName);
  if (fromMsix) return fromMsix;

  const fromAppData = await highestVersionExecutable(fs, [path.join(appData, "Claude", "claude-code")], exeName);
  if (fromAppData) return fromAppData;

  const pathValue = envValue(env, "PATH") || "";
  const separator = platform === "win32" ? ";" : ":";
  for (const directory of pathValue.split(separator)) {
    if (!directory.trim()) continue;
    const candidate = path.join(directory.trim(), exeName);
    if (await isFile(fs, candidate)) return candidate;
  }
  return null;
}

// Mirror of ConPtyAttachSend.SanitizeMessage: this is the exact text the helper types.
export function sanitizeFollowupMessage(text) {
  let value = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (value.charCodeAt(0) === 0xfeff) value = value.slice(1);
  value = value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  return value.replace(/^[\n \t]+/, "").replace(/[\n \t]+$/, "");
}

// Why a follow-up must go through a file instead of being pasted (null = paste is allowed).
// Size limits come from probe P5b. A leading "/" or "!" would be read by the Claude TUI as a slash
// command or shell-mode input instead of a message.
export function pasteUnsafeReason(message) {
  if (message.length > PASTE_MAX_CHARS) return "too-long";
  if (message.split("\n").length > PASTE_MAX_LINES) return "too-many-lines";
  if (/^[/!]/.test(message)) return "leading-command-character";
  return null;
}

export function parseAgentsJson(stdout) {
  const text = String(stdout ?? "").trim();
  const attempts = [text];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) attempts.push(text.slice(start, end + 1));
  for (const attempt of attempts) {
    try {
      const value = JSON.parse(attempt);
      if (Array.isArray(value)) return value.filter((entry) => entry && typeof entry === "object");
    } catch {
      // try the next form
    }
  }
  return null;
}

export function parseBackgroundedId(stdout) {
  const text = String(stdout ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const match = /backgrounded\s*[·•|-]\s*([A-Za-z0-9_-]{4,64})\b/i.exec(text);
  return match ? match[1] : null;
}

export function parseReceipt(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith("{")) continue;
    try {
      const value = JSON.parse(lines[index]);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // keep looking upwards
    }
  }
  return null;
}

function normalizeCwd(value) {
  return String(value ?? "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

// Amendment 9 (BUG-W8-2): first 8 letters/digits of the run id; the session name ends with ` · r<token>`.
export function claudeLaunchToken(runId) {
  const token = String(runId ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  return token.length >= 4 ? token : null;
}

export function launchTokenMarker(token) {
  return `r${token}`;
}

function sanitizeTitle(title, runId) {
  const cleaned = String(title ?? "")
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^-+/, "")
    .trim();
  return cleaned || `relay-${String(runId).slice(0, 8)}`;
}

function receiptSummary(code, receipt) {
  if (!receipt) return `rc=${code} receipt=missing`;
  const stages = Array.isArray(receipt.stages) ? receipt.stages.join(">") : "";
  return `rc=${code} typed=${receipt.typed === true} crSent=${receipt.crSent === true} abort=${receipt.abortReason ?? "none"} stages=${stages}`;
}

function defaultLogger() {
  return {
    info() {},
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  };
}

export function runProcess(spawnImpl, file, args, { cwd, env, timeoutMs, onStdoutLine } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(file, args, { cwd, env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exitInfo = null;
    let settled = false;
    let timedOut = false;
    let killTimer = null;
    let drainTimer = null;
    const capture = (chunks, chunk, count) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (count < MAX_CAPTURE_BYTES) chunks.push(buffer);
      return count + buffer.length;
    };
    let pendingLine = "";
    child.stdout?.on("data", (chunk) => {
      stdoutBytes = capture(stdout, chunk, stdoutBytes);
      if (typeof onStdoutLine !== "function") return;
      pendingLine += (Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))).toString("utf8");
      if (pendingLine.length > 65_536) pendingLine = pendingLine.slice(-65_536);
      let index;
      while ((index = pendingLine.indexOf("\n")) >= 0) {
        const line = pendingLine.slice(0, index).replace(/\r$/, "");
        pendingLine = pendingLine.slice(index + 1);
        try {
          onStdoutLine(line);
        } catch {
          // a line observer must never break the capture
        }
      }
    });
    child.stderr?.on("data", (chunk) => { stderrBytes = capture(stderr, chunk, stderrBytes); });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      // A cold-started daemon may inherit the pipes; release them instead of waiting for it to exit.
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
      resolve({
        code: exitInfo?.code ?? null,
        signal: exitInfo?.signal ?? null,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    };
    child.on("error", (error) => {
      if (settled) return;
      if (exitInfo) {
        finish();
        return;
      }
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      exitInfo = { code, signal };
      clearTimeout(drainTimer);
      drainTimer = setTimeout(finish, 500);
    });
    child.on("close", (code, signal) => {
      if (!exitInfo) exitInfo = { code, signal };
      finish();
    });
    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          // already gone
        }
        drainTimer = setTimeout(() => {
          if (!exitInfo) exitInfo = { code: null, signal: "SIGTERM" };
          finish();
        }, 2000);
      }, timeoutMs);
    }
  });
}

export function createClaudeBgProvider(options = {}) {
  const {
    onUpdate,
    logger = defaultLogger(),
    now = Date.now,
    claudeExecutable,
    env: baseEnv = process.env,
    spawn: spawnImpl = nodeSpawn,
    fs = nodeFs,
    homedir = os.homedir,
    platform = process.platform,
    appRoot = DEFAULT_APP_ROOT,
    conptyHelperPath,
    tempDir = os.tmpdir(),
    promptDir: defaultPromptDir,
    permissionMode: defaultPermissionMode = DEFAULT_PERMISSION_MODE,
    autoPoll = true,
    pollIntervalMs = 5_000,
    discoveryIntervalMs = 1_000,
    discoveryTimeoutMs = 30_000,
    deliveryIntervalMs = 1_000,
    deliveryTimeoutMs = 30_000,
    stopIntervalMs = 1_000,
    stopTimeoutMs = 20_000,
    helperReadyTimeoutMs = 60_000,
    helperTotalTimeoutMs = 120_000,
    commandTimeoutMs = 60_000,
    // Amendment 7 (DBG-03): a session started by `--bg` whose discovery failed stays tracked by its stdout
    // short id; if `claude agents` keeps failing it is reported interrupted (refs kept) after this bound.
    unconfirmedStartGraceMs = 5 * 60_000,
    // Amendment 9 (BUG-W8-2): recover looks a run without a short id up by its launch token this many times.
    recoverLookupAttempts = 4,
    recoverLookupIntervalMs = 2_000,
    // Extra child variables (object or () => object, read per spawn), e.g. CODEX_TASKBOARD_URL.
    extraEnv = null,
  } = options;
  if (typeof onUpdate !== "function") throw new TypeError("createClaudeBgProvider requires onUpdate(runId, update)");

  const scrubbedEnv = scrubClaudeEnv(baseEnv);
  function childEnvironment() {
    const extra = typeof extraEnv === "function" ? extraEnv() : extraEnv;
    return extra && typeof extra === "object" ? { ...scrubbedEnv, ...extra } : scrubbedEnv;
  }
  const helperPath = conptyHelperPath || path.join(appRoot, "resources", "bin", "ConPtyAttachSend.exe");
  const runs = new Map();
  const sessionLocks = new Map();
  // Amendment 7 (DBG-02): per-session stop epoch + count of messages actually typed. A delivery captures
  // the epoch when it begins and gives up (types nothing) once a stop was requested after that.
  const sessionControls = new Map();
  // Follow-up fix: pending clean-up timers for session controls kept briefly after a recent delivery.
  const controlCleanupTimers = new Map();
  // After a message was typed / delivered, `claude agents` can still report the session `idle` for up to a
  // poll interval or so; within this window a stop does not trust `idle` and sends the interrupt anyway.
  const recentDeliveryWindowMs = 2 * pollIntervalMs;
  const sleepers = new Set();
  let executablePromise = null;
  let disposed = false;
  let pollerActive = false;
  let tickInFlight = null;

  const configDir = () => claudeConfigDirectory({ env: baseEnv, homedir: typeof homedir === "function" ? homedir() : homedir });

  function log(level, message, meta) {
    try {
      logger?.[level]?.(`[claude-bg] ${message}`, meta ?? {});
    } catch {
      // logging must never break the provider
    }
  }

  function emit(runId, update) {
    try {
      const result = onUpdate(runId, update);
      if (result && typeof result.then === "function") {
        result.catch((error) => log("error", "onUpdate rejected", { runId, error: String(error?.message ?? error) }));
      }
    } catch (error) {
      log("error", "onUpdate threw", { runId, error: String(error?.message ?? error) });
    }
  }

  function sleep(ms, { background = false } = {}) {
    return new Promise((resolve) => {
      if (disposed) {
        resolve();
        return;
      }
      const sleeper = { resolve };
      sleeper.handle = setTimeout(() => {
        sleepers.delete(sleeper);
        resolve();
      }, ms);
      if (background) sleeper.handle.unref?.();
      sleepers.add(sleeper);
    });
  }

  async function getExecutable() {
    if (!executablePromise) {
      executablePromise = resolveClaudeExecutable({ explicit: claudeExecutable, env: baseEnv, fs, homedir, platform })
        .then((resolved) => {
          if (!resolved) executablePromise = null;
          return resolved;
        }, (error) => {
          executablePromise = null;
          throw error;
        });
    }
    return executablePromise;
  }

  async function runClaude(args, { cwd, timeoutMs = commandTimeoutMs } = {}) {
    const exe = await getExecutable();
    if (!exe) throw new ClaudeProviderError("CLAUDE_NOT_FOUND");
    try {
      return await runProcess(spawnImpl, exe, args, { cwd, env: childEnvironment(), timeoutMs });
    } catch (error) {
      if (error?.code === "ENOENT") executablePromise = null;
      throw error;
    }
  }

  async function listAgents() {
    const result = await runClaude(["agents", "--json", "--all"]);
    if (result.code !== 0) throw new ClaudeProviderError("CLAUDE_AGENTS_FAILED", `exit ${result.code}`);
    const entries = parseAgentsJson(result.stdout);
    if (!entries) throw new ClaudeProviderError("CLAUDE_AGENTS_UNPARSEABLE");
    return entries.filter((entry) => entry.kind === "background");
  }

  async function readBridgeSessionId(shortId) {
    if (!SHORT_ID_PATTERN.test(String(shortId ?? ""))) return null;
    try {
      const text = await fs.readFile(path.join(configDir(), "jobs", shortId, "state.json"), "utf8");
      const value = JSON.parse(text)?.bridgeSessionId;
      return typeof value === "string" && BRIDGE_ID_PATTERN.test(value) ? value : null;
    } catch {
      return null;
    }
  }

  function withSessionLock(shortId, task) {
    const previous = sessionLocks.get(shortId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    const tail = next.catch(() => {});
    sessionLocks.set(shortId, tail);
    tail.then(() => {
      if (sessionLocks.get(shortId) === tail) sessionLocks.delete(shortId);
    });
    return next;
  }

  function sessionControl(shortId) {
    let control = sessionControls.get(shortId);
    if (!control) {
      // typed: messages typed so far; typedInFlight: deliveries that typed and are still confirming;
      // lastTypedAt: now() of the last typed / delivered message; users: sendFollowup / stop calls holding it
      // (a control is never dropped while held, so a captured stop epoch always refers to the live one).
      // gates: pre-Enter gates of deliveries whose helper is running (Amendment 9); a stop aborts them at once.
      control = { stopEpoch: 0, typed: 0, typedInFlight: 0, lastTypedAt: null, users: 0, gates: new Set() };
      sessionControls.set(shortId, control);
    }
    const timer = controlCleanupTimers.get(shortId);
    if (timer) {
      clearTimeout(timer);
      controlCleanupTimers.delete(shortId);
    }
    return control;
  }

  function recentlyTyped(control) {
    return control.lastTypedAt !== null && now() - control.lastTypedAt <= recentDeliveryWindowMs;
  }

  function sessionTracked(shortId) {
    for (const tracked of runs.values()) if (tracked.shortId === shortId) return true;
    return false;
  }

  // Follow-up fix: drop a session's control once nothing holds or tracks it (release / close / dispose),
  // so the map does not grow with every session ever used. A control with a recent delivery is kept until
  // that window has passed, so a stop right after it still interrupts.
  function forgetSessionControl(shortId, { force = false } = {}) {
    if (!shortId) return;
    const control = sessionControls.get(shortId);
    if (!control || control.users > 0 || sessionTracked(shortId)) return;
    if (!force && recentlyTyped(control)) {
      if (controlCleanupTimers.has(shortId) || disposed) return;
      const timer = setTimeout(() => {
        controlCleanupTimers.delete(shortId);
        forgetSessionControl(shortId, { force: true });
      }, Math.max(1, recentDeliveryWindowMs - (now() - control.lastTypedAt)) + 1);
      timer.unref?.();
      controlCleanupTimers.set(shortId, timer);
      return;
    }
    const timer = controlCleanupTimers.get(shortId);
    if (timer) clearTimeout(timer);
    controlCleanupTimers.delete(shortId);
    sessionControls.delete(shortId);
  }

  function track(run) {
    let tracked = runs.get(run.runId);
    if (!tracked) {
      tracked = {
        runId: run.runId,
        shortId: null,
        sessionId: null,
        bridgeSessionId: null,
        cwd: null,
        promptDir: null,
        transcriptPath: null,
        active: false,
        lastStatus: null,
        observedRunning: false,
        waitingKey: null,
        delivering: 0,
        stopping: false,
        unconfirmedSince: null,
        unknownLogged: new Set(),
      };
      runs.set(run.runId, tracked);
    }
    for (const key of ["shortId", "sessionId", "bridgeSessionId", "cwd", "promptDir"]) {
      if (!tracked[key] && run[key]) tracked[key] = run[key];
    }
    return tracked;
  }

  function trackRow(run) {
    if (!run || typeof run.id !== "string") throw new ClaudeProviderError("CLAUDE_RUN_INVALID");
    return track({
      runId: run.id,
      shortId: run.claudeShortId,
      sessionId: run.claudeSessionId,
      bridgeSessionId: run.claudeBridgeSessionId,
    });
  }

  function release(tracked) {
    tracked.active = false;
    if (runs.get(tracked.runId) === tracked) runs.delete(tracked.runId);
    if (!tracked.active && tracked.delivering === 0 && !tracked.stopping) forgetSessionControl(tracked.shortId);
  }

  function forgetIfIdle(tracked) {
    if (!tracked.active && tracked.delivering === 0 && !tracked.stopping) release(tracked);
  }

  async function transcriptAnalysis(tracked) {
    if (!tracked.transcriptPath && tracked.sessionId) {
      tracked.transcriptPath = await findTranscriptPath({ fs, configDir: configDir(), cwd: tracked.cwd, sessionId: tracked.sessionId });
    }
    return readTranscriptAnalysis({ fs, transcriptPath: tracked.transcriptPath });
  }

  function hasActiveRuns() {
    for (const tracked of runs.values()) if (tracked.active) return true;
    return false;
  }

  function ensurePoller() {
    if (!autoPoll || pollerActive || disposed || !hasActiveRuns()) return;
    pollerActive = true;
    (async () => {
      try {
        while (!disposed && hasActiveRuns()) {
          await sleep(pollIntervalMs, { background: true });
          if (disposed) break;
          await pollNow();
        }
      } catch (error) {
        log("error", "poll loop failed", { error: String(error?.message ?? error) });
      } finally {
        pollerActive = false;
      }
      if (!disposed && hasActiveRuns()) ensurePoller();
    })();
  }

  function pollNow() {
    if (tickInFlight) return tickInFlight;
    tickInFlight = (async () => {
      const active = [...runs.values()].filter((tracked) => tracked.active);
      if (active.length === 0 || disposed) return;
      let entries;
      try {
        entries = await listAgents();
      } catch (error) {
        log("warn", "agents poll failed; statuses unchanged", { error: String(error?.message ?? error) });
        for (const tracked of active) {
          if (!tracked.active || tracked.unconfirmedSince === null || tracked.stopping || tracked.delivering > 0) continue;
          if (now() - tracked.unconfirmedSince < unconfirmedStartGraceMs) continue;
          finishRun(tracked, { status: "interrupted", error: "CLAUDE_BG_SESSION_UNCONFIRMED" });
        }
        return;
      }
      for (const tracked of active) {
        if (!tracked.active || disposed) continue;
        try {
          await evaluate(tracked, entries);
        } catch (error) {
          log("error", "status evaluation failed", { runId: tracked.runId, error: String(error?.message ?? error) });
        }
      }
    })().finally(() => {
      tickInFlight = null;
    });
    return tickInFlight;
  }

  function finishRun(tracked, update) {
    tracked.lastStatus = update.status;
    release(tracked);
    emit(tracked.runId, update);
  }

  function logUnknownOnce(tracked, value) {
    if (tracked.unknownLogged.has(value)) return;
    tracked.unknownLogged.add(value);
    log("warn", "unknown agents status; keeping previous status", { runId: tracked.runId, shortId: tracked.shortId, value });
  }

  async function evaluate(tracked, entries) {
    const entry = entries.find((candidate) => candidate.id === tracked.shortId);
    if (tracked.stopping) return;
    if (entry) tracked.unconfirmedSince = null;
    if (!entry) {
      if (tracked.delivering > 0) return;
      finishRun(tracked, { status: "interrupted", error: "CLAUDE_SESSION_NOT_LISTED" });
      return;
    }
    if (!tracked.sessionId && typeof entry.sessionId === "string") tracked.sessionId = entry.sessionId;
    if (!tracked.cwd && typeof entry.cwd === "string") tracked.cwd = entry.cwd;
    if (!tracked.bridgeSessionId) {
      const bridge = await readBridgeSessionId(tracked.shortId);
      if (bridge) {
        tracked.bridgeSessionId = bridge;
        emit(tracked.runId, { refs: { claudeBridgeSessionId: bridge } });
      }
    }
    if (!tracked.active || tracked.stopping) return;

    const hasPid = entry.pid !== undefined && entry.pid !== null;
    if (hasPid) {
      if (entry.status === "waiting") {
        tracked.observedRunning = true;
        const key = `WAITING_FOR_PERMISSION: ${entry.waitingFor ?? "unknown"}`;
        if (tracked.waitingKey !== key) {
          tracked.waitingKey = key;
          tracked.lastStatus = "running";
          emit(tracked.runId, { status: "running", error: key });
        }
        return;
      }
      if (entry.status === "busy" || (entry.status === undefined && entry.state === "working")) {
        tracked.observedRunning = true;
        if (tracked.lastStatus !== "running" || tracked.waitingKey) {
          tracked.waitingKey = null;
          tracked.lastStatus = "running";
          emit(tracked.runId, { status: "running" });
        }
        return;
      }
      if (entry.status === "idle") {
        if (tracked.delivering > 0) return;
        const analysis = await transcriptAnalysis(tracked);
        if (!tracked.active || tracked.stopping || tracked.delivering > 0) return;
        if (tracked.observedRunning || analysis.turnComplete) {
          finishRun(tracked, { status: "finished", resultText: analysis.resultText });
        }
        return;
      }
      logUnknownOnce(tracked, `status:${String(entry.status)}`);
      return;
    }

    if (tracked.delivering > 0) return;
    if (entry.state === "stopped") {
      finishRun(tracked, { status: "stopped" });
      return;
    }
    if (entry.state === "done" || entry.state === "blocked") {
      const analysis = await transcriptAnalysis(tracked);
      if (!tracked.active || tracked.stopping || tracked.delivering > 0) return;
      if (analysis.turnComplete) finishRun(tracked, { status: "finished", resultText: analysis.resultText });
      else finishRun(tracked, { status: "interrupted", error: "CLAUDE_SESSION_PROCESS_ENDED" });
      return;
    }
    logUnknownOnce(tracked, `state:${String(entry.state)}`);
  }

  async function writePromptFile(directory, fileName, content) {
    await fs.mkdir(directory, { recursive: true });
    const filePath = path.join(directory, fileName);
    await fs.writeFile(filePath, content, "utf8");
    return filePath;
  }

  async function writeFollowupFile(directory, runId, content, followupId) {
    await fs.mkdir(directory, { recursive: true });
    // Amendment 7 (DBG-04): one follow-up keeps one file (and so one typed line) across every resend.
    const stableId = typeof followupId === "string" ? followupId.replace(/[^A-Za-z0-9_-]/g, "") : "";
    if (stableId) {
      const filePath = path.join(directory, `followup-${stableId.slice(0, 120)}.md`);
      await fs.writeFile(filePath, content, "utf8");
      return filePath;
    }
    for (let attempt = 1; attempt < 10_000; attempt += 1) {
      const filePath = path.join(directory, `${runId}-followup-${attempt}.md`);
      try {
        await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
        return filePath;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    throw new ClaudeProviderError("CLAUDE_FOLLOWUP_FILE_FAILED");
  }

  async function discoverSession({ stdoutId, name, cwd, known }) {
    const deadline = now() + discoveryTimeoutMs;
    const wantedCwd = normalizeCwd(cwd);
    let lastError = null;
    while (!disposed) {
      try {
        const entries = await listAgents();
        if (stdoutId) {
          const byId = entries.find((entry) => entry.id === stdoutId);
          if (byId) {
            if (byId.name !== name || normalizeCwd(byId.cwd) !== wantedCwd) {
              log("warn", "background session id from --bg output has a different name or cwd", { shortId: stdoutId });
            }
            return byId;
          }
        } else {
          const candidates = entries.filter((entry) => typeof entry.id === "string"
            && !known.has(entry.id)
            && entry.name === name
            && normalizeCwd(entry.cwd) === wantedCwd);
          if (candidates.length === 1) return candidates[0];
          if (candidates.length > 1) lastError = "CLAUDE_BG_DISCOVERY_AMBIGUOUS";
        }
      } catch (error) {
        lastError = String(error?.message ?? error);
      }
      if (now() >= deadline) break;
      await sleep(discoveryIntervalMs);
    }
    throw new ClaudeProviderError("CLAUDE_BG_DISCOVERY_TIMEOUT", lastError ?? `no background session named ${JSON.stringify(name)}`);
  }

  // Amendment 9 (BUG-W8-1): the pre-Enter gate of one delivery. It is decided once: `go` when the helper reports
  // TYPED and no stop is pending, `abort` when a stop arrives first (written at once, even before TYPED).
  function decideGate(gate, decision) {
    if (gate.decision) return gate.written;
    gate.decision = decision;
    gate.written = fs.writeFile(gate.path, decision, "utf8").catch((error) => {
      log("warn", "writing the delivery gate failed (the helper times out and sends no Enter)", { gate: gate.path, error: String(error?.message ?? error) });
    });
    return gate.written;
  }

  // `gate` (queue / steer): { control, shouldAbort() }.
  async function runHelper({ tracked, messageText, mode, gate: gateOptions = null }) {
    if (!(await isFile(fs, helperPath))) {
      return { ok: false, receipt: null, detail: `CONPTY_HELPER_MISSING: ${helperPath}` };
    }
    const exe = await getExecutable();
    if (!exe) return { ok: false, receipt: null, detail: "CLAUDE_NOT_FOUND" };
    const base = path.join(tempDir, `relay-claude-${String(tracked.runId).replace(/[^A-Za-z0-9_-]/g, "")}-${randomUUID()}`);
    const messageFile = `${base}.txt`;
    const outputFile = `${base}.bin`;
    const gate = gateOptions ? { path: `${base}.gate`, decision: null, written: null, typedSeen: false } : null;
    try {
      await fs.mkdir(tempDir, { recursive: true });
      await fs.writeFile(messageFile, messageText, "utf8");
      if (gate) await fs.writeFile(gate.path, "", "utf8");
    } catch (error) {
      await fs.rm(messageFile, { force: true }).catch(() => {});
      if (gate) await fs.rm(gate.path, { force: true }).catch(() => {});
      return { ok: false, receipt: null, detail: `CONPTY_MESSAGE_FILE_FAILED: ${String(error?.message ?? error)}` };
    }
    if (gate) gateOptions.control.gates.add(gate);
    try {
      const cwd = tracked.cwd && (await isDirectory(fs, tracked.cwd)) ? tracked.cwd : tempDir;
      if (gate && gateOptions.shouldAbort()) {
        // A stop arrived while the files were prepared: the helper is never started.
        decideGate(gate, "abort");
        return { ok: false, receipt: null, gateAborted: true, detail: "GATE_ABORT_BEFORE_HELPER" };
      }
      const args = [
        exe,
        tracked.shortId,
        messageFile,
        outputFile,
        String(helperReadyTimeoutMs),
        String(helperTotalTimeoutMs),
        "--mode",
        mode,
      ];
      if (gate) args.push("--gate-file", gate.path);
      const onStdoutLine = gate
        ? (line) => {
          if (line.trim() !== "TYPED" || gate.typedSeen) return;
          gate.typedSeen = true;
          decideGate(gate, gateOptions.shouldAbort() ? "abort" : "go");
        }
        : undefined;
      const result = await runProcess(spawnImpl, helperPath, args, {
        cwd,
        env: childEnvironment(),
        timeoutMs: helperTotalTimeoutMs + 30_000,
        onStdoutLine,
      });
      const receipt = parseReceipt(result.stdout);
      return {
        ok: result.code === 0,
        code: result.code,
        receipt,
        gateDecision: gate?.decision ?? null,
        detail: `${receiptSummary(result.code, receipt)}${gate ? ` gate=${receipt?.gateResult ?? gate.decision ?? "none"}` : ""}`,
      };
    } catch (error) {
      return { ok: false, receipt: null, detail: `CONPTY_HELPER_SPAWN_FAILED: ${String(error?.message ?? error)}` };
    } finally {
      if (gate) {
        gateOptions.control.gates.delete(gate);
        if (gate.written) await gate.written;
      }
      await fs.rm(messageFile, { force: true }).catch(() => {});
      await fs.rm(outputFile, { force: true }).catch(() => {});
      if (gate) await fs.rm(gate.path, { force: true }).catch(() => {});
    }
  }

  // Looks the session up right before the helper types anything. `failed` = the lookup itself failed.
  async function lookupSessionEntry(tracked) {
    try {
      const entry = (await listAgents()).find((candidate) => candidate.id === tracked.shortId) ?? null;
      if (entry) {
        if (!tracked.sessionId && typeof entry.sessionId === "string") tracked.sessionId = entry.sessionId;
        if (!tracked.cwd && typeof entry.cwd === "string") tracked.cwd = entry.cwd;
      }
      return { entry, failed: false };
    } catch (error) {
      log("warn", "agents lookup failed", { runId: tracked.runId, error: String(error?.message ?? error) });
      return { entry: null, failed: true, error: String(error?.message ?? error) };
    }
  }

  // W4 retest bug A: the session shows a permission prompt. Typed text + Enter would answer the prompt
  // (= approve the command), so nothing is typed; the session is tracked as running-and-waiting instead.
  function markWaitingForPermission(tracked, entry) {
    const key = `WAITING_FOR_PERMISSION: ${entry.waitingFor ?? "unknown"}`;
    tracked.observedRunning = true;
    tracked.active = true;
    runs.set(tracked.runId, tracked);
    if (tracked.waitingKey !== key || tracked.lastStatus !== "running") {
      tracked.waitingKey = key;
      tracked.lastStatus = "running";
      emit(tracked.runId, { status: "running", error: key });
    }
    ensurePoller();
    return key;
  }

  // Recovery of a run whose session reference is known (C3 recover).
  async function recoverTracked(tracked) {
    let entries;
    try {
      entries = await listAgents();
    } catch (error) {
      log("warn", "agents lookup during recover failed", { runId: tracked.runId, error: String(error?.message ?? error) });
      release(tracked);
      return { status: "interrupted" };
    }
    const entry = entries.find((candidate) => candidate.id === tracked.shortId);
    if (!entry) {
      release(tracked);
      return { status: "interrupted" };
    }
    if (!tracked.sessionId && typeof entry.sessionId === "string") tracked.sessionId = entry.sessionId;
    if (!tracked.cwd && typeof entry.cwd === "string") tracked.cwd = entry.cwd;
    const hasPid = entry.pid !== undefined && entry.pid !== null;
    if (hasPid && entry.status !== "idle") {
      tracked.active = true;
      tracked.lastStatus = "running";
      tracked.observedRunning = entry.status === "busy" || entry.status === "waiting" || entry.state === "working";
      tracked.waitingKey = null;
      ensurePoller();
      return { status: "running" };
    }
    const analysis = await transcriptAnalysis(tracked);
    release(tracked);
    if (entry.state !== "stopped" && analysis.turnComplete) return { status: "finished", resultText: analysis.resultText };
    return { status: "interrupted" };
  }

  // Amendment 9 (BUG-W8-2): a background session whose name carries `r<token>` (and whose cwd matches the
  // project folder when known). Retried a few times: right after a crash `claude agents` may not list it yet.
  async function findSessionByLaunchToken({ runId, token, cwd }) {
    const marker = new RegExp(`(^|[^A-Za-z0-9])${launchTokenMarker(token)}($|[^A-Za-z0-9])`);
    const wantedCwd = cwd ? normalizeCwd(cwd) : null;
    for (let attempt = 1; attempt <= Math.max(1, recoverLookupAttempts) && !disposed; attempt += 1) {
      try {
        const candidates = (await listAgents()).filter((entry) => typeof entry.id === "string"
          && SHORT_ID_PATTERN.test(entry.id)
          && typeof entry.name === "string"
          && marker.test(entry.name)
          && (wantedCwd === null || normalizeCwd(entry.cwd) === wantedCwd)
          && !sessionTracked(entry.id));
        if (candidates.length === 1) return candidates[0];
        if (candidates.length > 1) {
          log("warn", "several background sessions carry the launch token; not adopting any", { runId, token });
          return null;
        }
      } catch (error) {
        log("warn", "agents lookup by launch token failed", { runId, attempt, error: String(error?.message ?? error) });
      }
      if (attempt < recoverLookupAttempts) await sleep(recoverLookupIntervalMs);
    }
    return null;
  }

  const provider = {
    name: "claude",

    async available() {
      let exe;
      try {
        exe = await getExecutable();
      } catch (error) {
        return { ok: false, reason: "CLAUDE_NOT_FOUND" };
      }
      if (!exe) return { ok: false, reason: "CLAUDE_NOT_FOUND" };
      let result;
      try {
        result = await runClaude(["--version"], { timeoutMs: 30_000 });
      } catch (error) {
        return { ok: false, reason: error?.code === "ENOENT" ? "CLAUDE_NOT_FOUND" : "CLAUDE_VERSION_FAILED" };
      }
      const parsed = parseVersion(result.stdout);
      if (result.code !== 0 || !parsed) return { ok: false, reason: "CLAUDE_VERSION_UNKNOWN" };
      const version = parsed.join(".");
      if (compareVersions(parsed, MIN_CLAUDE_VERSION) < 0) return { ok: false, reason: "CLAUDE_TOO_OLD", version };
      return { ok: true, version };
    },

    async start({ runId, cwd, prompt, model, title, permissionMode, promptDir } = {}) {
      if (typeof runId !== "string" || !runId) throw new ClaudeProviderError("CLAUDE_RUN_INVALID", "runId required");
      if (typeof cwd !== "string" || !cwd) throw new ClaudeProviderError("CLAUDE_RUN_INVALID", "cwd required");
      if (typeof prompt !== "string" || !prompt.trim()) throw new ClaudeProviderError("CLAUDE_EMPTY_PROMPT");
      const configuredDirectory = promptDir || defaultPromptDir;
      if (typeof configuredDirectory !== "string" || !configuredDirectory) throw new ClaudeProviderError("CLAUDE_PROMPT_DIR_REQUIRED");
      const directory = path.resolve(configuredDirectory);
      // Amendment 6: `permissionMode: null` → no --permission-mode flag (Claude applies its own settings).
      const mode = permissionMode === null ? null : (permissionMode || defaultPermissionMode);
      if (mode !== null && (typeof mode !== "string" || !/^[A-Za-z]+$/.test(mode))) {
        throw new ClaudeProviderError("CLAUDE_INVALID_PERMISSION_MODE", String(mode));
      }
      if (model !== undefined && model !== null && model !== "" && (typeof model !== "string" || model.startsWith("-"))) {
        throw new ClaudeProviderError("CLAUDE_INVALID_MODEL");
      }
      const exe = await getExecutable();
      if (!exe) throw new ClaudeProviderError("CLAUDE_NOT_FOUND");
      await fs.mkdir(directory, { recursive: true });

      let promptArg = prompt;
      if (prompt.length > ARGV_PROMPT_LIMIT || prompt.startsWith("-")) {
        const filePath = await writePromptFile(directory, `${runId}-prompt.md`, prompt);
        promptArg = `請先完整讀取這個檔案中的任務說明並照做：${filePath}`;
      }
      const token = claudeLaunchToken(runId);
      const name = token ? `${sanitizeTitle(title, runId)} · ${launchTokenMarker(token)}` : sanitizeTitle(title, runId);

      const known = new Set();
      for (const tracked of runs.values()) if (tracked.shortId) known.add(tracked.shortId);
      try {
        for (const entry of await listAgents()) if (typeof entry.id === "string") known.add(entry.id);
      } catch (error) {
        log("warn", "agents snapshot before start failed", { runId, error: String(error?.message ?? error) });
      }

      // `--add-dir` takes a variadic list, so it is followed by another option, never by the prompt.
      const args = ["--bg", "--add-dir", directory, "-n", name];
      if (mode !== null) args.push("--permission-mode", mode);
      if (model) args.push("--model", model);
      args.push(promptArg);
      if (disposed) throw new ClaudeProviderError("CLAUDE_BG_START_FAILED", "provider disposed before claude --bg");
      if (token) {
        // Amendment 9 (BUG-W8-2): saved before the session can exist, so a board killed before the short id
        // is known can still find the session by name on restart (recover).
        try {
          await onUpdate(runId, { refs: { claudeLaunchToken: token } });
        } catch (error) {
          log("warn", "saving the launch token failed", { runId, error: String(error?.message ?? error) });
        }
      }
      let result;
      try {
        result = await runClaude(args, { cwd, timeoutMs: commandTimeoutMs * 2 });
      } catch (error) {
        throw new ClaudeProviderError("CLAUDE_BG_START_FAILED", String(error?.message ?? error));
      }
      const stdoutId = parseBackgroundedId(result.stdout);
      if (result.code !== 0) {
        if (!stdoutId) {
          throw new ClaudeProviderError("CLAUDE_BG_START_FAILED", `exit ${result.code}: ${result.stderr.trim().slice(0, 300)}`);
        }
        // The CLI printed a session id, so a background session exists; treat it as started.
        log("warn", "claude --bg exited non-zero after printing a session id", { runId, shortId: stdoutId, code: result.code });
      }
      if (stdoutId) {
        // Amendment 7 (DBG-03): persist the only reliable reference before discovery can fail or be cut short.
        emit(runId, { refs: { claudeShortId: stdoutId } });
      }
      let entry;
      try {
        entry = await discoverSession({ stdoutId, name, cwd, known });
      } catch (error) {
        if (!stdoutId) throw error;
        if (disposed) {
          const interrupted = new ClaudeProviderError(
            "CLAUDE_BG_START_INTERRUPTED",
            `the board closed before background session ${stdoutId} was confirmed`,
          );
          interrupted.refs = { claudeShortId: stdoutId };
          interrupted.sessionMayBeRunning = true;
          throw interrupted;
        }
        // Started but not confirmed: keep controlling it by the --bg short id (stop / close / polling).
        log("warn", "background session not confirmed by claude agents; tracking it by the --bg short id", {
          runId,
          shortId: stdoutId,
          error: String(error?.message ?? error),
        });
        const pending = track({ runId, shortId: stdoutId, cwd, promptDir: directory });
        pending.shortId = stdoutId;
        pending.active = true;
        pending.lastStatus = "starting";
        pending.observedRunning = false;
        pending.unconfirmedSince = now();
        ensurePoller();
        return { claudeShortId: stdoutId, claudeSessionId: null, unconfirmed: true };
      }
      const tracked = track({ runId, shortId: entry.id, sessionId: entry.sessionId, cwd: entry.cwd || cwd, promptDir: directory });
      tracked.shortId = entry.id;
      tracked.active = true;
      tracked.lastStatus = "starting";
      tracked.observedRunning = false;
      const refs = { claudeShortId: entry.id, claudeSessionId: typeof entry.sessionId === "string" ? entry.sessionId : null };
      const bridge = await readBridgeSessionId(entry.id);
      if (bridge) {
        tracked.bridgeSessionId = bridge;
        refs.claudeBridgeSessionId = bridge;
      }
      log("info", "background session started", { runId, shortId: entry.id });
      ensurePoller();
      return refs;
    },

    // `since` (ISO time, optional): the message was first sent at that time as a steer; if the transcript
    // already shows the same text since then, it is reported delivered without typing it again (bug B).
    // `followupId` (optional, Amendment 7): file-mode messages use one stable file per follow-up, so a resend
    // types the same line and the `since` check recognises it.
    async sendFollowup({ run, body, mode, since, followupId } = {}) {
      if (mode !== "steer" && mode !== "queue") return { delivered: false, detail: "INVALID_MODE" };
      const tracked = trackRow(run);
      if (!tracked.shortId || !SHORT_ID_PATTERN.test(tracked.shortId)) {
        forgetIfIdle(tracked);
        return { delivered: false, detail: "RUN_HAS_NO_CLAUDE_SESSION" };
      }
      const control = sessionControl(tracked.shortId);
      const stopEpoch = control.stopEpoch;
      control.users += 1;
      try {
        const stopRequested = () => control.stopEpoch !== stopEpoch;
        const sanitized = sanitizeFollowupMessage(body);
        if (!sanitized) {
          forgetIfIdle(tracked);
          return { delivered: false, detail: "EMPTY_MESSAGE" };
        }

        let messageText = sanitized;
        const unsafe = pasteUnsafeReason(sanitized);
        if (unsafe) {
          const directory = tracked.promptDir || defaultPromptDir;
          if (!directory) {
            forgetIfIdle(tracked);
            return { delivered: false, detail: "CLAUDE_PROMPT_DIR_REQUIRED" };
          }
          try {
            const filePath = await writeFollowupFile(path.resolve(directory), tracked.runId, String(body), followupId);
            messageText = `請讀取這個檔案中的補充說明並照做：${filePath}`;
          } catch (error) {
            forgetIfIdle(tracked);
            return { delivered: false, detail: `CLAUDE_FOLLOWUP_FILE_FAILED: ${String(error?.message ?? error)}` };
          }
        }

        return withSessionLock(tracked.shortId, async () => {
          tracked.delivering += 1;
          let typedHere = false;
          try {
            if (stopRequested()) return { delivered: false, stopRequested: true, detail: "STOP_REQUESTED_BEFORE_TYPING" };
            const lookup = await lookupSessionEntry(tracked);
            if (lookup.failed) {
              // Without a fresh status the session might be showing a permission prompt; never type blind.
              return { delivered: false, detail: `AGENTS_CHECK_FAILED: ${lookup.error}` };
            }
            const entry = lookup.entry;
            if (entry && entry.pid !== undefined && entry.pid !== null && entry.status === "waiting") {
              const key = markWaitingForPermission(tracked, entry);
              return { delivered: false, waitingForPermission: true, detail: key };
            }
            const before = await transcriptAnalysis(tracked);
            const sinceMs = typeof since === "string" ? Date.parse(since) : Number.NaN;
            if (Number.isFinite(sinceMs)) {
              const earlier = findMessageSince(before, sinceMs, messageText);
              if (earlier) {
                return { delivered: true, alreadyInTranscript: true, detail: `ALREADY_IN_TRANSCRIPT via ${earlier.source}` };
              }
            }
            const baseline = deliveryBaseline(before);
            // DBG-02: the last point before anything reaches the session. A stop requested meanwhile wins.
            if (stopRequested()) return { delivered: false, stopRequested: true, detail: "STOP_REQUESTED_BEFORE_TYPING" };
            const helper = await runHelper({
              tracked,
              messageText,
              mode,
              gate: { control, shouldAbort: () => disposed || stopRequested() },
            });
            const receipt = helper.receipt;
            // Amendment 9: text erased at the gate (abort / timeout, no Enter) never reached the session.
            const erasedAtGate = receipt?.typed === true && receipt.crSent !== true
              && (receipt.gateResult === "abort" || receipt.gateResult === "timeout") && receipt.inputCleared === true;
            if (receipt?.typed === true && !erasedAtGate) {
              typedHere = true;
              control.typed += 1;
              control.typedInFlight += 1;
              control.lastTypedAt = now();
            }
            if (helper.gateAborted || (receipt && receipt.crSent !== true && receipt.gateResult === "abort")) {
              const detail = receipt?.typed === true ? "STOP_REQUESTED_BEFORE_ENTER" : "STOP_REQUESTED_BEFORE_TYPING";
              return { delivered: false, stopRequested: true, detail: `${detail} ${helper.detail}` };
            }
            if (!receipt || receipt.typed !== true || receipt.crSent !== true) {
              return { delivered: false, detail: `NOT_TYPED ${helper.detail}` };
            }
            const deadline = now() + deliveryTimeoutMs;
            let match = null;
            while (!disposed) {
              match = findNewHumanMessage(await transcriptAnalysis(tracked), baseline, messageText);
              if (match || now() >= deadline || stopRequested()) break;
              await sleep(deliveryIntervalMs);
            }
            if (!match && stopRequested()) {
              return { delivered: false, stopRequested: true, detail: `STOP_REQUESTED_DURING_DELIVERY ${helper.detail}` };
            }
            if (!match) return { delivered: false, detail: `NOT_CONFIRMED_IN_TRANSCRIPT ${helper.detail}` };

            control.lastTypedAt = now();
            tracked.observedRunning = false;
            tracked.waitingKey = null;
            const wasActive = tracked.active;
            tracked.active = true;
            runs.set(tracked.runId, tracked);
            if (mode === "queue" || !wasActive) {
              tracked.lastStatus = "running";
              emit(tracked.runId, { status: "running" });
            }
            ensurePoller();
            return { delivered: true, detail: `DELIVERED via ${match.source}${unsafe ? ` (file: ${unsafe})` : ""} ${helper.detail}` };
          } catch (error) {
            return { delivered: false, detail: `FOLLOWUP_ERROR: ${String(error?.message ?? error)}` };
          } finally {
            if (typedHere) control.typedInFlight -= 1;
            tracked.delivering -= 1;
            forgetIfIdle(tracked);
          }
        });
      } finally {
        control.users -= 1;
        forgetSessionControl(tracked.shortId);
      }
    },

    async stop({ run } = {}) {
      const tracked = trackRow(run);
      if (!tracked.shortId || !SHORT_ID_PATTERN.test(tracked.shortId)) {
        release(tracked);
        return { stopped: true, detail: "RUN_HAS_NO_CLAUDE_SESSION" };
      }
      tracked.stopping = true;
      // Amendment 7 (DBG-02): bump the epoch first (deliveries that have not typed yet give up), then run the
      // stop inside the session lock so it never answers while a delivery is still in flight.
      const control = sessionControl(tracked.shortId);
      control.users += 1;
      control.stopEpoch += 1;
      // Amendment 9: a delivery whose helper has not been told to press Enter yet never will.
      for (const gate of control.gates) decideGate(gate, "abort");
      const typedBeforeStop = control.typed;
      const typedDeliveryInFlight = control.typedInFlight > 0;
      let succeeded = false;
      try {
        return await withSessionLock(tracked.shortId, () => stopLocked());
      } finally {
        tracked.stopping = false;
        control.users -= 1;
        if (succeeded) release(tracked);
        else forgetIfIdle(tracked);
        forgetSessionControl(tracked.shortId);
      }

      async function stopLocked() {
        const entryState = async ({ trustIdle = true } = {}) => {
          const entry = (await listAgents()).find((candidate) => candidate.id === tracked.shortId);
          if (!entry) return "SESSION_NOT_LISTED";
          if (entry.pid === undefined || entry.pid === null) return "PROCESS_NOT_RUNNING";
          if (entry.status === "idle" && trustIdle) return "IDLE";
          return null;
        };
        // A delivery typed before or while this stop waited, or one typed / delivered within 2x the poll
        // interval: `agents` may still show idle, so interrupt anyway.
        const typedWhileWaiting = typedDeliveryInFlight || control.typed !== typedBeforeStop || recentlyTyped(control);
        let before = null;
        try {
          before = await entryState({ trustIdle: !typedWhileWaiting });
        } catch (error) {
          log("warn", "agents lookup before stop failed", { runId: tracked.runId, error: String(error?.message ?? error) });
        }
        if (before) {
          succeeded = true;
          return { stopped: true, detail: `ALREADY_${before}` };
        }
        const helper = await runHelper({ tracked, messageText: "", mode: "interrupt" });
        const deadline = now() + stopTimeoutMs;
        while (!disposed) {
          let state = null;
          try {
            state = await entryState();
          } catch (error) {
            log("warn", "agents lookup during stop failed", { runId: tracked.runId, error: String(error?.message ?? error) });
          }
          if (state) {
            succeeded = true;
            return { stopped: true, detail: `${state} ${helper.detail}` };
          }
          if (now() >= deadline) break;
          await sleep(stopIntervalMs);
        }
        return { stopped: false, detail: `STILL_BUSY_AFTER_INTERRUPT ${helper.detail}` };
      }
    },

    async close({ run } = {}) {
      const tracked = trackRow(run);
      release(tracked);
      if (!tracked.shortId || !SHORT_ID_PATTERN.test(tracked.shortId)) return;
      // The session is being ended: its stop / delivery bookkeeping is no longer needed.
      forgetSessionControl(tracked.shortId, { force: true });
      try {
        const result = await runClaude(["stop", tracked.shortId]);
        if (result.code !== 0) log("warn", "claude stop returned non-zero", { runId: tracked.runId, shortId: tracked.shortId, code: result.code });
      } catch (error) {
        log("warn", "claude stop failed", { runId: tracked.runId, shortId: tracked.shortId, error: String(error?.message ?? error) });
      }
    },

    openUrl(run) {
      const bridge = run?.claudeBridgeSessionId || (run?.id ? runs.get(run.id)?.bridgeSessionId : null);
      if (typeof bridge !== "string" || !BRIDGE_ID_PATTERN.test(bridge)) return null;
      return `claude://claude.ai/epitaxy/${bridge}`;
    },

    async recover(run, { cwd: projectCwd = null } = {}) {
      const tracked = trackRow(run);
      const adopted = {};
      if (!tracked.shortId || !SHORT_ID_PATTERN.test(tracked.shortId)) {
        // Amendment 9 (BUG-W8-2): the board was killed before the short id was saved; find the session by the
        // launch token in its name (and the project folder), then recover it like any other run.
        const token = typeof run?.claudeLaunchToken === "string" && LAUNCH_TOKEN_PATTERN.test(run.claudeLaunchToken)
          ? run.claudeLaunchToken
          : null;
        const found = token ? await findSessionByLaunchToken({ runId: tracked.runId, token, cwd: projectCwd }) : null;
        if (!found) {
          release(tracked);
          return { status: "interrupted" };
        }
        tracked.shortId = found.id;
        adopted.claudeShortId = found.id;
        if (typeof found.sessionId === "string") {
          tracked.sessionId = found.sessionId;
          adopted.claudeSessionId = found.sessionId;
        }
        if (!tracked.cwd && typeof found.cwd === "string") tracked.cwd = found.cwd;
        const bridge = await readBridgeSessionId(found.id);
        if (bridge) {
          tracked.bridgeSessionId = bridge;
          adopted.claudeBridgeSessionId = bridge;
        }
        log("info", "adopted a background session found by launch token", { runId: tracked.runId, shortId: found.id });
      }
      const result = await recoverTracked(tracked);
      return Object.keys(adopted).length > 0 ? { ...result, refs: adopted } : result;
    },

    async dispose() {
      disposed = true;
      for (const control of sessionControls.values()) for (const gate of control.gates) decideGate(gate, "abort");
      for (const sleeper of sleepers) {
        clearTimeout(sleeper.handle);
        sleeper.resolve();
      }
      sleepers.clear();
      for (const tracked of runs.values()) tracked.active = false;
      runs.clear();
      for (const timer of controlCleanupTimers.values()) clearTimeout(timer);
      controlCleanupTimers.clear();
      for (const [shortId, control] of sessionControls) if (control.users === 0) sessionControls.delete(shortId);
      if (tickInFlight) await tickInFlight.catch(() => {});
    },

    // Not part of C3: runs one status poll immediately (used by tests and diagnostics).
    pollNow,
    // Not part of C3: number of per-session stop/delivery controls held (tests).
    sessionControlCount: () => sessionControls.size,
  };
  return provider;
}
