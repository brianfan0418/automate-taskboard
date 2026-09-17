import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { runAppLinksWorkHere } from "../phoneOnboarding";
import { ApiError, listTaskRuns, type TaskRunActivity } from "../api";
import { providerDisplayName } from "../actors";
import { useTaskboardI18n } from "../i18n";
import { RUN_APP_LINK_EMBEDDED_TEXT, openRunAppUrl, type RunAppOpenOptions, type RunAppOpenResult } from "../hostEmbedding";
import type {
  Task,
  TaskFollowup,
  TaskFollowupMode,
  TaskFollowupStatus,
  TaskRun,
  TaskRunStatus,
  TaskRunWithOpenUrl,
} from "../types";
import "./TaskRunControls.css";

type TextFn = (chinese: string, english: string, taiwanese?: string) => string;

const RUN_STATUS_LABELS: Record<TaskRunStatus, readonly [string, string]> = {
  starting: ["啟動中", "Starting"],
  running: ["處理中", "Running"],
  stopping: ["停止中", "Stopping"],
  finished: ["已完成", "Finished"],
  stopped: ["已停止", "Stopped"],
  failed: ["失敗", "Failed"],
  interrupted: ["已中斷", "Interrupted"],
};

const FOLLOWUP_MODE_LABELS: Record<TaskFollowupMode, readonly [string, string]> = {
  queue: ["排隊", "Queued"],
  steer: ["插嘴", "Interrupt"],
};

const FOLLOWUP_STATUS_LABELS: Record<TaskFollowupStatus, readonly [string, string]> = {
  pending: ["等待送出", "Pending"],
  sent: ["已送出", "Sent"],
  failed: ["送出失敗", "Failed"],
  canceled: ["已取消", "Canceled"],
};

const ACTIVE_RUN_STATUSES: readonly TaskRunStatus[] = ["starting", "running", "stopping"];

const ACTIVITY_KIND_LABELS: Record<string, readonly [string, string]> = {
  message: ["訊息", "Message"],
  command: ["指令", "Command"],
  file: ["檔案", "File"],
  tool: ["工具", "Tool"],
  status: ["狀態", "Status"],
};

/** Same cap as the server ring buffer (TICKETS Amendment 2: last 200 per run). */
export const TASK_RUN_ACTIVITY_LIMIT = 200;
/** Lines shown in the detail panel (newest at the bottom). */
export const TASK_RUN_ACTIVITY_VISIBLE = 30;

/**
 * Live run events forwarded from the board's SSE stream (App LocalRealtimeSync) to open run panels.
 * A module-level bus keeps TaskDetail's props unchanged.
 */
export type TaskRunLiveEvent =
  | { type: "run.activity"; taskId: string; runId: string | null; activity: TaskRunActivity }
  | { type: "run.updated"; taskId: string; run: TaskRun | null }
  | { type: "followup.updated"; taskId: string; followup?: TaskFollowup | null };

const taskRunListeners = new Set<(event: TaskRunLiveEvent) => void>();

export function publishTaskRunEvent(event: TaskRunLiveEvent) {
  for (const listener of [...taskRunListeners]) {
    try {
      listener(event);
    } catch (error) {
      console.error(error);
    }
  }
}

export function subscribeTaskRunEvents(listener: (event: TaskRunLiveEvent) => void): () => void {
  taskRunListeners.add(listener);
  return () => {
    taskRunListeners.delete(listener);
  };
}

/** Server marker: a steer that was not confirmed was converted to a queued follow-up (W3 smoke bug 1). */
export const STEER_NOT_DELIVERED_QUEUED = "STEER_NOT_DELIVERED_QUEUED";
/** Server marker: the converted steer could not be sent because the run had already ended. */
export const STEER_NOT_DELIVERED_RUN_ENDED = "STEER_NOT_DELIVERED_RUN_ENDED";
/** Server marker (W4 retest bug A): the AI was at a permission prompt, so the steer was queued instead of typed. */
export const STEER_WAITING_PERMISSION_QUEUED = "STEER_WAITING_PERMISSION_QUEUED";
/** Server marker (W4 review): a steer still being delivered when the board restarted. */
export const STEER_INTERRUPTED_BY_RESTART = "STEER_INTERRUPTED_BY_RESTART";
/** Server marker (W4 review): the run ended failed / interrupted / stopped, so queued messages were canceled. */
export const RUN_ENDED = "RUN_ENDED";
export const STEER_QUEUED_TEXT = "插嘴沒有送達（AI 正在執行長指令），已改為排隊，本輪結束後送出";
export const STEER_RUN_ENDED_TEXT = "插嘴沒有送達，AI 已經結束這一輪，訊息沒有送出。";
export const STEER_WAITING_PERMISSION_TEXT = "AI 正在等待權限確認，訊息已改為排隊；請先到 App 處理確認";
export const STEER_QUEUED_SENT_TEXT = "已改為排隊並已送出";
export const STEER_RESTART_TEXT = "看板重新啟動時插嘴還沒送達，訊息沒有送出。";
export const RUN_ENDED_CANCELED_TEXT = "任務已結束，排隊訊息已取消";
export const CODEX_RUN_ACTIVE_APP_TEXT = "任務執行中，完成後才能在 Codex App 開啟";

