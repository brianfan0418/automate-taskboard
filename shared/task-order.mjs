// v2 contract C5: display/claim order, provider mapping,
// dependency blocking. Pure functions; no I/O, no clock, no locale collation.

export const PRIORITY_RANK = Object.freeze({ urgent: 0, high: 1, medium: 2, low: 3, none: 4 });

const AGENT_PROVIDERS = Object.freeze({ "codex-agent": "codex", "claude-agent": "claude" });

function compareValues(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

// Unknown or missing priority sorts with "none" (last).
function priorityRank(task) {
  return Object.hasOwn(PRIORITY_RANK, task?.priority) ? PRIORITY_RANK[task.priority] : PRIORITY_RANK.none;
}

function compareText(left, right) {
  return compareValues(String(left ?? ""), String(right ?? ""));
}

/** priority rank asc → dueDate (non-null first, earlier first) → createdAt asc → id */
export function compareSuggested(a, b) {
  const byPriority = priorityRank(a) - priorityRank(b);
  if (byPriority !== 0) return byPriority;

  const aHasDue = hasValue(a?.dueDate);
  const bHasDue = hasValue(b?.dueDate);
  if (aHasDue !== bHasDue) return aHasDue ? -1 : 1;
  if (aHasDue) {
    const byDue = compareText(a.dueDate, b.dueDate);
    if (byDue !== 0) return byDue;
  }

  return compareText(a?.createdAt, b?.createdAt) || compareText(a?.id, b?.id);
}

// sortOrder asc (non-finite values last) → createdAt asc → id
function compareManual(a, b) {
  const aOrder = Number.isFinite(a?.sortOrder) ? a.sortOrder : null;
  const bOrder = Number.isFinite(b?.sortOrder) ? b.sortOrder : null;
  if (aOrder !== bOrder) {
    if (aOrder === null) return 1;
    if (bOrder === null) return -1;
    return aOrder - bOrder;
  }
  return compareText(a?.createdAt, b?.createdAt) || compareText(a?.id, b?.id);
}

/**
 * Returns a new sorted array (input is not mutated).
 * orderMode "manual" → sortOrder; anything else → suggested (the DB default).
 */
export function orderTasks(tasks, orderMode) {
  const list = Array.isArray(tasks) ? [...tasks] : [];
  return list.sort(orderMode === "manual" ? compareManual : compareSuggested);
}

/** agent:codex-agent → "codex", agent:claude-agent → "claude", otherwise null (C1). */
export function providerForAssignee(assignee) {
  if (!assignee || assignee.type !== "agent") return null;
  return Object.hasOwn(AGENT_PROVIDERS, assignee.id) ? AGENT_PROVIDERS[assignee.id] : null;
}

/** true when task.relations.blockedBy has any entry whose status is not "done"; missing relations → false. */
export function isBlockedByOpenDependency(task) {
  const blockedBy = task?.relations?.blockedBy;
  if (!Array.isArray(blockedBy)) return false;
  return blockedBy.some((entry) => entry?.status !== "done");
}
