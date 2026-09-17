/*
 * W12-B 文字大小 setting (vitest + jsdom):
 *   npx vitest run web/src/textSize.test.tsx --environment jsdom
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { getTaskboardI18n } from "./i18n";
import {
  DEFAULT_TEXT_SIZE,
  TEXT_SIZE_SCALE,
  TEXT_SIZE_STEPS,
  TEXT_SIZE_STORAGE_KEY,
  TextSizeSetting,
  applyTextSize,
  readStoredTextSize,
  resolveTextSize,
  storeTextSize,
  textSizeFallbackKey,
  useRootTextScale,
  useTextSize,
} from "./textSize";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.textSize;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  delete document.documentElement.dataset.textSize;
  window.history.replaceState(null, "", "/");
});

describe("W12-B 文字大小 model", () => {
  it("has four steps 小 90% / 標準 100% (default) / 大 115% / 特大 130%", () => {
    expect(TEXT_SIZE_STEPS).toEqual(["small", "standard", "large", "xlarge"]);
    expect(TEXT_SIZE_STEPS.map((step) => TEXT_SIZE_SCALE[step])).toEqual([0.9, 1, 1.15, 1.3]);
    expect(DEFAULT_TEXT_SIZE).toBe("standard");
    expect(resolveTextSize(null)).toBe("standard");
    expect(resolveTextSize("huge")).toBe("standard");
    expect(resolveTextSize("xlarge")).toBe("xlarge");
  });

  it("persists per device in localStorage and applies to <html data-text-size>", () => {
    storeTextSize("large");
    expect(window.localStorage.getItem(TEXT_SIZE_STORAGE_KEY)).toBe("large");
    expect(readStoredTextSize()).toBe("large");
    applyTextSize("large");
    expect(document.documentElement.dataset.textSize).toBe("large");

    storeTextSize("standard");
    applyTextSize("standard");
    expect(window.localStorage.getItem(TEXT_SIZE_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute("data-text-size")).toBe(false);
  });

  it("without localStorage (sandboxed Codex iframe) it keeps the step in client storage under a per-host key", () => {
    const blocked = () => { throw new DOMException("The document is sandboxed and lacks the 'allow-same-origin' flag.", "SecurityError"); };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(blocked);
    expect(readStoredTextSize()).toBe("standard");
    expect(() => storeTextSize("xlarge")).not.toThrow();
    expect(readStoredTextSize()).toBe("xlarge");
    expect(textSizeFallbackKey("127.0.0.1")).toBe("taskboard.text-size.v1.host.127.0.0.1");
    expect(textSizeFallbackKey("100.64.0.2")).not.toBe(textSizeFallbackKey("127.0.0.1"));
    storeTextSize("standard");
    expect(readStoredTextSize()).toBe("standard");
  });

  it("useRootTextScale follows the root font size when 文字大小 changes", async () => {
    const root = document.documentElement;
    const { result } = renderHook(() => useRootTextScale());
    expect(result.current).toBe(1);
    await act(async () => {
      root.style.fontSize = "20.8px";
      root.dataset.textSize = "xlarge";
      await Promise.resolve();
    });
    expect(result.current).toBeCloseTo(1.3);
    root.style.fontSize = "";
  });

  it("useTextSize restores the saved step on mount and updates root + storage on change", () => {
    window.localStorage.setItem(TEXT_SIZE_STORAGE_KEY, "small");
    const { result, rerender } = renderHook(() => useTextSize());
    expect(result.current[0]).toBe("small");
    const firstSetter = result.current[1];
    rerender();
    expect(result.current[1]).toBe(firstSetter);
    act(() => result.current[1]("xlarge"));
    expect(result.current[0]).toBe("xlarge");
    expect(document.documentElement.dataset.textSize).toBe("xlarge");
    expect(window.localStorage.getItem(TEXT_SIZE_STORAGE_KEY)).toBe("xlarge");
  });
});

describe("W12-B TextSizeSetting", () => {
  it("renders zh-TW labels with percentages and reports the chosen step", () => {
    const onChange = vi.fn();
    const { text } = getTaskboardI18n("zh-TW");
    render(<TextSizeSetting value="standard" onChange={onChange} text={text} />);
    const select = screen.getByRole("combobox", { name: "文字大小" }) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "小（90%）", "標準（100%）", "大（115%）", "特大（130%）",
    ]);
    expect(select.value).toBe("standard");
    fireEvent.change(select, { target: { value: "large" } });
    expect(onChange).toHaveBeenCalledWith("large");
  });

  it("uses English and Simplified Chinese copy through text()", () => {
    render(<TextSizeSetting value="small" onChange={() => {}} text={getTaskboardI18n("en").text} />);
    const select = screen.getByRole("combobox", { name: "Text size" }) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Small (90%)", "Default (100%)", "Large (115%)", "Extra large (130%)",
    ]);
    cleanup();
    render(<TextSizeSetting value="small" onChange={() => {}} text={getTaskboardI18n("zh").text} />);
    const zh = screen.getByRole("combobox", { name: "文字大小" }) as HTMLSelectElement;
    expect(zh.options[1].textContent).toBe("标准（100%）");
  });

  it("sits next to 語言 in the project menu and applies the choice to the page", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("EventSource", class { addEventListener() {} removeEventListener() {} close() {} });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1/");
      if (url.pathname === "/api/projects") {
        return jsonResponse({ projects: [{ id: "p1", name: "專案一", workspacePath: null, source: "local", labels: [], issueCount: 0, createdAt: "x", updatedAt: "x" }] });
      }
      if (url.pathname === "/api/tasks") return jsonResponse({ tasks: [] });
      if (url.pathname.endsWith("/automation")) return jsonResponse({ automation: { projectId: "p1", enabled: false, maxParallel: 1, orderMode: "suggested" } });
      if (url.pathname.endsWith("/development-contexts")) return jsonResponse({ contexts: [] });
      return jsonResponse({});
    }));
    window.history.replaceState(null, "", "/?project=p1");
    render(<App />);
    await screen.findAllByText("專案一");
    // First use opens the project menu by itself; otherwise open it from the header.
    if (!document.querySelector(".header-project-menu")) fireEvent.click(document.querySelector(".header-project-button")!);
    await waitFor(() => expect(document.querySelector(".header-project-menu")).toBeTruthy());
    const menu = document.querySelector(".header-project-menu") as HTMLElement;
    const language = within(menu).getByRole("combobox", { name: "語言" });
    const textSize = within(menu).getByRole("combobox", { name: "文字大小" }) as HTMLSelectElement;
    expect(language.closest("label")?.nextElementSibling).toBe(textSize.closest("label"));
    expect(textSize.value).toBe("standard");
    fireEvent.change(textSize, { target: { value: "xlarge" } });
    expect(document.documentElement.dataset.textSize).toBe("xlarge");
    expect(window.localStorage.getItem(TEXT_SIZE_STORAGE_KEY)).toBe("xlarge");
    expect((within(menu).getByRole("combobox", { name: "文字大小" }) as HTMLSelectElement).value).toBe("xlarge");
  });
});
