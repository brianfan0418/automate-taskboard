/*
 * Vitest suite: npx vitest run web/src/mobileUiModel.test.ts --environment jsdom
 *
 * Node 22's `node --test` default glob also matches `*.test.ts`. Under plain Node this file only
 * registers one skipped node:test entry (vitest, JSX components and extensionless imports cannot load
 * there); everything else is imported dynamically inside the vitest branch.
 */
import type { MobileBoardProps } from "./components/MobileBoard";
import type { ActorIdentity, Task, TaskStatus } from "./types";

const runningInVitest = Boolean(
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VITEST,
);

if (runningInVitest) {
  await defineVitestSuite();
} else {
  const nodeTestModule = "node:test";
  const { test } = await import(/* @vite-ignore */ nodeTestModule) as {
    test: (name: string, options: { skip: string }, fn: () => void) => void;
  };
  test("web/src/mobileUiModel.test.ts (vitest suite)", {
    skip: "run with: npx vitest run web/src/mobileUiModel.test.ts --environment jsdom",
  }, () => {});
}

async function defineVitestSuite() {
  const { afterEach, describe, expect, it, vi } = await import("vitest");
  const { act, cleanup, fireEvent, render, renderHook, within } = await import("@testing-library/react");
  const { createElement } = await import("react");
  const { MobileBoard, useMobileBoardViewport } = await import("./components/MobileBoard");
  const {
    MOBILE_COLLAPSED_STORAGE_KEY,
    MOBILE_DEFAULT_COLLAPSED_STATUSES,
    MOBILE_LONG_PRESS_MS,
    exceededMobileDragSlop,
    isMobileBoardViewport,
    mobileCanonicalView,
    mobileDropBeforeTaskId,
    mobileEdgeScrollDelta,
    mobileMoveDestinations,
    mobileMoveNeedsDetail,
    parseMobileCollapsedStatuses,
    readMobileCollapsedStatuses,
    serializeMobileCollapsedStatuses,
    toggleMobileCollapsedStatus,
    writeMobileCollapsedStatuses,
  } = await import("./mobileUiModel");
  const { TASK_STATUSES } = await import("./types");

  const USER: ActorIdentity = { type: "user", id: "local-user", name: "Alice", avatarUrl: null };
  const CLAUDE: ActorIdentity = { type: "agent", id: "claude-agent", name: "Claude", avatarUrl: null };

  function makeTask(id: string, status: TaskStatus, assignee: ActorIdentity = USER): Task {
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
      assignee,
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
    };
  }

  function groupTasks(tasks: Task[]): Record<TaskStatus, Task[]> {
    return Object.fromEntries(
      TASK_STATUSES.map((status) => [status, tasks.filter((task) => task.status === status)]),
    ) as Record<TaskStatus, Task[]>;
  }

  function memoryStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
      values,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
  }

  describe("mobile interaction model (ported from fork)", () => {
    it("keeps the desktop view preference while collapsing mobile list/issues into one issue board", () => {
      expect(mobileCanonicalView("list", 390)).toBe("issues");
      expect(mobileCanonicalView("issues", 719)).toBe("issues");
      expect(mobileCanonicalView("list", 1024)).toBe("list");
      expect(mobileCanonicalView("dashboard", 390)).toBe("dashboard");
    });

    it("treats widths up to 719px as the mobile board", () => {
      expect(isMobileBoardViewport(719)).toBe(true);
      expect(isMobileBoardViewport(720)).toBe(false);
      expect(isMobileBoardViewport(Number.NaN)).toBe(false);
    });

    it("uses the specified 300 ms intent delay and 8 px pre-activation slop", () => {
      expect(MOBILE_LONG_PRESS_MS).toBe(300);
      expect(exceededMobileDragSlop(10, 10, 18, 10)).toBe(false);
      expect(exceededMobileDragSlop(10, 10, 19, 10)).toBe(true);
    });

    it("computes vertical drop positions without relying on adjacent status columns", () => {
      const rects = [
        { id: "a", top: 100, height: 60 },
        { id: "b", top: 168, height: 60 },
        { id: "c", top: 236, height: 60 },
      ];
      expect(mobileDropBeforeTaskId(rects, "a", 180)).toBe("b");
      expect(mobileDropBeforeTaskId(rects, "a", 400)).toBeNull();
    });

    it("scrolls only inside the top and bottom mobile edge zones", () => {
      expect(mobileEdgeScrollDelta(20, 800)).toBeLessThan(0);
      expect(mobileEdgeScrollDelta(400, 800)).toBe(0);
      expect(mobileEdgeScrollDelta(790, 800)).toBeGreaterThan(0);
      expect(mobileEdgeScrollDelta(20, 0)).toBe(0);
    });
  });

  describe("mobile collapsed sections", () => {
    it("uses the storage key taskboard.mobile.collapsed", () => {
      expect(MOBILE_COLLAPSED_STORAGE_KEY).toBe("taskboard.mobile.collapsed");
    });

    it("falls back to the defaults for missing or malformed values and keeps an explicit empty list", () => {
      expect(parseMobileCollapsedStatuses(null)).toEqual([...MOBILE_DEFAULT_COLLAPSED_STATUSES]);
      expect(parseMobileCollapsedStatuses("not json")).toEqual([...MOBILE_DEFAULT_COLLAPSED_STATUSES]);
      expect(parseMobileCollapsedStatuses("{\"done\":true}")).toEqual([...MOBILE_DEFAULT_COLLAPSED_STATUSES]);
      expect(parseMobileCollapsedStatuses("[]")).toEqual([]);
    });

    it("drops unknown statuses, removes duplicates and keeps board order", () => {
      expect(parseMobileCollapsedStatuses("[\"done\",\"nope\",\"backlog\",\"done\"]")).toEqual(["backlog", "done"]);
      expect(serializeMobileCollapsedStatuses(["canceled", "todo"])).toBe("[\"todo\",\"canceled\"]");
    });

    it("toggles a status in and out", () => {
      expect(toggleMobileCollapsedStatus(["done"], "todo")).toEqual(["todo", "done"]);
      expect(toggleMobileCollapsedStatus(["todo", "done"], "todo")).toEqual(["done"]);
    });

    it("reads and writes through storage and survives storage errors", () => {
      const storage = memoryStorage();
      expect(writeMobileCollapsedStatuses(storage, ["blocked"])).toBe(true);
      expect(storage.values.get(MOBILE_COLLAPSED_STORAGE_KEY)).toBe("[\"blocked\"]");
      expect(readMobileCollapsedStatuses(storage)).toEqual(["blocked"]);

      const broken = {
        getItem: () => { throw new Error("denied"); },
        setItem: () => { throw new Error("denied"); },
      };
      expect(readMobileCollapsedStatuses(broken)).toEqual([...MOBILE_DEFAULT_COLLAPSED_STATUSES]);
      expect(writeMobileCollapsedStatuses(broken, ["todo"])).toBe(false);
      expect(writeMobileCollapsedStatuses(null, ["todo"])).toBe(false);
    });
  });

  describe("mobile move destinations (BLUEPRINT §4.2)", () => {
    it("offers every other status for user-assigned cards", () => {
      expect(mobileMoveDestinations({ status: "in_review", assignee: USER }))
        .toEqual(["backlog", "todo", "in_progress", "blocked", "done", "canceled"]);
      expect(mobileMoveNeedsDetail({ status: "in_review", assignee: USER })).toBe(false);
    });

    it("limits agent cards in progress to stop destinations", () => {
      expect(mobileMoveDestinations({ status: "in_progress", assignee: CLAUDE })).toEqual(["backlog", "todo", "canceled"]);
    });

    it("keeps continue and rework on the detail page for agent cards", () => {
      expect(mobileMoveDestinations({ status: "in_review", assignee: CLAUDE }))
        .toEqual(["backlog", "blocked", "done", "canceled"]);
      expect(mobileMoveDestinations({ status: "blocked", assignee: CLAUDE }))
        .toEqual(["backlog", "todo", "in_review", "done", "canceled"]);
      expect(mobileMoveNeedsDetail({ status: "in_review", assignee: CLAUDE })).toBe(true);
      expect(mobileMoveNeedsDetail({ status: "blocked", assignee: CLAUDE })).toBe(true);
      expect(mobileMoveNeedsDetail({ status: "todo", assignee: CLAUDE })).toBe(false);
    });

    it("lets agent cards in todo start work and in backlog be delivered", () => {
      expect(mobileMoveDestinations({ status: "todo", assignee: CLAUDE })).toContain("in_progress");
      expect(mobileMoveDestinations({ status: "backlog", assignee: CLAUDE })).toContain("todo");
    });
  });

  describe("MobileBoard component", () => {
    afterEach(() => {
      cleanup();
      vi.useRealTimers();
      vi.restoreAllMocks();
      document.body.className = "";
    });

    function renderBoard(tasks: Task[], overrides: Partial<MobileBoardProps> = {}) {
      const props: MobileBoardProps = {
        tasksByStatus: groupTasks(tasks),
        storage: memoryStorage(),
        onDrop: vi.fn(),
        onComplete: vi.fn(async () => {}),
        onOpenTask: vi.fn(),
        ...overrides,
      };
      const view = render(createElement(MobileBoard, props));
      return { ...view, props };
    }

    function section(container: HTMLElement, status: TaskStatus) {
      return container.querySelector<HTMLElement>(`.mobile-board-section[data-task-status="${status}"]`)!;
    }

    it("stacks every status as a section and collapses done/canceled by default", () => {
      const { container } = renderBoard([makeTask("a", "todo"), makeTask("b", "done")]);
      const sections = Array.from(container.querySelectorAll<HTMLElement>(".mobile-board-section"));
      expect(sections.map((element) => element.dataset.taskStatus)).toEqual([...TASK_STATUSES]);
      expect(section(container, "todo").querySelector('[data-task-id="a"]')).not.toBeNull();
      expect(section(container, "done").querySelector(".mobile-board-list")).toBeNull();
      expect(section(container, "done").querySelector(".mobile-board-section-count")?.textContent).toBe("1");
      expect(section(container, "done").querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
    });

    it("toggles a section and persists the collapsed list", () => {
      const storage = memoryStorage({ [MOBILE_COLLAPSED_STORAGE_KEY]: "[]" });
      const { container } = renderBoard([makeTask("a", "todo")], { storage });
      const header = section(container, "todo").querySelector<HTMLButtonElement>(".mobile-board-section-header")!;
      expect(header.getAttribute("aria-expanded")).toBe("true");

      fireEvent.click(header);
      expect(header.getAttribute("aria-expanded")).toBe("false");
      expect(section(container, "todo").querySelector('[data-task-id="a"]')).toBeNull();
      expect(storage.values.get(MOBILE_COLLAPSED_STORAGE_KEY)).toBe("[\"todo\"]");

      cleanup();
      const again = renderBoard([makeTask("a", "todo")], { storage });
      expect(section(again.container, "todo").querySelector(".mobile-board-list")).toBeNull();
    });

    it("opens the destination sheet on tap and moves with onDrop(dest, id, null)", () => {
      const task = makeTask("a", "in_progress", CLAUDE);
      const { container, props } = renderBoard([task]);
      fireEvent.click(container.querySelector<HTMLButtonElement>('[data-task-id="a"] .mobile-task-card-open')!);

      const dialog = within(document.body).getByRole("dialog");
      const destinations = Array.from(dialog.querySelectorAll<HTMLButtonElement>("[data-destination]"))
        .map((button) => button.dataset.destination);
      expect(destinations).toEqual(["backlog", "todo", "canceled"]);

      fireEvent.click(dialog.querySelector<HTMLButtonElement>('[data-destination="todo"]')!);
      expect(props.onDrop).toHaveBeenCalledWith("todo", "a", null);
      expect(document.querySelector("[data-mobile-move-sheet]")).toBeNull();
    });

    it("opens task details from the sheet", () => {
      const task = makeTask("a", "in_review", CLAUDE);
      const { container, props } = renderBoard([task]);
      fireEvent.click(container.querySelector<HTMLButtonElement>('[data-task-id="a"] .mobile-task-card-open')!);
      const dialog = within(document.body).getByRole("dialog");
      expect(dialog.querySelector(".mobile-move-sheet-note")).not.toBeNull();

      fireEvent.click(dialog.querySelector<HTMLButtonElement>(".mobile-move-sheet-details")!);
      expect(props.onOpenTask).toHaveBeenCalledWith(task);
      expect(props.onDrop).not.toHaveBeenCalled();
      expect(document.querySelector("[data-mobile-move-sheet]")).toBeNull();
    });

    it("closes the sheet with Escape", () => {
      const { container } = renderBoard([makeTask("a", "todo")]);
      fireEvent.click(container.querySelector<HTMLButtonElement>('[data-task-id="a"] .mobile-task-card-open')!);
      expect(document.querySelector("[data-mobile-move-sheet]")).not.toBeNull();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(document.querySelector("[data-mobile-move-sheet]")).toBeNull();
    });

    it("completes in-review cards from the card button without opening the sheet", async () => {
      const task = makeTask("a", "in_review");
      const { container, props } = renderBoard([task]);
      await act(async () => {
        fireEvent.click(container.querySelector<HTMLButtonElement>('[data-task-id="a"] .mobile-task-card-complete')!);
      });
      expect(props.onComplete).toHaveBeenCalledWith(task);
      expect(document.querySelector("[data-mobile-move-sheet]")).toBeNull();
    });

    it("moves a card to the section under the finger after a 300 ms long press", () => {
      vi.useFakeTimers();
      const { container, props } = renderBoard([makeTask("a", "todo"), makeTask("b", "backlog")]);
      const card = container.querySelector<HTMLElement>('[data-task-id="a"]')!;
      const backlogSection = section(container, "backlog");
      const backlogCard = container.querySelector<HTMLElement>('[data-task-id="b"]')!;
      vi.spyOn(backlogCard, "getBoundingClientRect").mockReturnValue({ top: 310 } as DOMRect);
      Object.defineProperty(backlogCard, "offsetHeight", { configurable: true, value: 60 });
      const elementFromPoint = vi.fn(() => card as Element);
      Object.defineProperty(document, "elementFromPoint", { configurable: true, value: elementFromPoint });

      fireEvent.pointerDown(card.querySelector(".mobile-task-card-open")!, {
        pointerId: 7, button: 0, isPrimary: true, clientX: 40, clientY: 300,
      });
      act(() => {
        vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS - 1);
      });
      expect(card.classList.contains("is-mobile-dragging")).toBe(false);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(card.classList.contains("is-mobile-dragging")).toBe(true);
      expect(document.body.classList.contains("is-mobile-task-dragging")).toBe(true);

      elementFromPoint.mockReturnValue(backlogSection);
      fireEvent.pointerMove(document, { pointerId: 7, clientX: 40, clientY: 320 });
      expect(backlogSection.classList.contains("is-drop-target")).toBe(true);
      fireEvent.pointerUp(document, { pointerId: 7, clientX: 40, clientY: 320 });

      expect(props.onDrop).toHaveBeenCalledWith("backlog", "a", "b");
      expect(card.classList.contains("is-mobile-dragging")).toBe(false);
      expect(document.body.classList.contains("is-mobile-task-dragging")).toBe(false);

      // The click that follows the long press must not open the sheet.
      fireEvent.click(card.querySelector(".mobile-task-card-open")!);
      expect(document.querySelector("[data-mobile-move-sheet]")).toBeNull();
    });

    it("does not start a drag when the finger moves before the long press (scrolling)", () => {
      vi.useFakeTimers();
      const { container, props } = renderBoard([makeTask("a", "todo")]);
      const card = container.querySelector<HTMLElement>('[data-task-id="a"]')!;
      Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => card) });

      fireEvent.pointerDown(card, { pointerId: 3, button: 0, isPrimary: true, clientX: 40, clientY: 300 });
      fireEvent.pointerMove(document, { pointerId: 3, clientX: 40, clientY: 330 });
      act(() => {
        vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS * 2);
      });
      fireEvent.pointerUp(document, { pointerId: 3, clientX: 40, clientY: 330 });

      expect(card.classList.contains("is-mobile-dragging")).toBe(false);
      expect(props.onDrop).not.toHaveBeenCalled();
    });

    it("blocks native scrolling only while a long-press drag is active, also after an initial loading render", () => {
      vi.useFakeTimers();
      const storage = memoryStorage();
      const baseProps: MobileBoardProps = {
        tasksByStatus: groupTasks([makeTask("a", "todo")]),
        storage,
        loading: true,
        onDrop: vi.fn(),
        onComplete: vi.fn(async () => {}),
        onOpenTask: vi.fn(),
      };
      const { container, rerender } = render(createElement(MobileBoard, baseProps));
      expect(container.querySelector(".mobile-board.is-loading")).not.toBeNull();
      rerender(createElement(MobileBoard, { ...baseProps, loading: false }));
      const card = container.querySelector<HTMLElement>('[data-task-id="a"]')!;
      Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => card) });

      const idleMove = new Event("touchmove", { bubbles: true, cancelable: true });
      card.dispatchEvent(idleMove);
      expect(idleMove.defaultPrevented).toBe(false);

      fireEvent.pointerDown(card, { pointerId: 5, button: 0, isPrimary: true, clientX: 40, clientY: 300 });
      act(() => {
        vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
      });
      const dragMove = new Event("touchmove", { bubbles: true, cancelable: true });
      card.dispatchEvent(dragMove);
      expect(dragMove.defaultPrevented).toBe(true);
      fireEvent.pointerCancel(document, { pointerId: 5 });
      expect(baseProps.onDrop).not.toHaveBeenCalled();
    });

    it("cancels an active drag with Escape without moving", () => {
      vi.useFakeTimers();
      const { container, props } = renderBoard([makeTask("a", "todo")]);
      const card = container.querySelector<HTMLElement>('[data-task-id="a"]')!;
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: vi.fn(() => section(container, "backlog")),
      });

      fireEvent.pointerDown(card, { pointerId: 4, button: 0, isPrimary: true, clientX: 40, clientY: 300 });
      act(() => {
        vi.advanceTimersByTime(MOBILE_LONG_PRESS_MS);
      });
      fireEvent.keyDown(document, { key: "Escape" });
      fireEvent.pointerUp(document, { pointerId: 4 });
      expect(props.onDrop).not.toHaveBeenCalled();
      expect(card.classList.contains("is-mobile-dragging")).toBe(false);
    });
  });

  describe("useMobileBoardViewport", () => {
    afterEach(() => {
      cleanup();
      vi.unstubAllGlobals();
    });

    it("follows the ≤719px media query", () => {
      const listeners = new Set<() => void>();
      const media = { matches: true };
      vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
        get matches() {
          return media.matches;
        },
        media: query,
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      })));

      const { result } = renderHook(() => useMobileBoardViewport());
      expect(result.current).toBe(true);
      expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 719px)");

      act(() => {
        media.matches = false;
        listeners.forEach((listener) => listener());
      });
      expect(result.current).toBe(false);
    });
  });
}