const STEER_CONVERSION_CODES = new Set([STEER_NOT_DELIVERED_QUEUED, STEER_WAITING_PERMISSION_QUEUED]);

/** People-facing text for a follow-up error code; other errors pass through. */
export function followupErrorText(error: string | null | undefined, text: TextFn): string | null {
  if (!error) return null;
  if (error === STEER_NOT_DELIVERED_QUEUED) {
    return text(STEER_QUEUED_TEXT, "The interruption did not reach the AI (it is running a long command). It was queued and will be sent when this turn ends.");
  }
  if (error === STEER_WAITING_PERMISSION_QUEUED) {
    return text(STEER_WAITING_PERMISSION_TEXT, "The AI is waiting for a permission confirmation, so the message was queued. Handle the confirmation in the App first.");
  }
  if (error === STEER_NOT_DELIVERED_RUN_ENDED) {
    return text(STEER_RUN_ENDED_TEXT, "The interruption did not reach the AI and the turn has ended, so the message was not sent.");
  }
  if (error === STEER_INTERRUPTED_BY_RESTART) {
    return text(STEER_RESTART_TEXT, "The board restarted before the interruption was delivered, so it was not sent.");
  }
  if (error === RUN_ENDED) {
    return text(RUN_ENDED_CANCELED_TEXT, "The task ended, so the queued message was canceled.");
  }
  return error;
}

/**
 * Note shown under a follow-up in the run panel. A converted steer that was later sent is not a
 * failure (W4 retest bug D): it reads 「已改為排隊並已送出」.
 */
export function followupNote(followup: TaskFollowup, text: TextFn): { kind: "notice" | "error"; message: string } | null {
  if (!followup.error) return null;
  if (followup.status === "sent" && STEER_CONVERSION_CODES.has(followup.error)) {
    return { kind: "notice", message: text(STEER_QUEUED_SENT_TEXT, "Queued instead, and sent.") };
  }
  const message = followupErrorText(followup.error, text) ?? followup.error;
  const notice = followup.error === RUN_ENDED
    || (followup.status === "pending" && STEER_CONVERSION_CODES.has(followup.error));
  return { kind: notice ? "notice" : "error", message };
}

/**
 * Composer status line for the follow-up the person just sent, updated from followup.updated
 * (W3 smoke bug 3: the request answers before delivery). 送出中 → 已送達 / 已改排隊 / 失敗.
 */
export function followupDeliveryState(
  followup: TaskFollowup,
  providerName: string,
  text: TextFn,
): { kind: "notice" | "error"; message: string } {
  if (followup.status === "sent") {
    if (followup.error && STEER_CONVERSION_CODES.has(followup.error)) {
      return { kind: "notice", message: text(STEER_QUEUED_SENT_TEXT, "Queued instead, and sent.") };
    }
    return { kind: "notice", message: text(`已送達 ${providerName}。`, `Delivered to ${providerName}.`) };
  }
  if (followup.status === "canceled" && followup.error === RUN_ENDED) {
    return { kind: "notice", message: followupErrorText(followup.error, text)! };
  }
  if (followup.status === "canceled") {
    return { kind: "notice", message: text("訊息已取消（AI 已停止）。", "The message was canceled (the AI run stopped).") };
  }
  if (followup.status === "failed") {
    return {
      kind: "error",
      message: followupErrorText(followup.error, text) ?? text("訊息沒有送達 AI。", "The message did not reach the AI."),
    };
  }
  if (followup.mode === "steer") {
    return { kind: "notice", message: text(`插嘴送出中，正在確認 ${providerName} 是否收到…`, `Sending the interruption; checking that ${providerName} received it…`) };
  }
  if (followup.error && STEER_CONVERSION_CODES.has(followup.error)) {
    return { kind: "notice", message: followupErrorText(followup.error, text)! };
  }
  return {
    kind: "notice",
    message: text(
      `已排隊，${providerName} 做完目前這一輪後會送出。`,
      `Queued. It will be sent after ${providerName} finishes the current turn.`,
    ),
  };
}

