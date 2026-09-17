import os from "node:os";
import { pathToFileURL } from "node:url";

import "../shared/automate-env-init.mjs";
import { createTaskboardServer, resolveHost, resolvePort } from "./app.mjs";

export { createTaskboardServer, resolveHost, resolvePort, resolveServerOptions } from "./app.mjs";

// Startup failures that need a clear operator message (the launcher captures stderr).
export function describeStartupError(error) {
  if (error?.code === "DB_MIGRATION_FAILED") {
    const details = error.details ?? {};
    const lines = [
      "[taskboard] DB_MIGRATION_FAILED: 資料庫升級失敗，看板沒有啟動。",
      `[taskboard] ${error.message}`,
    ];
    if (details.backupPath) lines.push(`[taskboard] 備份檔：${details.backupPath}`);
    else lines.push("[taskboard] 備份檔：沒有建立（升級前備份失敗，資料庫未變更）");
    if (details.restored === true) lines.push("[taskboard] 原資料庫已從備份還原。");
    else if (details.backupPath) lines.push("[taskboard] 原資料庫沒有自動還原成功，請用上面的備份檔手動還原。");
    if (details.stage) lines.push(`[taskboard] 失敗階段：${details.stage}`);
    return lines.join("\n");
  }
  return null;
}

async function main() {
  const app = createTaskboardServer();
  const host = resolveHost();
  const listenFd = process.env.CODEX_TASKBOARD_LISTEN_FD === undefined
    ? null
    : Number(process.env.CODEX_TASKBOARD_LISTEN_FD);
  const address = await app.listen({ host, port: resolvePort(), fd: listenFd });
  console.log(`AutoMate Taskboard listening on http://127.0.0.1:${address.port}`);
  if (host === "0.0.0.0") {
    const addresses = Object.values(os.networkInterfaces())
      .flat()
      .filter((entry) => entry?.family === "IPv4" && !entry.internal)
      .map((entry) => entry.address);
    for (const lanAddress of [...new Set(addresses)]) {
      console.log(`AutoMate Taskboard available on LAN at http://${lanAddress}:${address.port}`);
    }
  }

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
  };
  process.once("SIGINT", () => close().then(() => process.exit(0)));
  process.once("SIGTERM", () => close().then(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const described = describeStartupError(error);
    if (described) console.error(described);
    console.error(error);
    process.exitCode = 1;
  });
}
