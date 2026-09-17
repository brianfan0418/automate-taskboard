// Build-time UI feature flags. Flip a flag to re-enable a hidden entry point;
// this never removes the underlying feature/backend code.

// Hides Jira-specific UI entry points (the "Connect Jira" / "Jira settings"
// menu item and its dialog trigger) from the web UI. Backend Jira
// integration and already-synced Jira tasks/projects are unaffected — this
// only gates the UI surface that lets a user *start* or *reconfigure* a
// Jira connection.
export const JIRA_UI_ENABLED = false;
