import { windowsCodexProfileArgument } from "./windows-codex.mjs";

// Coexistence with Dashi "Codex Taskboard": every desktop taskboard launcher starts its own
// Codex with a private `--user-data-dir` (AutoMate: `<data dir>/codex-profile`). A Codex process
// that names a different profile belongs to another launcher, so this launcher must not reuse,
// inject into, or stop it.

export function codexCommandHasProfile(command) {
  return /(?:^|[\s"])--user-data-dir(?:=|\s)/i.test(String(command ?? ""));
}

export function codexCommandUsesProfile(command, profilePath, platform = process.platform) {
  const text = String(command ?? "");
  if (!profilePath) return false;
  return platform === "win32"
    ? windowsCodexProfileArgument(text, profilePath)
    : `${text} `.includes(` --user-data-dir=${profilePath} `);
}

export function isForeignProfileCodex(command, ownProfilePath, platform = process.platform) {
  if (!ownProfilePath || !codexCommandHasProfile(command)) return false;
  return !codexCommandUsesProfile(command, ownProfilePath, platform);
}
