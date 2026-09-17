/*
 * W15 「新增任務」 entry + 3-step start guide (vitest + jsdom):
 *   npx vitest run web/src/newTaskEntry.test.tsx --environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { START_GUIDE_DISMISSED_KEY, StartGuide } from "./components/StartGuide";
import { TaskboardLanguageProvider } from "./i18n";
import { taskboardStorage } from "./storage";
import type { ActorIdentity, Task, TaskStatus } from "./types";

// The real Gantt chart needs a browser canvas; the header button is what these tests look at.
vi.mock("./components/GanttView", () => ({ GanttView: () => <div className="gantt-view-stub" /> }));

const USER: ActorIdentity = { type: "user", id: "local-user", name: "Alice", avatarUrl: null };
const LOCAL = { id: "local", name: "local", workspacePath: null, source: "local", labels: [], issueCount: 0, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };
const P1 = { id: "p1", name: "專案一", workspacePath: null, source: "local", labels: [], issueCount: 0, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

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

type ProjectRow = Omit<typeof P1, "workspacePath"> & { workspacePath: string | null };

function stubBoard(options: {
  projects: ProjectRow[];
  tasks?: Task[];
  onWrite?: (method: string, path: string, body: any) => Response | null;
}) {
  let projects = [...options.projects];
  const tasks = options.tasks ?? [];
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("EventSource", class { addEventListener() {} removeEventListener() {} close() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1/");
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      writes.push({ method, path: url.pathname, body });
      const custom = options.onWrite?.(method, url.pathname, body);
      if (custom) return custom;
      if (method === "PATCH" && url.pathname.startsWith("/api/projects/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/projects/".length));
        projects = projects.map((project) => project.id === id ? { ...project, workspacePath: body.workspacePath } : project);
        return jsonResponse({ project: projects.find((project) => project.id === id) });
      }
      if (method === "POST" && url.pathname === "/api/projects") {
        const created = { ...P1, id: body.id, name: body.name, workspacePath: body.workspacePath };
        projects = [...projects, created];
        return jsonResponse({ project: created }, 201);
      }
      return jsonResponse({});
    }
    if (url.pathname === "/api/projects") return jsonResponse({ projects });
    if (url.pathname === "/api/tasks") {
      if (url.searchParams.get("archived") === "true") return jsonResponse({ tasks: [] });
      const projectId = url.searchParams.get("projectId");
      return jsonResponse({ tasks: projectId && projectId !== "__all_projects__" ? tasks.filter((task) => task.projectId === projectId) : tasks });
    }
    if (url.pathname.endsWith("/automation")) return jsonResponse({ automation: { projectId: "p1", enabled: false, maxParallel: 1, orderMode: "suggested" } });
    if (url.pathname.endsWith("/development-contexts")) return jsonResponse({ contexts: [] });
    return jsonResponse({});
  }));
  return writes;
}

function headerNewTaskButton() {
  return document.querySelector(".workspace-header .header-create-button") as HTMLButtonElement | null;
}

function viewTab(name: string) {
  return within(document.querySelector(".view-tabs") as HTMLElement).getByRole("button", { name });
}

beforeEach(() => {
  // jsdom has no <dialog> modal API; TaskEditor calls it on mount.
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
  window.localStorage.clear();
  // Tests run without initializeTaskboardStorage(), so taskboardStorage is in-memory and outlives each test: reset it.
  for (const key of [
    START_GUIDE_DISMISSED_KEY,
    "taskboard.recentProjectIds.v1",
    "taskboard.project-view.v1.p1",
    "taskboard.project-view.v1.local",
    "taskboard.project-view.v1.__all_projects__",
  ]) taskboardStorage.removeItem(key);
  // Skip the first-use project menu and the phone wizard so the board is in its everyday state.
  taskboardStorage.setItem("taskboard.first-use-complete.v1", "true");
  taskboardStorage.setItem("automate.phoneWizard.dismissed.v1", "1");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("W15 「新增任務」 header button", () => {
  for (const scope of ["p1", "__all_projects__"]) {
    it(`is a labelled button on 儀表板, 任務看板, 列表 and 甘特圖 (${scope === "p1" ? "single project" : "所有專案"})`, async () => {
      stubBoard({ projects: [LOCAL, P1], tasks: [makeTask("t1", "todo")] });
      window.history.replaceState(null, "", `/?project=${scope}`);
      render(<App />);
      await screen.findAllByText("Task t1");
      for (const view of ["儀表板", "任務看板", "列表檢視", "甘特圖"]) {
        fireEvent.click(viewTab(view));
        const button = headerNewTaskButton();
        expect(button, view).toBeTruthy();
        expect(button!.textContent).toContain("新增任務");
        expect(button!.getAttribute("aria-label")).toBe("新增任務");
        expect(button!.className).toContain("primary");
      }
    });
  }

  it("所有專案: opens the editor with the project picker set to the only project; key C works too", async () => {
    stubBoard({ projects: [LOCAL, P1], tasks: [makeTask("t1", "todo")] });
    window.history.replaceState(null, "", "/?project=__all_projects__");
    render(<App />);
    await screen.findAllByText("Task t1");
    fireEvent.click(headerNewTaskButton()!);
    await waitFor(() => expect(document.querySelector(".task-dialog")).toBeTruthy());
    expect(document.querySelector(".task-dialog .property-project")?.textContent).toContain("專案一");
    // W15 wording: zh-TW says 任務, not 議題.
    expect(document.getElementById("task-dialog-title")?.textContent).toBe("新增任務");
    expect(document.querySelector(".task-dialog button[type=submit]")?.textContent).toContain("建立任務");
    expect(document.body.textContent).not.toContain("議題");
    fireEvent.click(within(document.querySelector(".task-dialog") as HTMLElement).getByRole("button", { name: "關閉編輯器" }));
    await waitFor(() => expect(document.querySelector(".task-dialog")).toBeNull());

    fireEvent.keyDown(document.body, { key: "c" });
    await waitFor(() => expect(document.querySelector(".task-dialog")).toBeTruthy());
  });

  it("所有專案 with several projects defaults to the last used one", async () => {
    const P2 = { ...P1, id: "p2", name: "專案二" };
    taskboardStorage.setItem("taskboard.recentProjectIds.v1", JSON.stringify(["local", "p2"]));
    stubBoard({ projects: [LOCAL, P1, P2], tasks: [makeTask("t1", "todo")] });
    window.history.replaceState(null, "", "/?project=__all_projects__");
    render(<App />);
    await screen.findAllByText("Task t1");
    fireEvent.click(headerNewTaskButton()!);
    await waitFor(() => expect(document.querySelector(".task-dialog")).toBeTruthy());
    expect(document.querySelector(".task-dialog .property-project")?.textContent).toContain("專案二");
  });
});

describe("W15 phone width", () => {
  it("keeps a compact 「新增任務」 (accessible name) above the mobile board, and the guide on an empty board", async () => {
    stubBoard({ projects: [LOCAL, P1] });
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("max-width"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    window.history.replaceState(null, "", "/?project=p1");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "三步開始" })).toBeTruthy();
    expect(document.querySelector("[class*='mobile-board']")).toBeTruthy();
    const button = within(document.querySelector(".workspace-header") as HTMLElement).getByRole("button", { name: "新增任務" });
    expect(button.classList.contains("header-create-button")).toBe(true);
    fireEvent.click(button);
    await waitFor(() => expect(document.querySelector(".task-dialog")).toBeTruthy());
  });
});

describe("W15 no project yet: create a project first, then the new-task editor", () => {
  it("「新增任務」 opens 建立專案 with a hint, and the editor opens for the new project", async () => {
    const writes = stubBoard({ projects: [LOCAL] });
    window.history.replaceState(null, "", "/?project=__all_projects__");
    render(<App />);
    await screen.findByRole("heading", { name: "三步開始" });
    fireEvent.click(headerNewTaskButton()!);
    const dialog = await screen.findByRole("dialog", { name: "建立專案" });
    expect(within(dialog).getByText("先選一個資料夾建立專案，建立後會接著打開「新增任務」。")).toBeTruthy();
    expect(document.querySelector(".task-dialog")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("專案名稱"), { target: { value: "報價單" } });
    fireEvent.change(within(dialog).getByLabelText("資料夾"), { target: { value: "C:\\Users\\bob\\ROOT" } });
    fireEvent.submit(dialog);
    await waitFor(() => expect(document.querySelector(".task-dialog")).toBeTruthy());
    const created = writes.find((write) => write.method === "POST" && write.path === "/api/projects");
    expect(created?.body).toMatchObject({ name: "報價單", workspacePath: "C:\\Users\\bob\\ROOT" });
    expect(screen.queryByRole("dialog", { name: "建立專案" })).toBeNull();
  });

  it("key C also goes to 建立專案 first; cancelling does not open the editor", async () => {
    stubBoard({ projects: [LOCAL] });
    window.history.replaceState(null, "", "/?project=__all_projects__");
    render(<App />);
    await screen.findByRole("heading", { name: "三步開始" });
    fireEvent.keyDown(document.body, { key: "c" });
    const dialog = await screen.findByRole("dialog", { name: "建立專案" });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "建立專案" })).toBeNull());
    expect(document.querySelector(".task-dialog")).toBeNull();
  });

  it("creating a project from the project menu does not open the editor afterwards", async () => {
    stubBoard({ projects: [LOCAL, P1], tasks: [makeTask("t1", "todo")] });
    window.history.replaceState(null, "", "/?project=p1");
    render(<App />);
    await screen.findAllByText("Task t1");
    fireEvent.click(document.querySelector(".header-project-button")!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "建立專案" }));
    const dialog = await screen.findByRole("dialog", { name: "建立專案" });
    expect(within(dialog).queryByText("先選一個資料夾建立專案，建立後會接著打開「新增任務」。")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("專案名稱"), { target: { value: "另一個" } });
    fireEvent.change(within(dialog).getByLabelText("資料夾"), { target: { value: "C:\\Work\\Other" } });
    fireEvent.submit(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "建立專案" })).toBeNull());
    expect(document.querySelector(".task-dialog")).toBeNull();
  });
});

describe("W15 3-step start guide", () => {
  it("no project: step ① has 建立專案, nothing ticked; the button runs the project-first flow", async () => {
    stubBoard({ projects: [LOCAL] });
    window.history.replaceState(null, "", "/?project=__all_projects__");
    render(<App />);
    const guide = (await screen.findByRole("heading", { name: "三步開始" })).closest("section") as HTMLElement;
    expect(guide.querySelectorAll(".start-guide-step.is-done")).toHaveLength(0);
    expect(within(guide).getByText("建立專案（選資料夾）")).toBeTruthy();
    expect(within(guide).getByText("指派給 Claude 或 Codex 開始做")).toBeTruthy();
    fireEvent.click(within(guide.querySelector('[data-step="project"]') as HTMLElement).getByRole("button", { name: "建立專案" }));
    expect(await screen.findByText("先選一個資料夾建立專案，建立後會接著打開「新增任務」。")).toBeTruthy();
  });

  it("empty project: ① ticked, ② offers 新增任務 on 任務看板 and 儀表板; 列表 does not show it", async () => {
    stubBoard({ projects: [LOCAL, P1] });
    window.history.replaceState(null, "", "/?project=p1");
    render(<App />);
    const guide = (await screen.findByRole("heading", { name: "三步開始" })).closest("section") as HTMLElement;
    expect(guide.querySelector('[data-step="project"]')?.className).toContain("is-done");
    expect(within(guide.querySelector('[data-step="project"]') as HTMLElement).queryByRole("button")).toBeNull();
    fireEvent.click(within(guide.querySelector('[data-step="task"]') as HTMLElement).getByRole("button", { name: "新增任務" }));
    await waitFor(() => expect(document.querySelector(".task-dialog")).toBeTruthy());
    fireEvent.click(within(document.querySelector(".task-dialog") as HTMLElement).getByRole("button", { name: "關閉編輯器" }));
    await waitFor(() => expect(document.querySelector(".task-dialog")).toBeNull());

    fireEvent.click(viewTab("儀表板"));
    expect(screen.getByRole("heading", { name: "三步開始" })).toBeTruthy();
    fireEvent.click(viewTab("列表檢視"));
    expect(screen.queryByRole("heading", { name: "三步開始" })).toBeNull();
  });

  it("is not shown once tasks exist", async () => {
    stubBoard({ projects: [LOCAL, P1], tasks: [makeTask("t1", "todo")] });
    window.history.replaceState(null, "", "/?project=__all_projects__");
    render(<App />);
    await screen.findAllByText("Task t1");
    expect(screen.queryByRole("heading", { name: "三步開始" })).toBeNull();
  });

  it("× hides it and remembers the choice", async () => {
    stubBoard({ projects: [LOCAL, P1] });
    window.history.replaceState(null, "", "/?project=p1");
    const first = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "關閉入門指引" }));
    expect(screen.queryByRole("heading", { name: "三步開始" })).toBeNull();
    expect(taskboardStorage.getItem(START_GUIDE_DISMISSED_KEY)).toBe("true");
    first.unmount();
    render(<App />);
    await waitFor(() => expect(headerNewTaskButton()).toBeTruthy());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(screen.queryByRole("heading", { name: "三步開始" })).toBeNull();
  });

  it("uses English and Simplified Chinese copy through text()", () => {
    const props = { hasProject: true, hasTasks: false, onCreateProject() {}, onNewTask() {}, onDismiss() {} };
    render(<TaskboardLanguageProvider language="en"><StartGuide {...props} /></TaskboardLanguageProvider>);
    expect(screen.getByRole("heading", { name: "Get started in 3 steps" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New task" })).toBeTruthy();
    cleanup();
    render(<TaskboardLanguageProvider language="zh"><StartGuide {...props} /></TaskboardLanguageProvider>);
    expect(screen.getByText("指派给 Claude 或 Codex 开始做")).toBeTruthy();
  });
});

describe("W15 project folder", () => {
  const CLAUDE: ActorIdentity = { type: "agent", id: "claude-agent", name: "Claude", avatarUrl: null };

  it("建立專案 needs a folder; 選擇資料夾… asks the PC and fills the folder and an empty name", async () => {
    const writes = stubBoard({
      projects: [LOCAL],
      onWrite: (method, path) => (method === "POST" && path === "/api/local/pick-folder"
        ? jsonResponse({ path: "C:\\Users\\bob\\Documents\\報價單", canceled: false })
        : null),
    });
    window.history.replaceState(null, "", "/?project=__all_projects__");
    render(<App />);
    await screen.findByRole("heading", { name: "三步開始" });
    fireEvent.click(headerNewTaskButton()!);
    const dialog = await screen.findByRole("dialog", { name: "建立專案" });
    const create = within(dialog).getByRole("button", { name: "建立" }) as HTMLButtonElement;
    fireEvent.change(within(dialog).getByLabelText("專案名稱"), { target: { value: "" } });
    expect(create.disabled).toBe(true);
    expect(within(dialog).getByText("AI 會在這個資料夾裡工作。")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "選擇資料夾…" }));
    await waitFor(() => expect((within(dialog).getByLabelText("資料夾") as HTMLInputElement).value).toBe("C:\\Users\\bob\\Documents\\報價單"));
    expect((within(dialog).getByLabelText("專案名稱") as HTMLInputElement).value).toBe("報價單");
    expect(writes.find((write) => write.path === "/api/local/pick-folder")?.body).toEqual({ title: "選擇專案資料夾" });
    expect(create.disabled).toBe(false);
    fireEvent.submit(dialog);
    await waitFor(() => expect(document.querySelector(".task-dialog")).toBeTruthy());
    expect(writes.find((write) => write.method === "POST" && write.path === "/api/projects")?.body)
      .toMatchObject({ name: "報價單", workspacePath: "C:\\Users\\bob\\Documents\\報價單" });
  });

  it("a folder error from the server stays in the dialog", async () => {
    stubBoard({
      projects: [LOCAL],
      onWrite: (method, path) => (method === "POST" && path === "/api/projects"
        ? jsonResponse({ error: { code: "WORKSPACE_FOLDER_MISSING", message: "找不到這個資料夾：C:\\Nope" } }, 400)
        : null),
    });
    window.history.replaceState(null, "", "/?project=__all_projects__");
    render(<App />);
    await screen.findByRole("heading", { name: "三步開始" });
    fireEvent.click(headerNewTaskButton()!);
    const dialog = await screen.findByRole("dialog", { name: "建立專案" });
    fireEvent.change(within(dialog).getByLabelText("專案名稱"), { target: { value: "A" } });
    fireEvent.change(within(dialog).getByLabelText("資料夾"), { target: { value: "C:\\Nope" } });
    fireEvent.submit(dialog);
    expect(await within(dialog).findByText("找不到這個資料夾：C:\\Nope")).toBeTruthy();
    expect(document.querySelector(".task-dialog")).toBeNull();
  });

  it("review M2: on a phone with no own project, 新增任務 opens the editor (臨時任務) instead of a dead-end 建立專案", async () => {
    const writes = stubBoard({ projects: [LOCAL] });
    window.history.replaceState(null, "", "/?project=__all_projects__");
    // A phone opens the board on the tailnet address; the page hostname comes from document.baseURI.
    const base = document.createElement("base");
    base.href = "http://100.64.0.9:47833/";
    document.head.appendChild(base);
    try {
      render(<App />);
      const guide = (await screen.findByRole("heading", { name: "三步開始" })).closest("section") as HTMLElement;
      const stepOne = guide.querySelector('[data-step="project"]') as HTMLElement;
      expect(within(stepOne).queryByRole("button")).toBeNull();
      expect(within(stepOne).getByText("請在電腦上的 AutoMate Taskboard 視窗建立專案並選資料夾。")).toBeTruthy();

      fireEvent.click(headerNewTaskButton()!);
      await waitFor(() => expect(document.querySelector(".task-dialog")).toBeTruthy());
      expect(screen.queryByRole("dialog", { name: "建立專案" })).toBeNull();
      fireEvent.click(within(document.querySelector(".task-dialog") as HTMLElement).getByRole("button", { name: "關閉編輯器" }));
      await waitFor(() => expect(document.querySelector(".task-dialog")).toBeNull());
      fireEvent.keyDown(document.body, { key: "c" });
      await waitFor(() => expect(document.querySelector(".task-dialog")).toBeTruthy());
      fireEvent.click(within(document.querySelector(".task-dialog") as HTMLElement).getByRole("button", { name: "關閉編輯器" }));
      await waitFor(() => expect(document.querySelector(".task-dialog")).toBeNull());

      // Creating a project from the project menu on a phone: no folder field, created without a folder.
      fireEvent.click(document.querySelector(".header-project-button")!);
      fireEvent.click(await screen.findByRole("menuitem", { name: "建立專案" }));
      const dialog = await screen.findByRole("dialog", { name: "建立專案" });
      expect(within(dialog).queryByLabelText("資料夾")).toBeNull();
      expect(within(dialog).queryByRole("button", { name: "選擇資料夾…" })).toBeNull();
      expect(within(dialog).getByText("專案資料夾只能在電腦上的 AutoMate Taskboard 視窗設定；設定資料夾之前，AI 還不能處理這個專案的任務。")).toBeTruthy();
      fireEvent.change(within(dialog).getByLabelText("專案名稱"), { target: { value: "手機建的" } });
      const create = within(dialog).getByRole("button", { name: "建立" }) as HTMLButtonElement;
      expect(create.disabled).toBe(false);
      fireEvent.submit(dialog);
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "建立專案" })).toBeNull());
      expect(writes.find((write) => write.method === "POST" && write.path === "/api/projects")?.body)
        .toMatchObject({ name: "手機建的", workspacePath: null });
    } finally {
      base.remove();
    }
  });

  it("review O5: the 設定專案資料夾 button follows the error code, not the message text", async () => {
    stubBoard({
      projects: [LOCAL, P1],
      tasks: [makeTask("t1", "todo", { assignee: CLAUDE })],
      onWrite: (method, path) => (method === "POST" && path.endsWith("/run/start")
        ? jsonResponse({ error: { code: "SOMETHING_ELSE", message: "專案沒有設定資料夾，AI 無法開工" } }, 409)
        : null),
    });
    window.history.replaceState(null, "", "/?project=__all_projects__");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "開工 T-t1" }));
    const banner = (await screen.findByText("專案沒有設定資料夾，AI 無法開工")).closest(".error-banner") as HTMLElement;
    expect(within(banner).queryByRole("button", { name: "設定專案資料夾" })).toBeNull();
  });

  it("專案資料夾… in the project menu sets the folder of an existing project", async () => {
    const writes = stubBoard({ projects: [LOCAL, P1], tasks: [makeTask("t1", "todo")] });
    window.history.replaceState(null, "", "/?project=p1");
    render(<App />);
    await screen.findAllByText("Task t1");
    fireEvent.click(document.querySelector(".header-project-button")!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "專案資料夾…" }));
    const dialog = await screen.findByRole("dialog", { name: "設定「專案一」的資料夾" });
    fireEvent.change(within(dialog).getByLabelText("資料夾"), { target: { value: "D:\\ROOT" } });
    fireEvent.submit(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "設定「專案一」的資料夾" })).toBeNull());
    expect(writes.find((write) => write.method === "PATCH")).toEqual({ method: "PATCH", path: "/api/projects/p1", body: { workspacePath: "D:\\ROOT" } });
  });

  it("開工 on a project without a folder shows the message with 設定專案資料夾, and saving clears it", async () => {
    const writes = stubBoard({
      projects: [LOCAL, P1],
      tasks: [makeTask("t1", "todo", { assignee: CLAUDE })],
      onWrite: (method, path) => (method === "POST" && path.endsWith("/run/start")
        ? jsonResponse({ error: { code: "WORKSPACE_NOT_FOUND", message: "專案沒有設定資料夾，AI 無法開工", details: { projectId: "p1", workspacePath: null } } }, 409)
        : null),
    });
    window.history.replaceState(null, "", "/?project=__all_projects__");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "開工 T-t1" }));
    const banner = (await screen.findByText("專案沒有設定資料夾，AI 無法開工")).closest(".error-banner") as HTMLElement;
    fireEvent.click(within(banner).getByRole("button", { name: "設定專案資料夾" }));
    const dialog = await screen.findByRole("dialog", { name: "設定「專案一」的資料夾" });
    fireEvent.change(within(dialog).getByLabelText("資料夾"), { target: { value: "C:\\Users\\bob\\ROOT" } });
    fireEvent.submit(dialog);
    await waitFor(() => expect(screen.queryByText("專案沒有設定資料夾，AI 無法開工")).toBeNull());
    expect(writes.some((write) => write.method === "PATCH" && write.path === "/api/projects/p1")).toBe(true);
  });
});
