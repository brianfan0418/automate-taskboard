// Import fix F2: the import button's turn explicitly selects the manage-automate-taskboard skill.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AiChatService, taskboardImportInput } from "../server/ai-chat.mjs";
import { TaskboardDatabase } from "../server/database.mjs";
import { createTaskboardServer } from "../server/index.mjs";

const SKILL_PATH = "/fixture/manage-automate-taskboard/SKILL.md";

function fakeAppServer() {
  const turns = [];
  return {
    turns,
    child: null,
    subscribe() { return () => {}; },
    async startThread() { return { thread: { id: "codex-thread-1" } }; },
    async resumeThread({ threadId }) { return { thread: { id: threadId } }; },
    async startTurn(params) { turns.push(params); return { turn: { id: `turn-${turns.length}` } }; },
    async interruptTurn() { return {}; },
    async listSkills() { return []; },
    async close() {},
  };
}

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-import-intent-"));
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  database.createProject({ id: "project", name: "Project", workspacePath: null });
  const appServer = fakeAppServer();
  const service = new AiChatService({
    database,
    codexExecutable: "codex",
    manageTaskboardSkillPath: SKILL_PATH,
    appServer,
    resolveContext: async () => ({
      project: database.getProject("project"),
      workspacePath: workspace,
      addDirectories: [],
    }),
    killGraceMs: 10,
  });
  const thread = database.createAiChatThread({
    title: "Import",
    origin: { projectId: "project", projectName: "Project", workspacePath: workspace },
    model: "gpt-real",
    reasoningEffort: "medium",
    sandbox: "workspace-write",
  });
  return {
    appServer,
    database,
    service,
    thread,
    async close() {
      // The service's grace timer is unref'd; keep the loop alive while the fake turn is interrupted.
      const keepAlive = setInterval(() => {}, 50);
      try {
        await service.close();
      } finally {
        clearInterval(keepAlive);
      }
      database.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

test("taskboardImportInput names the board skill and the import flag", () => {
  const local = taskboardImportInput(SKILL_PATH);
  assert.deepEqual(local[0], { type: "text", text: "$manage-automate-taskboard " });
  assert.deepEqual(local[1], { type: "skill", name: "manage-automate-taskboard", path: SKILL_PATH });
  assert.match(local[2].text, /taskctl issue create --import/);
  const remote = taskboardImportInput(null);
  assert.equal(remote.some((item) => item.type === "skill"), false);
  assert.match(remote[0].text, /\$manage-automate-taskboard/);
});

test("an import-intent composer turn starts with the manage-automate-taskboard skill item", async () => {
  const fixture = await createFixture();
  try {
    await fixture.service.startTurn(fixture.thread.id, {
      contractVersion: "composer.v1",
      revision: "unused",
      intent: "taskboard-import",
      document: { version: 1, nodes: [{ type: "text", text: "Import the project task status." }] },
    });
    const [turn] = fixture.appServer.turns;
    assert.deepEqual(turn.input[1], { type: "skill", name: "manage-automate-taskboard", path: SKILL_PATH });
    assert.equal(turn.input.filter((item) => item.type === "skill").length, 1);
    assert.equal(turn.input.at(-1).text, "Import the project task status.");
    const userEvent = fixture.database.listAiChatEvents(fixture.thread.id)
      .find((event) => event.type === "user_message");
    assert.equal(userEvent.data.intent, "taskboard-import");
  } finally {
    await fixture.close();
  }
});

test("a composer turn without intent does not add the board skill", async () => {
  const fixture = await createFixture();
  try {
    await fixture.service.startTurn(fixture.thread.id, {
      contractVersion: "composer.v1",
      revision: "unused",
      document: { version: 1, nodes: [{ type: "text", text: "hello" }] },
    });
    const [turn] = fixture.appServer.turns;
    assert.deepEqual(turn.input, [{ type: "text", text: "hello" }]);
  } finally {
    await fixture.close();
  }
});

test("the turn API accepts only the known intent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-import-intent-api-"));
  const app = createTaskboardServer({
    dataDirectory: directory,
    codexExecutable: path.join(directory, "missing-codex"),
    codexStatePath: path.join(directory, "missing-state.json"),
    enableScheduler: false,
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`http://127.0.0.1:${address.port}/api/local/ai/threads/missing/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractVersion: "composer.v1",
        revision: "r",
        intent: "run-everything",
        document: { version: 1, nodes: [{ type: "text", text: "x" }] },
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(body.error.code, "INVALID_FIELD");
    assert.match(body.error.message, /intent/);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
