import {
  parseMove, parseVersionMutation, parseRelationMutation,
  parseCommentCreate, parseCommentPatch, parseTaskCreate,
  parseTaskPatch, parseTaskFilters, parseTaskTreeQuery, parseProjectReadmeSave,
} from "../shared/task-input.mjs";
import {
  ApiError,
  validateProjectId,
  assertPlainObject,
  assertAllowedKeys,
  stringField,
  slugify,
  parseProjectLabel,
  parseThreadId,
  parseStatus,
} from "../shared/api-fields.mjs";
import { createHmac, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocket as WebSocketClient, WebSocketServer } from "ws";

import {
  DEFAULT_PROJECT_ID,
  JIRA_PROJECT_ID,
  TASK_STATUSES,
} from "../shared/domain.mjs";
import { resolveCodexExecutable } from "../shared/codex-executable.mjs";
import { withoutTaskboardLauncherEnvironment } from "../shared/codex-environment.mjs";
import { executableCommand } from "../shared/executable-command.mjs";
import { AiChatService } from "./ai-chat.mjs";
import { resolveAiWorkspace, resolveMappedAiWorkspace } from "./ai-chat-catalog.mjs";
import { decodeComposerReferenceKey } from "../shared/composer-reference.mjs";
import { createCloudConfigStore } from "./cloud-config.mjs";
import {
  CloudProxyError,
  createCloudProxy,
  isLocalCompanionRoute,
} from "./cloud-proxy.mjs";
import { TaskboardDatabase } from "./database.mjs";
import { createJiraConfigStore } from "./jira-config.mjs";
import { createJiraIntegration } from "./jira-integration.mjs";
import { ProjectSummaryService } from "./project-summary.mjs";
import { CodexAppServer } from "./codex-app-server.mjs";
import { createMobileAccess, MOBILE_ACCESS_EVENT } from "./mobile/index.mjs";
import { MobilePairingService } from "./mobile/pairing-service.mjs";
import {
  isLocalHostHeader,
  isLoopbackAddress as isExactLoopbackAddress,
} from "./mobile/remote-auth.mjs";
import { agentActorForProvider, CLAUDE_AGENT_ACTOR, CODEX_AGENT_ACTOR } from "./runs/actors.mjs";
import { detectClaudePermissionMode } from "./runs/claude-permission-settings.mjs";
import { createCodexAppProvider } from "./runs/codex-app.mjs";
import { createScheduler } from "./runs/scheduler.mjs";
import { createRunService } from "./runs/service.mjs";
import { assertProjectFolder, createFolderPicker } from "./folder-picker.mjs";
import { isBlockedByOpenDependency, providerForAssignee } from "../shared/task-order.mjs";
import { buildTaskPrompt } from "../shared/task-prompt.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const JSON_BODY_LIMIT = 1024 * 1024;
const PROJECT_README_BODY_LIMIT = 3 * 1024 * 1024;
const ATTACHMENT_BODY_LIMIT = 25 * 1024 * 1024;
const AI_CHAT_TURN_BODY_LIMIT = 25 * 1024 * 1024;
const AI_CHAT_ATTACHMENT_LIMIT = 10;
const AI_CHAT_SKILL_MARKER = "\uFFFC";
const HOST_RUNTIME_TTL_MS = 3_000;
const CODEX_PLAN_TAIL_BYTES = 16 * 1024 * 1024;
const INLINE_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
]);
const PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX = "taskboard.project-board-display-settings.v3.";
const TRUSTED_EMBED_ORIGINS = new Set(["app://-"]);
const TRUSTED_ORIGINS_ENV = "CODEX_TASKBOARD_TRUSTED_ORIGINS";
const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(body);
}

function sendEmpty(response, status, headers = {}) {
  response.writeHead(status, { "cache-control": "no-store", ...headers });
  response.end();
}

function toFetchRequest(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const init = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = Readable.toWeb(request);
    init.duplex = "half";
  }
  return new Request(`http://127.0.0.1${request.url}`, init);
}

async function sendFetchResponse(response, upstream) {
  response.statusCode = upstream.status;
  response.statusMessage = upstream.statusText;
  for (const [name, value] of upstream.headers) {
    if (
      name === "connection"
      || name === "content-encoding"
      || name === "content-length"
      || name === "set-cookie"
      || name === "transfer-encoding"
    ) {
      continue;
    }
    response.setHeader(name, value);
  }
  const cookies = upstream.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) response.setHeader("set-cookie", cookies);
  if (!upstream.body) {
    response.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const body = Readable.fromWeb(upstream.body);
    body.once("error", reject);
    response.once("finish", resolve);
    body.pipe(response);
  });
}

function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isTrustedNetworkHost(hostname) {
  const host = normalizeHostname(hostname);
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  if (isIP(host) === 4) {
    const octets = host.split(".").map(Number);
    return octets[0] === 127
      || octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254);
  }
  if (isIP(host) === 6) {
    return host.startsWith("fc")
      || host.startsWith("fd")
      || /^fe[89ab]/.test(host);
  }
  return false;
}

function parseTrustedOrigins(value) {
  if (value === undefined) return new Set();
  const configured = String(value).trim();
  if (!configured) {
    throw new Error(`${TRUSTED_ORIGINS_ENV} must not be empty when configured`);
  }

  const origins = new Set();
  for (const rawOrigin of configured.split(",")) {
    const origin = rawOrigin.trim();
    if (!origin || origin.includes("*")) {
      throw new Error(`${TRUSTED_ORIGINS_ENV} must be a comma-separated list of exact HTTPS origins`);
    }
    let url;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`${TRUSTED_ORIGINS_ENV} must contain valid HTTPS origins`);
    }
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) {
      throw new Error(`${TRUSTED_ORIGINS_ENV} must contain exact HTTPS origins without paths, queries, fragments, or credentials`);
    }
    if (origins.has(url.origin)) {
      throw new Error(`${TRUSTED_ORIGINS_ENV} must not contain duplicate origins`);
    }
    origins.add(url.origin);
  }
  return origins;
}

function parseRequestHost(value) {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new ApiError(403, "INVALID_HOST", "Request Host must be local, private, or explicitly trusted");
  }
  let url;
  try {
    url = new URL(`https://${value}`);
  } catch {
    throw new ApiError(403, "INVALID_HOST", "Request Host must be local, private, or explicitly trusted");
  }
  if (
    url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || !url.hostname
  ) {
    throw new ApiError(403, "INVALID_HOST", "Request Host must be local, private, or explicitly trusted");
  }
  return { hostname: url.hostname, httpsOrigin: url.origin };
}

function assertTrustedNetworkRequest(request, allowOpaqueOrigin = false, trustedOrigins = new Set()) {
  const host = parseRequestHost(request.headers.host);
  const trustedNetworkHost = isTrustedNetworkHost(host.hostname);
  const configuredTrustedHost = !trustedNetworkHost && trustedOrigins.has(host.httpsOrigin);
  if (!trustedNetworkHost && !configuredTrustedHost) {
    throw new ApiError(403, "INVALID_HOST", "Request Host must be local, private, or explicitly trusted");
  }

  const origin = request.headers.origin;
  const configuredTrustedOrigin = trustedOrigins.has(origin);
  if (origin && !configuredTrustedOrigin && !TRUSTED_EMBED_ORIGINS.has(origin)) {
    if (!(allowOpaqueOrigin && origin === "null")) {
      let originHost;
      try {
        originHost = new URL(origin).hostname;
      } catch {
        throw new ApiError(403, "INVALID_ORIGIN", "Request Origin must be local or private");
      }
      if (!isTrustedNetworkHost(originHost)) {
        throw new ApiError(403, "INVALID_ORIGIN", "Request Origin must be local or private");
      }
    }
  }
  return configuredTrustedHost || configuredTrustedOrigin;
}

function assertLoopbackRequest(request) {
  const address = request.socket.remoteAddress;
  if (
    address !== "127.0.0.1"
    && address !== "::1"
    && address !== "::ffff:127.0.0.1"
  ) {
    throw new ApiError(403, "LOCAL_ONLY", "This endpoint is only available on this device");
  }
}

// W15 review M1/O1: choosing or setting a project folder (the AI's working directory on this PC) is
// only allowed from this PC's own board: loopback socket, local Host header (DNS rebinding), and not
// an opaque `Origin: null` page. The Codex-embedded panel is a sandboxed iframe without
// allow-same-origin, so it sends `Origin: null`; everywhere else it is admitted by the launcher
// instance token (see trustedEmbedOrigin), but it cannot set folders — the board window can.
export function assertProjectFolderRequest(request) {
  if (!isExactLoopbackAddress(request?.socket?.remoteAddress) || !isLocalHostHeader(request?.headers?.host)) {
    throw new ApiError(403, "LOCAL_ONLY", "只能在這台電腦上的看板設定專案資料夾");
  }
  if (request.headers.origin === "null") {
    throw new ApiError(403, "LOCAL_ONLY", "請在 AutoMate Taskboard 視窗裡設定專案資料夾");
  }
}

function assertAllowedQuery(searchParams, allowed, routeLabel) {
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `${routeLabel} does not accept query parameter '${key}'`);
    }
    if (searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "INVALID_QUERY_PARAMETER", `Query parameter '${key}' cannot be repeated`);
    }
  }
}

function assertNoQuery(searchParams, routeLabel) {
  assertAllowedQuery(searchParams, new Set(), routeLabel);
}

function parseAfterCursor(searchParams, routeLabel) {
  assertAllowedQuery(searchParams, new Set(["after"]), routeLabel);
  const value = searchParams.get("after");
  if (value === null) return null;
  const revision = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(revision)) {
    throw new ApiError(400, "INVALID_CURSOR", "Cursor must be a non-negative integer revision");
  }
  return { value, revision };
}

function nextCursor(items, after) {
  if (items.length === 0) return after?.value ?? "0";
  return String(items.reduce(
    (revision, item) => Math.max(revision, item.changeRevision),
    0,
  ));
}

function decodeRouteSegment(value, name) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ApiError(400, "INVALID_PATH", `${name} contains invalid encoding`);
  }
  if (!decoded || decoded.length > 256 || decoded.includes("\0")) {
    throw new ApiError(400, "INVALID_PATH", `${name} is invalid`);
  }
  return decoded;
}

function isLoopbackAddress(value) {
  if (typeof value !== "string") return false;
  const address = value.toLowerCase().split("%", 1)[0];
  return address === "::1"
    || address === "127.0.0.1"
    || address.startsWith("127.")
    || address === "::ffff:127.0.0.1"
    || address.startsWith("::ffff:127.");
}

function assertAiLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    throw new ApiError(403, "LOCAL_AI_LOOPBACK_REQUIRED", "Local AI routes are only available from this device");
  }
}

