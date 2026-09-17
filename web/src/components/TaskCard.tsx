import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { resolvePersistedAttachmentUrl } from "../api";
import {
  TASK_PRIORITIES,
  type ActorIdentity,
  type AssigneeTarget,
  type Task,
  type TaskDraft,
  type TaskPriority,
} from "../types";
import { labelPresentation } from "../labels";
import { taskPriorityLabel, useTaskboardI18n } from "../i18n";
import {
  CLAUDE_AGENT_ACTOR,
  CODEX_AGENT_ACTOR,
  actorKey,
  assigneeTargetForActor,
  providerDisplayName,
  providerForAssignee,
} from "../actors";
import type {
  TaskCardPresentation,
  TaskConversationItem,
} from "../taskConversations";
import { ActorAvatar } from "./ActorAvatar";
import { LinearIcon } from "./LinearIcon";
import { DueDateIcon, PriorityIcon, ProjectIcon } from "./SemanticIcons";
import { LabelPicker } from "./LabelPicker";
import { TaskPropertyPicker } from "./TaskPropertyPicker";
import { TaskConversationMenu } from "./TaskConversationMenu";
import {
  TaskRunCopyConversationIdButton,
  isActiveTaskRun,
  isWaitingForPermissionError,
  taskRunConversationId,
  taskRunErrorText,
  taskRunHasAppLink,
} from "./TaskRunPanel";
import "./TaskRunControls.css";
import completeIcon from "../assets/figma-taskboard/card-complete.svg";
import processingAnimation from "../assets/figma-taskboard/loading-16.svg";

interface TaskCardProps {
  task: Task;
  variant?: "main" | "sidebar";
  presentation: TaskCardPresentation;
  isDragging: boolean;
  dragShift: number;
  isMoving: boolean;
  isSettling: boolean;
  isContextMenuOpen: boolean;
  availableLabels: string[];
  projectName?: string;
  currentUser: ActorIdentity;
  showCover: boolean;
  showBody: boolean;
  onCreateLabel: (label: string) => Promise<void>;
  onEdit: (task: Task) => void;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
  onComplete?: (task: Task) => Promise<void>;
  onContextMenu: (task: Task, position: { x: number; y: number }) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onOpenConversation: (conversation: TaskConversationItem) => void;
  // v2 run controls; optional so existing mounts keep compiling.
  onStartRun?: (task: Task) => void | Promise<void>;
  onStopRun?: (task: Task) => void | Promise<void>;
  onOpenRunInApp?: (task: Task) => void | Promise<void>;
}

type RunCardAction = "start" | "stop" | "open";

interface TaskCardMarkdownNode {
  type: string;
  value?: string;
  children?: TaskCardMarkdownNode[];
}

const taskCardMarkdownParser = unified().use(remarkParse).use(remarkGfm);

function taskBodyText(value: string) {
  function visibleText(node: TaskCardMarkdownNode): string {
    if (node.type === "image" || node.type === "imageReference" || node.type === "definition") {
      return "";
    }
    if (node.type === "break") return " ";
    if (node.value !== undefined) return node.value;
    const separator = node.type === "root"
      || node.type === "blockquote"
      || node.type === "list"
      || node.type === "listItem"
      || node.type === "table"
      || node.type === "tableRow"
      ? " "
      : "";
    return node.children?.map(visibleText).join(separator) ?? "";
  }

  return visibleText(taskCardMarkdownParser.parse(value) as TaskCardMarkdownNode)
    .replace(/\s+/g, " ")
    .trim();
}

function calendarDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" })
    .format(new Date(`${value}T12:00:00`));
}

function createdDate(value: string, locale: string, text: (chinese: string, english: string, taiwanese?: string) => string) {
  const formatted = new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" })
    .format(new Date(value));
  return text(`${formatted}创建`, `Created ${formatted}`, `${formatted}建立`);
}

function elapsedTime(startedAt: string | null, now: number) {
  if (!startedAt) return "";
  const elapsed = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  if (elapsed < 60) return `${elapsed}s`;
  const minutes = Math.floor(elapsed / 60);
  if (minutes < 60) return `${minutes}m${elapsed % 60 ? `${elapsed % 60}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
}

function firstTaskImage(task: Task) {
  const markdownImage = task.description.match(
    /!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^)]*["'])?\)/,
  );
  const source = markdownImage?.[1]
    ?? markdownImage?.[2];
  return source ? resolvePersistedAttachmentUrl(source) : null;
}

