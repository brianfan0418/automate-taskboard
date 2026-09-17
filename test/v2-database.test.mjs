import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { ASSIGNEE_TARGETS, parseAssigneeTarget } from "../shared/api-fields.mjs";
import { parseCloudTaskPatch, parseTaskCreate, parseTaskPatch } from "../shared/task-input.mjs";

const actor = { type: "user", id: "v2-db-tester", name: "V2 DB Tester", avatarUrl: null };
const V2_TABLES = ["project_automation", "task_followups", "task_runs"];
const RUN_KEYS = [
  "id", "taskId", "provider", "status", "claudeShortId", "claudeSessionId", "claudeBridgeSessionId",
  "codexThreadId", "codexTurnId", "resultText", "error", "startedAt", "endedAt", "createdAt", "updatedAt",
  // Amendment 6
  "claudePermissionMode", "claudePermissionSource",
  // Amendment 9
  "claudeLaunchToken",
].sort();
const FOLLOWUP_KEYS = ["id", "taskId", "runId", "body", "mode", "status", "error", "createdAt", "sentAt"].sort();

async function tempDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "taskboard-v2-database-"));
}

async function createFixture() {
  const directory = await tempDirectory();
  const filename = path.join(directory, "taskboard.sqlite");
  const fixture = {
    directory,
    filename,
    database: new TaskboardDatabase(filename),
    reopen() {
      this.database.close();
      this.database = new TaskboardDatabase(filename);
      return this.database;
    },
    async close() {
      try {
        this.database.close();
      } catch {
        // Already closed by the test.
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
  return fixture;
}

function createTask(database, projectId = "local", title = "Run target") {
  return database.createTask({
    projectId,
    title,
    description: "",
    status: "todo",
    priority: "none",
    labels: [],
    threadId: null,
    actor,
    assignee: actor,
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
  });
}

function tableNames(connection) {
  return connection.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all()
    .map((row) => row.name);
}

function backupFiles(directory, { all = false } = {}) {
  const backups = path.join(directory, "backups");
  if (!existsSync(backups)) return [];
  // Opening a WAL-mode backup read-only leaves -wal/-shm companions; count only backup files.
  return readdirSync(backups).filter((name) => all || name.endsWith(".sqlite")).sort();
}

function assertApiError(fn, status, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.name, "ApiError");
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

test("v2 schema creates run, follow-up, and automation tables with contract indexes", async () => {
  const fixture = await createFixture();
  try {
    const connection = fixture.database.database;
    const tables = tableNames(connection);
    for (const table of V2_TABLES) assert.equal(tables.includes(table), true, table);

    const runIndexes = connection.prepare("PRAGMA index_list(task_runs)").all();
    const oneActive = runIndexes.find((index) => index.name === "task_runs_one_active");
    assert.equal(oneActive?.unique, 1);
    assert.equal(oneActive?.partial, 1);
    assert.deepEqual(
      connection.prepare("PRAGMA index_info(task_runs_task)").all().map((column) => column.name),
      ["task_id", "created_at"],
    );
    assert.deepEqual(
      connection.prepare("PRAGMA index_info(task_followups_task)").all().map((column) => column.name),
      ["task_id", "created_at"],
    );
    const runForeignKeys = connection.prepare("PRAGMA foreign_key_list(task_runs)").all();
    assert.equal(runForeignKeys.some((key) => key.table === "tasks" && key.on_delete === "CASCADE"), true);
    const followupForeignKeys = connection.prepare("PRAGMA foreign_key_list(task_followups)").all();
    assert.equal(followupForeignKeys.some((key) => key.table === "task_runs" && key.on_delete === "SET NULL"), true);
    const automationForeignKeys = connection.prepare("PRAGMA foreign_key_list(project_automation)").all();
    assert.equal(automationForeignKeys.some((key) => key.table === "projects" && key.on_delete === "CASCADE"), true);
  } finally {
    await fixture.close();
  }
});

test("createRun starts a camelCase starting run and enforces one active run per task", async () => {
  const fixture = await createFixture();
  try {
    const { database } = fixture;
    const task = createTask(database);
    const other = createTask(database, "local", "Other task");

    const run = database.createRun({ taskId: task.id, provider: "claude" });
    assert.deepEqual(Object.keys(run).sort(), RUN_KEYS);
    assert.equal(run.taskId, task.id);
    assert.equal(run.provider, "claude");
    assert.equal(run.status, "starting");
    assert.match(run.id, /^[0-9a-f-]{36}$/);
    assert.equal(typeof run.startedAt, "string");
    assert.equal(run.startedAt, run.createdAt);
    for (const key of ["claudeShortId", "claudeSessionId", "claudeBridgeSessionId", "codexThreadId", "codexTurnId", "resultText", "error", "endedAt", "claudePermissionMode", "claudePermissionSource", "claudeLaunchToken"]) {
      assert.equal(run[key], null, key);
    }

    assertApiError(() => database.createRun({ taskId: task.id, provider: "codex" }), 409, "RUN_ALREADY_ACTIVE");
    database.updateRun(run.id, { status: "running" });
    assertApiError(() => database.createRun({ taskId: task.id, provider: "claude" }), 409, "RUN_ALREADY_ACTIVE");
    database.updateRun(run.id, { status: "stopping" });
    assertApiError(() => database.createRun({ taskId: task.identifier, provider: "claude" }), 409, "RUN_ALREADY_ACTIVE");

    const otherRun = database.createRun({ taskId: other.identifier, provider: "codex" });
    assert.equal(otherRun.taskId, other.id);

    database.updateRun(run.id, { status: "stopped" });
    const second = database.createRun({ taskId: task.id, provider: "codex" });
    assert.equal(second.status, "starting");
    assertApiError(() => database.updateRun(run.id, { status: "running" }), 409, "RUN_ALREADY_ACTIVE");
    assert.equal(database.getRun(run.id).status, "stopped");

    assertApiError(() => database.createRun({ taskId: "missing-task", provider: "claude" }), 404, "TASK_NOT_FOUND");
    assertApiError(() => database.createRun({ provider: "claude" }), 404, "TASK_NOT_FOUND");
    assertApiError(() => database.createRun({ taskId: other.id, provider: "gemini" }), 400, "INVALID_FIELD");
  } finally {
    await fixture.close();
  }
});

test("updateRun patches refs, sets updatedAt and endedAt, and rejects immutable keys", async () => {
  const fixture = await createFixture();
  try {
    const { database } = fixture;
    const task = createTask(database);
    const run = database.createRun({ taskId: task.id, provider: "claude" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const running = database.updateRun(run.id, {
      status: "running",
      claudeShortId: "abc123",
      claudeSessionId: "session-1",
      claudeBridgeSessionId: "bridge-1",
      resultText: undefined,
    });
    assert.equal(running.status, "running");
    assert.equal(running.claudeShortId, "abc123");
    assert.equal(running.claudeSessionId, "session-1");
    assert.equal(running.claudeBridgeSessionId, "bridge-1");
    assert.equal(running.endedAt, null);
    assert.ok(running.updatedAt > run.updatedAt);
    assert.equal(running.createdAt, run.createdAt);

    const finished = database.updateRun(run.id, { status: "finished", resultText: "完成了" });
    assert.equal(finished.status, "finished");
    assert.equal(finished.resultText, "完成了");
    assert.equal(typeof finished.endedAt, "string");

    const refinished = database.updateRun(run.id, { status: "finished", error: null });
    assert.equal(refinished.endedAt, finished.endedAt, "endedAt is kept once the run already ended");

    const codexTask = createTask(database, "local", "Codex task");
    const codexRun = database.createRun({ taskId: codexTask.id, provider: "codex" });
    const failed = database.updateRun(codexRun.id, {
      status: "failed",
      error: "boom",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
      endedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(failed.endedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(failed.error, "boom");
    assert.equal(failed.codexThreadId, "thread-1");
    assert.equal(failed.codexTurnId, "turn-1");

    for (const key of ["id", "taskId", "provider", "createdAt", "unknownColumn"]) {
      assertApiError(() => database.updateRun(run.id, { [key]: "x" }), 400, "UNKNOWN_FIELD");
    }
    assertApiError(() => database.updateRun(run.id, { status: "done" }), 400, "INVALID_FIELD");
    assertApiError(() => database.updateRun(run.id, { resultText: 42 }), 400, "INVALID_FIELD");
    assertApiError(() => database.updateRun("missing-run", { status: "running" }), 404, "RUN_NOT_FOUND");
    assert.deepEqual(database.updateRun(run.id, {}), database.getRun(run.id));
    assert.equal(database.getRun("missing-run"), null);
  } finally {
    await fixture.close();
  }
});

test("run queries return newest, active, project-scoped, and status-filtered runs", async () => {
  const fixture = await createFixture();
  try {
    const { database } = fixture;
    database.createProject({ id: "alpha", name: "Alpha", workspacePath: "/tmp/alpha" });
    const task = createTask(database);
    const alphaTask = createTask(database, "alpha", "Alpha task");

    const first = database.createRun({ taskId: task.id, provider: "codex" });
    database.updateRun(first.id, { status: "interrupted" });
    const second = database.createRun({ taskId: task.id, provider: "claude" });
    database.updateRun(second.id, { status: "finished", resultText: "" });
    const third = database.createRun({ taskId: task.id, provider: "claude" });
    database.updateRun(third.id, { status: "running" });
    const alphaRun = database.createRun({ taskId: alphaTask.id, provider: "codex" });

    assert.deepEqual(database.listRuns(task.id).map((run) => run.id), [third.id, second.id, first.id]);
    assert.equal(database.getLatestRun(task.id).id, third.id);
    assert.equal(database.getActiveRun(task.id).id, third.id);
    assert.equal(database.getActiveRun(alphaTask.id).id, alphaRun.id);
    assert.equal(database.getLatestRun("missing-task"), null);
    assert.equal(database.getActiveRun("missing-task"), null);
    assert.deepEqual(database.listRuns("missing-task"), []);

    database.updateRun(third.id, { status: "stopped" });
    assert.equal(database.getActiveRun(task.id), null);
    assert.equal(database.getLatestRun(task.id).id, third.id);
    assert.equal(database.getLatestRun(task.id).resultText, null);
    assert.equal(database.listRuns(task.id)[1].resultText, "");

    const restarted = database.createRun({ taskId: task.id, provider: "codex" });
    const allActive = database.listActiveRuns();
    assert.deepEqual(allActive.map((run) => run.id).sort(), [alphaRun.id, restarted.id].sort());
    assert.equal(allActive.find((run) => run.id === alphaRun.id).projectId, "alpha");
    assert.equal(allActive.find((run) => run.id === restarted.id).projectId, "local");
    assert.deepEqual(database.listActiveRuns({ projectId: "alpha" }).map((run) => run.id), [alphaRun.id]);
    assert.deepEqual(database.listActiveRuns({ projectId: "nobody" }), []);

    assert.deepEqual(
      database.listRunsByStatus(["finished", "interrupted"]).map((run) => run.id).sort(),
      [first.id, second.id].sort(),
    );
    assert.deepEqual(
      database.listRunsByStatus(["starting", "running", "stopping"]).map((run) => run.id).sort(),
      [alphaRun.id, restarted.id].sort(),
    );
    assert.deepEqual(database.listRunsByStatus([]), []);
    assertApiError(() => database.listRunsByStatus(["bogus"]), 400, "INVALID_FIELD");
  } finally {
    await fixture.close();
  }
});

test("follow-ups are created pending, listed oldest first, and updated with sentAt", async () => {
  const fixture = await createFixture();
  try {
    const { database } = fixture;
    const task = createTask(database);
    const other = createTask(database, "local", "Other");
    const run = database.createRun({ taskId: task.id, provider: "claude" });
    const otherRun = database.createRun({ taskId: other.id, provider: "codex" });

    const queued = database.createFollowup({ taskId: task.id, runId: run.id, body: "請順便更新 README", mode: "queue" });
    assert.deepEqual(Object.keys(queued).sort(), FOLLOWUP_KEYS);
    assert.equal(queued.status, "pending");
    assert.equal(queued.mode, "queue");
    assert.equal(queued.runId, run.id);
    assert.equal(queued.sentAt, null);
    assert.equal(queued.error, null);
    const steer = database.createFollowup({ taskId: task.id, runId: run.id, body: "先停一下", mode: "steer" });
    const noRun = database.createFollowup({ taskId: task.identifier, body: "later", mode: "queue" });
    assert.equal(noRun.runId, null);
    assert.equal(noRun.taskId, task.id);

    assert.deepEqual(database.listFollowups(task.id).map((item) => item.id), [queued.id, steer.id, noRun.id]);
    assert.deepEqual(database.listPendingFollowups(task.id).map((item) => item.id), [queued.id, noRun.id]);

    const sent = database.updateFollowup(queued.id, { status: "sent" });
    assert.equal(sent.status, "sent");
    assert.equal(typeof sent.sentAt, "string");
    const failed = database.updateFollowup(noRun.id, { status: "failed", error: "not delivered", runId: run.id });
    assert.equal(failed.error, "not delivered");
    assert.equal(failed.runId, run.id);
    assert.equal(failed.sentAt, null);
    const explicit = database.updateFollowup(steer.id, { status: "sent", sentAt: "2026-02-02T00:00:00.000Z" });
    assert.equal(explicit.sentAt, "2026-02-02T00:00:00.000Z");
    assert.deepEqual(database.listPendingFollowups(task.id), []);

    assertApiError(() => database.createFollowup({ taskId: "missing", body: "x", mode: "queue" }), 404, "TASK_NOT_FOUND");
    assertApiError(() => database.createFollowup({ taskId: task.id, body: "x", mode: "later" }), 400, "INVALID_FIELD");
    assertApiError(() => database.createFollowup({ taskId: task.id, body: null, mode: "queue" }), 400, "INVALID_FIELD");
    assertApiError(() => database.createFollowup({ taskId: task.id, runId: "missing-run", body: "x", mode: "queue" }), 404, "RUN_NOT_FOUND");
    assertApiError(() => database.createFollowup({ taskId: task.id, runId: otherRun.id, body: "x", mode: "queue" }), 400, "INVALID_FIELD");
    assertApiError(() => database.updateFollowup(queued.id, { body: "changed" }), 400, "UNKNOWN_FIELD");
    assertApiError(() => database.updateFollowup(queued.id, { status: "done" }), 400, "INVALID_FIELD");
    assertApiError(() => database.updateFollowup("missing-followup", { status: "sent" }), 404, "FOLLOWUP_NOT_FOUND");
  } finally {
    await fixture.close();
  }
});

test("deleting an archived task cascades its runs and follow-ups", async () => {
  const fixture = await createFixture();
  try {
    const { database } = fixture;
    const task = createTask(database);
    const run = database.createRun({ taskId: task.id, provider: "claude" });
    database.updateRun(run.id, { status: "finished", resultText: "ok" });
    database.createFollowup({ taskId: task.id, runId: run.id, body: "x", mode: "queue" });
    const archived = database.archiveTask(task.id, task.version, undefined, undefined, actor);
    database.deleteArchivedTask(task.id, archived.version);
    assert.equal(database.getRun(run.id), null);
    assert.deepEqual(database.listFollowups(task.id), []);
  } finally {
    await fixture.close();
  }
});

test("project automation returns defaults, upserts validated patches, and lists enabled projects", async () => {
  const fixture = await createFixture();
  try {
    let database = fixture.database;
    database.createProject({ id: "alpha", name: "Alpha", workspacePath: "/tmp/alpha" });
    database.createProject({ id: "beta", name: "Beta", workspacePath: "/tmp/beta" });

    assert.deepEqual(database.getProjectAutomation("alpha"), {
      projectId: "alpha",
      enabled: false,
      maxParallel: 3,
      claudeModel: null,
      codexModel: null,
      codexEffort: null,
      orderMode: "suggested",
      claudePermissionMode: "followClaude",
      updatedAt: null,
    });
    assert.deepEqual(database.listEnabledAutomations(), []);

    const enabled = database.updateProjectAutomation("alpha", {
      enabled: true,
      maxParallel: 5,
      claudeModel: "claude-opus",
      codexEffort: "high",
    });
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.maxParallel, 5);
    assert.equal(enabled.claudeModel, "claude-opus");
    assert.equal(enabled.codexModel, null);
    assert.equal(enabled.codexEffort, "high");
    assert.equal(enabled.orderMode, "suggested");
    assert.equal(typeof enabled.updatedAt, "string");

    const manual = database.updateProjectAutomation("alpha", { orderMode: "manual", claudeModel: "  " });
    assert.equal(manual.enabled, true, "partial patch keeps other fields");
    assert.equal(manual.maxParallel, 5);
    assert.equal(manual.claudeModel, null);
    assert.equal(manual.orderMode, "manual");

    database.updateProjectAutomation("beta", { maxParallel: 1 });
    assert.deepEqual(database.listEnabledAutomations().map((automation) => automation.projectId), ["alpha"]);
    database.updateProjectAutomation("beta", { enabled: true, maxParallel: 20 });
    assert.deepEqual(database.listEnabledAutomations().map((automation) => automation.projectId), ["alpha", "beta"]);

    for (const maxParallel of [0, 21, 1.5, "3"]) {
      assertApiError(() => database.updateProjectAutomation("alpha", { maxParallel }), 400, "INVALID_FIELD");
    }
    assertApiError(() => database.updateProjectAutomation("alpha", { enabled: 1 }), 400, "INVALID_FIELD");
    assertApiError(() => database.updateProjectAutomation("alpha", { orderMode: "random" }), 400, "INVALID_FIELD");
    assertApiError(() => database.updateProjectAutomation("alpha", { codexModel: 5 }), 400, "INVALID_FIELD");
    assertApiError(() => database.updateProjectAutomation("alpha", { schedule: "hourly" }), 400, "UNKNOWN_FIELD");
    assertApiError(() => database.updateProjectAutomation("missing", { enabled: true }), 404, "PROJECT_NOT_FOUND");
    assertApiError(() => database.getProjectAutomation("missing"), 404, "PROJECT_NOT_FOUND");
    assert.equal(database.getProjectAutomation("alpha").maxParallel, 5, "failed patches do not write");

    database = fixture.reopen();
    assert.equal(database.getProjectAutomation("alpha").orderMode, "manual");
    assert.equal(database.getProjectAutomation("beta").maxParallel, 20);
    assert.deepEqual(backupFiles(fixture.directory), [], "an already-v2 database is not backed up again");
  } finally {
    await fixture.close();
  }
});

test("a brand-new database migrates without creating a backup", async () => {
  const fixture = await createFixture();
  try {
    assert.deepEqual(backupFiles(fixture.directory), []);
    assert.equal(existsSync(path.join(fixture.directory, "backups")), false);
    fixture.reopen();
    assert.equal(existsSync(path.join(fixture.directory, "backups")), false);
  } finally {
    await fixture.close();
  }
});

test("upgrading an existing pre-v2 database writes a checkpointed backup first", async () => {
  const directory = await tempDirectory();
  const filename = path.join(directory, "taskboard.sqlite");
  let writer = null;
  let upgraded = null;
  try {
    const seed = new TaskboardDatabase(filename);
    const task = createTask(seed, "local", "Before v2");
    seed.close();
    const legacy = new DatabaseSync(filename);
    legacy.exec("DROP TABLE task_followups; DROP TABLE task_runs; DROP TABLE project_automation;");
    legacy.close();

    // A second connection leaves a committed row in the WAL (not yet checkpointed).
    writer = new DatabaseSync(filename);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    writer.prepare("UPDATE tasks SET title = 'Written in WAL' WHERE id = ?").run(task.id);
    assert.equal(existsSync(`${filename}-wal`), true);

    upgraded = new TaskboardDatabase(filename);
    const backups = backupFiles(directory);
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^taskboard-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sqlite$/);
    for (const table of V2_TABLES) assert.equal(tableNames(upgraded.database).includes(table), true);
    assert.equal(upgraded.getTask(task.id).title, "Written in WAL");

    const backup = new DatabaseSync(path.join(directory, "backups", backups[0]), { readOnly: true });
    try {
      const backupTables = tableNames(backup);
      for (const table of V2_TABLES) assert.equal(backupTables.includes(table), false, table);
      assert.equal(
        backup.prepare("SELECT title FROM tasks WHERE id = ?").get(task.id).title,
        "Written in WAL",
        "backup includes WAL content",
      );
    } finally {
      backup.close();
    }

    upgraded.close();
    upgraded = new TaskboardDatabase(filename);
    assert.equal(backupFiles(directory).length, 1, "a v2 database is not backed up on later starts");
  } finally {
    writer?.close();
    upgraded?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a partially missing v2 schema is also backed up before migration", async () => {
  const directory = await tempDirectory();
  const filename = path.join(directory, "taskboard.sqlite");
  let database = null;
  try {
    new TaskboardDatabase(filename).close();
    const legacy = new DatabaseSync(filename);
    legacy.exec("DROP TABLE project_automation;");
    legacy.close();
    database = new TaskboardDatabase(filename);
    assert.equal(backupFiles(directory).length, 1);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration backups keep only the newest five and ignore unrelated files", async () => {
  const directory = await tempDirectory();
  const filename = path.join(directory, "taskboard.sqlite");
  let database = null;
  try {
    new TaskboardDatabase(filename).close();
    const legacy = new DatabaseSync(filename);
    legacy.exec("DROP TABLE task_followups; DROP TABLE task_runs; DROP TABLE project_automation;");
    legacy.close();

    const backupsDirectory = path.join(directory, "backups");
    mkdirSync(backupsDirectory, { recursive: true });
    const seeded = [1, 2, 3, 4, 5, 6].map((day) => `taskboard-2020-01-0${day}T00-00-00-000Z.sqlite`);
    for (const name of seeded) writeFileSync(path.join(backupsDirectory, name), "old");
    writeFileSync(path.join(backupsDirectory, `${seeded[0]}-wal`), "old companion");
    writeFileSync(path.join(backupsDirectory, "notes.txt"), "keep");
    writeFileSync(path.join(backupsDirectory, "taskboard-manual.sqlite"), "keep");

    database = new TaskboardDatabase(filename);
    const remaining = backupFiles(directory, { all: true });
    const timestamped = remaining.filter((name) => /^taskboard-\d{4}-/.test(name));
    assert.equal(timestamped.length, 5);
    assert.deepEqual(timestamped.slice(0, 4), seeded.slice(2));
    assert.equal(timestamped[4].startsWith("taskboard-2020-"), false, "the new backup is kept");
    assert.equal(remaining.includes(`${seeded[0]}-wal`), false, "companions of pruned backups are removed");
    assert.equal(remaining.includes("notes.txt"), true);
    assert.equal(remaining.includes("taskboard-manual.sqlite"), true);
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an existing database is not migrated when its backup cannot be written", async () => {
  const directory = await tempDirectory();
  const filename = path.join(directory, "taskboard.sqlite");
  try {
    new TaskboardDatabase(filename).close();
    const legacy = new DatabaseSync(filename);
    legacy.exec("DROP TABLE task_followups; DROP TABLE task_runs; DROP TABLE project_automation;");
    legacy.close();
    // A plain file where the backups directory should be makes the backup step fail.
    writeFileSync(path.join(directory, "backups"), "not a directory");

    let failure = null;
    try {
      new TaskboardDatabase(filename);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, "constructor must throw");
    assert.equal(failure.code, "DB_MIGRATION_FAILED");
    assert.equal(failure.status, 500);
    assert.deepEqual(failure.details, { backupPath: null, restored: false, stage: "backup" });

    const untouched = new DatabaseSync(filename, { readOnly: true });
    try {
      const tables = tableNames(untouched);
      for (const table of V2_TABLES) assert.equal(tables.includes(table), false, table);
    } finally {
      untouched.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed migration restores the original database file and reports DB_MIGRATION_FAILED", async () => {
  const directory = await tempDirectory();
  const filename = path.join(directory, "taskboard.sqlite");
  try {
    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = OFF;
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT,
        next_task_number INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('backlog', 'todo', 'in_progress', 'done')),
        priority TEXT NOT NULL,
        labels TEXT NOT NULL DEFAULT '[]',
        sort_order REAL NOT NULL,
        archived_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO projects VALUES ('local', 'Local', NULL, 3, '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z');
      INSERT INTO tasks VALUES (
        'kept-task', 'LOCAL-1', 'local', 'Kept task', '', 'todo', 'none', '[]', 1000, NULL, 1,
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'
      );
      INSERT INTO tasks VALUES (
        'orphan-task', 'LOCAL-2', 'ghost-project', 'Orphan', '', 'todo', 'none', '[]', 2000, NULL, 1,
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'
      );
    `);
    legacy.close();
    const originalBytes = readFileSync(filename);

    let failure = null;
    try {
      new TaskboardDatabase(filename);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, "constructor must throw");
    assert.equal(failure.name, "ApiError");
    assert.equal(failure.status, 500);
    assert.equal(failure.code, "DB_MIGRATION_FAILED");
    assert.match(failure.message, /foreign key violation/);
    assert.equal(failure.details.restored, true);
    const backups = backupFiles(directory);
    assert.equal(backups.length, 1);
    const backupPath = path.join(directory, "backups", backups[0]);
    assert.equal(failure.details.backupPath, backupPath);
    assert.ok(failure.message.includes(`backup: ${backupPath}`));

    assert.equal(existsSync(`${filename}-wal`), false);
    assert.deepEqual(readFileSync(filename), originalBytes, "database file bytes are restored");
    assert.deepEqual(readFileSync(backupPath), originalBytes, "backup is an exact copy of the pre-migration file");

    const restored = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.deepEqual(tableNames(restored), ["projects", "tasks"]);
      const tasksSql = restored.prepare("SELECT sql FROM sqlite_schema WHERE name = 'tasks'").get().sql;
      assert.doesNotMatch(tasksSql, /in_review/);
      assert.deepEqual(
        restored.prepare("SELECT id FROM tasks ORDER BY id").all().map((row) => row.id),
        ["kept-task", "orphan-task"],
      );
    } finally {
      restored.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("assignee target parsers accept claude-agent alongside existing targets", () => {
  assert.deepEqual([...ASSIGNEE_TARGETS], ["current-user", "codex-agent", "claude-agent"]);
  for (const target of ["current-user", "codex-agent", "claude-agent"]) {
    assert.equal(parseAssigneeTarget(target), target);
  }
  assert.equal(parseAssigneeTarget(undefined), undefined);
  for (const invalid of ["claude", "Claude-Agent", null, { type: "agent" }]) {
    assertApiError(() => parseAssigneeTarget(invalid), 400, "INVALID_FIELD");
  }

  const identity = (value) => value;
  assert.equal(parseTaskCreate({ title: "Claude task", assigneeTarget: "claude-agent" }, identity).assigneeTarget, "claude-agent");
  assert.equal(parseTaskPatch({ version: 1, assigneeTarget: "claude-agent" }, identity).assigneeTarget, "claude-agent");
  assert.equal(parseCloudTaskPatch({ version: 1, assigneeTarget: "claude-agent" }, identity).assigneeTarget, "claude-agent");
  assertApiError(() => parseTaskPatch({ version: 1, assigneeTarget: "gemini-agent" }, identity), 400, "INVALID_FIELD");
});

// ---- W5: CONTRACTS Amendment 5 (claude_permission_mode) and pending steers ----

test("W5 + Amendment 6: claudePermissionMode defaults to followClaude, validates, persists, and is listed", async () => {
  const fixture = await createFixture();
  try {
    let database = fixture.database;
    database.createProject({ id: "alpha", name: "Alpha", workspacePath: "/tmp/alpha" });
    assert.equal(database.getProjectAutomation("alpha").claudePermissionMode, "followClaude");
    assert.equal(database.updateProjectAutomation("alpha", { maxParallel: 3 }).claudePermissionMode, "followClaude", "a new row stores the default");
    for (const mode of ["bypassPermissions", "followClaude"]) {
      assert.equal(database.updateProjectAutomation("alpha", { claudePermissionMode: mode }).claudePermissionMode, mode);
    }
    const saved = database.updateProjectAutomation("alpha", { claudePermissionMode: "acceptEdits", enabled: true });
    assert.equal(saved.claudePermissionMode, "acceptEdits");
    assert.equal(database.updateProjectAutomation("alpha", { maxParallel: 2 }).claudePermissionMode, "acceptEdits", "partial patch keeps it");
    for (const value of ["manual", "dontAsk", "default", "FollowClaude", "", null, 1]) {
      assertApiError(() => database.updateProjectAutomation("alpha", { claudePermissionMode: value }), 400, "INVALID_FIELD");
    }
    assert.equal(database.listEnabledAutomations()[0].claudePermissionMode, "acceptEdits");
    database = fixture.reopen();
    assert.equal(database.getProjectAutomation("alpha").claudePermissionMode, "acceptEdits");
    const column = database.database.prepare("PRAGMA table_info(project_automation)").all()
      .find((candidate) => candidate.name === "claude_permission_mode");
    assert.equal(column.type, "TEXT");
    assert.equal(column.dflt_value, "'followClaude'");
    assert.throws(() => database.database.prepare(
      "UPDATE project_automation SET claude_permission_mode = 'plan' WHERE project_id = 'alpha'",
    ).run(), /CHECK constraint failed/);
  } finally {
    await fixture.close();
  }
});

test("W5: a v2 database without claude_permission_mode is backed up, then migrated with the (Amendment 6) default", async () => {
  const directory = await tempDirectory();
  const filename = path.join(directory, "taskboard.sqlite");
  let database = null;
  try {
    const first = new TaskboardDatabase(filename);
    first.createProject({ id: "alpha", name: "Alpha", workspacePath: "/tmp/alpha" });
    first.updateProjectAutomation("alpha", { enabled: true, maxParallel: 4 });
    first.close();
    // Rebuild project_automation in its Amendment-4 shape (no claude_permission_mode).
    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE project_automation_old AS SELECT project_id, enabled, max_parallel, claude_model, codex_model,
        codex_effort, order_mode, updated_at FROM project_automation;
      DROP TABLE project_automation;
      CREATE TABLE project_automation (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0,
        max_parallel INTEGER NOT NULL DEFAULT 3,
        claude_model TEXT,
        codex_model TEXT,
        codex_effort TEXT,
        order_mode TEXT NOT NULL DEFAULT 'suggested' CHECK (order_mode IN ('suggested', 'manual')),
        updated_at TEXT NOT NULL
      );
      INSERT INTO project_automation SELECT * FROM project_automation_old;
      DROP TABLE project_automation_old;
    `);
    legacy.close();

    database = new TaskboardDatabase(filename);
    const backups = backupFiles(directory);
    assert.equal(backups.length, 1, "missing column → backup before migrating");
    const automation = database.getProjectAutomation("alpha");
    assert.deepEqual([automation.enabled, automation.maxParallel, automation.claudePermissionMode], [true, 4, "followClaude"]);
    const backup = new DatabaseSync(path.join(directory, "backups", backups[0]), { readOnly: true });
    try {
      const columns = backup.prepare("PRAGMA table_info(project_automation)").all().map((column) => column.name);
      assert.equal(columns.includes("claude_permission_mode"), false, "the backup is the pre-migration file");
    } finally {
      backup.close();
    }
    database.close();
    database = new TaskboardDatabase(filename);
    assert.equal(backupFiles(directory).length, 1, "not backed up again once migrated");
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// ---- Amendment 6: followClaude migration and the run permission record ----

function rebuildAsAmendment5(filename, { withRunColumns = false } = {}) {
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE project_automation_old AS SELECT * FROM project_automation;
    DROP TABLE project_automation;
    CREATE TABLE project_automation (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0,
      max_parallel INTEGER NOT NULL DEFAULT 3,
      claude_model TEXT,
      codex_model TEXT,
      codex_effort TEXT,
      order_mode TEXT NOT NULL DEFAULT 'suggested' CHECK (order_mode IN ('suggested', 'manual')),
      claude_permission_mode TEXT DEFAULT 'bypassPermissions'
        CHECK (claude_permission_mode IN ('acceptEdits', 'bypassPermissions')),
      updated_at TEXT NOT NULL
    );
    INSERT INTO project_automation (
      project_id, enabled, max_parallel, claude_model, codex_model, codex_effort, order_mode,
      claude_permission_mode, updated_at
    )
    SELECT project_id, enabled, max_parallel, claude_model, codex_model, codex_effort, order_mode,
      CASE project_id WHEN 'alpha' THEN 'acceptEdits' ELSE 'bypassPermissions' END, updated_at
    FROM project_automation_old;
    DROP TABLE project_automation_old;
  `);
  if (!withRunColumns) {
    legacy.exec(`
      ALTER TABLE task_runs DROP COLUMN claude_permission_mode;
      ALTER TABLE task_runs DROP COLUMN claude_permission_source;
    `);
  }
  legacy.close();
}

test("Amendment 6: an Amendment-5 database is backed up, rebuilt to allow followClaude, and keeps every stored value", async () => {
  const directory = await tempDirectory();
  const filename = path.join(directory, "taskboard.sqlite");
  let database = null;
  try {
    const first = new TaskboardDatabase(filename);
    first.createProject({ id: "alpha", name: "Alpha", workspacePath: "/tmp/alpha" });
    first.createProject({ id: "beta", name: "Beta", workspacePath: "/tmp/beta" });
    first.updateProjectAutomation("alpha", { enabled: true, maxParallel: 4, claudeModel: "opus" });
    first.updateProjectAutomation("beta", { maxParallel: 2, orderMode: "manual" });
    const task = createTask(first);
    const run = first.createRun({ taskId: task.id, provider: "claude" });
    first.updateRun(run.id, { status: "finished", resultText: "ok" });
    first.close();
    rebuildAsAmendment5(filename);

    database = new TaskboardDatabase(filename);
    const backups = backupFiles(directory);
    assert.equal(backups.length, 1, "CHECK without followClaude → backup before migrating");
    const alpha = database.getProjectAutomation("alpha");
    const beta = database.getProjectAutomation("beta");
    assert.deepEqual(
      [alpha.enabled, alpha.maxParallel, alpha.claudeModel, alpha.claudePermissionMode],
      [true, 4, "opus", "acceptEdits"],
    );
    assert.deepEqual([beta.maxParallel, beta.orderMode, beta.claudePermissionMode], [2, "manual", "bypassPermissions"]);
    const tableSql = database.database.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'project_automation'",
    ).get().sql;
    assert.match(tableSql, /'followClaude'/);
    assert.equal(
      database.database.prepare("PRAGMA table_info(project_automation)").all()
        .find((column) => column.name === "claude_permission_mode").dflt_value,
      "'followClaude'",
    );
    assert.equal(database.updateProjectAutomation("beta", { claudePermissionMode: "followClaude" }).claudePermissionMode, "followClaude");
    database.createProject({ id: "gamma", name: "Gamma", workspacePath: "/tmp/gamma" });
    assert.equal(database.updateProjectAutomation("gamma", { enabled: false }).claudePermissionMode, "followClaude");
    assert.throws(() => database.database.prepare(
      "UPDATE project_automation SET claude_permission_mode = 'plan' WHERE project_id = 'alpha'",
    ).run(), /CHECK constraint failed/);
    assert.equal(database.database.prepare("PRAGMA foreign_key_check").get(), undefined);
    const migratedRun = database.getRun(run.id);
    assert.deepEqual([migratedRun.resultText, migratedRun.claudePermissionMode, migratedRun.claudePermissionSource], ["ok", null, null]);
    // Deleting a project still cascades to its automation row after the rebuild.
    database.database.prepare("DELETE FROM projects WHERE id = 'gamma'").run();
    assert.equal(database.database.prepare("SELECT COUNT(*) AS count FROM project_automation WHERE project_id = 'gamma'").get().count, 0);

    const backup = new DatabaseSync(path.join(directory, "backups", backups[0]), { readOnly: true });
    try {
      const sql = backup.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'project_automation'").get().sql;
      assert.doesNotMatch(sql, /followClaude/, "the backup is the pre-migration file");
    } finally {
      backup.close();
    }
    database.close();
    database = new TaskboardDatabase(filename);
    assert.equal(backupFiles(directory).length, 1, "not backed up again once migrated");
    assert.equal(database.getProjectAutomation("alpha").claudePermissionMode, "acceptEdits");
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Amendment 6: a database whose task_runs lack the permission columns is backed up and migrated", async () => {
  const directory = await tempDirectory();
  const filename = path.join(directory, "taskboard.sqlite");
  let database = null;
  try {
    const first = new TaskboardDatabase(filename);
    first.close();
    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      ALTER TABLE task_runs DROP COLUMN claude_permission_mode;
      ALTER TABLE task_runs DROP COLUMN claude_permission_source;
    `);
    legacy.close();
    database = new TaskboardDatabase(filename);
    assert.equal(backupFiles(directory).length, 1);
    const columns = database.database.prepare("PRAGMA table_info(task_runs)").all().map((column) => column.name);
    assert.ok(columns.includes("claude_permission_mode"));
    assert.ok(columns.includes("claude_permission_source"));
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Amendment 9: a database whose task_runs lack claude_launch_token is backed up and migrated; updateRun validates the token", async () => {
  const directory = await tempDirectory();
  const filename = path.join(directory, "taskboard.sqlite");
  let database = null;
  try {
    const first = new TaskboardDatabase(filename);
    const task = createTask(first);
    const run = first.createRun({ taskId: task.id, provider: "claude" });
    first.close();
    const legacy = new DatabaseSync(filename);
    legacy.exec("ALTER TABLE task_runs DROP COLUMN claude_launch_token;");
    legacy.close();
    database = new TaskboardDatabase(filename);
    assert.equal(backupFiles(directory).length, 1, "missing column → backup before migrating");
    const columns = database.database.prepare("PRAGMA table_info(task_runs)").all().map((column) => column.name);
    assert.ok(columns.includes("claude_launch_token"));
    assert.equal(database.getRun(run.id).claudeLaunchToken, null);
    assert.equal(database.updateRun(run.id, { claudeLaunchToken: "a1b2c3d4" }).claudeLaunchToken, "a1b2c3d4");
    assertApiError(() => database.updateRun(run.id, { claudeLaunchToken: "a b" }), 400, "INVALID_FIELD");
    assert.equal(database.updateRun(run.id, { claudeLaunchToken: null }).claudeLaunchToken, null);
    database.close();
    database = new TaskboardDatabase(filename);
    assert.equal(backupFiles(directory).length, 1, "not backed up again once migrated");
  } finally {
    database?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Amendment 6: updateRun records and validates the Claude permission mode and source", async () => {
  const fixture = await createFixture();
  try {
    const { database } = fixture;
    const task = createTask(database);
    const run = database.createRun({ taskId: task.id, provider: "claude" });
    const saved = database.updateRun(run.id, { claudePermissionMode: "acceptEdits", claudePermissionSource: "project" });
    assert.deepEqual([saved.claudePermissionMode, saved.claudePermissionSource], ["acceptEdits", "project"]);
    for (const [mode, source] of [["default", "user"], ["plan", "managed"], ["auto", "projectLocal"], ["dontAsk", "user"], ["bypassPermissions", "fallback"], ["acceptEdits", "board"], [null, "projectLocal"]]) {
      const next = database.updateRun(run.id, { claudePermissionMode: mode, claudePermissionSource: source });
      assert.deepEqual([next.claudePermissionMode, next.claudePermissionSource], [mode, source]);
    }
    assertApiError(() => database.updateRun(run.id, { claudePermissionMode: "followClaude" }), 400, "INVALID_FIELD");
    assertApiError(() => database.updateRun(run.id, { claudePermissionMode: "manual" }), 400, "INVALID_FIELD");
    assertApiError(() => database.updateRun(run.id, { claudePermissionSource: "somewhere" }), 400, "INVALID_FIELD");
    assertApiError(() => database.updateRun(run.id, { claudePermissionSource: 3 }), 400, "INVALID_FIELD");
    assert.equal(database.getRun(run.id).claudePermissionSource, "projectLocal");
  } finally {
    await fixture.close();
  }
});

test("W5: listPendingSteerFollowups returns pending steers across tasks only", async () => {
  const fixture = await createFixture();
  try {
    const database = fixture.database;
    const first = createTask(database, "local", "A");
    const second = createTask(database, "local", "B");
    const steerA = database.createFollowup({ taskId: first.id, body: "steer A", mode: "steer" });
    database.createFollowup({ taskId: first.id, body: "queue A", mode: "queue" });
    const steerB = database.createFollowup({ taskId: second.id, body: "steer B", mode: "steer" });
    const sent = database.createFollowup({ taskId: second.id, body: "steer sent", mode: "steer" });
    database.updateFollowup(sent.id, { status: "sent" });
    assert.deepEqual(database.listPendingSteerFollowups().map((followup) => followup.id), [steerA.id, steerB.id]);
  } finally {
    await fixture.close();
  }
});
