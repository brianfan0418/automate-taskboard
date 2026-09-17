import { ApiError } from "./api";
import type { ActorIdentity, Task, TaskRun, TaskStatus } from "./types";

/*
 * DBG-08 (BLUEPRINT §4.2): an AI card that already ran and now waits in 等你確認 (in_review) or 卡住
 * (blocked) goes back to 處理中 (in_progress) only by continuing the same AI conversation with a message.
 * A plain status move would show 處理中 with no AI working. Every board path that can make that move
 * (drag and drop, mobile long-press drag, context menu, detail status picker, Ctrl+Z undo) asks this guard
 * first and opens the continue flow (message required → continueTask) instead. The mobile destination
 * sheet already hides the move (mobileUiModel.mobileMoveDestinations).
 * The server answers such a plain move with 409 CONTINUE_MESSAGE_REQUIRED; that is handled the same way.
 * A card whose last run never reached an AI session (launch failed, no refs) has nothing to continue: the
 * guard and the server (409 REWORK_REQUIRED) route it to the rework flow (comment + 退回重做) instead.
 */

export const CONTINUE_MESSAGE_REQUIRED = "CONTINUE_MESSAGE_REQUIRED";
export const REWORK_REQUIRED = "REWORK_REQUIRED";

export type ContinueGuardTask = Pick<Task, "status" | "assignee"> & Partial<Pick<Task, "activeRun" | "latestRun">>;
type GuardRun = Pick<TaskRun, "status"> & Partial<Pick<TaskRun, "claudeShortId" | "claudeSessionId" | "codexThreadId">>;
type GuardActor = Pick<ActorIdentity, "type" | "id"> | null | undefined;

export const CONTINUE_FLOW_HINT_TEXT = [
  "要讓 AI 接著處理，請在下方輸入訊息後按「繼續」。",
  "To let the AI pick this up again, type a message below and press Continue.",
] as const;

/** DBG-08 follow-up: shown when the last run never reached an AI session, so only rework is possible. */
export const REWORK_FLOW_HINT_TEXT = [
  "上一次沒有成功開工，請改用「退回重做」",
  "The last run never started. Send the card back for rework instead.",
] as const;

/** Which flow replaces a plain move: "continue" (message to the same AI session) or "rework". */
export type ContinueFlowKind = "continue" | "rework";

const ACTIVE_RUN_STATUSES: readonly string[] = ["starting", "running", "stopping"];
const AI_AGENT_IDS: readonly string[] = ["claude-agent", "codex-agent"];

function isAiAssignee(actor: GuardActor): boolean {
  return actor?.type === "agent" && AI_AGENT_IDS.includes(actor.id);
}

/** A run that reached an AI session (Claude short / session id or Codex thread id). Mirrors the server. */
export function runHasSessionRefs(run: Partial<GuardRun> | null | undefined): boolean {
  return Boolean(run && (run.claudeSessionId || run.claudeShortId || run.codexThreadId));
}

/**
 * Mirrors the server's assertNoSilentContinue: in_review/blocked → in_progress with no active run, a
 * previous run and an AI assignee (current or requested). A previous run without session refs → "rework".
 */
export function continueFlowFor(
  task: ContinueGuardTask,
  destination: TaskStatus,
  { requestedAssignee }: { requestedAssignee?: GuardActor } = {},
): ContinueFlowKind | null {
  if (destination !== "in_progress") return null;
  if (task.status !== "in_review" && task.status !== "blocked") return null;
  const activeRun = task.activeRun as GuardRun | null | undefined;
  if (activeRun && ACTIVE_RUN_STATUSES.includes(activeRun.status)) return null;
  if (!task.latestRun) return null;
  if (!isAiAssignee(task.assignee) && !isAiAssignee(requestedAssignee)) return null;
  return runHasSessionRefs(task.latestRun) ? "continue" : "rework";
}

/** True when a plain status move must be replaced by the continue or rework flow. */
export function requiresContinueMessage(
  task: ContinueGuardTask,
  destination: TaskStatus,
  options: { requestedAssignee?: GuardActor } = {},
): boolean {
  return continueFlowFor(task, destination, options) !== null;
}

export function isContinueMessageRequiredError(error: unknown): boolean {
  return continueFlowForError(error) !== null;
}

/** The flow a server refusal asks for: 409 CONTINUE_MESSAGE_REQUIRED → continue, 409 REWORK_REQUIRED → rework. */
export function continueFlowForError(error: unknown): ContinueFlowKind | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === CONTINUE_MESSAGE_REQUIRED) return "continue";
  if (error.code === REWORK_REQUIRED) return "rework";
  return null;
}

export type GuardedStatusMoveResult<T> =
  | { kind: "moved"; value: T }
  | { kind: "continue"; reason: "guard" | "server"; flow: ContinueFlowKind };

/**
 * Run a status move unless it needs the continue (or rework) flow. `openContinue` is called instead of
 * `move` when the guard matches, or after `move` fails with 409 CONTINUE_MESSAGE_REQUIRED /
 * REWORK_REQUIRED (then `onServerRefusal` runs first, e.g. to roll back an optimistic update). Other
 * errors are rethrown.
 */
export async function guardedStatusMove<T>({
  task,
  destination,
  requestedAssignee,
  move,
  openContinue,
  onServerRefusal,
}: {
  task: ContinueGuardTask;
  destination: TaskStatus;
  requestedAssignee?: GuardActor;
  move: () => Promise<T>;
  openContinue: (reason: "guard" | "server", flow: ContinueFlowKind) => void;
  onServerRefusal?: (error: ApiError) => void;
}): Promise<GuardedStatusMoveResult<T>> {
  const flow = continueFlowFor(task, destination, { requestedAssignee });
  if (flow) {
    openContinue("guard", flow);
    return { kind: "continue", reason: "guard", flow };
  }
  try {
    return { kind: "moved", value: await move() };
  } catch (error) {
    const refusal = continueFlowForError(error);
    if (!refusal) throw error;
    onServerRefusal?.(error as ApiError);
    openContinue("server", refusal);
    return { kind: "continue", reason: "server", flow: refusal };
  }
}