function pathField(value, name) {
  const normalized = stringField(value, name, { nullable: true, maxLength: 4096 });
  if (normalized === "") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  if (normalized?.includes("\0")) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot contain null bytes`);
  }
  return normalized;
}

function parseDevelopmentContext(value) {
  if (value === null) return null;
  assertPlainObject(value);
  if (value.type === "branch") {
    assertAllowedKeys(value, new Set(["type", "branch"]));
    return {
      type: "branch",
      branch: stringField(value.branch, "developmentContext.branch", { required: true, maxLength: 512 }),
    };
  }
  if (value.type === "worktree") {
    assertAllowedKeys(value, new Set(["type", "path", "branch"]));
    const worktreePath = stringField(value.path, "developmentContext.path", { required: true, maxLength: 4096 });
    if (worktreePath.includes("\0")) {
      throw new ApiError(400, "INVALID_FIELD", "'developmentContext.path' cannot contain null bytes");
    }
    return {
      type: "worktree",
      path: worktreePath,
      branch: stringField(value.branch ?? null, "developmentContext.branch", { nullable: true, maxLength: 512 }),
    };
  }
  throw new ApiError(400, "INVALID_FIELD", "'developmentContext.type' must be branch or worktree");
}

function parseProjectCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["id", "name", "workspacePath"]));
  const name = stringField(body.name, "name", { required: true, maxLength: 120 });
  const id = validateProjectId(body.id ?? slugify(name));
  if (!id) {
    throw new ApiError(400, "INVALID_FIELD", "Project name must contain at least one letter or number when 'id' is omitted");
  }
  const workspacePath = stringField(body.workspacePath ?? null, "workspacePath", { nullable: true, maxLength: 4096 });
  if (workspacePath === "") {
    throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot be empty");
  }
  if (workspacePath?.includes("\0")) {
    throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
  }
  return { id, name, workspacePath };
}

function requestHeader(request, name) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function actorFromRequest(request) {
  if (request.headers["x-taskboard-client"] === "taskctl") {
    return CODEX_AGENT_ACTOR;
  }

  const rawId = requestHeader(request, "x-taskboard-user-id");
  const rawName = requestHeader(request, "x-taskboard-user-name");
  const rawAvatarUrl = requestHeader(request, "x-taskboard-user-avatar");
  if (rawId === undefined && rawName === undefined && rawAvatarUrl === undefined) {
    return { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };
  }
  if (rawId === undefined || rawName === undefined) {
    throw new ApiError(400, "INVALID_ACTOR", "User identity requires both an ID and name");
  }

  const id = stringField(rawId, "X-Taskboard-User-Id", { required: true, maxLength: 96 });
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(id)) {
    throw new ApiError(400, "INVALID_ACTOR", "User ID contains unsupported characters");
  }
  let decodedName;
  try {
    decodedName = decodeURIComponent(rawName);
  } catch {
    throw new ApiError(400, "INVALID_ACTOR", "User name is not valid URL-encoded text");
  }
  const name = stringField(decodedName, "X-Taskboard-User-Name", { required: true, maxLength: 120 });

  let avatarUrl = null;
  if (rawAvatarUrl !== undefined) {
    const value = stringField(rawAvatarUrl, "X-Taskboard-User-Avatar", { required: true, maxLength: 2048 });
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new ApiError(400, "INVALID_ACTOR", "User avatar URL is invalid");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new ApiError(400, "INVALID_ACTOR", "User avatar URL must use HTTP or HTTPS");
    }
    avatarUrl = parsed.toString();
  }
  return { type: "user", id, name, avatarUrl };
}

function resolveAssignee(target, actor) {
  if (target === undefined) return actor;
  if (target === "codex-agent") return CODEX_AGENT_ACTOR;
  if (target === "claude-agent") return CLAUDE_AGENT_ACTOR;
  if (actor.type !== "user") {
    throw new ApiError(400, "INVALID_FIELD", "'current-user' requires a user request identity");
  }
  return actor;
}

function parseIssueRelationType(value) {
  if (!["parent", "blocks", "blocked_by", "related"].includes(value)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "'relation type' must be parent, blocks, blocked_by, or related",
    );
  }
  return value;
}

function parseAttachmentHeaders(request) {
  const encodedFilename = request.headers["x-taskboard-filename"];
  if (typeof encodedFilename !== "string") {
    throw new ApiError(400, "INVALID_FILENAME", "X-Taskboard-Filename is required");
  }
  let filename;
  try {
    filename = decodeURIComponent(encodedFilename).trim();
  } catch {
    throw new ApiError(400, "INVALID_FILENAME", "Attachment filename contains invalid encoding");
  }
  if (
    filename.length === 0
    || filename.length > 240
    || filename === "."
    || filename === ".."
    || /[\u0000-\u001f\u007f/\\]/.test(filename)
  ) {
    throw new ApiError(400, "INVALID_FILENAME", "Attachment filename is invalid");
  }

  const rawContentType = request.headers["content-type"];
  const contentType = typeof rawContentType === "string"
    ? rawContentType.split(";", 1)[0].trim().toLowerCase()
    : "application/octet-stream";
  if (contentType.length === 0 || contentType.length > 200 || !/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(contentType)) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Attachment Content-Type is invalid");
  }
  const kind = request.headers["x-taskboard-attachment-kind"];
  if (kind !== "inline" && kind !== "attachment") {
    throw new ApiError(
      400,
      "INVALID_ATTACHMENT_KIND",
      "X-Taskboard-Attachment-Kind must be inline or attachment",
    );
  }
  return { filename, contentType, kind };
}

async function readBody(request, limit, tooLargeMessage) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new ApiError(413, "BODY_TOO_LARGE", tooLargeMessage);
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) {
      throw new ApiError(413, "BODY_TOO_LARGE", tooLargeMessage);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(
  request,
  limit = JSON_BODY_LIMIT,
  tooLargeMessage = "Request body cannot exceed 1 MiB",
) {
  const contentType = request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  const body = await readBody(request, limit, tooLargeMessage);
  const length = body.length;
  if (length === 0) {
    throw new ApiError(400, "INVALID_JSON", "Request body cannot be empty");
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must contain valid JSON");
  }
}

async function assertEmptyRequestBody(request, routeLabel) {
  const body = await readBody(request, JSON_BODY_LIMIT, "Request body cannot exceed 1 MiB");
  if (body.length > 0) {
    throw new ApiError(400, "INVALID_BODY", `${routeLabel} does not accept a request body`);
  }
}

function parseAiSandbox(value) {
  if (value === undefined) return undefined;
  if (!["read-only", "workspace-write", "danger-full-access"].includes(value)) {
    throw new ApiError(
      400,
      "INVALID_SANDBOX",
      "'sandbox' must be read-only, workspace-write, or danger-full-access",
    );
  }
  return value;
}

function parseAiSetting(value, name, maxLength) {
  const setting = stringField(value, name, { maxLength });
  if (setting === "") {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  return setting;
}

function parseAiExecutionTarget(value) {
  const fields = [
    "codexProjectId",
    "codexProjectKind",
    "codexHostId",
    "workspacePath",
  ];
  const present = fields.filter((field) => value[field] !== undefined);
  if (present.length === 0) return undefined;
  if (present.length !== fields.length) {
    throw new ApiError(400, "INVALID_CODEX_TARGET", "Codex project identity must contain all four fields");
  }
  const codexProjectKind = parseAiSetting(value.codexProjectKind, "codexProjectKind", 16);
  if (codexProjectKind !== "local" && codexProjectKind !== "remote") {
    throw new ApiError(400, "INVALID_CODEX_TARGET", "'codexProjectKind' must be local or remote");
  }
  const workspacePath = parseAiSetting(value.workspacePath, "workspacePath", 4096);
  if (workspacePath.includes("\0")) {
    throw new ApiError(400, "INVALID_CODEX_TARGET", "'workspacePath' cannot contain null bytes");
  }
  return {
    codexProjectId: parseAiSetting(value.codexProjectId, "codexProjectId", 256),
    codexProjectKind,
    codexHostId: parseAiSetting(value.codexHostId, "codexHostId", 512),
    workspacePath,
  };
}

function aiExecutionTargetFromQuery(searchParams) {
  return parseAiExecutionTarget({
    codexProjectId: searchParams.get("codexProjectId") ?? undefined,
    codexProjectKind: searchParams.get("codexProjectKind") ?? undefined,
    codexHostId: searchParams.get("codexHostId") ?? undefined,
    workspacePath: searchParams.get("workspacePath") ?? undefined,
  });
}

function parseAiThreadCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "projectId",
    "issueId",
    "title",
    "model",
    "reasoningEffort",
    "sandbox",
    "codexProjectId",
    "codexProjectKind",
    "codexHostId",
    "workspacePath",
  ]));
  return {
    projectId: validateProjectId(body.projectId),
    issueId: parseAiSetting(body.issueId, "issueId", 128),
    title: parseAiSetting(body.title, "title", 160),
    model: parseAiSetting(body.model, "model", 128),
    reasoningEffort: parseAiSetting(body.reasoningEffort, "reasoningEffort", 64),
    sandbox: parseAiSandbox(body.sandbox),
    ...parseAiExecutionTarget(body),
  };
}

function parseAiThreadPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["title", "model", "reasoningEffort", "sandbox"]));
  const input = {};
  if (body.title !== undefined) input.title = parseAiSetting(body.title, "title", 160);
  if (body.model !== undefined) input.model = parseAiSetting(body.model, "model", 128);
  if (body.reasoningEffort !== undefined) {
    input.reasoningEffort = parseAiSetting(body.reasoningEffort, "reasoningEffort", 64);
  }
  if (body.sandbox !== undefined) input.sandbox = parseAiSandbox(body.sandbox);
  if (Object.keys(input).length === 0) {
    throw new ApiError(400, "INVALID_BODY", "PATCH requires at least one thread setting");
  }
  return input;
}

function parseAiSkillIds(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) {
    throw new ApiError(400, "INVALID_FIELD", "'skillIds' must be an array with at most 20 entries");
  }
  const skillIds = value.map((skillId, index) => (
    stringField(skillId, `skillIds[${index}]`, { required: true, maxLength: 256 })
  ));
  return skillIds;
}

function parseAiAttachments(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > AI_CHAT_ATTACHMENT_LIMIT) {
    throw new ApiError(
      400,
      "INVALID_ATTACHMENT",
      `'attachments' must be an array with at most ${AI_CHAT_ATTACHMENT_LIMIT} files`,
    );
  }
  return value.map((attachment, index) => {
    assertPlainObject(attachment);
    assertAllowedKeys(attachment, new Set(["filename", "contentType", "dataBase64"]));
    const filename = stringField(attachment.filename, `attachments[${index}].filename`, {
      required: true,
      maxLength: 240,
    });
    if (/[\u0000-\u001f\u007f/\\]/.test(filename)) {
      throw new ApiError(
        400,
        "INVALID_ATTACHMENT",
        `'attachments[${index}].filename' is invalid`,
      );
    }
    const contentType = stringField(
      attachment.contentType,
      `attachments[${index}].contentType`,
      { required: true, maxLength: 256 },
    ).toLowerCase();
    const dataBase64 = stringField(
      attachment.dataBase64,
      `attachments[${index}].dataBase64`,
      { required: true, maxLength: AI_CHAT_TURN_BODY_LIMIT },
    );
    if (
      dataBase64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)
    ) {
      throw new ApiError(
        400,
        "INVALID_ATTACHMENT",
        `'attachments[${index}].dataBase64' must contain valid base64`,
      );
    }
    const data = Buffer.from(dataBase64, "base64");
    if (data.length === 0 || data.toString("base64") !== dataBase64) {
      throw new ApiError(
        400,
        "INVALID_ATTACHMENT",
        `'attachments[${index}].dataBase64' must contain valid base64`,
      );
    }
    return { filename, contentType, data, size: data.length };
  });
}

function parseAiTurn(body) {
  assertPlainObject(body);
  if (body.contractVersion !== undefined) return parseComposerTurn(body);
  assertAllowedKeys(body, new Set([
    "message",
    "skillIds",
    "dangerFullAccessConfirmed",
    "attachments",
  ]));
  if (
    body.dangerFullAccessConfirmed !== undefined
    && typeof body.dangerFullAccessConfirmed !== "boolean"
  ) {
    throw new ApiError(400, "INVALID_FIELD", "'dangerFullAccessConfirmed' must be a boolean");
  }
  const message = stringField(body.message ?? "", "message", { maxLength: 100_000 });
  const skillIds = parseAiSkillIds(body.skillIds) ?? [];
  if (message.split(AI_CHAT_SKILL_MARKER).length - 1 !== skillIds.length) {
    throw new ApiError(400, "INVALID_FIELD", "'skillIds' must match the Skill markers in 'message'");
  }
  const attachments = parseAiAttachments(body.attachments);
  if (message === "" && attachments.length === 0) {
    throw new ApiError(
      400,
      "INVALID_MESSAGE",
      "A message or at least one attachment is required",
    );
  }
  return {
    message,
    skillIds,
    dangerFullAccessConfirmed: body.dangerFullAccessConfirmed,
    attachments,
  };
}

function parseComposerCandidateQuery(searchParams) {
  assertAllowedQuery(
    searchParams,
    new Set([
      "projectId",
      "threadId",
      "trigger",
      "query",
      "surface",
      "codexProjectId",
      "codexProjectKind",
      "codexHostId",
      "workspacePath",
    ]),
    "GET /api/local/ai/composer/candidates",
  );
  let projectId;
  const rawProjectId = searchParams.get("projectId");
  if (rawProjectId !== null) {
    try {
      projectId = validateProjectId(rawProjectId);
    } catch {
      throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer project id is invalid");
    }
  }
  const trigger = searchParams.get("trigger");
  if (trigger !== "/" && trigger !== "@") {
    throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer trigger must be '/' or '@'");
  }
  const query = searchParams.get("query") ?? "";
  if (query.length > 256) {
    throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer query cannot exceed 256 characters");
  }
  let threadId;
  try {
    threadId = parseThreadId(searchParams.get("threadId") ?? undefined);
  } catch {
    throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer thread id is invalid");
  }
  const surface = searchParams.get("surface") ?? "ai-chat";
  if (!new Set(["ai-chat", "issue-description", "comment"]).has(surface)) {
    throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer surface is invalid");
  }
  return {
    projectId,
    threadId,
    trigger,
    query,
    surface,
    ...aiExecutionTargetFromQuery(searchParams),
  };
}

function invalidComposerRebindRequest(message) {
  return new ApiError(400, "INVALID_COMPOSER_REBIND_REQUEST", message);
}

function assertComposerRebindKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalidComposerRebindRequest(`'${field}.${key}' is not allowed`);
    }
  }
}

function parseComposerRebindRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidComposerRebindRequest("Composer rebind body must be an object");
  }
  assertComposerRebindKeys(
    value,
    new Set(["contractVersion", "projectId", "threadId", "document"]),
    "body",
  );
  if (value.contractVersion !== "composer.v1") {
    throw invalidComposerRebindRequest("'contractVersion' must be 'composer.v1'");
  }
  let projectId;
  try {
    projectId = validateProjectId(value.projectId);
  } catch {
    throw invalidComposerRebindRequest("'projectId' is invalid");
  }
  let threadId;
  try {
    threadId = parseThreadId(value.threadId);
  } catch {
    throw invalidComposerRebindRequest("'threadId' is invalid");
  }
  const document = value.document;
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw invalidComposerRebindRequest("'document' must be an object");
  }
  assertComposerRebindKeys(document, new Set(["version", "nodes"]), "document");
  if (document.version !== 1) {
    throw invalidComposerRebindRequest("'document.version' must be 1");
  }
  if (!Array.isArray(document.nodes) || document.nodes.length > 200) {
    throw invalidComposerRebindRequest("'document.nodes' must contain at most 200 entries");
  }
  let textLength = 0;
  const nodes = document.nodes.map((node, nodeIndex) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw invalidComposerRebindRequest(`'document.nodes[${nodeIndex}]' must be an object`);
    }
    if (node.type === "text") {
      assertComposerRebindKeys(node, new Set(["type", "text"]), `document.nodes[${nodeIndex}]`);
      if (typeof node.text !== "string") {
        throw invalidComposerRebindRequest(`'document.nodes[${nodeIndex}].text' must be a string`);
      }
      textLength += node.text.length;
      return { type: "text", text: node.text };
    }
    if (node.type === "unsupportedReference") {
      assertComposerRebindKeys(
        node,
        new Set(["type", "referenceUri", "label"]),
        `document.nodes[${nodeIndex}]`,
      );
      if (typeof node.label !== "string" || node.label.length === 0 || node.label.length > 256) {
        throw invalidComposerRebindRequest(`'document.nodes[${nodeIndex}].label' is invalid`);
      }
      if (typeof node.referenceUri !== "string" || node.referenceUri.length > 1_024) {
        throw invalidComposerRebindRequest(
          `'document.nodes[${nodeIndex}].referenceUri' is invalid`,
        );
      }
      const match = /^taskboard:\/\/composer-reference\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(
        node.referenceUri,
      );
      if (!match) {
        throw invalidComposerRebindRequest(
          `'document.nodes[${nodeIndex}].referenceUri' is not a composer reference marker`,
        );
      }
      try {
        decodeComposerReferenceKey(match[3]);
      } catch {
        throw invalidComposerRebindRequest(
          `'document.nodes[${nodeIndex}].referenceUri' has an invalid reference key`,
        );
      }
      const reasonCode = match[1] !== "v1"
        ? "REFERENCE_FORMAT_UNSUPPORTED"
        : !new Set(["skill", "agent"]).has(match[2])
          ? "REFERENCE_KIND_UNSUPPORTED"
          : null;
      if (!reasonCode) {
        throw invalidComposerRebindRequest(
          `'document.nodes[${nodeIndex}]' must use persistedReference for supported markers`,
        );
      }
      return {
        type: "unsupportedReference",
        referenceUri: node.referenceUri,
        label: node.label,
        reasonCode,
      };
    }
    if (node.type !== "persistedReference") {
      throw invalidComposerRebindRequest(
        `'document.nodes[${nodeIndex}].type' must be text, persistedReference or unsupportedReference`,
      );
    }
    assertComposerRebindKeys(
      node,
      new Set(["type", "referenceKind", "referenceKey", "label"]),
      `document.nodes[${nodeIndex}]`,
    );
    if (node.referenceKind !== "skill" && node.referenceKind !== "agent") {
      throw invalidComposerRebindRequest(
        `'document.nodes[${nodeIndex}].referenceKind' must be skill or agent`,
      );
    }
    if (
      typeof node.referenceKey !== "string"
      || node.referenceKey.length === 0
      || node.referenceKey.length > 512
    ) {
      throw invalidComposerRebindRequest(
        `'document.nodes[${nodeIndex}].referenceKey' is invalid`,
      );
    }
    if (typeof node.label !== "string" || node.label.length === 0 || node.label.length > 256) {
      throw invalidComposerRebindRequest(`'document.nodes[${nodeIndex}].label' is invalid`);
    }
    let stableId;
    try {
      stableId = decodeComposerReferenceKey(node.referenceKey);
    } catch {
      throw invalidComposerRebindRequest(
        `'document.nodes[${nodeIndex}].referenceKey' is not canonical base64url`,
      );
    }
    if (node.referenceKind === "skill" && stableId !== stableId.normalize("NFC")) {
      throw invalidComposerRebindRequest(
        `'document.nodes[${nodeIndex}].referenceKey' does not contain an NFC Skill name`,
      );
    }
    return {
      type: "persistedReference",
      referenceKind: node.referenceKind,
      referenceKey: node.referenceKey,
      label: node.label,
      stableId,
    };
  });
  if (textLength > 100_000) {
    throw invalidComposerRebindRequest("Composer text cannot exceed 100000 characters");
  }
  return {
    contractVersion: "composer.v1",
    projectId,
    threadId,
    document: { version: 1, nodes },
  };
}

async function resolveComposerRebindWorkspace(aiChat, input) {
  let thread;
  if (input.threadId !== undefined) {
    try {
      thread = aiChat.getThread(input.threadId);
    } catch (error) {
      if (error instanceof ApiError && error.code === "AI_CHAT_THREAD_NOT_FOUND") {
        throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer thread does not exist");
      }
      throw error;
    }
    if (thread.origin.projectId !== input.projectId) {
      throw new ApiError(
        400,
        "INVALID_COMPOSER_QUERY",
        "Composer thread does not belong to the selected project",
      );
    }
    if (thread.origin.codexProjectKind !== "remote") {
      try {
        if (!(await stat(thread.origin.workspacePath)).isDirectory()) throw new Error("not a directory");
      } catch {
        throw new ApiError(
          409,
          "PROJECT_WORKSPACE_UNAVAILABLE",
          "The conversation workspace is not available on this device",
        );
      }
    }
    return {
      workspacePath: thread.origin.workspacePath,
      composerCatalog: aiChat.composerCatalogForThread(thread),
    };
  }
  let resolved;
  try {
    resolved = await aiChat.resolveContext(input.projectId, thread?.origin.issueId);
  } catch (error) {
    if (
      error instanceof ApiError
      && ["PROJECT_NOT_FOUND", "AI_CHAT_ISSUE_NOT_FOUND"].includes(error.code)
    ) {
      throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer project is invalid");
    }
    throw error;
  }
  return { workspacePath: resolved.workspacePath, composerCatalog: aiChat.composerCatalog };
}

function parseComposerDocument(value) {
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["version", "nodes"]));
  if (value.version !== 1) {
    throw new ApiError(400, "INVALID_COMPOSER_DOCUMENT", "'document.version' must be 1");
  }
  if (!Array.isArray(value.nodes) || value.nodes.length > 200) {
    throw new ApiError(
      400,
      "INVALID_COMPOSER_DOCUMENT",
      "'document.nodes' must be an array with at most 200 entries",
    );
  }
  let textLength = 0;
  const nodes = value.nodes.map((node, index) => {
    assertPlainObject(node);
    if (typeof node.type !== "string" || !node.type) {
      throw new ApiError(
        400,
        "INVALID_COMPOSER_DOCUMENT",
        `'document.nodes[${index}].type' is required`,
      );
    }
    if (node.type === "text") {
      assertAllowedKeys(node, new Set(["type", "text"]));
      if (typeof node.text !== "string") {
        throw new ApiError(
          400,
          "INVALID_COMPOSER_DOCUMENT",
          `'document.nodes[${index}].text' must be a string`,
        );
      }
      textLength += node.text.length;
      return { type: "text", text: node.text };
    }
    if (node.type === "skill" || node.type === "agent") {
      assertAllowedKeys(node, new Set(["type", "candidateRef", "label"]));
      return {
        type: node.type,
        candidateRef: stringField(
          node.candidateRef,
          `document.nodes[${index}].candidateRef`,
          { required: true, maxLength: 512 },
        ),
        label: stringField(node.label, `document.nodes[${index}].label`, {
          required: true,
          maxLength: 256,
        }),
      };
    }
    return { type: node.type };
  });
  if (textLength > 100_000) {
    throw new ApiError(
      400,
      "INVALID_COMPOSER_DOCUMENT",
      "Composer text cannot exceed 100000 characters",
    );
  }
  return { version: 1, nodes };
}

function parseComposerTurn(body) {
  assertAllowedKeys(body, new Set([
    "contractVersion",
    "revision",
    "document",
    "dangerFullAccessConfirmed",
    "attachments",
    "intent",
  ]));
  if (body.contractVersion !== "composer.v1") {
    throw new ApiError(
      400,
      "INVALID_COMPOSER_DOCUMENT",
      "'contractVersion' must be 'composer.v1'",
    );
  }
  if (
    body.dangerFullAccessConfirmed !== undefined
    && typeof body.dangerFullAccessConfirmed !== "boolean"
  ) {
    throw new ApiError(400, "INVALID_FIELD", "'dangerFullAccessConfirmed' must be a boolean");
  }
  return {
    contractVersion: "composer.v1",
    revision: stringField(body.revision, "revision", { required: true, maxLength: 512 }),
    document: parseComposerDocument(body.document),
    dangerFullAccessConfirmed: body.dangerFullAccessConfirmed,
    attachments: parseAiAttachments(body.attachments),
    ...(body.intent === undefined ? {} : { intent: parseComposerTurnIntent(body.intent) }),
  };
}

// Import fix F2: a turn started from the "import current project task status" button names the
// board skill explicitly, so the model cannot pick a similarly named skill from another board.
const COMPOSER_TURN_INTENTS = new Set(["taskboard-import"]);

function parseComposerTurnIntent(value) {
  if (typeof value !== "string" || !COMPOSER_TURN_INTENTS.has(value)) {
    throw new ApiError(400, "INVALID_FIELD", "'intent' must be 'taskboard-import'");
  }
  return value;
}

/**
 * SSE hub. DBG-05: a stream opened by a paired phone is bound to its session; before every write
 * (events and keep-alive) such a stream is re-validated with `isSessionActive(sessionId)` and
 * destroyed once the session is revoked, expired or mobile access is off. Local / LAN streams
 * (no session) are unaffected.
 */
export class EventHub {
  constructor({ isSessionActive = null } = {}) {
    this.clients = new Map();
    this.isSessionActive = isSessionActive;
    this.keepAlive = setInterval(() => {
      this.write(": keep-alive\n\n");
    }, 20_000);
    this.keepAlive.unref();
  }

  connect(request, response, { sessionId = null } = {}) {
    response.writeHead(200, {
      connection: "keep-alive",
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    response.write(": connected\n\n");
    this.clients.set(response, { sessionId: typeof sessionId === "string" && sessionId ? sessionId : null });
    request.once("close", () => this.clients.delete(response));
  }

  #authorized(client) {
    if (client.sessionId === null) return true;
    try {
      return typeof this.isSessionActive === "function" && this.isSessionActive(client.sessionId) === true;
    } catch {
      return false;
    }
  }

  /** Destroys every session-bound stream whose session is no longer valid; returns how many. */
  revalidate() {
    let dropped = 0;
    for (const [response, client] of this.clients) {
      if (this.#authorized(client)) continue;
      this.clients.delete(response);
      dropped += 1;
      try {
        response.destroy();
      } catch {
        // Already gone.
      }
    }
    return dropped;
  }

  write(message) {
    this.revalidate();
    for (const response of this.clients.keys()) response.write(message);
  }

  emit(type, value) {
    const event = {
      type,
      projectId: value.projectId ?? value.project?.id ?? value.task?.projectId,
      taskId: value.task?.id ?? value.comment?.taskId ?? value.attachment?.taskId,
      ...value,
      at: new Date().toISOString(),
    };
    this.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  close() {
    clearInterval(this.keepAlive);
    for (const response of this.clients.keys()) response.end();
    this.clients.clear();
  }
}

/** Amendment 13 (W12-C): handoff token shape accepted in the web manifest's start_url. */
const MANIFEST_HANDOFF_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

/**
 * Amendment 13: `/manifest.webmanifest?handoff=<token>` answers the static manifest with
 * `start_url: "./?handoff=<token>"`, so a home-screen web app saved right after pairing starts with its
 * single-use handoff token. The server only echoes a well-formed value; it validates nothing else here.
 */
export function manifestWithHandoff(manifestText, handoff) {
  const manifest = JSON.parse(manifestText);
  if (typeof handoff === "string" && MANIFEST_HANDOFF_PATTERN.test(handoff)) {
    manifest.start_url = `./?handoff=${handoff}`;
  }
  return JSON.stringify(manifest);
}

/** Files with a fixed name that change between releases must be revalidated (not `immutable`). */
function staticCacheControl(root, filename) {
  const relative = path.relative(root, filename).split(path.sep).join("/");
  if (relative === "index.html" || relative === "manifest.webmanifest" || relative.startsWith("icons/")) return "no-cache";
  return "public, max-age=31536000, immutable";
}

async function serveStatic(request, response, pathname, staticDirectory, searchParams = null) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    throw new ApiError(400, "INVALID_PATH", "URL path contains invalid encoding");
  }
  if (decodedPath.includes("\0")) {
    throw new ApiError(400, "INVALID_PATH", "URL path is invalid");
  }

  const root = path.resolve(staticDirectory);
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  let filename = path.resolve(root, relativePath);
  if (filename !== root && !filename.startsWith(`${root}${path.sep}`)) {
    throw new ApiError(400, "INVALID_PATH", "URL path is outside the static directory");
  }

  let fileStats;
  try {
    fileStats = await stat(filename);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!fileStats?.isFile() && !path.extname(relativePath)) {
    filename = path.join(root, "index.html");
    try {
      fileStats = await stat(filename);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!fileStats?.isFile()) return false;

  let body = await readFile(filename);
  let cacheControl = staticCacheControl(root, filename);
  if (path.relative(root, filename) === "manifest.webmanifest" && searchParams?.has("handoff")) {
    try {
      body = Buffer.from(manifestWithHandoff(body.toString("utf8"), searchParams.get("handoff")));
      cacheControl = "no-store";
    } catch {
      // A malformed manifest file is served unchanged.
    }
  }
  const headers = {
    "cache-control": cacheControl,
    "content-length": body.length,
    "content-type": CONTENT_TYPES.get(path.extname(filename).toLowerCase()) ?? "application/octet-stream",
  };
  response.writeHead(200, headers);
  response.end(request.method === "HEAD" ? undefined : body);
  return true;
}

function methodNotAllowed(response, allowed) {
  sendJson(response, 405, {
    error: { code: "METHOD_NOT_ALLOWED", message: `Allowed methods: ${allowed.join(", ")}` },
  }, { allow: allowed.join(", ") });
}

function codexProjectRoot(state, projectId) {
  if (!projectId || !state || typeof state !== "object") return null;
  const project = state["local-projects"]?.[projectId];
  const root = Array.isArray(project?.rootPaths) ? project.rootPaths[0] : null;
  return typeof root === "string" && root.trim() ? root : null;
}

async function readCodexProjectWorkspaces(codexStatePath) {
  try {
    const state = JSON.parse(await readFile(codexStatePath, "utf8"));
    const projects = state["local-projects"];
    if (!projects || typeof projects !== "object" || Array.isArray(projects)) return {};
    return Object.fromEntries(Object.keys(projects).flatMap((projectId) => {
      const root = codexProjectRoot(state, projectId);
      return root ? [[projectId, root]] : [];
    }));
  } catch {
    return {};
  }
}

function latestThreadCwd(value, threadId) {
  const matches = [];
  const stack = [value];
  while (stack.length > 0) {
    const candidate = stack.pop();
    if (!candidate || typeof candidate !== "object") continue;
    if (candidate.conversationId === threadId && typeof candidate.cwd === "string" && candidate.cwd.trim()) {
      matches.push(candidate);
    }
    stack.push(...(Array.isArray(candidate) ? candidate : Object.values(candidate)));
  }
  matches.sort((left, right) => Number(right.updatedAtMs ?? 0) - Number(left.updatedAtMs ?? 0));
  return matches[0]?.cwd ?? null;
}

async function resolveProjectWorkspace(project, codexProjectId, codexThreadId, codexStatePath, codexProcessesPath) {
  try {
    const state = JSON.parse(await readFile(codexStatePath, "utf8"));
    const assignment = state["thread-project-assignments"]?.[codexThreadId];
    const root = codexProjectRoot(state, project.id)
      ?? codexProjectRoot(state, codexProjectId)
      ?? codexProjectRoot(state, assignment?.projectId)
      ?? (typeof assignment?.cwd === "string" ? assignment.cwd : null);
    if (root) return root;
  } catch {}
  if (project.workspacePath) return project.workspacePath;
  if (!codexThreadId) return null;
  try {
    const processes = JSON.parse(await readFile(codexProcessesPath, "utf8"));
    return latestThreadCwd(processes, codexThreadId);
  } catch {
    return null;
  }
}

async function parseWorktrees(output) {
  const contexts = [];
  for (const block of output.trim().split(/\n\s*\n/)) {
    if (!block) continue;
    let worktreePath = "";
    let branch = null;
    let prunable = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) worktreePath = line.slice(9);
      if (line.startsWith("branch refs/heads/")) branch = line.slice(18);
      if (line.startsWith("prunable")) prunable = true;
    }
    if (!worktreePath || prunable) continue;
    try {
      await stat(worktreePath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    contexts.push({ type: "worktree", path: worktreePath, branch });
  }
  return contexts;
}

async function scanDevelopmentContexts(workspacePath, processEnv = process.env) {
  if (!workspacePath) return { workspacePath: null, contexts: [] };
  const environment = withoutTaskboardLauncherEnvironment(processEnv);
  try {
    const rootResult = await execFileAsync("git", ["-C", workspacePath, "rev-parse", "--show-toplevel"], {
      env: environment,
      timeout: 4_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const root = rootResult.stdout.trim();
    const [branchesResult, worktreesResult] = await Promise.all([
      execFileAsync("git", ["-C", root, "for-each-ref", "--format=%(refname:short)", "refs/heads"], {
        env: environment,
        timeout: 4_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }),
      execFileAsync("git", ["-C", root, "worktree", "list", "--porcelain"], {
        env: environment,
        timeout: 4_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }),
    ]);
    const branches = branchesResult.stdout.split("\n").map((branch) => branch.trim()).filter(Boolean);
    return {
      workspacePath: root,
      contexts: [
        ...branches.map((branch) => ({ type: "branch", branch })),
        ...(await parseWorktrees(worktreesResult.stdout)),
      ],
    };
  } catch {
    return { workspacePath, contexts: [] };
  }
}

// ---- v2 runs, automation and mobile access ----------------------

const RUN_PROVIDER_NAMES = Object.freeze(["claude", "codex"]);
const RUN_STOP_DESTINATIONS = new Set(["backlog", "todo", "canceled"]);
const SCHEDULER_AVAILABILITY_TTL_MS = 30_000;
// Total time app.close() waits for in-flight run work (before and after disposing providers). The
// desktop app force-quits the server about 5 s after asking it to stop, so the whole wait stays ≤ 4 s.
const RUN_SETTLE_ON_CLOSE_MS = 4_000;
const RUN_SETTLE_BEFORE_DISPOSE_MS = 3_000;
const ROUTE_AVAILABILITY_TTL_MS = 10_000;
const PROJECT_AUTOMATION_FIELDS = new Set([
  "enabled", "maxParallel", "claudeModel", "codexModel", "codexEffort", "orderMode", "claudePermissionMode",
]);
const MOBILE_ROUTE_PATTERN = /^\/api\/(?:local\/mobile-access(?:\/tailscale)?$|local\/pairing\/|pairing\/|sessions\/)/;
const QUIET_RUN_LOGGER = Object.freeze({
  info() {},
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
});
let claudeProviderMissingLogged = false;

/** C3 provider that can never run: `available()` reports why, `start` throws 409 PROVIDER_UNAVAILABLE. */
export function createUnavailableRunProvider(name, reason, detail = null) {
  const label = name === "claude" ? "Claude" : "Codex";
  const message = `${label} is unavailable (${reason})${detail ? `: ${detail}` : ""}`;
  return {
    name,
    async available() {
      return { ok: false, reason };
    },
    async start() {
      throw new ApiError(409, "PROVIDER_UNAVAILABLE", message);
    },
    async sendFollowup() {
      return { delivered: false, detail: message };
    },
    async stop() {
      return { stopped: false, detail: message };
    },
    async close() {},
    openUrl() {
      return null;
    },
    async recover() {
      return { status: "interrupted" };
    },
    async dispose() {},
  };
}

// Wraps a provider that is created asynchronously (dynamic import) behind the sync C3 surface.
function createDeferredRunProvider(name, load, fallbackReason) {
  let provider = null;
  const loading = Promise.resolve()
    .then(load)
    .catch((error) => createUnavailableRunProvider(name, fallbackReason, error?.message ?? String(error)))
    .then((loaded) => {
      provider = loaded;
      return loaded;
    });
  const forward = (method) => async (...args) => (await loading)[method](...args);
  return {
    name,
    ready: () => loading,
    available: forward("available"),
    start: forward("start"),
    sendFollowup: forward("sendFollowup"),
    stop: forward("stop"),
    close: forward("close"),
    recover: forward("recover"),
    openUrl(run) {
      return provider ? provider.openUrl(run) : null;
    },
    async dispose() {
      await (await loading).dispose();
    },
  };
}

/**
 * ConPTY helper for Claude follow-ups (INTEGRATION Amendment 3), first match wins:
 * 1. env `RELAY_CONPTY_HELPER`;
 * 2. the packaged Tauri resource `<resources>/bin/ConPtyAttachSend.exe` (the packaged server runs
 *    from `<resources>/app/server`, so that is `<projectRoot>/../bin`) when it exists;
 * 3. the dev build output `<repo>/src-tauri/resources/bin/ConPtyAttachSend.exe` (`npm run build:conpty`).
 */
export function resolveConptyHelperPath({ env = process.env, projectRoot = PROJECT_ROOT, exists = existsSync } = {}) {
  const configured = String(env.RELAY_CONPTY_HELPER ?? "").trim();
  if (configured) return path.resolve(configured);
  const packagedHelper = path.join(projectRoot, "..", "bin", "ConPtyAttachSend.exe");
  if (exists(packagedHelper)) return packagedHelper;
  return path.join(projectRoot, "src-tauri", "resources", "bin", "ConPtyAttachSend.exe");
}

/** Fixed Claude prompt-file directory (Amendment 3): `<dataDirectory>/claude-prompts`. */
export function claudePromptDirectory(dataDirectory) {
  return path.join(dataDirectory, "claude-prompts");
}

/**
 * Environment added to board-run AI child processes (W3 smoke bug 2): `CODEX_TASKBOARD_URL` is this
 * board's loopback base URL including the launcher instance-token prefix, so a skill that calls
 * `taskctl` (which reads CODEX_TASKBOARD_URL first) targets this board instead of the default port.
 * Empty until the server is listening.
 */
export function boardRunEnvironment({ port, routePrefix = "" } = {}) {
  if (!Number.isInteger(port) || port <= 0) return {};
  return { CODEX_TASKBOARD_URL: `http://127.0.0.1:${port}${routePrefix}` };
}

