// W15: a short first-use guide shown on an empty board or dashboard (no tasks in view).
// ① 建立專案（選資料夾） ② 新增任務 ③ 指派給 Claude 或 Codex 開始做. Dismissible; the parent hides it once tasks exist.
import { useTaskboardI18n } from "../i18n";
import { LinearIcon } from "./LinearIcon";
import "./StartGuide.css";

export const START_GUIDE_DISMISSED_KEY = "taskboard.start-guide-dismissed.v1";

export interface StartGuideProps {
  hasProject: boolean;
  hasTasks: boolean;
  /** Omitted where a project folder cannot be chosen (phone, embedded panel): step ① is text only. */
  onCreateProject?: () => void;
  onNewTask: () => void;
  onDismiss: () => void;
}

export function StartGuide({ hasProject, hasTasks, onCreateProject, onNewTask, onDismiss }: StartGuideProps) {
  const { text } = useTaskboardI18n();
  const steps: Array<{
    key: string;
    title: string;
    detail: string;
    done: boolean;
    action?: { label: string; onClick: () => void };
  }> = [
    {
      key: "project",
      title: text("创建项目（选择文件夹）", "Create a project (pick a folder)", "建立專案（選資料夾）"),
      detail: onCreateProject
        ? text(
          "选一个文件夹，AI 会在里面工作。",
          "Pick a folder; the AI works inside it.",
          "選一個資料夾，AI 會在裡面工作。",
        )
        : text(
          "请在电脑上的 AutoMate Taskboard 窗口建立项目并选择文件夹。",
          "Create the project and pick its folder in AutoMate Taskboard on the computer.",
          "請在電腦上的 AutoMate Taskboard 視窗建立專案並選資料夾。",
        ),
      done: hasProject,
      action: hasProject || !onCreateProject
        ? undefined
        : { label: text("创建项目", "Create project", "建立專案"), onClick: onCreateProject },
    },
    {
      key: "task",
      title: text("新建任务", "Add a task", "新增任務"),
      detail: text("写下要做的事。", "Write down what needs doing.", "寫下要做的事。"),
      done: hasTasks,
      action: hasTasks
        ? undefined
        : { label: text("新建任务", "New task", "新增任務"), onClick: onNewTask },
    },
    {
      key: "assign",
      title: text("指派给 Claude 或 Codex 开始做", "Assign it to Claude or Codex to start", "指派給 Claude 或 Codex 開始做"),
      detail: text(
        "打开任务，把负责人选成 Claude 或 Codex，再按「开工」。",
        "Open the task, set the assignee to Claude or Codex, then press Start.",
        "打開任務，把負責人選成 Claude 或 Codex，再按「開工」。",
      ),
      done: false,
    },
  ];

  return (
    <section className="start-guide" aria-labelledby="start-guide-title">
      <div className="start-guide-header">
        <h2 id="start-guide-title">{text("三步开始", "Get started in 3 steps", "三步開始")}</h2>
        <button
          className="icon-button start-guide-dismiss"
          type="button"
          aria-label={text("关闭入门指引", "Close the getting started guide", "關閉入門指引")}
          title={text("关闭", "Close", "關閉")}
          onClick={onDismiss}
        >
          <LinearIcon name="close" />
        </button>
      </div>
      <ol className="start-guide-steps">
        {steps.map((step, index) => (
          <li key={step.key} className={`start-guide-step${step.done ? " is-done" : ""}`} data-step={step.key}>
            <span className="start-guide-marker" aria-hidden="true">
              {step.done ? <LinearIcon name="check" /> : index + 1}
            </span>
            <div className="start-guide-body">
              <strong>
                {step.title}
                {step.done && <span className="start-guide-done-label">{text("（已完成）", " (done)", "（已完成）")}</span>}
              </strong>
              <span>{step.detail}</span>
            </div>
            {step.action && (
              <button
                className={`button ${index === steps.findIndex((candidate) => !candidate.done) ? "primary" : "secondary"}`}
                type="button"
                onClick={step.action.onClick}
              >
                {step.action.label}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
