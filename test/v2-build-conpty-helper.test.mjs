import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";

import {
  DEFAULT_CSC_PATH,
  DEFAULT_OUT_DIR,
  DEFAULT_SOURCE_DIR,
  buildCscArgs,
  buildConptyHelper,
  parseArgs,
  resolvePaths,
} from "../scripts/build-conpty-helper.mjs";

test("parseArgs reads --source, --out and --csc overrides", () => {
  assert.deepEqual(parseArgs([]), {});
  assert.deepEqual(
    parseArgs(["--source", "C:\\tmp\\src", "--out", "C:\\tmp\\out", "--csc", "C:\\tmp\\csc.exe"]),
    { sourceDir: "C:\\tmp\\src", outDir: "C:\\tmp\\out", cscPath: "C:\\tmp\\csc.exe" },
  );
});

test("parseArgs rejects unknown flags", () => {
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
});

test("resolvePaths defaults to tools/conpty and src-tauri/resources/bin", () => {
  const paths = resolvePaths();
  assert.equal(paths.sourceDir, DEFAULT_SOURCE_DIR);
  assert.equal(paths.outDir, DEFAULT_OUT_DIR);
  assert.equal(paths.cscPath, DEFAULT_CSC_PATH);
  assert.equal(paths.sourcePath, path.join(DEFAULT_SOURCE_DIR, "ConPtyAttachSend.cs"));
  assert.equal(paths.outPath, path.join(DEFAULT_OUT_DIR, "ConPtyAttachSend.exe"));
});

test("resolvePaths joins overridden directories with the fixed file names", () => {
  const paths = resolvePaths({ sourceDir: "C:\\tmp\\src", outDir: "C:\\tmp\\out" });
  assert.equal(paths.sourcePath, path.join("C:\\tmp\\src", "ConPtyAttachSend.cs"));
  assert.equal(paths.outPath, path.join("C:\\tmp\\out", "ConPtyAttachSend.exe"));
});

test("buildCscArgs mirrors the documented manual compile line", () => {
  const args = buildCscArgs({
    sourcePath: "tools\\conpty\\ConPtyAttachSend.cs",
    outPath: "C:\\tmp\\ConPtyAttachSend.exe",
  });
  assert.deepEqual(args, [
    "/nologo",
    "/optimize+",
    "/out:C:\\tmp\\ConPtyAttachSend.exe",
    "tools\\conpty\\ConPtyAttachSend.cs",
  ]);
});

test("buildConptyHelper skips with exit 0 on non-Windows without touching the filesystem or exec", () => {
  const calls = { exists: [], mkdir: [], exec: [] };
  const result = buildConptyHelper(
    {},
    {
      platform: "linux",
      exists: (p) => {
        calls.exists.push(p);
        return true;
      },
      mkdir: (p) => calls.mkdir.push(p),
      exec: (...args) => {
        calls.exec.push(args);
        return { status: 0 };
      },
      log: () => {},
    },
  );
  assert.equal(result.status, "skipped");
  assert.equal(result.code, 0);
  assert.deepEqual(calls.exists, []);
  assert.deepEqual(calls.mkdir, []);
  assert.deepEqual(calls.exec, []);
});

test("buildConptyHelper fails clearly when csc.exe is missing, without compiling", () => {
  const logs = [];
  const calls = { exec: [] };
  const result = buildConptyHelper(
    {},
    {
      platform: "win32",
      exists: () => false,
      mkdir: () => {},
      exec: (...args) => {
        calls.exec.push(args);
        return { status: 0 };
      },
      log: (message) => logs.push(message),
    },
  );
  assert.equal(result.status, "error");
  assert.equal(result.code, 1);
  assert.match(result.message, /csc\.exe not found/);
  assert.deepEqual(calls.exec, []);
  assert.ok(logs.some((line) => /csc\.exe not found/.test(line)));
});

test("buildConptyHelper fails clearly when the source .cs file is missing, without compiling", () => {
  const calls = { exec: [] };
  const result = buildConptyHelper(
    {},
    {
      platform: "win32",
      exists: (p) => !p.endsWith("ConPtyAttachSend.cs"),
      mkdir: () => {},
      exec: (...args) => {
        calls.exec.push(args);
        return { status: 0 };
      },
      log: () => {},
    },
  );
  assert.equal(result.status, "error");
  assert.equal(result.code, 1);
  assert.match(result.message, /source file not found/);
  assert.deepEqual(calls.exec, []);
});

test("buildConptyHelper invokes csc.exe with the resolved paths and creates the out dir first", () => {
  const calls = { mkdir: [], exec: [] };
  const result = buildConptyHelper(
    { sourceDir: "C:\\src", outDir: "C:\\out", cscPath: "C:\\csc.exe" },
    {
      platform: "win32",
      exists: () => true,
      mkdir: (p, opts) => calls.mkdir.push({ p, opts }),
      exec: (command, args, opts) => {
        calls.exec.push({ command, args, opts });
        return { status: 0, stdout: "", stderr: "" };
      },
      log: () => {},
    },
  );
  assert.equal(result.status, "ok");
  assert.equal(result.code, 0);
  assert.equal(result.outPath, path.join("C:\\out", "ConPtyAttachSend.exe"));
  assert.deepEqual(calls.mkdir, [{ p: "C:\\out", opts: { recursive: true } }]);
  assert.equal(calls.exec.length, 1);
  assert.equal(calls.exec[0].command, "C:\\csc.exe");
  assert.deepEqual(calls.exec[0].args, [
    "/nologo",
    "/optimize+",
    `/out:${path.join("C:\\out", "ConPtyAttachSend.exe")}`,
    path.join("C:\\src", "ConPtyAttachSend.cs"),
  ]);
});

test("buildConptyHelper surfaces a non-zero csc.exe exit code as an error with combined output", () => {
  const result = buildConptyHelper(
    { sourceDir: "C:\\src", outDir: "C:\\out", cscPath: "C:\\csc.exe" },
    {
      platform: "win32",
      exists: () => true,
      mkdir: () => {},
      exec: () => ({ status: 1, stdout: "", stderr: "CS0006: source file not found" }),
      log: () => {},
    },
  );
  assert.equal(result.status, "error");
  assert.equal(result.code, 1);
  assert.match(result.message, /csc\.exe exited with code 1/);
  assert.match(result.message, /CS0006/);
});

test("buildConptyHelper surfaces a spawn failure (e.g. EPERM) as an error", () => {
  const result = buildConptyHelper(
    { sourceDir: "C:\\src", outDir: "C:\\out", cscPath: "C:\\csc.exe" },
    {
      platform: "win32",
      exists: () => true,
      mkdir: () => {},
      exec: () => ({ error: new Error("spawn EPERM") }),
      log: () => {},
    },
  );
  assert.equal(result.status, "error");
  assert.equal(result.code, 1);
  assert.match(result.message, /failed to launch csc\.exe/);
  assert.match(result.message, /EPERM/);
});
