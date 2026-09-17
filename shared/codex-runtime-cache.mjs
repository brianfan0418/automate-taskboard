import { copyFile, mkdir, readdir, rename, stat, unlink, utimes } from "node:fs/promises";
import path from "node:path";

// Helpers Codex looks for next to its own executable (Codex App >= 26.9 ships these in
// app\resources and moves them together into %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\).
export const CODEX_REQUIRED_HELPERS = Object.freeze([
  "codex-code-mode-host.exe",
  "codex-command-runner.exe",
  "codex-windows-sandbox-setup.exe",
]);

const CODEX_EXECUTABLE_NAME = "codex.exe";

/** Files that belong to the Codex runtime inside a Codex App resources directory. */
export function isCodexRuntimeFile(name) {
  const lower = name.toLowerCase();
  if (lower === CODEX_EXECUTABLE_NAME) return true;
  if (/^codex-[a-z0-9._-]+\.exe$/.test(lower)) return true;
  if (lower === "rg.exe") return true;
  return lower.endsWith(".dll");
}

async function fileStat(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile() ? info : null;
  } catch {
    return null;
  }
}

/** Runtime files present in the source directory, codex.exe first. */
export async function listCodexRuntimeFiles(sourceDirectory) {
  let names;
  try {
    names = (await readdir(sourceDirectory)).filter(isCodexRuntimeFile);
  } catch {
    // Some packaged installs allow opening files but not listing the folder: probe known names.
    names = [CODEX_EXECUTABLE_NAME, ...CODEX_REQUIRED_HELPERS, "rg.exe"];
  }
  const files = [];
  for (const name of names) {
    const info = await fileStat(path.join(sourceDirectory, name));
    if (info) files.push({ name, size: info.size, mtimeMs: info.mtimeMs, atime: info.atime, mtime: info.mtime });
  }
  files.sort((left, right) => {
    const leftMain = left.name.toLowerCase() === CODEX_EXECUTABLE_NAME;
    const rightMain = right.name.toLowerCase() === CODEX_EXECUTABLE_NAME;
    if (leftMain !== rightMain) return leftMain ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  return files;
}

function sameFile(info, source) {
  return Boolean(info) && info.size === source.size && Math.trunc(info.mtimeMs) === Math.trunc(source.mtimeMs);
}

async function copyRuntimeFile(sourceDirectory, cacheDirectory, file) {
  const target = path.join(cacheDirectory, file.name);
  if (sameFile(await fileStat(target), file)) return false;
  const temporary = `${target}.partial-${process.pid}-${Date.now()}`;
  try {
    await copyFile(path.join(sourceDirectory, file.name), temporary);
    await utimes(temporary, file.atime, file.mtime);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return true;
}

/**
 * A Codex App managed bin directory (%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\) whose codex.exe and
 * helpers match the source files exactly, or null.
 */
export async function findMatchingCodexAppBin(binRoot, sourceFiles) {
  if (!binRoot) return null;
  let entries;
  try {
    entries = await readdir(binRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const required = sourceFiles.filter((file) => (
    file.name.toLowerCase() === CODEX_EXECUTABLE_NAME
    || CODEX_REQUIRED_HELPERS.includes(file.name.toLowerCase())
  ));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(binRoot, entry.name);
    let complete = required.length > 0;
    for (const file of required) {
      const info = await fileStat(path.join(directory, file.name));
      if (!info || info.size !== file.size) {
        complete = false;
        break;
      }
    }
    if (complete) return path.join(directory, CODEX_EXECUTABLE_NAME);
  }
  return null;
}

/**
 * Makes a runnable copy of a packaged codex.exe together with every helper executable Codex spawns
 * from its own directory. Each file is refreshed on its own size/mtime, so a missing or outdated
 * helper is copied even when codex.exe itself is current. When copying fails (for example a cached
 * file is locked by a running app-server), a complete Codex App bin directory is used instead.
 */
export async function prepareCodexRuntime({ executable, cacheDirectory, codexAppBinRoot = null }) {
  const sourceDirectory = path.dirname(executable);
  const sourceFiles = await listCodexRuntimeFiles(sourceDirectory);
  if (!sourceFiles.some((file) => file.name.toLowerCase() === CODEX_EXECUTABLE_NAME)) {
    throw new Error(`Codex executable not found: ${executable}`);
  }
  const copied = [];
  try {
    await mkdir(cacheDirectory, { recursive: true });
    for (const file of sourceFiles) {
      if (await copyRuntimeFile(sourceDirectory, cacheDirectory, file)) copied.push(file.name);
    }
  } catch (error) {
    const fallback = await findMatchingCodexAppBin(codexAppBinRoot, sourceFiles);
    if (fallback) return { executable: fallback, copied, source: "codex-app-bin" };
    throw error;
  }
  return {
    executable: path.join(cacheDirectory, CODEX_EXECUTABLE_NAME),
    copied,
    source: "cache",
  };
}

export function defaultCodexAppBinRoot(env = process.env) {
  return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin") : null;
}
