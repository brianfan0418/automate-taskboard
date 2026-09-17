// AutoMate Taskboard keeps reading the inherited CODEX_TASKBOARD_* variables (launcher, tests,
// scripts, and existing setups depend on them). AUTOMATE_TASKBOARD_* is an optional alias that
// fills a CODEX_TASKBOARD_* value only when that value is not already set, so values injected by
// the desktop launcher always win.
export const AUTOMATE_TASKBOARD_ENV_PREFIX = "AUTOMATE_TASKBOARD_";
export const CODEX_TASKBOARD_ENV_PREFIX = "CODEX_TASKBOARD_";

export function applyAutomateTaskboardEnvAliases(environment = process.env) {
  for (const [name, value] of Object.entries(environment)) {
    if (!name.startsWith(AUTOMATE_TASKBOARD_ENV_PREFIX) || value === undefined) continue;
    const legacyName = CODEX_TASKBOARD_ENV_PREFIX + name.slice(AUTOMATE_TASKBOARD_ENV_PREFIX.length);
    if (environment[legacyName] === undefined) environment[legacyName] = value;
  }
  return environment;
}
