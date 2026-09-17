import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODEX_REQUIRED_HELPERS,
  findMatchingCodexAppBin,
  isCodexRuntimeFile,
  prepareCodexRuntime,
} from "../shared/codex-runtime-cache.mjs";

async function fakeCodexResources(root, extra = {}) {
  const resources = path.join(root, "WindowsApps", "OpenAI.Codex_1.0_x64", "app", "resources");
  await mkdir(resources, { recursive: true });
  const files = {
    "codex.exe": "codex-main",
    "codex-code-mode-host.exe": "host",
    "codex-command-runner.exe": "runner",
    "codex-windows-sandbox-setup.exe": "sandbox",
    "rg.exe": "rg",
    "app.asar": "not-runtime",
    "chatgpt-app-dark.ico": "icon",
    ...extra,
  };
  const fixed = new Date("2026-09-15T13:31:29Z");
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(resources, name), content);
    await utimes(path.join(resources, name), fixed, fixed);
  }
  return resources;
}

test("runtime file filter keeps codex helpers, rg and DLLs only", () => {
  assert.equal(isCodexRuntimeFile("codex.exe"), true);
  assert.equal(isCodexRuntimeFile("Codex-Code-Mode-Host.exe"), true);
  assert.equal(isCodexRuntimeFile("codex-future-helper.exe"), true);
  assert.equal(isCodexRuntimeFile("rg.exe"), true);
  assert.equal(isCodexRuntimeFile("vcruntime140.dll"), true);
  assert.equal(isCodexRuntimeFile("app.asar"), false);
  assert.equal(isCodexRuntimeFile("codex"), false);
  assert.equal(isCodexRuntimeFile("chatgpt-app-dark.ico"), false);
});

test("prepareCodexRuntime copies codex.exe together with every sibling helper", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-runtime-"));
  try {
    const resources = await fakeCodexResources(root, { "helper.dll": "dll" });
    const cache = path.join(root, "AutoMate Taskboard", "codex-runtime");
    const result = await prepareCodexRuntime({
      executable: path.join(resources, "codex.exe"),
      cacheDirectory: cache,
    });
    assert.equal(result.executable, path.join(cache, "codex.exe"));
    assert.equal(result.source, "cache");
    const cached = (await readdir(cache)).sort();
    assert.deepEqual(cached, [
      "codex-code-mode-host.exe",
      "codex-command-runner.exe",
      "codex-windows-sandbox-setup.exe",
      "codex.exe",
      "helper.dll",
      "rg.exe",
    ]);
    for (const helper of CODEX_REQUIRED_HELPERS) assert.ok(cached.includes(helper));
    const sourceTime = (await stat(path.join(resources, "codex-code-mode-host.exe"))).mtimeMs;
    assert.equal(Math.trunc((await stat(path.join(cache, "codex-code-mode-host.exe"))).mtimeMs), Math.trunc(sourceTime));

    const second = await prepareCodexRuntime({
      executable: path.join(resources, "codex.exe"),
      cacheDirectory: cache,
    });
    assert.deepEqual(second.copied, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an old cache holding only codex.exe gets the missing helpers without recopying codex.exe", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-runtime-"));
  try {
    const resources = await fakeCodexResources(root);
    const cache = path.join(root, "codex-runtime");
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, "codex.exe"), "codex-main");
    const sourceInfo = await stat(path.join(resources, "codex.exe"));
    await utimes(path.join(cache, "codex.exe"), sourceInfo.atime, sourceInfo.mtime);

    const result = await prepareCodexRuntime({
      executable: path.join(resources, "codex.exe"),
      cacheDirectory: cache,
    });
    assert.deepEqual(result.copied.sort(), [
      "codex-code-mode-host.exe",
      "codex-command-runner.exe",
      "codex-windows-sandbox-setup.exe",
      "rg.exe",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a changed helper is refreshed on its own size and mtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-runtime-"));
  try {
    const resources = await fakeCodexResources(root);
    const cache = path.join(root, "codex-runtime");
    const executable = path.join(resources, "codex.exe");
    await prepareCodexRuntime({ executable, cacheDirectory: cache });
    await writeFile(path.join(resources, "codex-command-runner.exe"), "runner-v2");
    const result = await prepareCodexRuntime({ executable, cacheDirectory: cache });
    assert.deepEqual(result.copied, ["codex-command-runner.exe"]);
    assert.equal(await readFile(path.join(cache, "codex-command-runner.exe"), "utf8"), "runner-v2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("copy failure falls back to a complete matching Codex App bin directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-runtime-"));
  try {
    const resources = await fakeCodexResources(root);
    const binRoot = path.join(root, "Local", "OpenAI", "Codex", "bin");
    const incomplete = path.join(binRoot, "aaaa");
    const complete = path.join(binRoot, "bbbb");
    await mkdir(incomplete, { recursive: true });
    await mkdir(complete, { recursive: true });
    await writeFile(path.join(incomplete, "codex.exe"), "codex-main");
    for (const name of ["codex.exe", ...CODEX_REQUIRED_HELPERS]) {
      await writeFile(path.join(complete, name), await readFile(path.join(resources, name)));
    }
    // A file where the cache directory should be makes mkdir fail.
    const blocked = path.join(root, "blocked");
    await writeFile(blocked, "x");
    const result = await prepareCodexRuntime({
      executable: path.join(resources, "codex.exe"),
      cacheDirectory: path.join(blocked, "codex-runtime"),
      codexAppBinRoot: binRoot,
    });
    assert.equal(result.source, "codex-app-bin");
    assert.equal(result.executable, path.join(complete, "codex.exe"));

    await rm(complete, { recursive: true, force: true });
    await assert.rejects(prepareCodexRuntime({
      executable: path.join(resources, "codex.exe"),
      cacheDirectory: path.join(blocked, "codex-runtime"),
      codexAppBinRoot: binRoot,
    }));
    assert.equal(await findMatchingCodexAppBin(path.join(root, "missing"), []), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
