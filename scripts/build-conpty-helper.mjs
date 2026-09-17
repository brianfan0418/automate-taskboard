#!/usr/bin/env node
// Compiles tools/conpty/ConPtyAttachSend.cs (T3) into src-tauri/resources/bin/ConPtyAttachSend.exe
// using the .NET Framework csc.exe that ships with Windows.
//
// CLI usage:
//   node scripts/build-conpty-helper.mjs [--source <dir>] [--out <dir>] [--csc <path>]
// --source / --out point at directories (not files): the source directory must contain
// ConPtyAttachSend.cs, the out directory receives ConPtyAttachSend.exe. This lets a manual
// check compile a copy of ConPtyAttachSend.cs from a scratch directory without
// touching the real tools/conpty or src-tauri/resources/bin locations.
//
// On non-Windows this is a no-op (exit 0): the helper only ever runs inside the Windows
// Tauri build. On Windows, a missing csc.exe or missing source file is a hard failure.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SOURCE_FILE_NAME = "ConPtyAttachSend.cs";
export const OUT_FILE_NAME = "ConPtyAttachSend.exe";
export const DEFAULT_SOURCE_DIR = path.join(projectRoot, "tools", "conpty");
export const DEFAULT_OUT_DIR = path.join(projectRoot, "src-tauri", "resources", "bin");
export const DEFAULT_CSC_PATH = path.join(
  process.env.WINDIR || String.raw`C:\Windows`,
  "Microsoft.NET",
  "Framework64",
  "v4.0.30319",
  "csc.exe",
);

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source") {
      options.sourceDir = argv[(i += 1)];
    } else if (arg === "--out") {
      options.outDir = argv[(i += 1)];
    } else if (arg === "--csc") {
      options.cscPath = argv[(i += 1)];
    } else {
      throw new Error(`build-conpty-helper: unknown argument "${arg}"`);
    }
  }
  return options;
}

export function resolvePaths({ sourceDir, outDir, cscPath } = {}) {
  const resolvedSourceDir = sourceDir ?? DEFAULT_SOURCE_DIR;
  const resolvedOutDir = outDir ?? DEFAULT_OUT_DIR;
  return {
    sourceDir: resolvedSourceDir,
    outDir: resolvedOutDir,
    sourcePath: path.join(resolvedSourceDir, SOURCE_FILE_NAME),
    outPath: path.join(resolvedOutDir, OUT_FILE_NAME),
    cscPath: cscPath ?? DEFAULT_CSC_PATH,
  };
}

// Equivalent manual compile line:
//   csc.exe /nologo /optimize+ /out:<tmp>\ConPtyAttachSend.exe tools\conpty\ConPtyAttachSend.cs
export function buildCscArgs({ sourcePath, outPath }) {
  return ["/nologo", "/optimize+", `/out:${outPath}`, sourcePath];
}

/**
 * @param {{sourceDir?: string, outDir?: string, cscPath?: string}} options
 * @param {{platform?: string, exists?: (p: string) => boolean, mkdir?: (p: string, opts?: object) => void,
 *   exec?: (command: string, args: string[], opts: object) => object, log?: (msg: string) => void}} deps
 * @returns {{status: "skipped"|"error"|"ok", code: number, message?: string, outPath?: string}}
 */
export function buildConptyHelper(options = {}, deps = {}) {
  const {
    platform = process.platform,
    exists = existsSync,
    mkdir = mkdirSync,
    exec = spawnSync,
    log = console.log,
  } = deps;

  if (platform !== "win32") {
    const message = "build-conpty-helper: skipping ConPtyAttachSend.exe build (not Windows).";
    log(message);
    return { status: "skipped", code: 0, message };
  }

  const { sourcePath, outDir, outPath, cscPath } = resolvePaths(options);

  if (!exists(cscPath)) {
    const message =
      `build-conpty-helper: csc.exe not found at "${cscPath}". ` +
      "Install the .NET Framework 4.x developer pack, or pass --csc <path to csc.exe>.";
    log(message);
    return { status: "error", code: 1, message };
  }

  if (!exists(sourcePath)) {
    const message =
      `build-conpty-helper: source file not found at "${sourcePath}". ` +
      "Expected tools/conpty/ConPtyAttachSend.cs (T3); pass --source <dir> to override.";
    log(message);
    return { status: "error", code: 1, message };
  }

  mkdir(outDir, { recursive: true });

  const args = buildCscArgs({ sourcePath, outPath });
  const result = exec(cscPath, args, { encoding: "utf8", windowsHide: true });

  if (result.error) {
    const message = `build-conpty-helper: failed to launch csc.exe: ${result.error.message}`;
    log(message);
    return { status: "error", code: 1, message };
  }

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const message = `build-conpty-helper: csc.exe exited with code ${result.status}.\n${output}`;
    log(message);
    return { status: "error", code: result.status ?? 1, message };
  }

  const message = `build-conpty-helper: compiled "${outPath}".`;
  log(message);
  return { status: "ok", code: 0, message, outPath };
}

function isCliEntryPoint() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(invoked);
  } catch {
    return false;
  }
}

if (isCliEntryPoint()) {
  const options = parseArgs(process.argv.slice(2));
  const result = buildConptyHelper(options);
  process.exit(result.code);
}
