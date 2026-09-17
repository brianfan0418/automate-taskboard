import assert from "node:assert/strict";
import { test } from "node:test";

import { TASK_PROMPT_FINAL_INSTRUCTION, TASK_PROMPT_NO_TRACKER_INSTRUCTION, buildTaskPrompt } from "../shared/task-prompt.mjs";

const FINAL_LINE = "完成後，請用繁體中文簡短說明你做了什麼、產出或修改了哪些檔案（含路徑）。";

const baseTask = {
  id: "task-1",
  identifier: "RELAY-42",
  title: "整理 CSV 匯入流程",
  description: "把 data/input.csv 讀進來，\n輸出到 out/report.md。",
  status: "in_progress",
};

function comment(id, overrides = {}) {
  return {
    id,
    taskId: "task-1",
    body: `訊息 ${id}`,
    authorType: "user",
    authorId: "local-user",
    authorName: "Alice",
    createdAt: "2026-09-17T01:00:00.000Z",
    ...overrides,
  };
}

test("final instruction constant matches contract C5", () => {
  assert.equal(TASK_PROMPT_FINAL_INSTRUCTION, FINAL_LINE);
});

test("prompt includes identifier, title, description and ends with the instruction line", () => {
  const prompt = buildTaskPrompt({ task: baseTask, comments: [], attachments: [] });
  assert.match(prompt, /參考編號：RELAY-42（僅供對照）/);
  assert.match(prompt, /工作名稱：整理 CSV 匯入流程/);
  assert.ok(prompt.includes("把 data/input.csv 讀進來，\n輸出到 out/report.md。"));
  assert.match(prompt, /（目前沒有補充訊息）/);
  assert.doesNotMatch(prompt, /附件檔案/);
  const lines = prompt.split("\n");
  assert.equal(lines.at(-1), FINAL_LINE);
  assert.ok(prompt.endsWith(FINAL_LINE));
});

