import { createContext, useContext, type ReactNode } from "react";
import type { TaskPriority, TaskStatus } from "./types";
import { TAIWAN_TEXT } from "./zh-TW";

export type TaskboardLanguage = "zh-TW" | "zh" | "en";

interface TaskboardI18n {
  language: TaskboardLanguage;
  locale: "zh-TW" | "zh-CN" | "en";
  text: (chinese: string, english: string, taiwanese?: string) => string;
}

const I18N: Record<TaskboardLanguage, TaskboardI18n> = {
  "zh-TW": {
    language: "zh-TW",
    locale: "zh-TW",
    text: (chinese, _english, taiwanese) => taiwanese ?? TAIWAN_TEXT[chinese] ?? chinese,
  },
  zh: {
    language: "zh",
    locale: "zh-CN",
    text: (chinese) => chinese,
  },
  en: {
    language: "en",
    locale: "en",
    text: (_chinese, english) => english,
  },
};

const STATUS_LABELS: Record<TaskboardLanguage, Record<TaskStatus, string>> = {
  "zh-TW": {
    backlog: "待立項",
    todo: "等待認領",
    in_progress: "處理中",
    in_review: "等你確認",
    blocked: "遇到阻礙",
    done: "完成",
    canceled: "取消",
  },
  zh: {
    backlog: "待立项",
    todo: "等待认领",
    in_progress: "处理中",
    in_review: "等你确认",
    blocked: "遇到阻碍",
    done: "完成",
    canceled: "取消",
  },
  en: {
    backlog: "Backlog",
    todo: "To do",
    in_progress: "In progress",
    in_review: "In review",
    blocked: "Blocked",
    done: "Done",
    canceled: "Canceled",
  },
};

const PRIORITY_LABELS: Record<TaskboardLanguage, Record<TaskPriority, string>> = {
  "zh-TW": { none: "無優先順序", urgent: "緊急", high: "高", medium: "中", low: "低" },
  zh: {
    none: "无优先级",
    urgent: "紧急",
    high: "高",
    medium: "中",
    low: "低",
  },
  en: {
    none: "No priority",
    urgent: "Urgent",
    high: "High",
    medium: "Medium",
    low: "Low",
  },
};

const TaskboardLanguageContext = createContext<TaskboardLanguage>("zh-TW");

export function resolveTaskboardLanguage(value: string | null | undefined): TaskboardLanguage {
  const normalized = value?.trim().replaceAll("_", "-").toLowerCase() ?? "";
  if (/^zh-(?:tw|hant|hk|mo)(?:-|$)/.test(normalized)) return "zh-TW";
  if (normalized === "zh" || /^zh-(?:cn|hans|sg)(?:-|$)/.test(normalized)) return "zh";
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  return "zh-TW";
}

export const TASKBOARD_LANGUAGE_KEY = "taskboard.language";

// A saved or URL choice outranks host-context updates. Default (no saved/query value) is Taiwan.
export function preferredTaskboardLanguage(saved?: string | null, query?: string | null): TaskboardLanguage {
  return resolveTaskboardLanguage(saved || query);
}

/** True for every Chinese UI language (zh-TW and zh). Use this instead of `language === "zh"`. */
export function isChineseLanguage(language: TaskboardLanguage): boolean {
  return language === "zh-TW" || language === "zh";
}

export function getTaskboardI18n(language: TaskboardLanguage): TaskboardI18n {
  return I18N[language];
}

export function taskStatusLabel(language: TaskboardLanguage, status: TaskStatus): string {
  return STATUS_LABELS[language][status];
}

export function taskPriorityLabel(language: TaskboardLanguage, priority: TaskPriority): string {
  return PRIORITY_LABELS[language][priority];
}

export function TaskboardLanguageProvider({
  language,
  children,
}: {
  language: TaskboardLanguage;
  children: ReactNode;
}) {
  return (
    <TaskboardLanguageContext.Provider value={language}>
      {children}
    </TaskboardLanguageContext.Provider>
  );
}

export function useTaskboardI18n(): TaskboardI18n {
  return I18N[useContext(TaskboardLanguageContext)];
}
