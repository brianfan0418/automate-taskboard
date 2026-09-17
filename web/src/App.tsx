import { resolveInlineAttachments } from "./inlineAttachments";
import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  ApiError,
  addTaskRelation,
  archiveTask as archiveTaskRequest,
  getProjectAutomation,
  createProjectLabel as createProjectLabelRequest,
  createProject as createProjectRequest,
  createTask as createTaskRequest,
  configureJiraConnection,
  deleteArchivedTask as deleteArchivedTaskRequest,
  deleteProjectLabel as deleteProjectLabelRequest,
  deleteProject as deleteProjectRequest,
  updateProjectWorkspace,
  WORKSPACE_MISSING_EVENT,
  getAiChatCatalog,
  getCodexThreadProgress,
  getJiraConnection,
  getTaskboardRevision,
  getTaskboardMetadata,
  listArchivedTasks,
  listTaskRuns,
  listDevelopmentContexts,
  listDeviceWorkspaces,
  listProjects,
  listTasks,
  moveTask as moveTaskRequest,
  publishHostRuntime,
  removeTaskRelation,
  resetProjectOrder,
  resolveTaskboardUrl,
  resolveTaskboardWebSocketUrl,
  restoreTask as restoreTaskRequest,
  setApiText,
  setCurrentUserActor,
  startTaskRun as startTaskRunRequest,
  stopTaskRun as stopTaskRunRequest,
  syncJiraConnection,
  uploadAttachment,
  updateTask as updateTaskRequest,
} from "./api";
import {
  actorKey,
  actorForAssigneeTarget,
  assigneeTargetForActor,
} from "./actors";
import { BoardColumn } from "./components/BoardColumn";
import { MobileBoard, useMobileBoardViewport } from "./components/MobileBoard";
import {
  MobileAccessSettings,
  PairingCompletion,
  isLoopbackHostname,
  isPhonePairingRequired,
} from "./components/MobileAccessSettings";
import { PhoneOnboarding } from "./components/PhoneOnboarding";
import { START_GUIDE_DISMISSED_KEY, StartGuide } from "./components/StartGuide";
import { ProjectFolderField, folderDisplayName } from "./components/ProjectFolderField";
import { PhoneSetupWizard } from "./components/PhoneSetupWizard";
import { PHONE_WIZARD_DISMISSED_KEY, runAppLinksWorkHere } from "./phoneOnboarding";
import { HeaderPhoneButton, usePairedPhones } from "./components/HeaderPhoneButton";
import type { AiChatOpenThreadRequest } from "./components/AiChat";
import {
  BoardCardDisplayMenu,
  DEFAULT_BOARD_DISPLAY_SETTINGS,
  type BoardDisplaySettings,
} from "./components/BoardCardDisplayMenu";
import { DashboardView } from "./components/DashboardView";
import { JIRA_UI_ENABLED } from "./featureFlags";
import { ProjectReadmeView } from "./components/ProjectReadmeView";
import { IssueListView } from "./components/IssueListView";
import { JiraConnectionDialog } from "./components/JiraConnectionDialog";
import { ArchivedTasksColumn, OtherTasksPanel } from "./components/OtherTasksPanel";
import {
  type PendingInlineAttachment,
  type PendingInlineImage,
} from "./documentModel";
import { LinearIcon } from "./components/LinearIcon";
import {
  DeleteIcon,
  MoreIcon,
  PlusIcon,
  RefreshIcon,
  RelationIcon,
} from "./components/SemanticIcons";
import { ProjectAutomationMenu } from "./components/ProjectAutomationMenu";
import { TaskboardIcon } from "./components/TaskboardIcon";
import { TaskContextMenu } from "./components/TaskContextMenu";
import { TaskDetail } from "./components/TaskDetail";
import {
  CODEX_RUN_ACTIVE_APP_TEXT,
  mergeRunIntoTask,
  pickTaskRunAppUrl,
  publishTaskRunEvent,
} from "./components/TaskRunPanel";
import { runErrorTextPair } from "./runErrorText";
import {
  TaskEditor,
  type NewTaskCreateOptions,
  type NewTaskEditorDraft,
} from "./components/TaskEditor";
import { TaskFilterMenu } from "./components/TaskFilterMenu";
import {
  PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX,
  projectBoardDisplaySettingsStorageEntries,
  refreshProjectBoardDisplaySettingsStorage,
  taskboardStorage,
} from "./storage";
import {
  installEmbeddedExternalLinkHandler,
  postEmbeddedHostMessage,
  setEmbeddedFrameChallenge,
} from "./embeddedHost.mjs";
import { newClientId } from "./clientId";
import { continueFlowFor, continueFlowForError, guardedStatusMove, type ContinueFlowKind } from "./continueGuard";
import { RUN_APP_LINK_EMBEDDED_TEXT, openRunAppUrl, taskboardPageHostname } from "./hostEmbedding";
import { buildIssueUrl, readIssueIdentifier } from "./issueRoute";
import {
  getTaskboardI18n,
  preferredTaskboardLanguage,
  resolveTaskboardLanguage,
  taskStatusLabel,
  TASKBOARD_LANGUAGE_KEY,
  TaskboardLanguageProvider,
} from "./i18n";
import {
  MAIN_STATUSES,
  type OtherTaskTab,
} from "./issueBoardStatuses";
import {
  indexAiThreadsByTask,
  normalizeCodexThreadId,
  taskCardPresentation,
  type TaskCardPresentation,
  type TaskConversationItem,
} from "./taskConversations";
import {
  EMPTY_TASK_FILTERS,
  matchesTaskFilters,
  matchesTaskSearch,
  readTaskFilters,
  taskFilterCount,
  writeTaskFilters,
} from "./taskFilters";
import {
  TASK_STATUSES,
  type ActorIdentity,
  type AiChatModel,
  type AiChatThread,
  type CodexProjectIdentity,
  type CodexThreadBinding,
  type DevelopmentScan,
  type HostContext,
  type IssueRelationOrigin,
  type IssueRelationType,
  type JiraConnection,
  type Project,
  type ProjectOrderMode,
  type Task,
  type TaskFollowup,
  type TaskRun,
  type TaskboardMetadata,
  type TaskDraft,
  type TaskStatus,
} from "./types";
import "./appIntegration.css";
import { TextSizeSetting, useTextSize } from "./textSize";
// Display/claim order is shared with the server scheduler (CONTRACTS C5). shared/task-order.mjs has no
// .d.mts beside it (outside the web scope), so the import is untyped and narrowed right below.
// @ts-expect-error No declaration file for the shared ESM module; see orderTasks below.
import { orderTasks as orderSharedTasks } from "../../shared/task-order.mjs";
// The poller stays in ESM JavaScript so its lifecycle can be tested directly with node:test.
// @ts-expect-error The module's option contract is enforced by its focused node tests.
import { createRevisionPoller, createRevisionWebSocketClient, getRevisionPollingInterval, getRevisionWebSocketConfig } from "./revisionPolling.mjs";

const orderTasks = orderSharedTasks as <T extends Task>(
  tasks: readonly T[],
  orderMode: ProjectOrderMode | null | undefined,
) => T[];

/**
 * Drop inside a todo column that shows the suggested order: the full order the user now sees, as
 * renumbered sortOrders (1024 apart) and the writes needed (dragged card first). null = nothing moved.
 */
export function planSuggestedTodoReorder(
  projectTodoTasks: readonly Task[],
  task: Task,
  beforeTaskId: string | null,
): { sortOrders: Map<string, number>; writes: Task[] } | null {
  const shown = orderTasks(projectTodoTasks, "suggested");
  const desired = shown.filter((candidate) => candidate.id !== task.id);
  const beforeIndex = beforeTaskId ? desired.findIndex((candidate) => candidate.id === beforeTaskId) : -1;
  desired.splice(beforeIndex < 0 ? desired.length : beforeIndex, 0, task);
  if (desired.length === shown.length && desired.every((candidate, index) => candidate.id === shown[index].id)) {
    return null;
  }
  const sortOrders = new Map(desired.map((candidate, index) => [candidate.id, (index + 1) * 1024]));
  const writes = [task, ...desired.filter((candidate) => (
    candidate.id !== task.id && candidate.sortOrder !== sortOrders.get(candidate.id)
  ))];
  return { sortOrders, writes };
}

/** All projects: a drop that stays inside todo is not written (see moveTask). Moves between columns are. */
export function blocksAllProjectsTodoReorder(isAllProjects: boolean, from: TaskStatus, to: TaskStatus): boolean {
  return isAllProjects && from === "todo" && to === "todo";
}

type ConnectionState = "connecting" | "live" | "reconnecting";
type Theme = "light" | "dark";
type BoardView = "readme" | "dashboard" | "issues" | "list" | "gantt";
type DetailSourceScroll =
  | { projectId: string; view: "issues"; status: TaskStatus; scrollTop: number; scrollLeft: number }
  | { projectId: string; view: "list"; scrollTop: number };
type GanttZoom = "day" | "week" | "month";
type ActionError = string | readonly [string, string, string?];
type ProjectLoadError = {
  source: "projects";
  operation: "initial" | "refresh";
  requestId: number;
  message: string;
};
type TasksLoadError = {
  source: "tasks";
  requestId: number;
  message: string;
};
type LoadError = ProjectLoadError | TasksLoadError;
const GANTT_ZOOM_OPTIONS: GanttZoom[] = ["day", "week", "month"];

const AiChat = lazy(() => import("./components/AiChat").then((module) => ({
  default: module.AiChat,
})));
const GanttView = lazy(() => import("./components/GanttView").then((module) => ({
  default: module.GanttView,
})));

interface EditorState {
  status: TaskStatus;
  projectId?: string | null;
}

interface ContextMenuState {
  taskId: string;
  x: number;
  y: number;
}

interface ProjectChoice {
  id: string;
  name: string;
  issueCount: number;
  inCodex: boolean;
  persisted: boolean;
  codexIdentity: CodexProjectIdentity | null;
}

interface ProjectContextMenuState {
  project: ProjectChoice;
  x: number;
  y: number;
}

interface UndoOperation {
  id: number;
  undo: () => Promise<void>;
}

interface UndoNotice {
  id: number;
  message: string;
}

const DEFAULT_USER_ACTOR: ActorIdentity = {
  type: "user",
  id: "local-user",
  name: "本地用户",
  avatarUrl: null,
};

const GLOBAL_PROJECT_ID = "local";

// W15 review O1: the Codex-embedded panel is a sandboxed iframe without allow-same-origin, so its
// origin is opaque ("null") and the server refuses folder routes from it.
function isOpaqueOrigin(): boolean {
  try {
    return window.origin === "null";
  } catch {
    return false;
  }
}
const ALL_PROJECTS_ID = "__all_projects__";
const ALL_PROJECTS_DEFAULT_BOARD_DISPLAY_SETTINGS: BoardDisplaySettings = {
  ...DEFAULT_BOARD_DISPLAY_SETTINGS,
  mainStatuses: ["backlog", ...DEFAULT_BOARD_DISPLAY_SETTINGS.mainStatuses],
  sidebarStatuses: DEFAULT_BOARD_DISPLAY_SETTINGS.sidebarStatuses.filter(
    (status) => status !== "backlog",
  ),
};
const RECENT_PROJECT_IDS_KEY = "taskboard.recentProjectIds.v1";
const PROJECT_VIEW_KEY_PREFIX = "taskboard.project-view.v1.";
const DEVICE_WORKSPACE_PATHS_KEY = "taskboard.deviceWorkspacePaths.v1";
const PROJECT_CODEX_IDENTITIES_KEY = "taskboard.projectCodexIdentities.v1";
const ISSUE_READ_KEY_PREFIX = "taskboard.issue-read.v1";
const FIRST_USE_COMPLETE_KEY = "taskboard.first-use-complete.v1";
function issueReadStorageKey(mode: string, task: Pick<Task, "id" | "projectId">) {
  return `${ISSUE_READ_KEY_PREFIX}:${mode}:${task.projectId}:${task.id}`;
}

function readProjectBoardView(projectId: string): BoardView {
  const view = taskboardStorage.getItem(`${PROJECT_VIEW_KEY_PREFIX}${projectId}`);
  return view === "readme" || view === "dashboard" || view === "list" || view === "gantt" || view === "issues"
    ? view
    : "issues";
}

function readProjectBoardDisplaySettings(): Record<string, BoardDisplaySettings> {
  const settings: Record<string, BoardDisplaySettings> = {};
  for (const [key, storedValue] of projectBoardDisplaySettingsStorageEntries()) {
    const projectId = key.slice(PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX.length);
    if (!projectId) continue;
    try {
      const value = JSON.parse(storedValue);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        settings[projectId] = value as BoardDisplaySettings;
      }
    } catch {
      // Ignore malformed display settings without affecting other projects.
    }
  }
  return settings;
}

function readRecentProjectIds(): string[] {
  try {
    const value = JSON.parse(taskboardStorage.getItem(RECENT_PROJECT_IDS_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((projectId): projectId is string => typeof projectId === "string" && projectId.length > 0)
      : [];
  } catch {
    return [];
  }
}

const EVENT_NAMES = [
  "task.created",
  "task.updated",
  "task.moved",
  "task.archived",
  "task.restored",
  "task.deleted",
  "task.relation.updated",
  "comment.created",
  "comment.updated",
  "comment.deleted",
  "attachment.created",
  "attachment.deleted",
  "project.created",
  "project.updated",
  "project.labels.updated",
  "project.readme.updated",
  "client-storage.updated",
  // v2 runs (CONTRACTS C4/C6, TICKETS Amendment 2)
  "run.updated",
  "run.activity",
  "followup.updated",
] as const;

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

function getInitialTheme(): Theme {
  const query = new URL(document.baseURI).searchParams;
  const host = query.get("host");
  if (
    window.parent !== window
    && (host === "codex" || host === "deepseek-harness")
  ) {
    const fromQuery = query.get("theme");
    if (isTheme(fromQuery)) return fromQuery;
    const stored = taskboardStorage.getItem("taskboard.theme");
    if (isTheme(stored)) return stored;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readDeviceWorkspacePaths(): Record<string, string> {
  try {
    const value = JSON.parse(taskboardStorage.getItem(DEVICE_WORKSPACE_PATHS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => (
      typeof entry[1] === "string" && entry[1].trim().length > 0
    )));
  } catch {
    return {};
  }
}

function readProjectCodexIdentities(): Record<string, CodexProjectIdentity> {
  try {
    const value = JSON.parse(taskboardStorage.getItem(PROJECT_CODEX_IDENTITIES_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, CodexProjectIdentity] => {
      const identity = entry[1] as Partial<CodexProjectIdentity> | null;
      return Boolean(
        identity
        && typeof identity.codexProjectId === "string"
        && (identity.codexProjectKind === "local" || identity.codexProjectKind === "remote")
        && typeof identity.codexHostId === "string"
        && typeof identity.workspacePath === "string",
      );
    }));
  } catch {
    return {};
  }
}

// v2 error codes (CONTRACTS C4/C6/C7, T11 handoff) shown as plain Traditional Chinese instead of the server text.

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt),
  );
}

function taskToDraft(task: Task): TaskDraft {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    labels: task.labels,
    developmentContext: task.developmentContext,
    startDate: task.startDate,
    dueDate: task.dueDate,
    recurrence: task.recurrence,
  };
}

interface LocalRealtimeSyncProps {
  selectedProjectId: string;
  detailTaskId: string | null;
  refreshProjectList: () => Promise<void>;
  refreshTasks: (
    projectId: string,
    options?: { quiet?: boolean; signal?: AbortSignal },
  ) => Promise<void>;
  refreshProjectBoardDisplaySettings: () => Promise<void>;
  setConnection: Dispatch<SetStateAction<ConnectionState>>;
  setCommentsRevision: Dispatch<SetStateAction<number>>;
  setAttachmentsRevision: Dispatch<SetStateAction<number>>;
  setReadmeRevision: Dispatch<SetStateAction<number>>;
  onRunUpdated: (taskId: string, run: TaskRun) => void;
}

function LocalRealtimeSync({
  selectedProjectId,
  detailTaskId,
  refreshProjectList,
  refreshTasks,
  refreshProjectBoardDisplaySettings,
  setConnection,
  setCommentsRevision,
  setAttachmentsRevision,
  setReadmeRevision,
  onRunUpdated,
}: LocalRealtimeSyncProps) {
  const selectionRef = useRef({ selectedProjectId, detailTaskId });
  const eventsUrl = resolveTaskboardUrl("/api/events");

  useLayoutEffect(() => {
    selectionRef.current = { selectedProjectId, detailTaskId };
  }, [selectedProjectId, detailTaskId]);

  useEffect(() => {
    const source = new EventSource(eventsUrl);
    let refreshTimer: number | undefined;
    let refreshProjectsPending = false;
    const pendingTaskProjects = new Set<string | undefined>();

    const scheduleRefresh = (options: { projects?: boolean; tasks?: boolean; projectId?: string }) => {
      refreshProjectsPending ||= options.projects === true;
      if (options.tasks) pendingTaskProjects.add(options.projectId);
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        const { selectedProjectId } = selectionRef.current;
        if (refreshProjectsPending) void refreshProjectList();
        if (
          selectedProjectId
          && pendingTaskProjects.size > 0
          && (
            selectedProjectId === ALL_PROJECTS_ID
            || pendingTaskProjects.has(undefined)
            || pendingTaskProjects.has(selectedProjectId)
          )
        ) {
          void refreshTasks(selectedProjectId, { quiet: true });
        }
        refreshProjectsPending = false;
        pendingTaskProjects.clear();
      }, 120);
    };

    const handleEvent = (event: Event) => {
      const message = event as MessageEvent<string>;
      let payload: {
        projectId?: string;
        taskId?: string;
        project?: Project;
        key?: string;
        run?: TaskRun;
        followup?: TaskFollowup;
        runId?: string;
        activity?: { kind?: unknown; text?: unknown; at?: unknown; createdAt?: unknown };
      } = {};
      try {
        payload = JSON.parse(message.data) as typeof payload;
      } catch {
        // A malformed event should not interrupt later updates.
      }
      if (event.type === "run.activity") {
        const activity = payload.activity;
        if (payload.taskId && activity && typeof activity.kind === "string" && typeof activity.text === "string") {
          publishTaskRunEvent({
            type: "run.activity",
            taskId: payload.taskId,
            runId: payload.runId ?? null,
            activity: {
              kind: activity.kind,
              text: activity.text,
              ...(typeof activity.at === "string" ? { at: activity.at } : {}),
              ...(typeof activity.createdAt === "string" ? { createdAt: activity.createdAt } : {}),
            },
          });
        }
        return;
      }
      if (event.type === "followup.updated") {
        if (payload.taskId) {
          publishTaskRunEvent({
            type: "followup.updated",
            taskId: payload.taskId,
            followup: payload.followup && typeof payload.followup === "object" ? payload.followup : null,
          });
        }
        return;
      }
      if (
        event.type === "client-storage.updated"
        && payload.key?.startsWith(PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX)
      ) {
        void refreshProjectBoardDisplaySettings();
        return;
      }
      const { selectedProjectId, detailTaskId } = selectionRef.current;
      const eventProjectId = payload.projectId ?? payload.project?.id;
      const affectsSelectedProject = Boolean(selectedProjectId)
        && (
          selectedProjectId === ALL_PROJECTS_ID
          || !eventProjectId
          || eventProjectId === selectedProjectId
        );
      if (event.type === "run.updated") {
        if (payload.taskId && payload.run) {
          onRunUpdated(payload.taskId, payload.run);
          publishTaskRunEvent({ type: "run.updated", taskId: payload.taskId, run: payload.run });
        }
        // Status moves arrive as task.* events too; this re-read keeps activeRun/latestRun exact.
        scheduleRefresh({ tasks: affectsSelectedProject, projectId: eventProjectId });
        return;
      }
      if (event.type === "project.created" || event.type === "project.updated") {
        scheduleRefresh({ projects: true });
        return;
      }
      if (event.type === "project.labels.updated") {
        scheduleRefresh({ projects: true, tasks: affectsSelectedProject, projectId: eventProjectId });
        return;
      }
      if (event.type.startsWith("task.")) {
        scheduleRefresh({
          projects: event.type !== "task.relation.updated",
          tasks: affectsSelectedProject,
          projectId: eventProjectId,
        });
        return;
      }
      if (!affectsSelectedProject) return;
      if (event.type === "project.readme.updated") {
        setReadmeRevision((current) => current + 1);
        return;
      }
      if (event.type.startsWith("comment.")) {
        if (!detailTaskId || !payload.taskId || payload.taskId === detailTaskId) {
          setCommentsRevision((current) => current + 1);
        }
        scheduleRefresh({ tasks: true, projectId: eventProjectId });
        return;
      }
      if (event.type.startsWith("attachment.")) {
        if (!detailTaskId || !payload.taskId || payload.taskId === detailTaskId) {
          setAttachmentsRevision((current) => current + 1);
          setCommentsRevision((current) => current + 1);
        }
      }
    };

    EVENT_NAMES.forEach((name) => source.addEventListener(name, handleEvent));
    source.onopen = () => {
      setConnection("live");
      const { selectedProjectId, detailTaskId } = selectionRef.current;
      void refreshProjectBoardDisplaySettings();
      scheduleRefresh({ projects: true, tasks: Boolean(selectedProjectId) });
      if (selectedProjectId && selectedProjectId !== ALL_PROJECTS_ID) {
        setReadmeRevision((current) => current + 1);
      }
      if (detailTaskId) {
        setCommentsRevision((current) => current + 1);
        setAttachmentsRevision((current) => current + 1);
      }
    };
    source.onerror = () => {
      setConnection("reconnecting");
    };

    return () => {
      window.clearTimeout(refreshTimer);
      EVENT_NAMES.forEach((name) => source.removeEventListener(name, handleEvent));
      source.close();
    };
  }, [
    eventsUrl,
    onRunUpdated,
    refreshProjectBoardDisplaySettings,
    refreshProjectList,
    refreshTasks,
    setAttachmentsRevision,
    setCommentsRevision,
    setConnection,
    setReadmeRevision,
  ]);

  return null;
}

