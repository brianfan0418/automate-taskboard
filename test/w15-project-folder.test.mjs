// W15 follow-up: project folder — native picker endpoint, validation, setting a folder later, and
// runs for a manually created project use that folder as cwd (Claude and Codex).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import {
  FOLDER_PICKER_SCRIPT,
  assertProjectFolder,
  createFolderPicker,
  parseFolderPickerOutput,
} from "../server/folder-picker.mjs";

const quietLogger = { info() {}, warn() {}, error() {} };

function fakeProvider(name) {
  const provider = {
    name,
    calls: [],
    async available() { return { ok: true, version: `${name}-test` }; },
    async start(input) {
      provider.calls.push({ method: "start", input });
      return name === "codex"
        ? { codexThreadId: `thread-${input.runId}`, codexTurnId: "turn-1" }
        : { claudeShortId: "short-1", claudeSessionId: "session-1", claudeBridgeSessionId: "bridge-1" };
    },
    async sendFollowup() { return { delivered: true, detail: "delivered" }; },
    async stop() { return { stopped: true, detail: "stopped" }; },
    async close() {},
    openUrl() { return null; },
    async recover() { return { status: "interrupted" }; },
    async dispose() {},
  };
  return provider;
}

async function startBoard(t, options = {}) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "taskboard-w15-folder-"));
  const providers = { claude: fakeProvider("claude"), codex: fakeProvider("codex") };
  const app = createTaskboardServer({
    dataDirectory,
    runProviders: providers,
    enableScheduler: false,
    runLogger: quietLogger,
    claudePermissionDetector: async () => ({ effectiveMode: null, source: null }),
    ...options,
  });
  const address = await app.listen({ port: 0 });
  await app.whenStarted();
  t.after(async () => {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { app, providers, baseUrl: `http://127.0.0.1:${address.port}`, port: address.port, dataDirectory };
}

async function api(baseUrl, pathname, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function tempFolder(t, prefix) {
  const folder = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

test("a manually created project with a picked folder runs Claude and Codex in that folder", async (t) => {
  const { app, baseUrl, providers } = await startBoard(t);
  const folder = await tempFolder(t, "報價 單-");
  const created = await api(baseUrl, "/api/projects", {
    method: "POST",
    body: { id: "temp-quotes", name: "報價單", workspacePath: `${folder}${path.sep}` },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.project.workspacePath, folder, "trailing separator is dropped");
  const listed = await api(baseUrl, "/api/projects");
  assert.equal(listed.body.projects.find((project) => project.id === "temp-quotes").workspacePath, folder);

  for (const [assigneeTarget, providerName] of [["claude-agent", "claude"], ["codex-agent", "codex"]]) {
    const task = await api(baseUrl, "/api/tasks", {
      method: "POST",
      body: { projectId: "temp-quotes", title: `整理 ${providerName}`, status: "todo", assigneeTarget },
    });
    assert.equal(task.status, 201, JSON.stringify(task.body));
    const started = await api(baseUrl, `/api/tasks/${task.body.task.id}/run/start`, { method: "POST", body: {} });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await app.runService.settle();
    const call = providers[providerName].calls.find((entry) => entry.method === "start");
    assert.equal(call.input.cwd, folder, `${providerName} cwd`);
  }
});

test("creating a project refuses a missing or relative folder", async (t) => {
  const { baseUrl } = await startBoard(t);
  const missing = path.join(os.tmpdir(), `w15-missing-${Date.now()}`);
  const refused = await api(baseUrl, "/api/projects", { method: "POST", body: { id: "temp-a", name: "A", workspacePath: missing } });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, "WORKSPACE_FOLDER_MISSING");
  assert.equal(refused.body.error.message, `找不到這個資料夾：${missing}`);
  const relative = await api(baseUrl, "/api/projects", { method: "POST", body: { id: "temp-b", name: "B", workspacePath: "docs" } });
  assert.equal(relative.status, 400);
  assert.equal(relative.body.error.code, "WORKSPACE_NOT_ABSOLUTE");
  const projects = await api(baseUrl, "/api/projects");
  assert.equal(projects.body.projects.some((project) => project.id === "temp-a" || project.id === "temp-b"), false);
  // Without a folder the project is still created (taskctl / API compatibility); runs then ask for a folder.
  const noFolder = await api(baseUrl, "/api/projects", { method: "POST", body: { id: "temp-c", name: "C", workspacePath: null } });
  assert.equal(noFolder.status, 201);
});

test("a project without a folder: run/start says so with the project id, PATCH sets the folder, the next run uses it", async (t) => {
  const { app, baseUrl, providers } = await startBoard(t);
  await api(baseUrl, "/api/projects", { method: "POST", body: { id: "temp-old", name: "舊專案", workspacePath: null } });
  const task = await api(baseUrl, "/api/tasks", {
    method: "POST",
    body: { projectId: "temp-old", title: "整理", status: "todo", assigneeTarget: "claude-agent" },
  });
  const refused = await api(baseUrl, `/api/tasks/${task.body.task.id}/run/start`, { method: "POST", body: {} });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "WORKSPACE_NOT_FOUND");
  assert.equal(refused.body.error.message, "專案沒有設定資料夾，AI 無法開工");
  assert.deepEqual(refused.body.error.details, { projectId: "temp-old", workspacePath: null });

  const missing = await api(baseUrl, "/api/projects/temp-old", {
    method: "PATCH",
    body: { workspacePath: path.join(os.tmpdir(), `w15-nope-${Date.now()}`) },
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, "WORKSPACE_FOLDER_MISSING");
  assert.equal((await api(baseUrl, "/api/projects/local", { method: "PATCH", body: { workspacePath: os.tmpdir() } })).status, 400);
  assert.equal((await api(baseUrl, "/api/projects/temp-none", { method: "PATCH", body: { workspacePath: os.tmpdir() } })).status, 404);
  assert.equal((await api(baseUrl, "/api/projects/temp-old", { method: "PATCH", body: { name: "x" } })).status, 400);

  const folder = await tempFolder(t, "w15-old-");
  const updated = await api(baseUrl, "/api/projects/temp-old", { method: "PATCH", body: { workspacePath: folder } });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.project.workspacePath, folder);

  const started = await api(baseUrl, `/api/tasks/${task.body.task.id}/run/start`, { method: "POST", body: {} });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await app.runService.settle();
  assert.equal(providers.claude.calls.find((entry) => entry.method === "start").input.cwd, folder);
});

function rawRequest(port, { method, pathname, host, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({
      host: "127.0.0.1",
      port,
      method,
      path: pathname,
      headers: {
        host,
        ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
      },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : undefined }));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

test("POST /api/local/pick-folder returns the picked folder, a cancel, and is local-only", async (t) => {
  const answers = [{ path: "C:\\Users\\bob\\ROOT", canceled: false }, { path: null, canceled: true }];
  const calls = [];
  const folderPicker = {
    supported: true,
    async pick(input) {
      calls.push(input);
      return answers.shift();
    },
  };
  const { baseUrl, port } = await startBoard(t, { folderPicker });
  const picked = await api(baseUrl, "/api/local/pick-folder", { method: "POST", body: { title: "選擇專案資料夾", initialPath: "C:\\Users" } });
  assert.equal(picked.status, 200, JSON.stringify(picked.body));
  assert.deepEqual(picked.body, { path: "C:\\Users\\bob\\ROOT", canceled: false });
  assert.equal(calls[0].title, "選擇專案資料夾");
  assert.equal(calls[0].initialPath, "C:\\Users");
  assert.ok(calls[0].signal instanceof AbortSignal, "the route passes an abort signal for closed pages");
  const canceled = await api(baseUrl, "/api/local/pick-folder", { method: "POST", body: {} });
  assert.deepEqual(canceled.body, { path: null, canceled: true });
  assert.equal((await api(baseUrl, "/api/local/pick-folder")).status, 405);
  assert.equal((await api(baseUrl, "/api/local/pick-folder", { method: "POST", body: { other: 1 } })).status, 400);

  const foreignHost = await rawRequest(port, { method: "POST", pathname: "/api/local/pick-folder", host: "relay-pc.tailnet.ts.net", body: {} });
  assert.equal(foreignHost.status, 403);
  assert.equal(calls.length, 2, "a non-local Host never opens the dialog");
});

test("folder picker: output protocol, hidden PowerShell, timeout, busy and unsupported platforms", async () => {
  assert.deepEqual(parseFolderPickerOutput("CANCEL\r\n"), { path: null, canceled: true });
  const encoded = Buffer.from("C:\\Users\\小明\\ROOT", "utf8").toString("base64");
  assert.deepEqual(parseFolderPickerOutput(`OK:${encoded}\r\n`), { path: "C:\\Users\\小明\\ROOT", canceled: false });
  assert.equal(parseFolderPickerOutput(`ERROR:${Buffer.from("boom").toString("base64")}`).error, "boom");
  assert.match(FOLDER_PICKER_SCRIPT, /FOS_PICKFOLDERS|AutoMateFolderPicker/);

  const spawned = [];
  function fakeSpawn(file, args, options) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit("close", null, "SIGTERM"));
    };
    spawned.push({ file, args, options, child });
    return child;
  }
  const picker = createFolderPicker({ spawn: fakeSpawn, platform: "win32", timeoutMs: 50, systemRoot: "C:\\Windows" });
  const pending = picker.pick({ title: "選擇專案資料夾", initialPath: "" });
  await assert.rejects(picker.pick({}), (error) => error.status === 409 && error.code === "FOLDER_PICKER_BUSY");
  const [{ file, args, options, child }] = spawned;
  assert.equal(file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(options.windowsHide, true);
  assert.deepEqual(args.slice(0, 8), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden"]);
  assert.equal(Buffer.from(options.env.AUTOMATE_PICKER_TITLE, "base64").toString("utf8"), "選擇專案資料夾");
  child.stdout.emit("data", `OK:${encoded}\r\n`);
  child.emit("close", 0);
  assert.deepEqual(await pending, { path: "C:\\Users\\小明\\ROOT", canceled: false });

  const timedOut = picker.pick({});
  assert.deepEqual(await timedOut, { path: null, canceled: true, timedOut: true });
  assert.equal(spawned[1].child.killed, true);

  const failing = picker.pick({});
  spawned[2].child.stdout.emit("data", `ERROR:${Buffer.from("no desktop").toString("base64")}`);
  spawned[2].child.emit("close", 1);
  await assert.rejects(failing, (error) => error.status === 500 && error.code === "FOLDER_PICKER_FAILED" && /no desktop/.test(error.message));

  const mac = createFolderPicker({ spawn: fakeSpawn, platform: "darwin" });
  await assert.rejects(mac.pick({}), (error) => error.status === 501 && error.code === "FOLDER_PICKER_UNSUPPORTED");
});

test("assertProjectFolder keeps drive roots and drops trailing separators", async (t) => {
  const folder = await tempFolder(t, "w15-root-");
  assert.equal(await assertProjectFolder(`  ${folder}${path.sep}${path.sep} `), folder);
  const root = path.parse(folder).root;
  assert.equal(await assertProjectFolder(root), root);
  await assert.rejects(assertProjectFolder(""), (error) => error.code === "WORKSPACE_REQUIRED");
});

// --- W15 review fixes -------------------------------------------------------------------------

// Dispatches a request with a forged socket address through the real server handler (as in
// v2-integration-mobile.test.mjs).
async function forged(app, pathname, { method = "GET", body, headers = {}, remoteAddress }) {
  const { Readable } = await import("node:stream");
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  request.method = method;
  request.url = pathname;
  request.socket = { remoteAddress };
  request.headers = { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers };
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const response = {
    statusCode: null,
    headers: {},
    body: "",
    headersSent: false,
    writableEnded: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(status, values = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(values)) this.headers[name.toLowerCase()] = value;
      this.headersSent = true;
      return this;
    },
    write(chunk) { this.body += chunk; return true; },
    end(chunk) {
      if (chunk) this.body += chunk;
      this.writableEnded = true;
      finish();
    },
    destroy(error) { this.destroyed = error ?? true; finish(); },
  };
  app.server.emit("request", request, response);
  await done;
  let parsed;
  try { parsed = response.body ? JSON.parse(response.body) : undefined; } catch { parsed = undefined; }
  return { status: response.statusCode, body: parsed, text: response.body };
}

test("review M1: a LAN client can create a project only without a folder and cannot set a folder by any route", async (t) => {
  const picks = [];
  const { app, baseUrl, port } = await startBoard(t, {
    folderPicker: { supported: true, async pick(input) { picks.push(input); return { path: "C:\\x", canceled: false }; } },
  });
  const folder = await tempFolder(t, "w15-lan-");
  const lan = (pathname, options = {}) => forged(app, pathname, {
    remoteAddress: "192.168.50.20",
    ...options,
    headers: { host: `192.168.50.5:${port}`, ...(options.headers ?? {}) },
  });

  const withFolder = await lan("/api/projects", { method: "POST", body: { id: "temp-lan", name: "LAN", workspacePath: folder } });
  assert.equal(withFolder.status, 403, withFolder.text);
  assert.equal(withFolder.body.error.code, "LOCAL_ONLY");
  const withoutFolder = await lan("/api/projects", { method: "POST", body: { id: "temp-lan", name: "LAN", workspacePath: null } });
  assert.equal(withoutFolder.status, 201, withoutFolder.text);
  assert.equal(withoutFolder.body.project.workspacePath, null);

  for (const [method, pathname, body] of [
    ["PATCH", "/api/projects/temp-lan", { workspacePath: folder }],
    ["POST", "/api/local/pick-folder", {}],
    ["PUT", "/api/local/project-mappings/temp-lan", { workspacePath: folder }],
  ]) {
    const result = await lan(pathname, { method, body });
    assert.equal(result.status, 403, `${method} ${pathname} ${result.text}`);
  }
  // A loopback socket with a foreign Host (DNS rebinding) is refused too.
  const rebound = await forged(app, "/api/projects/temp-lan", {
    method: "PATCH",
    remoteAddress: "127.0.0.1",
    headers: { host: `evil.example:${port}` },
    body: { workspacePath: folder },
  });
  assert.equal(rebound.status, 403, rebound.text);
  assert.equal(picks.length, 0, "no folder dialog was opened");
  const project = (await api(baseUrl, "/api/projects")).body.projects.find((candidate) => candidate.id === "temp-lan");
  assert.equal(project.workspacePath, null);
});

test("review O1: an opaque Origin (sandboxed Codex panel) cannot pick or set a folder but can still create a project without one", async (t) => {
  const token = "w15-review-instance-token-0001";
  const picks = [];
  const { port } = await startBoard(t, {
    instanceToken: token,
    instanceSecret: "0123456789abcdef0123456789abcdef",
    folderPicker: { supported: true, async pick(input) { picks.push(input); return { path: "C:\\x", canceled: false }; } },
  });
  const folder = await tempFolder(t, "w15-null-origin-");
  const call = async (pathname, method, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/${token}${pathname}`, {
      method,
      headers: { "content-type": "application/json", origin: "null" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  };
  assert.equal((await call("/api/local/pick-folder", "POST", {})).status, 403);
  assert.equal((await call("/api/projects", "POST", { id: "temp-embed", name: "E", workspacePath: folder })).status, 403);
  const created = await call("/api/projects", "POST", { id: "temp-embed", name: "E", workspacePath: null });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const patched = await call("/api/projects/temp-embed", "PATCH", { workspacePath: folder });
  assert.equal(patched.status, 403);
  assert.equal(patched.body.error.message, "請在 AutoMate Taskboard 視窗裡設定專案資料夾");
  assert.equal(picks.length, 0);
  // The board window itself (same-origin page on 127.0.0.1) still sets the folder.
  const fromWindow = await fetch(`http://127.0.0.1:${port}/${token}/api/projects/temp-embed`, {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ workspacePath: folder }),
  });
  assert.equal(fromWindow.status, 200);
});

