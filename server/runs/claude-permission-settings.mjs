import nodeFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { claudeConfigDirectory } from "./claude-transcript.mjs";

// CONTRACTS Amendment 6: which permission mode Claude Code's own settings select for a folder.
// Source: Claude Code docs (code.claude.com/docs/en/settings, /permission-modes#which-mode-a-session-starts-in,
// /managed-settings), checked 2026-09-17:
// - key `permissions.defaultMode`; values default | acceptEdits | plan | auto | dontAsk | bypassPermissions,
//   plus `manual` as an alias for `default`;
// - precedence (highest first): managed settings, command line, `<project>/.claude/settings.local.json`,
//   `<project>/.claude/settings.json`, user `~/.claude/settings.json` (`%USERPROFILE%\.claude` on Windows,
//   or `CLAUDE_CONFIG_DIR`). The shared project file is read from the session's working directory; on
//   Windows the local file stays next to it (elsewhere Claude may use the git repository root — not modelled);
// - `auto` and `bypassPermissions` do not take effect from the two project files: project `auto` makes
//   Claude use its built-in default (not the user file), project `bypassPermissions` starts in Manual;
// - file-based managed settings: `managed-settings.json`, then `managed-settings.d/*.json` in alphabetical
//   order (a later single value replaces an earlier one; hidden and non-.json files are ignored).
// Registry / MDM / server-managed policy is not detected.

export const CLAUDE_SETTINGS_PERMISSION_MODES = Object.freeze([
  "default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions",
]);
export const CLAUDE_SETTINGS_SCOPES = Object.freeze(["managed", "projectLocal", "project", "user"]);

const MODE_ALIASES = Object.freeze({ manual: "default" });
const PROJECT_SCOPES = new Set(["projectLocal", "project"]);

export function managedSettingsDirectory(platform = process.platform) {
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  return "/etc/claude-code";
}

export function managedSettingsPath(platform = process.platform) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.join(managedSettingsDirectory(platform), "managed-settings.json");
}

/** Settings files that can set `permissions.defaultMode`, highest precedence first (managed drop-ins excluded). */
export function claudeSettingsFiles({ cwd = null, env = process.env, homedir = os.homedir, platform = process.platform } = {}) {
  const home = typeof homedir === "function" ? homedir() : homedir;
  const files = [{ scope: "managed", path: managedSettingsPath(platform) }];
  if (typeof cwd === "string" && cwd.trim()) {
    files.push({ scope: "projectLocal", path: path.join(cwd, ".claude", "settings.local.json") });
    files.push({ scope: "project", path: path.join(cwd, ".claude", "settings.json") });
  }
  files.push({ scope: "user", path: path.join(claudeConfigDirectory({ env, homedir: home }), "settings.json") });
  return files;
}

/** `manual` → `default`; any other string that is not a documented mode → null. */
export function normalizeClaudeSettingsMode(value) {
  if (typeof value !== "string") return null;
  if (Object.hasOwn(MODE_ALIASES, value)) return MODE_ALIASES[value];
  return CLAUDE_SETTINGS_PERMISSION_MODES.includes(value) ? value : null;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Returns the raw `permissions.defaultMode` string, or null when the file is missing, unreadable,
// not JSON, or has no string value there.
async function readConfiguredMode(fs, filePath) {
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(String(content).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.permissions)) return null;
  const mode = parsed.permissions.defaultMode;
  return typeof mode === "string" ? mode : null;
}

// `managed-settings.d/*.json` (not hidden), alphabetical; a missing directory → none.
async function managedDropInFiles(fs, platform) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const directory = pathApi.join(managedSettingsDirectory(platform), "managed-settings.d");
  let names;
  try {
    names = typeof fs.readdir === "function" ? await fs.readdir(directory) : [];
  } catch {
    return [];
  }
  return names.map(String)
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort()
    .map((name) => pathApi.join(directory, name));
}

/**
 * @returns {Promise<{ effectiveMode: string | null, source: { scope: string, path: string, configuredMode: string } | null }>}
 * `source: null` → no settings file selects a mode. `effectiveMode: null` with a source → Claude's
 * built-in default applies (project / local `auto`), which depends on plan and cannot be read from files.
 */
export async function detectClaudePermissionMode({
  cwd = null,
  env = process.env,
  homedir = os.homedir,
  platform = process.platform,
  fs = nodeFs,
} = {}) {
  for (const file of claudeSettingsFiles({ cwd, env, homedir, platform })) {
    const candidates = file.scope === "managed" ? [file.path, ...await managedDropInFiles(fs, platform)] : [file.path];
    let found = null;
    for (const candidate of candidates) {
      const configuredMode = await readConfiguredMode(fs, candidate);
      const mode = normalizeClaudeSettingsMode(configuredMode);
      // Managed files merge in order, so a later drop-in's value replaces an earlier one.
      if (mode !== null) found = { mode, source: { scope: file.scope, path: candidate, configuredMode } };
    }
    if (found === null) continue;
    const { mode, source } = found;
    if (PROJECT_SCOPES.has(file.scope) && mode === "auto") return { effectiveMode: null, source };
    if (PROJECT_SCOPES.has(file.scope) && mode === "bypassPermissions") return { effectiveMode: "default", source };
    return { effectiveMode: mode, source };
  }
  return { effectiveMode: null, source: null };
}
