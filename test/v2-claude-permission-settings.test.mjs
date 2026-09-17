// CONTRACTS Amendment 6: reading Claude Code's permissions.defaultMode with a fake file system.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  CLAUDE_SETTINGS_PERMISSION_MODES,
  claudeSettingsFiles,
  detectClaudePermissionMode,
  managedSettingsDirectory,
  managedSettingsPath,
  normalizeClaudeSettingsMode,
} from "../server/runs/claude-permission-settings.mjs";

const CWD = path.join("C:\\", "work", "alpha");
const HOME = path.join("C:\\", "Users", "alice");
const MANAGED = managedSettingsPath("win32");
const PROJECT_LOCAL = path.join(CWD, ".claude", "settings.local.json");
const PROJECT = path.join(CWD, ".claude", "settings.json");
const USER = path.join(HOME, ".claude", "settings.json");

function fakeFs(files, directories = {}) {
  const reads = [];
  return {
    reads,
    async readdir(directory) {
      if (!Object.hasOwn(directories, directory)) {
        const error = new Error(`ENOENT: ${directory}`);
        error.code = "ENOENT";
        throw error;
      }
      return directories[directory];
    },
    async readFile(filePath, encoding) {
      reads.push(filePath);
      assert.equal(encoding, "utf8");
      if (!Object.hasOwn(files, filePath)) {
        const error = new Error(`ENOENT: ${filePath}`);
        error.code = "ENOENT";
        throw error;
      }
      const value = files[filePath];
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

function settings(defaultMode) {
  return JSON.stringify({ permissions: { allow: ["Bash(npm test)"], defaultMode } });
}

function detect(files, { cwd = CWD, env = {}, directories = {} } = {}) {
  const fs = fakeFs(files, directories);
  return detectClaudePermissionMode({ cwd, env, homedir: () => HOME, platform: "win32", fs }).then((result) => ({ result, fs }));
}

test("Amendment 6: documented defaultMode values, the manual alias, and unknown values", () => {
  assert.deepEqual([...CLAUDE_SETTINGS_PERMISSION_MODES], ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]);
  for (const mode of CLAUDE_SETTINGS_PERMISSION_MODES) assert.equal(normalizeClaudeSettingsMode(mode), mode);
  assert.equal(normalizeClaudeSettingsMode("manual"), "default");
  for (const value of ["AcceptEdits", "followClaude", "", null, 1, undefined, "toString"]) {
    assert.equal(normalizeClaudeSettingsMode(value), null, String(value));
  }
});

test("Amendment 6: settings files in precedence order (managed, local, project, user; CLAUDE_CONFIG_DIR)", () => {
  assert.equal(MANAGED, "C:\\Program Files\\ClaudeCode\\managed-settings.json");
  assert.deepEqual(claudeSettingsFiles({ cwd: CWD, env: {}, homedir: HOME, platform: "win32" }), [
    { scope: "managed", path: MANAGED },
    { scope: "projectLocal", path: PROJECT_LOCAL },
    { scope: "project", path: PROJECT },
    { scope: "user", path: USER },
  ]);
  const custom = path.join("D:\\", "claude-config");
  assert.deepEqual(
    claudeSettingsFiles({ cwd: null, env: { CLAUDE_CONFIG_DIR: `  ${custom} ` }, homedir: () => HOME, platform: "win32" }),
    [{ scope: "managed", path: MANAGED }, { scope: "user", path: path.join(custom, "settings.json") }],
  );
  assert.equal(managedSettingsDirectory("win32"), "C:\\Program Files\\ClaudeCode");
  assert.equal(managedSettingsPath("darwin"), "/Library/Application Support/ClaudeCode/managed-settings.json");
  assert.equal(managedSettingsPath("linux"), "/etc/claude-code/managed-settings.json");
});

test("Amendment 6: the highest-precedence file that sets a valid mode wins", async () => {
  const all = {
    [MANAGED]: settings("plan"),
    [PROJECT_LOCAL]: settings("dontAsk"),
    [PROJECT]: settings("acceptEdits"),
    [USER]: settings("default"),
  };
  assert.deepEqual((await detect(all)).result, {
    effectiveMode: "plan",
    source: { scope: "managed", path: MANAGED, configuredMode: "plan" },
  });
  const { [MANAGED]: _managed, ...withoutManaged } = all;
  assert.deepEqual((await detect(withoutManaged)).result.source.scope, "projectLocal");
  const { [PROJECT_LOCAL]: _local, ...projectAndUser } = withoutManaged;
  assert.deepEqual((await detect(projectAndUser)).result, {
    effectiveMode: "acceptEdits",
    source: { scope: "project", path: PROJECT, configuredMode: "acceptEdits" },
  });
  const { [PROJECT]: _project, ...userOnly } = projectAndUser;
  assert.deepEqual((await detect(userOnly)).result, {
    effectiveMode: "default",
    source: { scope: "user", path: USER, configuredMode: "default" },
  });
});

test("Amendment 6: no file sets a mode → no source (the board falls back)", async () => {
  const { result, fs } = await detect({
    [PROJECT]: JSON.stringify({ permissions: { allow: ["Read"] } }),
    [USER]: JSON.stringify({ theme: "dark" }),
  });
  assert.deepEqual(result, { effectiveMode: null, source: null });
  assert.deepEqual(fs.reads, [MANAGED, PROJECT_LOCAL, PROJECT, USER]);
  assert.deepEqual((await detect({})).result, { effectiveMode: null, source: null });
});

test("Amendment 6: missing cwd reads only managed and user settings; CLAUDE_CONFIG_DIR is respected", async () => {
  const custom = path.join("D:\\", "claude-config");
  const { result, fs } = await detect({
    [PROJECT]: settings("plan"),
    [USER]: settings("plan"),
    [path.join(custom, "settings.json")]: settings("acceptEdits"),
  }, { cwd: null, env: { CLAUDE_CONFIG_DIR: custom } });
  assert.deepEqual(fs.reads, [MANAGED, path.join(custom, "settings.json")]);
  assert.deepEqual(result, {
    effectiveMode: "acceptEdits",
    source: { scope: "user", path: path.join(custom, "settings.json"), configuredMode: "acceptEdits" },
  });
});

test("Amendment 6: manual alias, BOM, broken JSON, wrong types and unknown values", async () => {
  assert.deepEqual((await detect({ [PROJECT]: settings("manual") })).result, {
    effectiveMode: "default",
    source: { scope: "project", path: PROJECT, configuredMode: "manual" },
  });
  assert.equal((await detect({ [PROJECT]: `\uFEFF${settings("acceptEdits")}` })).result.effectiveMode, "acceptEdits");
  // Unusable entries are skipped and the next file in precedence order decides.
  const skipped = await detect({
    [MANAGED]: "{ not json",
    [PROJECT_LOCAL]: settings("followClaude"),
    [PROJECT]: JSON.stringify({ permissions: { defaultMode: 3 } }),
    [USER]: settings("dontAsk"),
  });
  assert.deepEqual(skipped.result.source, { scope: "user", path: USER, configuredMode: "dontAsk" });
  const unreadable = Object.assign(new Error("EACCES"), { code: "EACCES" });
  assert.equal((await detect({ [PROJECT]: unreadable, [USER]: settings("plan") })).result.effectiveMode, "plan");
  for (const content of ["null", "[]", JSON.stringify({ permissions: null }), JSON.stringify({ permissions: [] })]) {
    assert.deepEqual((await detect({ [PROJECT]: content })).result, { effectiveMode: null, source: null }, content);
  }
});

test("Amendment 6: auto and bypassPermissions do not take effect from project files (docs)", async () => {
  // Project auto → Claude's built-in default, and the user file is NOT consulted.
  for (const file of [PROJECT_LOCAL, PROJECT]) {
    const { result, fs } = await detect({ [file]: settings("auto"), [USER]: settings("acceptEdits") });
    assert.equal(result.effectiveMode, null);
    assert.equal(result.source.path, file);
    assert.equal(result.source.configuredMode, "auto");
    assert.equal(fs.reads.includes(USER), false);
  }
  // Project bypassPermissions → the session starts in Manual (`default`).
  for (const file of [PROJECT_LOCAL, PROJECT]) {
    const { result } = await detect({ [file]: settings("bypassPermissions"), [USER]: settings("acceptEdits") });
    assert.deepEqual([result.effectiveMode, result.source.path, result.source.configuredMode], ["default", file, "bypassPermissions"]);
  }
  // From user or managed settings both apply as written.
  for (const mode of ["auto", "bypassPermissions"]) {
    assert.equal((await detect({ [USER]: settings(mode) })).result.effectiveMode, mode);
    assert.equal((await detect({ [MANAGED]: settings(mode) })).result.effectiveMode, mode);
  }
});

test("Amendment 6: managed-settings.d drop-ins merge after managed-settings.json in alphabetical order", async () => {
  const dropIns = path.win32.join(managedSettingsDirectory("win32"), "managed-settings.d");
  const at = (name) => path.win32.join(dropIns, name);
  const directories = { [dropIns]: ["20-b.json", ".hidden.json", "10-a.json", "notes.txt", "30-c.json"] };
  const { result, fs } = await detect({
    [MANAGED]: settings("plan"),
    [at("10-a.json")]: settings("dontAsk"),
    [at("20-b.json")]: settings("acceptEdits"),
    [at("30-c.json")]: JSON.stringify({ model: "opus" }),
    [at(".hidden.json")]: settings("bypassPermissions"),
    [PROJECT]: settings("default"),
  }, { directories });
  assert.deepEqual(result, {
    effectiveMode: "acceptEdits",
    source: { scope: "managed", path: at("20-b.json"), configuredMode: "acceptEdits" },
  });
  assert.deepEqual(fs.reads.slice(0, 4), [MANAGED, at("10-a.json"), at("20-b.json"), at("30-c.json")]);
  assert.equal(fs.reads.includes(PROJECT), false, "a managed value decides before project files");
  // A drop-in alone (no managed-settings.json) still counts; a missing directory is ignored.
  assert.equal((await detect({ [at("10-a.json")]: settings("auto") }, { directories })).result.effectiveMode, "auto");
  assert.equal((await detect({ [PROJECT]: settings("plan") })).result.source.scope, "project");
});