test("review O4: cloud mode saves the folder as this device's project mapping instead of forwarding PATCH", async (t) => {
  const state = { version: 1, remoteUrl: "https://tasks.example.test", actorName: "Alice", sharedKey: "k", projectMappings: {} };
  const cloudConfigStore = {
    async read() { return structuredClone(state); },
    async setProjectWorkspace(projectId, workspacePath) { state.projectMappings[projectId] = workspacePath; return structuredClone(state); },
  };
  let forwarded = 0;
  const { baseUrl } = await startBoard(t, { cloudConfigStore, remoteFetch: async () => { forwarded += 1; return new Response("{}", { status: 500 }); } });
  const folder = await tempFolder(t, "w15-cloud-");
  const patched = await api(baseUrl, "/api/projects/portfolio", { method: "PATCH", body: { workspacePath: folder } });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.deepEqual(patched.body, { project: { id: "portfolio", workspacePath: folder } });
  assert.equal(state.projectMappings.portfolio, folder);
  assert.equal(forwarded, 0);
  const missing = await api(baseUrl, "/api/projects/portfolio", { method: "PATCH", body: { workspacePath: path.join(folder, "nope") } });
  assert.equal(missing.status, 400);
});

test("review O2: a closed page or a server shutdown closes the folder dialog and frees the picker", async () => {
  const spawned = [];
  function fakeSpawn() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit("close", null, "SIGTERM"));
    };
    spawned.push(child);
    return child;
  }
  const picker = createFolderPicker({ spawn: fakeSpawn, platform: "win32", timeoutMs: 60_000 });
  const controller = new AbortController();
  const pending = picker.pick({ signal: controller.signal });
  assert.equal(picker.busy, true);
  controller.abort();
  assert.deepEqual(await pending, { path: null, canceled: true, aborted: true });
  assert.equal(spawned[0].killed, true);
  assert.equal(picker.busy, false, "a new dialog can open right away");

  const second = picker.pick({});
  picker.dispose();
  assert.deepEqual(await second, { path: null, canceled: true, aborted: true });
  assert.equal(spawned[1].killed, true);
  assert.equal(picker.busy, false);
});

