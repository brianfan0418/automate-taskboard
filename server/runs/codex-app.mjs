// Codex provider for Taskboard v2 runs (CONTRACTS C3).
//
// One shared Codex app-server (JSON-RPC over stdio, see server/codex-app-server.mjs) hosts
// every Codex run. Each run owns one app-server thread; each start / queued follow-up is a
// turn on that thread. The provider never touches the database or HTTP: progress is reported
// only through `onUpdate(runId, update)`.

// No `sandbox` param: an explicit "workspace-write" fails on Windows (CreateProcessWithLogonW 1385,
// TICKETS Amendment 1), so the user's own Codex config decides the sandbox.
const APPROVAL_POLICY = "never";
const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const ERROR_LIMIT = 65_536;
const ACTIVITY_TEXT_LIMIT = 2_000;
// Amendment 1: turn/interrupt does not kill an in-flight command.
const STOP_STEP_NOTE = " (the step already in progress may still complete)";

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.slice(0, ERROR_LIMIT);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function textInput(text) {
  // Mirrors upstream ai-chat.mjs user input items (`text_elements` defaults to []).
  return [{ type: "text", text }];
}

function textActivity(kind, text) {
  if (typeof text !== "string" || !text.trim()) return null;
  return { kind, text: text.length > ACTIVITY_TEXT_LIMIT ? text.slice(0, ACTIVITY_TEXT_LIMIT) : text };
}

// Amendment 2: live run activity from app-server items (agentMessage text, commandExecution
// command, fileChange paths, mcpToolCall name).
export function activityForCodexItem(item) {
  if (!item || typeof item !== "object") return null;
  if (item.type === "agentMessage") return textActivity("message", item.text);
  if (item.type === "commandExecution") {
    const command = Array.isArray(item.command) ? item.command.join(" ") : item.command;
    return textActivity("command", command);
  }
  if (item.type === "fileChange") {
    const paths = Array.isArray(item.changes)
      ? item.changes.flatMap((change) => (nonEmptyString(change?.path) ? [change.path] : []))
      : [];
    return textActivity("file", paths.join("\n"));
  }
  if (item.type === "mcpToolCall") {
    const name = [item.server, item.tool].filter(nonEmptyString).join(".");
    return textActivity("tool", name);
  }
  return null;
}

function lastAgentMessageText(items) {
  if (!Array.isArray(items)) return undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "agentMessage" && typeof item.text === "string") return item.text;
  }
  return undefined;
}