function TaskCardMedia({ src }: { src: string }) {
  const mediaRef = useRef<HTMLDivElement>(null);
  const imageSizeRef = useRef<{ naturalWidth: number; naturalHeight: number } | null>(null);
  const [presentation, setPresentation] = useState<{ width: number; clamped: boolean } | null>(null);
  const clamped = presentation?.clamped ?? false;
  const updatePresentation = useCallback(() => {
    const media = mediaRef.current;
    const imageSize = imageSizeRef.current;
    if (!media || !imageSize) return;
    const renderedWidth = Math.min(imageSize.naturalWidth, media.clientWidth);
    const nextPresentation = {
      width: imageSize.naturalWidth,
      clamped: imageSize.naturalHeight * renderedWidth / imageSize.naturalWidth > 300,
    };
    setPresentation((current) => (
      current?.width === nextPresentation.width && current.clamped === nextPresentation.clamped
        ? current
        : nextPresentation
    ));
  }, []);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    const observer = new ResizeObserver(updatePresentation);
    observer.observe(media);
    return () => observer.disconnect();
  }, [updatePresentation]);

  return (
    <div
      ref={mediaRef}
      className={`task-card-media${clamped ? " is-clamped" : ""}`}
      style={presentation ? { width: presentation.width } : undefined}
    >
      <img
        src={src}
        alt=""
        loading="lazy"
        onLoad={(event) => {
          imageSizeRef.current = {
            naturalWidth: event.currentTarget.naturalWidth,
            naturalHeight: event.currentTarget.naturalHeight,
          };
          updatePresentation();
        }}
      />
    </div>
  );
}

function ProcessingProgress({
  presentation,
}: {
  presentation: TaskCardPresentation;
}) {
  const { text } = useTaskboardI18n();
  const { processing } = presentation;
  const hasProgress = processing.total !== null
    && processing.total > 0
    && processing.completed !== null;
  if (!hasProgress) return null;

  const total = processing.total!;
  const completed = Math.max(0, Math.min(processing.completed!, total));
  const label = text(`处理进度 ${completed}/${total}`, `Processing progress ${completed}/${total}`, `處理進度 ${completed}/${total}`);

  return (
    <div className="card-progress-row">
      <div
        className={`task-progress-segments${processing.running ? " is-running" : ""}`}
        aria-label={label}
        title={label}
      >
        {Array.from({ length: total }, (_, index) => (
          <span className={index < completed ? "is-complete" : ""} key={index} />
        ))}
      </div>
    </div>
  );
}

function ProcessingLabel({ processing }: { processing: TaskCardPresentation["processing"] }) {
  const { text } = useTaskboardI18n();
  const { running, startedAt } = processing;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running || !startedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);
  const elapsed = elapsedTime(startedAt, now);
  return (
    <span className="task-processing-label">
      {running
        ? (elapsed ? text(`已处理 ${elapsed}...`, `Processing for ${elapsed}...`, `已處理 ${elapsed}...`) : text("正在处理...", "Processing..."))
        : text("暂停处理", "Processing paused")}
    </span>
  );
}

function ProcessingStatusRow({
  presentation,
  onOpenConversation,
}: {
  presentation: TaskCardPresentation;
  onOpenConversation: (conversation: TaskConversationItem) => void;
}) {
  const running = presentation.processing.running;
  return (
    <div className={`task-processing-row${running ? " is-running" : " is-paused"}`}>
      {running && <img className="task-processing-glyph" src={processingAnimation} alt="" aria-hidden="true" />}
      <ProcessingLabel processing={presentation.processing} />
      <span className="task-processing-spacer" aria-hidden="true" />
      {presentation.conversations.length > 0 && (
        <TaskConversationMenu
          conversations={presentation.conversations}
          onOpenConversation={onOpenConversation}
        />
      )}
    </div>
  );
}

function ParticipantAvatars({ participants }: { participants: ActorIdentity[] }) {
  const { text } = useTaskboardI18n();
  if (participants.length === 0) return null;
  return (
    <span
      className="task-participants"
      aria-label={text(
        `参与人：${participants.map((participant) => participant.name).join("、")}`,
        `Participants: ${participants.map((participant) => participant.name).join(", ")}`,
        `參與者：${participants.map((participant) => participant.name).join("、")}`,
      )}
    >
      {participants.map((participant) => (
        <ActorAvatar
          actor={participant}
          className="task-participant-avatar"
          key={`${participant.type}:${participant.id}`}
        />
      ))}
    </span>
  );
}