/**
 * 「在 App 開啟」 target (W3 note): an active Codex run in the server list blocks the fallback to an
 * older run (the board's app-server still owns that thread).
 */
export function pickTaskRunAppUrl(
  runs: readonly TaskRunWithOpenUrl[],
  targetRunId: string | null | undefined,
): { url: string } | { blocked: "codex-run-active" } | null {
  if (runs.some((run) => run.provider === "codex" && isActiveTaskRun(run))) return { blocked: "codex-run-active" };
  const openable = runs.filter((run) => run.openUrl && taskRunHasAppLink(run));
  const url = openable.find((run) => run.id === targetRunId)?.openUrl ?? openable[0]?.openUrl ?? null;
  return url ? { url } : null;
}

/** Task copy with `run` merged into activeRun/latestRun (SSE run.updated). */
export function mergeRunIntoTask(task: Task, run: TaskRun): Task {
  const activeRun = ACTIVE_RUN_STATUSES.includes(run.status)
    ? run
    : task.activeRun?.id === run.id ? null : task.activeRun ?? null;
  const latestRun = !task.latestRun
    || task.latestRun.id === run.id
    || run.createdAt >= task.latestRun.createdAt
    ? run
    : task.latestRun;
  return { ...task, activeRun, latestRun };
}

/** Appends one live activity; a different run id starts a new list. Pure, for the panel and its tests. */
export function appendTaskRunActivity(
  current: { runId: string | null; items: TaskRunActivity[] },
  runId: string | null,
  activity: TaskRunActivity,
): { runId: string | null; items: TaskRunActivity[] } {
  if (runId && current.runId && runId !== current.runId) {
    return { runId, items: [activity] };
  }
  const items = [...current.items, activity];
  return {
    runId: current.runId ?? runId,
    items: items.length > TASK_RUN_ACTIVITY_LIMIT ? items.slice(-TASK_RUN_ACTIVITY_LIMIT) : items,
  };
}

function activityKey(item: TaskRunActivity): string {
  return `${item.at ?? item.createdAt ?? ""}|${item.kind}|${item.text}`;
}

/**
 * Seeds the list from `GET /api/tasks/:id/runs` without dropping live events that arrived while the
 * request was in flight: live items for the same run that the server snapshot does not contain are
 * kept after the seed (W3 review fix). A different run id takes the seed only.
 */
export function seedTaskRunActivity(
  current: { runId: string | null; items: TaskRunActivity[] },
  runId: string | null,
  seed: TaskRunActivity[],
): { runId: string | null; items: TaskRunActivity[] } {
  const sameRun = !current.runId || !runId || current.runId === runId;
  const seen = new Set(seed.map(activityKey));
  const extra = sameRun ? current.items.filter((item) => !seen.has(activityKey(item))) : [];
  const items = [...seed, ...extra];
  return {
    runId: runId ?? (sameRun ? current.runId : null),
    items: items.length > TASK_RUN_ACTIVITY_LIMIT ? items.slice(-TASK_RUN_ACTIVITY_LIMIT) : items,
  };
}

export function taskRunStatusLabel(status: TaskRunStatus, text: TextFn): string {
  const [chinese, english] = RUN_STATUS_LABELS[status] ?? [status, status];
  return text(chinese, english);
}

export function isActiveTaskRun(run: TaskRun | null | undefined): run is TaskRun {
  return Boolean(run && ACTIVE_RUN_STATUSES.includes(run.status));
}

// Mirrors the refs each provider needs for openUrl (CONTRACTS C3); the URL itself comes from the server.
// INTEGRATION Amendment 3: a Codex thread is only offered in the Codex App once the run is no longer
// active (the board's app-server still owns the turn while it runs).
export function taskRunHasAppLink(run: TaskRun | null | undefined): boolean {
  if (!run) return false;
  if (run.provider === "claude") return Boolean(run.claudeBridgeSessionId);
  return Boolean(run.codexThreadId) && !isActiveTaskRun(run);
}