test("review O2: the server closes an open folder dialog when it stops", async (t) => {
  let disposed = 0;
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "taskboard-w15-close-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const app = createTaskboardServer({
    dataDirectory,
    runProviders: { claude: fakeProvider("claude"), codex: fakeProvider("codex") },
    enableScheduler: false,
    runLogger: quietLogger,
    folderPicker: { supported: true, async pick() { return { path: null, canceled: true }; }, dispose() { disposed += 1; } },
  });
  await app.listen({ port: 0 });
  await app.whenStarted();
  await app.close();
  assert.equal(disposed, 1);
});

test("review O3: Windows folders need a drive letter or a UNC share", async () => {
  const directory = { isDirectory: () => true };
  const statImpl = async () => directory;
  const win = { statImpl, platform: "win32", isAbsolute: path.win32.isAbsolute };
  await assert.rejects(assertProjectFolder("\\foo", win), (error) => error.code === "WORKSPACE_NOT_ABSOLUTE");
  await assert.rejects(assertProjectFolder("/foo", win), (error) => error.code === "WORKSPACE_NOT_ABSOLUTE");
  await assert.rejects(assertProjectFolder("C:foo", win), (error) => error.code === "WORKSPACE_NOT_ABSOLUTE");
  assert.ok(await assertProjectFolder("D:\\Work\\ROOT", win));
  assert.ok(await assertProjectFolder("\\\\nas\\share\\ROOT", win));
  assert.ok(await assertProjectFolder("/srv/root", { statImpl, platform: "linux", isAbsolute: path.posix.isAbsolute }));
});

test("Windows: the folder picker helper compiles and creates the dialog without showing it", { skip: process.platform !== "win32" }, async () => {
  const picker = createFolderPicker({ timeoutMs: 60_000 });
  assert.deepEqual(await picker.check(), { ready: true });
});