function TaskLabels({ task }: { task: Task }) {
  const { language } = useTaskboardI18n();
  return (
    <>
      {task.labels.slice(0, 2).map((label) => {
        const presentation = labelPresentation(label, language);
        return (
          <span className={`label-chip${presentation.tone ? ` label-chip-${presentation.tone}` : ""}`} key={label}>
            {presentation.tone && <i aria-hidden="true" />}
            <span>{presentation.name}</span>
          </span>
        );
      })}
      {task.labels.length > 2 && (
        <span className="label-more" title={task.labels.slice(2).map((label) => labelPresentation(label, language).name).join(", ")}>
          +{task.labels.length - 2}
        </span>
      )}
    </>
  );
}

function PriorityControl({
  task,
  disabled,
  open,
  onOpenChange,
  onChange,
}: {
  task: Task;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (priority: TaskPriority) => void;
}) {
  const { language, text } = useTaskboardI18n();
  const displayIdentifier = task.externalKey ?? task.identifier;
  return (
    <TaskPropertyPicker
      value={task.priority}
      options={TASK_PRIORITIES.map((priority) => ({
        value: priority,
        label: taskPriorityLabel(language, priority),
        icon: <PriorityIcon priority={priority} size={14} />,
        className: `priority-${priority}`,
      }))}
      open={open}
      disabled={disabled}
      className="card-property-control"
      triggerClassName={`priority-chip priority-chip-${task.priority}`}
      ariaLabel={text(`${displayIdentifier} 优先级`, `${displayIdentifier} priority`, `${displayIdentifier} 優先順序`)}
      title={text(
        `优先级：${taskPriorityLabel(language, task.priority)}`,
        `Priority: ${taskPriorityLabel(language, task.priority)}`,
        `優先順序：${taskPriorityLabel(language, task.priority)}`,
      )}
      onOpenChange={onOpenChange}
      onChange={onChange}
    />
  );
}

function DueDateControl({
  task,
  disabled,
  onChange,
}: {
  task: Task;
  disabled: boolean;
  onChange: (dueDate: string | null) => void;
}) {
  const { locale, text } = useTaskboardI18n();
  const displayIdentifier = task.externalKey ?? task.identifier;
  if (!task.dueDate) return null;
  return (
    <label className="due-date-chip card-property-control" title={text(`截止日期 ${task.dueDate}`, `Due date ${task.dueDate}`)}>
      <DueDateIcon color="currentColor" size={12} /> {calendarDate(task.dueDate, locale)}
      <input
        type="date"
        aria-label={text(`${displayIdentifier} 截止日期`, `${displayIdentifier} due date`)}
        value={task.dueDate}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
      />
    </label>
  );
}

function AssigneeControl({
  task,
  participants: persistedParticipants,
  currentUser,
  disabled,
  open,
  onOpenChange,
  onChange,
}: {
  task: Task;
  participants: ActorIdentity[];
  currentUser: ActorIdentity;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (target: AssigneeTarget) => void;
}) {
  const { text } = useTaskboardI18n();
  const displayIdentifier = task.externalKey ?? task.identifier;
  const currentUserKey = actorKey(currentUser);
  const assignee = actorKey(task.assignee) === currentUserKey ? currentUser : task.assignee;
  const participants = persistedParticipants.map((participant) => (
    actorKey(participant) === currentUserKey ? currentUser : participant
  ));
  const options = [assignee, currentUser, CODEX_AGENT_ACTOR, CLAUDE_AGENT_ACTOR]
    .filter((actor, index, actors) => (
      actors.findIndex((candidate) => actorKey(candidate) === actorKey(actor)) === index
    ));
  return (
    <TaskPropertyPicker
      value={actorKey(task.assignee)}
      options={options.map((actor) => ({
        value: actorKey(actor),
        label: actorKey(actor) === currentUserKey ? text(`${actor.name}（我）`, `${actor.name} (me)`) : actor.name,
        icon: <ActorAvatar actor={actor} className="task-property-assignee-avatar" />,
      }))}
      open={open}
      disabled={disabled}
      className="task-participants-control card-property-control"
      triggerClassName="task-assignee-trigger"
      triggerContent={<ParticipantAvatars participants={participants} />}
      ariaLabel={text(`${displayIdentifier} 负责人`, `${displayIdentifier} assignee`, `${displayIdentifier} 負責人`)}
      title={text(`负责人：${assignee.name}`, `Assignee: ${assignee.name}`, `負責人：${assignee.name}`)}
      onOpenChange={onOpenChange}
      onChange={(value) => {
        const selected = options.find((actor) => actorKey(actor) === value);
        const target = selected ? assigneeTargetForActor(selected, currentUser) : undefined;
        if (target) onChange(target);
      }}
    />
  );
}

