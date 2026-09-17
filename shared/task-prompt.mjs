// v2 contract C5: task prompt sent to the agent when a run starts.
// Pure function; output is Taiwan Traditional Chinese and deterministic for a given input.

export const TASK_PROMPT_FINAL_INSTRUCTION = "完成後，請用繁體中文簡短說明你做了什麼、產出或修改了哪些檔案（含路徑）。";

// W3 smoke bug 2: the prompt is a direct work request. It must not say the work comes from a board,
// card or task tool (an installed board-management skill would take over); the identifier is only
// a reference label.
export const TASK_PROMPT_NO_TRACKER_INSTRUCTION = "不需要更新任何任務系統或看板狀態；完成後直接回覆結果即可。";

// NUL cannot be passed through process argv; CRLF/CR are normalized to LF.
function cleanText(value) {
  return String(value ?? "").replace(/\u0000/g, "").replace(/\r\n?/g, "\n");
}

function singleLine(value) {
  return cleanText(value).replace(/\s+/g, " ").trim();
}

function commentAuthorName(comment) {
  return singleLine(comment?.authorName ?? comment?.author?.name ?? comment?.actor?.name) || "（未知作者）";
}

function orderedComments(comments) {
  const list = Array.isArray(comments) ? comments.filter(Boolean) : [];
  // Stable sort: equal createdAt keeps the caller's order.
  return list
    .map((comment, index) => ({ comment, index }))
    .sort((left, right) => {
      const a = String(left.comment.createdAt ?? "");
      const b = String(right.comment.createdAt ?? "");
      if (a < b) return -1;
      if (a > b) return 1;
      return left.index - right.index;
    })
    .map(({ comment }) => comment);
}

function attachmentId(entry) {
  if (!entry || typeof entry !== "object") return "";
  return singleLine(entry.id);
}

// Accepts a path string or an object with `path` or `localPath` (and optional `filename`).
// Entries without a path are omitted: the prompt only lists files the agent can open.
// `seenIds` dedupes attachments by id across comments and task attachments (first occurrence wins).
function attachmentLines(attachments, seenIds) {
  const lines = [];
  for (const entry of Array.isArray(attachments) ? attachments : []) {
    const filePath = singleLine(typeof entry === "string" ? entry : (entry?.localPath ?? entry?.path));
    if (!filePath) continue;
    const id = attachmentId(entry);
    if (id) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }
    const filename = typeof entry === "string" ? "" : singleLine(entry?.filename);
    lines.push(filename ? `- ${filePath}（原始檔名：${filename}）` : `- ${filePath}`);
  }
  return lines;
}

/**
 * buildTaskPrompt({ task, comments, attachments }) → string
 * Includes identifier, title, description, all comments oldest→newest with author name and time,
 * each comment's own attachments (comments[i].attachments[j] = { id, filename, localPath }) listed under
 * that comment, task attachment file paths if any (deduped by id against comment attachments), then TASK_PROMPT_NO_TRACKER_INSTRUCTION, and ends with
 * TASK_PROMPT_FINAL_INSTRUCTION as the last line. No board/card/taskctl wording (W3 smoke bug 2).
 */
export function buildTaskPrompt({ task, comments = [], attachments = [] } = {}) {
  const identifier = singleLine(task?.identifier) || "（無編號）";
  const title = singleLine(task?.title) || "（無標題）";
  const description = cleanText(task?.description).trim();

  const lines = [
    "請幫我完成下面這件工作。",
    "",
    `工作名稱：${title}`,
    `參考編號：${identifier}（僅供對照）`,
    "",
    "## 工作內容",
    description || "（沒有補充內容）",
    "",
  ];

  const seenIds = new Set();
  const commentList = orderedComments(comments);
  lines.push(`## 補充訊息（由舊到新，共 ${commentList.length} 則）`);
  if (commentList.length === 0) {
    lines.push("（目前沒有補充訊息）");
  }
  commentList.forEach((comment, index) => {
    const time = singleLine(comment.createdAt) || "（時間不明）";
    lines.push(
      "",
      `### 訊息 ${index + 1}｜${commentAuthorName(comment)}｜${time}`,
      cleanText(comment.body).trim() || "（空白訊息）",
    );
    const commentFiles = attachmentLines(comment.attachments, seenIds);
    if (commentFiles.length > 0) {
      lines.push("", "此訊息的附件檔案：", ...commentFiles);
    }
  });
  lines.push("");

  const files = attachmentLines(attachments, seenIds);
  if (files.length > 0) {
    lines.push("## 附件檔案", ...files, "");
  }

  lines.push(TASK_PROMPT_NO_TRACKER_INSTRUCTION, TASK_PROMPT_FINAL_INSTRUCTION);
  return lines.join("\n");
}