/** Full Codex thread id to copy (「複製對話編號」), or null. */
export function taskRunConversationId(run: TaskRun | null | undefined): string | null {
  if (!run || run.provider !== "codex") return null;
  return run.codexThreadId || null;
}

const CLAUDE_PERMISSION_SOURCE_LABELS: Record<string, readonly [string, string]> = {
  board: ["看板設定", "board setting"],
  fallback: ["Claude 沒有設定，看板預設", "no Claude setting, board fallback"],
  managed: ["組織管理設定", "managed settings"],
  projectLocal: ["專案 .claude/settings.local.json", "project .claude/settings.local.json"],
  project: ["專案 .claude/settings.json", "project .claude/settings.json"],
  user: ["使用者 settings.json", "user settings.json"],
};

/** CONTRACTS Amendment 6: 「Claude 權限：acceptEdits（專案 .claude/settings.json）」, or null when not recorded. */
export function taskRunClaudePermissionText(run: TaskRun | null | undefined, text: TextFn): string | null {
  if (!run || run.provider !== "claude" || !run.claudePermissionSource) return null;
  const mode = run.claudePermissionMode ?? text("Claude 內建預設", "Claude's built-in default");
  const [chinese, english] = CLAUDE_PERMISSION_SOURCE_LABELS[run.claudePermissionSource]
    ?? [run.claudePermissionSource, run.claudePermissionSource];
  return text(`Claude 權限：${mode}（${chinese}）`, `Claude permissions: ${mode} (${english})`);
}

export const WAITING_FOR_PERMISSION_PREFIX = "WAITING_FOR_PERMISSION:";

export function isWaitingForPermissionError(error: string | null | undefined): boolean {
  return typeof error === "string" && error.startsWith(WAITING_FOR_PERMISSION_PREFIX);
}

/** Run error for people: the raw WAITING_FOR_PERMISSION code becomes a plain instruction. */
export function taskRunErrorText(error: string | null | undefined, text: TextFn): string | null {
  if (!error) return null;
  if (isWaitingForPermissionError(error)) {
    return text("AI 在等待權限確認，請到 App 查看", "The AI is waiting for a permission confirmation. Check it in the app.");
  }
  return error;
}

async function copyToClipboard(value: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall back below (e.g. the page is not a secure context on a phone).
    }
  }
  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    if (!document.execCommand("copy")) throw new Error("copy failed");
  } finally {
    area.remove();
  }
}

/** 「複製對話編號」: copies the full Codex thread id. */
export function TaskRunCopyConversationIdButton({
  run,
  className = "task-run-card-button",
}: {
  run: TaskRun | null | undefined;
  className?: string;
}) {
  const { text } = useTaskboardI18n();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const conversationId = taskRunConversationId(run);
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);
  if (!conversationId) return null;
  return (
    <button
      type="button"
      className={className}
      title={conversationId}
      aria-label={text(`複製對話編號 ${conversationId}`, `Copy conversation ID ${conversationId}`)}
      onClick={(event) => {
        event.stopPropagation();
        copyToClipboard(conversationId).then(() => setState("copied"), () => setState("failed"));
      }}
    >
      {state === "copied"
        ? text("已複製", "Copied")
        : state === "failed"
          ? text("複製失敗", "Copy failed")
          : text("複製對話編號", "Copy conversation ID")}
    </button>
  );
}

// E1: same open path as App (openRunUrl): host bridge when embedded, else navigate so the OS hands off the scheme.
export function openTaskRunUrl(url: string, options?: RunAppOpenOptions): RunAppOpenResult {
  return openRunAppUrl(url, options);
}

function formatTime(value: string | null, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(date);
}

function errorMessage(error: unknown, text: TextFn): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return text("無法讀取 AI 執行紀錄。", "Could not load AI runs.");
}

interface TaskRunPanelProps {
  task: Task;
  // Bump to reload after a local action (for example a follow-up was sent).
  revision?: number;
  children?: ReactNode;
}

