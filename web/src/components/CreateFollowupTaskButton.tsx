import { useEffect, useState } from "react";
import { addTaskRelation, createTask } from "../api";
import { useTaskboardI18n } from "../i18n";
import { runErrorMessage } from "../runErrorText";
import { buildIssueUrl } from "../issueRoute";
import type { Task, TaskDraft, TaskRelationSummary } from "../types";
import "./TaskRunControls.css";

const TITLE_MAX_LENGTH = 240;
const TITLE_PREFIX = "檢查：";

export function buildFollowupTaskDraft(task: Task, baseUri: string): TaskDraft {
  const identifier = task.externalKey ?? task.identifier;
  const issueUrl = buildIssueUrl(baseUri, task.projectId, task.identifier).href;
  const resultText = task.latestRun?.resultText?.trim();
  const title = `${TITLE_PREFIX}${task.title}`;
  return {
    title: title.length > TITLE_MAX_LENGTH ? `${title.slice(0, TITLE_MAX_LENGTH - 1)}…` : title,
    description: [
      `原任務：[${identifier}](${issueUrl})（${task.title}）`,
      "",
      "原任務最後的 AI 結論：",
      "",
      resultText || "（原任務沒有 AI 結論）",
    ].join("\n"),
    status: "backlog",
    priority: "none",
    labels: [],
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
  };
}

function relationSummary(task: Task): TaskRelationSummary {
  return {
    id: task.id,
    identifier: task.identifier,
    externalKey: task.externalKey ?? null,
    projectId: task.projectId,
    title: task.title,
    status: task.status,
    priority: task.priority,
    assignee: task.assignee,
    archivedAt: task.archivedAt,
  };
}

interface CreateFollowupTaskButtonProps {
  task: Task;
  className?: string;
  onCreated?: (created: Task) => void;
  onOpenTask?: (task: TaskRelationSummary) => void;
}

export function CreateFollowupTaskButton({
  task,
  className = "detail-copy-action",
  onCreated,
  onOpenTask,
}: CreateFollowupTaskButtonProps) {
  const { text } = useTaskboardI18n();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCreated(null);
    setError(null);
  }, [task.id]);

  async function create() {
    if (creating) return;
    setCreating(true);
    setError(null);
    setCreated(null);
    let nextTask: Task | null = null;
    try {
      nextTask = await createTask(task.projectId, buildFollowupTaskDraft(task, document.baseURI));
      const related = await addTaskRelation(nextTask, "related", task.id);
      nextTask = related.task;
      setCreated(nextTask);
      onCreated?.(nextTask);
    } catch (createError) {
      const message = runErrorMessage(createError, text, text("操作未完成，請重試。", "The action could not be completed. Try again."));
      if (nextTask) {
        setCreated(nextTask);
        onCreated?.(nextTask);
        setError(text(
          `已建立 ${nextTask.identifier}，但沒能加上關聯：${message}`,
          `Created ${nextTask.identifier}, but could not link it: ${message}`,
        ));
      } else {
        setError(message);
      }
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="create-followup-task">
      <button
        className={className}
        type="button"
        disabled={creating}
        title={text(
          "建立一張「待立項」的新任務，帶上這張卡的連結與最後的 AI 結論",
          "Create a backlog task that links to this card and includes its latest AI result",
        )}
        onClick={() => void create()}
      >
        <span className="detail-copy-action-label">
          {creating
            ? text("建立中…", "Creating…")
            : text("以這張卡建立新任務", "Create follow-up task")}
        </span>
      </button>
      {created && !error && (
        <p className="create-followup-task-status" role="status">
          <span>{text(`已建立 ${created.identifier}`, `Created ${created.identifier}`)}</span>
          {onOpenTask && (
            <button type="button" onClick={() => onOpenTask(relationSummary(created))}>
              {text("開啟", "Open")}
            </button>
          )}
        </p>
      )}
      {error && <p className="task-run-error" role="alert">{error}</p>}
    </div>
  );
}