test("comments appear oldest to newest with author name and time", () => {
  const comments = [
    comment("c3", { body: "第三則：改用 UTF-8", authorName: "Claude", authorType: "agent", createdAt: "2026-09-17T03:00:00.000Z" }),
    comment("c1", { body: "第一則：先看需求", createdAt: "2026-09-17T01:00:00.000Z" }),
    comment("c2", { body: "第二則：\n補充兩行\n內容", authorName: "Codex", createdAt: "2026-09-17T02:00:00.000Z" }),
  ];
  const input = [...comments];
  const prompt = buildTaskPrompt({ task: baseTask, comments, attachments: [] });

  const first = prompt.indexOf("第一則：先看需求");
  const second = prompt.indexOf("第二則：\n補充兩行\n內容");
  const third = prompt.indexOf("第三則：改用 UTF-8");
  assert.ok(first > 0 && second > first && third > second, "comments must be ordered by createdAt");

  assert.match(prompt, /共 3 則/);
  assert.match(prompt, /### 訊息 1｜Alice｜2026-09-17T01:00:00\.000Z\n第一則：先看需求/);
  assert.match(prompt, /### 訊息 2｜Codex｜2026-09-17T02:00:00\.000Z\n第二則：/);
  assert.match(prompt, /### 訊息 3｜Claude｜2026-09-17T03:00:00\.000Z\n第三則：改用 UTF-8/);
  assert.ok(third < prompt.indexOf(FINAL_LINE));
  assert.equal(prompt.split("\n").at(-1), FINAL_LINE);
  assert.deepEqual(comments, input, "input array must not be reordered");
});

test("comments with equal createdAt keep the given order", () => {
  const prompt = buildTaskPrompt({
    task: baseTask,
    comments: [comment("x", { body: "甲" }), comment("y", { body: "乙" })],
  });
  assert.ok(prompt.indexOf("### 訊息 1｜Alice｜2026-09-17T01:00:00.000Z\n甲") > 0);
  assert.ok(prompt.indexOf("### 訊息 2｜Alice｜2026-09-17T01:00:00.000Z\n乙") > 0);
});

test("attachment file paths are listed when present", () => {
  const prompt = buildTaskPrompt({
    task: baseTask,
    comments: [comment("c1")],
    attachments: [
      { id: "a1", path: "C:\\data\\attachments\\a1", filename: "spec.pdf" },
      "D:\\shared\\報表.xlsx",
      { id: "a2", filename: "no-path.png" },
    ],
  });
  assert.match(prompt, /## 附件檔案\n- C:\\data\\attachments\\a1（原始檔名：spec\.pdf）\n- D:\\shared\\報表\.xlsx\n/);
  assert.doesNotMatch(prompt, /no-path\.png/);
  assert.ok(prompt.indexOf("## 附件檔案") > prompt.indexOf("訊息 c1"));
  assert.equal(prompt.split("\n").at(-1), FINAL_LINE);
});

test("missing fields get Traditional Chinese placeholders; CRLF and NUL are normalized", () => {
  const prompt = buildTaskPrompt({
    task: { id: "t", identifier: "", title: "  ", description: null },
    comments: [comment("c1", { body: "第一行\r\n第二行\u0000", authorName: null, createdAt: null })],
  });
  assert.match(prompt, /參考編號：（無編號）/);
  assert.match(prompt, /工作名稱：（無標題）/);
  assert.match(prompt, /## 工作內容\n（沒有補充內容）/);
  assert.match(prompt, /### 訊息 1｜（未知作者）｜（時間不明）\n第一行\n第二行\n/);
  assert.doesNotMatch(prompt, /\r|\u0000/);
  assert.equal(prompt.split("\n").at(-1), FINAL_LINE);
});

test("buildTaskPrompt is deterministic", () => {
  const input = { task: baseTask, comments: [comment("c1"), comment("c2")], attachments: ["C:\\x"] };
  assert.equal(buildTaskPrompt(input), buildTaskPrompt(input));
});

test("W3 bug 2: prompt is a direct work request without board, card or taskctl wording", () => {
  assert.equal(TASK_PROMPT_NO_TRACKER_INSTRUCTION, "不需要更新任何任務系統或看板狀態；完成後直接回覆結果即可。");
  const prompt = buildTaskPrompt({
    task: baseTask,
    comments: [comment("c1", { body: "請順便檢查格式" })],
    attachments: ["C:\\x\\a.txt"],
  });
  const lines = prompt.split("\n");
  assert.equal(lines.at(-1), FINAL_LINE);
  assert.equal(lines.at(-2), TASK_PROMPT_NO_TRACKER_INSTRUCTION);
  assert.ok(lines[0].startsWith("請幫我完成"));
  // Everything before the explicit "no tracker" line avoids board / card / task-tool wording.
  const body = lines.slice(0, -2).join("\n");
  for (const word of ["看板", "任務卡", "卡片", "taskctl", "taskboard", "Taskboard", "board"]) {
    assert.ok(!body.includes(word), `prompt must not mention ${word}`);
  }
  assert.ok(!prompt.includes("taskctl"));
});

test("DBG-09: comment attachments are listed under their comment with filename and local path", () => {
  const prompt = buildTaskPrompt({
    task: baseTask,
    comments: [
      comment("c2", {
        body: "第二則：參考這張圖",
        createdAt: "2026-09-17T02:00:00.000Z",
        attachments: [
          { id: "ca2", filename: "diagram.png", localPath: "C:\\data\\attachments\\ca2" },
        ],
      }),
      comment("c1", {
        body: "第一則：需求檔在附件",
        attachments: [
          { id: "ca1", filename: "需求.docx", localPath: "C:\\data\\attachments\\ca1" },
          { id: "ca-missing", filename: "no-local.png" },
        ],
      }),
    ],
    attachments: [{ id: "ta1", path: "C:\\data\\attachments\\ta1", filename: "spec.pdf" }],
  });
  assert.match(prompt, /第一則：需求檔在附件\n\n此訊息的附件檔案：\n- C:\\data\\attachments\\ca1（原始檔名：需求\.docx）\n/);
  assert.match(prompt, /第二則：參考這張圖\n\n此訊息的附件檔案：\n- C:\\data\\attachments\\ca2（原始檔名：diagram\.png）\n/);
  assert.doesNotMatch(prompt, /no-local\.png/);
  assert.ok(prompt.indexOf("ca1") < prompt.indexOf("### 訊息 2"), "comment 1 attachment stays under comment 1");
  assert.match(prompt, /## 附件檔案\n- C:\\data\\attachments\\ta1（原始檔名：spec\.pdf）\n/);
  assert.equal(prompt.split("\n").at(-1), FINAL_LINE);
});

test("DBG-09: attachments are deduped by id across comments and task attachments", () => {
  const shared = { id: "dup", filename: "same.txt", localPath: "C:\\data\\attachments\\dup" };
  const prompt = buildTaskPrompt({
    task: baseTask,
    comments: [
      comment("c1", { attachments: [shared, shared] }),
      comment("c2", { createdAt: "2026-09-17T02:00:00.000Z", attachments: [shared] }),
    ],
    attachments: [
      { id: "dup", path: "C:\\data\\attachments\\dup", filename: "same.txt" },
      { id: "t1", path: "C:\\data\\attachments\\t1", filename: "t1.txt" },
      { id: "t1", path: "C:\\data\\attachments\\t1", filename: "t1.txt" },
    ],
  });
  assert.equal(prompt.split("C:\\data\\attachments\\dup").length - 1, 1);
  assert.equal(prompt.split("C:\\data\\attachments\\t1").length - 1, 1);
  assert.equal(prompt.split("此訊息的附件檔案：").length - 1, 1, "second comment has no new attachment block");
  assert.match(prompt, /## 附件檔案\n- C:\\data\\attachments\\t1（原始檔名：t1\.txt）\n/);
});