function RunElapsed({ startedAt }: { startedAt: string | null }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!startedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const elapsed = elapsedTime(startedAt, now);
  return elapsed ? <span className="task-run-chip-elapsed">{elapsed}</span> : null;
}

function TaskRunCardRow({
  task,
  conversations,
  onStartRun,
  onStopRun,
  onOpenRunInApp,
  onOpenConversation,
}: {
  task: Task;
  conversations: TaskConversationItem[];
  onStartRun?: (task: Task) => void | Promise<void>;
  onStopRun?: (task: Task) => void | Promise<void>;
  onOpenRunInApp?: (task: Task) => void | Promise<void>;
  onOpenConversation: (conversation: TaskConversationItem) => void;
}) {
  const { text } = useTaskboardI18n();
  const [pendingAction, setPendingAction] = useState<RunCardAction | null>(null);
  const displayIdentifier = task.externalKey ?? task.identifier;
  const activeRun = isActiveTaskRun(task.activeRun) ? task.activeRun : null;
  const appLinkRun = activeRun ?? task.latestRun ?? null;
  const canOpenInApp = Boolean(onOpenRunInApp) && taskRunHasAppLink(appLinkRun);
  const canStart = Boolean(onStartRun)
    && !activeRun
    && task.status === "todo"
    && providerForAssignee(task.assignee) !== null;
  const canStop = Boolean(onStopRun) && activeRun !== null && activeRun.status !== "stopping";
  // Amendment 3: while a Codex run is active the App link is not offered; the thread id can still be copied.
  const canCopyConversationId = activeRun !== null && !canOpenInApp && taskRunConversationId(activeRun) !== null;
  const waitingNotice = activeRun && isWaitingForPermissionError(activeRun.error)
    ? taskRunErrorText(activeRun.error, text)
    : null;
  if (!activeRun && !canOpenInApp && !canStart) return null;

  function runAction(action: RunCardAction, callback: ((task: Task) => void | Promise<void>) | undefined) {
    if (!callback || pendingAction) return;
    // Call synchronously so the click's user activation still applies (e.g. opening an app URL).
    let result: void | Promise<void>;
    try {
      result = callback(task);
    } catch {
      return;
    }
    if (!result) return;
    setPendingAction(action);
    void result
      .catch(() => {})
      .finally(() => setPendingAction((current) => current === action ? null : current));
  }

  const providerName = activeRun ? providerDisplayName(activeRun.provider) : "";
  return (
    <div className={`task-run-card-row${activeRun ? ` is-${activeRun.status}` : ""}${waitingNotice ? " has-notice" : ""}`}>
      {activeRun && activeRun.status !== "stopping" && (
        <img className="task-processing-glyph" src={processingAnimation} alt="" aria-hidden="true" />
      )}
      {activeRun && (
        <span className={`task-run-chip is-${activeRun.status}`}>
          {activeRun.status === "stopping"
            ? text(`停止中 · ${providerName}`, `Stopping · ${providerName}`)
            : text(`處理中 · ${providerName}`, `In progress · ${providerName}`)}
          {activeRun.status !== "stopping" && <RunElapsed startedAt={activeRun.startedAt} />}
        </span>
      )}
      <span className="task-run-card-spacer" aria-hidden="true" />
      {canCopyConversationId && <TaskRunCopyConversationIdButton run={activeRun} />}
      {canOpenInApp && (
        <button
          className="task-run-card-button"
          type="button"
          disabled={pendingAction !== null}
          aria-label={text(`在 App 開啟 ${displayIdentifier}`, `Open ${displayIdentifier} in app`)}
          onClick={(event) => {
            event.stopPropagation();
            runAction("open", onOpenRunInApp);
          }}
        >
          {text("在 App 開啟", "Open in app")}
        </button>
      )}
      {canStop && (
        <button
          className="task-run-card-button is-danger"
          type="button"
          disabled={pendingAction !== null}
          aria-label={text(`停止 ${displayIdentifier}`, `Stop ${displayIdentifier}`)}
          onClick={(event) => {
            event.stopPropagation();
            runAction("stop", onStopRun);
          }}
        >
          {pendingAction === "stop" ? text("停止中…", "Stopping…") : text("停止", "Stop")}
        </button>
      )}
      {canStart && (
        <button
          className="task-run-card-button is-primary"
          type="button"
          disabled={pendingAction !== null}
          aria-label={text(`開工 ${displayIdentifier}`, `Start ${displayIdentifier}`)}
          onClick={(event) => {
            event.stopPropagation();
            runAction("start", onStartRun);
          }}
        >
          {pendingAction === "start" ? text("開工中…", "Starting…") : text("開工", "Start")}
        </button>
      )}
      {waitingNotice && (
        <p className="task-run-card-notice" role="status">{waitingNotice}</p>
      )}
      {activeRun && conversations.length > 0 && (
        <TaskConversationMenu
          conversations={conversations}
          onOpenConversation={onOpenConversation}
        />
      )}
    </div>
  );
}

