// W15 follow-up: 「資料夾」 field for 建立專案 and 設定專案資料夾.
// On this PC a 「選擇資料夾…」 button asks the board service to open the native folder dialog;
// the path can also be typed or pasted. Phones never see the button.
import { useId, useState } from "react";
import { pickFolder } from "../api";
import { useTaskboardI18n } from "../i18n";
import { runErrorMessage } from "../runErrorText";

export interface ProjectFolderFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Native picker is available (board opened on this PC). */
  canPick: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Called with the folder name when a folder is picked (e.g. to fill an empty project name). */
  onPicked?: (path: string) => void;
  onError?: (message: string | null) => void;
}

export function folderDisplayName(folderPath: string): string {
  return folderPath.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

export function ProjectFolderField({ value, onChange, canPick, disabled, autoFocus, onPicked, onError }: ProjectFolderFieldProps) {
  const { text } = useTaskboardI18n();
  const inputId = useId();
  const hintId = useId();
  const [picking, setPicking] = useState(false);

  async function choose() {
    if (picking) return;
    setPicking(true);
    onError?.(null);
    try {
      const result = await pickFolder({
        title: text("选择项目文件夹", "Choose the project folder", "選擇專案資料夾"),
        initialPath: value.trim() || null,
      });
      if (result.path) {
        onChange(result.path);
        onPicked?.(result.path);
      }
    } catch (error) {
      onError?.(runErrorMessage(
        error,
        text,
        text("无法打开选择文件夹窗口，请直接输入路径。", "Could not open the folder window. Type the path instead.", "無法開啟選擇資料夾視窗，請直接輸入路徑。"),
      ));
    } finally {
      setPicking(false);
    }
  }

  return (
    <div className="project-folder-field">
      <label htmlFor={inputId}>{text("文件夹", "Folder", "資料夾")}</label>
      <div className="project-folder-row">
        <input
          id={inputId}
          autoFocus={autoFocus}
          required
          maxLength={4096}
          spellCheck={false}
          aria-describedby={hintId}
          placeholder={text("例如 C:\\Users\\你\\Documents\\项目", "e.g. C:\\Users\\you\\Documents\\project", "例如 C:\\Users\\你\\Documents\\專案")}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        {canPick && (
          <button
            className="button secondary project-folder-pick"
            type="button"
            disabled={disabled || picking}
            onClick={() => void choose()}
          >
            {picking
              ? text("请在弹出的窗口中选择…", "Choose in the window…", "請在跳出的視窗中選擇…")
              : text("选择文件夹…", "Choose folder…", "選擇資料夾…")}
          </button>
        )}
      </div>
      <p id={hintId} className="project-folder-hint">
        {text(
          "AI 会在这个文件夹里工作。",
          "The AI works inside this folder.",
          "AI 會在這個資料夾裡工作。",
        )}
      </p>
    </div>
  );
}
