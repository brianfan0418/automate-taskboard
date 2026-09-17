import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { providerDisplayName, providerForAssignee } from "../actors";
import { taskPriorityLabel, taskStatusLabel, useTaskboardI18n } from "../i18n";
import {
  MOBILE_BOARD_MEDIA_QUERY,
  MOBILE_LONG_PRESS_MS,
  exceededMobileDragSlop,
  isMobileBoardViewport,
  mobileDropBeforeTaskId,
  mobileEdgeScrollDelta,
  readMobileCollapsedStatuses,
  toggleMobileCollapsedStatus,
  writeMobileCollapsedStatuses,
} from "../mobileUiModel";
import { taskboardStorage } from "../storage";
import type { TaskCardPresentation } from "../taskConversations";
import { TASK_STATUSES, type Task, type TaskStatus } from "../types";
import { ActorAvatar } from "./ActorAvatar";
import { LinearIcon } from "./LinearIcon";
import { MobileMoveSheet } from "./MobileMoveSheet";
import { DueDateIcon, PriorityIcon, StatusIcon } from "./SemanticIcons";
import { isActiveTaskRun, isWaitingForPermissionError, taskRunErrorText, taskRunHasAppLink } from "./TaskRunPanel";
import "./MobileIssueBoard.css";
import "./TaskRunControls.css";

export interface MobileBoardProps {
  /** Same grouping App passes to the desktop columns (`tasksByStatus`). */
  tasksByStatus: Record<TaskStatus, Task[]>;
  /** Sections to show, top to bottom. Defaults to every task status. */
  statuses?: readonly TaskStatus[];
  presentations?: Record<string, TaskCardPresentation>;
  projectNames?: Record<string, string>;
  hasActiveFilters?: boolean;
  loading?: boolean;
  movingTaskId?: string | null;
  /** Storage for the collapsed sections; defaults to the app storage (localStorage in the browser). */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  onDrop: (status: TaskStatus, taskId: string, beforeTaskId: string | null) => void;
  onComplete: (task: Task) => Promise<void> | void;
  onOpenTask: (task: Task) => void;
  /** v2 run controls (same handlers as the desktop TaskCard); each button is hidden without its callback. */
  onStartRun?: (task: Task) => void | Promise<void>;
  onStopRun?: (task: Task) => void | Promise<void>;
  onOpenRunInApp?: (task: Task) => void | Promise<void>;
}

type MobileRunAction = "start" | "stop" | "open";