export function createCodexAppProvider(options = {}) {
  const { onUpdate, codexVersion, appServerFactory } = options;
  if (typeof onUpdate !== "function") {
    throw new TypeError("createCodexAppProvider requires onUpdate(runId, update)");
  }
  if (!options.appServer && typeof appServerFactory !== "function") {
    throw new TypeError("createCodexAppProvider requires an appServer instance or appServerFactory()");
  }
  const logger = options.logger ?? console;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const ownsAppServer = !options.appServer;

  let appServer = options.appServer ?? null;
  let unsubscribe = null;
  let disposed = false;

  // runId -> run state; threadId -> runId currently bound to that thread.
  const runs = new Map();
  const runByThread = new Map();
  // threadId -> app-server child the thread was started/resumed on (null when not observable).
  const loadedThreads = new Map();
  // threadId -> { cwd, model, effort } remembered from start (used for resume / queued turns).
  const threadSettings = new Map();

  function log(level, message, details) {
    try {
      logger?.[level]?.(`[codex-app] ${message}`, ...(details === undefined ? [] : [details]));
    } catch {}
  }

  function emit(runId, update) {
    try {
      const result = onUpdate(runId, update);
      if (result && typeof result.then === "function") {
        result.then(undefined, (error) => log("error", `onUpdate failed for run ${runId}`, errorMessage(error)));
      }
    } catch (error) {
      log("error", `onUpdate failed for run ${runId}`, errorMessage(error));
    }
  }

  function server() {
    if (disposed) throw new Error("Codex app provider is disposed");
    if (!appServer) appServer = appServerFactory();
    if (!unsubscribe) {
      unsubscribe = appServer.subscribe((notification, child) => handleNotification(notification, child));
    }
    return appServer;
  }

  function currentChild(app) {
    return app?.child ?? null;
  }

  function createState(runId) {
    return {
      runId,
      threadId: null,
      turnId: null,
      lastCompletedTurnId: null,
      // idle: no turn in flight; turn-starting: turn/start sent; running: turn active.
      phase: "idle",
      child: null,
      agentText: new Map(),
      reportedItems: new Set(),
      stopWaiters: new Set(),
    };
  }

  function bindThread(state, threadId) {
    const previousRunId = runByThread.get(threadId);
    if (previousRunId && previousRunId !== state.runId) {
      const previous = runs.get(previousRunId);
      if (previous) settleStopWaiters(previous, { stopped: true, detail: "Codex thread moved to another run" });
      runs.delete(previousRunId);
    }
    state.threadId = threadId;
    runByThread.set(threadId, state.runId);
  }

  function forgetRun(state) {
    settleStopWaiters(state, { stopped: false, detail: "Codex run is no longer tracked" });
    runs.delete(state.runId);
    if (state.threadId && runByThread.get(state.threadId) === state.runId) {
      runByThread.delete(state.threadId);
    }
  }

  function settleStopWaiters(state, result) {
    for (const waiter of state.stopWaiters) waiter(result);
    state.stopWaiters.clear();
  }

  function isThreadLoaded(app, threadId) {
    if (!loadedThreads.has(threadId)) return false;
    const loadedChild = loadedThreads.get(threadId);
    return !loadedChild || loadedChild === currentChild(app);
  }

  function markRunning(state, turnId) {
    const wasRunning = state.phase === "running";
    const changed = state.turnId !== turnId;
    state.turnId = turnId;
    state.phase = "running";
    for (const key of state.agentText.keys()) {
      if (key !== turnId && key !== "") state.agentText.delete(key);
    }
    if (!wasRunning) {
      emit(state.runId, {
        status: "running",
        refs: { codexThreadId: state.threadId, codexTurnId: turnId },
      });
    } else if (changed) {
      emit(state.runId, { refs: { codexTurnId: turnId } });
    }
  }

  async function startTurnFor(app, state, text, effort) {
    state.phase = "turn-starting";
    let started;
    try {
      started = await app.startTurn({
        threadId: state.threadId,
        input: textInput(text),
        ...(nonEmptyString(effort) ? { effort } : {}),
      });
    } catch (error) {
      if (state.phase === "turn-starting") state.phase = "idle";
      throw error;
    }
    const turnId = started?.turn?.id;
    if (!nonEmptyString(turnId)) {
      if (state.phase === "turn-starting") state.phase = "idle";
      throw new Error("Codex did not provide a turn id");
    }
    // turn/started or even turn/completed may have been delivered before the response.
    if (turnId !== state.lastCompletedTurnId) markRunning(state, turnId);
    return turnId;
  }

  function stateForRun(run) {
    const byId = run?.id ? runs.get(run.id) : undefined;
    if (byId) return byId;
    const threadId = run?.codexThreadId;
    const boundRunId = nonEmptyString(threadId) ? runByThread.get(threadId) : undefined;
    return boundRunId ? runs.get(boundRunId) ?? null : null;
  }

  // Each item is reported once: on item/started when it already carries text (command, tool,
  // file paths), otherwise on item/completed (agent messages). Items without an id are only
  // reported on completion.
  function reportActivity(state, item, completed) {
    const activity = activityForCodexItem(item);
    if (!activity) return;
    const itemId = nonEmptyString(item.id) ? item.id : null;
    if (!itemId && !completed) return;
    if (itemId) {
      if (state.reportedItems.has(itemId)) return;
      state.reportedItems.add(itemId);
    }
    emit(state.runId, { activity });
  }

  function handleNotification(notification, child) {
    const method = notification?.method;
    const params = notification?.params;
    if (method === "app-server/terminated") {
      handleTerminated(child, params?.message);
      return;
    }
    if (!params || typeof params !== "object" || !nonEmptyString(params.threadId)) return;
    const runId = runByThread.get(params.threadId);
    const state = runId ? runs.get(runId) : undefined;
    if (!state) return;
    if (state.child && child && state.child !== child) return;

    if (method === "turn/started") {
      const turnId = params.turn?.id;
      if (!nonEmptyString(turnId) || turnId === state.lastCompletedTurnId) return;
      markRunning(state, turnId);
      return;
    }

    if (method === "item/started" || method === "item/completed") {
      const item = params.item;
      const turnId = nonEmptyString(params.turnId) ? params.turnId : state.turnId;
      if (turnId && turnId === state.lastCompletedTurnId) return;
      reportActivity(state, item, method === "item/completed");
      if (method !== "item/completed") return;
      if (item?.type !== "agentMessage" || typeof item.text !== "string") return;
      state.agentText.set(turnId ?? "", item.text);
      return;
    }

    if (method !== "turn/completed") return;
    const turn = params.turn && typeof params.turn === "object" ? params.turn : {};
    const turnId = nonEmptyString(turn.id) ? turn.id : state.turnId;
    if (turnId && turnId === state.lastCompletedTurnId) return;
    if (state.turnId && turnId && turnId !== state.turnId) {
      log("warn", `ignored turn/completed for stale turn ${turnId} (current ${state.turnId})`);
      return;
    }
    const resultText = (turnId ? state.agentText.get(turnId) : undefined)
      ?? state.agentText.get("")
      ?? lastAgentMessageText(turn.items)
      ?? "";
    state.turnId = turnId ?? state.turnId;
    state.lastCompletedTurnId = turnId ?? null;
    state.phase = "idle";
    state.agentText.clear();
    state.reportedItems.clear();

    let update;
    if (turn.status === "completed") {
      update = { status: "finished", resultText };
    } else if (turn.status === "interrupted") {
      update = { status: "stopped" };
    } else {
      update = {
        status: "failed",
        error: errorMessage(turn.error?.message) || `Codex reported a ${turn.status ?? "failed"} turn`,
      };
    }
    settleStopWaiters(state, {
      stopped: true,
      detail: `Codex turn ${turnId ?? "(unknown)"} ended (${turn.status ?? "unknown"})`,
    });
    emit(state.runId, update);
  }

  function handleTerminated(child, message) {
    for (const [threadId, loadedChild] of loadedThreads) {
      if (!child || !loadedChild || loadedChild === child) loadedThreads.delete(threadId);
    }
    const detail = nonEmptyString(message) ? errorMessage(message) : "Codex app-server terminated";
    for (const state of [...runs.values()]) {
      if (state.child && child && state.child !== child) continue;
      if (state.phase !== "running") continue;
      state.phase = "idle";
      state.lastCompletedTurnId = state.turnId;
      state.agentText.clear();
      settleStopWaiters(state, { stopped: true, detail });
      emit(state.runId, { status: "interrupted", error: detail });
    }
  }

  return {
    name: "codex",

    async available() {
      if (typeof codexVersion !== "function") {
        return { ok: false, reason: "Codex version check is not configured" };
      }
      try {
        const result = await codexVersion();
        const version = typeof result === "string" ? result.trim() : result?.version;
        if (!nonEmptyString(version)) return { ok: false, reason: "Codex CLI was not found" };
        return { ok: true, version };
      } catch (error) {
        return { ok: false, reason: errorMessage(error) || "Codex CLI is unavailable" };
      }
    },

    async start({ runId, cwd, prompt, model, effort } = {}) {
      if (!nonEmptyString(runId)) throw new TypeError("start requires runId");
      if (!nonEmptyString(cwd)) throw new TypeError("start requires cwd");
      if (!nonEmptyString(prompt)) throw new TypeError("start requires prompt");
      if (runs.has(runId)) throw new Error(`Codex run '${runId}' was already started`);
      const app = server();
      const state = createState(runId);
      state.phase = "turn-starting";
      runs.set(runId, state);
      try {
        const started = await app.startThread({
          ...(nonEmptyString(model) ? { model } : {}),
          cwd,
          approvalPolicy: APPROVAL_POLICY,
        });
        const threadId = started?.thread?.id;
        if (!nonEmptyString(threadId)) throw new Error("Codex did not provide a thread id");
        if (disposed || runs.get(runId) !== state) throw new Error("Codex run was abandoned during start");
        state.child = currentChild(app);
        bindThread(state, threadId);
        loadedThreads.set(threadId, state.child);
        threadSettings.set(threadId, {
          cwd,
          model: nonEmptyString(model) ? model : null,
          effort: nonEmptyString(effort) ? effort : null,
        });
        const turnId = await startTurnFor(app, state, prompt, effort);
        return { codexThreadId: threadId, codexTurnId: turnId };
      } catch (error) {
        forgetRun(state);
        throw error;
      }
    },

    async sendFollowup({ run, body, mode } = {}) {
      if (mode !== "steer" && mode !== "queue") {
        throw new TypeError("sendFollowup mode must be 'steer' or 'queue'");
      }
      if (!nonEmptyString(run?.id)) throw new TypeError("sendFollowup requires run");
      if (typeof body !== "string" || !body.trim()) {
        return { delivered: false, detail: "Follow-up body is empty" };
      }
      const threadId = run.codexThreadId;
      if (!nonEmptyString(threadId)) {
        return { delivered: false, detail: "Run has no Codex thread" };
      }
      let app;
      try {
        app = server();
      } catch (error) {
        return { delivered: false, detail: errorMessage(error) };
      }

      if (mode === "steer") {
        const expectedTurnId = run.codexTurnId ?? stateForRun(run)?.turnId;
        if (!nonEmptyString(expectedTurnId)) {
          return { delivered: false, detail: "No Codex turn to steer" };
        }
        const params = { threadId, input: textInput(body), expectedTurnId };
        try {
          const result = typeof app.steerTurn === "function"
            ? await app.steerTurn(params)
            : await app.request("turn/steer", params);
          return {
            delivered: true,
            detail: `Steered Codex turn ${nonEmptyString(result?.turnId) ? result.turnId : expectedTurnId}`,
          };
        } catch (error) {
          return { delivered: false, detail: `Codex turn/steer failed: ${errorMessage(error)}` };
        }
      }

      const bound = stateForRun({ codexThreadId: threadId });
      let state = runs.get(run.id);
      if (bound && bound !== state && bound.phase !== "idle") {
        return {
          delivered: false,
          detail: `Codex thread is still busy with run ${bound.runId}`,
        };
      }
      if (!state) {
        state = createState(run.id);
        state.turnId = run.codexTurnId ?? bound?.turnId ?? null;
        state.lastCompletedTurnId = bound?.lastCompletedTurnId ?? null;
        state.child = bound?.child ?? null;
        runs.set(run.id, state);
      }
      if (state.phase !== "idle") {
        return { delivered: false, detail: "Codex turn is still running; use steer" };
      }
      bindThread(state, threadId);
      const settings = threadSettings.get(threadId);
      try {
        if (!isThreadLoaded(app, threadId)) {
          const resumed = await app.resumeThread({
            threadId,
            ...(settings?.model ? { model: settings.model } : {}),
            ...(settings?.cwd ? { cwd: settings.cwd } : {}),
            approvalPolicy: APPROVAL_POLICY,
          });
          if (resumed?.thread?.id !== threadId) {
            throw new Error("Codex returned an unexpected resumed thread id");
          }
          state.child = currentChild(app);
          loadedThreads.set(threadId, state.child);
        }
        const turnId = await startTurnFor(app, state, body, settings?.effort);
        return { delivered: true, detail: `Started Codex turn ${turnId}` };
      } catch (error) {
        return { delivered: false, detail: `Codex queued follow-up failed: ${errorMessage(error)}` };
      }
    },

    async stop({ run } = {}) {
      const state = stateForRun(run);
      if (state && state.phase === "idle") {
        return { stopped: true, detail: "No Codex turn is running" };
      }
      const threadId = state?.threadId ?? run?.codexThreadId;
      // While a turn/start is still in flight the remembered turn id belongs to an older turn.
      const turnId = state ? (state.phase === "running" ? state.turnId : null) : run?.codexTurnId;
      if (!nonEmptyString(threadId) || !nonEmptyString(turnId)) {
        return { stopped: false, detail: "Codex turn id is not known yet" };
      }
      let app;
      try {
        app = server();
      } catch (error) {
        return { stopped: false, detail: errorMessage(error) };
      }
      if (!state) {
        try {
          await app.interruptTurn({ threadId, turnId });
          return { stopped: true, detail: `Interrupt sent for Codex turn ${turnId}${STOP_STEP_NOTE}` };
        } catch (error) {
          return { stopped: false, detail: `Codex turn/interrupt failed: ${errorMessage(error)}` };
        }
      }

      // Register before sending so a turn/completed that races the response is not missed.
      let settled = false;
      let timer;
      let settle;
      const ended = new Promise((resolve) => {
        settle = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          state.stopWaiters.delete(settle);
          resolve(result);
        };
      });
      state.stopWaiters.add(settle);
      const withNote = (result) => (result.stopped ? { ...result, detail: `${result.detail}${STOP_STEP_NOTE}` } : result);
      try {
        await app.interruptTurn({ threadId, turnId });
      } catch (error) {
        if (settled || state.phase === "idle") {
          settle({ stopped: true, detail: "Codex turn already ended" });
          return ended.then(withNote);
        }
        settle({ stopped: false, detail: `Codex turn/interrupt failed: ${errorMessage(error)}` });
        return ended.then(withNote);
      }
      if (!settled) {
        timer = setTimeout(() => {
          settle({
            stopped: false,
            detail: `Interrupt sent but Codex turn ${turnId} did not end within ${stopTimeoutMs}ms`,
          });
        }, stopTimeoutMs);
      }
      return ended.then(withNote);
    },

    async close({ run } = {}) {
      // Codex threads have no separate session process to end; only drop idle bookkeeping.
      const state = stateForRun(run);
      if (state && state.phase === "idle") forgetRun(state);
    },

    openUrl(run) {
      const threadId = run?.codexThreadId;
      return nonEmptyString(threadId) ? `codex://threads/${encodeURIComponent(threadId)}` : null;
    },

    async recover() {
      // The app-server child does not survive a board restart, so its turns cannot be resumed.
      return { status: "interrupted" };
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      for (const state of runs.values()) {
        settleStopWaiters(state, { stopped: false, detail: "Codex app provider disposed" });
      }
      runs.clear();
      runByThread.clear();
      loadedThreads.clear();
      threadSettings.clear();
      if (ownsAppServer && appServer) await appServer.close();
    },
  };
}
