import { CLAUDE_AGENT_ACTOR } from "../actors";
import type { ActorIdentity } from "../types";
import "./ActorAvatar.css";

/**
 * Inline mark for the Claude agent (v2 assignee `claude-agent`). A plain starburst, so no image
 * asset is needed; the Codex agent keeps the upstream `codex-agent-logo.png`.
 * Exported as markup for views that render HTML strings (GanttView bar templates).
 */
export const CLAUDE_AGENT_MARK_SVG = '<svg class="actor-claude-mark" viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
  + '<circle cx="8" cy="8" r="8" fill="#d97757"/>'
  + '<path d="M8 3.2v9.6M3.2 8h9.6M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>'
  + "</svg>";

export function isClaudeAgentActor(actor: Pick<ActorIdentity, "type" | "id"> | null | undefined): boolean {
  return actor?.type === "agent" && actor.id === CLAUDE_AGENT_ACTOR.id;
}

export function ActorAvatar({
  actor,
  className = "",
}: {
  actor: ActorIdentity;
  className?: string;
}) {
  const claude = isClaudeAgentActor(actor);
  return (
    <span
      className={`actor-avatar actor-avatar-${actor.type}${claude ? " actor-avatar-claude" : ""}${className ? ` ${className}` : ""}`}
      aria-hidden="true"
      title={actor.name}
    >
      {claude ? (
        <span
          className="actor-avatar-image actor-avatar-agent-image"
          dangerouslySetInnerHTML={{ __html: CLAUDE_AGENT_MARK_SVG }}
        />
      ) : actor.type === "agent" ? (
        <img
          className="actor-avatar-image actor-avatar-agent-image"
          src="codex-agent-logo.png"
          alt=""
        />
      ) : actor.avatarUrl ? (
        <img
          className="actor-avatar-image"
          src={actor.avatarUrl}
          alt=""
          referrerPolicy="no-referrer"
        />
      ) : actor.name.slice(0, 1)}
    </span>
  );
}