/** Run chip + 開工 / 停止 / 在 App 開啟 for a phone card; mirrors TaskCard's run row rules. */
function MobileRunRow({
  task,
  onStartRun,
  onStopRun,
  onOpenRunInApp,
}: {
  task: Task;
  onStartRun?: (task: Task) => void | Promise<void>;
  onStopRun?: (task: Task) => void | Promise<void>;
  onOpenRunInApp?: (task: Task) => void | Promise<void>;
}) {
  const { text } = useTaskboardI18n();
  const [pending, setPending] = useState<MobileRunAction | null>(null);
  const displayIdentifier = task.externalKey ?? task.identifier;
  const activeRun = isActiveTaskRun(task.activeRun) ? task.activeRun : null;
  const canStart = Boolean(onStartRun) && !activeRun && task.status === "todo" && providerForAssignee(task.assignee) !== null;
  const canStop = Boolean(onStopRun) && activeRun !== null && activeRun.status !== "stopping";
  const canOpen = Boolean(onOpenRunInApp) && taskRunHasAppLink(activeRun ?? task.latestRun ?? null);
  const waitingNotice = activeRun && isWaitingForPermissionError(activeRun.error)
    ? taskRunErrorText(activeRun.error, text)
    : null;
  if (!activeRun && !canStart && !canOpen) return null;

  function run(action: MobileRunAction, callback?: (task: Task) => void | Promise<void>) {
    if (!callback || pending) return;
    let result: void | Promise<void>;
    try {
      result = callback(task);
    } catch {
      return;
    }
    if (!result) return;
    setPending(action);
    void result.catch(() => {}).finally(() => setPending((current) => current === action ? null : current));
  }

  const providerName = activeRun ? providerDisplayName(activeRun.provider) : "";
  return (
    <div className={`mobile-task-card-run${waitingNotice ? " has-notice" : ""}`}>
      {activeRun && (
        <span className={`task-run-chip is-${activeRun.status}`}>
          {activeRun.status === "stopping"
            ? text(`停止中 · ${providerName}`, `Stopping · ${providerName}`)
            : text(`處理中 · ${providerName}`, `In progress · ${providerName}`)}
        </span>
      )}
      <span className="task-run-card-spacer" aria-hidden="true" />
      {canOpen && (
        <button
          type="button"
          className="task-run-card-button mobile-task-card-run-button"
          disabled={pending !== null}
          aria-label={text(`在 App 開啟 ${displayIdentifier}`, `Open ${displayIdentifier} in app`)}
          onClick={() => run("open", onOpenRunInApp)}
        >
          {text("在 App 開啟", "Open in app")}
        </button>
      )}
      {canStop && (
        <button
          type="button"
          className="task-run-card-button is-danger mobile-task-card-run-button"
          disabled={pending !== null}
          aria-label={text(`停止 ${displayIdentifier}`, `Stop ${displayIdentifier}`)}
          onClick={() => run("stop", onStopRun)}
        >
          {pending === "stop" ? text("停止中…", "Stopping…") : text("停止", "Stop")}
        </button>
      )}
      {canStart && (
        <button
          type="button"
          className="task-run-card-button is-primary mobile-task-card-run-button"
          disabled={pending !== null}
          aria-label={text(`開工 ${displayIdentifier}`, `Start ${displayIdentifier}`)}
          onClick={() => run("start", onStartRun)}
        >
          {pending === "start" ? text("開工中…", "Starting…") : text("開工", "Start")}
        </button>
      )}
      {waitingNotice && <p className="task-run-card-notice" role="status">{waitingNotice}</p>}
    </div>
  );
}

interface MobilePointerSession {
  pointerId: number;
  taskId: string;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  active: boolean;
  destinationStatus: TaskStatus | null;
  beforeTaskId: string | null;
  timer: number;
  frame: number;
  cleanup: (commit: boolean) => void;
}

interface MobileDropMarker {
  status: TaskStatus;
  beforeTaskId: string | null;
}

function subscribeMobileViewport(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  if (typeof window.matchMedia === "function") {
    const query = window.matchMedia(MOBILE_BOARD_MEDIA_QUERY);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function mobileViewportSnapshot() {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia === "function") return window.matchMedia(MOBILE_BOARD_MEDIA_QUERY).matches;
  return isMobileBoardViewport(window.innerWidth);
}

/** True while the viewport is ≤719px wide; App uses it to mount MobileBoard instead of the desktop views. */
export function useMobileBoardViewport(): boolean {
  return useSyncExternalStore(subscribeMobileViewport, mobileViewportSnapshot, () => false);
}

/** Buttons, links and form controls inside a card keep their own tap behaviour (except the card's open button). */
function interactiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest(
    "button, a, input, textarea, select, label, [contenteditable='true'], [role='menuitem'], [role='switch']",
  );
  return Boolean(control && !control.classList.contains("mobile-task-card-open"));
}

