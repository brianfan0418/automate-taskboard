import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { sendTaskFollowup } from "../api";
import { providerDisplayName } from "../actors";
import { useTaskboardI18n } from "../i18n";
import { runErrorMessage } from "../runErrorText";
import type { Task, TaskFollowup, TaskFollowupMode, TaskRun } from "../types";
import { followupDeliveryState, subscribeTaskRunEvents } from "./TaskRunPanel";
import "./TaskRunControls.css";

export const STEER_CONFIRMATION_TEXT = "插嘴會打斷 AI 目前的動作；正在進行的那一步可能已經生效。確定要送出嗎？";

interface FollowupComposerProps {
  task: Task;
  run: TaskRun;
  onSent?: (followup: TaskFollowup) => void;
}

export function FollowupComposer({ task, run, onSent }: FollowupComposerProps) {
  const { text } = useTaskboardI18n();
  const confirmTitleId = useId();
  const [body, setBody] = useState("");
  const [sending, setSending] = useState<TaskFollowupMode | null>(null);
  const [confirmingSteer, setConfirmingSteer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The follow-up this composer sent last; its state follows followup.updated (W3 smoke bug 3).
  const [tracked, setTracked] = useState<TaskFollowup | null>(null);
  const trimmed = body.trim();
  const busy = sending !== null;
  const providerName = providerDisplayName(run.provider);

  useEffect(() => {
    setBody("");
    setError(null);
    setNotice(null);
    setTracked(null);
    setConfirmingSteer(false);
  }, [task.id]);

  useEffect(() => subscribeTaskRunEvents((event) => {
    if (event.type !== "followup.updated" || event.taskId !== task.id || !event.followup) return;
    const updated = event.followup;
    setTracked((current) => (current && current.id === updated.id ? updated : current));
  }), [task.id]);

  useEffect(() => {
    if (!tracked) return;
    const state = followupDeliveryState(tracked, providerName, text);
    if (state.kind === "error") {
      setNotice(null);
      setError(state.message);
    } else {
      setError(null);
      setNotice(state.message);
    }
  }, [tracked, providerName, text]);

  useEffect(() => {
    if (!confirmingSteer) return;
    function closeWithEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setConfirmingSteer(false);
    }
    window.addEventListener("keydown", closeWithEscape, true);
    return () => window.removeEventListener("keydown", closeWithEscape, true);
  }, [confirmingSteer]);

  async function send(mode: TaskFollowupMode) {
    if (!trimmed || busy) return;
    setSending(mode);
    setError(null);
    setNotice(null);
    try {
      const followup = await sendTaskFollowup(task.id, trimmed, mode);
      setBody("");
      setTracked((current) => (current && current.id === followup.id ? current : followup));
      onSent?.(followup);
    } catch (sendError) {
      setError(runErrorMessage(sendError, text, text("訊息沒有送出，請重試。", "The message was not sent. Try again.")));
    } finally {
      setSending(null);
      setConfirmingSteer(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send("queue");
    }
  }

  return (
    <div className="followup-composer">
      <span className="task-run-label">{text(`追加訊息給 ${providerName}`, `Send a message to ${providerName}`)}</span>
      <textarea
        value={body}
        disabled={busy}
        placeholder={text("補充說明或修改要求…", "Add details or changes…")}
        aria-label={text("追加訊息", "Follow-up message")}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="followup-composer-actions">
        <span className="followup-composer-hint">
          {text("排隊：等 AI 做完這一輪再送出。", "Queue: sent after the AI finishes this turn.")}
        </span>
        <button
          className="button secondary"
          type="button"
          disabled={!trimmed || busy}
          onClick={() => setConfirmingSteer(true)}
        >
          {sending === "steer" ? text("送出中…", "Sending…") : text("插嘴", "Interrupt")}
        </button>
        <button
          className="button primary"
          type="button"
          disabled={!trimmed || busy}
          onClick={() => void send("queue")}
        >
          {sending === "queue" ? text("送出中…", "Sending…") : text("排隊送出", "Queue message")}
        </button>
      </div>
      {notice && <p className="task-run-notice" role="status">{notice}</p>}
      {error && <p className="task-run-error" role="alert">{error}</p>}

      {confirmingSteer && (
        <div
          className="delete-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setConfirmingSteer(false);
          }}
        >
          <div className="delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby={confirmTitleId}>
            <h2 id={confirmTitleId}>{text("確定要插嘴？", "Interrupt the AI?")}</h2>
            <p>{text(
              STEER_CONFIRMATION_TEXT,
              "Interrupting stops what the AI is doing right now; the step in progress may already have taken effect. Send anyway?",
            )}</p>
            <div>
              <button
                className="button secondary"
                type="button"
                disabled={busy}
                onClick={() => setConfirmingSteer(false)}
              >
                {text("取消", "Cancel")}
              </button>
              <button
                className="button danger"
                type="button"
                disabled={busy || !trimmed}
                onClick={() => void send("steer")}
              >
                {sending === "steer" ? text("送出中…", "Sending…") : text("確定插嘴", "Interrupt")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
