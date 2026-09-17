// Agent actors used by the v2 run service (CONTRACTS C1 / C4).
import { providerForAssignee } from "../../shared/task-order.mjs";

// CODEX_AGENT_ACTOR mirrors the constant in server/app.mjs; CLAUDE_AGENT_ACTOR is the v2 addition.

export const CODEX_AGENT_ACTOR = Object.freeze({
  type: "agent",
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
});

export const CLAUDE_AGENT_ACTOR = Object.freeze({
  type: "agent",
  id: "claude-agent",
  name: "Claude",
  avatarUrl: null,
});

// C1 `providerForAssignee` (shared/task-order.mjs) is the single source of the mapping:
// agent:codex-agent → "codex", agent:claude-agent → "claude", otherwise null.
export function providerForAgentActor(actor) {
  return providerForAssignee(actor);
}

export function agentActorForProvider(provider) {
  if (provider === "claude") return CLAUDE_AGENT_ACTOR;
  if (provider === "codex") return CODEX_AGENT_ACTOR;
  return null;
}
