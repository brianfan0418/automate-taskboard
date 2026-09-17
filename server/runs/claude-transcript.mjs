import path from "node:path";

// Reads Claude Code session transcripts (`<configDir>/projects/<slug>/<sessionId>.jsonl`).
// Only the fields needed for turn detection are interpreted; nothing here logs transcript content.

const TERMINAL_STOP_REASONS = new Set(["end_turn", "stop_sequence", "max_tokens", "refusal"]);
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

export function claudeConfigDirectory({ env = process.env, homedir }) {
  const configured = typeof env?.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR.trim() : "";
  return configured || path.join(homedir, ".claude");
}

export function projectSlugForCwd(cwd) {
  return String(cwd ?? "").replace(/[^a-zA-Z0-9]/g, "-");
}

export async function findTranscriptPath({ fs, configDir, cwd, sessionId }) {
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) return null;
  const projectsDir = path.join(configDir, "projects");
  const fileName = `${sessionId}.jsonl`;
  if (cwd) {
    const direct = path.join(projectsDir, projectSlugForCwd(cwd), fileName);
    if (await isFile(fs, direct)) return direct;
  }
  let directories = [];
  try {
    directories = await fs.readdir(projectsDir);
  } catch {
    return null;
  }
  for (const directory of directories) {
    const candidate = path.join(projectsDir, String(directory), fileName);
    if (await isFile(fs, candidate)) return candidate;
  }
  return null;
}

export function parseTranscriptLines(text) {
  const entries = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object") entries.push(value);
    } catch {
      // A partially written last line is expected while the session is writing.
    }
  }
  return entries;
}

export function normalizeMessageText(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").trim();
}

// Text of a human prompt entry, or null. Covers prompts recorded as `user` lines and prompts typed while a
// turn was running, which Claude Code records as `attachment` lines of type `queued_command`.
export function humanPromptText(entry) {
  if (!entry || typeof entry !== "object" || entry.isSidechain === true || entry.isMeta === true) return null;
  if (entry.type === "user") {
    if (entry.origin && typeof entry.origin === "object" && entry.origin.kind !== "human") return null;
    const content = entry.message?.content;
    let text = null;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      if (content.some((block) => block?.type === "tool_result")) return null;
      const parts = content.filter((block) => block?.type === "text" && typeof block.text === "string");
      if (parts.length === 0) return null;
      text = parts.map((block) => block.text).join("\n");
    }
    if (text === null) return null;
    if (text.startsWith("[Request interrupted by user")) return null;
    return text;
  }
  if (entry.type === "attachment") {
    const attachment = entry.attachment;
    if (!attachment || attachment.type !== "queued_command") return null;
    if ((attachment.commandMode ?? "prompt") !== "prompt") return null;
    if (attachment.origin && typeof attachment.origin === "object" && attachment.origin.kind !== "human") return null;
    if (typeof attachment.prompt === "string") return attachment.prompt;
    if (Array.isArray(attachment.prompt)) {
      const parts = attachment.prompt.filter((block) => block?.type === "text" && typeof block.text === "string");
      return parts.length ? parts.map((block) => block.text).join("\n") : null;
    }
  }
  return null;
}

function blocksText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.filter((block) => block?.type === "text" && typeof block.text === "string");
    return parts.length ? parts.map((block) => block.text).join("\n") : null;
  }
  return null;
}

// W4 retest bug B: a prompt typed while a tool call is running is first recorded only as
// `{"type":"queue-operation","operation":"enqueue","content":"<text>"}`; the `queued_command` attachment is
// written when the turn absorbs it (possibly minutes later). The enqueue line proves Claude Code received it.
export function queuedPromptText(entry) {
  if (!entry || typeof entry !== "object" || entry.type !== "queue-operation" || entry.operation !== "enqueue") return null;
  return blocksText(entry.content);
}

function entryTime(entry) {
  const value = typeof entry?.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  if (!Number.isNaN(value)) return value;
  const inner = typeof entry?.attachment?.timestamp === "string" ? Date.parse(entry.attachment.timestamp) : Number.NaN;
  return Number.isNaN(inner) ? null : inner;
}

function isToolResultEntry(entry) {
  return entry?.type === "user"
    && entry.isSidechain !== true
    && Array.isArray(entry.message?.content)
    && entry.message.content.some((block) => block?.type === "tool_result");
}

function isAssistantEntry(entry) {
  return entry?.type === "assistant" && entry.isSidechain !== true && entry.message && typeof entry.message === "object";
}