export function TaskRunPanel({ task, revision = 0, children }: TaskRunPanelProps) {
  const { locale, text } = useTaskboardI18n();
  const [runs, setRuns] = useState<TaskRunWithOpenUrl[]>([]);
  const [followups, setFollowups] = useState<TaskFollowup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveActivity, setLiveActivity] = useState<{ runId: string | null; items: TaskRunActivity[] }>(
    { runId: null, items: [] },
  );
  const [followupRevision, setFollowupRevision] = useState(0);
  const [openError, setOpenError] = useState<string | null>(null);
  const activityListRef = useRef<HTMLOListElement>(null);
  const reloadKey = [
    task.id,
    task.status,
    task.updatedAt,
    task.activeRun?.id,
    task.activeRun?.status,
    task.activeRun?.updatedAt,
    task.latestRun?.id,
    task.latestRun?.status,
    task.latestRun?.updatedAt,
    revision,
    followupRevision,
  ].join("|");

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void listTaskRuns(task.id, controller.signal).then(
      (data) => {
        const sortedRuns = [...data.runs].sort((left, right) => (
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
        ));
        setRuns(sortedRuns);
        setFollowups(data.followups);
        // Seed the live list from the server's buffer for the active/latest run.
        setLiveActivity((current) => seedTaskRunActivity(
          current,
          data.activityRunId ?? sortedRuns[0]?.id ?? null,
          data.activity.slice(-TASK_RUN_ACTIVITY_LIMIT),
        ));
        setLoading(false);
      },
      (loadError) => {
        if ((loadError as Error).name === "AbortError") return;
        setError(errorMessage(loadError, text));
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [reloadKey]);

  useEffect(() => subscribeTaskRunEvents((event) => {
    if (event.taskId !== task.id) return;
    if (event.type === "run.activity") {
      setLiveActivity((current) => appendTaskRunActivity(current, event.runId, event.activity));
    } else if (event.type === "followup.updated") {
      setFollowupRevision((current) => current + 1);
    }
  }), [task.id]);

  const visibleActivity = liveActivity.items.slice(-TASK_RUN_ACTIVITY_VISIBLE);
  useEffect(() => {
    const list = activityListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [liveActivity]);

  const fallbackRun = task.activeRun ?? task.latestRun ?? null;
  const latest: TaskRunWithOpenUrl | null = runs[0]
    ?? (fallbackRun ? { ...fallbackRun, openUrl: null } : null);
  const latestActive = latest !== null && ACTIVE_RUN_STATUSES.includes(latest.status);
  const startedAt = formatTime(latest?.startedAt ?? null, locale);
  const endedAt = formatTime(latest?.endedAt ?? null, locale);
  const latestPermission = taskRunClaudePermissionText(latest, text);

  function openInApp(event: MouseEvent<HTMLAnchorElement>, url: string) {
    event.preventDefault();
    setOpenError(null);
    if (openTaskRunUrl(url) === "unsupported-embedded") {
      setOpenError(text(RUN_APP_LINK_EMBEDDED_TEXT[0], RUN_APP_LINK_EMBEDDED_TEXT[1]));
    }
  }

  return (
    <section className="task-run-panel" aria-labelledby={`task-run-heading-${task.id}`}>
      <header className="task-run-panel-heading">
        <h2 id={`task-run-heading-${task.id}`}>{text("AI 執行", "AI run")}</h2>
        {latest && (
          <span className={`task-run-chip is-${latest.status}`}>
            {`${providerDisplayName(latest.provider)} · ${taskRunStatusLabel(latest.status, text)}`}
          </span>
        )}
        <span className="task-run-panel-spacer" aria-hidden="true" />
        {latest && <TaskRunCopyConversationIdButton run={latest} className="task-run-copy-id" />}
        {latest?.openUrl && taskRunHasAppLink(latest) && runAppLinksWorkHere() && (
          <a
            className="task-run-open-link"
            href={latest.openUrl}
            onClick={(event) => openInApp(event, latest.openUrl!)}
          >
            {text("在 App 開啟", "Open in app")}
          </a>
        )}
      </header>

      {error && <p className="task-run-error" role="alert">{error}</p>}
      {openError && <p className="task-run-error" role="alert">{openError}</p>}
      {loading && !latest && (
        <p className="task-run-muted" aria-busy="true">{text("正在讀取執行紀錄…", "Loading runs…")}</p>
      )}
      {!loading && !error && !latest && (
        <p className="task-run-muted">{text("這張卡還沒有 AI 執行紀錄。", "This card has no AI runs yet.")}</p>
      )}

      {latest && (startedAt || endedAt) && (
        <p className="task-run-times">
          {startedAt && text(`開始 ${startedAt}`, `Started ${startedAt}`)}
          {startedAt && endedAt && " · "}
          {endedAt && text(`結束 ${endedAt}`, `Ended ${endedAt}`)}
        </p>
      )}
      {latestPermission && <p className="task-run-times task-run-permission">{latestPermission}</p>}
      {latest?.error && (
        <p className={`task-run-error${isWaitingForPermissionError(latest.error) ? " is-waiting-permission" : ""}`} role={isWaitingForPermissionError(latest.error) ? "status" : undefined}>
          {taskRunErrorText(latest.error, text)}
        </p>
      )}
      {visibleActivity.length > 0 && (
        <div className="task-run-activity">
          <span className="task-run-label">
            {latestActive ? text("即時動態", "Live activity") : text("最近動態", "Recent activity")}
            {liveActivity.items.length > visibleActivity.length && (
              <span className="task-run-activity-count">
                {text(
                  `（最近 ${visibleActivity.length} / ${liveActivity.items.length} 則）`,
                  ` (latest ${visibleActivity.length} of ${liveActivity.items.length})`,
                )}
              </span>
            )}
          </span>
          <ol ref={activityListRef} aria-live={latestActive ? "polite" : undefined}>
            {visibleActivity.map((item, index) => {
              const [kindChinese, kindEnglish] = ACTIVITY_KIND_LABELS[item.kind] ?? [item.kind, item.kind];
              const time = formatTime(item.at ?? item.createdAt ?? null, locale);
              return (
                <li key={`${liveActivity.items.length - visibleActivity.length + index}`} className={`is-${item.kind}`}>
                  <span className="task-run-activity-kind">{text(kindChinese, kindEnglish)}</span>
                  <span className="task-run-activity-text">{item.text}</span>
                  {time && <time dateTime={item.at ?? item.createdAt}>{time}</time>}
                </li>
              );
            })}
          </ol>
        </div>
      )}
      {latest && !latestActive && latest.resultText !== null && (
        <div className="task-run-result">
          <span className="task-run-label">{text("AI 結論", "AI result")}</span>
          <p>{latest.resultText || text("（AI 沒有回傳文字）", "(The AI returned no text)")}</p>
        </div>
      )}

      {children}

      {followups.length > 0 && (
        <div className="task-run-followups">
          <span className="task-run-label">{text("追加訊息", "Follow-up messages")}</span>
          <ul>
            {followups.map((followup) => {
              const [modeChinese, modeEnglish] = FOLLOWUP_MODE_LABELS[followup.mode] ?? [followup.mode, followup.mode];
              const [statusChinese, statusEnglish] = followup.status === "pending" && followup.mode === "steer"
                ? ["送出中", "Sending"]
                : FOLLOWUP_STATUS_LABELS[followup.status] ?? [followup.status, followup.status];
              const createdAt = formatTime(followup.createdAt, locale);
              const note = followupNote(followup, text);
              return (
                <li key={followup.id}>
                  <span className="task-run-followup-meta">
                    <span>{text(modeChinese, modeEnglish)}</span>
                    <span>{text(statusChinese, statusEnglish)}</span>
                    {createdAt && <time dateTime={followup.createdAt}>{createdAt}</time>}
                  </span>
                  <p className="task-run-followup-body">{followup.body}</p>
                  {note && (
                    <p className={note.kind === "notice" ? "task-run-notice" : "task-run-error"}>
                      {note.message}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {runs.length > 1 && (
        <details className="task-run-history">
          <summary>{text(`執行紀錄（${runs.length}）`, `Run history (${runs.length})`)}</summary>
          <ol>
            {runs.map((run) => {
              const runStartedAt = formatTime(run.startedAt ?? run.createdAt, locale);
              const runEndedAt = formatTime(run.endedAt, locale);
              return (
                <li key={run.id}>
                  <span className="task-run-history-meta">
                    <span>{providerDisplayName(run.provider)}</span>
                    <span>{taskRunStatusLabel(run.status, text)}</span>
                    {runStartedAt && <span>{runStartedAt}</span>}
                    {runEndedAt && <span>{`→ ${runEndedAt}`}</span>}
                  </span>
                  {run.error && <p className="task-run-error">{taskRunErrorText(run.error, text)}</p>}
                </li>
              );
            })}
          </ol>
        </details>
      )}
    </section>
  );
}
