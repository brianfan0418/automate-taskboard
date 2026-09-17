import type { ActorIdentity, AssigneeTarget, TaskRunProvider } from "./types";

export const CODEX_AGENT_ACTOR: ActorIdentity = {
  type: "agent",
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
};

export const CLAUDE_AGENT_ACTOR: ActorIdentity = {
  type: "agent",
  id: "claude-agent",
  name: "Claude",
  avatarUrl: null,
};

export const AGENT_ACTORS: readonly ActorIdentity[] = [CODEX_AGENT_ACTOR, CLAUDE_AGENT_ACTOR];

export function actorKey(actor: ActorIdentity): string {
  return `${actor.type}:${actor.id}`;
}

export function actorForAssigneeTarget(
  target: AssigneeTarget,
  currentUser: ActorIdentity,
): ActorIdentity {
  if (target === "codex-agent") return CODEX_AGENT_ACTOR;
  if (target === "claude-agent") return CLAUDE_AGENT_ACTOR;
  return currentUser;
}

export function assigneeTargetForActor(
  actor: ActorIdentity,
  currentUser: ActorIdentity,
): AssigneeTarget | undefined {
  if (actor.type === "agent") {
    // Upstream only had the Codex agent, so any other agent id keeps mapping to it.
    return actor.id === CLAUDE_AGENT_ACTOR.id ? "claude-agent" : "codex-agent";
  }
  return actor.id === currentUser.id ? "current-user" : undefined;
}

// Web mirror of shared/task-order.mjs providerForAssignee (CONTRACTS C1).
export function providerForAssignee(assignee: ActorIdentity | null | undefined): TaskRunProvider | null {
  if (assignee?.type !== "agent") return null;
  if (assignee.id === CODEX_AGENT_ACTOR.id) return "codex";
  if (assignee.id === CLAUDE_AGENT_ACTOR.id) return "claude";
  return null;
}

export function providerDisplayName(provider: TaskRunProvider): string {
  return provider === "claude" ? "Claude" : "Codex";
}
