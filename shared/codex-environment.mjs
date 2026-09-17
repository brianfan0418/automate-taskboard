export function withoutTaskboardLauncherEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => (
      !name.startsWith("CODEX_TASKBOARD_") && !name.startsWith("AUTOMATE_TASKBOARD_")
    )),
  );
}
