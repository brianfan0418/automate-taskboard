import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { getProjectAutomationDetails, updateProjectAutomation } from "../api";
import { LinearIcon } from "./LinearIcon";
import { ProjectIcon } from "./SemanticIcons";
import { TaskPropertyPicker } from "./TaskPropertyPicker";
import { TaskboardIcon } from "./TaskboardIcon";
import { useTaskboardI18n } from "../i18n";
import { runErrorMessage } from "../runErrorText";
import { listenForMenuViewportChange, listenForOutsidePointerDown } from "../menuEvents";
import type {
  AiChatModel,
  ClaudePermissionMode,
  ClaudePermissionPreview,
  ClaudeSettingsScope,
  ProjectAutomation,
  ProjectAutomationPatch,
} from "../types";
import "./ProjectAutomationMenu.css";

/**
 * @deprecated Codex Desktop cron options from the pre-v2 menu. Only kept so the existing
 * App.tsx mount keeps type-checking until the integrator removes it; the menu never emits them.
 */
export interface LegacyAutomationOptions {
  enabledByUser: boolean;
  quotaAware: boolean;
  intervalMinutes: 5 | 10 | 15 | 30 | 60;
  model: string;
  reasoningEffort: string;
}

interface ProjectAutomationMenuProps {
  // Taskboard project whose backend automation settings are shown (GET/PUT /api/projects/:id/automation).
  projectId?: string | null;
  // Optional Codex model catalog; when empty the Codex model is a free-text field.
  models?: AiChatModel[];
  /** @deprecated ignored (pre-v2 cron state) */
  automation?: unknown;
  /** @deprecated ignored */
  pending?: boolean;
  /** @deprecated ignored */
  error?: string | null;
  /** @deprecated ignored */
  unavailableReason?: string | null;
  /** @deprecated never called (pre-v2 host automation request) */
  onOpen?: () => void;
  /** @deprecated never called (pre-v2 host automation request) */
  onChange?: (options: LegacyAutomationOptions) => void;
}

type PickerMenu = "maxParallel" | "codexModel" | "codexEffort" | null;

const MAX_PARALLEL_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** Amendments 5 / 6: 「Claude 權限」 choices (value → [Traditional Chinese, English]). */
export const CLAUDE_PERMISSION_MODE_LABELS: Record<ClaudePermissionMode, readonly [string, string]> = {
  followClaude: ["跟著 Claude 設定", "Follow Claude settings"],
  bypassPermissions: [
    "完整權限（不會停下來問，AI 可執行任何指令）",
    "Full permissions (never stops to ask; the AI can run any command)",
  ],
  acceptEdits: [
    "只自動允許改檔（執行指令時會停下來等你到 App 確認）",
    "Auto-allow file edits only (stops and waits for you to confirm commands in the App)",
  ],
};
const CLAUDE_PERMISSION_MODES: ClaudePermissionMode[] = ["followClaude", "bypassPermissions", "acceptEdits"];
const DEFAULT_CLAUDE_PERMISSION_MODE: ClaudePermissionMode = "followClaude";

/** Amendment 6: which Claude settings file a detected mode came from. */
export const CLAUDE_SETTINGS_SCOPE_LABELS: Record<ClaudeSettingsScope, readonly [string, string]> = {
  managed: ["組織管理設定", "managed settings"],
  projectLocal: ["專案 .claude/settings.local.json", "project .claude/settings.local.json"],
  project: ["專案 .claude/settings.json", "project .claude/settings.json"],
  user: ["使用者 settings.json", "user settings.json"],
};

type TextFn = (chinese: string, english: string, taiwanese?: string) => string;

/** Amendment 6: 「目前 Claude 設定：…」 under the select while 「跟著 Claude 設定」 is chosen. */
export function claudePermissionPreviewText(preview: ClaudePermissionPreview, text: TextFn): string {
  const source = preview.claudePermissionSource;
  if (!source) {
    return text(
      "目前 Claude 設定：沒有設定預設權限，看板會用完整權限（bypassPermissions）",
      "Current Claude setting: no default permission mode, so the board uses full permissions (bypassPermissions)",
    );
  }
  const scope = CLAUDE_SETTINGS_SCOPE_LABELS[source.scope] ?? [source.scope, source.scope];
  const effective = preview.claudeEffectivePermissionMode;
  const configured = source.configuredMode;
  const ignored = configured && configured !== effective && !(configured === "manual" && effective === "default");
  const mode = effective ?? text("Claude 內建預設", "Claude's built-in default");
  const [scopeChinese, scopeEnglish] = scope;
  return ignored
    ? text(
      `目前 Claude 設定：${mode}（來源：${scopeChinese}；專案設定裡的 ${configured} 不會生效）`,
      `Current Claude setting: ${mode} (from ${scopeEnglish}; ${configured} does not take effect from project settings)`,
    )
    : text(`目前 Claude 設定：${mode}（來源：${scopeChinese}）`, `Current Claude setting: ${mode} (from ${scopeEnglish})`);
}
const DEFAULT_CODEX_EFFORTS = ["low", "medium", "high", "xhigh"];