async function loadClaudeRunProvider({ importModule, onUpdate, promptDir, conptyHelperPath, extraEnv, logger }) {
  let module;
  try {
    module = await importModule();
  } catch (error) {
    if (!claudeProviderMissingLogged) {
      claudeProviderMissingLogged = true;
      logger.warn(`[runs] Claude provider is not installed (server/runs/claude-bg.mjs): ${error?.message ?? error}`);
    }
    return createUnavailableRunProvider("claude", "CLAUDE_PROVIDER_MISSING", error?.message ?? String(error));
  }
  if (typeof module?.createClaudeBgProvider !== "function") {
    return createUnavailableRunProvider("claude", "CLAUDE_PROVIDER_MISSING", "createClaudeBgProvider is not exported");
  }
  try {
    await mkdir(promptDir, { recursive: true });
    return module.createClaudeBgProvider({ onUpdate, logger, promptDir, conptyHelperPath, extraEnv });
  } catch (error) {
    logger.warn(`[runs] Claude provider could not be created: ${error?.message ?? error}`);
    return createUnavailableRunProvider("claude", "CLAUDE_PROVIDER_MISSING", error?.message ?? String(error));
  }
}

function createCodexVersionProbe(executable, processEnv) {
  return async () => {
    const command = executableCommand(executable, ["--version"]);
    const { stdout } = await execFileAsync(command.executable, command.args, {
      env: processEnv,
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    return String(stdout ?? "").trim() || null;
  };
}

/**
 * C5 prompt input with local file paths. Attachments are stored as <attachmentsDirectory>/<id>
 * (no extension). Task attachments keep `{ path, filename }`; DBG-09: every comment's own
 * attachments become `{ id, filename, localPath }` (shared/task-prompt.mjs prints them).
 */
export function taskPromptInput({ task, comments, attachments, attachmentsDirectory }) {
  return {
    task,
    comments: (Array.isArray(comments) ? comments : []).map((comment) => (
      comment && typeof comment === "object"
        ? {
          ...comment,
          attachments: (Array.isArray(comment.attachments) ? comment.attachments : [])
            .filter((attachment) => typeof attachment?.id === "string" && attachment.id)
            .map((attachment) => ({
              id: attachment.id,
              filename: attachment.filename,
              localPath: path.join(attachmentsDirectory, attachment.id),
            })),
        }
        : comment
    )),
    attachments: (attachments ?? []).map((attachment) => ({
      path: path.join(attachmentsDirectory, attachment.id),
      filename: attachment.filename,
    })),
  };
}

const CONTINUE_SOURCE_STATUSES = new Set(["in_review", "blocked"]);

/** DBG-08 follow-up: a run that reached an AI session (Claude short / session id or Codex thread id). */
export function runHasSessionRefs(run) {
  return Boolean(run && (run.claudeSessionId || run.claudeShortId || run.codexThreadId));
}

export const REWORK_REQUIRED_MESSAGE = "上一次沒有成功開工，請改用「退回重做」";

/**
 * DBG-08 / BLUEPRINT §4.2: moving an AI card that already ran from in_review / blocked back to
 * in_progress must continue the same AI session with a message (POST /api/tasks/:id/continue).
 * A plain move / PATCH would only change the column (no run, no provider call), so it is refused
 * with 409 CONTINUE_MESSAGE_REQUIRED before anything is written. When the latest run never reached
 * an AI session (no Claude / Codex refs, e.g. the launch failed) there is nothing to continue: the
 * refusal is 409 REWORK_REQUIRED (send the card back for rework instead). `assignees` lists the
 * current and any requested assignee; a run that is still active (the agent reporting its own
 * status) is not affected.
 */
export function assertNoSilentContinue({ task, status, assignees = [task?.assignee], activeRun = null, latestRun = null }) {
  if (!task || task.archivedAt || status !== "in_progress") return;
  if (!CONTINUE_SOURCE_STATUSES.has(task.status) || activeRun || !latestRun) return;
  if (!assignees.some((assignee) => providerForAssignee(assignee))) return;
  if (!runHasSessionRefs(latestRun)) {
    throw new ApiError(409, "REWORK_REQUIRED", REWORK_REQUIRED_MESSAGE);
  }
  throw new ApiError(
    409,
    "CONTINUE_MESSAGE_REQUIRED",
    "Moving this AI task back to in_progress continues the AI session; send a message with POST /api/tasks/:id/continue",
  );
}

/**
 * C6 move/patch rule: which run action a status change implies.
 * todo → in_progress for an agent assignee starts a run; in_progress → backlog/todo/canceled
 * with an active run stops it first. Everything else is a plain status change.
 */
export function runTransitionForStatusChange({
  task,
  status,
  assignee = task?.assignee,
  activeRun = null,
  actor = null,
}) {
  if (!task || task.archivedAt || status === undefined || status === task.status) return null;
  if (task.status === "todo" && status === "in_progress" && providerForAssignee(assignee)) return "start";
  if (task.status === "in_progress" && activeRun) {
    if (RUN_STOP_DESTINATIONS.has(status)) return "stop";
    // Review fix: a person moving a running card out of in_progress (done / in_review / blocked)
    // stops the AI too, so it is not left working unattended. An agent's own status change does not.
    if (actor?.type !== "agent") return "stop";
  }
  return null;
}

/** DBG-01: Tailscale / CGNAT source address 100.64.0.0/10 (plain or IPv4-mapped IPv6). */
export function isTailnetAddress(address) {
  if (typeof address !== "string") return false;
  const candidate = address.toLowerCase().replace(/^::ffff:/, "");
  if (isIP(candidate) !== 4) return false;
  const [first, second] = candidate.split(".").map(Number);
  return first === 100 && second >= 64 && second <= 127;
}

/**
 * DBG-01: a card the scheduler may claim — not archived, in todo, assigned to an AI agent.
 * Dependency blocks are ignored on purpose (a blocked card becomes claimable once they close).
 */
export function isAutoClaimEligibleTask(task) {
  return Boolean(task && !task.archivedAt && task.status === "todo" && providerForAssignee(task.assignee));
}

function isMobileAccessEnabled(mobileAccess) {
  try {
    if (typeof mobileAccess?.isEnabled === "function") return mobileAccess.isEnabled() === true;
    if (typeof mobileAccess?.settings === "function") return mobileAccess.settings()?.enabled === true;
  } catch {
    return false;
  }
  return false;
}

/**
 * C7 remote boundary: a request is a mobile (tailnet) request when it arrived on the dedicated
 * tailnet listener, or — only while mobile access is enabled — when a non-loopback request comes
 * from a tailnet source address (100.64.0.0/10) or carries the enabled tailnet Host/Origin.
 * Everything else (plain private LAN, and tailnet/CGNAT peers while mobile access is off) keeps the
 * upstream private-network rules, which still cannot start or queue AI work (DBG-01).
 */
export function isMobileRemoteRequest(request, { listenerKind = "main", mobileAccess = null } = {}) {
  if (listenerKind === "tailnet") return true;
  const remoteAddress = request?.socket?.remoteAddress;
  if (!mobileAccess || isExactLoopbackAddress(remoteAddress)) return false;
  // The trusted tailnet Host only exists while mobile access is enabled.
  if (mobileAccess.isTrustedRemoteHost?.(request)) return true;
  // DBG-01 anti-spoof: while mobile access is enabled, a tailnet peer is a mobile request whatever
  // Host it sends, so a forged private-LAN Host cannot downgrade it to plain LAN rules.
  return isTailnetAddress(remoteAddress) && isMobileAccessEnabled(mobileAccess);
}

/**
 * Review fix (security): routes that launch or steer an AI run (run/start, run/stop, followup,
 * continue, rework, the start/stop side effects of move/PATCH/archive, automation PUT) are only
 * reachable from this device (loopback) or from a paired phone. A plain private-LAN client or a
 * configured trusted origin cannot start AI work, matching the upstream loopback-only AI routes.
 */
export function assertRunControlRequest(request, { mobilePrincipal = null, configuredTrustedRequest = false } = {}) {
  if (configuredTrustedRequest) {
    throw new ApiError(409, "LOCAL_COMPANION_REQUIRED", "AI runs require a device-local Taskboard origin");
  }
  if (mobilePrincipal) return;
  if (!isLoopbackAddress(request?.socket?.remoteAddress)) {
    throw new ApiError(
      403,
      "LOCAL_AI_LOOPBACK_REQUIRED",
      "AI runs can only be started or controlled from this device or a paired phone",
    );
  }
}

/**
 * Amendment 11 (F4): imported cards keep "done"; every other source status (pending, in progress,
 * in review, blocked, canceled) lands in backlog, so an import never queues or starts AI work.
 */
export function importedTaskStatus(requestedStatus) {
  return requestedStatus === "done" ? "done" : "backlog";
}

/**
 * Amendment 11 (F4): POST /api/tasks/import is reachable only from this device through taskctl.
 */
export function assertTaskImportRequest(request, {
  mobileRemote = false,
  mobilePrincipal = null,
  configuredTrustedRequest = false,
} = {}) {
  if (mobileRemote || mobilePrincipal || configuredTrustedRequest || !isExactLoopbackAddress(request?.socket?.remoteAddress)) {
    throw new ApiError(403, "IMPORT_LOOPBACK_REQUIRED", "Task import is only available from this device");
  }
  if (request.headers?.["x-taskboard-client"] !== "taskctl") {
    throw new ApiError(403, "IMPORT_TASKCTL_REQUIRED", "Task import must be sent by taskctl");
  }
}

/**
 * DBG-01: a write that queues a card for auto-claim (or changes a queued card) needs the same
 * authorization as a direct start, but tells the client why with its own code and copy.
 */
export function assertAutoClaimWriteRequest(request, options = {}) {
  try {
    assertRunControlRequest(request, options);
  } catch (error) {
    if (error?.code === "LOCAL_AI_LOOPBACK_REQUIRED") {
      throw new ApiError(
        403,
        "AUTO_CLAIM_WRITE_REQUIRES_LOCAL",
        "這張卡已排入 AI 自動處理；只能在這台電腦或已配對的手機上建立或修改",
      );
    }
    throw error;
  }
}

/** C7: remote `/api/*` requests need a paired session; other paths (web UI assets) do not. */
export function assertMobileRemoteAuthorized(request, pathname, mobileAccess) {
  if (!pathname.startsWith("/api/")) return null;
  const principal = mobileAccess?.authorize(request) ?? null;
  if (!principal) {
    throw new ApiError(401, "PAIRING_REQUIRED", "This device is not paired with the taskboard");
  }
  return principal;
}

async function readOptionalJsonObject(request, allowedKeys) {
  const raw = await readBody(request, JSON_BODY_LIMIT, "Request body cannot exceed 1 MiB");
  if (raw.length === 0) return {};
  const contentType = request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must contain valid JSON");
  }
  assertPlainObject(body);
  assertAllowedKeys(body, allowedKeys);
  return body;
}

function versionConflict(task, version) {
  return new ApiError(409, "VERSION_CONFLICT", "Task changed since it was last read", {
    expectedVersion: version,
    actualVersion: task.version,
  });
}

export function resolveServerOptions(options = {}) {
  const environment = options.processEnv ?? process.env;
  const configuredDataDirectory = options.dataDirectory ?? environment.CODEX_TASKBOARD_DATA_DIR;
  const dataDirectory = configuredDataDirectory
    ? path.resolve(configuredDataDirectory)
    : path.join(PROJECT_ROOT, ".data");
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const instanceToken = String(
    options.instanceToken ?? environment.CODEX_TASKBOARD_INSTANCE_TOKEN ?? "",
  ).trim();
  if (instanceToken && !/^[a-z0-9-]{16,128}$/i.test(instanceToken)) {
    throw new Error("CODEX_TASKBOARD_INSTANCE_TOKEN must be an identifier");
  }
  const instanceSecret = String(
    options.instanceSecret ?? environment.CODEX_TASKBOARD_INSTANCE_SECRET ?? "",
  ).trim();
  if (instanceToken && !/^[a-f0-9-]{32,128}$/i.test(instanceSecret)) {
    throw new Error("CODEX_TASKBOARD_INSTANCE_SECRET must be set in launcher mode");
  }
  return {
    dataDirectory,
    databasePath: options.databasePath ?? path.join(dataDirectory, "taskboard.sqlite"),
    attachmentsDirectory: options.attachmentsDirectory ?? path.join(dataDirectory, "attachments"),
    cloudConfigPath: options.cloudConfigPath ?? path.join(dataDirectory, "cloud-companion.json"),
    jiraConfigPath: options.jiraConfigPath ?? path.join(dataDirectory, "jira-connection.json"),
    clientStoragePath: options.clientStoragePath ?? path.join(dataDirectory, "client-storage.json"),
    staticDirectory: options.staticDirectory ?? path.join(PROJECT_ROOT, "dist", "web"),
    skillPath: options.skillPath
      ?? environment.CODEX_TASKBOARD_SKILL_PATH
      ?? path.join(PROJECT_ROOT, "skills", "manage-automate-taskboard", "SKILL.md"),
    codexExecutable: resolveCodexExecutable({ explicit: options.codexExecutable }),
    codexStatePath: options.codexStatePath
      ?? path.join(codexHome, ".codex-global-state.json"),
    codexProcessesPath: options.codexProcessesPath
      ?? path.join(codexHome, "process_manager", "chat_processes.json"),
    instanceToken,
    instanceSecret,
    trustedOrigins: parseTrustedOrigins(environment[TRUSTED_ORIGINS_ENV]),
    version: String(
      options.version ?? environment.CODEX_TASKBOARD_VERSION ?? "development",
    ).trim(),
  };
}

export function resolvePort(value = process.env.CODEX_TASKBOARD_PORT ?? "47833") {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CODEX_TASKBOARD_PORT must be an integer between 1 and 65535");
  }
  return port;
}