function assistantText(entry) {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

// Summarises the latest turn: the turn starts at the last human prompt.
//  - turnComplete: a `system/turn_duration` line follows the prompt, or the last assistant line after the prompt
//    (and after the last tool result) carries a terminal stop_reason.
//  - resultText: assistant text written after the last tool result of the turn (falls back to the last
//    text-bearing assistant line of the turn), trimmed; empty string when there is none.
export function analyzeTranscript(entries) {
  const humanMessages = [];
  const queuedPrompts = [];
  entries.forEach((entry, index) => {
    const text = humanPromptText(entry);
    if (text !== null) {
      humanMessages.push({ index, text, at: entryTime(entry), source: entry.type === "attachment" ? "queued-command" : "user-message" });
      return;
    }
    const queued = queuedPromptText(entry);
    if (queued !== null) queuedPrompts.push({ index, text: queued, at: entryTime(entry), source: "queue-enqueue" });
  });
  const lastHumanIndex = humanMessages.length ? humanMessages[humanMessages.length - 1].index : -1;
  if (lastHumanIndex < 0) {
    return { humanMessages, queuedPrompts, lastHumanIndex, assistantAfterLastHuman: false, turnComplete: false, resultText: "" };
  }
  let lastAssistantIndex = -1;
  let lastToolResultIndex = -1;
  let turnDurationSeen = false;
  for (let index = lastHumanIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (isAssistantEntry(entry)) lastAssistantIndex = index;
    else if (isToolResultEntry(entry)) lastToolResultIndex = index;
    else if (entry?.type === "system" && entry.subtype === "turn_duration") turnDurationSeen = true;
  }
  const terminalStop = lastAssistantIndex > lastToolResultIndex
    && TERMINAL_STOP_REASONS.has(entries[lastAssistantIndex].message?.stop_reason);

  const collect = (fromIndex) => {
    const texts = [];
    for (let index = fromIndex + 1; index < entries.length; index += 1) {
      if (!isAssistantEntry(entries[index])) continue;
      const text = assistantText(entries[index]);
      if (text.trim()) texts.push(text);
    }
    return texts;
  };
  let texts = collect(Math.max(lastHumanIndex, lastToolResultIndex));
  if (texts.length === 0) {
    const all = collect(lastHumanIndex);
    texts = all.length ? [all[all.length - 1]] : [];
  }
  return {
    humanMessages,
    queuedPrompts,
    lastHumanIndex,
    assistantAfterLastHuman: lastAssistantIndex > lastHumanIndex,
    turnComplete: turnDurationSeen || terminalStop,
    resultText: texts.join("\n").trim(),
  };
}

/** Counts used as the "before typing" baseline for findNewHumanMessage. */
export function deliveryBaseline(analysis) {
  return { human: analysis?.humanMessages?.length ?? 0, queued: analysis?.queuedPrompts?.length ?? 0 };
}

// A message typed after the baseline counts as delivered when it shows up as a human prompt (user line or
// queued_command attachment) or as a queue-operation enqueue (bug B). `baseline` may be a plain number
// (human prompts only; enqueue lines are then all considered).
export function findNewHumanMessage(analysis, baseline, expectedText) {
  const expected = normalizeMessageText(expectedText);
  if (!expected) return null;
  const humanBase = typeof baseline === "number" ? baseline : baseline?.human ?? 0;
  const queuedBase = typeof baseline === "number" ? Number.POSITIVE_INFINITY : baseline?.queued ?? 0;
  const matches = (message) => normalizeMessageText(message.text) === expected;
  const human = (analysis.humanMessages ?? []).slice(Math.max(0, humanBase)).find(matches);
  if (human) return human;
  if (queuedBase === Number.POSITIVE_INFINITY) return null;
  return (analysis.queuedPrompts ?? []).slice(Math.max(0, queuedBase)).find(matches) ?? null;
}

// Bug B safety net: the same text already reached the session at or after `sinceMs` (any prompt shape).
export function findMessageSince(analysis, sinceMs, expectedText, toleranceMs = 2_000) {
  const expected = normalizeMessageText(expectedText);
  if (!expected || !Number.isFinite(sinceMs)) return null;
  const all = [...(analysis.humanMessages ?? []), ...(analysis.queuedPrompts ?? [])];
  return all.find((message) => message.at !== null && message.at !== undefined
    && message.at >= sinceMs - toleranceMs && normalizeMessageText(message.text) === expected) ?? null;
}

export async function readTranscriptAnalysis({ fs, transcriptPath }) {
  if (!transcriptPath) return analyzeTranscript([]);
  try {
    const text = await fs.readFile(transcriptPath, "utf8");
    return analyzeTranscript(parseTranscriptLines(text));
  } catch {
    return analyzeTranscript([]);
  }
}

async function isFile(fs, filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}
