// DBG-09 regression: the buildPrompt callback gives every comment's own attachments a local file
// path, `comments[i].attachments[j] = { id, filename, localPath }`, resolved like task attachments
// (<attachmentsDirectory>/<id>). Real createTaskboardServer + SQLite + HTTP uploads; the prompt
// builder is replaced through the `taskPromptBuilder` seam to capture its input.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer, taskPromptInput } from "../server/app.mjs";
import { buildTaskPrompt } from "../shared/task-prompt.mjs";

const quiet = { info() {}, warn() {}, error() {} };

function fakeProvider(name, starts) {
  return {
    name,
    async available() { return { ok: true }; },
    async start(input) {
      starts.push(input);
      return { claudeShortId: "short-1", claudeSessionId: "session-1", claudeBridgeSessionId: "bridge-1" };
    },
    async sendFollowup() { return { delivered: true }; },
    async stop() { return { stopped: true }; },
    async close() {},
    openUrl() { return null; },
    async recover() { return { status: "interrupted" }; },
    async dispose() {},
  };
}

test("DBG-09: buildPrompt input carries comment attachments with local paths (run/start)", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-dbg09-"));
  const dataDirectory = path.join(directory, "data");
  const workspacePath = path.join(directory, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const starts = [];
  const promptInputs = [];
  const app = createTaskboardServer({
    dataDirectory,
    runProviders: { claude: fakeProvider("claude", starts), codex: fakeProvider("codex", starts) },
    enableScheduler: false,
    runLogger: quiet,
    mobileAccess: false,
    taskPromptBuilder: (input) => {
      promptInputs.push(input);
      return buildTaskPrompt(input);
    },
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  await app.whenStarted();
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const api = async (pathname, { method = "GET", body, headers = {}, raw } = {}) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  const upload = (route, filename, contentType, kind, content) => api(route, {
    method: "POST",
    raw: Buffer.from(content),
    headers: {
      "content-type": contentType,
      "x-taskboard-filename": encodeURIComponent(filename),
      "x-taskboard-attachment-kind": kind,
    },
  });

  assert.equal((await api("/api/projects", { method: "POST", body: { id: "work", name: "work", workspacePath } })).status, 201);
  const created = await api("/api/tasks", {
    method: "POST",
    body: { projectId: "work", title: "依附件要求整理報表", status: "todo", assigneeTarget: "claude-agent" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const task = created.body.task;

  const taskFile = await upload(`/api/tasks/${task.id}/attachments`, "task-spec.txt", "text/plain", "attachment", "task spec");
  assert.equal(taskFile.status, 201, JSON.stringify(taskFile.body));
  const comment = await api(`/api/tasks/${task.id}/comments`, { method: "POST", body: { body: "請照附件要求做" } });
  assert.equal(comment.status, 201, JSON.stringify(comment.body));
  const commentId = comment.body.comment.id;
  const pdf = await upload(`/api/comments/${commentId}/attachments`, "requirements.pdf", "application/pdf", "attachment", "%PDF-1.4 req");
  assert.equal(pdf.status, 201, JSON.stringify(pdf.body));
  const png = await upload(`/api/comments/${commentId}/attachments`, "layout.png", "image/png", "inline", "png-bytes");
  assert.equal(png.status, 201, JSON.stringify(png.body));

  const started = await api(`/api/tasks/${task.id}/run/start`, { method: "POST", body: {} });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await app.runService.settle();

  assert.equal(promptInputs.length, 1);
  assert.equal(starts.length, 1);
  const input = promptInputs[0];
  const attachmentsDirectory = path.join(dataDirectory, "attachments");
  // Task-level attachments keep their shape.
  assert.deepEqual(input.attachments, [{
    path: path.join(attachmentsDirectory, taskFile.body.attachment.id),
    filename: "task-spec.txt",
  }]);
  const promptComment = input.comments.find((entry) => entry.id === commentId);
  assert.ok(promptComment, "comment is passed to the prompt builder");
  assert.equal(promptComment.body, "請照附件要求做");
  const expected = [
    { id: pdf.body.attachment.id, filename: "requirements.pdf", localPath: path.join(attachmentsDirectory, pdf.body.attachment.id) },
    { id: png.body.attachment.id, filename: "layout.png", localPath: path.join(attachmentsDirectory, png.body.attachment.id) },
  ];
  assert.deepEqual(
    [...promptComment.attachments].sort((a, b) => a.filename.localeCompare(b.filename)),
    [...expected].sort((a, b) => a.filename.localeCompare(b.filename)),
  );
  // The local paths point at the stored files.
  assert.equal(await readFile(expected[0].localPath, "utf8"), "%PDF-1.4 req");
  assert.equal(await readFile(expected[1].localPath, "utf8"), "png-bytes");
});

test("DBG-09: taskPromptInput maps comment attachments to { id, filename, localPath } without other fields", () => {
  const directory = path.join(os.tmpdir(), "attachments-root");
  const input = taskPromptInput({
    task: { id: "t1", title: "x" },
    comments: [
      { id: "c1", body: "one", attachments: [{ id: "a1", filename: "a.pdf", kind: "attachment", size: 3, contentType: "application/pdf" }] },
      { id: "c2", body: "two" },
      { id: "c3", body: "three", attachments: [{ filename: "no-id.txt" }] },
    ],
    attachments: [{ id: "t-a", filename: "task.txt" }],
    attachmentsDirectory: directory,
  });
  assert.deepEqual(input.comments[0].attachments, [{ id: "a1", filename: "a.pdf", localPath: path.join(directory, "a1") }]);
  assert.deepEqual(input.comments[1].attachments, []);
  assert.deepEqual(input.comments[2].attachments, []);
  assert.equal(input.comments[0].body, "one");
  assert.deepEqual(input.attachments, [{ path: path.join(directory, "t-a"), filename: "task.txt" }]);
});
