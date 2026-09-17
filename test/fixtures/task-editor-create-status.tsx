import { createRoot } from "react-dom/client";

import { TaskEditor, type NewTaskEditorDraft } from "../../web/src/components/TaskEditor";
import { getTaskboardI18n, TaskboardLanguageProvider, type TaskboardLanguage } from "../../web/src/i18n";
import type { ActorIdentity, TaskDraft } from "../../web/src/types";

// Render in the product's default UI language and find the submit button by its localized label.
const language: TaskboardLanguage = "zh-TW";
const createIssueLabel = getTaskboardI18n(language).text("创建议题", "Create issue");

const currentUser: ActorIdentity = {
  type: "user",
  id: "reviewer",
  name: "Reviewer",
  avatarUrl: null,
};

const oldTodoDraft: NewTaskEditorDraft = {
  title: "保留的草稿标题",
  descriptionSegments: [{ id: "draft-description", type: "text", text: "保留的草稿描述" }],
  status: "todo",
  priority: "high",
  assignee: currentUser,
  selectedLabels: ["回归证据"],
  developmentContext: null,
  startDate: "",
  dueDate: "",
  recurrence: null,
  relations: {
    parentId: null,
    relatedIds: [],
    subIssueIds: [],
  },
};

function publishResult(draft: TaskDraft) {
  document.documentElement.dataset.result = encodeURIComponent(JSON.stringify(draft));
}

createRoot(document.getElementById("root")!).render(
  <TaskboardLanguageProvider language={language}>
    <TaskEditor
      projectId={null}
      tasks={[]}
      referenceTasks={[]}
      initialStatus="in_progress"
      initialDraft={oldTodoDraft}
      labels={["回归证据"]}
      currentUser={currentUser}
      developmentScan={{ workspacePath: null, contexts: [] }}
      developmentScanLoading={false}
      onCreateLabel={async () => {}}
      onCancel={() => {}}
      onSave={async (draft) => publishResult(draft)}
    />
  </TaskboardLanguageProvider>,
);

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const createButton = [...document.querySelectorAll("button")]
      .find((button) => button.textContent === createIssueLabel);
    if (!(createButton instanceof HTMLButtonElement)) {
      document.documentElement.dataset.error = "create button not found";
      return;
    }
    createButton.click();
  });
});
