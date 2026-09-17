// v2 contract C5: auto-claim scheduler.
// Knows nothing about the database or providers; everything is injected.

import {
  isBlockedByOpenDependency,
  orderTasks,
  providerForAssignee,
} from "../../shared/task-order.mjs";

export const DEFAULT_SCHEDULER_INTERVAL_MS = 15000;

// startTask errors with these codes end the project's loop for the current tick (not logged).
export const PROJECT_STOP_CODES = new Set(["AUTOMATION_DISABLED", "PARALLEL_LIMIT_REACHED"]);

function describeError(error) {
  if (error instanceof Error) {
    return error.code ? `${error.code}: ${error.message}` : error.message;
  }
  return String(error);
}

export function isSchedulerCandidate(task) {
  return Boolean(
    task
    && typeof task.id === "string"
    && task.status === "todo"
    && !task.archivedAt
    && providerForAssignee(task.assignee) !== null
    && !isBlockedByOpenDependency(task),
  );
}

/**
 * createScheduler({ listEnabledAutomations, countActiveRuns(projectId), listTodoTasks(projectId),
 *   startTask(taskId), intervalMs = 15000, logger }) → { start(), stop(), tick() }
 *
 * - The injected functions may be synchronous or return promises.
 * - tick(): for each enabled automation, available = maxParallel − countActiveRuns(projectId);
 *   candidates = orderTasks(todo tasks with an agent provider and no open dependency, orderMode);
 *   starts candidates in order, one at a time, until `available` starts succeeded or the
 *   re-counted active runs reach maxParallel. A startTask error is logged and the next candidate
 *   is tried. Resolves { started: taskId[] }.
 * - Never runs two ticks concurrently: calling tick() while one is in flight returns the
 *   in-flight promise.
 * - stop() clears the interval, makes the in-flight tick stop before its next startTask, and
 *   resolves once that tick has settled.
 */
export function createScheduler({
  listEnabledAutomations,
  countActiveRuns,
  listTodoTasks,
  startTask,
  intervalMs = DEFAULT_SCHEDULER_INTERVAL_MS,
  logger = console,
} = {}) {
  for (const [name, value] of Object.entries({ listEnabledAutomations, countActiveRuns, listTodoTasks, startTask })) {
    if (typeof value !== "function") throw new TypeError(`createScheduler: ${name} must be a function`);
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError("createScheduler: intervalMs must be a positive number");
  }

  let timer = null;
  let inFlight = null;
  let generation = 0;

  const warn = (message) => {
    try {
      (logger?.warn ?? logger?.error ?? logger?.log)?.call(logger, `[scheduler] ${message}`);
    } catch {
      // A broken logger must not break scheduling.
    }
  };

  async function activeRunCount(projectId) {
    const count = Number(await countActiveRuns(projectId));
    if (!Number.isFinite(count) || count < 0) {
      throw new Error(`countActiveRuns returned an invalid value for project ${projectId}`);
    }
    return count;
  }

  async function runProject(automation, tickGeneration, attempted, started) {
    const projectId = automation?.projectId;
    if (!projectId || automation.enabled === false) return;
    const maxParallel = Number(automation.maxParallel);
    if (!Number.isInteger(maxParallel) || maxParallel < 1) {
      warn(`project ${projectId}: invalid maxParallel ${JSON.stringify(automation.maxParallel)}, skipped`);
      return;
    }

    let available;
    let candidates;
    try {
      available = maxParallel - await activeRunCount(projectId);
      if (available <= 0) return;
      const todo = await listTodoTasks(projectId);
      candidates = orderTasks(
        (Array.isArray(todo) ? todo : []).filter(isSchedulerCandidate),
        automation.orderMode,
      );
    } catch (error) {
      warn(`project ${projectId}: ${describeError(error)}, skipped`);
      return;
    }

    let startedHere = 0;
    let attemptedHere = 0;
    for (const task of candidates) {
      if (tickGeneration !== generation) return;
      if (startedHere >= available) return;
      if (attempted.has(task.id)) continue;
      // Re-count before every start after the first: manual runs count toward maxParallel,
      // and a failed start may or may not have left an active run behind.
      if (attemptedHere > 0) {
        try {
          if (await activeRunCount(projectId) >= maxParallel) return;
        } catch (error) {
          warn(`project ${projectId}: ${describeError(error)}, stopped for this tick`);
          return;
        }
        if (tickGeneration !== generation) return;
      }
      attempted.add(task.id);
      attemptedHere += 1;
      try {
        await startTask(task.id);
        started.push(task.id);
        startedHere += 1;
      } catch (error) {
        // DBG-06/07: the integrator re-checks the project right before a start; when auto-claim was
        // turned off or the project is full, no later candidate of this project can start this tick.
        if (PROJECT_STOP_CODES.has(error?.code)) return;
        warn(`project ${projectId}: startTask ${task.id} failed: ${describeError(error)}`);
      }
    }
  }

  async function runTick() {
    const tickGeneration = generation;
    const started = [];
    const attempted = new Set();
    let automations;
    try {
      automations = await listEnabledAutomations();
    } catch (error) {
      warn(`listEnabledAutomations failed: ${describeError(error)}`);
      return { started };
    }
    for (const automation of Array.isArray(automations) ? automations : []) {
      if (tickGeneration !== generation) break;
      await runProject(automation, tickGeneration, attempted, started);
    }
    return { started };
  }

  function tick() {
    if (!inFlight) {
      inFlight = runTick().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      tick().catch((error) => warn(`tick failed: ${describeError(error)}`));
    }, intervalMs);
    timer?.unref?.();
  }

  async function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    generation += 1;
    if (inFlight) await inFlight.catch(() => {});
  }

  return { start, stop, tick };
}
