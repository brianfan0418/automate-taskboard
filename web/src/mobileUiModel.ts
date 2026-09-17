import { TASK_STATUSES, type TaskStatus } from "./types";

export const MOBILE_BOARD_MAX_WIDTH = 719;
export const MOBILE_BOARD_MEDIA_QUERY = `(max-width: ${MOBILE_BOARD_MAX_WIDTH}px)`;
export const MOBILE_LONG_PRESS_MS = 300;
export const MOBILE_DRAG_SLOP_PX = 8;
export const MOBILE_EDGE_SCROLL_ZONE_PX = 72;
export const MOBILE_EDGE_SCROLL_MAX_PX = 18;
export const MOBILE_COLLAPSED_STORAGE_KEY = "taskboard.mobile.collapsed";
export const MOBILE_DEFAULT_COLLAPSED_STATUSES: readonly TaskStatus[] = ["done", "canceled"];

export interface MobileDropRect {
  id: string;
  top: number;
  height: number;
}

export interface MobileMoveTask {
  status: TaskStatus;
  assignee?: { type: string } | null;
}

export function isMobileBoardViewport(width: number): boolean {
  return Number.isFinite(width) && width <= MOBILE_BOARD_MAX_WIDTH;
}

export function exceededMobileDragSlop(startX: number, startY: number, x: number, y: number): boolean {
  return Math.hypot(x - startX, y - startY) > MOBILE_DRAG_SLOP_PX;
}

export function mobileDropBeforeTaskId(
  rects: readonly MobileDropRect[],
  draggedTaskId: string,
  pointerY: number,
): string | null {
  return rects
    .filter((rect) => rect.id !== draggedTaskId)
    .find((rect) => pointerY < rect.top + rect.height / 2)
    ?.id ?? null;
}

export function mobileEdgeScrollDelta(pointerY: number, viewportHeight: number): number {
  if (!Number.isFinite(pointerY) || !Number.isFinite(viewportHeight) || viewportHeight <= 0) return 0;
  if (pointerY < MOBILE_EDGE_SCROLL_ZONE_PX) {
    const ratio = Math.max(0, Math.min(1, (MOBILE_EDGE_SCROLL_ZONE_PX - pointerY) / MOBILE_EDGE_SCROLL_ZONE_PX));
    return -Math.max(1, Math.round(MOBILE_EDGE_SCROLL_MAX_PX * ratio));
  }
  const lowerEdge = viewportHeight - MOBILE_EDGE_SCROLL_ZONE_PX;
  if (pointerY > lowerEdge) {
    const ratio = Math.max(0, Math.min(1, (pointerY - lowerEdge) / MOBILE_EDGE_SCROLL_ZONE_PX));
    return Math.max(1, Math.round(MOBILE_EDGE_SCROLL_MAX_PX * ratio));
  }
  return 0;
}

export function mobileCanonicalView<T extends string>(view: T, width: number): T | "issues" {
  if (isMobileBoardViewport(width) && (view === "issues" || view === "list")) return "issues";
  return view;
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

function orderedStatuses(statuses: Iterable<unknown>): TaskStatus[] {
  const selected = new Set<TaskStatus>();
  for (const status of statuses) {
    if (isTaskStatus(status)) selected.add(status);
  }
  return TASK_STATUSES.filter((status) => selected.has(status));
}

/** Parses the stored collapsed sections. Missing or malformed values fall back to the defaults. */
export function parseMobileCollapsedStatuses(raw: string | null | undefined): TaskStatus[] {
  if (raw === null || raw === undefined) return [...MOBILE_DEFAULT_COLLAPSED_STATUSES];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? orderedStatuses(value) : [...MOBILE_DEFAULT_COLLAPSED_STATUSES];
  } catch {
    return [...MOBILE_DEFAULT_COLLAPSED_STATUSES];
  }
}

export function serializeMobileCollapsedStatuses(statuses: Iterable<TaskStatus>): string {
  return JSON.stringify(orderedStatuses(statuses));
}

export function toggleMobileCollapsedStatus(statuses: readonly TaskStatus[], status: TaskStatus): TaskStatus[] {
  return statuses.includes(status)
    ? statuses.filter((candidate) => candidate !== status)
    : orderedStatuses([...statuses, status]);
}

export function readMobileCollapsedStatuses(storage: Pick<Storage, "getItem"> | null | undefined): TaskStatus[] {
  try {
    return parseMobileCollapsedStatuses(storage?.getItem(MOBILE_COLLAPSED_STORAGE_KEY) ?? null);
  } catch {
    return [...MOBILE_DEFAULT_COLLAPSED_STATUSES];
  }
}

export function writeMobileCollapsedStatuses(
  storage: Pick<Storage, "setItem"> | null | undefined,
  statuses: Iterable<TaskStatus>,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(MOBILE_COLLAPSED_STORAGE_KEY, serializeMobileCollapsedStatuses(statuses));
    return true;
  } catch {
    return false;
  }
}

/*
 * Destination sheet targets per BLUEPRINT §4.2. A plain status move is offered only where §4.2 does
 * not require more than a status change. For agent-assigned cards:
 * - in_progress → backlog/todo/canceled only (the server stops the run first); in_review/blocked come
 *   from run events and done must go through human review.
 * - in_review → todo needs a comment (rework) and in_review/blocked → in_progress needs a message
 *   (continue in the same AI conversation); both are done from the task detail page.
 * User-assigned cards keep the upstream behaviour: any other status.
 */
const AGENT_DETAIL_ONLY_DESTINATIONS: Partial<Record<TaskStatus, readonly TaskStatus[]>> = {
  in_progress: ["in_review", "blocked", "done"],
  in_review: ["todo", "in_progress"],
  blocked: ["in_progress"],
};

function isAgentTask(task: MobileMoveTask): boolean {
  return task.assignee?.type === "agent";
}

export function mobileMoveDestinations(task: MobileMoveTask): TaskStatus[] {
  const excluded = isAgentTask(task) ? AGENT_DETAIL_ONLY_DESTINATIONS[task.status] ?? [] : [];
  return TASK_STATUSES.filter((status) => status !== task.status && !excluded.includes(status));
}

/** True when the card has §4.2 flows (continue / send back with a comment) that live on the detail page. */
export function mobileMoveNeedsDetail(task: MobileMoveTask): boolean {
  return isAgentTask(task) && (task.status === "in_review" || task.status === "blocked");
}
