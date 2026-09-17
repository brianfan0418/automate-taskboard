import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PRIORITY_RANK,
  compareSuggested,
  isBlockedByOpenDependency,
  orderTasks,
  providerForAssignee,
} from "../shared/task-order.mjs";

function task(id, overrides = {}) {
  return {
    id,
    priority: "none",
    dueDate: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    sortOrder: 0,
    ...overrides,
  };
}

const ids = (tasks) => tasks.map((item) => item.id);

test("PRIORITY_RANK matches contract C5", () => {
  assert.deepEqual({ ...PRIORITY_RANK }, { urgent: 0, high: 1, medium: 2, low: 3, none: 4 });
});

test("suggested order: priority rank ascending", () => {
  const tasks = [
    task("none", { priority: "none" }),
    task("low", { priority: "low" }),
    task("urgent", { priority: "urgent" }),
    task("medium", { priority: "medium" }),
    task("high", { priority: "high" }),
  ];
  assert.deepEqual(ids(orderTasks(tasks, "suggested")), ["urgent", "high", "medium", "low", "none"]);
});

test("suggested order: within a priority, due date set first and earlier first", () => {
  const tasks = [
    task("no-due", { priority: "high", createdAt: "2026-01-01T00:00:00.000Z" }),
    task("due-late", { priority: "high", dueDate: "2026-10-05" }),
    task("due-early", { priority: "high", dueDate: "2026-09-20" }),
    task("urgent-no-due", { priority: "urgent" }),
  ];
  assert.deepEqual(ids(orderTasks(tasks, "suggested")), ["urgent-no-due", "due-early", "due-late", "no-due"]);
});

test("suggested order: same priority and due date → createdAt ascending → id", () => {
  const tasks = [
    task("b", { createdAt: "2026-09-02T00:00:00.000Z" }),
    task("c", { createdAt: "2026-09-01T00:00:00.000Z" }),
    task("a", { createdAt: "2026-09-02T00:00:00.000Z" }),
  ];
  assert.deepEqual(ids(orderTasks(tasks, "suggested")), ["c", "a", "b"]);
  assert.equal(compareSuggested(tasks[0], tasks[0]), 0);
});

test("suggested order ignores sortOrder; unknown priority sorts with none", () => {
  const tasks = [
    task("low-top", { priority: "low", sortOrder: -5000 }),
    task("weird", { priority: "bogus", createdAt: "2026-08-01T00:00:00.000Z", sortOrder: -9000 }),
    task("medium-bottom", { priority: "medium", sortOrder: 9000 }),
  ];
  assert.deepEqual(ids(orderTasks(tasks, "suggested")), ["medium-bottom", "low-top", "weird"]);
});

test("manual order: sortOrder ascending, then createdAt; ignores priority and due date", () => {
  const tasks = [
    task("urgent-3", { priority: "urgent", dueDate: "2026-09-18", sortOrder: 3000 }),
    task("low-1", { priority: "low", sortOrder: 1000 }),
    task("none-2-late", { sortOrder: 2000, createdAt: "2026-09-03T00:00:00.000Z" }),
    task("none-2-early", { sortOrder: 2000, createdAt: "2026-09-02T00:00:00.000Z" }),
    task("missing-order", { priority: "urgent", sortOrder: null }),
  ];
  assert.deepEqual(
    ids(orderTasks(tasks, "manual")),
    ["low-1", "none-2-early", "none-2-late", "urgent-3", "missing-order"],
  );
});

test("orderTasks does not mutate its input and tolerates non-arrays", () => {
  const tasks = [task("b", { priority: "low" }), task("a", { priority: "urgent" })];
  const snapshot = ids(tasks);
  const ordered = orderTasks(tasks, "suggested");
  assert.deepEqual(ids(tasks), snapshot);
  assert.notEqual(ordered, tasks);
  assert.deepEqual(orderTasks(undefined, "manual"), []);
});

test("providerForAssignee maps agent assignees only", () => {
  assert.equal(providerForAssignee({ type: "agent", id: "codex-agent", name: "Codex" }), "codex");
  assert.equal(providerForAssignee({ type: "agent", id: "claude-agent", name: "Claude" }), "claude");
  assert.equal(providerForAssignee({ type: "user", id: "codex-agent" }), null);
  assert.equal(providerForAssignee({ type: "user", id: "local-user" }), null);
  assert.equal(providerForAssignee({ type: "agent", id: "other-agent" }), null);
  assert.equal(providerForAssignee({ type: "agent", id: "toString" }), null);
  assert.equal(providerForAssignee(null), null);
  assert.equal(providerForAssignee(undefined), null);
});

test("isBlockedByOpenDependency: any blockedBy entry not done blocks", () => {
  assert.equal(isBlockedByOpenDependency({ relations: { blockedBy: [{ status: "done" }, { status: "in_review" }] } }), true);
  assert.equal(isBlockedByOpenDependency({ relations: { blockedBy: [{ status: "canceled" }] } }), true);
  assert.equal(isBlockedByOpenDependency({ relations: { blockedBy: [{ status: "done" }, { status: "done" }] } }), false);
  assert.equal(isBlockedByOpenDependency({ relations: { blockedBy: [] } }), false);
  assert.equal(isBlockedByOpenDependency({ relations: { blocks: [{ status: "todo" }] } }), false);
  assert.equal(isBlockedByOpenDependency({ relations: null }), false);
  assert.equal(isBlockedByOpenDependency({}), false);
  assert.equal(isBlockedByOpenDependency(undefined), false);
});