export function TaskCard({
  task,
  variant = "main",
  presentation,
  isDragging,
  dragShift,
  isMoving,
  isSettling,
  isContextMenuOpen,
  availableLabels,
  projectName,
  currentUser,
  showCover,
  showBody,
  onCreateLabel,
  onEdit,
  onUpdate,
  onComplete,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onOpenConversation,
  onStartRun,
  onStopRun,
  onOpenRunInApp,
}: TaskCardProps) {
  const { locale, text } = useTaskboardI18n();
  const displayIdentifier = task.externalKey ?? task.identifier;
  const [propertyMenu, setPropertyMenu] = useState<"priority" | "labels" | "assignee" | null>(null);
  const [savingProperty, setSavingProperty] = useState<"priority" | "labels" | "dueDate" | "assignee" | null>(null);
  const creator: ActorIdentity = {
    type: task.creatorType,
    id: task.creatorId,
    name: task.creatorName,
    avatarUrl: task.creatorAvatarUrl,
  };
  const processingCard = task.status === "in_progress";
  const hasActiveRun = isActiveTaskRun(task.activeRun);
  const supportsConversation = task.status === "in_progress"
    || task.status === "in_review"
    || task.status === "blocked"
    || task.status === "done"
    || task.status === "canceled";
  const showsConversation = supportsConversation && presentation.conversations.length > 0;
  const showsInlineParticipants = variant === "main"
    && task.participants.length > 0;
  const image = showCover ? firstTaskImage(task) : null;
  const body = useMemo(
    () => showBody ? taskBodyText(task.description) : "",
    [showBody, task.description],
  );
  const hasProperties = task.priority !== "none" || task.labels.length > 0 || task.dueDate;
  const showsProperties = Boolean(projectName)
    || (!processingCard && (hasProperties || showsInlineParticipants || showsConversation));
  const propertyDisabled = savingProperty !== null;

  function updateProperty(changes: Partial<TaskDraft>, property: NonNullable<typeof savingProperty>) {
    setSavingProperty(property);
    void onUpdate(task, changes)
      .catch(() => {})
      .finally(() => setSavingProperty((current) => current === property ? null : current));
  }

  return (
    <article
      className={`task-card task-card-${variant} status-${task.status}${processingCard ? " is-processing-card" : ""}${processingCard && presentation.processing.running ? " is-running-card" : ""}${image ? " has-media" : ""}${presentation.unread ? " is-unread" : ""}${isDragging ? " is-dragging" : ""}${dragShift ? " is-drag-shifted" : ""}${isMoving ? " is-moving" : ""}${isSettling ? " is-settling" : ""}${isContextMenuOpen ? " is-context-open" : ""}${propertyMenu ? " is-property-menu-open" : ""}`}
      style={{
        viewTransitionName: task.status === "in_review" ? `review-task-${task.id}` : "none",
        ...(dragShift ? { transform: `translate3d(0, ${dragShift}px, 0)` } : {}),
      }}
      draggable={!isMoving}
      aria-labelledby={`task-${task.id}-title`}
      data-task-id={task.id}
      data-drag-shift={dragShift || undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(task, { x: event.clientX, y: event.clientY });
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", task.id);
        event.dataTransfer.setData("application/x-taskboard-task", task.id);
        onDragStart(task, event.currentTarget.offsetHeight);
      }}
      onDragEnd={onDragEnd}
    >
      <button
        className="task-card-open"
        type="button"
        aria-label={text(`打开 ${displayIdentifier}: ${task.title}`, `Open ${displayIdentifier}: ${task.title}`, `開啟 ${displayIdentifier}: ${task.title}`)}
        onClick={() => onEdit(task)}
      />

      <div className="card-topline">
        <span className="card-reference">
          <span className="task-identifier">ID: {displayIdentifier}</span>
        </span>
        {presentation.unread && <span className="task-unread-dot" aria-label={text("有未读更新", "Unread updates")} />}
        {task.status === "in_review" && onComplete && (
          <button
            className="task-card-complete"
            type="button"
            aria-label={text(`完成 ${displayIdentifier}`, `Complete ${displayIdentifier}`)}
            title={text("完成", "Complete")}
            onClick={(event) => {
              event.stopPropagation();
              const card = event.currentTarget.closest<HTMLElement>(".task-card")!;
              card.style.viewTransitionName = "completing-task";
              const transition = document.startViewTransition(() => onComplete(task));
              void transition.finished.then(
                () => { card.style.viewTransitionName = `review-task-${task.id}`; },
                () => { card.style.viewTransitionName = `review-task-${task.id}`; },
              );
            }}
          >
            <img src={completeIcon} alt="" aria-hidden="true" />
            <span>{text("完成", "Complete")}</span>
          </button>
        )}
        {variant === "sidebar" && (
          <span className="sidebar-card-creator">
            <AssigneeControl
              task={task}
              participants={task.participants.length ? task.participants : [creator]}
              currentUser={currentUser}
              disabled={propertyDisabled || task.source === "jira"}
              open={propertyMenu === "assignee"}
              onOpenChange={(open) => setPropertyMenu(open ? "assignee" : null)}
              onChange={(assigneeTarget) => updateProperty({ assigneeTarget }, "assignee")}
            />
            <span>{createdDate(task.createdAt, locale, text)}</span>
          </span>
        )}
      </div>

      <h3 id={`task-${task.id}-title`}>{task.title}</h3>

      {body && <p className="task-card-description">{body}</p>}

      {image && (
        <TaskCardMedia key={image} src={image} />
      )}

      {showsProperties && (
        <div className="card-properties" aria-label={text("议题属性", "Issue properties")}>
          {projectName && (
            <span className="project-chip" title={projectName}>
              <ProjectIcon color="currentColor" />
              <span>{projectName}</span>
            </span>
          )}
          {!processingCard && task.priority !== "none" && (
            <PriorityControl
              task={task}
              disabled={propertyDisabled}
              open={propertyMenu === "priority"}
              onOpenChange={(open) => setPropertyMenu(open ? "priority" : null)}
              onChange={(priority) => updateProperty({ priority }, "priority")}
            />
          )}
          {!processingCard && task.labels.length > 0 && (
            <LabelPicker
              availableLabels={availableLabels}
              selectedLabels={task.labels}
              open={propertyMenu === "labels"}
              disabled={propertyDisabled}
              className="card-label-picker card-property-control"
              triggerClassName="card-label-trigger"
              triggerContent={<TaskLabels task={task} />}
              onOpenChange={(open) => setPropertyMenu(open ? "labels" : null)}
              onChange={(labels) => updateProperty({ labels }, "labels")}
              onCreateLabel={onCreateLabel}
            />
          )}
          {!processingCard && (
            <DueDateControl
              task={task}
              disabled={propertyDisabled}
              onChange={(dueDate) => updateProperty({
                dueDate,
                ...(dueDate ? {} : { recurrence: null }),
              }, "dueDate")}
            />
          )}
          {!processingCard && showsInlineParticipants && (
            <AssigneeControl
              task={task}
              participants={task.participants}
              currentUser={currentUser}
              disabled={propertyDisabled || task.source === "jira"}
              open={propertyMenu === "assignee"}
              onOpenChange={(open) => setPropertyMenu(open ? "assignee" : null)}
              onChange={(assigneeTarget) => updateProperty({ assigneeTarget }, "assignee")}
            />
          )}
          {!processingCard && showsConversation && <span className="card-properties-spacer" aria-hidden="true" />}
          {!processingCard && showsConversation && (
            <TaskConversationMenu
              conversations={presentation.conversations}
              onOpenConversation={onOpenConversation}
            />
          )}
        </div>
      )}

      {processingCard && !hasActiveRun && (
        <>
          <ProcessingProgress presentation={presentation} />
          <ProcessingStatusRow
            presentation={presentation}
            onOpenConversation={onOpenConversation}
          />
        </>
      )}

      <TaskRunCardRow
        task={task}
        conversations={presentation.conversations}
        onStartRun={onStartRun}
        onStopRun={onStopRun}
        onOpenRunInApp={onOpenRunInApp}
        onOpenConversation={onOpenConversation}
      />
    </article>
  );
}
