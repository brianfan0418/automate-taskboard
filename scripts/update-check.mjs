#!/usr/bin/env node
// Amendment 11: shared-folder update checker run by the Windows launcher with the bundled Node.
//   node update-check.mjs check   --current 2.0.0 --build-config <res>\update-source.json --override-config <data>\update-source.json
//   node update-check.mjs prepare --current 2.0.0 --expect-version 2.0.1 [...same config options] [--temp-dir DIR]
// Prints exactly one JSON object on stdout. Failures are reported as { status: "error", code, message }
// with a Traditional Chinese message; nothing outside the temp directory is written or deleted.
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { UPDATE_PUBLIC_KEY_PEM } from "../shared/update-public-key.mjs";
import {
  UPDATE_MANIFEST_NAME,
  UpdateError,
  evaluateManifest,
  joinUpdateSource,
  resolveUpdateSource,
  truncateUpdateNotes,
  verifyInstallerFile,
} from "../shared/update-manifest.mjs";

/** Copies at most `limit` bytes; aborts with SIZE_MISMATCH as soon as the source grows past it. */
async function copyWithSizeLimit(sourcePath, targetPath, limit) {
  let copied = 0;
  const guard = new Transform({
    transform(chunk, _encoding, callback) {
      copied += chunk.length;
      if (copied > limit) {
        callback(new UpdateError("SIZE_MISMATCH", `安裝檔大小不符（預期 ${limit}，實際超過）。`));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(createReadStream(sourcePath), guard, createWriteStream(targetPath));
}

/** Keeps only the current installer name in the update temp directory (older downloads and partials go). */
async function removeStaleDownloads(tempDirectory, keepName) {
  let entries;
  try {
    entries = await readdir(tempDirectory, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name !== keepName)
    .map((entry) => unlink(path.join(tempDirectory, entry.name)).catch(() => {})));
}

function parseOptions(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  const names = new Map([
    ["--current", "currentVersion"],
    ["--build-config", "buildConfigPath"],
    ["--override-config", "overrideConfigPath"],
    ["--temp-dir", "tempDirectory"],
    ["--expect-version", "expectVersion"],
  ]);
  for (let index = 0; index < rest.length; index += 1) {
    const key = names.get(rest[index]);
    if (!key || rest[index + 1] === undefined) throw new UpdateError("USAGE", `未知的參數：${rest[index]}`);
    options[key] = rest[++index];
  }
  if (command !== "check" && command !== "prepare") throw new UpdateError("USAGE", "指令必須是 check 或 prepare。");
  if (!options.currentVersion) throw new UpdateError("USAGE", "缺少 --current。");
  return options;
}

async function readManifest(source) {
  const manifestPath = joinUpdateSource(source, UPDATE_MANIFEST_NAME);
  let text;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new UpdateError("MANIFEST_MISSING", `更新資料夾中找不到 ${UPDATE_MANIFEST_NAME}：${source}`);
    }
    throw new UpdateError("SOURCE_UNREACHABLE", `無法讀取更新資料夾（請確認能連到更新資料夾所在的網路）：${source}`);
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new UpdateError("INVALID_MANIFEST", "更新資訊格式錯誤。");
  }
}

export async function runUpdateCommand(options, { publicKeyPem = UPDATE_PUBLIC_KEY_PEM } = {}) {
  const { source } = await resolveUpdateSource(options);
  if (!source) return { status: "disabled" };
  const manifest = evaluateManifest(await readManifest(source), {
    publicKeyPem,
    currentVersion: options.currentVersion,
  });
  const summary = {
    version: manifest.version,
    currentVersion: options.currentVersion,
    notes: truncateUpdateNotes(manifest.notes),
    installer: manifest.installer,
    size: manifest.size,
  };
  if (options.command === "check") {
    return { status: manifest.newer ? "available" : "none", ...summary };
  }
  if (!manifest.newer) {
    throw new UpdateError("NOT_NEWER", `更新資料夾中的版本 ${manifest.version} 不比目前版本 ${options.currentVersion} 新。`);
  }
  if (options.expectVersion && options.expectVersion !== manifest.version) {
    throw new UpdateError("VERSION_CHANGED", "更新資料夾中的版本已變更，請重新檢查更新。");
  }
  const tempDirectory = options.tempDirectory ?? path.join(os.tmpdir(), "AutoMateTaskboard-update");
  await mkdir(tempDirectory, { recursive: true });
  await removeStaleDownloads(tempDirectory, manifest.installer);
  const installerPath = path.join(tempDirectory, manifest.installer);
  const partialPath = `${installerPath}.partial-${process.pid}`;
  const sharedInstallerPath = joinUpdateSource(source, manifest.installer);
  let sharedInstaller;
  try {
    sharedInstaller = await stat(sharedInstallerPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new UpdateError("INSTALLER_MISSING", `更新資料夾中找不到安裝檔：${manifest.installer}`);
    }
    throw new UpdateError("COPY_FAILED", `無法讀取更新資料夾中的安裝檔：${error?.message ?? error}`);
  }
  if (!sharedInstaller.isFile() || sharedInstaller.size !== manifest.size) {
    throw new UpdateError("SIZE_MISMATCH", `安裝檔大小不符（預期 ${manifest.size}，實際 ${sharedInstaller.size}）。`);
  }
  try {
    try {
      await copyWithSizeLimit(sharedInstallerPath, partialPath, manifest.size);
    } catch (error) {
      if (error instanceof UpdateError) throw error;
      if (error?.code === "ENOENT") {
        throw new UpdateError("INSTALLER_MISSING", `更新資料夾中找不到安裝檔：${manifest.installer}`);
      }
      throw new UpdateError("COPY_FAILED", `無法複製安裝檔到暫存資料夾：${error?.message ?? error}`);
    }
    await verifyInstallerFile(partialPath, manifest);
    await rename(partialPath, installerPath);
  } catch (error) {
    await unlink(partialPath).catch(() => {});
    throw error;
  }
  // Re-verify the final file so a concurrent writer cannot swap it after the rename.
  await verifyInstallerFile(installerPath, manifest);
  return { status: "ready", ...summary, installerPath };
}

async function main(argv) {
  let result;
  try {
    result = await runUpdateCommand(parseOptions(argv));
  } catch (error) {
    result = error instanceof UpdateError
      ? { status: "error", code: error.code, message: error.message }
      : { status: "error", code: "UNEXPECTED", message: `更新檢查發生錯誤：${error?.message ?? error}` };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