function scrollContainerFor(element: HTMLElement | null): HTMLElement {
  for (let current = element; current; current = current.parentElement) {
    const { overflowY } = window.getComputedStyle(current);
    if ((overflowY === "auto" || overflowY === "scroll") && current.scrollHeight > current.clientHeight) return current;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

function calendarDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" })
    .format(new Date(`${value}T12:00:00`));
}

export function MobileBoard({
  tasksByStatus,
  statuses = TASK_STATUSES,
  presentations,
  projectNames,
  hasActiveFilters = false,
  loading = false,
  movingTaskId = null,
  storage = taskboardStorage,
  onDrop,
  onComplete,
  onOpenTask,
  onStartRun,
  onStopRun,
  onOpenRunInApp,
}: MobileBoardProps) {
  const { language, locale, text } = useTaskboardI18n();
  const [collapsed, setCollapsed] = useState<TaskStatus[]>(() => readMobileCollapsedStatuses(storage));
  const [sheetTaskId, setSheetTaskId] = useState<string | null>(null);
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dropMarker, setDropMarker] = useState<MobileDropMarker | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<MobilePointerSession | null>(null);
  const suppressClickUntilRef = useRef(0);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  const sheetTask = sheetTaskId
    ? statuses.flatMap((status) => tasksByStatus[status] ?? []).find((task) => task.id === sheetTaskId) ?? null
    : null;

  useEffect(() => {
    if (sheetTaskId && !sheetTask) setSheetTaskId(null);
  }, [sheetTask, sheetTaskId]);

  // A non-passive touchmove listener registered before the gesture starts lets an active long-press
  // drag cancel native scrolling (listeners added mid-gesture are ignored by the compositor).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const blockScrollWhileDragging = (event: TouchEvent) => {
      if (sessionRef.current?.active && event.cancelable) event.preventDefault();
    };
    root.addEventListener("touchmove", blockScrollWhileDragging, { passive: false });
    return () => root.removeEventListener("touchmove", blockScrollWhileDragging);
  }, []);

  useEffect(() => () => sessionRef.current?.cleanup(false), []);

  function toggleSection(status: TaskStatus) {
    setCollapsed((current) => {
      const next = toggleMobileCollapsedStatus(current, status);
      writeMobileCollapsedStatuses(storage, next);
      return next;
    });
  }

  const openSheet = useCallback((taskId: string) => {
    if (Date.now() < suppressClickUntilRef.current) return;
    setSheetTaskId(taskId);
  }, []);

  function updateDropTarget(session: MobilePointerSession) {
    const root = rootRef.current;
    const section = document.elementFromPoint(session.lastX, session.lastY)
      ?.closest<HTMLElement>(".mobile-board-section[data-task-status]");
    if (!root || !section || !root.contains(section)) return;
    const status = section.dataset.taskStatus as TaskStatus;
    const rects = Array.from(section.querySelectorAll<HTMLElement>(".mobile-task-card[data-task-id]"))
      .map((element) => ({
        id: element.dataset.taskId!,
        top: element.getBoundingClientRect().top,
        height: element.offsetHeight,
      }));
    const beforeTaskId = mobileDropBeforeTaskId(rects, session.taskId, session.lastY);
    if (session.destinationStatus === status && session.beforeTaskId === beforeTaskId) return;
    session.destinationStatus = status;
    session.beforeTaskId = beforeTaskId;
    setDropMarker({ status, beforeTaskId });
  }

  function beginPointer(event: ReactPointerEvent<HTMLElement>, task: Task) {
    if (event.button !== 0 || !event.isPrimary || sessionRef.current || movingTaskId === task.id) return;
    if (interactiveTarget(event.target)) return;

    function edgeScrollFrame() {
      if (sessionRef.current !== session || !session.active) return;
      const container = scrollContainerFor(rootRef.current);
      const isDocument = container === document.scrollingElement || container === document.documentElement;
      const bounds = isDocument ? { top: 0, height: window.innerHeight } : container.getBoundingClientRect();
      const delta = mobileEdgeScrollDelta(session.lastY - bounds.top, bounds.height);
      if (delta) {
        container.scrollBy({ top: delta, behavior: "auto" });
        updateDropTarget(session);
      }
      session.frame = window.requestAnimationFrame(edgeScrollFrame);
    }

    function handleMove(nativeEvent: PointerEvent) {
      if (nativeEvent.pointerId !== session.pointerId) return;
      if (!session.active) {
        if (exceededMobileDragSlop(session.startX, session.startY, nativeEvent.clientX, nativeEvent.clientY)) {
          session.cleanup(false);
        }
        return;
      }
      nativeEvent.preventDefault();
      session.lastX = nativeEvent.clientX;
      session.lastY = nativeEvent.clientY;
      updateDropTarget(session);
    }

    function handleUp(nativeEvent: PointerEvent) {
      if (nativeEvent.pointerId !== session.pointerId) return;
      session.cleanup(session.active);
    }

    function handleCancel(nativeEvent: PointerEvent) {
      if (nativeEvent.pointerId !== session.pointerId) return;
      session.cleanup(false);
    }

    function handleKeyDown(nativeEvent: KeyboardEvent) {
      if (nativeEvent.key !== "Escape") return;
      nativeEvent.preventDefault();
      session.cleanup(false);
    }

    function handleContextMenu(nativeEvent: MouseEvent) {
      if (!session.active) return;
      nativeEvent.preventDefault();
      nativeEvent.stopPropagation();
    }

    const session: MobilePointerSession = {
      pointerId: event.pointerId,
      taskId: task.id,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      active: false,
      destinationStatus: null,
      beforeTaskId: null,
      timer: 0,
      frame: 0,
      cleanup(commit) {
        window.clearTimeout(session.timer);
        window.cancelAnimationFrame(session.frame);
        document.removeEventListener("pointermove", handleMove, true);
        document.removeEventListener("pointerup", handleUp, true);
        document.removeEventListener("pointercancel", handleCancel, true);
        document.removeEventListener("keydown", handleKeyDown, true);
        document.removeEventListener("contextmenu", handleContextMenu, true);
        if (sessionRef.current === session) sessionRef.current = null;
        if (!session.active) return;
        session.active = false;
        suppressClickUntilRef.current = Date.now() + 350;
        document.body.classList.remove("is-mobile-task-dragging");
        setDragTaskId(null);
        setDropMarker(null);
        if (commit && session.destinationStatus) {
          onDropRef.current(session.destinationStatus, session.taskId, session.beforeTaskId);
        }
      },
    };
    sessionRef.current = session;

    session.timer = window.setTimeout(() => {
      if (sessionRef.current !== session) return;
      session.active = true;
      setSheetTaskId(null);
      setDragTaskId(task.id);
      updateDropTarget(session);
      document.body.classList.add("is-mobile-task-dragging");
      if (typeof navigator.vibrate === "function") navigator.vibrate(20);
      session.frame = window.requestAnimationFrame(edgeScrollFrame);
    }, MOBILE_LONG_PRESS_MS);

    document.addEventListener("pointermove", handleMove, { capture: true, passive: false });
    document.addEventListener("pointerup", handleUp, true);
    document.addEventListener("pointercancel", handleCancel, true);
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("contextmenu", handleContextMenu, true);
  }

  // The root element is always rendered (also while loading) so the touchmove listener above is attached once.
  return (
    <div
      ref={rootRef}
      className={`mobile-board${loading ? " is-loading" : ""}${dragTaskId ? " is-dragging" : ""}`}
      data-mobile-board
      aria-busy={loading || undefined}
      aria-label={loading ? text("正在載入議題", "Loading issues", "正在載入任務") : undefined}
    >
      {loading && statuses.slice(0, 3).map((status) => (
        <div className="mobile-board-loading-section" key={status}>
          <span /><div /><div />
        </div>
      ))}
      {!loading && statuses.map((status) => {
        const tasks = tasksByStatus[status] ?? [];
        const isCollapsed = collapsed.includes(status);
        const label = taskStatusLabel(language, status);
        const isDropTarget = dropMarker?.status === status;
        const dropAtEnd = isDropTarget && dropMarker?.beforeTaskId === null;
        const headerId = `mobile-board-header-${status}`;
        const listId = `mobile-board-list-${status}`;
        return (
          <section
            key={status}
            className={`mobile-board-section status-${status}${isCollapsed ? " is-collapsed" : ""}${isDropTarget ? " is-drop-target" : ""}${dropAtEnd ? " is-mobile-drop-at-end" : ""}`}
            data-task-status={status}
            aria-labelledby={headerId}
          >
            <h2 className="mobile-board-section-heading">
              <button
                id={headerId}
                type="button"
                className="mobile-board-section-header"
                aria-expanded={!isCollapsed}
                aria-controls={listId}
                onClick={() => toggleSection(status)}
              >
                <LinearIcon className="mobile-board-chevron" name={isCollapsed ? "chevronRight" : "chevronDown"} />
                <span className="mobile-board-status-icon">
                  <StatusIcon status={status} size={14} />
                </span>
                <span className="mobile-board-section-label">{label}</span>
                <span className="mobile-board-section-count">{tasks.length}</span>
              </button>
            </h2>
            {!isCollapsed && (
              <div className="mobile-board-list" id={listId}>
                {tasks.map((task) => {
                  const displayIdentifier = task.externalKey ?? task.identifier;
                  const presentation = presentations?.[task.id];
                  const projectName = projectNames?.[task.projectId];
                  const isDropBefore = isDropTarget && dropMarker?.beforeTaskId === task.id;
                  return (
                    <article
                      key={task.id}
                      className={`mobile-task-card status-${task.status}${dragTaskId === task.id ? " is-mobile-dragging" : ""}${isDropBefore ? " is-mobile-drop-before" : ""}${movingTaskId === task.id ? " is-moving" : ""}${presentation?.unread ? " is-unread" : ""}`}
                      data-task-id={task.id}
                      aria-labelledby={`mobile-task-${task.id}-title`}
                      onPointerDown={(event) => beginPointer(event, task)}
                    >
                      <button
                        type="button"
                        className="mobile-task-card-open"
                        aria-haspopup="dialog"
                        aria-label={text(
                          `${displayIdentifier}：${task.title}，選擇要移到哪裡`,
                          `${displayIdentifier}: ${task.title}. Choose where to move it`,
                        )}
                        onClick={() => openSheet(task.id)}
                      />
                      <div className="mobile-task-card-topline">
                        <span className="mobile-task-card-identifier">{displayIdentifier}</span>
                        {presentation?.unread && (
                          <span className="task-unread-dot" aria-label={text("有未讀更新", "Unread updates")} />
                        )}
                        {task.status === "in_progress" && presentation?.processing.running && !isActiveTaskRun(task.activeRun) && (
                          <span className="mobile-task-card-running">{text("執行中", "Running")}</span>
                        )}
                        {task.status === "in_review" && (
                          <button
                            type="button"
                            className="mobile-task-card-complete"
                            aria-label={text(`完成 ${displayIdentifier}`, `Complete ${displayIdentifier}`)}
                            disabled={movingTaskId === task.id}
                            onClick={() => {
                              void Promise.resolve()
                                .then(() => onComplete(task))
                                .catch(() => {});
                            }}
                          >
                            <LinearIcon name="check" />
                            <span>{text("完成", "Complete")}</span>
                          </button>
                        )}
                      </div>
                      <h3 id={`mobile-task-${task.id}-title`}>{task.title}</h3>
                      <div className="mobile-task-card-meta">
                        {projectName && <span className="mobile-task-card-project">{projectName}</span>}
                        {task.priority !== "none" && (
                          <span className={`mobile-task-card-priority priority-${task.priority}`}>
                            <PriorityIcon priority={task.priority} size={12} />
                            {taskPriorityLabel(language, task.priority)}
                          </span>
                        )}
                        {task.dueDate && (
                          <span className="mobile-task-card-due">
                            <DueDateIcon size={12} />
                            {calendarDate(task.dueDate, locale)}
                          </span>
                        )}
                        <span className="mobile-task-card-assignee">
                          <ActorAvatar actor={task.assignee} />
                          <span>{task.assignee.name}</span>
                        </span>
                      </div>
                      <MobileRunRow
                        task={task}
                        onStartRun={onStartRun}
                        onStopRun={onStopRun}
                        onOpenRunInApp={onOpenRunInApp}
                      />
                    </article>
                  );
                })}
                {tasks.length === 0 && (
                  <div className="mobile-board-empty">
                    {hasActiveFilters
                      ? text("目前篩選條件下沒有議題", "No issues match the current filters", "目前篩選條件下沒有任務")
                      : text("沒有議題", "No issues", "沒有任務")}
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}
      {!loading && sheetTask && (
        <MobileMoveSheet
          task={sheetTask}
          onDrop={onDrop}
          onOpenTask={onOpenTask}
          onClose={() => setSheetTaskId(null)}
        />
      )}
    </div>
  );
}
