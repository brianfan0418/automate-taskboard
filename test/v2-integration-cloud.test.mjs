// v2 integration (I-S): cloud mode has no Claude agent identity (T2 INTEGRATION_REQUIREMENT).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createCloudWorkerHarness } from "./helpers/cloud-worker-harness.mjs";

let cloud;

before(async () => {
  cloud = await createCloudWorkerHarness();
});

after(async () => {
  await cloud?.dispose();
});

test("cloud rejects the claude-agent assignee with 400 INVALID_FIELD on create and update", async () => {
  const project = await cloud.request("/api/projects", {
    method: "POST",
    actorName: "Alice",
    json: { id: "v2cloud", name: "V2 Cloud" },
  });
  assert.equal(project.response.status, 201);

  const rejectedCreate = await cloud.request("/api/tasks", {
    method: "POST",
    actorName: "Alice",
    json: { projectId: "v2cloud", title: "Claude task", assigneeTarget: "claude-agent" },
  });
  assert.equal(rejectedCreate.response.status, 400);
  assert.equal(rejectedCreate.body.error.code, "INVALID_FIELD");

  const created = await cloud.request("/api/tasks", {
    method: "POST",
    actorName: "Alice",
    json: { projectId: "v2cloud", title: "Codex task", assigneeTarget: "codex-agent" },
  });
  assert.equal(created.response.status, 201);
  assert.match(created.body.task.assignee.id, /codex-agent$/);

  const rejectedPatch = await cloud.request(`/api/tasks/${created.body.task.id}`, {
    method: "PATCH",
    actorName: "Alice",
    json: { version: created.body.task.version, assigneeTarget: "claude-agent" },
  });
  assert.equal(rejectedPatch.response.status, 400);
  assert.equal(rejectedPatch.body.error.code, "INVALID_FIELD");
});