export function resolveHost(value = process.env.CODEX_TASKBOARD_HOST ?? "0.0.0.0") {
  const host = String(value).trim();
  if (host !== "127.0.0.1" && host !== "0.0.0.0") {
    throw new Error("CODEX_TASKBOARD_HOST must be 127.0.0.1 or 0.0.0.0");
  }
  return host;
}

export function createTaskboardServer(options = {}) {
  const resolved = resolveServerOptions(options);
  const codexProcessEnvironment = withoutTaskboardLauncherEnvironment(
    options.processEnv ?? process.env,
  );
  const routePrefix = resolved.instanceToken ? `/${resolved.instanceToken}` : "";
  const database = new TaskboardDatabase(resolved.databasePath);
  // W15: native folder dialog for project folders (injectable for tests).
  const folderPicker = options.folderPicker ?? createFolderPicker();
  // DBG-05: session-bound streams stay open only while mobile access accepts their session.
  const events = new EventHub({ isSessionActive: (sessionId) => Boolean(mobileAccess?.isSessionActive?.(sessionId)) });
  let clientStorageWrite = Promise.resolve();

  async function readClientStorage() {
    try {
      const value = JSON.parse(await readFile(resolved.clientStoragePath, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  function parseClientStorageUpdate(body) {
    assertPlainObject(body);
    assertAllowedKeys(body, new Set(["key", "value"]));
    const key = stringField(body.key, "key", { required: true, maxLength: 512 });
    const value = stringField(body.value, "value", { nullable: true, maxLength: 100_000 });
    return { key, value };
  }

  async function updateClientStorage({ key, value }) {
    clientStorageWrite = clientStorageWrite.catch(() => {}).then(async () => {
      const entries = await readClientStorage();
      if (value === null) delete entries[key];
      else entries[key] = value;
      await mkdir(path.dirname(resolved.clientStoragePath), { recursive: true });
      const temporaryPath = `${resolved.clientStoragePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(entries)}\n`, { mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, resolved.clientStoragePath);
      await chmod(resolved.clientStoragePath, 0o600);
    });
    await clientStorageWrite;
  }
  const cloudConfig = options.cloudConfigStore ?? createCloudConfigStore({
    configPath: resolved.cloudConfigPath,
  });
  const jiraConfig = options.jiraConfigStore ?? createJiraConfigStore({
    configPath: resolved.jiraConfigPath,
  });
  const jira = createJiraIntegration({
    configStore: jiraConfig,
    database,
    fetch: options.jiraFetch ?? globalThis.fetch,
  });
  let hostRuntime = null;
  function currentHostThreadBinding(threadId) {
    if (
      !hostRuntime
      || hostRuntime.threadId !== threadId
      || !hostRuntime.codexProjectId
      || !hostRuntime.codexProjectKind
      || !hostRuntime.codexHostId
      || !hostRuntime.workspacePath
    ) return undefined;
    return {
      threadId,
      codexProjectId: hostRuntime.codexProjectId,
      codexProjectKind: hostRuntime.codexProjectKind,
      codexHostId: hostRuntime.codexHostId,
      workspacePath: hostRuntime.workspacePath,
    };
  }
  function resolveInputThreadBinding(input) {
    if (input.threadBinding !== undefined) return input;
    const threadBinding = currentHostThreadBinding(input.threadId);
    return threadBinding ? { ...input, threadBinding } : input;
  }
  const cloudProxy = createCloudProxy({
    configStore: cloudConfig,
    fetch: options.remoteFetch ?? globalThis.fetch,
    resolveThreadBinding: currentHostThreadBinding,
    resolveDevelopmentContext: async (projectId, context, scans) => {
      if (!context.branch) return null;
      const config = await cloudConfig.read();
      const workspacePath = config.projectMappings[projectId];
      if (!workspacePath) return null;
      const key = `${projectId}\0${workspacePath}`;
      if (!scans.has(key)) {
        scans.set(key, scanDevelopmentContexts(workspacePath, codexProcessEnvironment));
      }
      const result = await scans.get(key);
      return result.contexts.find((candidate) => (
        candidate.type === "worktree" && candidate.branch === context.branch
      )) ?? null;
    },
    assertTaskProjectMoveAllowed: (taskId, targetProjectId) => {
      if (!database.hasAiChatThreadProjectConflict(taskId, targetProjectId)) return;
      throw new CloudProxyError(
        409,
        "AI_CHAT_PROJECT_MOVE_BLOCKED",
        "Delete issue-linked AI conversations before moving the issue to another project",
      );
    },
  });
  async function readCloudJson(pathname) {
    const upstream = await cloudProxy.forward(new Request(`http://127.0.0.1${pathname}`, {
      headers: { accept: "application/json" },
    }));
    let payload;
    try {
      payload = await upstream.json();
    } catch {
      throw new ApiError(
        upstream.ok ? 502 : upstream.status,
        "INVALID_CLOUD_RESPONSE",
        "Cloud taskboard returned an invalid JSON response",
      );
    }
    if (!upstream.ok) {
      throw new ApiError(
        upstream.status,
        payload?.error?.code ?? "CLOUD_REQUEST_FAILED",
        payload?.error?.message ?? "Cloud taskboard request failed",
        payload?.error?.details,
      );
    }
    return payload;
  }

  async function resolveAiChatContext(projectId, issueId, codexTarget) {
    const config = await cloudConfig.read();
    if (!config.remoteUrl) {
      if (codexTarget?.codexProjectKind === "remote") {
        const project = database.getProject(projectId);
        if (!project) {
          throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
        }
        let issue;
        if (issueId !== undefined) {
          issue = database.getTask(issueId);
          if (!issue || issue.projectId !== projectId || issue.archivedAt != null) {
            throw new ApiError(
              404,
              "AI_CHAT_ISSUE_NOT_FOUND",
              `Task '${issueId}' is not an active task in project '${projectId}'`,
            );
          }
        }
        return { project, issue, addDirectories: [], ...codexTarget };
      }
      let resolvedWorkspace;
      try {
        resolvedWorkspace = await resolveAiWorkspace(
          projectId,
          resolved.codexStatePath,
          database,
        );
      } catch (error) {
        if (
          !(error instanceof ApiError)
          || error.code !== "PROJECT_WORKSPACE_UNAVAILABLE"
          || projectId !== DEFAULT_PROJECT_ID
        ) {
          throw error;
        }
        resolvedWorkspace = {
          workspacePath: PROJECT_ROOT,
          addDirectories: [],
          project: database.getProject(projectId),
        };
      }
      let issue;
      if (issueId !== undefined) {
        issue = database.getTask(issueId);
        if (!issue || issue.projectId !== projectId || issue.archivedAt != null) {
          throw new ApiError(
            404,
            "AI_CHAT_ISSUE_NOT_FOUND",
            `Task '${issueId}' is not an active task in project '${projectId}'`,
          );
        }
      }
      return { ...resolvedWorkspace, issue };
    }

    const projectPayload = await readCloudJson("/api/projects");
    const project = Array.isArray(projectPayload.projects)
      ? projectPayload.projects.find((candidate) => candidate?.id === projectId)
      : null;
    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }

    let issue;
    if (issueId !== undefined) {
      const issuePayload = await readCloudJson(`/api/tasks/${encodeURIComponent(issueId)}`);
      issue = issuePayload.task;
      if (!issue || issue.projectId !== projectId || issue.archivedAt != null) {
        throw new ApiError(
          404,
          "AI_CHAT_ISSUE_NOT_FOUND",
          `Task '${issueId}' is not an active task in project '${projectId}'`,
        );
      }
    }

    if (codexTarget?.codexProjectKind === "remote") {
      return { project, issue, addDirectories: [], ...codexTarget };
    }

    const resolvedWorkspace = await resolveMappedAiWorkspace(
      projectId,
      project,
      config.projectMappings,
    );
    return { ...resolvedWorkspace, issue };
  }

  // Read at spawn time: providers and the AI chat app-server start children only after the board
  // is listening.
  const runChildEnvironment = () => boardRunEnvironment({ port: listenPort, routePrefix });
  const aiChat = new AiChatService({
    database,
    appServerExtraEnv: runChildEnvironment,
    codexExecutable: resolved.codexExecutable,
    codexStatePath: resolved.codexStatePath,
    manageTaskboardSkillPath: resolved.skillPath,
    processEnv: codexProcessEnvironment,
    resolveContext: resolveAiChatContext,
    remoteAppServerFactory: options.remoteAppServerFactory,
  });
  const projectSummary = new ProjectSummaryService({
    database,
    codexExecutable: resolved.codexExecutable,
    processEnv: codexProcessEnvironment,
    workspacePath: PROJECT_ROOT,
  });

  // ---- v2 runs (C3/C4), scheduler (C5), task JSON (C6) ----------------------------------------
  function withRunState(task) {
    if (!task || typeof task !== "object" || typeof task.id !== "string") return task;
    try {
      return {
        ...task,
        activeRun: database.getActiveRun(task.id),
        latestRun: database.getLatestRun(task.id),
      };
    } catch {
      return { ...task, activeRun: null, latestRun: null };
    }
  }

  // Every event payload that carries a task gets the same activeRun/latestRun fields as the API.
  const emitHubEvent = events.emit.bind(events);
  events.emit = (type, value) => {
    const payload = value && typeof value === "object" && value.task && typeof value.task === "object"
      ? { ...value, task: withRunState(value.task) }
      : value;
    // DBG-05: a pairing change (revoke from desktop or phone, mobile access turned off) drops the
    // affected streams right away, before this event is written.
    if (type === MOBILE_ACCESS_EVENT) events.revalidate();
    emitHubEvent(type, payload);
    if (type === MOBILE_ACCESS_EVENT) void scheduleTailnetSync();
  };

  const runLogger = options.runLogger ?? QUIET_RUN_LOGGER;
  // Amendment 6: which permission mode Claude Code's own settings select for a project folder.
  const detectClaudePermission = typeof options.claudePermissionDetector === "function"
    ? options.claudePermissionDetector
    : ({ cwd }) => detectClaudePermissionMode({ cwd, env: options.processEnv ?? process.env });
  let runService = null;
  const onProviderUpdate = (runId, update) => runService.handleProviderUpdate(runId, update);
  const runProviders = options.runProviders
    ? { ...options.runProviders }
    : {
      codex: createCodexAppProvider({
        // A dedicated app-server: AiChatService.close() must not tear down board runs.
        appServerFactory: () => new CodexAppServer({
          executable: resolved.codexExecutable,
          processEnv: codexProcessEnvironment,
          extraEnv: runChildEnvironment,
        }),
        onUpdate: onProviderUpdate,
        codexVersion: createCodexVersionProbe(resolved.codexExecutable, codexProcessEnvironment),
        logger: runLogger,
      }),
      claude: createDeferredRunProvider("claude", () => loadClaudeRunProvider({
        importModule: options.loadClaudeProviderModule ?? (() => import("./runs/claude-bg.mjs")),
        onUpdate: onProviderUpdate,
        promptDir: claudePromptDirectory(resolved.dataDirectory),
        conptyHelperPath: resolveConptyHelperPath({ env: options.processEnv ?? process.env }),
        extraEnv: runChildEnvironment,
        logger: runLogger,
      }), "CLAUDE_PROVIDER_MISSING"),
    };
  // Test seam: receives the C5 prompt input (with local attachment paths) instead of buildTaskPrompt.
  const taskPromptBuilder = typeof options.taskPromptBuilder === "function" ? options.taskPromptBuilder : buildTaskPrompt;
  // Test seam: clock and timer used to bound the run settle wait in close().
  const closeClock = {
    now: typeof options.closeClock?.now === "function" ? options.closeClock.now : Date.now,
    setTimeout: typeof options.closeClock?.setTimeout === "function" ? options.closeClock.setTimeout : setTimeout,
    clearTimeout: typeof options.closeClock?.clearTimeout === "function" ? options.closeClock.clearTimeout : clearTimeout,
  };
  runService = createRunService({
    database,
    providers: runProviders,
    emit: (type, payload) => events.emit(type, payload),
    buildPrompt: ({ task, comments, attachments }) => taskPromptBuilder(taskPromptInput({
      task,
      comments,
      attachments,
      attachmentsDirectory: resolved.attachmentsDirectory,
    })),
    logger: runLogger,
    detectClaudePermission,
  });

  // GET /api/projects/:id/automation extras (Amendment 6); never fails the automation response.
  async function claudePermissionPreview(projectId) {
    const workspacePath = database.getProject(projectId)?.workspacePath;
    try {
      const detection = await detectClaudePermission({
        cwd: typeof workspacePath === "string" && workspacePath.trim() ? workspacePath : null,
      });
      const source = detection?.source?.scope
        ? {
          scope: detection.source.scope,
          path: detection.source.path ?? null,
          configuredMode: detection.source.configuredMode ?? null,
        }
        : null;
      return {
        claudeEffectivePermissionMode: source ? detection.effectiveMode ?? null : null,
        claudePermissionSource: source,
      };
    } catch (error) {
      runLogger.warn?.(`[runs] reading Claude settings for project ${projectId} failed: ${error?.message ?? error}`);
      return { claudeEffectivePermissionMode: null, claudePermissionSource: null };
    }
  }

  const providerAvailabilityCache = new Map();
  function providerAvailability(name, maxAgeMs) {
    const cached = providerAvailabilityCache.get(name);
    if (cached && Date.now() - cached.at < maxAgeMs) return cached.promise;
    const provider = runProviders[name];
    const promise = (async () => {
      if (!provider) return { ok: false, reason: "PROVIDER_NOT_CONFIGURED" };
      try {
        const result = await provider.available();
        return {
          ok: result?.ok === true,
          ...(typeof result?.reason === "string" ? { reason: result.reason } : {}),
          ...(typeof result?.version === "string" ? { version: result.version } : {}),
        };
      } catch (error) {
        return { ok: false, reason: error?.message ?? String(error) };
      }
    })();
    providerAvailabilityCache.set(name, { at: Date.now(), promise });
    return promise;
  }

  const enableScheduler = options.enableScheduler !== false;
  let schedulerStarted = false;
  const scheduler = createScheduler({
    listEnabledAutomations: () => database.listEnabledAutomations(),
    countActiveRuns: (projectId) => database.listActiveRuns({ projectId }).length,
    listTodoTasks: (projectId) => database.listTasks({ projectId, status: "todo", archived: "false" }),
    // Auto-claim acts as the task's assignee agent; unavailable providers are skipped (task stays todo).
    startTask: async (taskId) => {
      const task = database.getTask(taskId);
      const providerName = providerForAssignee(task?.assignee);
      if (!task || !providerName) {
        throw new ApiError(409, "ASSIGNEE_NOT_AGENT", `Task '${taskId}' is not assigned to an AI agent`);
      }
      const availability = await providerAvailability(providerName, SCHEDULER_AVAILABILITY_TTL_MS);
      if (!availability.ok) {
        throw new ApiError(409, "PROVIDER_UNAVAILABLE", `${providerName}: ${availability.reason ?? "unavailable"}`);
      }
      // DBG-06/07: the availability check may have awaited a `--version` child, so the tick's
      // automation snapshot and active-run count can be stale. Re-read both here; from this point
      // to createRun inside runService.startTask everything is synchronous (no other request can
      // interleave). Manual starts do not pass through here and stay unlimited (D9).
      const fresh = database.getTask(task.id);
      if (!fresh || providerForAssignee(fresh.assignee) !== providerName) {
        throw new ApiError(409, "ASSIGNEE_NOT_AGENT", `Task '${taskId}' is no longer assigned to ${providerName}`);
      }
      const automation = database.getProjectAutomation(fresh.projectId);
      if (!automation?.enabled) {
        throw new ApiError(409, "AUTOMATION_DISABLED", `Auto-claim is turned off for project '${fresh.projectId}'`);
      }
      if (database.listActiveRuns({ projectId: fresh.projectId }).length >= automation.maxParallel) {
        throw new ApiError(409, "PARALLEL_LIMIT_REACHED", `Project '${fresh.projectId}' already runs ${automation.maxParallel} AI task(s)`);
      }
      // A dependency added during the await (the tick's todo snapshot predates it) blocks the claim too.
      if (isBlockedByOpenDependency(fresh)) {
        throw new ApiError(409, "TASK_BLOCKED_BY_DEPENDENCY", `Task '${fresh.identifier}' is blocked by an open dependency`);
      }
      return runService.startTask({ taskId: fresh.id, actor: agentActorForProvider(providerName) });
    },
    logger: runLogger,
  });
  function nudgeScheduler() {
    if (!schedulerStarted || closing) return;
    scheduler.tick().catch((error) => runLogger.warn(`[scheduler] tick failed: ${error?.message ?? error}`));
  }

  function emitAutomation(projectId, automation) {
    events.emit("project.automation.updated", { projectId, automation });
  }

  // Dragging a card inside todo while the project uses the suggested order switches it to manual.
  function switchToManualOrder(projectId) {
    try {
      if (database.getProjectAutomation(projectId).orderMode !== "suggested") return;
      emitAutomation(projectId, database.updateProjectAutomation(projectId, { orderMode: "manual" }));
    } catch (error) {
      runLogger.warn(`[runs] could not switch project ${projectId} to manual order: ${error?.message ?? error}`);
    }
  }

  // ---- v2 mobile access (C7): pairing + tailnet listener ----------------------------------------
  let mobileAccess = null;
  let pairingSessions = null;
  let tailnetServer = null;
  let tailnetBoundAddress = null;
  let tailnetLastWarning = null;
  let tailnetSync = Promise.resolve();
  let listenPort = null;
  let closing = false;
  let startupTask = null;

  function initMobileAccess(port) {
    if (mobileAccess || options.mobileAccess === false) return;
    try {
      mobileAccess = createMobileAccess({
        database,
        dataDirectory: resolved.dataDirectory,
        port,
        emitHub: events,
        logger: console,
        ...(options.mobileAccessOptions ?? {}),
      });
      pairingSessions = new MobilePairingService(database.database);
    } catch (error) {
      mobileAccess = null;
      pairingSessions = null;
      console.error(`[mobile-access] disabled: ${error?.code ? `${error.code}: ` : ""}${error?.message ?? error}`);
    }
  }

  function closeTailnetListener() {
    const current = tailnetServer;
    tailnetServer = null;
    tailnetBoundAddress = null;
    if (!current) return Promise.resolve();
    return new Promise((resolve) => {
      current.close(() => resolve());
      current.closeAllConnections?.();
    });
  }

  async function syncTailnetListenerNow() {
    if (!mobileAccess || closing || listenPort === null) return closeTailnetListener();
    const address = mobileAccess.settings().enabled ? await mobileAccess.tailnetAddress() : null;
    if (closing || !address) return closeTailnetListener();
    if (tailnetServer && tailnetBoundAddress === address) return undefined;
    await closeTailnetListener();
    const candidate = createServer((request, response) => handleHttpRequest(request, response, "tailnet"));
    try {
      await new Promise((resolve, reject) => {
        candidate.once("error", reject);
        candidate.listen(listenPort, address, () => {
          candidate.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      const warning = `[mobile-access] cannot listen on http://${address}:${listenPort}: ${error?.message ?? error}`;
      if (warning !== tailnetLastWarning) console.warn(warning);
      tailnetLastWarning = warning;
      return undefined;
    }
    tailnetLastWarning = null;
    if (closing) {
      await new Promise((resolve) => candidate.close(() => resolve()));
      return undefined;
    }
    tailnetServer = candidate;
    tailnetBoundAddress = address;
    console.log(`AutoMate Taskboard mobile access listening on http://${address}:${listenPort}`);
    return undefined;
  }

  function scheduleTailnetSync() {
    tailnetSync = tailnetSync
      .catch(() => {})
      .then(() => syncTailnetListenerNow())
      .catch((error) => console.warn(`[mobile-access] listener update failed: ${error?.message ?? error}`));
    return tailnetSync;
  }

  const aiEventResponses = new Set();
  const codexSessionSearches = new Map();
  const codexSessionStateCache = new Map();
  const codexSessionsDirectory = path.join(path.dirname(resolved.codexStatePath), "sessions");

  async function findCodexSession(threadId) {
    const cached = codexSessionSearches.get(threadId);
    if (cached && (cached.path || Date.now() - cached.checkedAt < 5_000)) return cached.path;

    const suffix = `-${threadId}.jsonl`;
    const directories = [codexSessionsDirectory];
    while (directories.length > 0) {
      const directory = directories.pop();
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          directories.push(entryPath);
        } else if (entry.isFile() && entry.name.endsWith(suffix)) {
          codexSessionSearches.set(threadId, { path: entryPath, checkedAt: Date.now() });
          return entryPath;
        }
      }
    }

    codexSessionSearches.set(threadId, { path: null, checkedAt: Date.now() });
    return null;
  }

  async function readCodexSessionState(threadId) {
    const sessionPath = await findCodexSession(threadId);
    if (!sessionPath) return null;

    const sessionStat = await stat(sessionPath);
    const cached = codexSessionStateCache.get(sessionPath);
    if (cached?.size === sessionStat.size && cached.mtimeMs === sessionStat.mtimeMs) {
      return cached.state;
    }

    const length = Math.min(sessionStat.size, CODEX_PLAN_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const handle = await open(sessionPath, "r");
    try {
      await handle.read(buffer, 0, length, sessionStat.size - length);
    } finally {
      await handle.close();
    }

    const lines = buffer.toString("utf8").split("\n");
    if (length < sessionStat.size) lines.shift();
    const records = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {}
    }

    let runningTurnId = null;
    for (const record of records) {
      const payload = record?.payload;
      if (record?.type !== "event_msg" || typeof payload?.turn_id !== "string") continue;
      if (payload.type === "task_started") runningTurnId = payload.turn_id;
      if (
        (payload.type === "task_complete" || payload.type === "turn_aborted")
        && payload.turn_id === runningTurnId
      ) {
        runningTurnId = null;
      }
    }

    let progress = null;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      const payload = record?.payload;
      if (payload?.type !== "custom_tool_call" || typeof payload.input !== "string") continue;

      let statuses = [];
      if (payload.name === "update_plan") {
        try {
          const input = JSON.parse(payload.input);
          statuses = Array.isArray(input.plan)
            ? input.plan.map((item) => item?.status).filter(Boolean)
            : [];
        } catch {}
      } else if (payload.name === "exec") {
        const callIndex = payload.input.lastIndexOf("tools.update_plan(");
        if (callIndex < 0) continue;
        statuses = [...payload.input.slice(callIndex).matchAll(
          /["']?status["']?\s*:\s*["'](completed|in_progress|pending)["']/g,
        )].map((match) => match[1]);
      }

      if (statuses.length > 0) {
        progress = {
          completed: statuses.filter((status) => status === "completed").length,
          total: statuses.length,
        };
        break;
      }
    }

    const state = {
      completed: progress?.completed ?? null,
      total: progress?.total ?? null,
      running: runningTurnId !== null,
    };
    codexSessionStateCache.set(sessionPath, {
      size: sessionStat.size,
      mtimeMs: sessionStat.mtimeMs,
      state,
    });
    return state;
  }

  async function handleHttpRequest(request, response, listenerKind) {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    try {
      const incomingUrl = new URL(request.url, "http://127.0.0.1");
      // C7: phones reach the board over the tailnet; they are authorized by device pairing, the
      // phone URL carries no launcher instance token, and upstream LAN trust does not apply.
      const mobileRemote = isMobileRemoteRequest(request, { listenerKind, mobileAccess });
      if (resolved.instanceToken && !mobileRemote && incomingUrl.pathname !== "/health") {
        if (incomingUrl.pathname === routePrefix) {
          response.writeHead(301, { location: `${incomingUrl.pathname}/${incomingUrl.search}` });
          response.end();
          return;
        }
        if (
          incomingUrl.pathname !== routePrefix
          && !incomingUrl.pathname.startsWith(`${routePrefix}/`)
        ) {
          throw new ApiError(404, "NOT_FOUND", "Route not found");
        }
        request.url = `${incomingUrl.pathname.slice(routePrefix.length) || "/"}${incomingUrl.search}`;
      }

      if (mobileRemote && !mobileAccess?.isTrustedRemoteHost(request)) {
        throw new ApiError(403, "INVALID_HOST", "Request Host is not the approved mobile access origin");
      }
      const configuredTrustedRequest = mobileRemote
        ? false
        : assertTrustedNetworkRequest(
          request,
          Boolean(resolved.instanceToken),
          resolved.trustedOrigins,
        );
      const origin = request.headers.origin;
      const trustedEmbedOrigin = TRUSTED_EMBED_ORIGINS.has(origin)
        || (Boolean(resolved.instanceToken) && origin === "null");
      if (trustedEmbedOrigin) {
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
        response.setHeader(
          "access-control-allow-headers",
          request.headers["access-control-request-headers"] ?? "content-type",
        );
        response.setHeader("access-control-expose-headers", "x-automate-taskboard-proof");
        response.setHeader("access-control-allow-private-network", "true");
        response.setHeader("vary", "origin");
        if (request.method === "OPTIONS") {
          response.writeHead(204);
          response.end();
          return;
        }
      }
      if (resolved.instanceToken && origin === "app://-") {
        const challenge = request.headers["x-automate-taskboard-challenge"];
        if (typeof challenge !== "string" || !/^[a-f0-9]{32,128}$/i.test(challenge)) {
          throw new ApiError(401, "INVALID_INSTANCE_CHALLENGE", "Launcher challenge is required");
        }
        response.setHeader(
          "x-automate-taskboard-proof",
          createHmac("sha256", resolved.instanceSecret).update(challenge).digest("hex"),
        );
      }
      const url = new URL(request.url, "http://127.0.0.1");
      const pathname = url.pathname;
      // C7 pairing routes first (they apply their own loopback / tailnet-origin rules), so pairing
      // completion is reachable before a device has a session.
      if (mobileAccess && await mobileAccess.handle(request, response)) return;
      if (!mobileAccess && MOBILE_ROUTE_PATTERN.test(pathname)) {
        throw new ApiError(503, "MOBILE_ACCESS_UNAVAILABLE", "Mobile access is not available on this taskboard");
      }
      const mobilePrincipal = mobileRemote ? assertMobileRemoteAuthorized(request, pathname, mobileAccess) : null;
      if (mobilePrincipal) {
        // Amendment 13: an actively used phone never reaches the browser's cookie lifetime cap.
        const refreshed = mobileAccess?.refreshSessionCookie?.(request);
        if (refreshed) response.setHeader("set-cookie", refreshed);
      }
      const assertRunControl = () => assertRunControlRequest(request, { mobilePrincipal, configuredTrustedRequest });
      // DBG-01: a write that puts a card into the auto-claim queue or changes a queued card (content,
      // assignee, project, status, comments, attachments, order, unblocking) hands work to the AI as
      // surely as a direct start, so it needs the same run-control authorization. Pass the card state
      // before and/or after the write; ids are read from the database.
      const assertAutoClaimWrite = () => assertAutoClaimWriteRequest(request, { mobilePrincipal, configuredTrustedRequest });
      const assertAutoClaimControl = (...cards) => {
        for (const card of cards) {
          const task = typeof card === "string" ? database.getTask(card) : card;
          if (isAutoClaimEligibleTask(task)) return assertAutoClaimWrite();
        }
        return undefined;
      };
      // Completing or deleting a card that blocks a queued card unblocks it for auto-claim.
      const assertUnblockControl = (task) => {
        for (const blocked of task?.relations?.blocks ?? []) {
          if (isAutoClaimEligibleTask(database.getTask(blocked.id))) return assertAutoClaimWrite();
        }
        return undefined;
      };
      if (pathname === "/api/local/pairing/sessions") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if (!isExactLoopbackAddress(request.socket.remoteAddress) || !isLocalHostHeader(request.headers.host)) {
          throw new ApiError(403, "LOCAL_ONLY", "Paired devices are only listed on this device");
        }
        assertNoQuery(url.searchParams, "GET /api/local/pairing/sessions");
        return sendJson(response, 200, { sessions: pairingSessions.listSessions() });
      }
      const isLocalAiRoute = pathname === "/api/local/ai" || pathname.startsWith("/api/local/ai/");
      const isDevelopmentContextsRoute = /^\/api\/projects\/[^/]+\/development-contexts$/.test(pathname);
      if (
        configuredTrustedRequest
        && (
          pathname.startsWith("/api/local/")
          || pathname === "/api/device-workspaces"
          || isDevelopmentContextsRoute
        )
      ) {
        throw new ApiError(
          409,
          "LOCAL_COMPANION_REQUIRED",
          "This capability requires a device-local Taskboard origin",
        );
      }
      if (isLocalAiRoute) {
        assertAiLoopbackRequest(request);
      } else if (pathname.startsWith("/api/local/")) {
        assertLoopbackRequest(request);
      }
      const isMachineCapabilityRoute = pathname === "/api/meta"
        || pathname === "/api/device-workspaces"
        || isDevelopmentContextsRoute;
      const capabilityCloudConfig = isMachineCapabilityRoute
        ? await cloudConfig.read()
        : null;
      if (capabilityCloudConfig?.remoteUrl) assertLoopbackRequest(request);

      if (pathname === "/health") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if (resolved.instanceToken) {
          const challenge = request.headers["x-automate-taskboard-challenge"];
          if (typeof challenge !== "string" || !/^[a-f0-9]{32,128}$/i.test(challenge)) {
            throw new ApiError(401, "INVALID_INSTANCE_CHALLENGE", "Launcher challenge is required");
          }
          return sendJson(response, 200, {
            status: "ok",
            product: "automate-taskboard",
            version: resolved.version,
            proof: createHmac("sha256", resolved.instanceSecret)
              .update(challenge)
              .digest("hex"),
          });
        }
        return sendJson(response, 200, { status: "ok" });
      }

      if (pathname === "/api/client-storage") {
        if (request.method === "GET") {
          await clientStorageWrite;
          const entries = await readClientStorage();
          const config = await cloudConfig.read();
          if (config.remoteUrl) {
            assertLoopbackRequest(request);
            const shared = await readCloudJson("/api/client-storage");
            for (const key of Object.keys(entries)) {
              if (key.startsWith(PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX)) delete entries[key];
            }
            for (const [key, value] of Object.entries(shared.entries)) {
              if (key.startsWith(PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX)) entries[key] = value;
            }
          }
          return sendJson(response, 200, { entries });
        }
        if (request.method === "PATCH") {
          const update = parseClientStorageUpdate(await readJson(request));
          const config = await cloudConfig.read();
          if (
            config.remoteUrl
            && update.key.startsWith(PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX)
          ) {
            assertLoopbackRequest(request);
            return sendFetchResponse(
              response,
              await cloudProxy.forward(new Request("http://127.0.0.1/api/client-storage", {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(update),
              })),
            );
          }
          await updateClientStorage(update);
          if (update.key.startsWith(PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX)) {
            events.emit("client-storage.updated", { key: update.key });
          }
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["GET", "PATCH"]);
      }

      // W15: opens the native folder dialog on this PC and returns the chosen folder.
      if (pathname === "/api/local/pick-folder") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertProjectFolderRequest(request);
        assertNoQuery(url.searchParams, "POST /api/local/pick-folder");
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set(["title", "initialPath"]));
        const title = stringField(body.title ?? null, "title", { nullable: true, maxLength: 200 });
        const initialPath = stringField(body.initialPath ?? null, "initialPath", { nullable: true, maxLength: 4096 });
        if (initialPath?.includes("\0")) {
          throw new ApiError(400, "INVALID_FIELD", "'initialPath' cannot contain null bytes");
        }
        // W15 review O2: a closed page (reload, closed tab) closes the dialog and frees the picker.
        const pickAbort = new AbortController();
        const abortPick = () => {
          if (!response.writableEnded) pickAbort.abort();
        };
        response.on?.("close", abortPick);
        let picked;
        try {
          picked = await folderPicker.pick({ title: title ?? "", initialPath: initialPath ?? "", signal: pickAbort.signal });
        } finally {
          response.off?.("close", abortPick);
        }
        if (pickAbort.signal.aborted) return undefined;
        return sendJson(response, 200, {
          path: picked.path ?? null,
          canceled: picked.path ? false : true,
          ...(picked.timedOut ? { timedOut: true } : {}),
        });
      }

      if (pathname === "/api/local/codex-thread-progress") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].some((key) => key !== "threadId")) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Only 'threadId' is supported");
        }
        const threadIds = [...new Set(url.searchParams.getAll("threadId").map((value) => (
          value.trim().replace(/^(?:local|cloud):/i, "")
        )))];
        if (threadIds.length > 64 || threadIds.some((threadId) => (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)
        ))) {
          throw new ApiError(400, "INVALID_FIELD", "'threadId' must contain valid Codex thread IDs");
        }
        const entries = await Promise.all(threadIds.map(async (threadId) => (
          [threadId, await readCodexSessionState(threadId)]
        )));
        return sendJson(response, 200, { progress: Object.fromEntries(entries) });
      }

      if (pathname === "/api/local/host-runtime") {
        if (request.method === "GET") {
          const runtime = hostRuntime && Date.now() - hostRuntime.updatedAt <= HOST_RUNTIME_TTL_MS
            ? hostRuntime
            : null;
          return sendJson(response, 200, { runtime });
        }
        if (request.method === "PUT") {
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set([
            "threadId",
            "threadRunning",
            "threadTodoProgress",
            "codexProjectId",
            "codexProjectKind",
            "codexHostId",
            "workspacePath",
          ]));
          const threadId = stringField(body.threadId, "threadId", { required: true, maxLength: 256 });
          if (typeof body.threadRunning !== "boolean") {
            throw new ApiError(400, "INVALID_FIELD", "'threadRunning' must be a boolean");
          }
          let threadTodoProgress = null;
          if (body.threadTodoProgress != null) {
            assertPlainObject(body.threadTodoProgress);
            assertAllowedKeys(body.threadTodoProgress, new Set(["completed", "total"]));
            const { completed, total } = body.threadTodoProgress;
            if (!Number.isInteger(completed) || !Number.isInteger(total) || completed < 0 || total < 1) {
              throw new ApiError(400, "INVALID_FIELD", "'threadTodoProgress' is invalid");
            }
            threadTodoProgress = { completed: Math.min(completed, total), total };
          }
          hostRuntime = {
            threadId,
            threadRunning: body.threadRunning,
            threadTodoProgress,
            codexProjectId: stringField(body.codexProjectId ?? null, "codexProjectId", {
              nullable: true,
              maxLength: 256,
            }),
            codexProjectKind: body.codexProjectKind === "local" || body.codexProjectKind === "remote"
              ? body.codexProjectKind
              : null,
            codexHostId: stringField(body.codexHostId ?? null, "codexHostId", {
              nullable: true,
              maxLength: 256,
            }),
            workspacePath: stringField(body.workspacePath ?? null, "workspacePath", {
              nullable: true,
              maxLength: 4096,
            }),
            updatedAt: Date.now(),
          };
          return sendJson(response, 200, { runtime: hostRuntime });
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      if (pathname === "/api/local/cloud-session") {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Cloud session routes do not accept query parameters");
        }
        if (request.method === "GET") {
          const config = await cloudConfig.read();
          return sendJson(response, 200, config.remoteUrl
            ? {
              mode: "cloud",
              remoteUrl: config.remoteUrl,
              actorName: config.actorName,
              authenticated: true,
            }
            : { mode: "local", authenticated: false });
        }
        if (request.method === "PUT") {
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set(["remoteUrl", "actorName", "sharedKey"]));
          try {
            const config = await cloudConfig.configure({
              remoteUrl: body.remoteUrl,
              actorName: body.actorName,
              sharedKey: body.sharedKey,
            });
            return sendJson(response, 200, {
              mode: "cloud",
              remoteUrl: config.remoteUrl,
              actorName: config.actorName,
              authenticated: true,
            });
          } catch (error) {
            throw new ApiError(400, error.code ?? "INVALID_CLOUD_CONFIG", error.message);
          }
        }
        if (request.method === "DELETE") {
          await cloudConfig.clearCloud();
          return sendJson(response, 200, { mode: "local", authenticated: false });
        }
        return methodNotAllowed(response, ["GET", "PUT", "DELETE"]);
      }

      if (pathname === "/api/local/jira-connection") {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Jira 連接介面不接受查詢參數");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { connection: await jira.status() });
        }
        if (request.method === "PUT") {
          const activeCloudConfig = await cloudConfig.read();
          if (activeCloudConfig.remoteUrl) {
            throw new ApiError(
              409,
              "JIRA_LOCAL_MODE_REQUIRED",
              "Jira 連接目前僅支援本機資料模式，請先離開雲端協作模式",
            );
          }
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set(["baseUrl", "username", "password", "projects"]));
          const baseUrl = stringField(body.baseUrl, "baseUrl", { required: true, maxLength: 2048 });
          const username = stringField(body.username ?? "", "username", { maxLength: 254 });
          const password = body.password ?? "";
          if (typeof password !== "string") {
            throw new ApiError(400, "INVALID_FIELD", "'password' must be a string");
          }
          if (password.length > 4096) {
            throw new ApiError(400, "INVALID_FIELD", "'password' cannot exceed 4096 characters");
          }
          try {
            const connection = await jira.configure({
              baseUrl,
              username,
              password,
              projects: body.projects,
            });
            events.emit("project.labels.updated", { project: database.getProject(JIRA_PROJECT_ID) });
            return sendJson(response, 200, { connection });
          } catch (error) {
            if (error instanceof ApiError) throw error;
            throw new ApiError(400, error.code ?? "INVALID_JIRA_CONFIG", error.message);
          }
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      if (pathname === "/api/local/jira-connection/sync") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Jira 同步介面不接受查詢參數");
        }
        await assertEmptyRequestBody(request, "POST /api/local/jira-connection/sync");
        const connection = await jira.sync({ force: true });
        events.emit("project.labels.updated", { project: database.getProject(JIRA_PROJECT_ID) });
        return sendJson(response, 200, { connection });
      }

      const projectMappingRoute = pathname.match(/^\/api\/local\/project-mappings\/([^/]+)$/);
      if (projectMappingRoute) {
        if (request.method !== "PUT") return methodNotAllowed(response, ["PUT"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project mapping routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectMappingRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        assertProjectFolderRequest(request);
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set(["workspacePath"]));
        const workspacePath = pathField(body.workspacePath, "workspacePath");
        if (!workspacePath || !path.isAbsolute(workspacePath)) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' must be absolute");
        }
        await cloudConfig.setProjectWorkspace(projectId, workspacePath);
        return sendJson(response, 200, { projectId, workspacePath });
      }

      if (pathname === "/api/meta") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/meta does not accept query parameters");
        }
        return sendJson(response, 200, {
          ...(configuredTrustedRequest ? {} : { manageTaskboardSkillPath: resolved.skillPath }),
          capabilities: {
            localAiChat: !configuredTrustedRequest
              && isLoopbackAddress(request.socket.remoteAddress),
          },
          ...(capabilityCloudConfig?.remoteUrl
            ? {
              mode: "cloud",
              realtime: {
                transport: "websocket",
                endpoint: "/api/events",
              },
              localCapabilities: { available: !configuredTrustedRequest },
            }
            : {}),
        });
      }

      if (pathname === "/api/local/ai/catalog") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertAllowedQuery(url.searchParams, new Set([
          "projectId",
          "codexProjectId",
          "codexProjectKind",
          "codexHostId",
          "workspacePath",
        ]), "GET /api/local/ai/catalog");
        const projectId = validateProjectId(url.searchParams.get("projectId") ?? undefined);
        return sendJson(
          response,
          200,
          await aiChat.getCatalog(projectId, undefined, aiExecutionTargetFromQuery(url.searchParams)),
        );
      }

      if (pathname === "/api/local/ai/composer/candidates") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const query = parseComposerCandidateQuery(url.searchParams);
        return sendJson(
          response,
          200,
          await aiChat.composerCatalog.candidatesForSurface(
            await aiChat.getComposerCandidates(query),
            query,
          ),
        );
      }

      if (pathname === "/api/local/ai/composer/rebind") {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/ai/composer/rebind");
        const input = parseComposerRebindRequest(await readJson(request));
        const { workspacePath, composerCatalog } = await resolveComposerRebindWorkspace(aiChat, input);
        return sendJson(
          response,
          200,
          await composerCatalog.rebindPersistedReferences({
            workspacePath,
            nodes: input.document.nodes,
          }),
        );
      }

      const projectSummaryRoute = pathname.match(/^\/api\/local\/projects\/([^/]+)\/summary$/);
      if (projectSummaryRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/projects/:id/summary");
        const projectId = validateProjectId(
          decodeRouteSegment(projectSummaryRoute[1], "Project id"),
        );
        return sendJson(response, 200, projectSummary.get(projectId));
      }

      if (pathname === "/api/local/ai/threads") {
        assertNoQuery(url.searchParams, "/api/local/ai/threads");
        if (request.method === "GET") {
          return sendJson(response, 200, { threads: await aiChat.listThreads() });
        }
        if (request.method === "POST") {
          const thread = await aiChat.createThread(parseAiThreadCreate(await readJson(request)));
          return sendJson(response, 201, { thread });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const aiThreadSummaryRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)\/summary$/);
      if (aiThreadSummaryRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/ai/threads/:id/summary");
        const threadId = decodeRouteSegment(aiThreadSummaryRoute[1], "Thread id");
        return sendJson(response, 200, await aiChat.getThreadSummary(threadId));
      }

      const aiThreadEventsRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)\/events$/);
      if (aiThreadEventsRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/local/ai/threads/:id/events");
        const threadId = decodeRouteSegment(aiThreadEventsRoute[1], "Thread id");
        await aiChat.getThread(threadId);
        response.writeHead(200, {
          connection: "keep-alive",
          "cache-control": "no-cache, no-transform",
          "content-type": "text/event-stream; charset=utf-8",
          "x-accel-buffering": "no",
        });
        aiEventResponses.add(response);
        const unsubscribe = aiChat.subscribe(threadId, (event) => {
          const type = event?.type === "ai.run" ? "ai.run" : "ai.event";
          response.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
        });
        response.write(": connected\n\n");
        response.write('event: ai.event\ndata: {"type":"ai.event"}\n\n');
        const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 20_000);
        keepAlive.unref();
        request.once("close", () => {
          clearInterval(keepAlive);
          unsubscribe();
          aiEventResponses.delete(response);
        });
        return;
      }

      const aiThreadTurnRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)\/turns$/);
      if (aiThreadTurnRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/ai/threads/:id/turns");
        const threadId = decodeRouteSegment(aiThreadTurnRoute[1], "Thread id");
        const run = await aiChat.startTurn(
          threadId,
          parseAiTurn(await readJson(
            request,
            AI_CHAT_TURN_BODY_LIMIT,
            "AI chat turn body cannot exceed 25 MiB",
          )),
        );
        return sendJson(response, 202, { run });
      }

      const aiThreadCompactRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)\/compact$/);
      if (aiThreadCompactRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/ai/threads/:id/compact");
        const threadId = decodeRouteSegment(aiThreadCompactRoute[1], "Thread id");
        await assertEmptyRequestBody(request, "POST /api/local/ai/threads/:id/compact");
        const thread = await aiChat.compactThread(threadId);
        return sendJson(response, 200, { thread });
      }

      const aiThreadRoute = pathname.match(/^\/api\/local\/ai\/threads\/([^/]+)$/);
      if (aiThreadRoute) {
        assertNoQuery(url.searchParams, "/api/local/ai/threads/:id");
        const threadId = decodeRouteSegment(aiThreadRoute[1], "Thread id");
        if (request.method === "GET") {
          return sendJson(response, 200, await aiChat.getThreadSnapshot(threadId));
        }
        if (request.method === "PATCH") {
          const thread = await aiChat.updateThread(threadId, parseAiThreadPatch(await readJson(request)));
          return sendJson(response, 200, { thread });
        }
        if (request.method === "DELETE") {
          await assertEmptyRequestBody(request, "DELETE /api/local/ai/threads/:id");
          await aiChat.deleteThread(threadId);
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["GET", "PATCH", "DELETE"]);
      }

      const aiInterruptRoute = pathname.match(/^\/api\/local\/ai\/runs\/([^/]+)\/interrupt$/);
      if (aiInterruptRoute) {
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/local/ai/runs/:id/interrupt");
        const runId = decodeRouteSegment(aiInterruptRoute[1], "Run id");
        await assertEmptyRequestBody(request, "POST /api/local/ai/runs/:id/interrupt");
        const run = await aiChat.interrupt(runId);
        return sendJson(response, 200, { run });
      }

      if (pathname === "/api/device-workspaces") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/device-workspaces does not accept query parameters");
        }
        return sendJson(response, 200, {
          workspaces: await readCodexProjectWorkspaces(resolved.codexStatePath),
        });
      }


      let currentCloudConfig = null;
      if (pathname.startsWith("/api/")) {
        currentCloudConfig = await cloudConfig.read();
        if (currentCloudConfig.remoteUrl) {
          assertLoopbackRequest(request);
          if (pathname === "/api/tasks/import") {
            // Amendment 11 (F4) in cloud mode: the cloud worker has no import route, so the local
            // companion enforces the same loopback + taskctl guard and done/backlog-only mapping,
            // then creates the card through the cloud's ordinary POST /api/tasks.
            if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
            assertNoQuery(url.searchParams, "POST /api/tasks/import");
            assertTaskImportRequest(request, { mobileRemote, mobilePrincipal, configuredTrustedRequest });
            const body = await readJson(request);
            assertPlainObject(body);
            const requestedStatus = parseStatus(body.status, "backlog");
            const status = importedTaskStatus(requestedStatus);
            const upstream = await cloudProxy.forward(new Request("http://127.0.0.1/api/tasks", {
              method: "POST",
              headers: { accept: "application/json", "content-type": "application/json" },
              body: JSON.stringify({ ...body, status }),
            }));
            if (!upstream.ok) return sendFetchResponse(response, upstream);
            let payload;
            try {
              payload = await upstream.json();
            } catch {
              throw new ApiError(502, "INVALID_CLOUD_RESPONSE", "Cloud taskboard returned an invalid JSON response");
            }
            if (payload?.task?.status !== status) {
              throw new ApiError(502, "IMPORT_STATUS_INVARIANT", "Cloud taskboard did not keep the imported status");
            }
            return sendJson(response, upstream.status, { ...payload, import: { requestedStatus, status } });
          }
          // W15 review O4: in cloud mode the project folder is this device's mapping (like
          // `taskctl project map`); the cloud worker has no PATCH /api/projects/:id.
          const cloudProjectRoute = request.method === "PATCH" ? pathname.match(/^\/api\/projects\/([^/]+)$/) : null;
          if (cloudProjectRoute) {
            assertProjectFolderRequest(request);
            let projectId;
            try {
              projectId = decodeURIComponent(cloudProjectRoute[1]);
            } catch {
              throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
            }
            validateProjectId(projectId);
            if (projectId === DEFAULT_PROJECT_ID || projectId === JIRA_PROJECT_ID) {
              throw new ApiError(400, "PROJECT_FOLDER_NOT_ALLOWED", "這個專案不能設定資料夾");
            }
            const body = await readJson(request);
            assertPlainObject(body);
            assertAllowedKeys(body, new Set(["workspacePath"]));
            const workspacePath = await assertProjectFolder(body.workspacePath);
            await cloudConfig.setProjectWorkspace(projectId, workspacePath);
            return sendJson(response, 200, { project: { id: projectId, workspacePath } });
          }
          if (!isLocalCompanionRoute(pathname)) {
            return sendFetchResponse(
              response,
              await cloudProxy.forward(toFetchRequest(request)),
            );
          }
        }
      }

      if (pathname === "/api/projects") {
        if (request.method === "GET") {
          if ([...url.searchParams.keys()].length > 0) {
            throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/projects does not accept query parameters");
          }
          const projects = database.listProjects().map((project) => ({
            ...project,
            workspacePath: project.id === DEFAULT_PROJECT_ID
              ? null
              : currentCloudConfig?.projectMappings[project.id] ?? project.workspacePath,
          }));
          return sendJson(response, 200, { projects });
        }
        if (request.method === "POST") {
          const input = parseProjectCreate(await readJson(request));
          // W15: a folder given on create must exist on this PC (runs use it as the working directory),
          // and only this PC's board may set it (review M1: a paired phone or LAN client creates projects
          // without a folder).
          if (input.workspacePath !== null) {
            assertProjectFolderRequest(request);
            input.workspacePath = await assertProjectFolder(input.workspacePath);
          }
          const project = database.createProject(input);
          events.emit("project.created", { project });
          return sendJson(response, 201, { project });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const projectRoute = pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (projectRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (request.method === "DELETE") {
          database.deleteProject(projectId);
          return sendEmpty(response, 204);
        }
        // W15: set the project folder from this PC (phones cannot pick a folder on the PC).
        if (request.method === "PATCH") {
          assertProjectFolderRequest(request);
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set(["workspacePath"]));
          if (projectId === DEFAULT_PROJECT_ID || projectId === JIRA_PROJECT_ID) {
            throw new ApiError(400, "PROJECT_FOLDER_NOT_ALLOWED", "這個專案不能設定資料夾");
          }
          if (!database.getProject(projectId)) {
            throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
          }
          const workspacePath = await assertProjectFolder(body.workspacePath);
          const project = database.updateProjectWorkspace(projectId, workspacePath);
          events.emit("project.updated", { projectId, project });
          return sendJson(response, 200, { project });
        }
        return methodNotAllowed(response, ["DELETE", "PATCH"]);
      }

      if (pathname === "/api/providers") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        assertNoQuery(url.searchParams, "GET /api/providers");
        const entries = await Promise.all(RUN_PROVIDER_NAMES.map(async (name) => (
          [name, await providerAvailability(name, ROUTE_AVAILABILITY_TTL_MS)]
        )));
        return sendJson(response, 200, { providers: Object.fromEntries(entries) });
      }

      const projectAutomationRoute = pathname.match(/^\/api\/projects\/([^/]+)\/(automation|order\/reset)$/);
      if (projectAutomationRoute) {
        const projectId = decodeRouteSegment(projectAutomationRoute[1], "Project id");
        validateProjectId(projectId);
        assertNoQuery(url.searchParams, "Project automation routes");
        if (projectAutomationRoute[2] === "automation") {
          if (request.method === "GET") {
            const automation = database.getProjectAutomation(projectId);
            return sendJson(response, 200, { automation, ...await claudePermissionPreview(projectId) });
          }
          if (request.method === "PUT") {
            assertRunControl();
            const patch = await readJson(request);
            assertPlainObject(patch);
            assertAllowedKeys(patch, PROJECT_AUTOMATION_FIELDS);
            const automation = database.updateProjectAutomation(projectId, patch);
            emitAutomation(projectId, automation);
            if (automation.enabled) nudgeScheduler();
            return sendJson(response, 200, { automation });
          }
          return methodNotAllowed(response, ["GET", "PUT"]);
        }
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertAutoClaimWrite(); // DBG-01: the order decides which queued card the AI claims next.
        await readOptionalJsonObject(request, new Set());
        const automation = database.updateProjectAutomation(projectId, { orderMode: "suggested" });
        emitAutomation(projectId, automation);
        return sendJson(response, 200, { automation });
      }

      const projectLabelsRoute = pathname.match(/^\/api\/projects\/([^/]+)\/labels$/);
      if (projectLabelsRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project label routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectLabelsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (request.method !== "POST" && request.method !== "DELETE") {
          return methodNotAllowed(response, ["POST", "DELETE"]);
        }
        if (request.method === "DELETE" && projectId === JIRA_PROJECT_ID) {
          throw new ApiError(
            409,
            "JIRA_LABEL_CATALOG_DELETE_UNAVAILABLE",
            "Jira 標籤目錄由同步管理，不能在 Taskboard 中刪除",
          );
        }
        const label = parseProjectLabel(await readJson(request));
        const project = request.method === "POST"
          ? database.addProjectLabel(projectId, label)
          : database.deleteProjectLabel(projectId, label);
        events.emit("project.labels.updated", { project });
        return sendJson(response, 200, { project });
      }

      const projectReadmeAttachmentsRoute = pathname.match(
        /^\/api\/projects\/([^/]+)\/readme\/attachments$/,
      );
      if (projectReadmeAttachmentsRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project README attachment routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectReadmeAttachmentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        const metadata = parseAttachmentHeaders(request);
        if (metadata.kind !== "inline") {
          throw new ApiError(400, "INVALID_ATTACHMENT_KIND", "Project README attachments must be inline");
        }
        const body = await readBody(request, ATTACHMENT_BODY_LIMIT, "Attachment cannot exceed 25 MiB");
        const id = randomUUID();
        await mkdir(resolved.attachmentsDirectory, { recursive: true });
        const storagePath = path.join(resolved.attachmentsDirectory, id);
        await writeFile(storagePath, body, { flag: "wx" });
        let attachment;
        try {
          attachment = database.createProjectReadmeAttachment(projectId, {
            id,
            ...metadata,
            size: body.length,
          });
        } catch (error) {
          await unlink(storagePath);
          throw error;
        }
        return sendJson(response, 201, { attachment });
      }

      const projectReadmeRoute = pathname.match(/^\/api\/projects\/([^/]+)\/readme$/);
      if (projectReadmeRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Project README routes do not accept query parameters");
        }
        let projectId;
        try {
          projectId = decodeURIComponent(projectReadmeRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        if (request.method === "GET") {
          return sendJson(response, 200, { readme: database.getProjectReadme(projectId) });
        }
        if (request.method === "PUT") {
          const input = parseProjectReadmeSave(await readJson(
            request,
            PROJECT_README_BODY_LIMIT,
            "Project README request cannot exceed 3 MiB",
          ));
          const readme = database.saveProjectReadme(projectId, input.content, input.version);
          events.emit("project.readme.updated", {
            projectId,
            readmeVersion: readme.version,
          });
          return sendJson(response, 200, { readme });
        }
        return methodNotAllowed(response, ["GET", "PUT"]);
      }

      const developmentContextsRoute = pathname.match(/^\/api\/projects\/([^/]+)\/development-contexts$/);
      if (developmentContextsRoute) {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const unknownQuery = [...url.searchParams.keys()].filter((key) => (
          !["codexProjectId", "codexThreadId", "workspacePath"].includes(key)
        ));
        if (unknownQuery.length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter: ${unknownQuery[0]}`);
        }
        let projectId;
        try {
          projectId = decodeURIComponent(developmentContextsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Project id contains invalid encoding");
        }
        validateProjectId(projectId);
        const project = currentCloudConfig.remoteUrl
          ? {
            id: projectId,
            workspacePath: projectId === DEFAULT_PROJECT_ID
              ? null
              : currentCloudConfig.projectMappings[projectId] ?? null,
          }
          : database.getProject(projectId);
        if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
        const codexProjectId = stringField(url.searchParams.get("codexProjectId") ?? null, "codexProjectId", {
          nullable: true,
          maxLength: 128,
        });
        const codexThreadId = stringField(url.searchParams.get("codexThreadId") ?? null, "codexThreadId", {
          nullable: true,
          maxLength: 256,
        });
        const deviceWorkspacePath = stringField(
          url.searchParams.get("workspacePath") ?? null,
          "workspacePath",
          { nullable: true, maxLength: 4096 },
        );
        if (deviceWorkspacePath?.includes("\0")) {
          throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
        }
        const workspacePath = deviceWorkspacePath ?? await resolveProjectWorkspace(
          project,
          codexProjectId,
          codexThreadId,
          resolved.codexStatePath,
          resolved.codexProcessesPath,
        );
        return sendJson(
          response,
          200,
          await scanDevelopmentContexts(workspacePath, codexProcessEnvironment),
        );
      }

      if (pathname === "/api/tasks/import") {
        // Amendment 11 (F4): the only way an agent may create a card as done. Loopback-only taskctl
        // import; never a phone, a LAN client or a configured trusted origin.
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertNoQuery(url.searchParams, "POST /api/tasks/import");
        assertTaskImportRequest(request, { mobileRemote, mobilePrincipal, configuredTrustedRequest });
        const actor = actorFromRequest(request);
        const body = await readJson(request);
        assertPlainObject(body);
        const requestedStatus = parseStatus(body.status, "backlog");
        const status = importedTaskStatus(requestedStatus);
        const { assigneeTarget, ...parsedInput } = parseTaskCreate({ ...body, status }, parseDevelopmentContext);
        const input = resolveInputThreadBinding(parsedInput);
        if (input.projectId === JIRA_PROJECT_ID) {
          throw new ApiError(
            409,
            "JIRA_CREATE_UNAVAILABLE",
            "請在 Jira 中建立任務，Taskboard 目前只同步已分配給你的任務",
          );
        }
        const assignee = resolveAssignee(assigneeTarget, actor);
        if (isAutoClaimEligibleTask({ ...input, status, archivedAt: null, assignee })) {
          throw new ApiError(500, "IMPORT_STATUS_INVARIANT", "Imported cards cannot be queued for AI work");
        }
        const task = database.createTask({ ...input, status, actor, assignee });
        events.emit("task.created", { task });
        return sendJson(response, 201, {
          task: withRunState(task),
          import: { requestedStatus, status },
        });
      }

      if (pathname === "/api/tasks") {
        if (request.method === "GET") {
          const filters = parseTaskFilters(url.searchParams);
          if (!filters.projectId || filters.projectId === JIRA_PROJECT_ID) await jira.sync();
          return sendJson(response, 200, { tasks: database.listTasks(filters).map(withRunState) });
        }
        if (request.method === "POST") {
          const actor = actorFromRequest(request);
          const { assigneeTarget, ...parsedInput } = parseTaskCreate(await readJson(request), parseDevelopmentContext);
          const input = resolveInputThreadBinding(parsedInput);
          if (input.projectId === JIRA_PROJECT_ID) {
            throw new ApiError(
              409,
              "JIRA_CREATE_UNAVAILABLE",
              "請在 Jira 中建立任務，Taskboard 目前只同步已分配給你的任務",
            );
          }
          const assignee = resolveAssignee(assigneeTarget, actor);
          // C6/D11: cards created by an AI agent (taskctl) always start in backlog.
          const status = actor.type === "agent" ? "backlog" : input.status;
          assertAutoClaimControl({ status, archivedAt: null, assignee });
          const task = database.createTask({
            ...input,
            ...(actor.type === "agent" ? { status: "backlog" } : {}),
            actor,
            assignee,
          });
          events.emit("task.created", { task });
          return sendJson(response, 201, { task: withRunState(task) });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      if (pathname === "/api/events") {
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/events does not accept query parameters");
        }
        events.connect(request, response, { sessionId: mobilePrincipal?.sessionId ?? null });
        return;
      }

      const taskRelationRoute = pathname.match(
        /^\/api\/tasks\/([^/]+)\/relations\/([^/]+)\/([^/]+)$/,
      );
      if (taskRelationRoute) {
        let taskId;
        let type;
        let relatedTaskId;
        try {
          taskId = decodeURIComponent(taskRelationRoute[1]);
          type = decodeURIComponent(taskRelationRoute[2]);
          relatedTaskId = decodeURIComponent(taskRelationRoute[3]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Issue relation path contains invalid encoding");
        }
        if (
          taskId.length === 0
          || taskId.length > 128
          || relatedTaskId.length === 0
          || relatedTaskId.length > 128
        ) {
          throw new ApiError(400, "INVALID_PATH", "Issue relation task id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Issue relation routes do not accept query parameters");
        }
        const relationType = parseIssueRelationType(type);
        if (request.method === "DELETE" && (relationType === "blocks" || relationType === "blocked_by")) {
          // DBG-01: removing a blocks relation can make the blocked card claimable.
          assertAutoClaimControl(relationType === "blocks" ? relatedTaskId : taskId);
        }
        if (request.method === "POST") {
          const { version, threadId, threadBinding, origin } = resolveInputThreadBinding(
            parseRelationMutation(await readJson(request)),
          );
          const result = database.addTaskRelation(
            taskId,
            version,
            relationType,
            relatedTaskId,
            threadId,
            threadBinding,
            actorFromRequest(request),
            origin,
          );
          events.emit("task.relation.updated", result);
          return sendJson(response, 200, result);
        }
        if (request.method === "DELETE") {
          const { version, threadId, threadBinding, origin } = resolveInputThreadBinding(
            parseRelationMutation(await readJson(request)),
          );
          const result = database.removeTaskRelation(
            taskId,
            version,
            relationType,
            relatedTaskId,
            threadId,
            threadBinding,
            actorFromRequest(request),
            origin,
          );
          events.emit("task.relation.updated", result);
          return sendJson(response, 200, result);
        }
        return methodNotAllowed(response, ["POST", "DELETE"]);
      }

      const taskActivitiesRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/activities$/);
      if (taskActivitiesRoute) {
        let taskId;
        try {
          taskId = decodeURIComponent(taskActivitiesRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (taskId.length === 0 || taskId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Activity routes do not accept query parameters");
        }
        if (request.method === "GET") {
          return sendJson(response, 200, { activities: database.listTaskActivities(taskId) });
        }
        return methodNotAllowed(response, ["GET"]);
      }

      const taskCommentsRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/comments$/);
      if (taskCommentsRoute) {
        let taskId;
        try {
          taskId = decodeURIComponent(taskCommentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (taskId.length === 0 || taskId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if (request.method === "GET") {
          const after = parseAfterCursor(url.searchParams, "Comment routes");
          const comments = after
            ? database.listCommentsAfter(taskId, after)
            : database.listComments(taskId);
          return sendJson(response, 200, {
            comments,
            nextCursor: nextCursor(comments, after),
          });
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Comment routes do not accept query parameters");
        }
        if (request.method === "POST") {
          assertAutoClaimControl(taskId); // DBG-01: comments are part of the AI prompt.
          const comment = database.createComment(taskId, {
            ...resolveInputThreadBinding(parseCommentCreate(await readJson(request))),
            actor: actorFromRequest(request),
          });
          const task = database.getTask(taskId);
          events.emit("comment.created", { comment, task });
          return sendJson(response, 201, { comment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const commentRoute = pathname.match(/^\/api\/comments\/([^/]+)$/);
      if (commentRoute) {
        let id;
        try {
          id = decodeURIComponent(commentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Comment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Comment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Comment routes do not accept query parameters");
        }
        if (request.method === "PATCH" || request.method === "DELETE") {
          assertAutoClaimControl(database.getComment(id)?.taskId); // DBG-01
        }
        if (request.method === "PATCH") {
          const patch = resolveInputThreadBinding(parseCommentPatch(await readJson(request)));
          const comment = database.updateComment(
            id,
            patch.version,
            patch.body,
            patch.threadId,
            patch.threadBinding,
          );
          const task = database.getTask(comment.taskId);
          events.emit("comment.updated", { comment, task });
          return sendJson(response, 200, { comment });
        }
        if (request.method === "DELETE") {
          const { version } = parseVersionMutation(await readJson(request));
          const comment = database.deleteComment(id, version);
          for (const attachment of comment.attachments) {
            try {
              await unlink(path.join(resolved.attachmentsDirectory, attachment.id));
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
          }
          const task = database.getTask(comment.taskId);
          events.emit("comment.deleted", { comment, task });
          return sendEmpty(response, 204);
        }
        return methodNotAllowed(response, ["PATCH", "DELETE"]);
      }

      const commentAttachmentsRoute = pathname.match(/^\/api\/comments\/([^/]+)\/attachments$/);
      if (commentAttachmentsRoute) {
        let commentId;
        try {
          commentId = decodeURIComponent(commentAttachmentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Comment id contains invalid encoding");
        }
        if (commentId.length === 0 || commentId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Comment id is invalid");
        }
        if (request.method === "GET") {
          const after = parseAfterCursor(url.searchParams, "Attachment routes");
          const attachments = database.listCommentAttachments(commentId, after);
          return sendJson(response, 200, {
            attachments,
            nextCursor: nextCursor(attachments, after),
          });
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method === "POST") {
          const comment = database.getComment(commentId);
          if (!comment) throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${commentId}' does not exist`);
          assertAutoClaimControl(comment.taskId); // DBG-01
          const metadata = parseAttachmentHeaders(request);
          const body = await readBody(request, ATTACHMENT_BODY_LIMIT, "Attachment cannot exceed 25 MiB");
          const id = randomUUID();
          await mkdir(resolved.attachmentsDirectory, { recursive: true });
          const storagePath = path.join(resolved.attachmentsDirectory, id);
          await writeFile(storagePath, body, { flag: "wx" });
          let attachment;
          try {
            attachment = database.createCommentAttachment(commentId, { id, ...metadata, size: body.length });
          } catch (error) {
            await unlink(storagePath);
            throw error;
          }
          const task = database.getTask(comment.taskId);
          events.emit("attachment.created", { attachment, comment: database.getComment(commentId), task });
          return sendJson(response, 201, { attachment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const taskAttachmentsRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/attachments$/);
      if (taskAttachmentsRoute) {
        let taskId;
        try {
          taskId = decodeURIComponent(taskAttachmentsRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (taskId.length === 0 || taskId.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if (request.method === "GET") {
          const after = parseAfterCursor(url.searchParams, "Attachment routes");
          const attachments = database.listAttachments(taskId, after);
          return sendJson(response, 200, {
            attachments,
            nextCursor: nextCursor(attachments, after),
          });
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method === "POST") {
          const task = database.getTask(taskId);
          if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
          assertAutoClaimControl(task); // DBG-01
          const metadata = parseAttachmentHeaders(request);
          const body = await readBody(request, ATTACHMENT_BODY_LIMIT, "Attachment cannot exceed 25 MiB");
          const id = randomUUID();
          await mkdir(resolved.attachmentsDirectory, { recursive: true });
          const storagePath = path.join(resolved.attachmentsDirectory, id);
          await writeFile(storagePath, body, { flag: "wx" });
          let attachment;
          try {
            attachment = database.createAttachment(taskId, { id, ...metadata, size: body.length });
          } catch (error) {
            await unlink(storagePath);
            throw error;
          }
          events.emit("attachment.created", { attachment, task });
          return sendJson(response, 201, { attachment });
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const attachmentContentRoute = pathname.match(/^\/api\/attachments\/([^/]+)\/(content|download)$/);
      if (attachmentContentRoute) {
        let id;
        try {
          id = decodeURIComponent(attachmentContentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Attachment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Attachment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          return methodNotAllowed(response, ["GET", "HEAD"]);
        }
        const attachment = database.getAttachment(id) ?? database.getProjectReadmeAttachment(id);
        if (!attachment) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
        const body = await readFile(path.join(resolved.attachmentsDirectory, attachment.id));
        const encodedFilename = encodeURIComponent(attachment.filename).replace(/['()*]/g, (character) => (
          `%${character.charCodeAt(0).toString(16).toUpperCase()}`
        ));
        const canOpenInline = attachmentContentRoute[2] === "content"
          && (
            INLINE_ATTACHMENT_TYPES.has(attachment.contentType)
            || attachment.contentType.startsWith("video/")
          );
        response.writeHead(200, {
          "cache-control": "private, no-store",
          "content-disposition": `${canOpenInline ? "inline" : "attachment"}; filename*=UTF-8''${encodedFilename}`,
          "content-length": body.length,
          "content-security-policy": "sandbox; default-src 'none'",
          "content-type": canOpenInline ? attachment.contentType : "application/octet-stream",
        });
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }

      const attachmentRoute = pathname.match(/^\/api\/attachments\/([^/]+)$/);
      if (attachmentRoute) {
        let id;
        try {
          id = decodeURIComponent(attachmentRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Attachment id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Attachment id is invalid");
        }
        if ([...url.searchParams.keys()].length > 0) {
          throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "Attachment routes do not accept query parameters");
        }
        if (request.method !== "DELETE") return methodNotAllowed(response, ["DELETE"]);
        const attachment = database.getAttachment(id);
        if (!attachment) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
        assertAutoClaimControl(attachment.taskId); // DBG-01
        try {
          await unlink(path.join(resolved.attachmentsDirectory, attachment.id));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        database.deleteAttachment(id);
        const task = database.getTask(attachment.taskId);
        events.emit("attachment.deleted", { attachment, task });
        return sendEmpty(response, 204);
      }

      const taskRunRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/(run\/start|run\/stop|run\/followup|continue|rework|runs)$/);
      if (taskRunRoute) {
        const taskId = decodeRouteSegment(taskRunRoute[1], "Task id");
        const runAction = taskRunRoute[2];
        assertNoQuery(url.searchParams, "Task run routes");
        if (runAction === "runs") {
          if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
          const task = database.getTask(taskId);
          if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
          const runs = database.listRuns(task.id).map((run) => ({ ...run, openUrl: runService.openUrl(run.id) }));
          const current = database.getActiveRun(task.id) ?? database.getLatestRun(task.id);
          return sendJson(response, 200, {
            runs,
            followups: database.listFollowups(task.id),
            // Amendment 2: live activity of the active (or latest) run, oldest first.
            activity: current ? runService.listActivity(current.id) : [],
          });
        }
        if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
        assertRunControl();
        const actor = actorFromRequest(request);
        if (runAction === "run/start") {
          await readOptionalJsonObject(request, new Set());
          // W3 smoke bug 3: 202 Accepted — run row is `starting`; provider progress follows via
          // run.updated SSE and GET /api/tasks/:id/runs (failure → run failed, card blocked).
          const result = await runService.startTask({ taskId, actor });
          return sendJson(response, 202, { task: withRunState(result.task), run: result.run });
        }
        if (runAction === "run/stop") {
          const body = await readOptionalJsonObject(request, new Set(["destination"]));
          const result = await runService.stopTask({ taskId, destination: body.destination ?? null, actor });
          return sendJson(response, 200, { task: withRunState(result.task), run: result.run });
        }
        if (runAction === "run/followup") {
          const body = await readJson(request);
          assertPlainObject(body);
          assertAllowedKeys(body, new Set(["body", "mode"]));
          // 202 Accepted — follow-up is `pending`; a steer is delivered in the background (followup.updated).
          const result = await runService.sendFollowup({ taskId, body: body.body, mode: body.mode, actor });
          return sendJson(response, 202, { followup: result.followup });
        }
        const body = await readJson(request);
        assertPlainObject(body);
        assertAllowedKeys(body, new Set(runAction === "rework" ? ["body", "commentId"] : ["body"]));
        if (runAction === "continue") {
          // 202 Accepted — new run is `starting`; the message is delivered in the background.
          const result = await runService.continueTask({ taskId, body: body.body, actor });
          return sendJson(response, 202, { task: withRunState(result.task), run: result.run });
        }
        const result = await runService.reworkTask({ taskId, body: body.body, commentId: body.commentId, actor });
        return sendJson(response, 200, { task: withRunState(result.task), comment: result.comment });
      }

      const taskTreeRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/tree$/);
      if (taskTreeRoute) {
        let id;
        try {
          id = decodeURIComponent(taskTreeRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
        const { direction, depth } = parseTaskTreeQuery(url.searchParams);
        return sendJson(response, 200, { tree: database.getTaskTree(id, direction, depth) });
      }

      const taskRoute = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(archive|restore|move))?$/);
      if (taskRoute) {
        let id;
        try {
          id = decodeURIComponent(taskRoute[1]);
        } catch {
          throw new ApiError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        if (id.length === 0 || id.length > 128) {
          throw new ApiError(400, "INVALID_PATH", "Task id is invalid");
        }
        const action = taskRoute[2];
        if (!action && request.method === "GET") {
          if ([...url.searchParams.keys()].length > 0) {
            throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/tasks/:id does not accept query parameters");
          }
          const task = database.getTask(id);
          if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
          return sendJson(response, 200, { task: withRunState(task) });
        }
        if (!action && request.method === "PATCH") {
          const actor = actorFromRequest(request);
          const {
            version,
            changes,
            threadId,
            threadBinding,
            assigneeTarget,
          } = resolveInputThreadBinding(parseTaskPatch(await readJson(request), parseDevelopmentContext));
          const source = database.getTaskSource(id);
          if (!source) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
          const beforePatch = database.getTask(id);
          if (actor.type === "agent" && changes.status === "done" && beforePatch.status !== "done") {
            throw new ApiError(403, "AGENT_CANNOT_COMPLETE", "AI agents cannot mark a task as done");
          }
          assertNoSilentContinue({
            task: beforePatch,
            status: changes.status,
            assignees: [
              beforePatch.assignee,
              assigneeTarget === "codex-agent" ? CODEX_AGENT_ACTOR : null,
              assigneeTarget === "claude-agent" ? CLAUDE_AGENT_ACTOR : null,
            ],
            activeRun: database.getActiveRun(beforePatch.id),
            latestRun: database.getLatestRun(beforePatch.id),
          });
          // DBG-01: any change to a queued card, or a change that queues it, needs run control.
          assertAutoClaimControl(beforePatch, {
            ...beforePatch,
            status: changes.status ?? beforePatch.status,
            assignee: assigneeTarget === undefined
              ? beforePatch.assignee
              : assigneeTarget === "codex-agent"
                ? CODEX_AGENT_ACTOR
                : assigneeTarget === "claude-agent" ? CLAUDE_AGENT_ACTOR : actor,
          });
          if (changes.status === "done" && beforePatch.status !== "done") assertUnblockControl(beforePatch);
          let jiraChanged = false;
          if (source !== "jira" && changes.projectId === JIRA_PROJECT_ID) {
            throw new ApiError(
              409,
              "JIRA_PROJECT_MOVE_UNAVAILABLE",
              "本機任務不能移入 Jira 同步專案",
            );
          }
          if (source === "jira") {
            const current = database.getTask(id);
            if (current.version !== version) {
              throw new ApiError(409, "VERSION_CONFLICT", "Task changed since it was last read", {
                expectedVersion: version,
                actualVersion: current.version,
              });
            }
            if (current.archivedAt !== null) {
              throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be updated");
            }
            if (Object.hasOwn(changes, "projectId")) {
              throw new ApiError(409, "JIRA_PROJECT_MOVE_UNAVAILABLE", "Jira 任務不能移到本機專案");
            }
            if (assigneeTarget !== undefined) {
              throw new ApiError(409, "JIRA_ASSIGNEE_UNAVAILABLE", "請在 Jira 中修改經辦人");
            }
            const dueDate = Object.hasOwn(changes, "dueDate") ? changes.dueDate : current.dueDate;
            const recurrence = Object.hasOwn(changes, "recurrence")
              ? changes.recurrence
              : current.recurrence;
            if (recurrence && !dueDate) {
              throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires a due date");
            }
            jiraChanged = await jira.updateTask(current, changes);
          }
          if (assigneeTarget !== undefined) {
            changes.assignee = resolveAssignee(assigneeTarget, actor);
          }
          // C6: a status change through PATCH follows the same run rules as the move endpoint.
          const patchTransition = runTransitionForStatusChange({
            task: beforePatch,
            status: changes.status,
            assignee: changes.assignee ?? beforePatch.assignee,
            activeRun: database.getActiveRun(beforePatch.id),
            actor,
          });
          if (patchTransition) assertRunControl();
          if (patchTransition && beforePatch.version !== version) throw versionConflict(beforePatch, version);
          if (patchTransition === "start") {
            // Review fix: check the start preconditions before any field change is written, so a
            // failing start does not leave the other PATCH changes committed. From here to the
            // synchronous part of startTask there is no await after the Jira call above.
            const providerName = providerForAssignee(changes.assignee ?? beforePatch.assignee);
            if (!runProviders[providerName]) {
              throw new ApiError(503, "PROVIDER_UNAVAILABLE", `Run provider '${providerName}' is not configured`);
            }
            runService.assertWorkspace({ projectId: changes.projectId ?? beforePatch.projectId });
          }
          if (patchTransition === "stop") {
            // Throws 502 RUN_STOP_FAILED when the AI did not confirm; the task is left unchanged.
            await runService.stopTask({ taskId: beforePatch.id, destination: null, actor });
          }
          const appliedChanges = patchTransition === "start"
            ? Object.fromEntries(Object.entries(changes).filter(([key]) => key !== "status"))
            : changes;
          let task;
          try {
            task = database.updateTask(id, version, appliedChanges, threadId, threadBinding, actor);
          } catch (error) {
            if (jiraChanged) {
              try {
                await jira.reconcile();
              } catch {
                throw new ApiError(
                  502,
                  "JIRA_RECONCILE_FAILED",
                  "Jira 已更新，但 Taskboard 重新同步失敗，請手動同步",
                );
              }
            }
            throw error;
          }
          events.emit("task.updated", { task });
          if (patchTransition === "start") {
            // startTask's checks (archived, todo, agent assignee, provider) and its move all run
            // synchronously before its first await, and nothing awaits between updateTask and here,
            // so no other request can change the card in between (no TASK_NOT_TODO race).
            const started = await runService.startTask({ taskId: task.id, actor });
            return sendJson(response, 200, { task: withRunState(started.task), run: started.run });
          }
          return sendJson(response, 200, { task: withRunState(task) });
        }
        if (!action && request.method === "DELETE") {
          const current = database.getTask(id);
          if (current?.source === "jira") {
            throw new ApiError(409, "JIRA_DELETE_UNAVAILABLE", "Jira 任務不能從 Taskboard 永久刪除");
          }
          assertUnblockControl(current); // DBG-01: deleting a blocker frees the cards it blocks.
          const { version } = parseVersionMutation(await readJson(request));
          const deleted = database.deleteArchivedTask(id, version);
          for (const attachmentId of deleted.attachmentIds) {
            try {
              await unlink(path.join(resolved.attachmentsDirectory, attachmentId));
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
          }
          events.emit("task.deleted", { task: deleted.task });
          return sendEmpty(response, 204);
        }
        if (action === "move" && request.method === "POST") {
          const move = resolveInputThreadBinding(parseMove(await readJson(request)));
          const actor = actorFromRequest(request);
          const current = database.getTask(id);
          if (!current) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
          if (actor.type === "agent" && move.status === "done" && current.status !== "done") {
            throw new ApiError(403, "AGENT_CANNOT_COMPLETE", "AI agents cannot mark a task as done");
          }
          assertNoSilentContinue({
            task: current,
            status: move.status,
            activeRun: database.getActiveRun(current.id),
            latestRun: database.getLatestRun(current.id),
          });
          const moveTransition = runTransitionForStatusChange({
            task: current,
            status: move.status,
            activeRun: database.getActiveRun(current.id),
            actor,
          });
          if (moveTransition) assertRunControl();
          // DBG-01: moving into todo, or moving / reordering a queued card, needs run control.
          assertAutoClaimControl(current, { ...current, status: move.status });
          if (move.status === "done" && current.status !== "done") assertUnblockControl(current);
          if (moveTransition && current.version !== move.version) throw versionConflict(current, move.version);
          if (current.source === "jira") {
            if (current.version !== move.version) {
              throw new ApiError(409, "VERSION_CONFLICT", "Task changed since it was last read", {
                expectedVersion: move.version,
                actualVersion: current.version,
              });
            }
            if (current.archivedAt !== null) {
              throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be moved");
            }
            await jira.moveTask(current, move.status);
          }
          if (moveTransition === "start") {
            // todo -> in_progress for an AI assignee: the run service creates the run and moves the card.
            const started = await runService.startTask({ taskId: current.id, actor });
            return sendJson(response, 200, { task: withRunState(started.task), run: started.run });
          }
          if (moveTransition === "stop") {
            // Throws 502 RUN_STOP_FAILED when the AI did not confirm; then the card does not move.
            await runService.stopTask({ taskId: current.id, destination: null, actor });
          }
          const task = database.moveTask(
            id,
            move.version,
            move.status,
            move.sortOrder,
            move.threadId,
            move.threadBinding,
            actor,
          );
          events.emit("task.moved", { task });
          if (
            current.status === "todo"
            && move.status === "todo"
            && move.sortOrder !== undefined
            && current.source !== "jira"
          ) {
            switchToManualOrder(current.projectId);
          }
          return sendJson(response, 200, { task: withRunState(task) });
        }
        if (action === "archive" && request.method === "POST") {
          const current = database.getTask(id);
          if (current?.source === "jira") {
            throw new ApiError(409, "JIRA_ARCHIVE_UNAVAILABLE", "Jira 任務由同步範圍自動管理，不能手動封存");
          }
          const { version, threadId, threadBinding } = resolveInputThreadBinding(
            parseVersionMutation(await readJson(request)),
          );
          const actor = actorFromRequest(request);
          if (current && current.archivedAt === null && database.getLatestRun(current.id)) {
            assertRunControl();
            if (current.version !== version) throw versionConflict(current, version);
            // D10: archiving stops an active run and closes the AI session(s) before archiving.
            await runService.archiveTask({ taskId: current.id, actor });
          }
          const task = database.archiveTask(
            id,
            version,
            threadId,
            threadBinding,
            actor,
          );
          events.emit("task.archived", { task });
          return sendJson(response, 200, { task: withRunState(task) });
        }
        if (action === "restore" && request.method === "POST") {
          const current = database.getTask(id);
          if (current?.source === "jira") {
            throw new ApiError(409, "JIRA_RESTORE_UNAVAILABLE", "Jira 任務由同步範圍自動管理，不能手動恢復");
          }
          // DBG-01: restoring an archived todo AI card puts it back into the auto-claim queue.
          if (current) assertAutoClaimControl({ ...current, archivedAt: null });
          const { version, threadId, threadBinding } = resolveInputThreadBinding(
            parseVersionMutation(await readJson(request)),
          );
          const task = database.restoreTask(
            id,
            version,
            threadId,
            threadBinding,
            actorFromRequest(request),
          );
          events.emit("task.restored", { task });
          return sendJson(response, 200, { task: withRunState(task) });
        }
        return methodNotAllowed(response, action ? ["POST"] : ["GET", "PATCH", "DELETE"]);
      }

      if (pathname.startsWith("/api/")) {
        throw new ApiError(404, "NOT_FOUND", "API route not found");
      }
      if (await serveStatic(request, response, pathname, resolved.staticDirectory, url.searchParams)) return;
      throw new ApiError(404, "NOT_FOUND", "Resource not found");
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      if (error instanceof ApiError) {
        const payload = { error: { code: error.code, message: error.message } };
        if (error.details !== undefined) payload.error.details = error.details;
        sendJson(response, error.status, payload);
        return;
      }
      if (error instanceof CloudProxyError) {
        const payload = { error: { code: error.code, message: error.message } };
        if (error.details !== undefined) payload.error.details = error.details;
        sendJson(response, error.status, payload);
        return;
      }
      console.error(error);
      sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
    }
  }

  const server = createServer((request, response) => handleHttpRequest(request, response, "main"));

  const cloudRealtimeServer = new WebSocketServer({ noServer: true });
  const cloudRealtimeSockets = new Set();

  function rejectWebSocketUpgrade(socket, status, message) {
    const body = `${message}\n`;
    socket.end([
      `HTTP/1.1 ${status} ${message}`,
      "Connection: close",
      "Content-Type: text/plain; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body,
    ].join("\r\n"));
  }

  function closeOrTerminateWebSocket(webSocket, code, reason) {
    if (webSocket.readyState !== WebSocketClient.OPEN) {
      webSocket.terminate();
      return;
    }
    if (code >= 1000 && ![1004, 1005, 1006, 1015].includes(code)) {
      webSocket.close(code, reason);
    } else {
      webSocket.terminate();
    }
  }

  server.on("upgrade", async (request, socket, head) => {
    let remoteSocket;
    try {
      const incomingUrl = new URL(request.url, "http://127.0.0.1");
      if (resolved.instanceToken) {
        if (!incomingUrl.pathname.startsWith(`${routePrefix}/`)) {
          rejectWebSocketUpgrade(socket, 404, "Not Found");
          return;
        }
        request.url = `${incomingUrl.pathname.slice(routePrefix.length) || "/"}${incomingUrl.search}`;
      }
      assertTrustedNetworkRequest(
        request,
        Boolean(resolved.instanceToken),
        resolved.trustedOrigins,
      );
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname !== "/api/events" || [...url.searchParams.keys()].length > 0) {
        rejectWebSocketUpgrade(socket, 404, "Not Found");
        return;
      }
      assertLoopbackRequest(request);
      const target = await cloudProxy.webSocketTarget("/api/events");
      remoteSocket = new WebSocketClient(target.url, { headers: target.headers });
      const pendingMessages = [];
      const queueMessage = (data, isBinary) => pendingMessages.push({ data, isBinary });
      remoteSocket.on("message", queueMessage);
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          remoteSocket.off("open", onOpen);
          remoteSocket.off("error", onError);
          remoteSocket.off("close", onClose);
        };
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = (error) => {
          cleanup();
          reject(error);
        };
        const onClose = () => {
          cleanup();
          reject(new Error("Cloud realtime connection closed before opening"));
        };
        remoteSocket.once("open", onOpen);
        remoteSocket.once("error", onError);
        remoteSocket.once("close", onClose);
      });
      cloudRealtimeServer.handleUpgrade(request, socket, head, (localSocket) => {
        const pair = { localSocket, remoteSocket };
        cloudRealtimeSockets.add(pair);
        const removePair = () => cloudRealtimeSockets.delete(pair);
        const forwardMessage = (data, isBinary) => {
          if (localSocket.readyState === WebSocketClient.OPEN) {
            localSocket.send(data, { binary: isBinary });
          }
        };

        remoteSocket.off("message", queueMessage);
        remoteSocket.on("message", forwardMessage);
        for (const { data, isBinary } of pendingMessages) forwardMessage(data, isBinary);

        localSocket.on("message", () => {
          localSocket.close(1008, "Client messages are not supported");
        });
        localSocket.on("close", (code, reason) => {
          removePair();
          closeOrTerminateWebSocket(remoteSocket, code, reason);
        });
        localSocket.on("error", () => remoteSocket.terminate());

        remoteSocket.on("close", (code, reason) => {
          removePair();
          closeOrTerminateWebSocket(localSocket, code, reason);
        });
        remoteSocket.on("error", () => {
          if (localSocket.readyState === WebSocketClient.OPEN) {
            localSocket.close(1011, "Cloud realtime connection failed");
          }
        });
      });
    } catch (error) {
      remoteSocket?.terminate();
      rejectWebSocketUpgrade(socket, error?.status ?? 502, "WebSocket connection failed");
    }
  });

  let listening = false;
  return {
    database,
    aiChat,
    server,
    options: resolved,
    runService,
    runProviders,
    runChildEnvironment,
    scheduler,
    get mobileAccess() {
      return mobileAccess;
    },
    /** Resolves after the post-listen startup (run recovery, then scheduler start) has finished. */
    whenStarted() {
      return startupTask ?? Promise.resolve();
    },
    /** Resolves after the tailnet listener has been reconciled with the mobile access settings. */
    syncMobileListener() {
      return scheduleTailnetSync();
    },
    get tailnetAddress() {
      return tailnetServer ? tailnetBoundAddress : null;
    },
    async listen({ host = "127.0.0.1", port = resolvePort(), fd = null } = {}) {
      if (host !== "127.0.0.1" && host !== "0.0.0.0") {
        throw new Error("Taskboard server must bind to 127.0.0.1 or 0.0.0.0");
      }
      if (fd !== null && (!Number.isInteger(fd) || fd < 3 || fd > 255)) {
        throw new Error("Taskboard server listen fd must be an inherited file descriptor");
      }
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        if (fd === null) server.listen(port, host);
        else server.listen({ fd });
      });
      listening = true;
      const address = server.address();
      listenPort = typeof address === "object" && address ? address.port : null;
      if (listenPort !== null) initMobileAccess(listenPort);
      if (mobileAccess?.settings().enabled) void scheduleTailnetSync();
      if (!startupTask) {
        // C4: recover runs left active by a previous board process once, after listen succeeded;
        // the auto-claim scheduler starts only after recovery so it counts the recovered runs.
        startupTask = (async () => {
          try {
            await runService.recoverOnStartup();
          } catch (error) {
            runLogger.error(`[runs] startup recovery failed: ${error?.message ?? error}`);
          }
          if (enableScheduler && !closing) {
            scheduler.start();
            schedulerStarted = true;
            nudgeScheduler();
          }
        })();
      }
      return address;
    },
    async close() {
      closing = true;
      // W15 review O2: an open folder dialog must not outlive the board service.
      folderPicker.dispose?.();
      schedulerStarted = false;
      await scheduler.stop();
      if (startupTask) await startupTask.catch(() => {});
      // Background launches / deliveries write to the database. Amendment 7 (DBG-03): let in-flight starts
      // settle (bounded) BEFORE disposing providers, so a start is not cut short into an unmanaged session;
      // whatever is still running after the bound is disposed and then settled (bounded) again.
      // Both waits share one budget (RUN_SETTLE_ON_CLOSE_MS): the second only gets what the first left.
      const settleDeadline = closeClock.now() + RUN_SETTLE_ON_CLOSE_MS;
      const settleRuns = async (limitMs) => {
        const waitMs = Math.max(0, Math.min(limitMs, settleDeadline - closeClock.now()));
        let settleTimer;
        await Promise.race([
          runService.settle().catch(() => {}),
          new Promise((resolve) => {
            if (waitMs === 0) {
              resolve();
              return;
            }
            settleTimer = closeClock.setTimeout(resolve, waitMs);
            settleTimer?.unref?.();
          }),
        ]);
        if (settleTimer !== undefined) closeClock.clearTimeout(settleTimer);
      };
      // Shorter first bound: the desktop app force-quits the server a few seconds after asking it to stop.
      await settleRuns(RUN_SETTLE_BEFORE_DISPOSE_MS);
      const disposals = await Promise.allSettled(
        Object.values(runProviders).map((provider) => provider?.dispose?.()),
      );
      for (const result of disposals) {
        if (result.status === "rejected") {
          runLogger.warn(`[runs] provider dispose failed: ${result.reason?.message ?? result.reason}`);
        }
      }
      await settleRuns(RUN_SETTLE_ON_CLOSE_MS);
      await tailnetSync.catch(() => {});
      await closeTailnetListener();
      await mobileAccess?.close();
      for (const { localSocket, remoteSocket } of cloudRealtimeSockets) {
        localSocket.terminate();
        remoteSocket.terminate();
      }
      cloudRealtimeSockets.clear();
      cloudRealtimeServer.close();
      const serverClosed = listening
        ? new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
          })
        : Promise.resolve();
      events.close();
      for (const response of aiEventResponses) response.end();
      aiEventResponses.clear();
      await aiChat.close();
      await projectSummary.close();
      await serverClosed;
      listening = false;
      database.close();
    },
  };
}
