/*
 * I-W web integration tests (vitest + jsdom):
 *   npx vitest run web/src/v2WebIntegration.test.tsx --environment jsdom
 * `.test.tsx` is not collected by plain `node --test`, so no runner guard is needed.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  MOBILE_CSRF_HEADER,
  MOBILE_CSRF_STORAGE_KEY,
  listTaskRuns,
  startTaskRun,
  type TaskRunActivity,
} from "./api";
import { App, blocksAllProjectsTodoReorder, planSuggestedTodoReorder } from "./App";
import {
  CONTINUE_FLOW_HINT_TEXT,
  REWORK_FLOW_HINT_TEXT,
  continueFlowFor,
  continueFlowForError,
  guardedStatusMove,
  isContinueMessageRequiredError,
  requiresContinueMessage,
} from "./continueGuard";
import { BoardColumn } from "./components/BoardColumn";
import { ActorAvatar } from "./components/ActorAvatar";
import { IssueListView } from "./components/IssueListView";
import {
  MobileAccessSettings,
  PairingCompletion,
  canRenderWithoutClientStorage,
  isLoopbackHostname,
  pairingLink,
  readPairingFragment,
  stageOf,
} from "./components/MobileAccessSettings";
import { StrictMode } from "react";
import { createPairingQrDataUrl } from "./mobilePairingQr.mjs";
import { MobileBoard } from "./components/MobileBoard";
import {
  TASK_RUN_ACTIVITY_LIMIT,
  TaskRunPanel,
  CODEX_RUN_ACTIVE_APP_TEXT,
  RUN_ENDED_CANCELED_TEXT,
  STEER_QUEUED_SENT_TEXT,
  STEER_QUEUED_TEXT,
  STEER_WAITING_PERMISSION_TEXT,
  appendTaskRunActivity,
  followupDeliveryState,
  followupNote,
  mergeRunIntoTask,
  pickTaskRunAppUrl,
  publishTaskRunEvent,
  seedTaskRunActivity,
  taskRunClaudePermissionText,
  taskRunConversationId,
  taskRunErrorText,
  taskRunHasAppLink,
} from "./components/TaskRunPanel";
import { RUN_ERROR_TEXT, runErrorMessage, runErrorTextPair } from "./runErrorText";
import { newClientId } from "./clientId";
import { RUN_APP_LINK_EMBEDDED_TEXT, isEmbeddedHostFrame, openRunAppUrl, taskboardPageHostname } from "./hostEmbedding";
import { createMobileAccessApi } from "./mobileAccessApi";
import { FollowupComposer } from "./components/FollowupComposer";
import { ProjectAutomationMenu, claudePermissionPreviewText } from "./components/ProjectAutomationMenu";
import { mobileCsrfWriteHeaders, taskboardStorage } from "./storage";
import { isChineseLanguage } from "./i18n";
import { labelDisplayName } from "./labels";
import type { MobileAccessApi, MobileAccessInspection } from "./mobileAccessApi";
import { RELAY_CSRF_STORAGE_KEY } from "./mobileAccessApi";
import type { TaskCardPresentation } from "./taskConversations";
import {
  TASK_STATUSES,
  type ActorIdentity,
  type Task,
  type TaskFollowup,
  type TaskRun,
  type TaskStatus,
} from "./types";

const USER: ActorIdentity = { type: "user", id: "local-user", name: "Alice", avatarUrl: null };
const CLAUDE: ActorIdentity = { type: "agent", id: "claude-agent", name: "Claude", avatarUrl: null };
const CODEX: ActorIdentity = { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null };

function makeTask(id: string, status: TaskStatus, overrides: Partial<Task> = {}): Task {
  return {
    id,
    identifier: `T-${id}`,
    projectId: "p1",
    title: `Task ${id}`,
    description: "",
    status,
    priority: "none",
    labels: [],
    sortOrder: 0,
    threadId: null,
    threadBinding: null,
    legacyLocalThreadId: null,
    conversationRefs: [],
    participants: [],
    previewImage: null,
    activityKey: "",
    activityUpdatedAt: "2026-09-17T00:00:00.000Z",
    creatorType: "user",
    creatorId: USER.id,
    creatorName: USER.name,
    creatorAvatarUrl: null,
    assignee: USER,
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
    source: "local",
    externalUrl: null,
    archivedAt: null,
    relations: { parent: null, subIssues: [], blockedBy: [], blocks: [], related: [] },
    version: 1,
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function makeRun(id: string, status: TaskRun["status"], overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id,
    taskId: "t1",
    provider: "claude",
    status,
    claudeShortId: null,
    claudeSessionId: null,
    claudeBridgeSessionId: null,
    codexThreadId: null,
    codexTurnId: null,
    resultText: null,
    error: null,
    startedAt: "2026-09-17T01:00:00.000Z",
    endedAt: null,
    createdAt: "2026-09-17T01:00:00.000Z",
    updatedAt: "2026-09-17T01:00:00.000Z",
    ...overrides,
  };
}

function presentationsFor(tasks: Task[]): Record<string, TaskCardPresentation> {
  return Object.fromEntries(tasks.map((task) => [task.id, {
    conversations: [],
    processing: { running: false, completed: null, total: null, startedAt: null },
    unread: false,
  }]));
}

function groupTasks(tasks: Task[]): Record<TaskStatus, Task[]> {
  return Object.fromEntries(
    TASK_STATUSES.map((status) => [status, tasks.filter((task) => task.status === status)]),
  ) as Record<TaskStatus, Task[]>;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe("i18n: zh-TW counts as Chinese", () => {
  it("isChineseLanguage covers zh-TW and zh only", () => {
    expect(isChineseLanguage("zh-TW")).toBe(true);
    expect(isChineseLanguage("zh")).toBe(true);
    expect(isChineseLanguage("en")).toBe(false);
  });

  it("label names use Chinese for zh-TW", () => {
    expect(labelDisplayName("特性", "zh-TW")).toBe("新功能");
    expect(labelDisplayName("改进", "zh-TW")).toBe("改進");
    expect(labelDisplayName("改进", "zh")).toBe("改进");
    expect(labelDisplayName("改进", "en")).toBe("Improvement");
  });
});

describe("api.ts", () => {
  it("uses the same sessionStorage key as the mobile pairing client", () => {
    expect(MOBILE_CSRF_STORAGE_KEY).toBe(RELAY_CSRF_STORAGE_KEY);
  });

  it("sends x-relay-csrf on writes when the phone has a token, not on reads", async () => {
    const seen: Array<{ method: string; csrf: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      seen.push({ method: (init.method ?? "GET").toUpperCase(), csrf: headers.get(MOBILE_CSRF_HEADER) });
      return (init.method ?? "GET").toUpperCase() === "GET"
        ? jsonResponse({ runs: [], followups: [] })
        : jsonResponse({ task: makeTask("t1", "in_progress"), run: makeRun("r1", "starting") });
    }));

    await startTaskRun("t1");
    expect(seen.at(-1)).toEqual({ method: "POST", csrf: null });

    window.sessionStorage.setItem(RELAY_CSRF_STORAGE_KEY, "csrf-token");
    await startTaskRun("t1");
    expect(seen.at(-1)).toEqual({ method: "POST", csrf: "csrf-token" });
    await listTaskRuns("t1");
    expect(seen.at(-1)).toEqual({ method: "GET", csrf: null });
  });

  it("listTaskRuns accepts activity at the top level or on the run", async () => {
    const activity: TaskRunActivity[] = [{ kind: "command", text: "npm test" }];
    const responses = [
      { runs: [{ ...makeRun("r1", "running"), openUrl: null }], followups: [], activity, activityRunId: "r1" },
      { runs: [{ ...makeRun("r2", "running"), openUrl: null, activity }], followups: [] },
      { runs: [{ ...makeRun("r3", "finished"), openUrl: null }], followups: [] },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(responses.shift())));

    expect(await listTaskRuns("t1")).toMatchObject({ activity, activityRunId: "r1" });
    expect(await listTaskRuns("t1")).toMatchObject({ activity, activityRunId: "r2" });
    expect(await listTaskRuns("t1")).toMatchObject({ activity: [], activityRunId: null });
  });
});

describe("run state helpers", () => {
  it("mergeRunIntoTask tracks the active and latest run", () => {
    const task = makeTask("t1", "in_progress");
    const running = makeRun("r1", "running");
    const started = mergeRunIntoTask(task, running);
    expect(started.activeRun?.id).toBe("r1");
    expect(started.latestRun?.id).toBe("r1");

    const finished = mergeRunIntoTask(started, { ...running, status: "finished", resultText: "done" });
    expect(finished.activeRun).toBeNull();
    expect(finished.latestRun?.status).toBe("finished");

    const older = makeRun("r0", "failed", { createdAt: "2026-09-16T00:00:00.000Z" });
    expect(mergeRunIntoTask(finished, older).latestRun?.id).toBe("r1");
  });

  it("appendTaskRunActivity caps the list and restarts for a new run", () => {
    let state = { runId: "r1" as string | null, items: [] as TaskRunActivity[] };
    for (let index = 0; index < TASK_RUN_ACTIVITY_LIMIT + 5; index += 1) {
      state = appendTaskRunActivity(state, "r1", { kind: "message", text: `line ${index}` });
    }
    expect(state.items).toHaveLength(TASK_RUN_ACTIVITY_LIMIT);
    expect(state.items[0].text).toBe("line 5");

    state = appendTaskRunActivity(state, "r2", { kind: "status", text: "new run" });
    expect(state).toEqual({ runId: "r2", items: [{ kind: "status", text: "new run" }] });
  });
});

describe("TaskRunPanel live activity", () => {
  it("seeds from GET runs and appends run.activity events for the open task", async () => {
    const run = makeRun("r1", "running");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      runs: [{ ...run, openUrl: null }],
      followups: [],
      activity: [{ kind: "command", text: "npm test" }],
    })));
    const task = makeTask("t1", "in_progress", { assignee: CLAUDE, activeRun: run, latestRun: run });
    render(<TaskRunPanel task={task} />);

    expect(await screen.findByText("npm test")).toBeTruthy();
    expect(screen.getByText("即時動態")).toBeTruthy();

    act(() => {
      publishTaskRunEvent({ type: "run.activity", taskId: "other", runId: "rx", activity: { kind: "message", text: "not mine" } });
      publishTaskRunEvent({ type: "run.activity", taskId: "t1", runId: "r1", activity: { kind: "file", text: "notes/a.txt" } });
    });
    expect(screen.getByText("notes/a.txt")).toBeTruthy();
    expect(screen.queryByText("not mine")).toBeNull();
    expect(screen.getByText("檔案")).toBeTruthy();
  });
});

describe("todo order: drop while the suggested order is shown", () => {
  it("renumbers the shown order and writes the dragged card first", () => {
    const urgent = makeTask("a", "todo", { priority: "urgent", sortOrder: 3000 });
    const high = makeTask("b", "todo", { priority: "high", sortOrder: 1000 });
    const none = makeTask("c", "todo", { priority: "none", sortOrder: 2000 });
    const plan = planSuggestedTodoReorder([urgent, high, none], none, "b");
    expect(plan).not.toBeNull();
    expect([...plan!.sortOrders.entries()]).toEqual([["a", 1024], ["c", 2048], ["b", 3072]]);
    expect(plan!.writes.map((task) => task.id)).toEqual(["c", "a", "b"]);
  });

  it("All projects does not write a drop inside todo, but still allows moves between columns", () => {
    expect(blocksAllProjectsTodoReorder(true, "todo", "todo")).toBe(true);
    expect(blocksAllProjectsTodoReorder(true, "todo", "in_progress")).toBe(false);
    expect(blocksAllProjectsTodoReorder(true, "in_progress", "todo")).toBe(false);
    expect(blocksAllProjectsTodoReorder(false, "todo", "todo")).toBe(false);
  });

  it("returns null when the card lands where it already is", () => {
    const urgent = makeTask("a", "todo", { priority: "urgent" });
    const high = makeTask("b", "todo", { priority: "high" });
    expect(planSuggestedTodoReorder([urgent, high], urgent, "b")).toBeNull();
    expect(planSuggestedTodoReorder([urgent, high], high, null)).toBeNull();
  });
});

describe("BoardColumn", () => {
  function renderColumn(status: TaskStatus, tasks: Task[], extra: Partial<Parameters<typeof BoardColumn>[0]> = {}) {
    return render(
      <BoardColumn
        scrollRef={() => {}}
        status={status}
        tasks={tasks}
        presentations={presentationsFor(tasks)}
        emptyMessage="empty"
        isDropTarget={false}
        draggedTaskId={null}
        draggedTaskHeight={0}
        movingTaskId={null}
        settlingTaskId={null}
        contextMenuTaskId={null}
        availableLabels={[]}
        currentUser={USER}
        showCover={false}
        showBody={false}
        onCreateLabel={async () => {}}
        onCreate={() => {}}
        onEdit={() => {}}
        onUpdate={async (task) => task}
        onComplete={async () => {}}
        onContextMenu={() => {}}
        onDragStart={() => {}}
        onDragEnd={() => {}}
        onDragEnter={() => {}}
        onDrop={() => {}}
        onOpenConversation={() => {}}
        {...extra}
      />,
    );
  }

  it("shows 恢復建議排序 only on the todo column in manual mode", async () => {
    const onResetOrder = vi.fn();
    const view = renderColumn("todo", [], { orderMode: "manual", onResetOrder });
    fireEvent.click(screen.getByRole("button", { name: "恢復建議排序" }));
    await waitFor(() => expect(onResetOrder).toHaveBeenCalledTimes(1));
    view.unmount();

    renderColumn("todo", [], { orderMode: "suggested", onResetOrder }).unmount();
    expect(screen.queryByRole("button", { name: "恢復建議排序" })).toBeNull();
    renderColumn("in_progress", [], { orderMode: "manual", onResetOrder });
    expect(screen.queryByRole("button", { name: "恢復建議排序" })).toBeNull();
  });

  it("forwards 開工 and 停止 to the run callbacks", () => {
    const onStartRun = vi.fn();
    const onStopRun = vi.fn();
    const todo = makeTask("t1", "todo", { assignee: CLAUDE });
    const view = renderColumn("todo", [todo], { onStartRun, onStopRun });
    fireEvent.click(screen.getByRole("button", { name: "開工 T-t1" }));
    expect(onStartRun).toHaveBeenCalledWith(todo);
    view.unmount();

    const run = makeRun("r1", "running", { provider: "codex" });
    const working = makeTask("t2", "in_progress", { assignee: CODEX, activeRun: run, latestRun: run });
    renderColumn("in_progress", [working], { onStartRun, onStopRun });
    fireEvent.click(screen.getByRole("button", { name: "停止 T-t2" }));
    expect(onStopRun).toHaveBeenCalledWith(working);
  });
});

describe("MobileBoard run row", () => {
  it("offers 開工 on agent todo cards and 停止 with the provider chip on running cards", () => {
    const onStartRun = vi.fn();
    const onStopRun = vi.fn();
    const run = makeRun("r1", "running");
    const tasks = [
      makeTask("t1", "todo", { assignee: CLAUDE }),
      makeTask("t2", "in_progress", { assignee: CLAUDE, activeRun: run, latestRun: run }),
      makeTask("t3", "todo", { assignee: USER }),
    ];
    render(
      <MobileBoard
        tasksByStatus={groupTasks(tasks)}
        storage={{ getItem: () => "[]", setItem: () => {} }}
        onDrop={() => {}}
        onComplete={() => {}}
        onOpenTask={() => {}}
        onStartRun={onStartRun}
        onStopRun={onStopRun}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "開工 T-t1" }));
    expect(onStartRun).toHaveBeenCalledWith(tasks[0]);
    expect(screen.queryByRole("button", { name: "開工 T-t3" })).toBeNull();
    const card = screen.getByText("Task t2").closest("article")!;
    expect(within(card as HTMLElement).getByText("處理中 · Claude")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "停止 T-t2" }));
    expect(onStopRun).toHaveBeenCalledWith(tasks[1]);
  });
});

describe("Claude assignee", () => {
  it("ActorAvatar draws the Claude mark and keeps the Codex logo", () => {
    const { container } = render(<><ActorAvatar actor={CLAUDE} /><ActorAvatar actor={CODEX} /></>);
    expect(container.querySelector(".actor-avatar-claude .actor-claude-mark")).toBeTruthy();
    expect(container.querySelector("img[src='codex-agent-logo.png']")).toBeTruthy();
  });

  it("IssueListView assignee select offers Claude", () => {
    const task = makeTask("t1", "todo", { assignee: CLAUDE });
    render(
      <IssueListView
        scrollRef={{ current: null }}
        tasks={[task]}
        presentations={presentationsFor([task])}
        currentUser={USER}
        hasActiveFilters={false}
        onOpenTask={() => {}}
        onOpenConversation={() => {}}
        onUpdate={async (current) => current}
      />,
    );
    const select = screen.getByRole("combobox", { name: /T-t1/ }) as HTMLSelectElement;
    expect(select.value).toBe("claude-agent");
    expect([...select.options].map((option) => option.value)).toEqual(["current-user", "codex-agent", "claude-agent"]);
  });
});

describe("MobileAccessSettings", () => {
  const missing: MobileAccessInspection = { enabled: false, url: null, tailnetAddress: null, reason: "TAILSCALE_NOT_FOUND" };

  it("stage follows reason and tailnet address", () => {
    expect(stageOf(null)).toBe("unknown");
    expect(stageOf(missing)).toBe("tailscale-missing");
    expect(stageOf({ ...missing, enabled: true, url: "http://100.64.0.1:47833/" })).toBe("tailscale-missing");
    expect(stageOf({ enabled: false, url: null, tailnetAddress: "100.64.0.1" })).toBe("local-only");
    expect(stageOf({ enabled: true, url: "http://100.64.0.1:47833/", tailnetAddress: "100.64.0.1" })).toBe("enabled");
  });

  it("renders without client storage only for a 401 on a non-loopback host", () => {
    const unpaired = new Error("Taskboard storage returned 401");
    expect(canRenderWithoutClientStorage(unpaired, "relay-pc.tailnet.ts.net")).toBe(true);
    expect(canRenderWithoutClientStorage(unpaired, "127.0.0.1")).toBe(false);
    expect(canRenderWithoutClientStorage(new Error("Taskboard storage returned 500"), "relay-pc.tailnet.ts.net")).toBe(false);
    expect(canRenderWithoutClientStorage(new TypeError("Failed to fetch"), "relay-pc.tailnet.ts.net")).toBe(false);
  });

  it("recognises loopback page hosts", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("100.64.0.1")).toBe(false);
  });

  function fakeApi(inspection: MobileAccessInspection & Record<string, unknown>) {
    return {
      inspect: vi.fn(async () => inspection),
      setEnabled: vi.fn(async () => inspection),
      createChallenge: vi.fn(),
      approveChallenge: vi.fn(),
      completePairing: vi.fn(),
      listPairedDevices: vi.fn(async () => []),
      revokeDevice: vi.fn(),
    } as unknown as MobileAccessApi & { listPairedDevices: ReturnType<typeof vi.fn> };
  }

  it("shows 找不到 Tailscale while off and lists sessions from the inspection", async () => {
    const api = fakeApi({
      ...missing,
      sessions: [{
        id: "s1",
        deviceLabel: "我的 iPhone",
        expiresAt: "2026-10-17T00:00:00.000Z",
        revokedAt: null,
        createdAt: "2026-09-17T00:00:00.000Z",
        lastSeenAt: "2026-09-17T00:00:00.000Z",
      }],
      pendingChallenges: [],
    });
    const onOpenChange = vi.fn();
    render(<MobileAccessSettings api={api} open onOpenChange={onOpenChange} showTrigger={false} showPairingCompletion={false} />);

    expect(await screen.findByText("找不到 Tailscale（請先安裝並登入 Tailscale）")).toBeTruthy();
    expect(await screen.findByText("我的 iPhone")).toBeTruthy();
    expect(api.listPairedDevices).not.toHaveBeenCalled();
    expect(screen.queryByText("TAILSCALE_NOT_FOUND")).toBeNull();
    expect(screen.queryByRole("button", { name: "手機存取" })).toBeNull();
    expect((screen.getByRole("button", { name: "啟用手機存取" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "關閉" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});

describe("Amendment 10: scan-to-pair", () => {
  const CHALLENGE_ID = "c4a11e00-0000-4000-8000-000000000002";
  const SECRET = "TestPairingSecret00000000000000000000000000";
  const PHONE_BASE = "http://100.64.0.1:47833/";
  const session = { session: { id: "s1", deviceLabel: "iPhone", expiresAt: "2026-09-24T00:00:00.000Z" }, csrfToken: "csrf" };

  function phoneApi(overrides: Record<string, unknown> = {}) {
    return {
      inspect: vi.fn(),
      setEnabled: vi.fn(),
      createChallenge: vi.fn(),
      approveChallenge: vi.fn(),
      revokeChallenge: vi.fn(async () => ({ challengeId: CHALLENGE_ID, revoked: true })),
      completePairing: vi.fn(async () => session),
      completePairingWithShortCode: vi.fn(async () => session),
      listPairedDevices: vi.fn(async () => []),
      revokeDevice: vi.fn(),
      ...overrides,
    } as unknown as MobileAccessApi & Record<string, ReturnType<typeof vi.fn>>;
  }

  afterEach(() => {
    vi.useRealTimers();
    window.history.replaceState(null, "", "/");
  });

  it("pairing link carries the secret only in the fragment and fits the local QR", () => {
    const link = pairingLink("http://100.127.255.255:65535/", CHALLENGE_ID, SECRET)!;
    const url = new URL(link);
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#pair=${CHALLENGE_ID}.${SECRET}`);
    expect(readPairingFragment(link)).toEqual({ challengeId: CHALLENGE_ID, challengeCode: SECRET });
    expect(new TextEncoder().encode(link).length).toBeLessThanOrEqual(134);
    expect(createPairingQrDataUrl(link)).toMatch(/^data:image\/svg\+xml/);
    expect(readPairingFragment(`${PHONE_BASE}#pair=bad`)).toBeNull();
    expect(readPairingFragment(PHONE_BASE)).toBeNull();
  });

  it("auto-submits from the QR link once (StrictMode), scrubs the URL and goes to the board", async () => {
    window.history.replaceState({ keep: 1 }, "", `/?view=board#pair=${CHALLENGE_ID}.${SECRET}`);
    let resolve: (value: typeof session) => void = () => {};
    const api = phoneApi({ completePairing: vi.fn(() => new Promise((done) => { resolve = done; })) });
    const onPaired = vi.fn();
    render(
      <StrictMode>
        <PairingCompletion api={api} locationHref={`${PHONE_BASE}?view=board#pair=${CHALLENGE_ID}.${SECRET}`} onPaired={onPaired} />
      </StrictMode>,
    );
    expect(await screen.findByText("正在配對…")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("?view=board");
    expect(window.location.href.includes(SECRET)).toBe(false);
    expect(api.completePairing).toHaveBeenCalledTimes(1);
    expect(api.completePairing).toHaveBeenCalledWith(CHALLENGE_ID, SECRET);
    await act(async () => resolve(session));
    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: "手機配對" })).toBeNull();
  });

  it("waits for desktop approval without typing, then completes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const approvalRequired = new ApiError(409, { error: { code: "PAIRING_APPROVAL_REQUIRED", message: "Desktop approval is required" } });
    const completePairing = vi.fn()
      .mockRejectedValueOnce(approvalRequired)
      .mockResolvedValueOnce(session);
    const api = phoneApi({ completePairing });
    const onPaired = vi.fn();
    render(<PairingCompletion api={api} locationHref={`${PHONE_BASE}#pair=${CHALLENGE_ID}.${SECRET}`} onPaired={onPaired} />);
    expect(await screen.findByText("正在配對…等待電腦上按「允許」")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
    expect(completePairing).toHaveBeenCalledTimes(2);
  });

  it("falls back to the 6-digit form with a readable error when the link secret fails", async () => {
    const expired = new ApiError(410, { error: { code: "PAIRING_CHALLENGE_EXPIRED", message: "Pairing challenge expired" } });
    const api = phoneApi({ completePairing: vi.fn(async () => { throw expired; }) });
    render(<PairingCompletion api={api} locationHref={`${PHONE_BASE}#pair=${CHALLENGE_ID}.${SECRET}`} />);
    expect((await screen.findByRole("alert")).textContent).toBe("配對碼已過期，請在電腦上重新產生配對碼。");
    expect(screen.getByLabelText("6 位數配對碼")).toBeTruthy();
  });

  it("manual fallback: numeric keyboard, no error before submit, 6 digits only", async () => {
    const api = phoneApi();
    const onPaired = vi.fn();
    render(<PairingCompletion api={api} locationHref={PHONE_BASE} pairingRequired onPaired={onPaired} />);
    const input = screen.getByLabelText("6 位數配對碼") as HTMLInputElement;
    expect(input.getAttribute("inputmode")).toBe("numeric");
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
    expect(input.maxLength).toBe(6);
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.change(input, { target: { value: "12" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "完成配對" }));
    expect((await screen.findByRole("alert")).textContent).toBe("請輸入電腦上顯示的 6 位數配對碼");
    expect(api.completePairingWithShortCode).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "12a3 4567" } });
    expect(input.value).toBe("123456");
    fireEvent.click(screen.getByRole("button", { name: "完成配對" }));
    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
    expect(api.completePairingWithShortCode).toHaveBeenCalledWith("123456");
    expect(api.completePairing).not.toHaveBeenCalled();
  });

  it("manual fallback shows the lockout message", async () => {
    const locked = new ApiError(429, { error: { code: "PAIRING_ATTEMPTS_EXCEEDED", message: "limit" } });
    const api = phoneApi({ completePairingWithShortCode: vi.fn(async () => { throw locked; }) });
    render(<PairingCompletion api={api} locationHref={PHONE_BASE} pairingRequired />);
    fireEvent.change(screen.getByLabelText("6 位數配對碼"), { target: { value: "654321" } });
    fireEvent.click(screen.getByRole("button", { name: "完成配對" }));
    expect((await screen.findByRole("alert")).textContent).toContain("錯誤次數過多");
  });

  it("renders nothing on this PC or on an already-paired phone page", () => {
    const api = phoneApi();
    const { container } = render(<>
      <PairingCompletion api={api} locationHref={`http://127.0.0.1:47833/#pair=${CHALLENGE_ID}.${SECRET}`} />
      <PairingCompletion api={api} locationHref={PHONE_BASE} pairingRequired={false} />
    </>);
    expect(container.innerHTML).toBe("");
    expect(api.completePairing).not.toHaveBeenCalled();
  });

  it("desktop 產生配對碼 approves at once and shows the QR plus a large 6-digit code; × revokes", async () => {
    const inspection = {
      enabled: true, url: PHONE_BASE, tailnetAddress: "100.64.0.1", sessions: [], pendingChallenges: [],
    };
    const api = phoneApi({
      inspect: vi.fn(async () => inspection),
      createChallenge: vi.fn(async () => ({
        challengeId: CHALLENGE_ID, challengeCode: SECRET, shortCode: "042917", deviceLabel: "我的手機",
        expiresAt: "2999-01-01T00:05:00.000Z", approved: false, approvedAt: null,
      })),
      approveChallenge: vi.fn(async () => ({
        challengeId: CHALLENGE_ID, deviceLabel: "我的手機", expiresAt: "2999-01-01T00:05:00.000Z", approvedAt: "2999-01-01T00:00:00.000Z",
      })),
    });
    render(<MobileAccessSettings api={api} open showTrigger={false} showPairingCompletion={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "產生配對碼" }));
    expect(await screen.findByAltText("用手機相機掃描即可自動配對")).toBeTruthy();
    expect(api.approveChallenge).toHaveBeenCalledWith(CHALLENGE_ID);
    expect(screen.getByLabelText("6 位數配對碼").textContent).toBe("042917");
    expect(screen.queryByRole("button", { name: "允許" })).toBeNull();
    expect(document.body.textContent?.includes(SECRET)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "取消這個配對請求" }));
    await waitFor(() => expect(api.revokeChallenge).toHaveBeenCalledWith(CHALLENGE_ID));
    expect(screen.queryByLabelText("6 位數配對碼")).toBeNull();
  });
});

describe("W3: live activity merge during load", () => {
  it("seedTaskRunActivity keeps live events the snapshot lacks and drops duplicates", () => {
    const early = { kind: "command", text: "npm test", at: "2026-09-17T01:00:01.000Z" };
    const live = { kind: "file", text: "a.txt", at: "2026-09-17T01:00:02.000Z" };
    const merged = seedTaskRunActivity({ runId: "r1", items: [early, live] }, "r1", [early]);
    expect(merged).toEqual({ runId: "r1", items: [early, live] });
    // A null live run id (event arrived before any seed) is merged too.
    expect(seedTaskRunActivity({ runId: null, items: [live] }, "r1", [early]).items).toEqual([early, live]);
    // A different run starts from the seed only.
    expect(seedTaskRunActivity({ runId: "r0", items: [live] }, "r1", [early])).toEqual({ runId: "r1", items: [early] });
  });

  it("TaskRunPanel does not overwrite run.activity events that arrive while GET runs is loading", async () => {
    const run = makeRun("r1", "running");
    let resolveFetch: (response: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));
    const task = makeTask("t1", "in_progress", { assignee: CLAUDE, activeRun: run, latestRun: run });
    render(<TaskRunPanel task={task} />);

    act(() => {
      publishTaskRunEvent({ type: "run.activity", taskId: "t1", runId: "r1", activity: { kind: "file", text: "live.txt", at: "2026-09-17T01:00:05.000Z" } });
    });
    await act(async () => {
      resolveFetch(jsonResponse({
        runs: [{ ...run, openUrl: null }],
        followups: [],
        activity: [{ kind: "command", text: "seeded command", at: "2026-09-17T01:00:01.000Z" }],
        activityRunId: "r1",
      }));
    });

    expect(await screen.findByText("seeded command")).toBeTruthy();
    expect(screen.getByText("live.txt")).toBeTruthy();
  });
});

describe("W3: Codex open-in-App and 複製對話編號", () => {
  const THREAD = "019a2b3c-4d5e-7f80-9123-456789abcdef";

  function renderInProgressColumn(task: Task) {
    return render(
      <BoardColumn
        scrollRef={() => {}}
        status="in_progress"
        tasks={[task]}
        presentations={presentationsFor([task])}
        emptyMessage="empty"
        isDropTarget={false}
        draggedTaskId={null}
        draggedTaskHeight={0}
        movingTaskId={null}
        settlingTaskId={null}
        contextMenuTaskId={null}
        availableLabels={[]}
        currentUser={USER}
        showCover={false}
        showBody={false}
        onCreateLabel={async () => {}}
        onCreate={() => {}}
        onEdit={() => {}}
        onUpdate={async (next) => next}
        onComplete={async () => {}}
        onContextMenu={() => {}}
        onDragStart={() => {}}
        onDragEnd={() => {}}
        onDragEnter={() => {}}
        onDrop={() => {}}
        onOpenConversation={() => {}}
        onStopRun={() => {}}
        onOpenRunInApp={() => {}}
      />,
    );
  }

  it("only offers the Codex App link when the run is not active", () => {
    expect(taskRunHasAppLink(makeRun("r1", "running", { provider: "codex", codexThreadId: THREAD }))).toBe(false);
    expect(taskRunHasAppLink(makeRun("r1", "starting", { provider: "codex", codexThreadId: THREAD }))).toBe(false);
    expect(taskRunHasAppLink(makeRun("r1", "finished", { provider: "codex", codexThreadId: THREAD }))).toBe(true);
    expect(taskRunHasAppLink(makeRun("r1", "running", { claudeBridgeSessionId: "bridge" }))).toBe(true);
    expect(taskRunConversationId(makeRun("r1", "running", { provider: "codex", codexThreadId: THREAD }))).toBe(THREAD);
    expect(taskRunConversationId(makeRun("r1", "running", { claudeShortId: "abc" }))).toBeNull();
  });

  it("TaskRunPanel hides 在 App 開啟 for an active Codex run and copies the full thread id", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    const run = makeRun("r1", "running", { provider: "codex", codexThreadId: THREAD });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      runs: [{ ...run, openUrl: `codex://threads/${THREAD}` }],
      followups: [],
      activity: [],
    })));
    const task = makeTask("t1", "in_progress", { assignee: CODEX, activeRun: run, latestRun: run });
    render(<TaskRunPanel task={task} />);

    const copy = await screen.findByRole("button", { name: `複製對話編號 ${THREAD}` });
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByText("在 App 開啟")).toBeNull();
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(THREAD));
    expect(await screen.findByText("已複製")).toBeTruthy();
  });

  it("TaskRunPanel offers 在 App 開啟 once the Codex run has ended", async () => {
    const run = makeRun("r1", "finished", { provider: "codex", codexThreadId: THREAD, resultText: "ok" });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      runs: [{ ...run, openUrl: `codex://threads/${THREAD}` }],
      followups: [],
      activity: [],
    })));
    render(<TaskRunPanel task={makeTask("t1", "in_review", { assignee: CODEX, latestRun: run })} />);
    const link = await screen.findByText("在 App 開啟");
    expect(link.getAttribute("href")).toBe(`codex://threads/${THREAD}`);
    expect(screen.getByRole("button", { name: `複製對話編號 ${THREAD}` })).toBeTruthy();
  });

  it("the board card hides 在 App 開啟 for a running Codex card but keeps 複製對話編號", () => {
    const run = makeRun("r1", "running", { provider: "codex", codexThreadId: THREAD });
    const working = makeTask("t2", "in_progress", { assignee: CODEX, activeRun: run, latestRun: run });
    const view = renderInProgressColumn(working);
    expect(screen.queryByRole("button", { name: "在 App 開啟 T-t2" })).toBeNull();
    expect(screen.getByRole("button", { name: `複製對話編號 ${THREAD}` })).toBeTruthy();
    view.unmount();

    const ended = makeRun("r1", "stopped", { provider: "codex", codexThreadId: THREAD });
    renderInProgressColumn(makeTask("t3", "in_progress", { assignee: CODEX, activeRun: null, latestRun: ended }));
    expect(screen.getByRole("button", { name: "在 App 開啟 T-t3" })).toBeTruthy();
  });
});

describe("W3: waiting for permission", () => {
  const WAITING = "WAITING_FOR_PERMISSION: Bash";
  const MESSAGE = "AI 在等待權限確認，請到 App 查看";

  it("maps the raw error to the Traditional Chinese instruction and leaves other errors alone", () => {
    const text = (chinese: string) => chinese;
    expect(taskRunErrorText(WAITING, text)).toBe(MESSAGE);
    expect(taskRunErrorText("boom", text)).toBe("boom");
    expect(taskRunErrorText(null, text)).toBeNull();
  });

  it("shows the instruction on the phone card and the detail panel", async () => {
    const run = makeRun("r1", "running", { claudeBridgeSessionId: "bridge", error: WAITING });
    const task = makeTask("t2", "in_progress", { assignee: CLAUDE, activeRun: run, latestRun: run });
    const board = render(
      <MobileBoard
        tasksByStatus={groupTasks([task])}
        storage={{ getItem: () => "[]", setItem: () => {} }}
        onDrop={() => {}}
        onComplete={() => {}}
        onOpenTask={() => {}}
        onStopRun={() => {}}
      />,
    );
    expect(screen.getByText(MESSAGE)).toBeTruthy();
    expect(screen.queryByText(WAITING)).toBeNull();
    board.unmount();

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ runs: [{ ...run, openUrl: null }], followups: [], activity: [] })));
    render(<TaskRunPanel task={task} />);
    expect(await screen.findByText(MESSAGE)).toBeTruthy();
    expect(screen.queryByText(WAITING)).toBeNull();
  });

  it("shows the instruction on the board card", () => {
    const run = makeRun("r1", "running", { claudeBridgeSessionId: "bridge", error: WAITING });
    const task = makeTask("t4", "in_progress", { assignee: CLAUDE, activeRun: run, latestRun: run });
    render(
      <BoardColumn
        scrollRef={() => {}}
        status="in_progress"
        tasks={[task]}
        presentations={presentationsFor([task])}
        emptyMessage="empty"
        isDropTarget={false}
        draggedTaskId={null}
        draggedTaskHeight={0}
        movingTaskId={null}
        settlingTaskId={null}
        contextMenuTaskId={null}
        availableLabels={[]}
        currentUser={USER}
        showCover={false}
        showBody={false}
        onCreateLabel={async () => {}}
        onCreate={() => {}}
        onEdit={() => {}}
        onUpdate={async (next) => next}
        onComplete={async () => {}}
        onContextMenu={() => {}}
        onDragStart={() => {}}
        onDragEnd={() => {}}
        onDragEnter={() => {}}
        onDrop={() => {}}
        onOpenConversation={() => {}}
        onStopRun={() => {}}
      />,
    );
    expect(screen.getByText(MESSAGE)).toBeTruthy();
    expect(screen.queryByText(WAITING)).toBeNull();
  });
});

describe("W3: v2 error codes show Traditional Chinese", () => {
  it("maps run-control codes and falls back to the message or the fallback", () => {
    const text = (chinese: string) => chinese;
    for (const code of ["LOCAL_AI_LOOPBACK_REQUIRED", "AUTO_CLAIM_WRITE_REQUIRES_LOCAL", "LOCAL_COMPANION_REQUIRED", "TASK_NOT_CONTINUABLE", "NO_PREVIOUS_RUN", "RUN_STOP_FAILED"]) {
      expect(RUN_ERROR_TEXT[code]).toBeTruthy();
      const error = new ApiError(409, { error: { code, message: "english developer text" } });
      expect(runErrorMessage(error, text, "fallback")).toBe(RUN_ERROR_TEXT[code][0]);
    }
    expect(runErrorMessage(new ApiError(500, { error: { code: "OTHER", message: "raw" } }), text, "fallback")).toBe("raw");
    expect(runErrorMessage("nope", text, "fallback")).toBe("fallback");
  });
});

describe("W3: client storage writes carry the phone CSRF token", () => {
  it("adds x-relay-csrf only when the phone has a token", () => {
    expect(mobileCsrfWriteHeaders({ "content-type": "application/json" })).toEqual({ "content-type": "application/json" });
    window.sessionStorage.setItem(MOBILE_CSRF_STORAGE_KEY, "csrf-1");
    expect(mobileCsrfWriteHeaders({ "content-type": "application/json" })).toEqual({
      "content-type": "application/json",
      [MOBILE_CSRF_HEADER]: "csrf-1",
    });
  });
});

describe("W4: follow-up delivery states (送出中 / 已送達 / 已改排隊)", () => {
  const text = (chinese: string) => chinese;
  function followup(overrides: Partial<TaskFollowup> = {}): TaskFollowup {
    return {
      id: "f1",
      taskId: "t1",
      runId: "r1",
      body: "只做到 3",
      mode: "steer",
      status: "pending",
      error: null,
      createdAt: "2026-09-17T01:00:00.000Z",
      sentAt: null,
      ...overrides,
    };
  }

  it("maps each follow-up state to a status line", () => {
    expect(followupDeliveryState(followup(), "Claude", text).message).toMatch(/^插嘴送出中/);
    expect(followupDeliveryState(followup({ status: "sent" }), "Claude", text)).toEqual({ kind: "notice", message: "已送達 Claude。" });
    expect(followupDeliveryState(followup({ mode: "queue", error: "STEER_NOT_DELIVERED_QUEUED" }), "Claude", text))
      .toEqual({ kind: "notice", message: STEER_QUEUED_TEXT });
    expect(STEER_QUEUED_TEXT).toBe("插嘴沒有送達（AI 正在執行長指令），已改為排隊，本輪結束後送出");
    expect(followupDeliveryState(followup({ mode: "queue" }), "Codex", text).message).toMatch(/^已排隊/);
    expect(followupDeliveryState(followup({ status: "failed", error: "STEER_NOT_DELIVERED_RUN_ENDED" }), "Claude", text).kind).toBe("error");
  });

  it("FollowupComposer answers at once and follows followup.updated", async () => {
    const accepted = followup();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ followup: accepted }, 202)));
    const run = makeRun("r1", "running");
    const task = makeTask("t1", "in_progress", { assignee: CLAUDE, activeRun: run, latestRun: run });
    render(<FollowupComposer task={task} run={run} />);

    fireEvent.change(screen.getByLabelText("追加訊息"), { target: { value: "只做到 3" } });
    fireEvent.click(screen.getByRole("button", { name: "插嘴" }));
    fireEvent.click(await screen.findByRole("button", { name: "確定插嘴" }));
    expect(await screen.findByText(/插嘴送出中/)).toBeTruthy();

    act(() => {
      publishTaskRunEvent({ type: "followup.updated", taskId: "t1", followup: followup({ mode: "queue", error: "STEER_NOT_DELIVERED_QUEUED" }) });
    });
    expect(await screen.findByText(STEER_QUEUED_TEXT)).toBeTruthy();

    act(() => {
      publishTaskRunEvent({ type: "followup.updated", taskId: "t1", followup: followup({ id: "other", status: "failed", error: "x" }) });
      publishTaskRunEvent({ type: "followup.updated", taskId: "t1", followup: followup({ mode: "queue", status: "sent", error: "STEER_NOT_DELIVERED_QUEUED" }) });
    });
    // W5 bug D: a converted steer that was sent later reads as queued-and-sent, not as a failure.
    expect(await screen.findByText("已改為排隊並已送出")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("TaskRunPanel lists a converted steer with the queued explanation", async () => {
    const run = makeRun("r1", "running");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      runs: [{ ...run, openUrl: null }],
      followups: [followup({ mode: "queue", error: "STEER_NOT_DELIVERED_QUEUED" }), followup({ id: "f2", body: "第二則" })],
      activity: [],
    })));
    render(<TaskRunPanel task={makeTask("t1", "in_progress", { assignee: CLAUDE, activeRun: run, latestRun: run })} />);
    expect(await screen.findByText(STEER_QUEUED_TEXT)).toBeTruthy();
    expect(screen.getByText("送出中")).toBeTruthy();
    expect(screen.queryByText("STEER_NOT_DELIVERED_QUEUED")).toBeNull();
  });
});

describe("W4: missing project folder and Codex open-in-App fallback", () => {
  it("WORKSPACE_NOT_FOUND shows the server's folder message", () => {
    const text = (chinese: string) => chinese;
    const error = new ApiError(409, { error: { code: "WORKSPACE_NOT_FOUND", message: "專案資料夾不存在：C:\\work\\ROOT" } });
    expect(runErrorMessage(error, text, "fallback")).toBe("專案資料夾不存在：C:\\work\\ROOT");
    expect(runErrorTextPair(error)?.[1]).toBe("Project folder does not exist: C:\\work\\ROOT");
  });

  it("an active Codex run blocks falling back to an older run", () => {
    const THREAD_OLD = "old-thread";
    const older = { ...makeRun("r-old", "finished", { provider: "codex", codexThreadId: THREAD_OLD }), openUrl: `codex://threads/${THREAD_OLD}` };
    const active = { ...makeRun("r-new", "running", { provider: "codex", codexThreadId: "new-thread", createdAt: "2026-09-17T02:00:00.000Z" }), openUrl: "codex://threads/new-thread" };
    expect(pickTaskRunAppUrl([active, older], "r-old")).toEqual({ blocked: "codex-run-active" });
    expect(CODEX_RUN_ACTIVE_APP_TEXT).toBe("任務執行中，完成後才能在 Codex App 開啟");
    expect(pickTaskRunAppUrl([older], "r-old")).toEqual({ url: `codex://threads/${THREAD_OLD}` });
    const claude = { ...makeRun("c1", "running", { claudeBridgeSessionId: "bridge" }), openUrl: "claude://claude.ai/epitaxy/bridge" };
    expect(pickTaskRunAppUrl([claude], "c1")).toEqual({ url: "claude://claude.ai/epitaxy/bridge" });
    expect(pickTaskRunAppUrl([], null)).toBeNull();
  });
});

describe("W5: permission-waiting steer, converted-and-sent, canceled after run end, Claude permission mode", () => {
  const text = (chinese: string) => chinese;
  function followup(overrides: Partial<TaskFollowup> = {}): TaskFollowup {
    return {
      id: "f1",
      taskId: "t1",
      runId: "r1",
      body: "先停一下",
      mode: "queue",
      status: "pending",
      error: null,
      createdAt: "2026-09-17T01:00:00.000Z",
      sentAt: null,
      ...overrides,
    };
  }

  it("maps the new server markers to people-facing text (never a failure for converted-and-sent)", () => {
    expect(STEER_WAITING_PERMISSION_TEXT).toBe("AI 正在等待權限確認，訊息已改為排隊；請先到 App 處理確認");
    expect(followupDeliveryState(followup({ error: "STEER_WAITING_PERMISSION_QUEUED" }), "Claude", text))
      .toEqual({ kind: "notice", message: STEER_WAITING_PERMISSION_TEXT });
    for (const error of ["STEER_NOT_DELIVERED_QUEUED", "STEER_WAITING_PERMISSION_QUEUED"]) {
      const sent = followup({ status: "sent", error, sentAt: "2026-09-17T01:05:00.000Z" });
      expect(followupDeliveryState(sent, "Claude", text)).toEqual({ kind: "notice", message: "已改為排隊並已送出" });
      expect(followupNote(sent, text)).toEqual({ kind: "notice", message: STEER_QUEUED_SENT_TEXT });
    }
    const canceled = followup({ status: "canceled", error: "RUN_ENDED" });
    expect(followupDeliveryState(canceled, "Codex", text)).toEqual({ kind: "notice", message: "任務已結束，排隊訊息已取消" });
    expect(followupNote(canceled, text)).toEqual({ kind: "notice", message: RUN_ENDED_CANCELED_TEXT });
    expect(followupNote(followup({ mode: "steer", status: "failed", error: "STEER_INTERRUPTED_BY_RESTART" }), text)?.kind).toBe("error");
    expect(followupNote(followup({ status: "failed", error: "rc=5" }), text)).toEqual({ kind: "error", message: "rc=5" });
    expect(followupNote(followup(), text)).toBeNull();
  });

  it("TaskRunPanel lists converted-and-sent as a notice and a canceled message with the run-ended text", async () => {
    const run = makeRun("r1", "running");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      runs: [{ ...run, openUrl: null }],
      followups: [
        followup({ status: "sent", error: "STEER_NOT_DELIVERED_QUEUED", sentAt: "2026-09-17T01:05:00.000Z" }),
        followup({ id: "f2", body: "第二則", error: "STEER_WAITING_PERMISSION_QUEUED" }),
        followup({ id: "f3", body: "第三則", status: "canceled", error: "RUN_ENDED" }),
      ],
      activity: [],
    })));
    render(<TaskRunPanel task={makeTask("t1", "in_progress", { assignee: CLAUDE, activeRun: run, latestRun: run })} />);
    const sentNote = await screen.findByText(STEER_QUEUED_SENT_TEXT);
    expect(sentNote.className).toBe("task-run-notice");
    expect(screen.getByText(STEER_WAITING_PERMISSION_TEXT).className).toBe("task-run-notice");
    expect(screen.getByText(RUN_ENDED_CANCELED_TEXT).className).toBe("task-run-notice");
    expect(screen.queryByText(STEER_QUEUED_TEXT)).toBeNull();
    expect(screen.queryByText("RUN_ENDED")).toBeNull();
  });

  it("ProjectAutomationMenu shows 「Claude 權限」 and saves claudePermissionMode", async () => {
    const automation = {
      projectId: "p1",
      enabled: false,
      maxParallel: 3,
      claudeModel: null,
      codexModel: null,
      codexEffort: null,
      orderMode: "suggested",
      claudePermissionMode: "bypassPermissions",
      updatedAt: "2026-09-17T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return jsonResponse({ automation: { ...automation, ...JSON.parse(String(init.body)) } });
      }
      return jsonResponse({ automation });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectAutomationMenu projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "自動化" }));
    const select = await screen.findByLabelText("Claude 權限") as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe("bypassPermissions");
    expect(Array.from(select.options).map((option) => [option.value, option.textContent])).toEqual([
      ["followClaude", "跟著 Claude 設定"],
      ["bypassPermissions", "完整權限（不會停下來問，AI 可執行任何指令）"],
      ["acceptEdits", "只自動允許改檔（執行指令時會停下來等你到 App 確認）"],
    ]);
    // The Claude settings preview only shows while 「跟著 Claude 設定」 is chosen (and the server sent one).
    expect(screen.queryByText(/目前 Claude 設定/)).toBeNull();
    fireEvent.change(select, { target: { value: "acceptEdits" } });
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
      expect(put).toBeTruthy();
      expect(JSON.parse(String(put![1]!.body))).toEqual({ claudePermissionMode: "acceptEdits" });
    });
    await waitFor(() => expect(select.value).toBe("acceptEdits"));
  });

  it("Amendment 6: 「跟著 Claude 設定」 is the default and shows the detected Claude setting", async () => {
    const automation = {
      projectId: "p1",
      enabled: false,
      maxParallel: 3,
      claudeModel: null,
      codexModel: null,
      codexEffort: null,
      orderMode: "suggested",
      claudePermissionMode: "followClaude",
      updatedAt: "2026-09-17T00:00:00.000Z",
    };
    let preview: Record<string, unknown> = {
      claudeEffectivePermissionMode: "acceptEdits",
      claudePermissionSource: { scope: "project", path: "C:\\work\\.claude\\settings.json", configuredMode: "acceptEdits" },
    };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return jsonResponse({ automation: { ...automation, ...JSON.parse(String(init.body)) } });
      }
      return jsonResponse({ automation, ...preview });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectAutomationMenu projectId="p1" />);
    const trigger = screen.getByRole("button", { name: "自動化" });
    fireEvent.click(trigger);
    const select = await screen.findByLabelText("Claude 權限") as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe("followClaude");
    expect(await screen.findByText("目前 Claude 設定：acceptEdits（來源：專案 .claude/settings.json）")).toBeTruthy();

    // Switching away hides the preview; switching back shows it again.
    fireEvent.change(select, { target: { value: "bypassPermissions" } });
    await waitFor(() => expect(screen.queryByText(/目前 Claude 設定/)).toBeNull());
    fireEvent.change(select, { target: { value: "followClaude" } });
    expect(await screen.findByText(/目前 Claude 設定：acceptEdits/)).toBeTruthy();

    // Reopening reloads: no Claude setting → the fallback is explained.
    preview = { claudeEffectivePermissionMode: null, claudePermissionSource: null };
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(await screen.findByText("目前 Claude 設定：沒有設定預設權限，看板會用完整權限（bypassPermissions）")).toBeTruthy();
  });

  it("Amendment 6: preview text for ignored project modes and the run permission line", () => {
    const text = (chinese: string) => chinese;
    expect(claudePermissionPreviewText({
      claudeEffectivePermissionMode: "default",
      claudePermissionSource: { scope: "projectLocal", path: null, configuredMode: "bypassPermissions" },
    }, text)).toBe("目前 Claude 設定：default（來源：專案 .claude/settings.local.json；專案設定裡的 bypassPermissions 不會生效）");
    expect(claudePermissionPreviewText({
      claudeEffectivePermissionMode: null,
      claudePermissionSource: { scope: "project", path: null, configuredMode: "auto" },
    }, text)).toBe("目前 Claude 設定：Claude 內建預設（來源：專案 .claude/settings.json；專案設定裡的 auto 不會生效）");
    expect(claudePermissionPreviewText({
      claudeEffectivePermissionMode: "default",
      claudePermissionSource: { scope: "user", path: null, configuredMode: "manual" },
    }, text)).toBe("目前 Claude 設定：default（來源：使用者 settings.json）");

    const run = {
      id: "r1", taskId: "t1", provider: "claude" as const, status: "running" as const,
      claudeShortId: null, claudeSessionId: null, claudeBridgeSessionId: null, codexThreadId: null, codexTurnId: null,
      resultText: null, error: null, startedAt: null, endedAt: null, createdAt: "x", updatedAt: "x",
    };
    expect(taskRunClaudePermissionText({ ...run, claudePermissionMode: "acceptEdits", claudePermissionSource: "project" }, text))
      .toBe("Claude 權限：acceptEdits（專案 .claude/settings.json）");
    expect(taskRunClaudePermissionText({ ...run, claudePermissionMode: "bypassPermissions", claudePermissionSource: "fallback" }, text))
      .toBe("Claude 權限：bypassPermissions（Claude 沒有設定，看板預設）");
    expect(taskRunClaudePermissionText({ ...run, claudePermissionMode: null, claudePermissionSource: "project" }, text))
      .toBe("Claude 權限：Claude 內建預設（專案 .claude/settings.json）");
    expect(taskRunClaudePermissionText(run, text)).toBeNull();
    expect(taskRunClaudePermissionText({ ...run, provider: "codex", claudePermissionSource: "board" }, text)).toBeNull();
  });
});

describe("DBG-10: client ids without crypto.randomUUID (http phone origin)", () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("falls back to getRandomValues when randomUUID is missing or throws", () => {
    const real = globalThis.crypto;
    const getRandomValues = <T extends ArrayBufferView | null>(array: T) => real.getRandomValues(array as never) as T;
    const ids = new Set(Array.from({ length: 50 }, () => newClientId({ getRandomValues })));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(newClientId({
      randomUUID: () => { throw new TypeError("randomUUID requires a secure context"); },
      getRandomValues,
    })).toMatch(UUID_V4);
    expect(newClientId({})).toMatch(UUID_V4);
    expect(newClientId({ randomUUID: () => "from-random-uuid", getRandomValues })).toBe("from-random-uuid");
  });

  it("global crypto without randomUUID still produces ids and sends the pairing request", async () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real), subtle: real.subtle });
    expect((globalThis.crypto as Partial<Crypto>).randomUUID).toBeUndefined();
    expect(newClientId()).toMatch(UUID_V4);

    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({
      challengeId: "c1", challengeCode: "secret", shortCode: "123456", expiresAt: "2026-09-17T02:00:00.000Z", deviceLabel: "phone",
    }, 201));
    const api = createMobileAccessApi(fetchMock as unknown as typeof fetch);
    await api.createChallenge("phone");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.requestKey).toMatch(UUID_V4);
  });
});

describe("E1/E2: board embedded in the Codex App (sandboxed iframe, about:blank location)", () => {
  const THREAD = "019a2b3c-4d5e-7f80-9123-456789abcdef";
  const EMBED_BASE = "http://127.0.0.1:9241/instance-token/?host=codex";
  let base: HTMLBaseElement | null = null;
  let restoreParent: (() => void) | null = null;

  function embedFrame() {
    base = document.createElement("base");
    base.href = EMBED_BASE;
    document.head.appendChild(base);
    const postMessage = vi.fn();
    const original = Object.getOwnPropertyDescriptor(window, "parent");
    Object.defineProperty(window, "parent", { value: { postMessage }, configurable: true });
    restoreParent = () => {
      if (original) Object.defineProperty(window, "parent", original);
      else delete (window as { parent?: unknown }).parent;
    };
    return postMessage;
  }

  afterEach(() => {
    base?.remove();
    base = null;
    restoreParent?.();
    restoreParent = null;
  });

  it("openRunAppUrl: embedded Codex thread goes through the host bridge, other schemes do not navigate", () => {
    const post = vi.fn();
    const assign = vi.fn();
    expect(openRunAppUrl(`codex://threads/${THREAD}`, { embedded: true, postHostMessage: post, assign })).toBe("host-bridge");
    expect(post).toHaveBeenCalledWith({ type: "taskboard:open-thread", payload: { threadId: THREAD, legacyLocal: true } });
    expect(openRunAppUrl("claude://session/abc", { embedded: true, postHostMessage: post, assign })).toBe("unsupported-embedded");
    expect(assign).not.toHaveBeenCalled();
    expect(openRunAppUrl("claude://session/abc", { embedded: false, postHostMessage: post, assign })).toBe("navigated");
    expect(assign).toHaveBeenCalledWith("claude://session/abc");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("E2: page hostname and embed flag come from the base URI, not the empty frame location", () => {
    const frame = { parent: {} as Window } as Pick<Window, "parent">;
    expect(isEmbeddedHostFrame(EMBED_BASE, frame)).toBe(true);
    expect(isEmbeddedHostFrame("http://127.0.0.1:9241/instance-token/", frame)).toBe(false);
    const self = {} as { parent: unknown };
    self.parent = self;
    expect(isEmbeddedHostFrame(EMBED_BASE, self as Pick<Window, "parent">)).toBe(false);
    expect(taskboardPageHostname(EMBED_BASE, "")).toBe("127.0.0.1");
    expect(isLoopbackHostname(taskboardPageHostname(EMBED_BASE, ""))).toBe(true);
    expect(taskboardPageHostname("about:blank", "100.64.0.1")).toBe("100.64.0.1");
    expect(canRenderWithoutClientStorage(new Error("Request failed 401"), taskboardPageHostname(EMBED_BASE, ""))).toBe(false);
  });

  it("TaskRunPanel 在 App 開啟 uses the host bridge when embedded", async () => {
    const postMessage = embedFrame();
    const run = makeRun("r1", "finished", { provider: "codex", codexThreadId: THREAD, resultText: "ok" });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      runs: [{ ...run, openUrl: `codex://threads/${THREAD}` }],
      followups: [],
      activity: [],
    })));
    render(<TaskRunPanel task={makeTask("t1", "in_review", { assignee: CODEX, latestRun: run })} />);
    fireEvent.click(await screen.findByText("在 App 開啟"));
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0]).toMatchObject({
      type: "taskboard:open-thread",
      payload: { threadId: THREAD, legacyLocal: true },
    });
  });

  it("TaskRunPanel shows a hint instead of navigating for a Claude link when embedded", async () => {
    const postMessage = embedFrame();
    const run = makeRun("r1", "finished", { claudeBridgeSessionId: "bridge-1", resultText: "ok" });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      runs: [{ ...run, openUrl: "claude://resume/bridge-1" }],
      followups: [],
      activity: [],
    })));
    render(<TaskRunPanel task={makeTask("t1", "in_review", { assignee: CLAUDE, latestRun: run })} />);
    fireEvent.click(await screen.findByText("在 App 開啟"));
    expect(postMessage).not.toHaveBeenCalled();
    expect(await screen.findByText(RUN_APP_LINK_EMBEDDED_TEXT[0])).toBeTruthy();
  });
});

describe("DBG-09: send back for rework uploads the comment attachments before the card moves to todo", () => {
  async function renderRework(options: { reworkStatus?: number; draft?: string } = {}) {
    const run = makeRun("r1", "finished", { resultText: "done" });
    const task = makeTask("t1", "in_review", { assignee: CLAUDE, latestRun: run });
    const calls: string[] = [];
    const reworkBodies: unknown[] = [];
    let reworkStatus = options.reworkStatus ?? 200;
    if (options.draft) taskboardStorage.setItem("taskboard.comment-draft.t1", options.draft);
    const comment = {
      id: "c1", taskId: "t1", body: options.draft ?? "", authorType: "user", authorId: USER.id, authorName: USER.name,
      authorAvatarUrl: null, threadId: null, threadBinding: null, legacyLocalThreadId: null, attachments: [],
      version: 1, createdAt: "2026-09-17T02:00:00.000Z", updatedAt: "2026-09-17T02:00:00.000Z",
    };
    const attachment = {
      id: "a1", taskId: "t1", commentId: "c1", kind: "attachment", filename: "需求.txt", contentType: "text/plain",
      size: 3, createdAt: "2026-09-17T02:00:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = init?.method ?? "GET";
      const path = new URL(url, "http://127.0.0.1/").pathname;
      if (method !== "GET") calls.push(`${method} ${path}`);
      if (method === "POST" && path.endsWith("/api/tasks/t1/comments")) return jsonResponse({ comment }, 201);
      if (method === "POST" && path.endsWith("/api/comments/c1/attachments")) return jsonResponse({ attachment }, 201);
      if (method === "PATCH" && path.endsWith("/api/comments/c1")) {
        const patched = JSON.parse(String(init?.body ?? "{}")) as { body?: string };
        return jsonResponse({ comment: { ...comment, body: patched.body ?? comment.body, version: 2, attachments: [attachment] } });
      }
      if (method === "POST" && path.endsWith("/rework")) {
        reworkBodies.push(JSON.parse(String(init?.body ?? "{}")));
        if (reworkStatus === 403) {
          return jsonResponse({ error: { code: "LOCAL_AI_LOOPBACK_REQUIRED", message: "AI runs can only be started or controlled from this device or a paired phone" } }, 403);
        }
        return jsonResponse({ task: { ...task, status: "todo" }, comment }, 200);
      }
      if (path.endsWith("/api/tasks/t1")) return jsonResponse({ task });
      if (path.endsWith("/comments")) return jsonResponse({ comments: [] });
      if (path.endsWith("/activities")) return jsonResponse({ activities: [] });
      if (path.endsWith("/attachments")) return jsonResponse({ attachments: [] });
      if (path.endsWith("/runs")) return jsonResponse({ runs: [{ ...run, openUrl: null }], followups: [], activity: [] });
      return jsonResponse({});
    }));
    const onUpdate = vi.fn(async (current: Task, changes: Partial<Task>) => {
      calls.push(`onUpdate status=${String(changes.status)}`);
      return { ...current, ...changes } as Task;
    });
    const { TaskDetail } = await import("./components/TaskDetail");
    const view = render(
      <TaskDetail
        task={task}
        tasks={[task]}
        referenceTasks={[task]}
        currentUser={USER}
        availableLabels={[]}
        developmentScan={{ contexts: [] } as never}
        developmentScanLoading={false}
        commentsRevision={0}
        attachmentsRevision={0}
        onCreateLabel={async () => {}}
        onDeleteLabel={async () => {}}
        onUpdate={onUpdate as never}
        onOpenTask={() => {}}
        onAddRelation={async () => ({}) as never}
        onRemoveRelation={async () => ({}) as never}
        onOpenThread={() => {}}
        onOpenLegacyLocalThread={() => {}}
        onOpenInThread={() => {}}
        onCopy={() => {}}
        openingThread={false}
        onError={() => {}}
      />,
    );
    const form = view.container.querySelector("form.comment-composer, form") as HTMLFormElement;
    const fileInput = [...view.container.querySelectorAll<HTMLInputElement>('input[type="file"][multiple]')]
      .find((input) => form.contains(input))!;
    const file = new File(["abc"], "需求.txt", { type: "text/plain" });
    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.click(within(form).getByRole("switch"));
    const submit = async () => {
      await waitFor(() => expect((within(form).getByRole("button", { name: "留言" }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(within(form).getByRole("button", { name: "留言" }));
    };
    return { view, form, calls, reworkBodies, submit, setReworkStatus: (status: number) => { reworkStatus = status; } };
  }

  afterEach(() => {
    taskboardStorage.removeItem("taskboard.comment-draft.t1");
  });

  it("posts the comment and uploads files first, then reworks with the existing commentId (no PATCH status)", async () => {
    const { calls, reworkBodies, submit } = await renderRework();
    await submit();

    await waitFor(() => expect(calls).toContain("POST /api/tasks/t1/rework"));
    expect(calls.some((call) => call.startsWith("onUpdate"))).toBe(false);
    const commentIndex = calls.findIndex((call) => call.startsWith("POST") && call.endsWith("/api/tasks/t1/comments"));
    const uploadIndex = calls.findIndex((call) => call.endsWith("/api/comments/c1/attachments"));
    const reworkIndex = calls.indexOf("POST /api/tasks/t1/rework");
    expect(commentIndex).toBeGreaterThanOrEqual(0);
    expect(uploadIndex).toBeGreaterThan(commentIndex);
    expect(reworkIndex).toBeGreaterThan(uploadIndex);
    expect(reworkBodies).toEqual([{ commentId: "c1" }]);
  });

  it("a 403 on rework shows the error, keeps the draft, and a retry reuses the comment and uploads", async () => {
    const draft = "請照附件重做";
    const { view, calls, reworkBodies, submit, setReworkStatus } = await renderRework({ reworkStatus: 403, draft });
    await submit();

    expect(await screen.findByText(RUN_ERROR_TEXT.LOCAL_AI_LOOPBACK_REQUIRED[0])).toBeTruthy();
    expect(reworkBodies).toEqual([{ commentId: "c1" }]);
    expect(calls.some((call) => call.startsWith("onUpdate"))).toBe(false);
    // The draft text stays in the composer (and its saved draft).
    expect(view.container.textContent).toContain(draft);
    expect(taskboardStorage.getItem("taskboard.comment-draft.t1")).toContain(draft);

    setReworkStatus(200);
    await submit();
    await waitFor(() => expect(reworkBodies).toHaveLength(2));
    expect(reworkBodies[1]).toEqual({ commentId: "c1" });
    expect(calls.filter((call) => call === "POST /api/tasks/t1/comments")).toHaveLength(1);
    expect(calls.filter((call) => call.endsWith("/api/comments/c1/attachments"))).toHaveLength(1);
    await waitFor(() => expect(taskboardStorage.getItem("taskboard.comment-draft.t1")).toBeNull());
  });
});

describe("DBG-08: in_review/blocked AI card → in_progress opens the continue flow", () => {
  const PROJECT = { id: "p1", name: "專案一", workspacePath: null, source: "local", labels: [], issueCount: 1, createdAt: "x", updatedAt: "x" };

  function stubBoardEnvironment(initialTasks: Task[], onWrite: (method: string, path: string, body: unknown) => Response | null) {
    const writes: string[] = [];
    let tasks = initialTasks;
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("EventSource", class { addEventListener() {} removeEventListener() {} close() {} });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1/");
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        writes.push(`${method} ${url.pathname}`);
        const response = onWrite(method, url.pathname, init?.body ? JSON.parse(String(init.body)) : null);
        if (response) {
          if (response.ok) {
            const data = await response.clone().json() as { task?: Task };
            if (data.task) tasks = tasks.map((task) => task.id === data.task!.id ? data.task! : task);
          }
          return response;
        }
        return jsonResponse({});
      }
      if (url.pathname === "/api/projects") return jsonResponse({ projects: [PROJECT] });
      if (url.pathname === "/api/tasks") {
        return jsonResponse({ tasks: url.searchParams.get("archived") === "true" ? [] : tasks });
      }
      const single = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
      if (single) return jsonResponse({ task: tasks.find((task) => task.id === single[1]) });
      if (url.pathname.endsWith("/comments")) return jsonResponse({ comments: [] });
      if (url.pathname.endsWith("/activities")) return jsonResponse({ activities: [] });
      if (url.pathname.endsWith("/attachments")) return jsonResponse({ attachments: [] });
      if (url.pathname.endsWith("/runs")) return jsonResponse({ runs: [], followups: [], activity: [] });
      if (url.pathname.endsWith("/automation")) return jsonResponse({ automation: { projectId: "p1", enabled: false, maxParallel: 1, orderMode: "suggested" } });
      if (url.pathname.endsWith("/development-contexts")) return jsonResponse({ contexts: [] });
      return jsonResponse({});
    }));
    return writes;
  }

  function dropOn(status: TaskStatus, taskId: string) {
    const heading = document.getElementById(`column-${status}`)!;
    fireEvent.drop(heading.closest("section")!, {
      dataTransfer: { getData: () => taskId, setData() {}, effectAllowed: "move" },
    });
  }

  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("guard: only AI cards with a previous run moving from in_review/blocked to in_progress", async () => {
    const run = makeRun("r1", "finished", { claudeShortId: "s1" });
    expect(requiresContinueMessage(makeTask("t", "in_review", { assignee: CLAUDE, latestRun: run }), "in_progress")).toBe(true);
    expect(requiresContinueMessage(makeTask("t", "blocked", { assignee: CODEX, latestRun: run }), "in_progress")).toBe(true);
    expect(requiresContinueMessage(makeTask("t", "in_review", { assignee: CLAUDE, latestRun: run }), "todo")).toBe(false);
    expect(requiresContinueMessage(makeTask("t", "todo", { assignee: CLAUDE, latestRun: run }), "in_progress")).toBe(false);
    expect(requiresContinueMessage(makeTask("t", "in_review", { assignee: CLAUDE, latestRun: null }), "in_progress")).toBe(false);
    expect(requiresContinueMessage(makeTask("t", "blocked", { assignee: USER, latestRun: run }), "in_progress")).toBe(false);

    const move = vi.fn(async () => "moved");
    const openContinue = vi.fn();
    await expect(guardedStatusMove({
      task: makeTask("t", "blocked", { assignee: CLAUDE, latestRun: run }), destination: "in_progress", move, openContinue,
    })).resolves.toEqual({ kind: "continue", reason: "guard", flow: "continue" });
    expect(move).not.toHaveBeenCalled();
    expect(openContinue).toHaveBeenCalledWith("guard", "continue");

    const refused = new ApiError(409, { error: { code: "CONTINUE_MESSAGE_REQUIRED", message: "message required" } });
    const onServerRefusal = vi.fn();
    await expect(guardedStatusMove({
      task: makeTask("t", "blocked", { assignee: USER, latestRun: run }),
      destination: "in_progress",
      move: async () => { throw refused; },
      openContinue,
      onServerRefusal,
    })).resolves.toEqual({ kind: "continue", reason: "server", flow: "continue" });
    expect(onServerRefusal).toHaveBeenCalledWith(refused);
    expect(isContinueMessageRequiredError(refused)).toBe(true);
    await expect(guardedStatusMove({
      task: makeTask("t", "todo"), destination: "in_progress", move: async () => { throw new Error("boom"); }, openContinue,
    })).rejects.toThrow("boom");
    expect(runErrorTextPair(refused)?.[0]).toContain("繼續");
  });

  it("guard mirrors the server: no active run, AI assignee current or requested, rework when the run has no session refs", async () => {
    const run = makeRun("r1", "finished", { claudeShortId: "s1" });
    const blocked = (overrides: Partial<Task>) => makeTask("t", "blocked", { assignee: CLAUDE, latestRun: run, ...overrides });
    // An active run (the agent reporting its own status) is not intercepted; a stale finished activeRun is.
    expect(continueFlowFor(blocked({ activeRun: makeRun("r2", "running", { claudeShortId: "s1" }) }), "in_progress")).toBeNull();
    expect(requiresContinueMessage(blocked({ activeRun: makeRun("r2", "running", { claudeShortId: "s1" }) }), "in_progress")).toBe(false);
    expect(continueFlowFor(blocked({ activeRun: makeRun("r2", "finished", { claudeShortId: "s1" }) }), "in_progress")).toBe("continue");
    // Requested AI assignee on a person card.
    expect(continueFlowFor(blocked({ assignee: USER }), "in_progress")).toBeNull();
    expect(continueFlowFor(blocked({ assignee: USER }), "in_progress", { requestedAssignee: CODEX })).toBe("continue");
    // Session refs decide continue vs rework (any single ref counts).
    expect(continueFlowFor(blocked({ latestRun: makeRun("r0", "failed") }), "in_progress")).toBe("rework");
    expect(continueFlowFor(blocked({ latestRun: makeRun("r0", "failed", { claudeSessionId: "x" }) }), "in_progress")).toBe("continue");
    expect(continueFlowFor(blocked({ latestRun: makeRun("r0", "failed", { provider: "codex", codexThreadId: "th" }) }), "in_progress")).toBe("continue");

    const openContinue = vi.fn();
    await expect(guardedStatusMove({
      task: blocked({ latestRun: makeRun("r0", "failed") }), destination: "in_progress", move: async () => "moved", openContinue,
    })).resolves.toEqual({ kind: "continue", reason: "guard", flow: "rework" });
    expect(openContinue).toHaveBeenCalledWith("guard", "rework");
    const reworkRefusal = new ApiError(409, { error: { code: "REWORK_REQUIRED", message: "上一次沒有成功開工，請改用「退回重做」" } });
    expect(continueFlowForError(reworkRefusal)).toBe("rework");
    await expect(guardedStatusMove({
      task: blocked({ assignee: USER }), destination: "in_progress", move: async () => { throw reworkRefusal; }, openContinue,
    })).resolves.toEqual({ kind: "continue", reason: "server", flow: "rework" });
    expect(runErrorTextPair(reworkRefusal)?.[0]).toBe("上一次沒有成功開工，請改用「退回重做」");
  });

  it("a stale non-active activeRun still opens the continue hint in the detail page (guard and detail agree)", async () => {
    const run = makeRun("r1", "finished", { resultText: "done", claudeShortId: "s1" });
    const card = makeTask("t1", "in_review", {
      assignee: CLAUDE, latestRun: run, activeRun: makeRun("r1", "finished", { claudeShortId: "s1" }), projectId: "p1",
    });
    const writes = stubBoardEnvironment([card], () => null);
    render(<App />);
    await screen.findByText("Task t1");
    dropOn("in_progress", "t1");
    expect(await screen.findByText(CONTINUE_FLOW_HINT_TEXT[0])).toBeTruthy();
    expect(screen.getByRole("button", { name: "繼續" })).toBeTruthy();
    expect(writes.filter((write) => write.endsWith("/move") || write.startsWith("PATCH /api/tasks"))).toEqual([]);
  });

  it("DBG-08 follow-up: a blocked AI card whose launch never started opens the rework flow, not continue", async () => {
    const failedLaunch = makeRun("r1", "failed", { error: "launch failed" });
    const card = makeTask("t1", "blocked", { assignee: CLAUDE, latestRun: failedLaunch, projectId: "p1" });
    const writes = stubBoardEnvironment([card], () => null);
    render(<App />);
    await screen.findByText("Task t1");
    dropOn("in_progress", "t1");
    expect(await screen.findByText(REWORK_FLOW_HINT_TEXT[0])).toBeTruthy();
    expect(screen.queryByText(CONTINUE_FLOW_HINT_TEXT[0])).toBeNull();
    expect(screen.queryByRole("button", { name: "繼續" })).toBeNull();
    const form = document.querySelector("form.comment-composer") as HTMLFormElement;
    expect(within(form).getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(writes.filter((write) => write.endsWith("/move") || write.startsWith("PATCH /api/tasks"))).toEqual([]);
  });

  it("DBG-08 follow-up: a server 409 REWORK_REQUIRED on a drop opens the rework flow", async () => {
    const failedLaunch = makeRun("r1", "failed", { error: "launch failed" });
    // Person assignee: not guarded on the client, so only the server refusal can route it.
    const card = makeTask("t1", "blocked", { assignee: USER, latestRun: failedLaunch, projectId: "p1" });
    const writes = stubBoardEnvironment([card], (method, path) => (
      method === "POST" && path.endsWith("/move")
        ? jsonResponse({ error: { code: "REWORK_REQUIRED", message: "上一次沒有成功開工，請改用「退回重做」" } }, 409)
        : null
    ));
    render(<App />);
    await screen.findByText("Task t1");
    dropOn("in_progress", "t1");
    await waitFor(() => expect(document.querySelector(".comment-continue-hint")?.textContent).toBe(REWORK_FLOW_HINT_TEXT[0]));
    expect(writes).toContain("POST /api/tasks/t1/move");
  });

  it("drag and drop to 處理中 opens the detail continue composer instead of moving", async () => {
    const run = makeRun("r1", "finished", { resultText: "done", claudeShortId: "s1" });
    const card = makeTask("t1", "in_review", { assignee: CLAUDE, latestRun: run, projectId: "p1" });
    const writes = stubBoardEnvironment([card], () => null);
    render(<App />);
    await screen.findByText("Task t1");
    dropOn("in_progress", "t1");
    expect(await screen.findByText(CONTINUE_FLOW_HINT_TEXT[0])).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("issue")?.toLowerCase()).toBe("t-t1");
    expect(screen.getByRole("button", { name: "繼續" })).toBeTruthy();
    expect(writes.filter((write) => write.endsWith("/move") || write.startsWith("PATCH /api/tasks"))).toEqual([]);
  });

  it("server 409 CONTINUE_MESSAGE_REQUIRED on a drop rolls back and shows Traditional Chinese text", async () => {
    const run = makeRun("r1", "finished", { resultText: "done", claudeShortId: "s1" });
    // Not guarded on the client (user assignee), so only the server refusal can stop it.
    const card = makeTask("t1", "blocked", { assignee: USER, latestRun: run, projectId: "p1" });
    const writes = stubBoardEnvironment([card], (method, path) => (
      method === "POST" && path.endsWith("/move")
        ? jsonResponse({ error: { code: "CONTINUE_MESSAGE_REQUIRED", message: "A continue message is required" } }, 409)
        : null
    ));
    render(<App />);
    await screen.findByText("Task t1");
    dropOn("in_progress", "t1");
    expect(await screen.findByText(RUN_ERROR_TEXT.CONTINUE_MESSAGE_REQUIRED[0])).toBeTruthy();
    expect(writes).toContain("POST /api/tasks/t1/move");
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("issue")?.toLowerCase()).toBe("t-t1"));
    expect(screen.queryByText("A continue message is required")).toBeNull();
  });

  it("detail status picker 處理中 shows the continue hint instead of saving the status", async () => {
    const run = makeRun("r1", "finished", { resultText: "done", claudeShortId: "s1" });
    const card = makeTask("t1", "blocked", { assignee: CODEX, latestRun: run, projectId: "p1", identifier: "RELAY-1" });
    const writes = stubBoardEnvironment([card], () => null);
    window.history.replaceState(null, "", "/?project=p1&issue=RELAY-1");
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "狀態" });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("option", { name: /處理中/ }));
    expect(await screen.findByText(CONTINUE_FLOW_HINT_TEXT[0])).toBeTruthy();
    expect(writes.filter((write) => write.startsWith("PATCH /api/tasks") || write.endsWith("/move"))).toEqual([]);
  });

  it("Ctrl+Z after moving an AI card out of 處理中 opens the continue flow instead of moving it back", async () => {
    const run = makeRun("r1", "finished", { resultText: "done", claudeShortId: "s1" });
    const card = makeTask("t1", "in_progress", { assignee: CLAUDE, latestRun: run, activeRun: null, projectId: "p1" });
    const writes = stubBoardEnvironment([card], (method, path, body) => {
      if (method === "POST" && path.endsWith("/move")) {
        const { status } = body as { status: TaskStatus };
        return jsonResponse({ task: { ...card, status, version: card.version + 1 } });
      }
      return null;
    });
    render(<App />);
    await screen.findByText("Task t1");
    dropOn("in_review", "t1");
    await waitFor(() => expect(writes).toEqual(["POST /api/tasks/t1/move"]));
    await waitFor(() => expect(document.getElementById("column-in_review")?.textContent).toContain("1"));

    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    expect(await screen.findByText(CONTINUE_FLOW_HINT_TEXT[0])).toBeTruthy();
    expect(writes).toEqual(["POST /api/tasks/t1/move"]);
  });
});

describe("import fix F2: task status import turn intent", () => {
  it("buildComposerTurnInput carries the import intent only when given", async () => {
    const { buildComposerTurnInput } = await import("./aiChatState");
    const document = { version: 1 as const, nodes: [{ type: "text" as const, text: "import" }] };
    expect(buildComposerTurnInput(document, "r1", false, [], "taskboard-import").intent).toBe("taskboard-import");
    expect("intent" in buildComposerTurnInput(document, "r1", false)).toBe(false);
  });
});

describe("W14: desktop board shows a paired phone (permanent pairing, expires_at 'never')", () => {
  const PROJECT = { id: "p1", name: "專案一", workspacePath: null, source: "local", labels: [], issueCount: 0, createdAt: "x", updatedAt: "x" };
  const PERMANENT = {
    id: "5e5510a0-0000-4000-8000-000000000001", deviceLabel: "我的手機", expiresAt: null, revokedAt: null,
    createdAt: "2026-09-17T08:18:09.579Z", lastSeenAt: "2026-09-17T08:50:28.921Z", homeScreenAt: "2026-09-17T08:20:07.843Z", parentSessionId: null,
  };

  function stubDesktopBoard(sessions: unknown[]) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("EventSource", class { addEventListener() {} removeEventListener() {} close() {} });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1/");
      if (url.pathname === "/api/projects") return jsonResponse({ projects: [PROJECT] });
      if (url.pathname === "/api/tasks") return jsonResponse({ tasks: [] });
      if (url.pathname === "/api/local/mobile-access") {
        return jsonResponse({ enabled: true, url: "http://100.64.0.10:47833/", tailnetAddress: "100.64.0.10", pairing: sessions.length ? "paired" : "unpaired", sessions, pendingChallenges: [] });
      }
      if (url.pathname === "/api/local/mobile-access/tailscale") return jsonResponse({ installed: true, running: true, loginName: null, tailnetAddress: "100.64.0.10", mobilePeers: [] });
      if (url.pathname.endsWith("/automation")) return jsonResponse({ automation: { projectId: "p1", enabled: false, maxParallel: 1, orderMode: "suggested" } });
      if (url.pathname.endsWith("/development-contexts")) return jsonResponse({ contexts: [] });
      return jsonResponse({});
    }));
  }

  beforeEach(() => {
    window.localStorage.removeItem("automate.phoneWizard.dismissed.v1");
    window.history.replaceState(null, "", "/?project=p1");
  });
  afterEach(() => {
    window.localStorage.removeItem("automate.phoneWizard.dismissed.v1");
    window.history.replaceState(null, "", "/");
  });

  it("paired: header says 「已連接 1 支手機」 and the wizard does not open by itself", async () => {
    stubDesktopBoard([PERMANENT]);
    render(<App />);
    await waitFor(() => expect(document.querySelector(".header-phone-button")?.getAttribute("aria-label")).toBe("已連接 1 支手機"));
    expect(document.querySelector(".header-phone-button .header-phone-badge")).toBeTruthy();
    expect(document.querySelector(".phone-wizard")).toBeNull();
    // Opening it by hand shows the paired phone, not the first-time page.
    fireEvent.click(document.querySelector(".header-phone-button")!);
    expect(await screen.findByRole("heading", { name: "已連接 1 支手機" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "用手機看看板" })).toBeNull();
  });

  it("no paired phone: header says 「連接手機」 and the wizard opens once", async () => {
    stubDesktopBoard([{ ...PERMANENT, revokedAt: "2026-09-17T09:00:00.000Z" }]);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "用手機看看板" })).toBeTruthy();
    expect(document.querySelector(".header-phone-button")?.getAttribute("aria-label")).toBe("連接手機");
    expect(document.querySelector(".header-phone-button .header-phone-badge")).toBeNull();
  });
});
