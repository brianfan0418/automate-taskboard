import { useCallback, useState, useSyncExternalStore } from "react";
import { taskboardPageHostname } from "./hostEmbedding";
import { taskboardStorage } from "./storage";

/**
 * W12-B 文字大小: four steps implemented by scaling the root font-size as a percentage of the
 * browser/OS default (never a hard-coded px), so every rem-based size and text-following layout
 * length scales together. Stored per device (localStorage), never synced through client-storage.
 */
export type TextSizeStep = "small" | "standard" | "large" | "xlarge";

export const TEXT_SIZE_STORAGE_KEY = "taskboard.text-size.v1";
export const DEFAULT_TEXT_SIZE: TextSizeStep = "standard";
export const TEXT_SIZE_STEPS: readonly TextSizeStep[] = ["small", "standard", "large", "xlarge"];
export const TEXT_SIZE_SCALE: Readonly<Record<TextSizeStep, number>> = {
  small: 0.9,
  standard: 1,
  large: 1.15,
  xlarge: 1.3,
};

type TextFn = (chinese: string, english: string, taiwanese?: string) => string;

export function textSizeLabel(step: TextSizeStep, text: TextFn): string {
  switch (step) {
    case "small": return text("小", "Small", "小");
    case "standard": return text("标准", "Default", "標準");
    case "large": return text("大", "Large", "大");
    case "xlarge": return text("特大", "Extra large", "特大");
  }
}

export function resolveTextSize(value: string | null | undefined): TextSizeStep {
  return TEXT_SIZE_STEPS.includes(value as TextSizeStep) ? value as TextSizeStep : DEFAULT_TEXT_SIZE;
}

function deviceStorage(): Storage | null {
  try {
    const storage = typeof window === "undefined" ? null : window.localStorage;
    if (!storage) return null;
    storage.getItem(TEXT_SIZE_STORAGE_KEY);
    return storage;
  } catch {
    return null;
  }
}

/**
 * Without localStorage (the Codex App embeds the board in a sandboxed iframe with an opaque origin, where
 * reading window.localStorage throws) the step goes to the board's client storage instead, under a key that
 * includes the hostname the board was opened through: the embedded panel on this PC uses 127.0.0.1, a phone
 * uses the tailnet address, so one device's choice does not change another's.
 */
export function textSizeFallbackKey(hostname: string = taskboardPageHostname()): string {
  return `${TEXT_SIZE_STORAGE_KEY}.host.${hostname || "unknown"}`;
}

export function readStoredTextSize(): TextSizeStep {
  try {
    const storage = deviceStorage();
    if (storage) return resolveTextSize(storage.getItem(TEXT_SIZE_STORAGE_KEY));
    return resolveTextSize(taskboardStorage.getItem(textSizeFallbackKey()));
  } catch {
    return DEFAULT_TEXT_SIZE;
  }
}

export function storeTextSize(step: TextSizeStep): void {
  try {
    const storage = deviceStorage();
    const key = storage ? TEXT_SIZE_STORAGE_KEY : textSizeFallbackKey();
    const target = storage ?? taskboardStorage;
    if (step === DEFAULT_TEXT_SIZE) target.removeItem(key);
    else target.setItem(key, step);
  } catch {
    // Blocked storage: the choice still applies for this page view.
  }
}

/** Applies the step to <html data-text-size>; styles.css maps it to a root font-size percentage. */
export function applyTextSize(step: TextSizeStep, root: HTMLElement | null = typeof document === "undefined" ? null : document.documentElement): void {
  if (!root) return;
  if (step === DEFAULT_TEXT_SIZE) delete root.dataset.textSize;
  else root.dataset.textSize = step;
}

/** State for the setting UI. main.tsx already applied the stored step before the first render. */
export function useTextSize(): [TextSizeStep, (step: TextSizeStep) => void] {
  const [step, setStep] = useState<TextSizeStep>(readStoredTextSize);
  const choose = useCallback((next: TextSizeStep) => {
    storeTextSize(next);
    applyTextSize(next);
    setStep(next);
  }, []);
  return [step, choose];
}

/** Current root font size divided by 16 (browser default × 文字大小), for JS-drawn px layouts. */
export function readRootTextScale(): number {
  if (typeof document === "undefined") return 1;
  const px = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(px) && px > 0 ? px / 16 : 1;
}

function subscribeRootTextScale(onChange: () => void) {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-text-size", "style", "class"] });
  return () => observer.disconnect();
}

/** Re-renders when 文字大小 changes; px-based widgets (Gantt, AI chat panel bounds) multiply by this. */
export function useRootTextScale(): number {
  return useSyncExternalStore(subscribeRootTextScale, readRootTextScale, () => 1);
}

export function TextSizeSetting({
  value,
  onChange,
  text,
  className = "project-menu-language project-menu-text-size",
}: {
  value: TextSizeStep;
  onChange: (step: TextSizeStep) => void;
  text: TextFn;
  className?: string;
}) {
  const label = text("文字大小", "Text size", "文字大小");
  return (
    <label className={className}>
      <span>{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(resolveTextSize(event.target.value))}
      >
        {TEXT_SIZE_STEPS.map((step) => (
          <option key={step} value={step}>
            {textSizeLabel(step, text)}{text(`（${Math.round(TEXT_SIZE_SCALE[step] * 100)}%）`, ` (${Math.round(TEXT_SIZE_SCALE[step] * 100)}%)`)}
          </option>
        ))}
      </select>
    </label>
  );
}
