// v2 run service (CONTRACTS C4): owns task_runs / task_followups state transitions,
// drives providers (C3) and moves tasks. Providers never touch the database.

import { createHash } from "node:crypto";
import { statSync } from "node:fs";

import { ApiError } from "../../shared/api-fields.mjs";
import { agentActorForProvider, providerForAgentActor } from "./actors.mjs";
import {
  CLAUDE_SETTINGS_PERMISSION_MODES,
  CLAUDE_SETTINGS_SCOPES,
  detectClaudePermissionMode,
} from "./claude-permission-settings.mjs";

const ACTIVE_RUN_STATUSES = new Set(["starting", "running", "stopping"]);
const TERMINAL_UPDATE_STATUSES = new Set(["finished", "failed", "interrupted", "stopped"]);
const STOP_DESTINATIONS = new Set(["backlog", "todo", "canceled"]);
const CONTINUABLE_STATUSES = new Set(["in_review", "blocked"]);
const RUN_REF_KEYS = [
  "claudeShortId",
  "claudeSessionId",
  "claudeBridgeSessionId",
  "claudeLaunchToken",
  "codexThreadId",
  "codexTurnId",
];

// Amendment 2: live activity is memory-only (last ACTIVITY_LIMIT_PER_RUN entries per run).
export const ACTIVITY_LIMIT_PER_RUN = 200;
const ACTIVITY_RUN_LIMIT = 500;
const ACTIVITY_TEXT_LIMIT = 4_000;
const ACTIVITY_KINDS = new Set(["message", "command", "file", "tool", "status"]);
// Result comments already posted, remembered per run for idempotency (bounded like activity).
const POSTED_RESULT_RUN_LIMIT = 500;

export const WAITING_FOR_PERMISSION_PREFIX = "WAITING_FOR_PERMISSION:";

export function isWaitingForPermissionError(value) {
  return typeof value === "string" && value.startsWith(WAITING_FOR_PERMISSION_PREFIX);
}

export const EMPTY_RESULT_TEXT = "（AI 沒有回傳文字）";

// W3 smoke bug 1: a steer that was not confirmed (for example the AI is inside a long tool call)
// becomes a queued follow-up that is sent when the turn finishes; the conversion is recorded here.
export const STEER_NOT_DELIVERED_QUEUED = "STEER_NOT_DELIVERED_QUEUED";
// The converted steer could not be sent because the run had already ended (stopped/failed).
export const STEER_NOT_DELIVERED_RUN_ENDED = "STEER_NOT_DELIVERED_RUN_ENDED";
// W4 retest bug A: the session was showing a permission prompt, so the steer was not typed (typing would
// answer the prompt); it is queued and sent after the turn.
export const STEER_WAITING_PERMISSION_QUEUED = "STEER_WAITING_PERMISSION_QUEUED";
// W4 review: a steer still being delivered when the board exited.
export const STEER_INTERRUPTED_BY_RESTART = "STEER_INTERRUPTED_BY_RESTART";
// W4 review: the run ended (failed / interrupted / stopped) with queued follow-ups still pending.
export const RUN_ENDED = "RUN_ENDED";

// Amendment 5 / 6: per-project Claude permission choice. `followClaude` (default) lets Claude Code apply
// its own `permissions.defaultMode`; when no settings file sets one the board passes the fallback mode.
export const CLAUDE_PERMISSION_MODES = Object.freeze(["followClaude", "acceptEdits", "bypassPermissions"]);
export const DEFAULT_CLAUDE_PERMISSION_MODE = "followClaude";
export const FOLLOW_CLAUDE_FALLBACK_PERMISSION_MODE = "bypassPermissions";

/** Default project-folder check (W3 smoke bug 4): an existing directory. */
export function workspaceDirectoryExists(workspacePath) {
  try {
    return statSync(workspacePath).isDirectory();
  } catch {
    return false;
  }
}
export const RESTART_INTERRUPTED_TEXT = "看板重新啟動，任務中斷，可按「繼續」。";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