const EFFORT_LABELS: Record<string, readonly [string, string]> = {
  low: ["輕度", "Low"],
  medium: ["中", "Medium"],
  high: ["高", "High"],
  xhigh: ["極高 (xhigh)", "Extra high (xhigh)"],
  max: ["最高", "Maximum"],
  ultra: ["極高 (ultra)", "Ultra"],
};

function messageFor(error: unknown, fallback: string, text: TextFn): string {
  return runErrorMessage(error, text, fallback);
}

export function ProjectAutomationMenu({
  projectId = null,
  models = [],
}: ProjectAutomationMenuProps) {
  const { text } = useTaskboardI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const projectIdRef = useRef(projectId);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const [open, setOpen] = useState(false);
  const [pickerMenu, setPickerMenu] = useState<PickerMenu>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const [automation, setAutomation] = useState<ProjectAutomation | null>(null);
  const [claudePermission, setClaudePermission] = useState<ClaudePermissionPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingCount, setSavingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [claudeModelDraft, setClaudeModelDraft] = useState("");
  const [codexModelDraft, setCodexModelDraft] = useState("");
  projectIdRef.current = projectId;

  const enabled = automation?.enabled ?? false;
  const disabled = !projectId || !automation;
  const stateLabel = enabled ? text("運行中", "Running") : text("已暫停", "Paused");
  const triggerLabel = enabled ? text("自動認領中", "Auto-claiming") : text("自動化", "Automation");

  const loadAutomation = useCallback((signal?: AbortSignal) => {
    if (!projectId) {
      setAutomation(null);
      setClaudePermission(null);
      setLoading(false);
      return;
    }
    const requestProjectId = projectId;
    setLoading(true);
    setError(null);
    void getProjectAutomationDetails(requestProjectId, signal).then(
      (next) => {
        if (signal?.aborted || projectIdRef.current !== requestProjectId) return;
        setAutomation(next.automation);
        setClaudePermission(next.claudePermission);
        setLoading(false);
      },
      (loadError) => {
        if ((loadError as Error).name === "AbortError" || projectIdRef.current !== requestProjectId) return;
        setError(messageFor(loadError, text("無法讀取自動認領設定。", "Could not load auto-claim settings."), text));
        setLoading(false);
      },
    );
  }, [projectId, text]);

  useEffect(() => {
    setAutomation(null);
    setClaudePermission(null);
    setError(null);
    const controller = new AbortController();
    loadAutomation(controller.signal);
    return () => controller.abort();
  }, [projectId]);

  useEffect(() => {
    setClaudeModelDraft(automation?.claudeModel ?? "");
  }, [automation?.claudeModel]);

  useEffect(() => {
    setCodexModelDraft(automation?.codexModel ?? "");
  }, [automation?.codexModel]);

  useEffect(() => {
    if (!open) setPickerMenu(null);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(trigger.right - menu.width, window.innerWidth - menu.width - 8));
    const top = trigger.bottom + 8 + menu.height <= window.innerHeight
      ? trigger.bottom + 8
      : Math.max(8, trigger.top - menu.height - 8);
    setPosition({ left, top, ready: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const stopOutside = listenForOutsidePointerDown([triggerRef, menuRef], close);
    const stopViewport = listenForMenuViewportChange(menuRef, close);
    function closeFromEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape" && !pickerMenu) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      stopOutside();
      stopViewport();
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [open, pickerMenu]);

  function save(patch: ProjectAutomationPatch) {
    if (!projectId || !automation) return;
    const requestProjectId = projectId;
    setAutomation((current) => current ? { ...current, ...patch } : current);
    setError(null);
    setSavingCount((count) => count + 1);
    // Saves run one at a time so a later change never lands before an earlier one.
    saveChainRef.current = saveChainRef.current.then(async () => {
      try {
        const next = await updateProjectAutomation(requestProjectId, patch);
        if (projectIdRef.current === requestProjectId) setAutomation(next);
      } catch (saveError) {
        if (projectIdRef.current !== requestProjectId) return;
        setError(messageFor(saveError, text("無法更新自動認領設定。", "Could not update auto-claim settings."), text));
        loadAutomation();
      } finally {
        setSavingCount((count) => Math.max(0, count - 1));
      }
    });
  }

  function commitModel(field: "claudeModel" | "codexModel", value: string) {
    if (!automation) return;
    const normalized = value.trim() || null;
    if (normalized === (automation[field] ?? null)) return;
    save(field === "claudeModel" ? { claudeModel: normalized } : { codexModel: normalized });
  }

  function commitOnEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    }
  }

  const maxParallelChoices = automation && !MAX_PARALLEL_CHOICES.includes(automation.maxParallel)
    ? [...MAX_PARALLEL_CHOICES, automation.maxParallel].sort((left, right) => left - right)
    : MAX_PARALLEL_CHOICES;
  const codexModel = automation?.codexModel ?? "";
  const selectedCodexModel = models.find((model) => model.slug === codexModel);
  const codexModelOptions = [
    { value: "", label: text("預設", "Default"), icon: <ProjectIcon color="currentColor" size={14} /> },
    ...models.map((model) => ({
      value: model.slug,
      label: model.displayName,
      icon: <ProjectIcon color="currentColor" size={14} />,
    })),
    ...(codexModel && !selectedCodexModel
      ? [{ value: codexModel, label: codexModel, icon: <ProjectIcon color="currentColor" size={14} /> }]
      : []),
  ];
  const codexEffort = automation?.codexEffort ?? "";
  const effortValues = selectedCodexModel?.supportedReasoningEfforts.length
    ? selectedCodexModel.supportedReasoningEfforts
    : DEFAULT_CODEX_EFFORTS;
  const codexEffortOptions = [
    { value: "", label: text("預設", "Default"), icon: <LinearIcon name="displayOptions" /> },
    ...[...effortValues, ...(codexEffort && !effortValues.includes(codexEffort) ? [codexEffort] : [])]
      .map((effort) => ({
        value: effort,
        label: EFFORT_LABELS[effort] ? text(...EFFORT_LABELS[effort]) : effort,
        icon: <LinearIcon name="displayOptions" />,
      })),
  ];

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="project-automation-menu no-drag"
      role="dialog"
      aria-label={text("自動認領待辦設定", "Auto-claim settings")}
      aria-busy={loading || savingCount > 0}
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
    >
      <div className="project-automation-menu-heading">
        <strong>{text("自動認領待辦", "Auto-claim tasks")}</strong>
        <span className={enabled ? "is-active" : "is-paused"}>{stateLabel}</span>
      </div>
      <div className="project-automation-switch">
        <span>{text("自動認領開關", "Auto-claim")}</span>
        <button
          type="button"
          className={`board-setting-switch${enabled ? " is-on" : ""}`}
          role="switch"
          aria-checked={enabled}
          aria-label={text("自動認領開關", "Auto-claim")}
          disabled={disabled}
          onClick={() => save({ enabled: !enabled })}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      <div className="project-automation-field">
        <span>{text("同時處理上限", "Max parallel")}</span>
        <TaskPropertyPicker
          value={String(automation?.maxParallel ?? 3)}
          options={maxParallelChoices.map((count) => ({
            value: String(count),
            label: text(`${count} 件`, `${count}`),
            icon: <LinearIcon name="displayOptions" />,
          }))}
          open={pickerMenu === "maxParallel"}
          disabled={disabled}
          className="project-automation-picker"
          triggerClassName="project-automation-picker-trigger"
          ariaLabel={text("同時處理上限", "Max parallel")}
          onOpenChange={(nextOpen) => setPickerMenu(nextOpen ? "maxParallel" : null)}
          onChange={(value) => {
            const maxParallel = Number(value);
            if (Number.isInteger(maxParallel) && maxParallel !== automation?.maxParallel) save({ maxParallel });
          }}
        />
      </div>
      <label className="project-automation-field">
        <span>{text("Claude 模型", "Claude model")}</span>
        <input
          className="project-automation-text-input"
          type="text"
          value={claudeModelDraft}
          placeholder={text("預設", "Default")}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => setClaudeModelDraft(event.target.value)}
          onBlur={(event) => commitModel("claudeModel", event.currentTarget.value)}
          onKeyDown={commitOnEnter}
        />
      </label>
      <label className="project-automation-field project-automation-permission">
        <span>{text("Claude 權限", "Claude permissions")}</span>
        <select
          className="project-automation-text-input project-automation-select"
          value={automation?.claudePermissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE}
          disabled={disabled}
          onChange={(event) => {
            const next = event.currentTarget.value as ClaudePermissionMode;
            if (CLAUDE_PERMISSION_MODES.includes(next) && next !== automation?.claudePermissionMode) {
              save({ claudePermissionMode: next });
            }
          }}
        >
          {CLAUDE_PERMISSION_MODES.map((mode) => (
            <option key={mode} value={mode}>{text(...CLAUDE_PERMISSION_MODE_LABELS[mode])}</option>
          ))}
        </select>
      </label>
      {automation?.claudePermissionMode === "followClaude" && claudePermission && (
        <p className="project-automation-note project-automation-claude-setting" role="status">
          {claudePermissionPreviewText(claudePermission, text)}
        </p>
      )}
      {models.length > 0 ? (
        <div className="project-automation-field">
          <span>{text("Codex 模型", "Codex model")}</span>
          <TaskPropertyPicker
            value={codexModel}
            options={codexModelOptions}
            open={pickerMenu === "codexModel"}
            disabled={disabled}
            className="project-automation-picker"
            triggerClassName="project-automation-picker-trigger"
            ariaLabel={text("Codex 模型", "Codex model")}
            onOpenChange={(nextOpen) => setPickerMenu(nextOpen ? "codexModel" : null)}
            onChange={(value) => commitModel("codexModel", value)}
          />
        </div>
      ) : (
        <label className="project-automation-field">
          <span>{text("Codex 模型", "Codex model")}</span>
          <input
            className="project-automation-text-input"
            type="text"
            value={codexModelDraft}
            placeholder={text("預設", "Default")}
            disabled={disabled}
            spellCheck={false}
            onChange={(event) => setCodexModelDraft(event.target.value)}
            onBlur={(event) => commitModel("codexModel", event.currentTarget.value)}
            onKeyDown={commitOnEnter}
          />
        </label>
      )}
      <div className="project-automation-field">
        <span>{text("Codex 推理強度", "Codex reasoning effort")}</span>
        <TaskPropertyPicker
          value={codexEffort}
          options={codexEffortOptions}
          open={pickerMenu === "codexEffort"}
          disabled={disabled}
          className="project-automation-picker"
          triggerClassName="project-automation-picker-trigger"
          ariaLabel={text("Codex 推理強度", "Codex reasoning effort")}
          onOpenChange={(nextOpen) => setPickerMenu(nextOpen ? "codexEffort" : null)}
          onChange={(value) => {
            const next = value || null;
            if (next !== (automation?.codexEffort ?? null)) save({ codexEffort: next });
          }}
        />
      </div>
      <p className="project-automation-note">
        {text(
          "開啟後，看板會依排序自動開工「等待認領」裡指派給 Codex 或 Claude 的卡片；手動開工不受上限限制。",
          "When on, the board starts To do cards assigned to Codex or Claude in board order. Manual starts ignore the limit.",
        )}
      </p>
      {!projectId && (
        <p className="project-automation-note">
          {text("尚未選擇專案，無法讀取自動認領設定。", "No project is selected, so auto-claim settings are unavailable.")}
        </p>
      )}
      {loading && !automation && projectId && (
        <p className="project-automation-note">{text("正在讀取設定…", "Loading settings…")}</p>
      )}
      {error && <p className="project-automation-error" role="alert">{error}</p>}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`project-automation-trigger no-drag ${enabled ? "is-active" : "is-paused"}`}
        aria-label={triggerLabel}
        aria-busy={loading || savingCount > 0}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={triggerLabel}
        onClick={() => {
          if (!open) {
            setPosition((current) => ({ ...current, ready: false }));
            loadAutomation();
          }
          setOpen((current) => !current);
        }}
      >
        <TaskboardIcon name={enabled ? "automationPause" : "automationPlay"} />
        <span>{triggerLabel}</span>
      </button>
      {menu}
    </>
  );
}
