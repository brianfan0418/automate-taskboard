// Mobile access settings persisted at <dataDirectory>/mobile-access.json.
// Ported from fork server/mobile-access-settings.mjs (HEAD dae7302) with the Serve cleanup
// fields removed. v2 shape: { version: 1, enabled: boolean, url: string|null }.
// Synchronous on purpose: C7 `settings()` is synchronous and the file is tiny.
import {
  mkdirSync as defaultMkdirSync,
  readFileSync as defaultReadFileSync,
  renameSync as defaultRenameSync,
  writeFileSync as defaultWriteFileSync,
} from "node:fs";
import path from "node:path";

import { MOBILE_ACCESS_SETTINGS_VERSION } from "../../shared/mobile-access-contract.mjs";

export class MobileAccessSettingsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MobileAccessSettingsError";
    this.code = code;
  }
}

function invalid() {
  return new MobileAccessSettingsError("MOBILE_ACCESS_SETTINGS_INVALID", "Mobile access settings are invalid");
}

function defaultSettings() {
  return { enabled: false, url: null };
}

function normalizeUrl(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw invalid();
  }
  return url.toString();
}

export function parseMobileAccessSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.version !== MOBILE_ACCESS_SETTINGS_VERSION || typeof value.enabled !== "boolean"
    || Object.keys(value).some((key) => !["version", "enabled", "url"].includes(key))) {
    throw invalid();
  }
  const url = normalizeUrl(value.url);
  return { enabled: value.enabled, url: value.enabled ? url : null };
}

export function createMobileAccessSettingsStore({
  configPath,
  logger = null,
  fs = {},
} = {}) {
  if (typeof configPath !== "string" || !configPath) throw new TypeError("configPath is required");
  const readFileSync = fs.readFileSync ?? defaultReadFileSync;
  const writeFileSync = fs.writeFileSync ?? defaultWriteFileSync;
  const renameSync = fs.renameSync ?? defaultRenameSync;
  const mkdirSync = fs.mkdirSync ?? defaultMkdirSync;

  function load() {
    let text;
    try {
      text = readFileSync(configPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return defaultSettings();
      logger?.warn?.(`[mobile-access] cannot read settings (${error?.code ?? "error"}); mobile access stays disabled`);
      return defaultSettings();
    }
    try {
      return parseMobileAccessSettings(JSON.parse(text));
    } catch {
      // Fail closed: a damaged file never enables remote access.
      logger?.warn?.("[mobile-access] settings file is invalid; mobile access stays disabled");
      return defaultSettings();
    }
  }

  let current = load();

  return Object.freeze({
    read() {
      return { ...current };
    },
    write({ enabled, url = null }) {
      if (typeof enabled !== "boolean") throw new TypeError("enabled must be boolean");
      const next = parseMobileAccessSettings({ version: MOBILE_ACCESS_SETTINGS_VERSION, enabled, url });
      mkdirSync(path.dirname(configPath), { recursive: true });
      const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
      const body = `${JSON.stringify({ version: MOBILE_ACCESS_SETTINGS_VERSION, ...next }, null, 2)}\n`;
      writeFileSync(temporaryPath, body, { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryPath, configPath);
      current = next;
      return { ...current };
    },
  });
}