export function createRunService({
  database,
  providers = {},
  emit,
  buildPrompt,
  now = () => new Date().toISOString(),
  logger = NOOP_LOGGER,
  workspaceExists = workspaceDirectoryExists,
  // Amendment 6: ({ cwd }) → { effectiveMode, source } (claude-permission-settings.mjs); injectable for tests.
  detectClaudePermission = ({ cwd }) => detectClaudePermissionMode({ cwd }),
} = {}) {
  if (!database) throw new TypeError("createRunService requires a database");
  if (typeof emit !== "function") throw new TypeError("createRunService requires emit(type, payload)");
  if (typeof buildPrompt !== "function") throw new TypeError("createRunService requires buildPrompt()");

  const terminalUpdateChains = new Map();
  // W3 smoke bug 3: provider calls run after the HTTP response. Every background job is tracked so
  // stop can wait for an in-flight launch and tests / shutdown can settle().
  const backgroundJobs = new Set();
  const launchesByRun = new Map();
  // BUG-W8-3: runId -> in-flight continuation delivery (the run already has its AI session). A stop signals
  // the provider first (pre-Enter gate `abort`) and only then waits for it; see stopActiveRun.
  const deliveriesByRun = new Map();
  // runId -> activity entries (oldest first); Map order doubles as the eviction order.
  const activityByRun = new Map();
  // runId -> hashes of result texts already posted as comments (the same result is never posted twice).
  const postedResultsByRun = new Map();

  function timestamp() {
    const value = now();
    return value instanceof Date ? value.toISOString() : value;
  }

  function log(level, message, details) {
    try {
      logger?.[level]?.(`[runs] ${message}`, details ?? "");
    } catch {
      // Logging must never break run handling.
    }
  }

  function errorMessage(error) {
    if (error && typeof error.message === "string" && error.message) return error.message;
    return String(error ?? "unknown error");
  }

  function safeEmit(type, payload) {
    try {
      emit(type, payload);
    } catch (error) {
      log("warn", `emit ${type} failed`, errorMessage(error));
    }
  }

  function runInBackground(label, work, { runId = null, delivery = false } = {}) {
    const job = Promise.resolve()
      .then(work)
      .catch((error) => log("error", `${label} failed`, errorMessage(error)));
    backgroundJobs.add(job);
    const jobs = delivery ? deliveriesByRun : launchesByRun;
    if (runId) jobs.set(runId, job);
    job.then(() => {
      backgroundJobs.delete(job);
      if (runId && jobs.get(runId) === job) jobs.delete(runId);
    });
    return job;
  }

  async function waitForLaunch(runId) {
    const launch = launchesByRun.get(runId);
    if (launch) await launch;
  }

  async function waitForDelivery(runId) {
    const delivery = deliveriesByRun.get(runId);
    if (delivery) await delivery;
  }

  // W3 smoke bug 4: the AI works in the project folder; refuse clearly before creating a run.
  function requireWorkspace(task) {
    const project = database.getProject(task.projectId);
    const workspacePath = typeof project?.workspacePath === "string" ? project.workspacePath : "";
    if (!workspacePath.trim()) {
      // W15: details.projectId lets the board offer 「設定專案資料夾」 for the right project.
      throw new ApiError(409, "WORKSPACE_NOT_FOUND", "專案沒有設定資料夾，AI 無法開工", {
        projectId: task.projectId,
        workspacePath: null,
      });
    }
    let exists = false;
    try {
      exists = workspaceExists(workspacePath) === true;
    } catch {
      exists = false;
    }
    if (!exists) {
      throw new ApiError(409, "WORKSPACE_NOT_FOUND", `專案資料夾不存在：${workspacePath}`, {
        projectId: task.projectId,
        workspacePath,
      });
    }
    return project;
  }

  function findFollowup(taskId, followupId) {
    return database.listFollowups(taskId).find((followup) => followup.id === followupId) ?? null;
  }

  function requireTask(taskId) {
    const task = database.getTask(taskId);
    if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
    return task;
  }

  function requireProvider(name) {
    const provider = providers?.[name];
    if (!provider) {
      throw new ApiError(503, "PROVIDER_UNAVAILABLE", `Run provider '${name}' is not configured`);
    }
    return provider;
  }

  function requireActor(actor, providerName) {
    const resolved = actor ?? agentActorForProvider(providerName);
    if (!resolved) throw new TypeError("An actor is required");
    return resolved;
  }

  function requireBody(body) {
    if (typeof body !== "string" || body.trim().length === 0) {
      throw new ApiError(400, "INVALID_BODY", "Message body must be a non-empty string");
    }
    return body;
  }

  function projectIdForTask(taskId) {
    return database.getTask(taskId)?.projectId ?? null;
  }

  function emitRun(run) {
    if (!run) return run;
    safeEmit("run.updated", { projectId: projectIdForTask(run.taskId), taskId: run.taskId, run });
    return run;
  }

  function emitFollowup(followup) {
    safeEmit("followup.updated", {
      projectId: projectIdForTask(followup.taskId),
      taskId: followup.taskId,
      followup,
    });
    return followup;
  }

  function saveRun(runId, patch) {
    return emitRun(database.updateRun(runId, patch));
  }

  function saveFollowup(followupId, patch) {
    return emitFollowup(database.updateFollowup(followupId, patch));
  }

  // Amendment 7 (DBG-02): a delivery outcome is only recorded on a follow-up that is still pending; a stop or
  // start that canceled it meanwhile wins. Returns null (nothing written) otherwise.
  function settlePendingFollowup(taskId, followupId, patch) {
    if (findFollowup(taskId, followupId)?.status !== "pending") return null;
    const updated = database.updateFollowup(followupId, patch, { ifStatus: "pending" });
    return updated ? emitFollowup(updated) : null;
  }

  function addComment(taskId, body, actor) {
    const comment = database.createComment(taskId, { body, actor });
    safeEmit("comment.created", { projectId: projectIdForTask(taskId), taskId, comment });
    return comment;
  }

  // Moves with the task's current version; sortOrder is passed as `undefined` so the
  // upstream moveTask places the card at the top of the destination column.
  function moveTask(taskId, status, actor) {
    const task = requireTask(taskId);
    if (task.status === status) return task;
    const moved = database.moveTask(task.id, task.version, status, undefined, undefined, undefined, actor);
    safeEmit("task.moved", { projectId: moved.projectId, taskId: moved.id, task: moved });
    return moved;
  }

  // Provider-driven moves only apply while the card is still in progress, and never throw.
  function moveFromInProgress(taskId, status, actor) {
    try {
      const task = database.getTask(taskId);
      if (!task || task.archivedAt || task.status !== "in_progress") return task;
      return moveTask(taskId, status, actor);
    } catch (error) {
      log("warn", `could not move task ${taskId} to ${status}`, errorMessage(error));
      return database.getTask(taskId);
    }
  }

  function refsPatch(source, { skipNull = false } = {}) {
    const patch = {};
    if (!source || typeof source !== "object") return patch;
    for (const key of RUN_REF_KEYS) {
      const value = source[key];
      if (value === undefined) continue;
      if (skipNull && value === null) continue;
      patch[key] = value;
    }
    return patch;
  }

  function cancelPendingFollowups(taskId, { error, queueOnly = false } = {}) {
    for (const followup of database.listFollowups(taskId)) {
      if (followup.status !== "pending" || (queueOnly && followup.mode !== "queue")) continue;
      saveFollowup(followup.id, error === undefined ? { status: "canceled" } : { status: "canceled", error });
    }
  }

  // W4 review: queued follow-ups of a run that ended failed / interrupted / stopped must not be sent to a
  // later continuation. A steer still being delivered settles itself (deliverSteer).
  function cancelQueuedAfterRunEnded(taskId) {
    cancelPendingFollowups(taskId, { error: RUN_ENDED, queueOnly: true });
  }

  // Bug B safety net: a steer converted after an unconfirmed delivery may already have reached the session.
  function queueSendOptions(followup) {
    return followup?.error === STEER_NOT_DELIVERED_QUEUED && followup.createdAt ? { since: followup.createdAt } : {};
  }

  function sessionKey(run) {
    if (run.provider === "claude") return run.claudeShortId ?? run.claudeSessionId ?? null;
    if (run.provider === "codex") return run.codexThreadId ?? null;
    return null;
  }

  // Amendment 6: the `--permission-mode` value for a Claude start (null = pass no flag) and the run record.
  async function claudePermission(automation, cwd) {
    const configured = CLAUDE_PERMISSION_MODES.includes(automation?.claudePermissionMode)
      ? automation.claudePermissionMode
      : DEFAULT_CLAUDE_PERMISSION_MODE;
    if (configured !== "followClaude") {
      return { permissionMode: configured, record: { claudePermissionMode: configured, claudePermissionSource: "board" } };
    }
    let detection = null;
    try {
      detection = await detectClaudePermission({ cwd });
    } catch (error) {
      log("warn", "reading Claude settings for the permission mode failed; using the fallback", errorMessage(error));
    }
    if (CLAUDE_SETTINGS_SCOPES.includes(detection?.source?.scope)) {
      const effectiveMode = CLAUDE_SETTINGS_PERMISSION_MODES.includes(detection.effectiveMode) ? detection.effectiveMode : null;
      return {
        permissionMode: null,
        record: { claudePermissionMode: effectiveMode, claudePermissionSource: detection.source.scope },
      };
    }
    return {
      permissionMode: FOLLOW_CLAUDE_FALLBACK_PERMISSION_MODE,
      record: { claudePermissionMode: FOLLOW_CLAUDE_FALLBACK_PERMISSION_MODE, claudePermissionSource: "fallback" },
    };
  }

  async function startInput({ runId, task, project, prompt, providerName }) {
    const automation = database.getProjectAutomation(task.projectId);
    const input = {
      runId,
      cwd: project?.workspacePath ?? null,
      prompt,
      title: `${task.identifier} ${task.title}`,
    };
    const model = providerName === "claude" ? automation?.claudeModel : automation?.codexModel;
    if (model) input.model = model;
    if (providerName === "codex" && automation?.codexEffort) input.effort = automation.codexEffort;
    if (providerName === "claude") {
      const { permissionMode, record } = await claudePermission(automation, input.cwd);
      input.permissionMode = permissionMode;
      if (database.getRun(runId)) saveRun(runId, record);
    }
    return input;
  }

  // A run that could not get going: failed + agent comment + card to blocked.
  function failRunLaunch(runId, taskId, providerName, message) {
    const current = database.getRun(runId);
    if (current && !ACTIVE_RUN_STATUSES.has(current.status)) {
      log("warn", `run ${runId} already ${current.status}; launch failure not applied`, message);
      return { task: database.getTask(taskId), run: current };
    }
    const run = saveRun(runId, { status: "failed", error: message });
    cancelQueuedAfterRunEnded(taskId);
    const agentActor = agentActorForProvider(providerName);
    addComment(taskId, `AI 無法開始工作：${message}`, agentActor);
    const task = moveFromInProgress(taskId, "blocked", agentActor);
    return { task, run };
  }

  function resultHash(resultText) {
    return createHash("sha256").update(resultText).digest("hex");
  }

  function resultAlreadyPosted(runId, resultText) {
    return postedResultsByRun.get(runId)?.has(resultHash(resultText)) ?? false;
  }

  // W6: a repeated finished update (same run, same result) must not post the result comment twice.
  // Returns false (and posts nothing) when this run already posted this exact result.
  function postResultOnce(run, body, resultText) {
    if (resultAlreadyPosted(run.id, resultText)) {
      log("info", `result for run ${run.id} was already posted; skipping duplicate comment`);
      return false;
    }
    let hashes = postedResultsByRun.get(run.id);
    if (!hashes) {
      hashes = new Set();
      postedResultsByRun.set(run.id, hashes);
      while (postedResultsByRun.size > POSTED_RESULT_RUN_LIMIT) {
        postedResultsByRun.delete(postedResultsByRun.keys().next().value);
      }
    }
    hashes.add(resultHash(resultText));
    addComment(run.taskId, body, agentActorForProvider(run.provider));
    return true;
  }

  function finishRun(run, resultText, note, { resultPosted = false } = {}) {
    const saved = saveRun(run.id, { status: "finished", resultText });
    const agentActor = agentActorForProvider(run.provider);
    const text = resultText.trim().length > 0 ? resultText : EMPTY_RESULT_TEXT;
    if (resultPosted || resultAlreadyPosted(run.id, resultText)) {
      if (note) addComment(run.taskId, note, agentActor);
    } else {
      postResultOnce(run, note ? `${text}\n\n${note}` : text, resultText);
    }
    moveFromInProgress(run.taskId, "in_review", agentActor);
    return saved;
  }

  async function applyFinished(run, update) {
    const resultText = typeof update.resultText === "string" ? update.resultText : "";
    if (run.status === "stopping") {
      // The user asked to stop; keep the text on the run but do not review/queue.
      saveRun(run.id, { status: "stopped", resultText });
      return;
    }
    const pending = database.listPendingFollowups(run.taskId);
    if (pending.length === 0) {
      finishRun(run, resultText, null);
      return;
    }

    // W3 note 5: the finished turn's result stays visible on the card before the next turn starts.
    const resultPosted = resultText.trim().length > 0;
    if (resultPosted) postResultOnce(run, resultText, resultText);
    saveRun(run.id, { status: "running", resultText });
    const provider = providers?.[run.provider];
    for (const next of pending) {
      // DBG-02: a stop (or anything that ended the run) during an earlier delivery ends the queue here.
      const beforeSend = database.getRun(run.id);
      if (!beforeSend || beforeSend.status !== "running") return;
      if (findFollowup(run.taskId, next.id)?.status !== "pending") continue;
      let result;
      try {
        if (!provider) throw new Error(`Run provider '${run.provider}' is not configured`);
        result = await provider.sendFollowup({
          run: beforeSend, body: next.body, mode: "queue", followupId: next.id, ...queueSendOptions(next),
        });
      } catch (error) {
        result = { delivered: false, detail: errorMessage(error) };
      }
      // DBG-02: re-read after the await; a stopped run or a canceled follow-up is never recorded as sent.
      const afterSend = database.getRun(run.id);
      if (!afterSend || afterSend.status !== "running") return;
      if (findFollowup(run.taskId, next.id)?.status !== "pending") return;
      if (result?.delivered && result.alreadyInTranscript) {
        // Bug B: the session already absorbed this message during the turn that just finished.
        settlePendingFollowup(run.taskId, next.id, { status: "sent", sentAt: timestamp(), runId: run.id });
        continue;
      }
      if (result?.delivered) {
        settlePendingFollowup(run.taskId, next.id, { status: "sent", sentAt: timestamp(), runId: run.id });
        return;
      }
      if (result?.waitingForPermission) {
        // Bug A: the session is at a permission prompt again; keep the message queued for the next finish.
        log("info", `queued follow-up ${next.id} waits: the session is waiting for permission`);
        return;
      }
      const detail = result?.detail || "unknown delivery failure";
      settlePendingFollowup(run.taskId, next.id, { status: "failed", error: detail, runId: run.id });
      const current = database.getRun(run.id);
      if (!current || !ACTIVE_RUN_STATUSES.has(current.status)) return;
      finishRun(current, resultText, `（排隊的追加訊息沒有送達：${detail}）`, { resultPosted });
      return;
    }
    // Every pending message had already reached the session: this turn's result is final.
    const current = database.getRun(run.id);
    if (current && ACTIVE_RUN_STATUSES.has(current.status)) finishRun(current, resultText, null, { resultPosted });
  }

  function applyFailure(run, update) {
    const status = update.status;
    const fallback = status === "failed" ? "AI 執行失敗（沒有錯誤訊息）" : "AI 對話中斷";
    const error = typeof update.error === "string" && update.error.trim() ? update.error : fallback;
    saveRun(run.id, { status, error });
    cancelQueuedAfterRunEnded(run.taskId);
    if (run.status === "stopping") return;
    const agentActor = agentActorForProvider(run.provider);
    const prefix = status === "failed" ? "AI 執行失敗" : "任務中斷";
    addComment(run.taskId, `${prefix}：${error}`, agentActor);
    moveFromInProgress(run.taskId, "blocked", agentActor);
  }

  async function applyTerminalUpdate(runId, update) {
    const run = database.getRun(runId);
    if (!run) {
      log("warn", `update for unknown run ${runId}`, update?.status);
      return;
    }
    const refs = refsPatch(update.refs);
    // A run that ends normally is no longer waiting for a permission prompt.
    if ((update.status === "finished" || update.status === "stopped") && isWaitingForPermissionError(run.error)
      && ACTIVE_RUN_STATUSES.has(run.status)) {
      refs.error = null;
    }
    if (!ACTIVE_RUN_STATUSES.has(run.status)) {
      if (Object.keys(refs).length > 0) saveRun(run.id, refs);
      log("info", `ignoring ${update.status} for ${run.status} run ${runId}`);
      return;
    }
    const current = Object.keys(refs).length > 0 ? saveRun(run.id, refs) : run;
    if (update.status === "finished") {
      await applyFinished(current, update);
    } else if (update.status === "stopped") {
      saveRun(run.id, { status: "stopped" });
      cancelQueuedAfterRunEnded(run.taskId);
    } else {
      applyFailure(current, update);
    }
  }

  function applyNonTerminalUpdate(runId, update) {
    const run = database.getRun(runId);
    if (!run) {
      log("warn", `update for unknown run ${runId}`, update?.status);
      return;
    }
    const patch = refsPatch(update.refs);
    if (update.status === "running" && (run.status === "starting" || run.status === "running")) {
      if (run.status !== "running") patch.status = "running";
      // A plain running update means a turn is in progress again: an identical result text from that
      // turn is a real new result, so forget the texts already posted for this run.
      if (!isWaitingForPermissionError(update.error)) postedResultsByRun.delete(run.id);
      // Amendment 3: `{ status: "running", error: "WAITING_FOR_PERMISSION: …" }` is surfaced on the run;
      // the next plain `running` update (the AI got going again) clears it.
      if (isWaitingForPermissionError(update.error)) {
        if (run.error !== update.error) patch.error = update.error;
      } else if (update.error === undefined && isWaitingForPermissionError(run.error)) {
        patch.error = null;
      }
    } else if (update.status !== undefined && update.status !== "running") {
      log("warn", `unknown run update status '${update.status}' for run ${runId}`);
    }
    if (Object.keys(patch).length > 0) saveRun(run.id, patch);
  }

  function normalizeActivity(value) {
    if (!value || typeof value !== "object" || !ACTIVITY_KINDS.has(value.kind)) return null;
    if (typeof value.text !== "string" || value.text.trim().length === 0) return null;
    return {
      kind: value.kind,
      text: value.text.length > ACTIVITY_TEXT_LIMIT ? value.text.slice(0, ACTIVITY_TEXT_LIMIT) : value.text,
      at: typeof value.at === "string" && value.at ? value.at : timestamp(),
    };
  }

  function recordActivity(runId, value) {
    const activity = normalizeActivity(value);
    if (!activity) {
      log("warn", `ignoring malformed activity for run ${runId}`);
      return;
    }
    const run = database.getRun(runId);
    if (!run) {
      log("warn", `activity for unknown run ${runId}`);
      return;
    }
    let entries = activityByRun.get(runId);
    if (!entries) {
      entries = [];
      activityByRun.set(runId, entries);
      while (activityByRun.size > ACTIVITY_RUN_LIMIT) {
        activityByRun.delete(activityByRun.keys().next().value);
      }
    }
    entries.push(activity);
    if (entries.length > ACTIVITY_LIMIT_PER_RUN) entries.splice(0, entries.length - ACTIVITY_LIMIT_PER_RUN);
    safeEmit("run.activity", { projectId: projectIdForTask(run.taskId), taskId: run.taskId, runId, activity });
  }

  function handleProviderUpdate(runId, update = {}) {
    const safeUpdate = update && typeof update === "object" ? update : {};
    if (safeUpdate.activity !== undefined) {
      try {
        recordActivity(runId, safeUpdate.activity);
      } catch (error) {
        log("error", `run ${runId} activity failed`, errorMessage(error));
      }
    }
    if (!TERMINAL_UPDATE_STATUSES.has(safeUpdate.status)) {
      try {
        applyNonTerminalUpdate(runId, safeUpdate);
      } catch (error) {
        log("error", `run ${runId} update failed`, errorMessage(error));
      }
      return Promise.resolve();
    }
    // Terminal updates for one run are applied in order, so a finished update that is
    // delivering a queued follow-up cannot race the next turn's finished update.
    const previous = terminalUpdateChains.get(runId) ?? Promise.resolve();
    const next = previous
      .then(() => applyTerminalUpdate(runId, safeUpdate))
      .catch((error) => log("error", `run ${runId} ${safeUpdate.status} update failed`, errorMessage(error)));
    terminalUpdateChains.set(runId, next);
    next.then(() => {
      if (terminalUpdateChains.get(runId) === next) terminalUpdateChains.delete(runId);
    });
    return next;
  }

  // New run in the same AI session as `latest` (refs and the session's permission record copied), card → in_progress.
  function openContinuationRun(taskId, latest, author) {
    let run = database.createRun({ taskId, provider: latest.provider });
    const refs = refsPatch(latest, { skipNull: true });
    for (const key of ["claudePermissionMode", "claudePermissionSource"]) {
      if (typeof latest[key] === "string") refs[key] = latest[key];
    }
    if (Object.keys(refs).length > 0) run = database.updateRun(run.id, refs);
    emitRun(run);
    try {
      moveTask(taskId, "in_progress", author);
    } catch (error) {
      saveRun(run.id, { status: "failed", error: errorMessage(error) });
      throw error;
    }
    return database.getRun(run.id);
  }

  // Returns "delivered" | "already" (bug B: the session had absorbed it) | "waiting" (bug A: permission
  // prompt; the run stays active) | "failed" (run failed, agent comment, card blocked).
  // `followupId`: the queued follow-up this continuation carries. On a delivery failure it is recorded as
  // failed with the delivery detail before the run failure cancels the rest of the queue (W6).
  // "stopped" (Amendment 7, DBG-02): the run was stopped while the message was being delivered; nothing is recorded.
  async function deliverContinuation(runId, taskId, providerName, body, sendOptions = {}, { followupId = null } = {}) {
    const run = database.getRun(runId);
    if (!run || !ACTIVE_RUN_STATUSES.has(run.status)) return "failed";
    if (run.status === "stopping") return "stopped";
    let result;
    try {
      const input = { run, body, mode: "queue", ...sendOptions };
      if (followupId) input.followupId = followupId;
      result = await requireProvider(providerName).sendFollowup(input);
    } catch (error) {
      result = { delivered: false, detail: errorMessage(error) };
    }
    const afterSend = database.getRun(runId);
    if (!afterSend || afterSend.status === "stopping" || afterSend.status === "stopped") return "stopped";
    if (result?.delivered && result.alreadyInTranscript) {
      const current = database.getRun(runId);
      if (current && ACTIVE_RUN_STATUSES.has(current.status)) {
        saveRun(runId, { status: "finished", resultText: "" });
        moveFromInProgress(taskId, "in_review", agentActorForProvider(providerName));
      }
      return "already";
    }
    if (result?.delivered) return "delivered";
    if (result?.waitingForPermission) return "waiting";
    const detail = result?.detail || "unknown delivery failure";
    if (followupId) settlePendingFollowup(taskId, followupId, { status: "failed", error: detail, runId });
    failRunLaunch(runId, taskId, providerName, `訊息沒有送達 AI 對話：${detail}`);
    return "failed";
  }

  async function deliverSteer({ taskId, followupId, runId, body, author }) {
    // A steer right after start/continue waits until the session exists and the continuation was delivered.
    await waitForLaunch(runId);
    await waitForDelivery(runId);
    const run = database.getRun(runId);
    let result;
    if (!run || run.status === "stopping" || !ACTIVE_RUN_STATUSES.has(run.status)) {
      result = { delivered: false, detail: "RUN_NOT_ACTIVE" };
    } else if (isWaitingForPermissionError(run.error)) {
      // W4 retest bug A: typing now would answer the permission prompt. The provider is not called.
      result = { delivered: false, waitingForPermission: true, detail: run.error };
    } else {
      try {
        result = await requireProvider(run.provider).sendFollowup({ run, body, mode: "steer", followupId });
      } catch (error) {
        result = { delivered: false, detail: errorMessage(error) };
      }
    }
    const current = findFollowup(taskId, followupId);
    if (!current || current.status !== "pending") return; // canceled (stop/start) meanwhile
    if (result?.delivered) {
      settlePendingFollowup(taskId, followupId, { status: "sent", sentAt: timestamp() });
      return;
    }
    const code = result?.waitingForPermission ? STEER_WAITING_PERMISSION_QUEUED : STEER_NOT_DELIVERED_QUEUED;
    log("warn", `steer ${followupId} not delivered; converted to a queued follow-up (${code})`, result?.detail);
    const queued = saveFollowup(followupId, { mode: "queue", status: "pending", error: code });
    const latestRun = database.getRun(runId);
    // Still active: the finished update sends it as the next turn (applyFinished).
    if (latestRun && ACTIVE_RUN_STATUSES.has(latestRun.status)) return;
    await sendQueuedAfterRunEnded(queued, latestRun, author);
  }

  // The turn ended while the steer was being confirmed. A finished run (card in review) continues in
  // the same session with this message; otherwise (stopped / failed / card moved) it is not sent.
  async function sendQueuedAfterRunEnded(followup, endedRun, author) {
    const task = database.getTask(followup.taskId);
    const canContinue = Boolean(
      task && !task.archivedAt && endedRun && endedRun.status === "finished"
      && task.status === "in_review" && !database.getActiveRun(task.id)
      && database.getLatestRun(task.id)?.id === endedRun.id && providers?.[endedRun.provider],
    );
    if (!canContinue) {
      saveFollowup(followup.id, { status: "failed", error: STEER_NOT_DELIVERED_RUN_ENDED });
      return;
    }
    let run;
    try {
      run = openContinuationRun(task.id, endedRun, author ?? agentActorForProvider(endedRun.provider));
    } catch (error) {
      log("warn", `could not continue task ${task.id} for queued steer`, errorMessage(error));
      saveFollowup(followup.id, { status: "failed", error: STEER_NOT_DELIVERED_RUN_ENDED });
      return;
    }
    saveFollowup(followup.id, { runId: run.id });
    const outcome = await deliverContinuation(
      run.id, task.id, endedRun.provider, followup.body, queueSendOptions(followup), { followupId: followup.id },
    );
    if (findFollowup(task.id, followup.id)?.status !== "pending") return;
    if (outcome === "waiting") return; // stays queued on the new run; sent when that turn finishes
    if (outcome === "stopped") {
      settlePendingFollowup(task.id, followup.id, { status: "canceled", error: RUN_ENDED });
      return;
    }
    settlePendingFollowup(task.id, followup.id, outcome === "failed"
      ? { status: "failed", error: STEER_NOT_DELIVERED_RUN_ENDED }
      : { status: "sent", sentAt: timestamp() });
  }

  async function stopActiveRun(requested) {
    // A start still in flight (no AI session yet) must settle before stopping.
    await waitForLaunch(requested.id);
    // BUG-W8-3 (Amendment 9): a continuation delivery in flight is NOT awaited first — the provider stop
    // (stop epoch bump, `abort` at the pre-Enter gate) is signalled before waiting for that delivery,
    // otherwise the gate has already answered `go` and the message starts a new turn.
    const active = database.getRun(requested.id);
    if (!active || !ACTIVE_RUN_STATUSES.has(active.status)) return active;
    const provider = requireProvider(active.provider);
    const resumeStatus = active.status === "stopping" ? "running" : active.status;
    const stopping = active.status === "stopping" ? active : saveRun(active.id, { status: "stopping" });
    let result;
    try {
      result = await provider.stop({ run: stopping });
    } catch (error) {
      result = { stopped: false, detail: errorMessage(error) };
    }
    // The delivery sees `stopping` / the gate abort and ends as "stopped" (nothing recorded).
    await waitForDelivery(active.id);
    const current = database.getRun(active.id);
    if (!current || !ACTIVE_RUN_STATUSES.has(current.status)) return current;
    if (result?.stopped) {
      const patch = { status: "stopped" };
      if (isWaitingForPermissionError(current.error)) patch.error = null;
      return saveRun(active.id, patch);
    }
    saveRun(active.id, { status: resumeStatus });
    throw new ApiError(
      502,
      "RUN_STOP_FAILED",
      `AI 沒有確認停止：${result?.detail || "unknown stop failure"}`,
    );
  }

  const service = {
    // W3 smoke bug 3: validates, persists the run and moves the card, then answers; the prompt and
    // provider.start run in the background (results via run.updated / DB state; failure → failed run,
    // agent comment, card blocked).
    async startTask({ taskId, actor } = {}) {
      const task = requireTask(taskId);
      if (task.archivedAt) throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be started");
      if (task.status !== "todo") {
        throw new ApiError(409, "TASK_NOT_TODO", `Task '${task.identifier}' must be in todo to start (current: ${task.status})`);
      }
      const providerName = providerForAgentActor(task.assignee);
      if (!providerName) {
        throw new ApiError(409, "ASSIGNEE_NOT_AGENT", `Task '${task.identifier}' is not assigned to an AI agent`);
      }
      const provider = requireProvider(providerName);
      requireWorkspace(task);
      const moveActor = requireActor(actor, providerName);

      const created = emitRun(database.createRun({ taskId: task.id, provider: providerName }));
      let moved;
      try {
        moved = moveTask(task.id, "in_progress", moveActor);
      } catch (error) {
        saveRun(created.id, { status: "failed", error: errorMessage(error) });
        throw error;
      }
      // Earlier queued messages are already comments, so the new prompt carries them.
      cancelPendingFollowups(task.id);

      runInBackground(`start run ${created.id}`, async () => {
        let refs;
        try {
          const current = requireTask(task.id);
          const comments = database.listComments(task.id);
          const attachments = database.listAttachments(task.id);
          const prompt = await buildPrompt({ task: current, comments, attachments });
          const project = database.getProject(task.projectId);
          refs = await provider.start(await startInput({ runId: created.id, task: current, project, prompt, providerName }));
        } catch (error) {
          const errorRefs = refsPatch(error?.refs, { skipNull: true });
          if (error?.sessionMayBeRunning === true && Object.keys(errorRefs).length > 0) {
            // Amendment 7 (DBG-03): the AI session was created but the start was cut short (board closing).
            // Keep the run active with its refs so stop / archive / restart recovery can still reach it.
            const current = database.getRun(created.id);
            if (current && ACTIVE_RUN_STATUSES.has(current.status)) saveRun(created.id, errorRefs);
            log("warn", `run ${created.id} start was interrupted after the session was created; kept for recovery`, errorMessage(error));
            return;
          }
          failRunLaunch(created.id, task.id, providerName, errorMessage(error));
          return;
        }
        const patch = refsPatch(refs);
        if (Object.keys(patch).length > 0 && database.getRun(created.id)) saveRun(created.id, patch);
      }, { runId: created.id });
      return { task: database.getTask(moved.id), run: database.getRun(created.id) };
    },

    async stopTask({ taskId, destination = null, actor } = {}) {
      if (destination !== null && destination !== undefined && !STOP_DESTINATIONS.has(destination)) {
        throw new ApiError(400, "INVALID_DESTINATION", "destination must be backlog, todo, canceled, or null");
      }
      const task = requireTask(taskId);
      const active = database.getActiveRun(task.id);
      let run = null;
      if (active) {
        run = await stopActiveRun(active);
        cancelPendingFollowups(task.id, { error: RUN_ENDED });
      }
      let resultTask = database.getTask(task.id);
      if (destination) {
        const latest = run ?? database.getLatestRun(task.id);
        resultTask = moveTask(task.id, destination, requireActor(actor, latest?.provider));
      }
      return { task: resultTask, run: run ?? database.getLatestRun(task.id) };
    },

    // W3 smoke bug 3: the follow-up row (pending) and the actor's comment are saved before answering;
    // a steer is delivered in the background (followup.updated). W3 smoke bug 1: a steer that is not
    // confirmed becomes a queued follow-up (error STEER_NOT_DELIVERED_QUEUED) sent after the turn.
    async sendFollowup({ taskId, body, mode, actor } = {}) {
      requireBody(body);
      if (mode !== "queue" && mode !== "steer") {
        throw new ApiError(400, "INVALID_FOLLOWUP_MODE", "mode must be queue or steer");
      }
      const task = requireTask(taskId);
      const active = database.getActiveRun(task.id);
      if (!active || active.status === "stopping") {
        throw new ApiError(409, "RUN_NOT_ACTIVE", `Task '${task.identifier}' has no running AI run`);
      }
      requireProvider(active.provider);
      const author = requireActor(actor, active.provider);

      const followup = emitFollowup(database.createFollowup({ taskId: task.id, runId: active.id, body, mode }));
      addComment(task.id, body, author);
      if (mode === "steer") {
        runInBackground(`steer follow-up ${followup.id}`, () => deliverSteer({
          taskId: task.id,
          followupId: followup.id,
          runId: active.id,
          body,
          author,
        }));
      }
      return { followup };
    },

    // Validates, comments, opens the new run (same AI session) and moves the card, then answers;
    // the message is delivered in the background (failure → failed run, agent comment, card blocked).
    async continueTask({ taskId, body, actor } = {}) {
      requireBody(body);
      const task = requireTask(taskId);
      if (task.archivedAt) throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be continued");
      if (!CONTINUABLE_STATUSES.has(task.status)) {
        throw new ApiError(409, "TASK_NOT_CONTINUABLE", `Task '${task.identifier}' must be in_review or blocked to continue (current: ${task.status})`);
      }
      if (database.getActiveRun(task.id)) {
        throw new ApiError(409, "RUN_ALREADY_ACTIVE", `Task '${task.identifier}' already has an active run`);
      }
      const latest = database.getLatestRun(task.id);
      if (!latest) throw new ApiError(409, "NO_PREVIOUS_RUN", `Task '${task.identifier}' has no previous run to continue`);
      // DBG-08 follow-up: a run that never reached an AI session (launch failed) has nothing to continue.
      if (sessionKey(latest) === null) throw new ApiError(409, "REWORK_REQUIRED", "上一次沒有成功開工，請改用「退回重做」");
      requireProvider(latest.provider);
      requireWorkspace(task);
      const author = requireActor(actor, latest.provider);

      addComment(task.id, body, author);
      const run = openContinuationRun(task.id, latest, author);
      runInBackground(`continue run ${run.id}`, async () => {
        const outcome = await deliverContinuation(run.id, task.id, latest.provider, body);
        if (outcome !== "waiting") return;
        // Bug A: the session is at a permission prompt; the message waits as a queued follow-up.
        const current = database.getRun(run.id);
        if (!current || !ACTIVE_RUN_STATUSES.has(current.status)) return;
        emitFollowup(database.createFollowup({ taskId: task.id, runId: run.id, body, mode: "queue" }));
      }, { runId: run.id, delivery: true });
      return { task: database.getTask(task.id), run: database.getRun(run.id) };
    },

    /**
     * Comments and moves the card back to todo. With `commentId` (DBG-09 follow-up) an already
     * created comment of this task is used instead of creating one, so a client can post the
     * comment, upload its attachments and only then move the card; every check still runs first.
     */
    async reworkTask({ taskId, body, commentId, actor } = {}) {
      const useExisting = commentId !== undefined && commentId !== null;
      if (useExisting) {
        if (typeof commentId !== "string" || commentId.length === 0) {
          throw new ApiError(400, "INVALID_BODY", "commentId must be a non-empty string");
        }
        if (body !== undefined) {
          throw new ApiError(400, "INVALID_BODY", "Send either body or commentId, not both");
        }
      } else {
        requireBody(body);
      }
      const task = requireTask(taskId);
      if (task.archivedAt) throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be moved");
      if (database.getActiveRun(task.id)) {
        throw new ApiError(409, "RUN_ALREADY_ACTIVE", `Task '${task.identifier}' has an active run; stop it first`);
      }
      const author = requireActor(actor, null);
      let comment;
      if (useExisting) {
        comment = database.getComment(commentId);
        if (!comment || comment.taskId !== task.id) {
          throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${commentId}' does not exist on this task`);
        }
      } else {
        comment = addComment(task.id, body, author);
      }
      const moved = moveTask(task.id, "todo", author);
      return { task: moved, comment };
    },

    async archiveTask({ taskId, actor } = {}) {
      const task = requireTask(taskId);
      if (database.getActiveRun(task.id)) {
        await service.stopTask({ taskId: task.id, destination: null, actor });
      }
      cancelPendingFollowups(task.id);
      const runs = database.listRuns(task.id);
      const latest = runs[0] ?? null;
      const closed = new Set();
      for (const run of runs) {
        const key = sessionKey(run);
        if (run !== latest && key === null) continue;
        const dedupe = `${run.provider}:${key ?? `run:${run.id}`}`;
        if (closed.has(dedupe)) continue;
        closed.add(dedupe);
        const provider = providers?.[run.provider];
        if (!provider) {
          log("warn", `cannot close ${run.provider} session for run ${run.id}: provider not configured`);
          continue;
        }
        try {
          await provider.close({ run });
        } catch (error) {
          log("warn", `closing session for run ${run.id} failed`, errorMessage(error));
        }
      }
      return { run: latest };
    },

    handleProviderUpdate,

    /** Throws 409 WORKSPACE_NOT_FOUND unless the project folder exists (pre-check for PATCH starts). */
    assertWorkspace({ projectId } = {}) {
      requireWorkspace({ projectId });
    },

    /** Resolves once no background launch / delivery / terminal update is pending (tests, shutdown). */
    async settle() {
      while (backgroundJobs.size > 0 || terminalUpdateChains.size > 0) {
        await Promise.allSettled([...backgroundJobs, ...terminalUpdateChains.values()]);
        await new Promise((resolve) => setImmediate(resolve));
      }
    },

    // Amendment 2: in-memory activity for a run (oldest first, at most ACTIVITY_LIMIT_PER_RUN).
    listActivity(runId) {
      return [...(activityByRun.get(runId) ?? [])];
    },

    async recoverOnStartup() {
      // W4 review: a steer caught mid-delivery by the restart would otherwise stay 「送出中」 forever.
      // Queued follow-ups stay pending (they follow their run's recovery).
      try {
        const steers = typeof database.listPendingSteerFollowups === "function"
          ? database.listPendingSteerFollowups()
          : [];
        for (const steer of steers) {
          saveFollowup(steer.id, { status: "failed", error: STEER_INTERRUPTED_BY_RESTART });
        }
      } catch (error) {
        log("error", "settling pending steers after restart failed", errorMessage(error));
      }
      const runs = database.listRunsByStatus(["starting", "running", "stopping"]);
      for (const run of runs) {
        try {
          let recovered;
          const provider = providers?.[run.provider];
          if (!provider) {
            recovered = { status: "interrupted" };
          } else {
            try {
              // Amendment 9: the project folder lets a provider match a session found by its launch token.
              let cwd = null;
              try {
                const task = database.getTask(run.taskId);
                cwd = (task && database.getProject(task.projectId)?.workspacePath) || null;
              } catch {
                cwd = null;
              }
              recovered = await provider.recover(run, { cwd });
            } catch (error) {
              log("warn", `recover failed for run ${run.id}`, errorMessage(error));
              recovered = { status: "interrupted" };
            }
          }
          // A stop that was in flight when the board exited is abandoned.
          if (run.status === "stopping") saveRun(run.id, { status: "running" });
          // Amendment 9: refs the provider adopted during recovery (e.g. found by launch token) are saved first.
          const recoveredRefs = refsPatch(recovered?.refs, { skipNull: true });
          const withRefs = (update) => (Object.keys(recoveredRefs).length > 0 ? { ...update, refs: recoveredRefs } : update);
          if (recovered?.status === "running") {
            await handleProviderUpdate(run.id, withRefs({ status: "running" }));
          } else if (recovered?.status === "finished") {
            await handleProviderUpdate(run.id, withRefs({
              status: "finished",
              resultText: typeof recovered.resultText === "string" ? recovered.resultText : "",
            }));
          } else {
            await handleProviderUpdate(run.id, withRefs({ status: "interrupted", error: RESTART_INTERRUPTED_TEXT }));
          }
        } catch (error) {
          log("error", `recovering run ${run.id} failed`, errorMessage(error));
        }
      }
    },

    openUrl(runId) {
      const run = database.getRun(runId);
      if (!run) return null;
      const provider = providers?.[run.provider];
      if (typeof provider?.openUrl !== "function") return null;
      try {
        return provider.openUrl(run) ?? null;
      } catch (error) {
        log("warn", `openUrl failed for run ${runId}`, errorMessage(error));
        return null;
      }
    },
  };
  return service;
}
