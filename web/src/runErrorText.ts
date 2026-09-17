import { ApiError } from "./api";

/**
 * Traditional Chinese (first) and English text for the v2 run/automation/mobile API error codes.
 * Server messages for these codes are English developer text, so the UI shows these instead.
 */
export const RUN_ERROR_TEXT: Record<string, readonly [string, string]> = {
  AGENT_CANNOT_COMPLETE: ["AI 不能把卡片標成完成，請由你確認後再完成。", "An AI agent cannot mark a card done; you confirm it."],
  ASSIGNEE_NOT_AGENT: ["負責人不是 Codex 或 Claude，無法開工。", "The assignee is not Codex or Claude, so the card cannot start."],
  PROVIDER_UNAVAILABLE: ["這個 AI 目前無法使用（找不到程式或版本太舊）。", "This AI is not available right now (missing or too old)."],
  RUN_ALREADY_ACTIVE: ["這張卡已經在處理中。", "This card is already being worked on."],
  RUN_NOT_ACTIVE: ["這張卡目前沒有在處理中。", "This card has no active AI run."],
  RUN_STOP_FAILED: ["停止失敗，卡片沒有移動。AI 目前的步驟可能仍在進行。", "Could not stop the AI run; the card did not move. The current step may still be running."],
  TASK_NOT_TODO: ["只有「等待認領」的卡片可以開工。", "Only To do cards can be started."],
  TASK_NOT_CONTINUABLE: ["只有「等你確認」或「卡住」的卡片可以繼續。", "Only In review or Blocked cards can be continued."],
  CONTINUE_MESSAGE_REQUIRED: ["要讓 AI 接著處理這張卡，請在詳情頁輸入訊息後按「繼續」，不能直接移到處理中。", "To move this card back to In progress, send the AI a message with Continue on the details page."],
  REWORK_REQUIRED: ["上一次沒有成功開工，請改用「退回重做」", "The last run never started. Send the card back for rework instead."],
  NO_PREVIOUS_RUN: ["這張卡還沒有 AI 對話可以繼續，請改用「開工」。", "This card has no previous AI conversation to continue; start it instead."],
  TASK_ARCHIVED: ["這張卡已封存，不能操作。", "This card is archived."],
  INVALID_BODY: ["請先輸入訊息內容。", "Enter a message first."],
  LOCAL_AI_LOOPBACK_REQUIRED: ["只能在這台電腦或已配對的手機上操作 AI。", "AI runs can only be controlled from this computer or a paired phone."],
  AUTO_CLAIM_WRITE_REQUIRES_LOCAL: ["這張卡已排入 AI 自動處理；只能在這台電腦或已配對的手機上建立或修改", "This card is queued for AI auto-claim; create or change it only from this computer or a paired phone."],
  LOCAL_COMPANION_REQUIRED: ["請在這台電腦上的看板操作 AI。", "Control AI runs from the Taskboard on this computer."],
  MOBILE_ACCESS_UNAVAILABLE: ["手機存取目前無法使用。", "Mobile access is not available right now."],
  PAIRING_REQUIRED: ["這支裝置尚未配對。請在電腦上開啟「手機存取」產生配對碼後再試。", "This device is not paired. Create a pairing code in Mobile access on the PC, then try again."],
};

/** Prefix of the server's WORKSPACE_NOT_FOUND message (W3 smoke bug 4); the folder path follows. */
export const WORKSPACE_NOT_FOUND_PREFIX = "專案資料夾不存在：";

/** Known v2 error code → [Traditional Chinese, English]; null for anything else. */
export function runErrorTextPair(error: unknown): readonly [string, string] | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === "WORKSPACE_NOT_FOUND") {
    // The server message already is Traditional Chinese and carries the missing path.
    if (error.message.startsWith(WORKSPACE_NOT_FOUND_PREFIX)) {
      const folder = error.message.slice(WORKSPACE_NOT_FOUND_PREFIX.length);
      return [error.message, `Project folder does not exist: ${folder}`];
    }
    return [
      error.message || "專案沒有設定資料夾，AI 無法開工",
      "The project has no folder, so the AI cannot start.",
    ];
  }
  // W15: project folder / folder picker errors — the server message is Traditional Chinese.
  const folderEnglish: Record<string, string> = {
    WORKSPACE_REQUIRED: "Choose the project folder.",
    WORKSPACE_NOT_ABSOLUTE: "Enter the full folder path (for example C:\\Users\\you\\Documents\\project).",
    WORKSPACE_FOLDER_MISSING: "That folder does not exist.",
    PROJECT_FOLDER_NOT_ALLOWED: "This project cannot have a folder.",
    FOLDER_PICKER_BUSY: "The folder window is already open. Choose a folder or cancel it first.",
    FOLDER_PICKER_FAILED: "Could not open the folder window. Type or paste the folder path instead.",
    FOLDER_PICKER_UNSUPPORTED: "This computer cannot open the folder window. Type or paste the folder path instead.",
  };
  if (folderEnglish[error.code]) return [error.message, folderEnglish[error.code]];
  return RUN_ERROR_TEXT[error.code] ?? null;
}

/** Message for a failed v2 request: mapped text for known codes, else the error message, else the fallback. */
export function runErrorMessage(
  error: unknown,
  text: (chinese: string, english: string, taiwanese?: string) => string,
  fallback: string,
): string {
  const known = runErrorTextPair(error);
  if (known) return text(known[0], known[1]);
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
