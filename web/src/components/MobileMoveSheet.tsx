import { useEffect, useId, useRef } from "react";
import { taskStatusLabel, useTaskboardI18n } from "../i18n";
import { mobileMoveDestinations, mobileMoveNeedsDetail } from "../mobileUiModel";
import type { Task, TaskStatus } from "../types";
import { LinearIcon } from "./LinearIcon";
import { StatusIcon } from "./SemanticIcons";
import "./MobileIssueBoard.css";

export interface MobileMoveSheetProps {
  task: Task;
  onDrop: (status: TaskStatus, taskId: string, beforeTaskId: string | null) => void;
  onOpenTask: (task: Task) => void;
  onClose: () => void;
}

export function MobileMoveSheet({ task, onDrop, onOpenTask, onClose }: MobileMoveSheetProps) {
  const { language, text } = useTaskboardI18n();
  const titleId = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const displayIdentifier = task.externalKey ?? task.identifier;
  const destinations = mobileMoveDestinations(task);
  const needsDetail = mobileMoveNeedsDetail(task);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheetRef.current?.querySelector<HTMLElement>("[data-destination], .mobile-move-sheet-details")?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <div
      className="mobile-move-sheet-backdrop"
      data-mobile-move-sheet
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={sheetRef}
        className="mobile-move-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="mobile-move-sheet-grabber" aria-hidden="true" />
        <header className="mobile-move-sheet-header">
          <div className="mobile-move-sheet-heading">
            <small>
              {displayIdentifier}
              <span aria-hidden="true"> · </span>
              {taskStatusLabel(language, task.status)}
            </small>
            <h2 id={titleId}>{task.title}</h2>
          </div>
          <button
            type="button"
            className="mobile-move-sheet-close"
            aria-label={text("關閉", "Close")}
            onClick={onClose}
          >
            <LinearIcon name="close" />
          </button>
        </header>

        {destinations.length > 0 && (
          <>
            <p className="mobile-move-sheet-prompt">{text("移到哪裡？", "Move to")}</p>
            <div className="mobile-move-sheet-destinations" role="group" aria-label={text("移動到狀態", "Move to status")}>
              {destinations.map((destination) => (
                <button
                  key={destination}
                  type="button"
                  data-destination={destination}
                  className={`mobile-move-sheet-destination status-${destination}`}
                  onClick={() => {
                    onDrop(destination, task.id, null);
                    onClose();
                  }}
                >
                  <StatusIcon status={destination} size={14} />
                  <span>{taskStatusLabel(language, destination)}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {needsDetail && (
          <p className="mobile-move-sheet-note">
            {text(
              "要讓 AI 繼續做，或留言後改回等待認領，請開啟詳情。",
              "To let the AI continue, or send it back to To do with a comment, open the details.",
            )}
          </p>
        )}

        <button
          type="button"
          className="mobile-move-sheet-details"
          onClick={() => {
            onClose();
            onOpenTask(task);
          }}
        >
          {text("開啟詳情", "Open details")}
        </button>
      </div>
    </div>
  );
}