export function App() {
  const query = useMemo(() => new URL(document.baseURI).searchParams, []);
  const host = query.get("host");
  const embedded = host === "codex" || host === "deepseek-harness";
  const undoShortcut = navigator.userAgent.includes("Macintosh") ? "⌘Z" : "Ctrl+Z";
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [hostContext, setHostContext] = useState<HostContext | null>(null);
  // v2 (T1): a saved choice outranks ?lang=; without either the board defaults to Taiwan Traditional Chinese.
  const [language, setLanguage] = useState(() => preferredTaskboardLanguage(
    taskboardStorage.getItem(TASKBOARD_LANGUAGE_KEY), query.get("lang"),
  ));
  const { locale, text } = getTaskboardI18n(language);
  // W12-B: 文字大小 is remembered per device (localStorage), independent of the synced client storage.
  const [textSize, setTextSize] = useTextSize();
  const [embeddedFrameChallenge, setEmbeddedFrameChallengeState] = useState("");
  const [developmentScan, setDevelopmentScan] = useState<DevelopmentScan>({ workspacePath: null, contexts: [] });
  const [developmentScanLoading, setDevelopmentScanLoading] = useState(false);
  const [manageTaskboardSkillPath, setManageTaskboardSkillPath] = useState("");
  const [taskboardMetadata, setTaskboardMetadata] = useState<TaskboardMetadata | null>(null);
  const [localAiChatAvailable, setLocalAiChatAvailable] = useState(false);
  const [aiImportReadyProjectId, setAiImportReadyProjectId] = useState<string | null>(null);
  const [aiThreads, setAiThreads] = useState<AiChatThread[]>([]);
  const [aiOpenThreadRequest, setAiOpenThreadRequest] = useState<AiChatOpenThreadRequest | null>(null);
  const aiOpenThreadRequestSequenceRef = useRef(0);
  const handleAiOpenThreadRequestHandled = useCallback((requestId: number) => {
    setAiOpenThreadRequest((current) => (
      current?.requestId === requestId ? null : current
    ));
  }, []);
  const [readActivityKeys, setReadActivityKeys] = useState<Record<string, string>>({});
  const [codexThreadProgress, setCodexThreadProgress] = useState<
    Record<string, {
      completed: number | null;
      total: number | null;
      running: boolean;
    } | null>
  >({});
  const [recentProjectIds, setRecentProjectIds] = useState(readRecentProjectIds);
  const initialProjectId = query.get("project") ?? recentProjectIds[0] ?? ALL_PROJECTS_ID;
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [archivedTasks, setArchivedTasks] = useState<Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [hasLoadedTasks, setHasLoadedTasks] = useState(false);
  const [projectLoadError, setProjectLoadError] = useState<ProjectLoadError | null>(null);
  const [tasksLoadError, setTasksLoadError] = useState<TasksLoadError | null>(null);
  const loadError: LoadError | null = projectLoadError ?? tasksLoadError;
  const [actionError, setActionError] = useState<ActionError | null>(null);
  useEffect(() => {
    if (actionError === null) setWorkspaceFixProjectId(null);
  }, [actionError]);
  useEffect(() => {
    function rememberMissingWorkspace(event: Event) {
      const projectId = (event as CustomEvent<{ projectId?: unknown }>).detail?.projectId;
      if (typeof projectId === "string") setWorkspaceFixProjectId(projectId);
    }
    window.addEventListener(WORKSPACE_MISSING_EVENT, rememberMissingWorkspace);
    return () => window.removeEventListener(WORKSPACE_MISSING_EVENT, rememberMissingWorkspace);
  }, []);
  const actionErrorText = actionError === null
    ? null
    : typeof actionError === "string"
      ? actionError
      : text(actionError[0], actionError[1], actionError[2]);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState(readTaskFilters);
  const [boardView, setBoardView] = useState<BoardView>(() => readProjectBoardView(initialProjectId));
  const [projectBoardDisplaySettings, setProjectBoardDisplaySettings] = useState(
    readProjectBoardDisplaySettings,
  );
  const refreshProjectBoardDisplaySettings = useCallback(async () => {
    try {
      await refreshProjectBoardDisplaySettingsStorage();
      setProjectBoardDisplaySettings(readProjectBoardDisplaySettings());
    } catch (error) {
      console.error(error);
    }
  }, []);
  const [dashboardSummaryAnimatedProjectId, setDashboardSummaryAnimatedProjectId] = useState<string | null>(null);
  const [ganttZoom, setGanttZoom] = useState<GanttZoom>("week");
  const [ganttHideCompleted, setGanttHideCompleted] = useState(false);
  const [ganttTodayRequest, setGanttTodayRequest] = useState(0);
  const [ganttViewMenuOpen, setGanttViewMenuOpen] = useState(false);
  const [otherTasksOpen, setOtherTasksOpen] = useState(false);
  const [otherTasksMounted, setOtherTasksMounted] = useState(false);
  const [otherTasksVisible, setOtherTasksVisible] = useState(false);
  const [otherTasksTab, setOtherTasksTab] = useState<OtherTaskTab>("backlog");
  const [restoringTaskId, setRestoringTaskId] = useState<string | null>(null);
  const [pendingArchivedTaskDelete, setPendingArchivedTaskDelete] = useState<Task | null>(null);
  const [deletingArchivedTaskId, setDeletingArchivedTaskId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const openNewTaskRef = useRef<(status?: TaskStatus) => void>(() => {});
  const [newTaskDraft, setNewTaskDraft] = useState<{
    projectId: string;
    targetProjectId: string | null;
    draft: NewTaskEditorDraft;
  } | null>(null);
  const [detailTaskIdentifier, setDetailTaskIdentifier] = useState<string | null>(
    () => readIssueIdentifier(window.location.search),
  );
  const [commentsRevision, setCommentsRevision] = useState(0);
  // DBG-08: bumped when a move needs the continue flow; TaskDetail focuses its composer and shows a hint.
  const [continueRequest, setContinueRequest] = useState<{ taskId: string; sequence: number; flow: ContinueFlowKind } | null>(null);
  const continueRequestSequenceRef = useRef(0);
  const [attachmentsRevision, setAttachmentsRevision] = useState(0);
  const [readmeRevision, setReadmeRevision] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [draggedTaskHeight, setDraggedTaskHeight] = useState(0);
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);
  const [movingTaskId, setMovingTaskId] = useState<string | null>(null);
  const [settlingTaskId, setSettlingTaskId] = useState<string | null>(null);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [openingThreadTaskId, setOpeningThreadTaskId] = useState<string | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(
    () => taskboardStorage.getItem(FIRST_USE_COMPLETE_KEY) === null,
  );
  const [projectMenuSearch, setProjectMenuSearch] = useState("");
  const [projectContextMenu, setProjectContextMenu] = useState<ProjectContextMenuState | null>(null);
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);
  // W15: set when 「新增任務」 had to create a project first; the new-task editor opens once the project exists.
  const [createTaskAfterProject, setCreateTaskAfterProject] = useState(false);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [startGuideDismissed, setStartGuideDismissed] = useState(
    () => taskboardStorage.getItem(START_GUIDE_DISMISSED_KEY) === "true",
  );
  const [projectName, setProjectName] = useState("");
  // W15: the folder AI runs use (required when creating a project on this PC).
  const [projectFolder, setProjectFolder] = useState("");
  const [projectFolderDialog, setProjectFolderDialog] = useState<{ projectId: string; name: string } | null>(null);
  const [projectFolderValue, setProjectFolderValue] = useState("");
  const [projectFolderError, setProjectFolderError] = useState<string | null>(null);
  const [savingProjectFolder, setSavingProjectFolder] = useState(false);
  // W15: set when a run refused to start because its project has no (existing) folder.
  const [workspaceFixProjectId, setWorkspaceFixProjectId] = useState<string | null>(null);
  const [jiraDialogOpen, setJiraDialogOpen] = useState(false);
  // v2 mobile access settings (T10): desktop only — a phone on the tailnet address cannot use /api/local/*.
  const [mobileAccessOpen, setMobileAccessOpen] = useState(false);
  // E2: embedded frames have an about:blank location; the base URI carries the real board address.
  const servedFromThisPc = isLoopbackHostname(taskboardPageHostname());
  // W15 review M1/O1: project folders are chosen only in this PC's own board. A phone, and the
  // sandboxed Codex panel (opaque origin, sends Origin: null), create projects without a folder.
  const canSetFolderHere = servedFromThisPc && !isOpaqueOrigin();
  // Amendment 13 (W12-C): desktop 「連接手機」 wizard; phone-side onboarding after pairing.
  const [phoneWizardOpen, setPhoneWizardOpen] = useState(false);
  const [phonePaired, setPhonePaired] = useState(() => !isPhonePairingRequired());
  const [phoneJustPaired, setPhoneJustPaired] = useState(false);
  const [phoneHintBarSlot, setPhoneHintBarSlot] = useState<HTMLDivElement | null>(null);
  // 「在 App 開啟」 (codex:// / claude://) only works on this PC.
  const openRunInAppHere = runAppLinksWorkHere();
  const [jiraConnection, setJiraConnection] = useState<JiraConnection | null>(null);
  const [jiraSaving, setJiraSaving] = useState(false);
  const [jiraSyncing, setJiraSyncing] = useState(false);
  const [jiraError, setJiraError] = useState<string | null>(null);
  const [pendingProjectDelete, setPendingProjectDelete] = useState<ProjectChoice | null>(null);
  const [projectDeleteIssueCount, setProjectDeleteIssueCount] = useState<number | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [deviceWorkspacePaths, setDeviceWorkspacePaths] = useState(readDeviceWorkspacePaths);
  const [projectCodexIdentities, setProjectCodexIdentities] = useState(readProjectCodexIdentities);
  const [automationCatalog, setAutomationCatalog] = useState<{
    projectId: string;
    models: AiChatModel[];
  } | null>(null);
  // v2 todo order mode per project (GET /api/projects/:id/automation orderMode; server default "suggested").
  const [projectOrderModes, setProjectOrderModes] = useState<Record<string, ProjectOrderMode>>({});
  const [announcement, setAnnouncementValue] = useState("");
  const [undoNotice, setUndoNotice] = useState<UndoNotice | null>(null);
  const projectsRequestRef = useRef(0);
  const tasksRequestRef = useRef(0);
  const tasksRef = useRef<Task[]>([]);
  const undoSequenceRef = useRef(0);
  const undoStackRef = useRef<UndoOperation[]>([]);
  const undoInFlightRef = useRef(false);
  const dragRegionRef = useRef<HTMLDivElement>(null);
  const issueListRef = useRef<HTMLDivElement>(null);
  const boardScrollRef = useRef<HTMLDivElement>(null);
  const boardColumnScrollRefs = useRef<Partial<Record<TaskStatus, HTMLDivElement | null>>>({});
  const detailSourceProjectIdRef = useRef<string | null>(null);
  const pendingDetailSourceScrollRef = useRef<DetailSourceScroll | null>(null);
  const taskScopeProjectId = detailSourceProjectIdRef.current ?? selectedProjectId;
  const taskScopeProjectIdRef = useRef(taskScopeProjectId);
  taskScopeProjectIdRef.current = taskScopeProjectId;

  const revisionPollingInterval = getRevisionPollingInterval(taskboardMetadata);
  const revisionWebSocketConfig = getRevisionWebSocketConfig(taskboardMetadata);
  const revisionWebSocketEndpoint = revisionWebSocketConfig?.endpoint ?? null;
  const textRef = useRef(text);
  textRef.current = text;
  setApiText(text);
  function errorMessage(error: unknown): string {
    if (error instanceof ApiError) {
      const known = runErrorTextPair(error);
      return known ? textRef.current(known[0], known[1]) : error.message;
    }
    if (error instanceof Error) return error.message;
    return textRef.current(
      "加载议题时出现问题。",
      "Something went wrong while loading your issues.",
    );
  }

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const applyRunUpdate = useCallback((taskId: string, run: TaskRun) => {
    setTasks((current) => (
      current.some((task) => task.id === taskId)
        ? current.map((task) => (task.id === taskId ? mergeRunIntoTask(task, run) : task))
        : current
    ));
  }, []);

  const setAnnouncement = useCallback((message: string) => {
    setUndoNotice(null);
    setAnnouncementValue(message);
  }, []);

  const markDashboardSummaryAnimationStarted = useCallback((projectId: string) => {
    setDashboardSummaryAnimatedProjectId(projectId);
  }, []);

  const rememberDeviceWorkspacePath = useCallback((projectId: string, workspacePath: string) => {
    if (projectId === GLOBAL_PROJECT_ID) return;
    const normalizedPath = workspacePath.trim();
    setDeviceWorkspacePaths((current) => {
      if (current[projectId] === normalizedPath || (!normalizedPath && !(projectId in current))) {
        return current;
      }
      const next = { ...current };
      if (normalizedPath) next[projectId] = normalizedPath;
      else delete next[projectId];
      taskboardStorage.setItem(DEVICE_WORKSPACE_PATHS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const rememberProjectOpen = useCallback((projectId: string) => {
    setRecentProjectIds((current) => {
      if (current[0] === projectId) return current;
      const next = [projectId, ...current.filter((candidate) => candidate !== projectId)];
      taskboardStorage.setItem(RECENT_PROJECT_IDS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedCodexProjectIdentity = useMemo(
    () => selectedProject ? codexProjectContextForTaskProject(selectedProject.id) : null,
    [deviceWorkspacePaths, hostContext, projectCodexIdentities, projects, selectedProject?.id],
  );
  const isAllProjects = selectedProjectId === ALL_PROJECTS_ID;
  const isJiraProject = selectedProject?.source === "jira";
  const storedBoardDisplaySettings = projectBoardDisplaySettings[selectedProjectId]
    ?? (isAllProjects
      ? ALL_PROJECTS_DEFAULT_BOARD_DISPLAY_SETTINGS
      : DEFAULT_BOARD_DISPLAY_SETTINGS);
  const boardDisplaySettings: BoardDisplaySettings = isAllProjects
    && storedBoardDisplaySettings.sidebarStatuses.includes("backlog")
    && !storedBoardDisplaySettings.mainStatuses.includes("backlog")
    ? {
        ...storedBoardDisplaySettings,
        mainStatuses: ["backlog", ...storedBoardDisplaySettings.mainStatuses],
        sidebarStatuses: storedBoardDisplaySettings.sidebarStatuses.filter(
          (status) => status !== "backlog",
        ),
      }
    : storedBoardDisplaySettings;
  const automationModels = automationCatalog && automationCatalog.projectId === selectedProject?.id
    ? automationCatalog.models
    : [];
  // Codex model catalog for the auto-claim menu's Codex model picker (the menu falls back to free text).
  useEffect(() => {
    setAutomationCatalog(null);
    if (!selectedProject || !localAiChatAvailable) return;
    const controller = new AbortController();
    void getAiChatCatalog(
      selectedProject.id,
      controller.signal,
      selectedCodexProjectIdentity,
    ).then(
      (catalog) => {
        if (controller.signal.aborted) return;
        setAutomationCatalog({ projectId: selectedProject.id, models: catalog.models });
      },
      () => {},
    );
    return () => controller.abort();
  }, [
    localAiChatAvailable,
    selectedCodexProjectIdentity?.codexHostId,
    selectedCodexProjectIdentity?.codexProjectId,
    selectedCodexProjectIdentity?.codexProjectKind,
    selectedCodexProjectIdentity?.workspacePath,
    selectedProject?.id,
  ]);
  const aiImportProjectId = hasLoadedTasks
    && tasks.length === 0
    && selectedProject
    && selectedProject.id !== GLOBAL_PROJECT_ID
    && !isJiraProject
    && localAiChatAvailable
      ? selectedProject.id
      : null;
  useEffect(() => {
    setAiImportReadyProjectId(null);
    if (!aiImportProjectId) return;
    const controller = new AbortController();
    void getAiChatCatalog(aiImportProjectId, controller.signal, selectedCodexProjectIdentity)
      .then(() => {
        if (!controller.signal.aborted) setAiImportReadyProjectId(aiImportProjectId);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [
    aiImportProjectId,
    selectedCodexProjectIdentity?.codexHostId,
    selectedCodexProjectIdentity?.codexProjectId,
    selectedCodexProjectIdentity?.codexProjectKind,
    selectedCodexProjectIdentity?.workspacePath,
  ]);
  useLayoutEffect(() => {
    if (selectedProject) rememberProjectOpen(selectedProject.id);
  }, [rememberProjectOpen, selectedProject]);
  const currentUser = hostContext?.user ?? {
    ...DEFAULT_USER_ACTOR,
    name: text("本地用户", "Local user"),
  };
  const selectedDeviceWorkspacePath = selectedProjectId === GLOBAL_PROJECT_ID || isAllProjects
    ? undefined
    : deviceWorkspacePaths[selectedProjectId];
  const referenceTasks = useMemo(() => [...tasks, ...archivedTasks], [archivedTasks, tasks]);
  const detailTask = detailTaskIdentifier
    ? referenceTasks.find((task) => task.identifier === detailTaskIdentifier) ?? null
    : null;
  const detailTaskId = detailTask?.id ?? null;
  const contextMenuTask = contextMenu
    ? tasks.find((task) => task.id === contextMenu.taskId) ?? null
    : null;
  const contextMenuWorkspacePath = contextMenuTask
    ? deviceWorkspacePaths[contextMenuTask.projectId]
    : undefined;
  const availableLabels = isAllProjects
    ? [...new Set(projects.flatMap((project) => project.labels))]
    : selectedProject?.labels ?? [];
  const projectNames = useMemo(() => Object.fromEntries(projects.map((project) => [
    project.id,
    project.id === GLOBAL_PROJECT_ID ? text("临时任务", "Temporary tasks") : project.name,
  ])), [projects, text]);
  const projectChoices = useMemo<ProjectChoice[]>(() => {
    const persistedById = new Map(projects.map((project) => [project.id, project]));
    const seen = new Set<string>();
    const choices: ProjectChoice[] = [];
    for (const project of hostContext?.projects ?? []) {
      if (!project.id || !project.name || seen.has(project.id)) continue;
      seen.add(project.id);
      choices.push({
        id: project.id,
        name: project.id === GLOBAL_PROJECT_ID
          ? text("临时任务", "Temporary tasks")
          : persistedById.get(project.id)?.name ?? project.name,
        issueCount: persistedById.get(project.id)?.issueCount ?? 0,
        inCodex: true,
        persisted: persistedById.has(project.id),
        codexIdentity: project.workspacePath && project.projectKind && project.hostId
          ? {
              codexProjectId: project.id,
              codexProjectKind: project.projectKind,
              codexHostId: project.hostId,
              workspacePath: project.workspacePath,
            }
          : null,
      });
    }
    for (const project of projects) {
      if (seen.has(project.id)) continue;
      choices.push({
        id: project.id,
        name: project.id === GLOBAL_PROJECT_ID
          ? text("临时任务", "Temporary tasks")
          : project.name,
        issueCount: project.issueCount,
        inCodex: false,
        persisted: true,
        codexIdentity: projectCodexIdentities[project.id] ?? null,
      });
    }
    const recentOrder = new Map(recentProjectIds.map((projectId, index) => [projectId, index]));
    const sortedChoices = choices.sort((left, right) => (
      (recentOrder.get(left.id) ?? recentProjectIds.length)
      - (recentOrder.get(right.id) ?? recentProjectIds.length)
    ));
    return [
      ...sortedChoices.filter((project) => project.issueCount > 0),
      ...sortedChoices.filter((project) => project.issueCount === 0),
    ];
  }, [hostContext?.projects, projectCodexIdentities, projects, recentProjectIds, text]);
  const projectMenuCandidates = projectChoices.filter(
    (project) => project.id !== GLOBAL_PROJECT_ID || project.issueCount > 0,
  );
  const projectMenuNeedle = projectMenuSearch.trim().toLocaleLowerCase();
  const projectMenuChoices = projectMenuNeedle
    ? projectMenuCandidates.filter((project) => project.name.toLocaleLowerCase().includes(projectMenuNeedle))
    : projectMenuCandidates;
  const firstEmptyProjectId = projectMenuChoices.find((project) => project.issueCount === 0)?.id ?? null;
  const hasProjectsWithIssues = projectMenuChoices.some((project) => project.issueCount > 0);
  const createTargetProjects = projectChoices.flatMap((choice) => {
    const project = projects.find((candidate) => candidate.id === choice.id);
    return project && project.source !== "jira"
      ? [{ id: choice.id, name: choice.name }]
      : [];
  });
  // W15: projects the user made (not 臨時任務). With 所有專案 a new task goes to the last used one, or the only one.
  const userCreateTargetProjects = createTargetProjects.filter((project) => project.id !== GLOBAL_PROJECT_ID);
  const defaultAllProjectsTargetId = recentProjectIds.find(
    (projectId) => userCreateTargetProjects.some((project) => project.id === projectId),
  ) ?? (userCreateTargetProjects.length === 1 ? userCreateTargetProjects[0].id : undefined);
  const editorProjectId = editor?.projectId
    ?? (newTaskDraft?.projectId === selectedProjectId ? newTaskDraft.targetProjectId : undefined)
    ?? (isAllProjects ? defaultAllProjectsTargetId ?? GLOBAL_PROJECT_ID : selectedProjectId);
  const developmentEditorProjectId = isAllProjects && editor ? editorProjectId : null;
  const hasTasksInView = tasks.length > 0;
  // W15: no project of your own yet (and nothing on this board) → 「新增任務」 creates a project first.
  // Review M2: only where a folder can be chosen; elsewhere a new task goes to 臨時任務 as before.
  const needsProjectBeforeTask = canSetFolderHere
    && projectsLoaded
    && userCreateTargetProjects.length === 0
    && (isAllProjects || selectedProjectId === GLOBAL_PROJECT_ID)
    && !hasTasksInView;
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  function openTaskContextMenu(task: Task, position: { x: number; y: number }) {
    if (
      isAllProjects
      && (!embedded || window.parent === window)
      && task.developmentContext?.type === "worktree"
    ) {
      setDevelopmentScanLoading(true);
    }
    setContextMenu({ taskId: task.id, ...position });
  }
  const issueReadMode = taskboardMetadata?.mode ?? "local";

  useEffect(() => {
    let mountFrame = 0;
    let showFrame = 0;
    let closeTimer = 0;

    if (otherTasksOpen) {
      setOtherTasksMounted(true);
      mountFrame = window.requestAnimationFrame(() => {
        showFrame = window.requestAnimationFrame(() => setOtherTasksVisible(true));
      });
    } else {
      setOtherTasksVisible(false);
      closeTimer = window.setTimeout(() => setOtherTasksMounted(false), 320);
    }

    return () => {
      window.cancelAnimationFrame(mountFrame);
      window.cancelAnimationFrame(showFrame);
      window.clearTimeout(closeTimer);
    };
  }, [otherTasksOpen]);

  const markTaskRead = useCallback((task: Task) => {
    if (!task.activityKey) return;
    const storageKey = issueReadStorageKey(issueReadMode, task);
    setReadActivityKeys((current) => {
      if (current[storageKey] === task.activityKey) return current;
      const next = { ...current, [storageKey]: task.activityKey };
      try {
        taskboardStorage.setItem(storageKey, task.activityKey);
      } catch {
        // Read state remains valid for this page even when browser persistence is unavailable.
      }
      return next;
    });
  }, [issueReadMode]);

  useEffect(() => {
    if (detailTask) markTaskRead(detailTask);
  }, [detailTask?.activityKey, detailTask?.id, markTaskRead]);

  function openTaskDetail(task: Pick<Task, "identifier" | "projectId">) {
    const fullTask = tasksRef.current.find((candidate) => candidate.identifier === task.identifier);
    if (fullTask) markTaskRead(fullTask);
    const currentIssue = readIssueIdentifier(window.location.search);
    if (!currentIssue) detailSourceProjectIdRef.current = selectedProjectId;
    if (isAllProjects) setSelectedProjectId(task.projectId);
    if (boardView === "list" && issueListRef.current) {
      pendingDetailSourceScrollRef.current = {
        projectId: selectedProjectId,
        view: "list",
        scrollTop: issueListRef.current.scrollTop,
      };
    } else if (boardView === "issues" && fullTask) {
      const scrollContainer = boardColumnScrollRefs.current[fullTask.status];
      if (scrollContainer) {
        pendingDetailSourceScrollRef.current = {
          projectId: selectedProjectId,
          view: "issues",
          status: fullTask.status,
          scrollTop: scrollContainer.scrollTop,
          scrollLeft: boardScrollRef.current?.scrollLeft ?? 0,
        };
      }
    }
    closeContextMenu();
    setProjectMenuOpen(false);
    setDetailTaskIdentifier(task.identifier);
    const boardUrl = buildIssueUrl(window.location.href, selectedProjectId, null);
    if (!currentIssue) {
      window.history.replaceState(window.history.state, "", boardUrl);
    }
    const detailUrl = buildIssueUrl(
      currentIssue ? window.location.href : boardUrl.href,
      task.projectId,
      task.identifier,
    );
    window.history.pushState(window.history.state, "", detailUrl);
  }

  function closeTaskDetail() {
    const sourceProjectId = detailSourceProjectIdRef.current ?? selectedProjectId;
    detailSourceProjectIdRef.current = null;
    setDetailTaskIdentifier(null);
    if (sourceProjectId !== selectedProjectId) {
      setSelectedProjectId(sourceProjectId);
      setBoardView(sourceProjectId === ALL_PROJECTS_ID ? "issues" : readProjectBoardView(sourceProjectId));
    }
    const url = buildIssueUrl(window.location.href, sourceProjectId, null);
    window.history.replaceState(window.history.state, "", url);
  }

  useLayoutEffect(() => {
    if (detailTaskIdentifier) return;
    const pendingScroll = pendingDetailSourceScrollRef.current;
    if (!pendingScroll) return;
    if (pendingScroll.view !== boardView || pendingScroll.projectId !== selectedProjectId) {
      pendingDetailSourceScrollRef.current = null;
      return;
    }
    pendingDetailSourceScrollRef.current = null;
    if (pendingScroll.view === "list") {
      if (issueListRef.current) issueListRef.current.scrollTop = pendingScroll.scrollTop;
      return;
    }
    const columnScrollContainer = boardColumnScrollRefs.current[pendingScroll.status];
    if (columnScrollContainer) columnScrollContainer.scrollTop = pendingScroll.scrollTop;
    if (boardScrollRef.current) boardScrollRef.current.scrollLeft = pendingScroll.scrollLeft;
  }, [boardView, detailTaskIdentifier, selectedProjectId]);

  useEffect(() => {
    function syncRouteFromLocation() {
      const url = new URL(window.location.href);
      const routeProjectId = url.searchParams.get("project") ?? GLOBAL_PROJECT_ID;
      const routeIssueIdentifier = readIssueIdentifier(url.search);
      if (routeIssueIdentifier && boardView === "list" && issueListRef.current) {
        pendingDetailSourceScrollRef.current = {
          projectId: selectedProjectId,
          view: "list",
          scrollTop: issueListRef.current.scrollTop,
        };
      } else if (routeIssueIdentifier && boardView === "issues") {
        const routeTask = tasksRef.current.find(
          (task) => task.identifier === routeIssueIdentifier,
        );
        const scrollContainer = routeTask
          ? boardColumnScrollRefs.current[routeTask.status]
          : null;
        if (routeTask && scrollContainer) {
          pendingDetailSourceScrollRef.current = {
            projectId: selectedProjectId,
            view: "issues",
            status: routeTask.status,
            scrollTop: scrollContainer.scrollTop,
            scrollLeft: boardScrollRef.current?.scrollLeft ?? 0,
          };
        }
      }
      if (!routeIssueIdentifier) detailSourceProjectIdRef.current = null;
      setDetailTaskIdentifier(routeIssueIdentifier);
      if (routeProjectId === selectedProjectId) return;
      setBoardView(routeProjectId === ALL_PROJECTS_ID ? "issues" : readProjectBoardView(routeProjectId));
      setSelectedProjectId(routeProjectId);
    }

    window.addEventListener("popstate", syncRouteFromLocation);
    return () => window.removeEventListener("popstate", syncRouteFromLocation);
  }, [boardView, selectedProjectId]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.embedded = String(embedded);
    document.documentElement.style.colorScheme = theme;
  }, [embedded, theme]);

  useEffect(() => {
    if (embedded && window.parent !== window) return;
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    const syncTheme = () => setTheme(systemTheme.matches ? "dark" : "light");
    syncTheme();
    systemTheme.addEventListener("change", syncTheme);
    return () => systemTheme.removeEventListener("change", syncTheme);
  }, [embedded]);

  useEffect(() => {
    if (selectedProjectId) {
      setBoardView(selectedProjectId === ALL_PROJECTS_ID ? "issues" : readProjectBoardView(selectedProjectId));
    }
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setDashboardSummaryAnimatedProjectId(null);
    } else if (boardView !== "dashboard") {
      setDashboardSummaryAnimatedProjectId(selectedProjectId);
    }
  }, [boardView, selectedProjectId]);

  useEffect(() => {
    writeTaskFilters(filters);
  }, [filters]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    if (taskboardStorage.getItem(FIRST_USE_COMPLETE_KEY) === null) {
      taskboardStorage.setItem(FIRST_USE_COMPLETE_KEY, "true");
    }
  }, []);

  useEffect(() => {
    if (!projectMenuOpen) return;
    function closeProjectMenu(event: PointerEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-project-switcher]")) setProjectMenuOpen(false);
    }
    function closeProjectMenuWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setProjectMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeProjectMenu);
    window.addEventListener("keydown", closeProjectMenuWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeProjectMenu);
      window.removeEventListener("keydown", closeProjectMenuWithEscape);
    };
  }, [projectMenuOpen]);

  useEffect(() => {
    if (!projectContextMenu) return;
    function closeProjectContextMenu(event: PointerEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-project-context-menu]")) setProjectContextMenu(null);
    }
    function closeProjectContextMenuWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setProjectContextMenu(null);
    }
    document.addEventListener("pointerdown", closeProjectContextMenu);
    window.addEventListener("keydown", closeProjectContextMenuWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeProjectContextMenu);
      window.removeEventListener("keydown", closeProjectContextMenuWithEscape);
    };
  }, [projectContextMenu]);

  useEffect(() => {
    if (!embedded || window.parent === window) return;
    let acknowledgedFrameChallenge = "";

    function receiveHostMessage(event: MessageEvent) {
      if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
      const message = event.data as { type?: string; payload?: unknown; theme?: unknown };

      if (message.type === "taskboard:frame-challenge") {
        const challenge = typeof message.payload === "object"
          && message.payload
          && "challenge" in message.payload
          && typeof message.payload.challenge === "string"
          ? message.payload.challenge
          : "";
        if (!challenge || challenge === acknowledgedFrameChallenge) return;
        acknowledgedFrameChallenge = challenge;
        setEmbeddedFrameChallenge(challenge);
        setEmbeddedFrameChallengeState(challenge);
        postEmbeddedHostMessage({ type: "taskboard:ready" });
        return;
      }

      if (message.type === "taskboard:theme" && isTheme(message.theme)) {
        setTheme(message.theme);
        return;
      }

      if (message.type === "taskboard:thread-prepared" && message.payload) {
        setOpeningThreadTaskId(null);
        return;
      }

      if (message.type === "taskboard:thread-create-error" && message.payload) {
        const payload = message.payload as { error?: unknown };
        setOpeningThreadTaskId(null);
        setActionError(typeof payload.error === "string"
          ? payload.error
          : textRef.current("无法在 Codex 中打开新对话。", "Could not open a new conversation in Codex."));
        return;
      }

      if (message.type === "taskboard:thread-open-error" && message.payload) {
        const payload = message.payload as { error?: unknown };
        setActionError(typeof payload.error === "string"
          ? payload.error
          : textRef.current("无法打开 Codex 对话。", "Could not open the Codex conversation."));
        return;
      }

      if (message.type !== "taskboard:host-context" || !message.payload) return;
      const payload = message.payload as HostContext;
      setHostContext(payload);
      setCurrentUserActor(payload.user);
      if (isTheme(payload.theme)) setTheme(payload.theme);
      if (host === "codex") void publishHostRuntime(payload);
    }

    const removeExternalLinkHandler = installEmbeddedExternalLinkHandler();
    window.addEventListener("message", receiveHostMessage);
    postEmbeddedHostMessage({ type: "taskboard:frame-awaiting-challenge" });
    return () => {
      window.removeEventListener("message", receiveHostMessage);
      setEmbeddedFrameChallenge("");
      removeExternalLinkHandler();
    };
  }, [embedded, host]);

  useLayoutEffect(() => {
    if (!embedded || window.parent === window || !dragRegionRef.current) return;
    const region = dragRegionRef.current;
    const publish = () => {
      const rect = region.getBoundingClientRect();
      postEmbeddedHostMessage({
        type: "taskboard:drag-region",
        payload: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    };
    const observer = new ResizeObserver(publish);
    observer.observe(region);
    window.addEventListener("resize", publish);
    publish();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publish);
      postEmbeddedHostMessage({ type: "taskboard:drag-region", payload: null });
    };
  }, [detailTaskId, embedded, embeddedFrameChallenge, selectedProjectId]);

  const loadProjectList = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++projectsRequestRef.current;
    setProjectLoadError((current) => (
      current?.operation === "initial" ? { ...current, requestId } : current
    ));
    try {
      const [nextProjects, metadata, workspaces] = await Promise.all([
        listProjects(signal),
        getTaskboardMetadata(signal),
        listDeviceWorkspaces(signal),
      ]);
      if (requestId !== projectsRequestRef.current) return;
      const [nextJiraConnection, nextTemporaryTasks] = await Promise.all([
        getJiraConnection(signal),
        listTasks(GLOBAL_PROJECT_ID, signal),
      ]);
      if (requestId !== projectsRequestRef.current) return;
      setTaskboardMetadata((current) => (
        current
        && current.mode === metadata.mode
        && JSON.stringify(current.realtime) === JSON.stringify(metadata.realtime)
        && current.manageTaskboardSkillPath === metadata.manageTaskboardSkillPath
        && current.localCapabilities?.available === metadata.localCapabilities?.available
          ? current
          : metadata
      ));
      setManageTaskboardSkillPath(metadata.manageTaskboardSkillPath ?? "");
      setLocalAiChatAvailable(metadata.capabilities?.localAiChat === true);
      setDeviceWorkspacePaths((current) => {
        const next = { ...current, ...workspaces };
        delete next[GLOBAL_PROJECT_ID];
        if (JSON.stringify(next) === JSON.stringify(current)) return current;
        taskboardStorage.setItem(DEVICE_WORKSPACE_PATHS_KEY, JSON.stringify(next));
        return next;
      });
      setProjectsLoaded(true);
      setProjects(nextProjects.map((project) => project.id === GLOBAL_PROJECT_ID
        ? {
            ...project,
            issueCount: nextTemporaryTasks.filter((task) => (
              MAIN_STATUSES.some((status) => status === task.status)
            )).length,
          }
        : project));
      setJiraConnection(nextJiraConnection);
      setSelectedProjectId((current) => {
        const fromQuery = new URLSearchParams(window.location.search).get("project");
        if (fromQuery === ALL_PROJECTS_ID) return fromQuery;
        if (fromQuery && nextProjects.some((project) => project.id === fromQuery)) return fromQuery;
        if (current === ALL_PROJECTS_ID) return current;
        if (current && nextProjects.some((project) => project.id === current)) return current;
        return nextProjects.find((project) => project.id === GLOBAL_PROJECT_ID)?.id
          ?? nextProjects[0]?.id
          ?? GLOBAL_PROJECT_ID;
      });
      setProjectLoadError((current) => (
        current?.operation === "initial" && current.requestId === requestId ? null : current
      ));
    } catch (error) {
      if ((error as Error).name !== "AbortError" && requestId === projectsRequestRef.current) {
        setProjectLoadError({
          source: "projects",
          operation: "initial",
          requestId,
          message: errorMessage(error),
        });
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadProjectList(controller.signal);
    return () => controller.abort();
  }, [loadProjectList]);

  const refreshProjectList = useCallback(async () => {
    const requestId = ++projectsRequestRef.current;
    setProjectLoadError((current) => (
      current?.operation === "refresh" ? { ...current, requestId } : current
    ));
    try {
      const [nextProjects, nextTemporaryTasks] = await Promise.all([
        listProjects(),
        listTasks(GLOBAL_PROJECT_ID),
      ]);
      if (requestId !== projectsRequestRef.current) return;
      setProjectsLoaded(true);
      setProjects(nextProjects.map((project) => project.id === GLOBAL_PROJECT_ID
        ? {
            ...project,
            issueCount: nextTemporaryTasks.filter((task) => (
              MAIN_STATUSES.some((status) => status === task.status)
            )).length,
          }
        : project));
      setProjectLoadError((current) => (
        current?.operation === "refresh" && current.requestId === requestId ? null : current
      ));
    } catch (error) {
      if (requestId === projectsRequestRef.current) {
        setProjectLoadError({
          source: "projects",
          operation: "refresh",
          requestId,
          message: errorMessage(error),
        });
      }
    }
  }, []);

  const refreshProjectOrderMode = useCallback(async (projectId: string, signal?: AbortSignal) => {
    if (!projectId || projectId === ALL_PROJECTS_ID) return;
    try {
      const automation = await getProjectAutomation(projectId, signal);
      setProjectOrderModes((current) => (
        current[projectId] === automation.orderMode
          ? current
          : { ...current, [projectId]: automation.orderMode }
      ));
    } catch {
      // Without automation settings (older server, request aborted) the board keeps the suggested default.
    }
  }, []);

  const refreshTasks = useCallback(async (
    projectId: string,
    options: { quiet?: boolean; signal?: AbortSignal } = {},
  ) => {
    // Another window or taskctl can switch the todo order mode (drag within todo / reset), so re-read it too.
    void refreshProjectOrderMode(projectId, options.signal);
    const requestId = ++tasksRequestRef.current;
    if (!options.quiet) setTasksLoading(true);
    setTasksLoadError((current) => (
      current ? { ...current, requestId } : current
    ));
    try {
      const taskProjectId = projectId === ALL_PROJECTS_ID ? undefined : projectId;
      const [nextTasks, nextArchivedTasks] = await Promise.all([
        listTasks(taskProjectId, options.signal),
        listArchivedTasks(taskProjectId, options.signal),
      ]);
      if (requestId !== tasksRequestRef.current) return;
      setTasks(sortTasks(nextTasks));
      setArchivedTasks(sortTasks(nextArchivedTasks));
      setProjects((current) => current.map((project) => {
        if (project.id !== projectId || project.source !== "jira") return project;
        const labels = [...new Set(nextTasks.flatMap((task) => task.labels))];
        return JSON.stringify(labels) === JSON.stringify(project.labels)
          ? project
          : { ...project, labels };
      }));
      setHasLoadedTasks(true);
      setTasksLoadError((current) => (
        current?.requestId === requestId ? null : current
      ));
    } catch (error) {
      if ((error as Error).name !== "AbortError" && requestId === tasksRequestRef.current) {
        setTasksLoadError({ source: "tasks", requestId, message: errorMessage(error) });
      }
    } finally {
      if (!options.quiet && requestId === tasksRequestRef.current) setTasksLoading(false);
    }
  }, [refreshProjectOrderMode]);

  useEffect(() => {
    if (!taskScopeProjectId) {
      setTasks([]);
      setArchivedTasks([]);
      setHasLoadedTasks(false);
      return;
    }
    setHasLoadedTasks(false);
    const controller = new AbortController();
    void refreshTasks(taskScopeProjectId, { signal: controller.signal });
    return () => controller.abort();
  }, [refreshTasks, taskScopeProjectId]);

  useEffect(() => {
    const isAllProjectTaskScope = taskScopeProjectId === ALL_PROJECTS_ID;
    if ((!isJiraProject && !(isAllProjectTaskScope && jiraConnection?.configured)) || !taskScopeProjectId) return;
    const timer = window.setInterval(() => {
      void refreshTasks(taskScopeProjectId, { quiet: true });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [isJiraProject, jiraConnection?.configured, refreshTasks, taskScopeProjectId]);

  useEffect(() => {
    const standalone = !embedded || window.parent === window;
    const developmentProjectId = isAllProjects
      ? developmentEditorProjectId ?? (standalone ? contextMenuTask?.projectId : null)
      : selectedProjectId;
    if (!developmentProjectId) {
      setDevelopmentScan({ workspacePath: null, contexts: [] });
      setDevelopmentScanLoading(false);
      return;
    }
    const controller = new AbortController();
    const codexProjectId = developmentProjectId === GLOBAL_PROJECT_ID
      ? hostContext?.projectId
      : developmentProjectId;
    const codexThreadId = hostContext?.threadId
      ?? (isAllProjects ? contextMenuTask?.threadId : detailTask?.threadId)
      ?? undefined;
    const workspacePath = isAllProjects
      ? developmentEditorProjectId
        ? deviceWorkspacePaths[developmentEditorProjectId]
        : contextMenuWorkspacePath
      : selectedDeviceWorkspacePath;
    setDevelopmentScan({ workspacePath: workspacePath ?? null, contexts: [] });
    setDevelopmentScanLoading(true);
    void listDevelopmentContexts(
      developmentProjectId,
      codexProjectId,
      codexThreadId,
      controller.signal,
      workspacePath,
    )
      .then((scan) => {
        setDevelopmentScan(scan);
        if (scan.workspacePath) rememberDeviceWorkspacePath(developmentProjectId, scan.workspacePath);
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") {
          setDevelopmentScan({ workspacePath: workspacePath ?? null, contexts: [] });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setDevelopmentScanLoading(false);
      });
    return () => controller.abort();
  }, [
    contextMenuTask?.projectId,
    contextMenuTask?.threadId,
    contextMenuWorkspacePath,
    detailTask?.threadId,
    deviceWorkspacePaths,
    developmentEditorProjectId,
    embedded,
    hostContext?.projectId,
    hostContext?.threadId,
    isAllProjects,
    rememberDeviceWorkspacePath,
    selectedProjectId,
    selectedDeviceWorkspacePath,
  ]);

  const invalidateCloudData = useCallback(() => {
    void refreshProjectList();
    void refreshProjectBoardDisplaySettings();
    const projectId = taskScopeProjectIdRef.current;
    if (projectId) {
      void refreshTasks(projectId, { quiet: true });
    }
    setReadmeRevision((current) => current + 1);
    setCommentsRevision((current) => current + 1);
    setAttachmentsRevision((current) => current + 1);
  }, [refreshProjectList, refreshProjectBoardDisplaySettings, refreshTasks]);

  useEffect(() => {
    if (revisionPollingInterval === null) return;
    const controller = new AbortController();
    setConnection("connecting");
    const poller = createRevisionPoller({
      intervalMs: revisionPollingInterval,
      fetchRevision: async (since: number) => {
        try {
          const result = await getTaskboardRevision(since, controller.signal);
          setConnection("live");
          return result;
        } catch (error) {
          if (!controller.signal.aborted) setConnection("reconnecting");
          throw error;
        }
      },
      onInvalidate: invalidateCloudData,
    });
    poller.start();
    return () => {
      controller.abort();
      poller.stop();
    };
  }, [
    revisionPollingInterval,
    invalidateCloudData,
  ]);

  useEffect(() => {
    if (revisionWebSocketEndpoint === null) return;
    const controller = new AbortController();
    const client = createRevisionWebSocketClient({
      url: resolveTaskboardWebSocketUrl(revisionWebSocketEndpoint),
      fetchRevision: (since: number) => getTaskboardRevision(since, controller.signal),
      onInvalidate: invalidateCloudData,
      onConnectionChange: setConnection,
    });
    client.start();
    return () => {
      controller.abort();
      client.stop();
    };
  }, [
    invalidateCloudData,
    revisionWebSocketEndpoint,
  ]);

  function pushUndo(message: string | null, undo: () => Promise<void>) {
    const operation = { id: ++undoSequenceRef.current, undo };
    undoStackRef.current = [...undoStackRef.current.slice(-19), operation];
    if (!message) return;
    setAnnouncementValue("");
    setUndoNotice({ id: operation.id, message });
  }

  async function performUndo() {
    if (undoInFlightRef.current) return;
    const operation = undoStackRef.current.at(-1);
    if (!operation) return;
    undoStackRef.current = undoStackRef.current.slice(0, -1);
    undoInFlightRef.current = true;
    setUndoNotice(null);
    setProjectMenuOpen(false);
    closeContextMenu();
    setActionError(null);
    try {
      await operation.undo();
    } catch (error) {
      setActionError(text(
        `无法撤回这次操作：${errorMessage(error)}`,
        `Could not undo this action: ${errorMessage(error)}`,
        `無法復原這次操作：${errorMessage(error)}`,
      ));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
    } finally {
      undoInFlightRef.current = false;
    }
  }

  async function restoreTaskDetails(
    snapshot: Task,
    changed: Task,
    assigneeTarget = assigneeTargetForActor(snapshot.assignee, currentUser),
  ) {
    const candidate = tasksRef.current.find((task) => task.id === changed.id);
    const current = candidate && candidate.version >= changed.version ? candidate : changed;
    // DBG-08: restore the other fields, but going back to in_progress goes through the continue flow.
    const requestedAssignee = assigneeTarget ? actorForAssigneeTarget(assigneeTarget, currentUser) : undefined;
    const flow = continueFlowFor(current, snapshot.status, { requestedAssignee });
    const needsContinue = flow !== null;
    const result = await guardedStatusMove({
      task: current,
      destination: needsContinue ? current.status : snapshot.status,
      requestedAssignee,
      move: () => updateTaskRequest(current, {
        ...taskToDraft(snapshot),
        ...(needsContinue ? { status: current.status } : {}),
        ...(assigneeTarget ? { assigneeTarget } : {}),
      }),
      openContinue: (_reason, refusal) => openContinueFlow(current, refusal),
    });
    if (flow) openContinueFlow(current, flow);
    if (result.kind !== "moved") return;
    const restored = result.value;
    setTasks((tasks) => sortTasks(tasks.map((task) => task.id === restored.id ? restored : task)));
  }

  // DBG-08: open the card's detail page with the continue composer focused (message required → continueTask),
  // or, when the last run never reached an AI session, with the rework composer (comment + 退回重做).
  function openContinueFlow(task: Task, flow: ContinueFlowKind = "continue") {
    clearTaskDragState();
    continueRequestSequenceRef.current += 1;
    setContinueRequest({ taskId: task.id, sequence: continueRequestSequenceRef.current, flow });
    // Undo closures can be older than the current render, so read the open issue from the URL.
    if (readIssueIdentifier(window.location.search) !== task.identifier) openTaskDetail(task);
  }

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.matches("input, textarea, select, [contenteditable='true']");
      if (
        event.key.toLowerCase() === "z"
        && (event.metaKey || event.ctrlKey)
        && !event.shiftKey
        && !isTyping
        && !editor
      ) {
        event.preventDefault();
        void performUndo();
        return;
      }
      if (isTyping || contextMenu || projectMenuOpen) return;
      if (
        event.key.toLowerCase() === "c"
        && !event.metaKey
        && !event.ctrlKey
        && selectedProjectId
        && !isJiraProject
      ) {
        event.preventDefault();
        openNewTaskRef.current("todo");
      }
      if (
        event.key === "/"
        && !detailTaskId
        && selectedProjectId
        && (boardView === "issues" || boardView === "list" || boardView === "gantt")
      ) {
        event.preventDefault();
        document.getElementById("task-search")?.focus();
      }
      if (event.key === "Escape" && detailTaskId) {
        closeTaskDetail();
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [boardView, contextMenu, detailTaskId, editor, isJiraProject, projectMenuOpen, selectedProjectId]);

  const filteredTasks = useMemo(() => {
    return tasks.filter(
      (task) => matchesTaskSearch(task, search, language) && matchesTaskFilters(task, filters),
    );
  }, [filters, language, search, tasks]);

  const filteredArchivedTasks = useMemo(() => archivedTasks.filter(
    (task) => matchesTaskSearch(task, search, language) && matchesTaskFilters(task, filters),
  ), [archivedTasks, filters, language, search]);

  const activeFilterCount = taskFilterCount(filters);
  const hasActiveTaskFilters = Boolean(search.trim()) || activeFilterCount > 0;

  const trackedCodexThreadIds = useMemo(() => [...new Set(tasks
    .filter((task) => task.status === "in_progress" && task.threadId)
    .map((task) => normalizeCodexThreadId(task.threadId))
    .filter(Boolean))].sort(), [tasks]);
  const trackedCodexThreadIdsKey = trackedCodexThreadIds.join(",");

  useEffect(() => {
    if (trackedCodexThreadIds.length === 0) {
      setCodexThreadProgress({});
      return;
    }
    let disposed = false;
    const sync = async () => {
      try {
        const progress = await getCodexThreadProgress(trackedCodexThreadIds);
        if (!disposed) {
          setCodexThreadProgress((current) => (
            JSON.stringify(current) === JSON.stringify(progress) ? current : progress
          ));
        }
      } catch {}
    };
    void sync();
    const timer = window.setInterval(sync, 2_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [trackedCodexThreadIdsKey]);

  // The todo column follows the project's order mode (suggested by default); in "All projects" the
  // per-project manual orders cannot be merged, so that view always shows the suggested order.
  const displayOrderMode = isAllProjects ? "suggested" : projectOrderModes[selectedProjectId] ?? "suggested";
  const tasksByStatus = useMemo(() => {
    const grouped = Object.fromEntries(
      TASK_STATUSES.map((status) => [status, filteredTasks.filter((task) => task.status === status)]),
    ) as Record<TaskStatus, Task[]>;
    grouped.todo = orderTasks(grouped.todo, displayOrderMode);
    return grouped;
  }, [displayOrderMode, filteredTasks]);
  // Phones (≤719px) only get the vertical board (T6); detail and empty-project pages still come first.
  const isMobileBoard = useMobileBoardViewport();
  // Amendment 13: the first time the board opens on this PC with no paired phone, offer the phone wizard
  // (「稍後」 / 「完成」 remember the choice). It never turns mobile access on by itself.
  // Amendment 15: the header phone button shows the paired phones; a paired, non-revoked phone (permanent pairing
  // included) never auto-opens the wizard.
  const pairedPhones = usePairedPhones(servedFromThisPc && !isMobileBoard);
  const refreshPairedPhones = pairedPhones.refresh;
  const phoneWizardChecked = useRef(false);
  useEffect(() => {
    if (!servedFromThisPc || isMobileBoard || phoneWizardChecked.current) return;
    phoneWizardChecked.current = true;
    let cancelled = false;
    void refreshPairedPhones().then((phones) => {
      // null: no mobile access backend (or not reachable) — no wizard.
      if (cancelled || phones === null || phones.length > 0) return;
      if (taskboardStorage.getItem(PHONE_WIZARD_DISMISSED_KEY) === "1") return;
      setPhoneWizardOpen(true);
    });
    return () => {
      cancelled = true;
    };
  }, [servedFromThisPc, isMobileBoard, refreshPairedPhones]);
  const orderedFilteredTasks = useMemo(() => [
    ...filteredTasks.filter((task) => task.status !== "todo"),
    ...tasksByStatus.todo,
  ], [filteredTasks, tasksByStatus]);

  const mainBoardItems = boardDisplaySettings.mainStatuses.filter(
    (status) => status !== "blocked"
      || !hasLoadedTasks
      || tasks.some((task) => task.status === "blocked"),
  );
  const mainColumnCount = Math.max(mainBoardItems.length, 1);
  // W12-B: board widths are in rem (16px-based numbers / 16) so columns grow with 文字大小.
  const mainBoardMinWidth = ((mainColumnCount * 300) + ((mainColumnCount - 1) * 24)) / 16;
  const mainBoardMaxWidth = ((mainColumnCount * 400) + ((mainColumnCount - 1) * 24)) / 16;
  const otherTasksColumnCount = mainColumnCount + 1;
  const otherTasksWidth = `clamp(18.75rem, calc(${100 / otherTasksColumnCount}% - ${(36 + (mainColumnCount * 24)) / otherTasksColumnCount / 16}rem), 25rem)`;
  const otherTaskTabs = boardDisplaySettings.sidebarStatuses;
  const otherTaskTabsKey = otherTaskTabs.join(",");
  const otherTasksAvailable = otherTaskTabs.length > 0;

  useEffect(() => {
    if (!otherTasksAvailable) {
      setOtherTasksOpen(false);
      return;
    }
    if (otherTaskTabs.includes(otherTasksTab)) return;
    setOtherTasksTab(otherTaskTabs[0]);
  }, [otherTaskTabsKey, otherTasksAvailable, otherTasksTab]);

  const aiThreadsByTask = useMemo(() => indexAiThreadsByTask(aiThreads), [aiThreads]);
  const taskPresentations = useMemo(() => Object.fromEntries(tasks.map((task) => {
    const storageKey = issueReadStorageKey(issueReadMode, task);
    const readActivityKey = readActivityKeys[storageKey] ?? taskboardStorage.getItem(storageKey);
    const unread = (task.status === "in_review" || task.status === "blocked")
      && readActivityKey !== task.activityKey;
    const runningNativeThreadId = hostContext?.threadRunning
      ? hostContext.threadId ?? null
      : null;
    const taskThreadId = normalizeCodexThreadId(task.threadId);
    return [task.id, taskCardPresentation(
      task,
      aiThreadsByTask.get(task.id) ?? [],
      unread,
      runningNativeThreadId,
      hostContext?.threadTodoProgress ?? null,
      taskThreadId ? codexThreadProgress[taskThreadId] ?? null : undefined,
    )];
  })) as Record<string, TaskCardPresentation>, [
    aiThreadsByTask,
    codexThreadProgress,
    hostContext?.threadId,
    hostContext?.threadRunning,
    hostContext?.threadTodoProgress,
    issueReadMode,
    readActivityKeys,
    tasks,
  ]);

  function selectBoardView(view: BoardView) {
    closeContextMenu();
    setGanttViewMenuOpen(false);
    setBoardView(view);
    if (selectedProjectId) {
      taskboardStorage.setItem(`${PROJECT_VIEW_KEY_PREFIX}${selectedProjectId}`, view);
    }
  }

  function updateProjectBoardDisplaySettings(value: BoardDisplaySettings) {
    setProjectBoardDisplaySettings((current) => {
      const next = { ...current, [selectedProjectId]: value };
      taskboardStorage.setItem(
        `${PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX}${selectedProjectId}`,
        JSON.stringify(value),
      );
      return next;
    });
  }

  function resetProjectBoardDisplaySettings() {
    setProjectBoardDisplaySettings((current) => {
      const next = { ...current };
      delete next[selectedProjectId];
      taskboardStorage.removeItem(
        `${PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX}${selectedProjectId}`,
      );
      return next;
    });
  }

  async function saveEditor(
    draft: TaskDraft,
    inlineFiles: PendingInlineAttachment[],
    inlineImages: PendingInlineImage[],
    createOptions?: NewTaskCreateOptions,
  ) {
    if (!selectedProjectId || !editor) return;
    const targetProjectId = editorProjectId ?? selectedProjectId;
    setActionError(null);
    let saved = await createTaskRequest(targetProjectId, draft);
    setProjects((current) => current.map((project) => (
      project.id === targetProjectId
        ? { ...project, issueCount: project.issueCount + 1 }
        : project
    )));
    let postCreateWriteFailed = false;
    if (inlineFiles.length > 0 || inlineImages.length > 0) {
      const [fileResults, inlineResults] = await Promise.all([
          Promise.allSettled(
            inlineFiles.map((file) => uploadAttachment(saved.id, file.file, "attachment")),
          ),
          Promise.allSettled(
            inlineImages.map((image) => uploadAttachment(saved.id, image.file, "inline")),
          ),
      ]);
      const fileAttachments = fileResults.flatMap((result) => (
        result.status === "fulfilled" ? [result.value] : []
      ));
      const inlineAttachments = inlineResults.flatMap((result) => (
        result.status === "fulfilled" ? [result.value] : []
      ));
      if (
        fileAttachments.length !== inlineFiles.length
        || inlineAttachments.length !== inlineImages.length
      ) {
        postCreateWriteFailed = true;
      } else if (inlineFiles.length > 0 || inlineImages.length > 0) {
        try {
          const description = resolveInlineAttachments(
            draft.description,
            [...inlineImages, ...inlineFiles],
            [...inlineAttachments, ...fileAttachments],
          );
          saved = await updateTaskRequest(saved, { ...draft, description });
        } catch {
          postCreateWriteFailed = true;
        }
      }
    }
    const relationUpdates = new Map<string, Task>();
    const movedSubIssues: Array<{ task: Task; previousParentId: string | null }> = [];
    let addedParentId: string | null = null;
    const addedRelatedIds: string[] = [];
    let relationWriteFailed = false;
    if (createOptions) {
      const { parentId, relatedIds, subIssueIds } = createOptions.relations;
      try {
        if (parentId) {
          const result = await addTaskRelation(saved, "parent", parentId);
          saved = result.task;
          addedParentId = parentId;
          relationUpdates.set(result.relatedTask.id, result.relatedTask);
        }
        for (const relatedId of relatedIds) {
          const result = await addTaskRelation(saved, "related", relatedId);
          saved = result.task;
          addedRelatedIds.push(relatedId);
          relationUpdates.set(result.relatedTask.id, result.relatedTask);
        }
        for (const subIssueId of subIssueIds) {
          const child = relationUpdates.get(subIssueId)
            ?? tasksRef.current.find((candidate) => candidate.id === subIssueId)!;
          const previousParentId = child.relations.parent?.id ?? null;
          const result = await addTaskRelation(child, "parent", saved.id);
          movedSubIssues.push({ task: result.task, previousParentId });
          relationUpdates.set(result.task.id, result.task);
          saved = result.relatedTask;
        }
      } catch {
        relationWriteFailed = true;
      }
    }
    relationUpdates.set(saved.id, saved);
    setTasks((current) => sortTasks([
      ...current.filter((task) => !relationUpdates.has(task.id)),
      ...relationUpdates.values(),
    ]));
    setNewTaskDraft(null);
    const failedWrites = [
      ...(relationWriteFailed ? [{ zh: "关系", en: "relations", tw: "關係" }] : []),
      ...(postCreateWriteFailed ? [{ zh: "正文或媒体", en: "description or media", tw: "正文或媒體" }] : []),
    ];
    if (!createOptions?.keepOpen || failedWrites.length > 0) setEditor(null);
    if (failedWrites.length > 0) {
      setActionError(text(
        `${saved.identifier} 已创建，但以下内容写入失败：${failedWrites.map((failure) => failure.zh).join("、")}。`,
        `${saved.identifier} was created, but these follow-up writes failed: ${failedWrites.map((failure) => failure.en).join(", ")}.`,
        `${saved.identifier} 已建立，但以下內容寫入失敗：${failedWrites.map((failure) => failure.tw).join("、")}。`,
      ));
    }
    pushUndo(null, async () => {
      const restoredRelations = new Map<string, Task>();
      const candidate = tasksRef.current.find((task) => task.id === saved.id);
      let current = candidate && candidate.version >= saved.version ? candidate : saved;
      if (addedParentId) {
        const result = await removeTaskRelation(current, "parent", addedParentId);
        current = result.task;
        restoredRelations.set(result.relatedTask.id, result.relatedTask);
      }
      for (const relatedId of [...addedRelatedIds].reverse()) {
        const result = await removeTaskRelation(current, "related", relatedId);
        current = result.task;
        restoredRelations.set(result.relatedTask.id, result.relatedTask);
      }
      for (const movedSubIssue of [...movedSubIssues].reverse()) {
        const latestChild = tasksRef.current.find((task) => task.id === movedSubIssue.task.id);
        const child = latestChild && latestChild.version >= movedSubIssue.task.version
          ? latestChild
          : movedSubIssue.task;
        const removed = await removeTaskRelation(child, "parent", saved.id);
        restoredRelations.set(removed.task.id, removed.task);
        current = removed.relatedTask;
        if (movedSubIssue.previousParentId) {
          const restored = await addTaskRelation(
            removed.task,
            "parent",
            movedSubIssue.previousParentId,
          );
          restoredRelations.set(restored.task.id, restored.task);
          restoredRelations.set(restored.relatedTask.id, restored.relatedTask);
        }
      }
      await archiveTaskRequest(current);
      setTasks((tasks) => sortTasks([
        ...tasks.filter((task) => task.id !== saved.id && !restoredRelations.has(task.id)),
        ...[...restoredRelations.values()].filter((task) => task.id !== saved.id),
      ]));
    });
  }

  function displayOrderModeFor(projectId: string): ProjectOrderMode {
    return isAllProjects ? "suggested" : projectOrderModes[projectId] ?? "suggested";
  }

  function clearTaskDragState() {
    setDropTarget(null);
    setDraggedTaskId(null);
    setDraggedTaskHeight(0);
  }

  // Dragging inside todo while the project shows the suggested order: the server switches the project to
  // manual (CONTRACTS C6), so first write the order the user sees (renumbered sortOrder) and then the drop,
  // otherwise the column would jump to the stale sortOrder order.
  async function reorderSuggestedTodo(task: Task, beforeTaskId: string | null) {
    const projectId = task.projectId;
    const plan = planSuggestedTodoReorder(
      tasks.filter((candidate) => candidate.projectId === projectId && candidate.status === "todo"),
      task,
      beforeTaskId,
    );
    if (!plan) {
      clearTaskDragState();
      return;
    }
    const { sortOrders, writes } = plan;
    let completedWrites = 0;
    setActionError(null);
    setMovingTaskId(task.id);
    setProjectOrderModes((current) => ({ ...current, [projectId]: "manual" }));
    setTasks((current) => sortTasks(current.map((candidate) => (
      sortOrders.has(candidate.id) ? { ...candidate, sortOrder: sortOrders.get(candidate.id)! } : candidate
    ))));
    try {
      for (const write of writes) {
        const latest = tasksRef.current.find((candidate) => candidate.id === write.id);
        const current = latest && latest.version >= write.version ? latest : write;
        const moved = await moveTaskRequest(current, "todo", sortOrders.get(write.id));
        setTasks((tasks) => sortTasks(tasks.map((item) => item.id === moved.id ? moved : item)));
        completedWrites += 1;
      }
      pushUndo(null, async () => {
        const automation = await resetProjectOrder(projectId);
        setProjectOrderModes((current) => ({ ...current, [projectId]: automation.orderMode }));
        if (taskScopeProjectIdRef.current) await refreshTasks(taskScopeProjectIdRef.current, { quiet: true });
      });
    } catch (error) {
      const failure = error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? textRef.current(
          "該議題已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
          "該任務已在其他位置更新，看板已重新同步。",
        )
        : errorMessage(error);
      // A write already landed: the project is manual now with a partly renumbered order.
      setActionError(completedWrites > 0
        ? `${failure} ${textRef.current(
          "排序只套用了一部分，專案已改為手動排序；可按待辦欄的「恢復建議排序」復原。",
          "The order was only partly applied and the project is now manual. Use \"Restore suggested order\" on the todo column to undo.",
        )}`
        : failure);
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
    } finally {
      setMovingTaskId(null);
      clearTaskDragState();
    }
  }

  async function moveTask(
    task: Task,
    status: TaskStatus,
    beforeTaskId: string | null = null,
    useDropPosition = false,
  ) {
    if (movingTaskId) {
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
      return;
    }

    // DBG-08: in_review/blocked AI card → in_progress continues the AI with a message, never a plain move.
    const continueFlow = continueFlowFor(task, status);
    if (continueFlow) {
      clearTaskDragState();
      openContinueFlow(task, continueFlow);
      return;
    }

    // All projects shows todo in suggested order across projects, while each project keeps its own
    // order mode on the server. A same-column drop here cannot be expressed as one project's order, and
    // any write would switch that project to manual (CONTRACTS C6) and change the scheduler claim order
    // without a visible change. So reordering inside todo is not supported in All projects.
    if (blocksAllProjectsTodoReorder(isAllProjects, task.status, status)) {
      clearTaskDragState();
      // Only explain when the drop would actually have changed the shown order.
      const shownTodo = orderTasks(filteredTasks.filter((candidate) => candidate.status === "todo"), "suggested");
      const landed = shownTodo.filter((candidate) => candidate.id !== task.id);
      const landedIndex = beforeTaskId ? landed.findIndex((candidate) => candidate.id === beforeTaskId) : -1;
      landed.splice(landedIndex < 0 ? landed.length : landedIndex, 0, task);
      if (!useDropPosition || landed.every((candidate, index) => candidate.id === shownTodo[index]?.id)) return;
      setActionError(textRef.current(
        "「全部專案」檢視不能調整待辦順序，請切到該專案再拖曳。",
        "Todo order can't be changed in All projects. Open the project to reorder.",
      ));
      return;
    }

    if (
      useDropPosition
      && task.status === status
      && status === "todo"
      && !isAllProjects
      && displayOrderModeFor(task.projectId) === "suggested"
    ) {
      await reorderSuggestedTodo(task, beforeTaskId);
      return;
    }

    // The todo column is displayed in the project's order mode, so drop neighbours come from that order.
    const statusTasks = tasks.filter((candidate) => (
      candidate.projectId === task.projectId && candidate.status === status
    ));
    const shownStatusTasks = status === "todo"
      ? orderTasks(statusTasks, displayOrderModeFor(task.projectId))
      : statusTasks;
    const destination = shownStatusTasks.filter((candidate) => candidate.id !== task.id);
    const statusChanged = task.status !== status;
    const insertionIndex = statusChanged && !useDropPosition
      ? 0
      : beforeTaskId
        ? destination.findIndex((candidate) => candidate.id === beforeTaskId)
        : destination.length;
    const targetIndex = insertionIndex < 0 ? destination.length : insertionIndex;
    const desiredOrder = [...destination];
    desiredOrder.splice(targetIndex, 0, task);
    const currentOrder = shownStatusTasks;
    if (
      task.status === status
      && currentOrder.length === desiredOrder.length
      && currentOrder.every((candidate, index) => candidate.id === desiredOrder[index].id)
    ) {
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
      return;
    }
    const previousTask = destination[targetIndex - 1] ?? null;
    const nextTask = destination[targetIndex] ?? null;
    const sortOrder = previousTask && nextTask
      ? (previousTask.sortOrder + nextTask.sortOrder) / 2
      : previousTask
        ? previousTask.sortOrder + 1024
        : nextTask
          ? nextTask.sortOrder - 1024
          : 1024;
    const previous = task;
    setActionError(null);
    setMovingTaskId(task.id);
    setTasks((current) => sortTasks(current.map((candidate) =>
      candidate.id === task.id ? { ...candidate, status, sortOrder } : candidate,
    )));

    try {
      const moved = await moveTaskRequest(task, status, sortOrder);
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === moved.id ? moved : candidate,
      )));
      if (status === "todo" && previous.status === "todo") void refreshProjectOrderMode(task.projectId);
      pushUndo(null, async () => {
        const candidate = tasksRef.current.find((current) => current.id === moved.id);
        const current = candidate && candidate.version >= moved.version ? candidate : moved;
        // DBG-08: undoing back to in_progress (e.g. after the run moved the card on) needs the continue flow.
        const result = await guardedStatusMove({
          task: current,
          destination: previous.status,
          move: () => moveTaskRequest(current, previous.status, previous.sortOrder),
          openContinue: (_reason, flow) => openContinueFlow(current, flow),
        });
        if (result.kind !== "moved") return;
        const restored = result.value;
        setTasks((tasks) => sortTasks(tasks.map((item) => item.id === restored.id ? restored : item)));
      });
    } catch (error) {
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === previous.id ? previous : candidate,
      )));
      const refusal = continueFlowForError(error);
      if (refusal) openContinueFlow(previous, refusal);
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? textRef.current(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : errorMessage(error));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
    } finally {
      setMovingTaskId(null);
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
    }
  }

  // v2: replace a card with the server's copy (run start/stop, rework, continue, run.updated).
  function mergeTaskFromServer(next: Task) {
    setTasks((current) => current.some((candidate) => candidate.id === next.id)
      ? sortTasks(current.map((candidate) => (
        candidate.id === next.id && candidate.version <= next.version ? next : candidate
      )))
      : current);
  }

  async function startTaskRun(task: Task) {
    setActionError(null);
    try {
      const result = await startTaskRunRequest(task.id);
      mergeTaskFromServer(result.task);
      if (result.run.status === "failed") {
        setActionError(result.run.error
          ? text(`開工失敗：${result.run.error}`, `Could not start: ${result.run.error}`)
          : text("開工失敗。", "Could not start."));
      }
    } catch (error) {
      setActionError(errorMessage(error));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
    }
  }

  // Card 「停止」: interrupt the AI and put the card back to 待立項 (BLUEPRINT 4.2 in_progress → backlog).
  async function stopTaskRun(task: Task) {
    setActionError(null);
    try {
      const result = await stopTaskRunRequest(task.id, "backlog");
      mergeTaskFromServer(result.task);
    } catch (error) {
      setActionError(errorMessage(error));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
    }
  }

  function openRunUrl(url: string) {
    // E1: shared with TaskRunPanel; embedded boards use the host bridge instead of navigating the frame.
    const result = openRunAppUrl(url, { embedded: embedded && window.parent !== window });
    if (result === "unsupported-embedded") {
      setActionError(text(RUN_APP_LINK_EMBEDDED_TEXT[0], RUN_APP_LINK_EMBEDDED_TEXT[1]));
    }
  }

  async function openTaskRunInApp(task: Task) {
    setActionError(null);
    try {
      const { runs } = await listTaskRuns(task.id);
      const targetRunId = (task.activeRun ?? task.latestRun)?.id;
      // Amendment 3 + W3 note: an active Codex run is not opened in the Codex App, and the board does
      // not fall back to an older run of that card while it is active.
      const target = pickTaskRunAppUrl(runs, targetRunId);
      if (target && "blocked" in target) {
        setActionError(text(CODEX_RUN_ACTIVE_APP_TEXT, "The task is running; open it in the Codex App after it finishes."));
        return;
      }
      if (!target) {
        setActionError(text("這次 AI 執行沒有可開啟的 App 連結。", "This AI run has no app link to open."));
        return;
      }
      openRunUrl(target.url);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  // Todo column header 「恢復建議排序」 (BLUEPRINT 4.4): back to suggested order, then reload the board.
  async function resetTodoOrder() {
    if (!selectedProject || isAllProjects) return;
    const projectId = selectedProject.id;
    setActionError(null);
    try {
      const automation = await resetProjectOrder(projectId);
      setProjectOrderModes((current) => ({ ...current, [projectId]: automation.orderMode }));
      if (taskScopeProjectId) await refreshTasks(taskScopeProjectId, { quiet: true });
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  function startTaskDrag(task: Task, height: number) {
    setDraggedTaskId(task.id);
    setDraggedTaskHeight(height);
    setDropTarget(task.status);
  }

  function endTaskDrag() {
    setDraggedTaskId(null);
    setDraggedTaskHeight(0);
    setDropTarget(null);
  }

  function finishTaskDrop(destination: TaskStatus, taskId: string, beforeTaskId: string | null = null) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    setDraggedTaskId(null);
    setDraggedTaskHeight(0);
    setDropTarget(null);
    if (!task) return;
    setSettlingTaskId(task.id);
    window.setTimeout(() => {
      setSettlingTaskId((current) => current === task.id ? null : current);
    }, 220);
    void moveTask(task, destination, beforeTaskId, true);
  }

  async function updateTaskProperties(task: Task, changes: Partial<TaskDraft>): Promise<Task> {
    const previous = task;
    // DBG-08: detail/list status pickers — in_review/blocked AI card → in_progress needs the continue flow.
    const continueFlow = changes.status
      ? continueFlowFor(task, changes.status, {
        requestedAssignee: changes.assigneeTarget ? actorForAssigneeTarget(changes.assigneeTarget, currentUser) : undefined,
      })
      : null;
    if (continueFlow) {
      openContinueFlow(task, continueFlow);
      return task;
    }
    const { assigneeTarget, ...taskChanges } = changes;
    const optimisticAssignee = assigneeTarget
      ? actorForAssigneeTarget(assigneeTarget, currentUser)
      : task.assignee;
    const optimisticParticipants = assigneeTarget
      && !task.participants.some((participant) => actorKey(participant) === actorKey(optimisticAssignee))
      ? [...task.participants, optimisticAssignee]
      : task.participants;
    setActionError(null);
    setTasks((current) => current.map((candidate) =>
      candidate.id === task.id
        ? { ...candidate, ...taskChanges, assignee: optimisticAssignee, participants: optimisticParticipants }
        : candidate,
    ));

    try {
      const updated = await updateTaskRequest(task, { ...taskToDraft(task), ...changes });
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      )));
      const previousAssigneeTarget = assigneeTargetForActor(previous.assignee, currentUser);
      if (!assigneeTarget || previousAssigneeTarget) {
        pushUndo(
          null,
          () => restoreTaskDetails(previous, updated, previousAssigneeTarget),
        );
      }
      return updated;
    } catch (error) {
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === previous.id ? previous : candidate,
      )));
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? text(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : errorMessage(error));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
      const refusal = continueFlowForError(error);
      if (refusal) {
        openContinueFlow(previous, refusal);
        return previous;
      }
      throw error;
    }
  }

  async function persistProjectLabel(label: string, projectId = selectedProjectId) {
    setActionError(null);
    try {
      const project = await createProjectLabelRequest(projectId, label);
      setProjects((current) => current.map((candidate) => (
        candidate.id === project.id ? project : candidate
      )));
    } catch (error) {
      setActionError(errorMessage(error));
      throw error;
    }
  }

  async function removeProjectLabel(label: string) {
    setActionError(null);
    try {
      const project = await deleteProjectLabelRequest(selectedProjectId, label);
      setProjects((current) => current.map((candidate) => (
        candidate.id === project.id ? project : candidate
      )));
      await refreshTasks(taskScopeProjectId, { quiet: true });
    } catch (error) {
      setActionError(errorMessage(error));
      throw error;
    }
  }

  async function mutateTaskRelation(
    action: "add" | "remove",
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
    origin?: IssueRelationOrigin,
  ) {
    setActionError(null);
    try {
      const result = action === "add"
        ? await addTaskRelation(task, type, relatedTaskId, undefined, origin)
        : await removeTaskRelation(task, type, relatedTaskId, undefined, origin);
      setTasks((current) => sortTasks(current.map((candidate) => {
        if (candidate.id === result.task.id) return result.task;
        if (candidate.id === result.relatedTask.id) return result.relatedTask;
        return candidate;
      })));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
      return result;
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? text(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : errorMessage(error));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
      throw error;
    }
  }

  async function duplicateTask(task: Task) {
    setActionError(null);
    try {
      const duplicated = await createTaskRequest(task.projectId, {
        ...taskToDraft(task),
        assigneeTarget: assigneeTargetForActor(task.assignee, currentUser),
        developmentContext: null,
      });
      setTasks((current) => sortTasks([...current, duplicated]));
      pushUndo(text(
        `${duplicated.identifier} 副本已创建。`,
        `${duplicated.identifier} copy was created.`,
        `${duplicated.identifier} 副本已建立。`,
      ), async () => {
        const candidate = tasksRef.current.find((current) => current.id === duplicated.id);
        const current = candidate && candidate.version >= duplicated.version ? candidate : duplicated;
        await archiveTaskRequest(current);
        setTasks((tasks) => tasks.filter((item) => item.id !== duplicated.id));
      });
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function archiveTask(task: Task) {
    setActionError(null);
    try {
      const archived = await archiveTaskRequest(task);
      setTasks((current) => current.filter((candidate) => candidate.id !== task.id));
      setArchivedTasks((current) => sortTasks([
        ...current.filter((candidate) => candidate.id !== archived.id),
        archived,
      ]));
      pushUndo(text(`${task.identifier} 已归档。`, `${task.identifier} was archived.`, `${task.identifier} 已封存。`), async () => {
        const restored = await restoreTaskRequest(archived);
        setArchivedTasks((current) => current.filter((candidate) => candidate.id !== restored.id));
        setTasks((current) => sortTasks([
          ...current.filter((candidate) => candidate.id !== restored.id),
          restored,
        ]));
      });
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? text(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : errorMessage(error));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
    }
  }

  async function restoreArchivedTask(task: Task) {
    setActionError(null);
    setRestoringTaskId(task.id);
    try {
      const restored = await restoreTaskRequest(task);
      setArchivedTasks((current) => current.filter((candidate) => candidate.id !== restored.id));
      setTasks((current) => sortTasks([
        ...current.filter((candidate) => candidate.id !== restored.id),
        restored,
      ]));
      setAnnouncement(text(
        `${restored.identifier} 已恢复。`,
        `${restored.identifier} was restored.`,
        `${restored.identifier} 已恢復。`,
      ));
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? text(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : errorMessage(error));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
    } finally {
      setRestoringTaskId(null);
    }
  }

  async function deletePendingArchivedTask() {
    if (!pendingArchivedTaskDelete || deletingArchivedTaskId) return;
    const task = pendingArchivedTaskDelete;
    setActionError(null);
    setDeletingArchivedTaskId(task.id);
    try {
      await deleteArchivedTaskRequest(task);
      setArchivedTasks((current) => current.filter((candidate) => candidate.id !== task.id));
      setPendingArchivedTaskDelete(null);
      setAnnouncement(text(
        `${task.identifier} 已永久删除。`,
        `${task.identifier} was permanently deleted.`,
        `${task.identifier} 已永久刪除。`,
      ));
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? text(
          "该议题已在其他位置更新，看板已重新同步。",
          "This issue changed elsewhere. The board has been synced.",
        )
        : errorMessage(error));
      if (taskScopeProjectId) void refreshTasks(taskScopeProjectId, { quiet: true });
    } finally {
      setDeletingArchivedTaskId(null);
    }
  }

  async function copyText(content: string, message: string) {
    try {
      await navigator.clipboard.writeText(content);
      setAnnouncement(message);
    } catch {
      setActionError(text("无法写入剪贴板。", "Could not write to the clipboard."));
    }
  }

  function codexProjectContextForTaskProject(taskboardProjectId: string) {
    if (taskboardProjectId === GLOBAL_PROJECT_ID) return null;
    const taskboardProject = projects.find((project) => project.id === taskboardProjectId);
    const savedIdentity = projectCodexIdentities[taskboardProjectId];
    if (savedIdentity?.codexProjectKind === "remote") {
      const liveProject = hostContext?.projects?.find(
        (project) => project.id === savedIdentity.codexProjectId,
      );
      return liveProject?.projectKind === "remote"
        && liveProject.hostId === savedIdentity.codexHostId
        && liveProject.workspacePath === savedIdentity.workspacePath
        ? savedIdentity
        : null;
    }
    const directCodexProject = hostContext?.projects?.find(
      (project) => project.id === taskboardProjectId,
    );
    const mappedWorkspacePath = deviceWorkspacePaths[taskboardProjectId]
      ?? taskboardProject?.workspacePath
      ?? directCodexProject?.workspacePath;
    const codexProject = directCodexProject ?? hostContext?.projects?.find(
      (project) => project.workspacePath === mappedWorkspacePath,
    );
    if (!codexProject) return null;
    return {
      codexProjectId: codexProject.id,
      codexProjectKind: codexProject.projectKind ?? "local" as const,
      codexHostId: codexProject.hostId ?? "local",
      workspacePath: mappedWorkspacePath ?? codexProject.workspacePath,
    };
  }

  function openThread(binding: CodexThreadBinding) {
    const remoteProject = binding.codexProjectKind === "remote"
      ? hostContext?.projects?.find((project) => (
          project.id === binding.codexProjectId
          && project.projectKind === "remote"
          && project.hostId === binding.codexHostId
          && project.workspacePath === binding.workspacePath
        ))
      : null;
    if (binding.codexProjectKind === "remote" && !remoteProject) {
      setActionError(text(
        "该对话绑定的 SSH 远程项目或主机当前不可用。",
        "The SSH remote project or host bound to this conversation is not available.",
      ));
      return;
    }
    if (embedded && window.parent !== window) {
      postEmbeddedHostMessage({
        type: "taskboard:open-thread",
        payload: binding,
      });
      return;
    }

    if (binding.codexProjectKind === "remote") {
      setActionError(text(
        "请在 Codex App 中打开该 SSH 远程对话。",
        "Open this SSH remote conversation in the Codex app.",
      ));
      return;
    }
    window.location.assign(`codex://threads/${encodeURIComponent(binding.threadId.trim())}`);
  }

  function openLegacyLocalThread(threadId: string) {
    if (embedded && window.parent !== window) {
      postEmbeddedHostMessage({
        type: "taskboard:open-thread",
        payload: { threadId, legacyLocal: true },
      });
      return;
    }
    window.location.assign(`codex://threads/${encodeURIComponent(threadId.trim())}`);
  }

  function openTaskConversation(conversation: TaskConversationItem) {
    if (conversation.kind === "local-ai" && conversation.aiThreadId) {
      aiOpenThreadRequestSequenceRef.current += 1;
      setAiOpenThreadRequest({
        threadId: conversation.aiThreadId!,
        requestId: aiOpenThreadRequestSequenceRef.current,
      });
      return;
    }
    if (conversation.threadBinding) {
      openThread(conversation.threadBinding);
    } else if (conversation.legacyLocalThreadId) {
      openLegacyLocalThread(conversation.legacyLocalThreadId);
    }
  }

  function expandCodexSidebar() {
    if (!embedded || window.parent === window) return;
    postEmbeddedHostMessage({ type: "taskboard:expand-sidebar" });
  }

  function remoteIdentityForTask(
    task: Task,
    baseIdentity: CodexProjectIdentity,
  ): CodexProjectIdentity | null {
    if (task.developmentContext?.type === "worktree") {
      const worktreePath = task.developmentContext.path;
      const matches = (hostContext?.projects ?? []).filter((project) => (
        project.projectKind === "remote"
        && project.hostId === baseIdentity.codexHostId
        && project.workspacePath === worktreePath
      ));
      if (matches.length !== 1) return null;
      return {
        codexProjectId: matches[0].id,
        codexProjectKind: "remote",
        codexHostId: matches[0].hostId!,
        workspacePath: matches[0].workspacePath!,
      };
    }
    const liveProject = hostContext?.projects?.find((project) => (
      project.id === baseIdentity.codexProjectId
      && project.projectKind === "remote"
      && project.hostId === baseIdentity.codexHostId
      && project.workspacePath === baseIdentity.workspacePath
    ));
    return liveProject ? baseIdentity : null;
  }

  async function openTaskInThread(task: Task) {
    const standalone = !embedded || window.parent === window;
    const projectless = task.projectId === GLOBAL_PROJECT_ID;
    const taskboardProject = projects.find((project) => project.id === task.projectId);
    const savedRemoteIdentity = projectCodexIdentities[task.projectId]?.codexProjectKind === "remote"
      ? projectCodexIdentities[task.projectId]
      : null;
    let codexProjectContext = savedRemoteIdentity
      ?? codexProjectContextForTaskProject(task.projectId);
    if (
      projectCodexIdentities[task.projectId]?.codexProjectKind === "remote"
      && !codexProjectContext
    ) {
      setActionError(text(
        "已保存的 SSH 远程项目或主机当前不可用。",
        "The saved SSH remote project or host is not available.",
      ));
      return;
    }
    if (!standalone && codexProjectContext?.codexProjectKind === "remote") {
      const identity = remoteIdentityForTask(task, codexProjectContext);
      if (!identity) {
        setActionError(task.developmentContext?.type === "worktree"
          ? text(
            "目标 SSH worktree 未在保存的主机中添加或映射。",
            "The target SSH worktree is not added or mapped on the saved host.",
          )
          : text(
            "已保存的 SSH 远程项目或主机当前不可用。",
            "The saved SSH remote project or host is not available.",
          ));
        return;
      }
      codexProjectContext = identity;
    }
    let workspacePath = projectless
      ? undefined
      : task.developmentContext?.type === "worktree"
        ? task.developmentContext.path
        : codexProjectContext?.workspacePath
          ?? deviceWorkspacePaths[task.projectId]
          ?? taskboardProject?.workspacePath;
    const embeddedInstruction = text(
      `[$manage-automate-taskboard](${manageTaskboardSkillPath}) 议题 ID：${task.identifier}`,
      `[$manage-automate-taskboard](${manageTaskboardSkillPath}) Issue ID: ${task.identifier}`,
      `[$manage-automate-taskboard](${manageTaskboardSkillPath}) 任務 ID：${task.identifier}`,
    );

    if (
      !projectless
      && task.developmentContext?.type === "worktree"
      && codexProjectContext?.codexProjectKind !== "remote"
    ) {
      const expectedWorktreePath = task.developmentContext.path;
      const baseWorkspacePath = codexProjectContext?.workspacePath
        ?? deviceWorkspacePaths[task.projectId]
        ?? taskboardProject?.workspacePath;
      if (standalone) {
        const worktreeExists = developmentScan.contexts.some((context) => (
          context.type === "worktree" && context.path === expectedWorktreePath
        ));
        if (!worktreeExists) workspacePath = developmentScan.workspacePath ?? baseWorkspacePath;
      } else {
        try {
          const scan = await listDevelopmentContexts(
            task.projectId,
            codexProjectContext?.codexProjectId,
            hostContext?.threadId ?? undefined,
            undefined,
            baseWorkspacePath,
          );
          const worktreeExists = scan.contexts.some((context) => (
            context.type === "worktree" && context.path === expectedWorktreePath
          ));
          if (!worktreeExists) workspacePath = scan.workspacePath ?? baseWorkspacePath;
        } catch (error) {
          setActionError(errorMessage(error));
          return;
        }
      }
    }

    if (codexProjectContext?.codexProjectKind === "remote" && !codexProjectContext.workspacePath) {
      setActionError(text(
        "SSH 远程项目缺少精确工作目录映射。",
        "The SSH remote project is missing its exact workspace mapping.",
      ));
      return;
    }
    if (openingThreadTaskId) return;
    if (standalone) {
      if (codexProjectContext?.codexProjectKind === "remote") {
        setActionError(text(
          "请在 Codex App 中打开该 SSH 远程项目的新对话。",
          "Open the new SSH remote project conversation in the Codex app.",
        ));
        return;
      }
      const deepLink = new URL("codex://threads/new");
      if (workspacePath) deepLink.searchParams.set("path", workspacePath);
      deepLink.searchParams.set("prompt", embeddedInstruction);
      window.location.assign(deepLink.toString());
      return;
    }
    setOpeningThreadTaskId(task.id);
    setActionError(null);
    postEmbeddedHostMessage({
      type: "taskboard:create-thread",
      payload: {
        taskId: task.id,
        identifier: task.identifier,
        title: task.title,
        instruction: embeddedInstruction,
        projectless,
        codexProjectId: codexProjectContext?.codexProjectId,
        codexProjectKind: codexProjectContext?.codexProjectKind ?? "local",
        codexHostId: codexProjectContext?.codexHostId ?? "local",
        codexProjectWorkspacePath: codexProjectContext?.workspacePath,
        workspacePath,
      },
    });
  }

  function changeProject(projectId: string) {
    closeContextMenu();
    setProjectContextMenu(null);
    setProjectMenuOpen(false);
    detailSourceProjectIdRef.current = null;
    setDetailTaskIdentifier(null);
    setBoardView(projectId === ALL_PROJECTS_ID ? "issues" : readProjectBoardView(projectId));
    if (projectId !== ALL_PROJECTS_ID) rememberProjectOpen(projectId);
    setSelectedProjectId(projectId);
    setSearch("");
    setFilters(EMPTY_TASK_FILTERS);
    setActionError(null);
    undoStackRef.current = [];
    setUndoNotice(null);
    const url = buildIssueUrl(window.location.href, projectId, null);
    window.history.replaceState(null, "", url);
  }

  async function selectProject(choice: ProjectChoice) {
    if (openingProjectId) return;
    setOpeningProjectId(choice.id);
    setActionError(null);
    try {
      let project = projects.find((candidate) => candidate.id === choice.id) ?? null;
      if (!project) {
        try {
          project = await createProjectRequest({
            id: choice.id,
            name: choice.name,
            workspacePath: null,
          });
          setProjects((current) => [...current, project!]);
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== "PROJECT_EXISTS") throw error;
          const nextProjects = await listProjects();
          setProjects(nextProjects);
          project = nextProjects.find((candidate) => candidate.id === choice.id) ?? null;
          if (!project) throw error;
        }
      }
      if (choice.codexIdentity) {
        setProjectCodexIdentities((current) => {
          const next = { ...current, [project!.id]: choice.codexIdentity! };
          taskboardStorage.setItem(PROJECT_CODEX_IDENTITIES_KEY, JSON.stringify(next));
          return next;
        });
        rememberDeviceWorkspacePath(project.id, choice.codexIdentity.workspacePath);
      }
      changeProject(project.id);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setOpeningProjectId(null);
    }
  }

  function openJiraDialog() {
    setProjectMenuOpen(false);
    setProjectContextMenu(null);
    setJiraError(null);
    setJiraDialogOpen(true);
  }

  async function saveJiraConnection(input: {
    baseUrl: string;
    username: string;
    password: string;
    projects: string[];
  }) {
    if (jiraSaving) return;
    setJiraSaving(true);
    setJiraError(null);
    try {
      const connection = await configureJiraConnection(input);
      const nextProjects = await listProjects();
      setJiraConnection(connection);
      setProjects(nextProjects);
      setJiraDialogOpen(false);
      changeProject(connection.projectId);
      await refreshTasks(connection.projectId);
      setAnnouncement(text(
        `已同步 ${connection.displayName ?? connection.username} 的 Jira 任务`,
        `Synced Jira issues for ${connection.displayName ?? connection.username}`,
        `已同步 ${connection.displayName ?? connection.username} 的 Jira 任務`,
      ));
    } catch (error) {
      setJiraError(errorMessage(error));
    } finally {
      setJiraSaving(false);
    }
  }

  async function syncJiraNow() {
    if (jiraSyncing || !selectedProjectId) return;
    setJiraSyncing(true);
    setActionError(null);
    try {
      const connection = await syncJiraConnection();
      setJiraConnection(connection);
      await Promise.all([
        refreshTasks(taskScopeProjectId, { quiet: true }),
        refreshProjectList(),
      ]);
      setAnnouncement(text("Jira 任务已同步", "Jira issues synced"));
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setJiraSyncing(false);
    }
  }

  function openCreateProjectDialog(options?: { thenNewTask?: boolean }) {
    setCreateTaskAfterProject(options?.thenNewTask === true);
    setProjectMenuOpen(false);
    setProjectContextMenu(null);
    setProjectName("");
    setProjectFolder("");
    setActionError(null);
    setProjectCreateOpen(true);
  }

  function closeCreateProjectDialog() {
    if (openingProjectId) return;
    setProjectCreateOpen(false);
    setCreateTaskAfterProject(false);
    setActionError(null);
  }

  // W15: the one entry for a new task (header button, key C, column ＋, empty states, start guide).
  function openNewTask(status: TaskStatus = "todo") {
    if (needsProjectBeforeTask) {
      openCreateProjectDialog({ thenNewTask: true });
      return;
    }
    setEditor({ status });
  }
  openNewTaskRef.current = openNewTask;

  function dismissStartGuide() {
    setStartGuideDismissed(true);
    taskboardStorage.setItem(START_GUIDE_DISMISSED_KEY, "true");
  }

  async function createTemporaryProject() {
    if (openingProjectId) return;
    const name = projectName.trim();
    const workspacePath = canSetFolderHere ? projectFolder.trim() : null;
    if (!name || (canSetFolderHere && !workspacePath)) return;
    setActionError(null);
    try {
      // DBG-10: id generation can throw on an http phone origin; keep it inside the try.
      const projectId = `temp-${newClientId()}`;
      setOpeningProjectId(projectId);
      const project = await createProjectRequest({
        id: projectId,
        name,
        workspacePath,
      });
      setProjects((current) => [...current, project]);
      setProjectCreateOpen(false);
      changeProject(project.id);
      if (createTaskAfterProject) {
        setCreateTaskAfterProject(false);
        setEditor({ status: "todo", projectId: project.id });
      }
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setOpeningProjectId(null);
    }
  }

  // W15: set the folder of an existing project (project menu, project context menu, run error banner).
  function canSetProjectFolder(projectId: string | null | undefined): projectId is string {
    if (!projectId || !canSetFolderHere) return false;
    if (projectId === GLOBAL_PROJECT_ID || projectId === ALL_PROJECTS_ID) return false;
    const project = projects.find((candidate) => candidate.id === projectId);
    return Boolean(project && project.source !== "jira");
  }

  function openProjectFolderDialog(projectId: string) {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) return;
    setProjectMenuOpen(false);
    setProjectContextMenu(null);
    setProjectFolderValue(project.workspacePath ?? "");
    setProjectFolderError(null);
    setProjectFolderDialog({
      projectId,
      name: projectChoices.find((choice) => choice.id === projectId)?.name ?? project.name,
    });
  }

  function closeProjectFolderDialog() {
    if (savingProjectFolder) return;
    setProjectFolderDialog(null);
    setProjectFolderError(null);
  }

  async function saveProjectFolder() {
    if (!projectFolderDialog || savingProjectFolder) return;
    const workspacePath = projectFolderValue.trim();
    if (!workspacePath) return;
    setSavingProjectFolder(true);
    setProjectFolderError(null);
    try {
      const project = await updateProjectWorkspace(projectFolderDialog.projectId, workspacePath);
      setProjects((current) => current.map((candidate) => (
        candidate.id === project.id ? { ...candidate, workspacePath: project.workspacePath } : candidate
      )));
      if (workspaceFixProjectId === project.id || workspaceFixTargetId === project.id) {
        setWorkspaceFixProjectId(null);
        setActionError(null);
      }
      setProjectFolderDialog(null);
      setAnnouncement(text(
        `已设置项目文件夹：${project.workspacePath}`,
        `Project folder set: ${project.workspacePath}`,
        `已設定專案資料夾：${project.workspacePath}`,
      ));
    } catch (error) {
      setProjectFolderError(errorMessage(error));
    } finally {
      setSavingProjectFolder(false);
    }
  }

  function requestProjectDelete(project: ProjectChoice) {
    setProjectMenuOpen(false);
    setProjectContextMenu(null);
    setProjectDeleteIssueCount(null);
    setPendingProjectDelete(project);
  }

  function closeProjectDeleteDialog() {
    if (deletingProjectId) return;
    setPendingProjectDelete(null);
    setProjectDeleteIssueCount(null);
  }

  async function deletePendingProject() {
    if (!pendingProjectDelete || deletingProjectId) return;
    const project = pendingProjectDelete;
    setDeletingProjectId(project.id);
    setActionError(null);
    try {
      await deleteProjectRequest(project.id);
      setProjects((current) => current.filter((candidate) => candidate.id !== project.id));
      setRecentProjectIds((current) => {
        const next = current.filter((candidate) => candidate !== project.id);
        taskboardStorage.setItem(RECENT_PROJECT_IDS_KEY, JSON.stringify(next));
        return next;
      });
      setProjectCodexIdentities((current) => {
        const next = { ...current };
        delete next[project.id];
        taskboardStorage.setItem(PROJECT_CODEX_IDENTITIES_KEY, JSON.stringify(next));
        return next;
      });
      setPendingProjectDelete(null);
      setProjectDeleteIssueCount(null);
      if (selectedProjectId === project.id) changeProject(GLOBAL_PROJECT_ID);
      setAnnouncement(text(
        `已删除项目“${project.name}”`,
        `Deleted project “${project.name}”`,
        `已刪除專案「${project.name}」`,
      ));
    } catch (error) {
      if (error instanceof ApiError && error.code === "PROJECT_NOT_EMPTY") {
        const details = error.details as { issueCount: number };
        setProjectDeleteIssueCount(details.issueCount);
      } else {
        setPendingProjectDelete(null);
        setActionError(errorMessage(error));
      }
    } finally {
      setDeletingProjectId(null);
    }
  }

  // W15: a run refused for a missing project folder offers 「設定專案資料夾」 in the error banner.
  // Review O5: decided by the WORKSPACE_NOT_FOUND error code (api.ts event), not by the message text.
  const workspaceFixTargetId = actionErrorText && canSetProjectFolder(workspaceFixProjectId) ? workspaceFixProjectId : null;

  // W15: the 3-step guide sits on an empty board / dashboard only.
  const showStartGuide = !startGuideDismissed
    && projectsLoaded
    && hasLoadedTasks
    && !hasTasksInView
    && !detailTask
    && !isJiraProject
    && (isMobileBoard || boardView === "issues" || boardView === "dashboard");

  const headerProjectName = isAllProjects
    ? text("所有项目", "All projects")
    : selectedProject?.id === GLOBAL_PROJECT_ID
      ? text("临时任务", "Temporary tasks")
      : selectedProject?.name ?? text("任务面板", "Taskboard");
  const appShellStyle = embedded
    ? { "--codex-titlebar-left-inset": `${hostContext?.titlebarLeftInset ?? 0}px` } as CSSProperties
    : undefined;

  return (
    <TaskboardLanguageProvider language={language}>
      <div className={`app-shell${embedded ? " embedded" : ""}`} style={appShellStyle}>
      {taskboardMetadata && taskboardMetadata.mode !== "cloud" && (
        <LocalRealtimeSync
          selectedProjectId={taskScopeProjectId}
          detailTaskId={detailTaskId}
          refreshProjectList={refreshProjectList}
          refreshTasks={refreshTasks}
          refreshProjectBoardDisplaySettings={refreshProjectBoardDisplaySettings}
          setConnection={setConnection}
          setCommentsRevision={setCommentsRevision}
          setAttachmentsRevision={setAttachmentsRevision}
          setReadmeRevision={setReadmeRevision}
          onRunUpdated={applyRunUpdate}
        />
      )}
      <main className="workspace">
        {!servedFromThisPc && <div ref={setPhoneHintBarSlot} className="phone-hint-bar-slot" />}
        <header className="workspace-header">
          <div className="workspace-title">
            <div className="workspace-kicker">
              {detailTask && (
                <button
                  className="detail-back-button"
                  type="button"
                  aria-label={text("返回议题看板", "Back to issue board")}
                  title={text("返回议题看板 (Esc)", "Back to issue board (Esc)")}
                  onClick={closeTaskDetail}
                >
                  <LinearIcon name="chevronLeft" />
                </button>
              )}
              {embedded && hostContext?.sidebarCollapsed && (
                <button
                  className="detail-back-button codex-sidebar-expand-button"
                  type="button"
                  aria-label={text("展开 Codex 侧边栏", "Expand Codex sidebar")}
                  title={text("展开侧边栏", "Expand sidebar")}
                  onClick={expandCodexSidebar}
                >
                  <LinearIcon name="codexSidebarExpand" />
                </button>
              )}
              <div className="header-project-switcher" data-project-switcher>
                <button
                  className="header-project-button"
                  type="button"
                  aria-label={text("切换项目", "Switch project")}
                  aria-haspopup="menu"
                  aria-expanded={projectMenuOpen}
                  onClick={() => {
                    setProjectContextMenu(null);
                    setProjectMenuSearch("");
                    setProjectMenuOpen((current) => !current);
                  }}
                >
                  <span className="project-name">{headerProjectName}</span>
                  <TaskboardIcon className="project-switcher-chevron" name="dropdown" />
                </button>
                {projectMenuOpen && (
                  <div className="header-project-menu" role="menu" aria-label={text("项目", "Projects")}>
                    <span>{text("切换项目", "Switch project")}</span>
                    <div className="project-menu-search">
                      <label className="sr-only" htmlFor="project-menu-search-input">
                        {text("按名称筛选项目", "Filter projects by name")}
                      </label>
                      <TaskboardIcon name="search" />
                      <input
                        id="project-menu-search-input"
                        autoFocus
                        type="search"
                        value={projectMenuSearch}
                        onChange={(event) => setProjectMenuSearch(event.target.value)}
                        placeholder={text("筛选项目…", "Filter projects…")}
                      />
                      {projectMenuSearch && (
                        <button
                          className="search-clear"
                          type="button"
                          aria-label={text("清除项目筛选", "Clear project filter")}
                          onClick={() => setProjectMenuSearch("")}
                        >
                          <LinearIcon name="close" />
                        </button>
                      )}
                    </div>
                    <div className="project-menu-list">
                      {!projectMenuNeedle && (
                        <>
                          <button
                            type="button"
                            role="menuitemradio"
                            aria-checked={isAllProjects}
                            disabled={openingProjectId !== null}
                            onClick={() => {
                              if (isAllProjects) setProjectMenuOpen(false);
                              else changeProject(ALL_PROJECTS_ID);
                            }}
                          >
                            <TaskboardIcon className="project-avatar" name="projectFolder" />
                            <span>{text("所有项目", "All projects")}</span>
                            {isAllProjects && <span className="project-menu-check" aria-hidden="true"><LinearIcon name="check" /></span>}
                          </button>
                          <div className="project-menu-divider" role="separator" />
                        </>
                      )}
                      {projectMenuChoices.map((project) => (
                        <Fragment key={project.id}>
                          {hasProjectsWithIssues && project.id === firstEmptyProjectId && (
                            <div className="project-menu-divider" role="separator" />
                          )}
                          <button
                            type="button"
                            role="menuitemradio"
                            aria-checked={project.id === selectedProjectId}
                            disabled={openingProjectId !== null}
                            onContextMenu={project.id.startsWith("temp-") ? (event) => {
                              event.preventDefault();
                              setProjectContextMenu({
                                project,
                                x: event.clientX,
                                y: event.clientY,
                              });
                            } : undefined}
                            onClick={() => {
                              if (project.id === selectedProjectId) setProjectMenuOpen(false);
                              else void selectProject(project);
                            }}
                          >
                            <TaskboardIcon className="project-avatar" name="projectFolder" />
                            <span>{project.name}</span>
                            {project.id === selectedProjectId && <span className="project-menu-check" aria-hidden="true"><LinearIcon name="check" /></span>}
                          </button>
                        </Fragment>
                      ))}
                      {projectMenuNeedle && projectMenuChoices.length === 0 && (
                        <div className="project-menu-empty">{text("没有匹配项目", "No matching projects")}</div>
                      )}
                    </div>
                    <div className="project-menu-actions">
                      <div className="project-menu-divider" role="separator" />
                      <label className="project-menu-language">
                        <span>{text("語言", "Language")}</span>
                        <select
                          aria-label={text("語言", "Language")}
                          value={language}
                          onChange={(event) => {
                            const choice = resolveTaskboardLanguage(event.target.value);
                            taskboardStorage.setItem(TASKBOARD_LANGUAGE_KEY, choice);
                            setLanguage(choice);
                          }}
                        >
                          <option value="zh-TW">繁體中文（台灣）</option>
                          <option value="zh">简体中文</option>
                          <option value="en">English</option>
                        </select>
                      </label>
                      <TextSizeSetting value={textSize} onChange={setTextSize} text={text} />
                      {servedFromThisPc && (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setProjectMenuOpen(false);
                            setProjectContextMenu(null);
                            setMobileAccessOpen(true);
                          }}
                        >
                          <svg className="project-avatar" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                            <rect x="4.25" y="1.75" width="7.5" height="12.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                            <path d="M7 11.75h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                          </svg>
                          <span>{text("手機存取", "Mobile access")}</span>
                        </button>
                      )}
                      {JIRA_UI_ENABLED && (
                        <button
                          type="button"
                          role="menuitem"
                          disabled={openingProjectId !== null}
                          onClick={openJiraDialog}
                        >
                          <RelationIcon className="project-avatar" color="currentColor" size={16} />
                          <span>
                            {jiraConnection?.configured
                              ? text("Jira 设置", "Jira settings")
                              : text("连接 Jira", "Connect Jira")}
                          </span>
                        </button>
                      )}
                      {canSetProjectFolder(selectedProject?.id) && (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => openProjectFolderDialog(selectedProject!.id)}
                        >
                          <LinearIcon className="project-avatar" name="folder" />
                          <span>{text("项目文件夹…", "Project folder…", "專案資料夾…")}</span>
                        </button>
                      )}
                      <button
                        type="button"
                        role="menuitem"
                        disabled={openingProjectId !== null}
                        onClick={() => openCreateProjectDialog()}
                      >
                        <PlusIcon className="project-avatar" color="currentColor" size={16} />
                        <span>{text("创建项目", "Create project")}</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div ref={dragRegionRef} className="workspace-drag-region" aria-hidden="true" />

          <div className="header-actions">
            {servedFromThisPc && !isMobileBoard && (
              <HeaderPhoneButton pairedCount={pairedPhones.phones?.length ?? 0} onClick={() => setPhoneWizardOpen(true)} />
            )}
            {selectedProject && (
              <ProjectAutomationMenu projectId={selectedProject.id} models={automationModels} />
            )}
            {isJiraProject && (
              <button
                className="icon-button"
                type="button"
                disabled={jiraSyncing}
                onClick={() => void syncJiraNow()}
                aria-label={text("同步 Jira", "Sync Jira")}
                title={text("同步 Jira", "Sync Jira")}
              >
                <RefreshIcon color="currentColor" />
              </button>
            )}
            {selectedProjectId && !isJiraProject && (
              <button
                className="button primary header-create-button"
                type="button"
                onClick={() => openNewTask()}
                aria-label={text("新建任务", "New task", "新增任務")}
                title={text("新建任务 (C)", "New task (C)", "新增任務 (C)")}
              >
                <PlusIcon color="currentColor" size={14} />
                <span className="header-create-label">{text("新建任务", "New task", "新增任務")}</span>
              </button>
            )}
          </div>
        </header>

        {selectedProjectId && !detailTask && <div className="board-toolbar">
          <div className="view-tabs" aria-label={text("看板视图", "Board views")}>
            <button
              className={`view-tab${boardView === "dashboard" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "dashboard"}
              onClick={() => selectBoardView("dashboard")}
            >
              {text("仪表盘", "Dashboard")}
            </button>
            <button
              className={`view-tab${boardView === "issues" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "issues"}
              onClick={() => selectBoardView("issues")}
            >
              {text("议题看板", "Issue board")}
            </button>
            <button
              className={`view-tab${boardView === "list" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "list"}
              onClick={() => selectBoardView("list")}
            >
              {text("列表视图", "List")}
            </button>
            <button
              className={`view-tab${boardView === "gantt" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "gantt"}
              onClick={() => selectBoardView("gantt")}
            >
              {text("甘特图", "Gantt")}
            </button>
            {!isAllProjects && (
              <button
                className={`view-tab${boardView === "readme" ? " active" : ""}`}
                type="button"
                aria-pressed={boardView === "readme"}
                onClick={() => selectBoardView("readme")}
              >
                {text("项目文档", "Project Docs")}
              </button>
            )}
          </div>
          {(isMobileBoard || boardView === "issues" || boardView === "list" || boardView === "gantt") && <div className="toolbar-tools">
            <div className={`search-field${search ? " has-value" : ""}`} title={text("搜索议题 (/)", "Search issues (/)")}>
              <TaskboardIcon className="search-icon" name="search" />
              <input
                id="task-search"
                type="search"
                aria-label={text("搜索议题", "Search issues")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={text("搜索议题…", "Search issues…")}
              />
              {!search && <kbd>/</kbd>}
              {search && (
                <button
                  className="search-clear"
                  type="button"
                  aria-label={text("清除搜索", "Clear search")}
                  onClick={() => {
                    setSearch("");
                    document.getElementById("task-search")?.focus();
                  }}
                >
                  <LinearIcon name="close" />
                </button>
              )}
            </div>
            {boardView === "gantt" && !isMobileBoard && (
              <div className="gantt-toolbar-controls">
                <label className="gantt-hide-completed">
                  <input type="checkbox" checked={ganttHideCompleted} onChange={(event) => setGanttHideCompleted(event.target.checked)} />
                  <i><LinearIcon name="check" /></i>
                  <span>{text("隐藏已完成", "Hide completed")}</span>
                </label>
                <button type="button" className="gantt-today-button" onClick={() => setGanttTodayRequest((current) => current + 1)}>{text("今天", "Today")}</button>
                <div className="gantt-view-menu-wrap">
                  <button type="button" className="gantt-view-menu-trigger" aria-label={text("时间轴视图选项", "Timeline view options")} aria-expanded={ganttViewMenuOpen} onClick={() => setGanttViewMenuOpen((current) => !current)}>
                    <MoreIcon color="currentColor" />
                  </button>
                  {ganttViewMenuOpen && (
                    <div className="gantt-view-menu" role="menu">
                      {GANTT_ZOOM_OPTIONS.map((value) => (
                        <button type="button" role="menuitemradio" aria-checked={ganttZoom === value} className={ganttZoom === value ? "active" : ""} onClick={() => { setGanttZoom(value); setGanttViewMenuOpen(false); }} key={value}>
                          <span>{language === "zh-TW"
                            ? { day: "日檢視", week: "週檢視", month: "月檢視" }[value]
                            : language === "zh"
                              ? { day: "日视图", week: "周视图", month: "月视图" }[value]
                              : { day: "Day", week: "Week", month: "Month" }[value]}</span>
                          {ganttZoom === value && <LinearIcon name="check" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            <TaskFilterMenu
              tasks={tasks}
              search={search}
              labels={availableLabels}
              filters={filters}
              onChange={setFilters}
            />
            {boardView === "issues" && !isMobileBoard && (isAllProjects || selectedProject) && (
              <BoardCardDisplayMenu
                settings={boardDisplaySettings}
                onChange={updateProjectBoardDisplaySettings}
                onReset={resetProjectBoardDisplaySettings}
              />
            )}
            {boardView === "issues" && otherTasksAvailable && (
              <button
                className={`other-tasks-trigger${otherTasksOpen ? " is-open" : ""}`}
                type="button"
                aria-controls="other-tasks-panel"
                aria-expanded={otherTasksOpen}
                aria-label={otherTasksOpen
                  ? text("关闭其他任务", "Close other issues")
                  : text("打开其他任务", "Open other issues")}
                title={text("其他任务", "Other issues")}
                onClick={() => setOtherTasksOpen((current) => !current)}
              >
                <TaskboardIcon name="panel" />
              </button>
            )}
          </div>}
        </div>}

        {(loadError || actionErrorText) && (
          <div className="error-banner" role="alert">
            <span className="error-mark" aria-hidden="true"><LinearIcon name="alert" /></span>
            <div><strong>{text("任务面板需要处理", "Taskboard needs attention")}</strong><p>{actionErrorText ?? loadError?.message}</p></div>
            {workspaceFixTargetId && (
              <button
                className="error-banner-fix"
                type="button"
                onClick={() => openProjectFolderDialog(workspaceFixTargetId)}
              >
                {text("设置项目文件夹", "Set project folder", "設定專案資料夾")}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setActionError(null);
                if (loadError?.source === "projects") {
                  if (loadError.operation === "initial") void loadProjectList();
                  else void refreshProjectList();
                } else if (taskScopeProjectId) void refreshTasks(taskScopeProjectId);
                else void loadProjectList();
              }}
            >
              {text("重试", "Try again")}
            </button>
          </div>
        )}

        {showStartGuide && (
          <StartGuide
            hasProject={userCreateTargetProjects.length > 0 || (!isAllProjects && selectedProjectId !== GLOBAL_PROJECT_ID)}
            hasTasks={hasTasksInView}
            onCreateProject={canSetFolderHere ? () => openCreateProjectDialog({ thenNewTask: true }) : undefined}
            onNewTask={() => openNewTask()}
            onDismiss={dismissStartGuide}
          />
        )}

        {detailTask && selectedProject ? (
          <TaskDetail
            key={detailTask.id}
            task={detailTask}
            tasks={tasks.filter((task) => task.projectId === detailTask.projectId)}
            referenceTasks={referenceTasks.filter((task) => task.projectId === detailTask.projectId)}
            currentUser={currentUser}
            availableLabels={availableLabels}
            developmentScan={developmentScan}
            developmentScanLoading={developmentScanLoading}
            commentsRevision={commentsRevision}
            attachmentsRevision={attachmentsRevision}
            continueRequest={continueRequest?.taskId === detailTask.id ? continueRequest.sequence : 0}
            continueRequestFlow={continueRequest?.taskId === detailTask.id ? continueRequest.flow : "continue"}
            onCreateLabel={persistProjectLabel}
            onDeleteLabel={removeProjectLabel}
            onUpdate={(current, changes) => updateTaskProperties(current, changes)}
            onTaskChanged={mergeTaskFromServer}
            onOpenTask={openTaskDetail}
            onAddRelation={(current, type, relatedTaskId, origin) => (
              mutateTaskRelation("add", current, type, relatedTaskId, origin)
            )}
            onRemoveRelation={(current, type, relatedTaskId, origin) => (
              mutateTaskRelation("remove", current, type, relatedTaskId, origin)
            )}
            onOpenThread={openThread}
            onOpenLegacyLocalThread={openLegacyLocalThread}
            onOpenInThread={openTaskInThread}
            onCopy={(text, message) => void copyText(text, message)}
            openingThread={openingThreadTaskId === detailTask.id}
            onError={setActionError}
          />
        ) : boardView !== "readme"
          && hasLoadedTasks
          && tasks.length === 0
          && selectedProject
          && aiImportReadyProjectId === selectedProject.id ? (
          <div className="page-empty">
            <h2>{text("当前项目还没有任务", "This project has no issues yet")}</h2>
            <p>{text(
              "让 Codex 检查当前项目目录对应的对话，并整理任务状态。",
              "Ask Codex to inspect conversations for this project directory and organize their task status.",
            )}</p>
            <div className="page-empty-actions">
              <button
                className="button primary"
                type="button"
                onClick={() => {
                  aiOpenThreadRequestSequenceRef.current += 1;
                  setAiOpenThreadRequest({
                    projectId: selectedProject.id,
                    issueId: null,
                    composerText: text(
                      "使用 $manage-automate-taskboard：只检查当前项目目录对应的 Codex 对话。请将其中已完成、处理中和待执行的任务整理并导入当前项目的 Taskboard。",
                      "Use $manage-automate-taskboard: only inspect Codex conversations associated with this project directory. Organize completed, in-progress, and pending tasks, then import them into this project's Taskboard.",
                    ),
                    // Import fix F2: the server also attaches the board skill to this turn.
                    intent: "taskboard-import",
                    requestId: aiOpenThreadRequestSequenceRef.current,
                  });
                }}
              >
                {text("导入当前项目任务状态", "Import current project task status")}
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => openNewTask()}
              >
                {text("新建任务", "New task", "新增任務")}
              </button>
            </div>
          </div>
        ) : isMobileBoard ? (
          <MobileBoard
            tasksByStatus={tasksByStatus}
            presentations={taskPresentations}
            projectNames={isAllProjects ? projectNames : undefined}
            hasActiveFilters={hasActiveTaskFilters}
            loading={tasksLoading && !hasLoadedTasks}
            movingTaskId={movingTaskId}
            onDrop={finishTaskDrop}
            onComplete={(task) => moveTask(task, "done")}
            onOpenTask={openTaskDetail}
            onStartRun={startTaskRun}
            onStopRun={stopTaskRun}
            onOpenRunInApp={openRunInAppHere ? openTaskRunInApp : undefined}
          />
        ) : boardView === "readme" && selectedProject ? (
          <ProjectReadmeView
            key={selectedProjectId}
            project={selectedProject}
            tasks={tasks.filter((task) => task.projectId === selectedProject.id)}
            referenceTasks={referenceTasks.filter((task) => task.projectId === selectedProject.id)}
            revision={readmeRevision}
            onOpenTask={openTaskDetail}
            onError={setActionError}
          />
        ) : boardView === "dashboard" && (selectedProject || isAllProjects) ? (
          <DashboardView
            key={selectedProjectId}
            projectId={selectedProjectId}
            projectCreatedAt={selectedProject?.createdAt ?? null}
            isAllProjects={isAllProjects}
            tasks={tasks}
            presentations={taskPresentations}
            currentUser={currentUser}
            animateSummary={dashboardSummaryAnimatedProjectId !== selectedProjectId}
            onSummaryAnimationStart={markDashboardSummaryAnimationStarted}
            onOpenTask={openTaskDetail}
            onOpenConversation={openTaskConversation}
          />
        ) : boardView === "list" ? (
          <IssueListView
            scrollRef={issueListRef}
            tasks={orderedFilteredTasks}
            presentations={taskPresentations}
            currentUser={currentUser}
            hasActiveFilters={hasActiveTaskFilters}
            onOpenTask={openTaskDetail}
            onOpenConversation={openTaskConversation}
            onUpdate={updateTaskProperties}
          />
        ) : boardView === "gantt" ? (
          <Suspense fallback={<div className="board-view-loading">{text("正在打开甘特图…", "Opening Gantt…")}</div>}>
            <GanttView
              tasks={filteredTasks}
              presentations={taskPresentations}
              hasActiveFilters={hasActiveTaskFilters}
              zoom={ganttZoom}
              hideCompleted={ganttHideCompleted}
              todayRequest={ganttTodayRequest}
              onOpenTask={openTaskDetail}
              onUpdate={updateTaskProperties}
            />
          </Suspense>
        ) : (
          <div
            className={`issue-board-layout${otherTasksAvailable && otherTasksVisible ? " has-other-tasks" : ""}`}
            data-main-columns={mainBoardItems.length}
            style={{
              "--main-column-count": mainColumnCount,
              "--main-board-min-width": `${mainBoardMinWidth}rem`,
              "--main-board-max-width": `${mainBoardMaxWidth}rem`,
              "--other-tasks-width": otherTasksWidth,
            } as CSSProperties}
          >
            {tasksLoading && !hasLoadedTasks ? (
              <div className="loading-board" aria-label={text("正在加载议题", "Loading issues")} aria-busy="true">
                {mainBoardItems.map((item) => (
                  <div className="loading-column" key={item}>
                    <span /><div /><div />
                  </div>
                ))}
              </div>
            ) : (
              <>
                <div ref={boardScrollRef} className="board-scroll" aria-label={text("议题看板", "Issue board")}>
                  <div className="board">
                    {mainBoardItems.map((item) => item === "archived" ? (
                      <ArchivedTasksColumn
                        key={item}
                        tasks={filteredArchivedTasks}
                        hasActiveFilters={hasActiveTaskFilters}
                        restoringTaskId={restoringTaskId}
                        deletingTaskId={deletingArchivedTaskId}
                        onRestore={(task) => void restoreArchivedTask(task)}
                        onDelete={setPendingArchivedTaskDelete}
                      />
                    ) : (
                      <BoardColumn
                        key={item}
                        scrollRef={(element) => {
                          boardColumnScrollRefs.current[item] = element;
                        }}
                        status={item}
                        tasks={tasksByStatus[item]}
                        presentations={taskPresentations}
                        emptyMessage={hasActiveTaskFilters
                          ? text("当前筛选下无匹配议题", "No issues match the current filters")
                          : text("暂无议题", "No issues")}
                        isDropTarget={dropTarget === item}
                        draggedTaskId={draggedTaskId}
                        draggedTaskHeight={draggedTaskHeight}
                        movingTaskId={movingTaskId}
                        settlingTaskId={settlingTaskId}
                        contextMenuTaskId={contextMenu?.taskId ?? null}
                        availableLabels={availableLabels}
                        projectNames={isAllProjects ? projectNames : undefined}
                        currentUser={currentUser}
                        showCover={boardDisplaySettings.cover}
                        showBody={boardDisplaySettings.body}
                        createEnabled={!isJiraProject}
                        onCreateLabel={persistProjectLabel}
                        onCreate={(initialStatus) => openNewTask(initialStatus)}
                        onEdit={openTaskDetail}
                        onUpdate={updateTaskProperties}
                        onComplete={(task) => moveTask(task, "done")}
                        onContextMenu={openTaskContextMenu}
                        onDragStart={startTaskDrag}
                        onDragEnd={endTaskDrag}
                        onDragEnter={setDropTarget}
                        onDrop={finishTaskDrop}
                        onOpenConversation={openTaskConversation}
                        onStartRun={startTaskRun}
                        onStopRun={stopTaskRun}
                        onOpenRunInApp={openRunInAppHere ? openTaskRunInApp : undefined}
                        orderMode={isAllProjects ? null : displayOrderMode}
                        onResetOrder={isAllProjects ? undefined : resetTodoOrder}
                      />
                    ))}
                  </div>
                </div>
                {otherTasksAvailable && otherTasksMounted && (
                  <OtherTasksPanel
                    open={otherTasksVisible}
                    activeTab={otherTasksTab}
                    tabs={otherTaskTabs}
                    tasksByStatus={tasksByStatus}
                    archivedTasks={filteredArchivedTasks}
                    presentations={taskPresentations}
                    hasActiveFilters={hasActiveTaskFilters}
                    isDropTarget={otherTasksTab !== "archived" && dropTarget === otherTasksTab}
                    draggedTaskId={draggedTaskId}
                    draggedTaskHeight={draggedTaskHeight}
                    movingTaskId={movingTaskId}
                    settlingTaskId={settlingTaskId}
                    contextMenuTaskId={contextMenu?.taskId ?? null}
                    availableLabels={availableLabels}
                    projectNames={isAllProjects ? projectNames : undefined}
                    currentUser={currentUser}
                    showCover={boardDisplaySettings.cover}
                    showBody={boardDisplaySettings.body}
                    onCreateLabel={persistProjectLabel}
                    restoringTaskId={restoringTaskId}
                    deletingTaskId={deletingArchivedTaskId}
                    onTabChange={setOtherTasksTab}
                    onCreate={isJiraProject
                      ? undefined
                      : (initialStatus) => openNewTask(initialStatus)}
                    onRestore={(task) => void restoreArchivedTask(task)}
                    onDelete={setPendingArchivedTaskDelete}
                    onEdit={openTaskDetail}
                    onUpdate={updateTaskProperties}
                    onContextMenu={openTaskContextMenu}
                    onDragStart={startTaskDrag}
                    onDragEnd={endTaskDrag}
                    onDragEnter={setDropTarget}
                    onDrop={finishTaskDrop}
                    onOpenConversation={openTaskConversation}
                    onStartRun={startTaskRun}
                    onStopRun={stopTaskRun}
                    onOpenRunInApp={openRunInAppHere ? openTaskRunInApp : undefined}
                  />
                )}
              </>
            )}
          </div>
        )}
      </main>

      {projectContextMenu && (
        <div
          className="task-context-menu project-context-menu"
          data-project-context-menu
          role="menu"
          aria-label={text(
            `项目“${projectContextMenu.project.name}”`,
            `Project “${projectContextMenu.project.name}”`,
            `專案「${projectContextMenu.project.name}」`,
          )}
          style={{ left: projectContextMenu.x, top: projectContextMenu.y }}
        >
          {canSetProjectFolder(projectContextMenu.project.id) && (
            <button
              className="context-menu-item"
              type="button"
              role="menuitem"
              onClick={() => openProjectFolderDialog(projectContextMenu.project.id)}
            >
              <span className="context-menu-icon" aria-hidden="true"><LinearIcon name="folder" /></span>
              <span className="context-menu-label">{text("设置项目文件夹…", "Set project folder…", "設定專案資料夾…")}</span>
            </button>
          )}
          <button
            className="context-menu-item is-danger"
            type="button"
            role="menuitem"
            onClick={() => requestProjectDelete(projectContextMenu.project)}
          >
            <span className="context-menu-icon" aria-hidden="true"><DeleteIcon color="currentColor" /></span>
            <span className="context-menu-label">{text("删除项目", "Delete project")}</span>
          </button>
        </div>
      )}

      {servedFromThisPc && (
        <MobileAccessSettings
          open={mobileAccessOpen}
          onOpenChange={(next) => {
            setMobileAccessOpen(next);
            if (!next) void refreshPairedPhones();
          }}
          showTrigger={false}
          showPairingCompletion={false}
        />
      )}
      {/* Phone side of pairing (Amendment 10): on the tailnet address, auto-pairs from the QR link's #pair= secret or asks for the 6-digit code while unpaired; then re-read everything with the new session. */}
      {servedFromThisPc && phoneWizardOpen && (
        <PhoneSetupWizard
          onClose={() => {
            taskboardStorage.setItem(PHONE_WIZARD_DISMISSED_KEY, "1");
            setPhoneWizardOpen(false);
            void refreshPairedPhones();
          }}
          onOpenSettings={() => {
            taskboardStorage.setItem(PHONE_WIZARD_DISMISSED_KEY, "1");
            setPhoneWizardOpen(false);
            setMobileAccessOpen(true);
          }}
        />
      )}
      {!servedFromThisPc && (
        <PhoneOnboarding
          paired={phonePaired}
          justPaired={phoneJustPaired}
          onJustPairedSeen={() => setPhoneJustPaired(false)}
          mobileBoard={isMobileBoard}
          hintBarSlot={phoneHintBarSlot}
        />
      )}
      <PairingCompletion
        onPaired={() => {
          setPhonePaired(true);
          setPhoneJustPaired(true);
          setActionError(null);
          void loadProjectList();
          void refreshProjectBoardDisplaySettings();
          if (taskScopeProjectId) void refreshTasks(taskScopeProjectId);
        }}
      />

      {jiraDialogOpen && (
        <JiraConnectionDialog
          connection={jiraConnection}
          saving={jiraSaving}
          error={jiraError}
          onClose={() => {
            if (!jiraSaving) setJiraDialogOpen(false);
          }}
          onSave={saveJiraConnection}
        />
      )}

      {projectCreateOpen && (
        <div
          className="delete-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) closeCreateProjectDialog();
          }}
        >
          <form
            className="delete-dialog project-create-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-create-title"
            onSubmit={(event) => {
              event.preventDefault();
              void createTemporaryProject();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeCreateProjectDialog();
            }}
          >
            <h2 id="project-create-title">{text("创建项目", "Create project")}</h2>
            {createTaskAfterProject && (
              <p className="project-create-hint">{text(
                "先选一个文件夹建立项目，建立后会接着打开「新建任务」。",
                "Pick a folder to create a project first. The new task form opens right after.",
                "先選一個資料夾建立專案，建立後會接著打開「新增任務」。",
              )}</p>
            )}
            <label>
              <span>{text("项目名称", "Project name")}</span>
              <input
                autoFocus
                maxLength={120}
                required
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
              />
            </label>
            {canSetFolderHere ? (
              <ProjectFolderField
                value={projectFolder}
                onChange={setProjectFolder}
                canPick
                disabled={openingProjectId !== null}
                onPicked={(folderPath) => {
                  if (!projectName.trim()) setProjectName(folderDisplayName(folderPath));
                }}
                onError={setActionError}
              />
            ) : (
              <p className="project-create-hint project-create-phone-note">{text(
                "项目文件夹只能在电脑上的 AutoMate Taskboard 窗口设置；在设置文件夹之前，AI 还不能处理这个项目的任务。",
                "The project folder can only be set in AutoMate Taskboard on the computer. Until then, the AI cannot work on this project's tasks.",
                "專案資料夾只能在電腦上的 AutoMate Taskboard 視窗設定；設定資料夾之前，AI 還不能處理這個專案的任務。",
              )}</p>
            )}
            {actionErrorText && <p className="project-dialog-error">{actionErrorText}</p>}
            <div>
              <button
                className="button secondary"
                type="button"
                disabled={openingProjectId !== null}
                onClick={closeCreateProjectDialog}
              >
                {text("取消", "Cancel")}
              </button>
              <button
                className="button primary"
                type="submit"
                disabled={!projectName.trim() || (canSetFolderHere && !projectFolder.trim()) || openingProjectId !== null}
              >
                {openingProjectId
                  ? text("创建中…", "Creating…")
                  : text("创建", "Create")}
              </button>
            </div>
          </form>
        </div>
      )}

      {projectFolderDialog && (
        <div
          className="delete-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) closeProjectFolderDialog();
          }}
        >
          <form
            className="delete-dialog project-create-dialog project-folder-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-folder-title"
            onSubmit={(event) => {
              event.preventDefault();
              void saveProjectFolder();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeProjectFolderDialog();
            }}
          >
            <h2 id="project-folder-title">{text(
              `设置“${projectFolderDialog.name}”的文件夹`,
              `Folder for “${projectFolderDialog.name}”`,
              `設定「${projectFolderDialog.name}」的資料夾`,
            )}</h2>
            <ProjectFolderField
              value={projectFolderValue}
              onChange={setProjectFolderValue}
              canPick
              autoFocus
              disabled={savingProjectFolder}
              onError={setProjectFolderError}
            />
            {projectFolderError && <p className="project-dialog-error">{projectFolderError}</p>}
            <div>
              <button
                className="button secondary"
                type="button"
                disabled={savingProjectFolder}
                onClick={closeProjectFolderDialog}
              >
                {text("取消", "Cancel")}
              </button>
              <button
                className="button primary"
                type="submit"
                disabled={!projectFolderValue.trim() || savingProjectFolder}
              >
                {savingProjectFolder ? text("保存中…", "Saving…", "儲存中…") : text("保存", "Save", "儲存")}
              </button>
            </div>
          </form>
        </div>
      )}

      {pendingProjectDelete && (
        <div
          className="delete-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) closeProjectDeleteDialog();
          }}
        >
          <div
            className="delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="project-delete-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") closeProjectDeleteDialog();
            }}
          >
            {projectDeleteIssueCount === null ? (
              <>
                <h2 id="project-delete-title">{text(
                  `删除项目“${pendingProjectDelete.name}”？`,
                  `Delete project “${pendingProjectDelete.name}”?`,
                  `刪除專案「${pendingProjectDelete.name}」？`,
                )}</h2>
                <p>{text(
                  "仅空项目可以删除。删除后无法恢复。",
                  "Only empty projects can be deleted. This cannot be undone.",
                )}</p>
                <div>
                  <button
                    className="button secondary"
                    type="button"
                    disabled={deletingProjectId !== null}
                    onClick={closeProjectDeleteDialog}
                  >
                    {text("取消", "Cancel")}
                  </button>
                  <button
                    className="button danger"
                    type="button"
                    disabled={deletingProjectId !== null}
                    onClick={() => void deletePendingProject()}
                  >
                    {deletingProjectId
                      ? text("删除中…", "Deleting…")
                      : text("删除项目", "Delete project")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 id="project-delete-title">{text(
                  `无法删除项目“${pendingProjectDelete.name}”`,
                  `Cannot delete project “${pendingProjectDelete.name}”`,
                  `無法刪除專案「${pendingProjectDelete.name}」`,
                )}</h2>
                <p>{text(
                  `该项目还有 ${projectDeleteIssueCount} 个议题（包含已归档议题）。请先移动或删除这些议题。`,
                  `This project still has ${projectDeleteIssueCount} issues, including archived issues. Move or delete them first.`,
                  `該專案還有 ${projectDeleteIssueCount} 個任務（包含已封存任務）。請先移動或刪除這些任務。`,
                )}</p>
                <div>
                  <button className="button primary" type="button" onClick={closeProjectDeleteDialog}>
                    {text("知道了", "Got it")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {pendingArchivedTaskDelete && (
        <div
          className="delete-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !deletingArchivedTaskId) {
              setPendingArchivedTaskDelete(null);
            }
          }}
        >
          <div
            className="delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="archived-task-delete-title"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !deletingArchivedTaskId) {
                setPendingArchivedTaskDelete(null);
              }
            }}
          >
            <h2 id="archived-task-delete-title">{text(
              `永久删除 ${pendingArchivedTaskDelete.identifier}？`,
              `Permanently delete ${pendingArchivedTaskDelete.identifier}?`,
              `永久刪除 ${pendingArchivedTaskDelete.identifier}？`,
            )}</h2>
            <p>{text(
              `“${pendingArchivedTaskDelete.title}”及其评论和附件将被永久删除，此操作无法撤销。`,
              `“${pendingArchivedTaskDelete.title}” and its comments and attachments will be permanently deleted. This cannot be undone.`,
              `「${pendingArchivedTaskDelete.title}」及其留言和附件將被永久刪除，此操作無法復原。`,
            )}</p>
            <div>
              <button
                className="button secondary"
                type="button"
                disabled={deletingArchivedTaskId !== null}
                onClick={() => setPendingArchivedTaskDelete(null)}
              >
                {text("取消", "Cancel")}
              </button>
              <button
                className="button danger"
                type="button"
                disabled={deletingArchivedTaskId !== null}
                onClick={() => void deletePendingArchivedTask()}
              >
                {deletingArchivedTaskId
                  ? text("删除中…", "Deleting…")
                  : text("永久删除", "Delete permanently")}
              </button>
            </div>
          </div>
        </div>
      )}

      {editor && (
        <TaskEditor
          key={`new-${selectedProjectId}-${editor.status}`}
          projectId={editorProjectId}
          projectOptions={isAllProjects ? createTargetProjects : undefined}
          onProjectChange={(projectId) => setEditor((current) => (
            current ? { ...current, projectId } : current
          ))}
          tasks={tasks.filter((task) => task.projectId === editorProjectId)}
          referenceTasks={referenceTasks.filter((task) => task.projectId === editorProjectId)}
          initialStatus={editor.status}
          initialDraft={newTaskDraft?.projectId !== selectedProjectId
            ? null
            : newTaskDraft.draft}
          labels={projects.find((project) => project.id === editorProjectId)?.labels ?? []}
          currentUser={currentUser}
          developmentScan={developmentScan}
          developmentScanLoading={developmentScanLoading}
          onCreateLabel={(label) => persistProjectLabel(label, editorProjectId ?? selectedProjectId)}
          onCancel={(draft) => {
            setNewTaskDraft(draft ? {
              projectId: selectedProjectId,
              targetProjectId: editorProjectId,
              draft,
            } : null);
            setEditor(null);
          }}
          onSave={saveEditor}
        />
      )}

      {contextMenu && contextMenuTask && (
        <TaskContextMenu
          task={contextMenuTask}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          labels={availableLabels}
          onClose={closeContextMenu}
          onEdit={openTaskDetail}
          onStatusChange={(task, status) => void moveTask(task, status)}
          onPriorityChange={(task, nextPriority) => void updateTaskProperties(
            task,
            { priority: nextPriority },
          ).catch(() => {})}
          onLabelsChange={(task, labels) => void updateTaskProperties(
            task,
            { labels },
          ).catch(() => {})}
          onDuplicate={(task) => void duplicateTask(task)}
          onCopy={(text, message) => void copyText(text, message)}
          openInThreadDisabled={developmentScanLoading}
          onOpenInThread={openTaskInThread}
          onArchive={(task) => void archiveTask(task)}
        />
      )}

      {localAiChatAvailable && !isAllProjects && (
        <Suspense fallback={null}>
          <AiChat
            available
            projectId={selectedProjectId || null}
            issueId={detailTaskId}
            codexProjectIdentity={selectedCodexProjectIdentity}
            onThreadsChange={setAiThreads}
            openThreadRequest={aiOpenThreadRequest}
            onOpenThreadRequestHandled={handleAiOpenThreadRequestHandled}
          />
        </Suspense>
      )}

      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      {undoNotice && (
        <div
          className="toast undo-toast"
          role="status"
          onAnimationEnd={() => setUndoNotice((current) => current?.id === undoNotice.id ? null : current)}
        >
          <span aria-hidden="true"><LinearIcon name="check" /></span>
          <span className="undo-toast-message">{undoNotice.message}</span>
          <button type="button" onClick={() => void performUndo()}>
            {text("撤回", "Undo")} <kbd>{undoShortcut}</kbd>
          </button>
        </div>
      )}
      {announcement && (
        <div className="toast" role="status" onAnimationEnd={() => setAnnouncementValue("")}>
          <span aria-hidden="true"><LinearIcon name="check" /></span>{announcement}
        </div>
      )}
      </div>
    </TaskboardLanguageProvider>
  );
}
