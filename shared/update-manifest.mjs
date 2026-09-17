// Amendment 11: shared-folder auto-update manifest (latest.json), signature and source resolution.
import { createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const UPDATE_MANIFEST_NAME = "latest.json";
export const UPDATE_SOURCE_FILE_NAME = "update-source.json";
export const UPDATE_SIGNATURE_DOMAIN = "automate-taskboard-update-v2";
/** Manifest `sigVersion`; any other value (or a missing one) is rejected. */
export const UPDATE_SIGNATURE_VERSION = 2;
/** Publish refuses longer notes; the checker truncates what it prints to this many characters. */
export const MAX_UPDATE_NOTES_LENGTH = 2_000;
/** Hard parse limit for notes in latest.json (anything larger is not a valid manifest). */
const MAX_MANIFEST_NOTES_LENGTH = 20_000;

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;
const INSTALLER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.exe$/;

export class UpdateError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function parseSemver(value) {
  const match = typeof value === "string" ? SEMVER_PATTERN.exec(value.trim()) : null;
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrereleaseIdentifier(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Semver 2.0 precedence: -1 when left < right, 0 when equal, 1 when left > right. */
export function compareSemver(left, right) {
  const a = typeof left === "string" ? parseSemver(left) : left;
  const b = typeof right === "string" ? parseSemver(right) : right;
  if (!a || !b) throw new UpdateError("INVALID_VERSION", `無效的版本號：${!a ? left : right}`);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    const result = comparePrereleaseIdentifier(a.prerelease[index], b.prerelease[index]);
    if (result !== 0) return result;
  }
  return 0;
}

export function notesSha256(notes = "") {
  return createHash("sha256").update(String(notes), "utf8").digest("hex");
}

/** Truncates notes for display / the checker output, ending with an ellipsis when shortened. */
export function truncateUpdateNotes(notes = "", limit = MAX_UPDATE_NOTES_LENGTH) {
  const characters = Array.from(String(notes));
  return characters.length <= limit ? String(notes) : `${characters.slice(0, limit - 1).join("")}…`;
}

/**
 * The exact bytes that are signed (sigVersion 2): one field per line, fixed order, trailing newline.
 * `notesSha256` binds the release notes shown in the update dialog to the signature.
 */
export function canonicalManifestString({ version, installer, sha256, size, notes = "" }) {
  return [
    UPDATE_SIGNATURE_DOMAIN,
    `version=${version}`,
    `installer=${installer}`,
    `sha256=${sha256}`,
    `size=${size}`,
    `notesSha256=${notesSha256(notes)}`,
    "",
  ].join("\n");
}

export function signManifest(fields, privateKey) {
  return cryptoSign(null, Buffer.from(canonicalManifestString(fields), "utf8"), privateKey).toString("base64");
}

/** Validates the shape of latest.json; throws UpdateError with a Traditional Chinese message. */
export function parseManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UpdateError("INVALID_MANIFEST", "更新資訊格式錯誤。");
  }
  const { version, installer, sha256, size, notes = "", signature, sigVersion } = value;
  if (sigVersion !== UPDATE_SIGNATURE_VERSION) {
    throw new UpdateError("UNSUPPORTED_SIGNATURE_VERSION", "更新資訊的簽章格式不受支援，已停止更新。");
  }
  if (!parseSemver(version)) throw new UpdateError("INVALID_MANIFEST", "更新資訊的版本號無效。");
  if (typeof installer !== "string" || !INSTALLER_PATTERN.test(installer) || path.basename(installer) !== installer) {
    throw new UpdateError("INVALID_MANIFEST", "更新資訊的安裝檔名稱無效。");
  }
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new UpdateError("INVALID_MANIFEST", "更新資訊的 SHA-256 無效。");
  }
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new UpdateError("INVALID_MANIFEST", "更新資訊的檔案大小無效。");
  }
  if (typeof notes !== "string" || notes.length > MAX_MANIFEST_NOTES_LENGTH) {
    throw new UpdateError("INVALID_MANIFEST", "更新資訊的說明無效。");
  }
  if (typeof signature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
    throw new UpdateError("INVALID_MANIFEST", "更新資訊缺少簽章。");
  }
  return { version, installer, sha256, size, notes, sigVersion, signature };
}

export function verifyManifestSignature(manifest, publicKeyPem) {
  if (manifest?.sigVersion !== UPDATE_SIGNATURE_VERSION) {
    throw new UpdateError("UNSUPPORTED_SIGNATURE_VERSION", "更新資訊的簽章格式不受支援，已停止更新。");
  }
  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    throw new UpdateError("INVALID_PUBLIC_KEY", "更新公鑰無效。");
  }
  const valid = cryptoVerify(
    null,
    Buffer.from(canonicalManifestString(manifest), "utf8"),
    key,
    Buffer.from(manifest.signature, "base64"),
  );
  if (!valid) throw new UpdateError("BAD_SIGNATURE", "更新資訊的簽章驗證失敗，已停止更新。");
  return manifest;
}

/** Parses + verifies a manifest; returns it with `newer` against the current version. */
export function evaluateManifest(value, { publicKeyPem, currentVersion }) {
  const manifest = verifyManifestSignature(parseManifest(value), publicKeyPem);
  return { ...manifest, newer: compareSemver(manifest.version, currentVersion) > 0 };
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest("hex"), size };
}

/** Checks a local installer copy against a verified manifest. */
export async function verifyInstallerFile(filePath, manifest) {
  const { sha256, size } = await sha256File(filePath);
  if (size !== manifest.size) {
    throw new UpdateError("SIZE_MISMATCH", `安裝檔大小不符（預期 ${manifest.size}，實際 ${size}）。`);
  }
  if (sha256 !== manifest.sha256) {
    throw new UpdateError("SHA256_MISMATCH", "安裝檔 SHA-256 不符，檔案可能損毀或遭到竄改。");
  }
  return { sha256, size };
}

async function readSourceFile(filePath) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new UpdateError("CONFIG_UNREADABLE", `無法讀取更新設定檔：${filePath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new UpdateError("CONFIG_INVALID", `更新設定檔格式錯誤：${filePath}`);
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.source !== "string") {
    throw new UpdateError("CONFIG_INVALID", `更新設定檔缺少 source 字串：${filePath}`);
  }
  return parsed.source.trim();
}

/**
 * Update source: the app-data override file wins when it exists (an empty source there turns
 * updates off); otherwise the build resource baked from AUTOMATE_UPDATE_SOURCE. Empty = disabled.
 */
export async function resolveUpdateSource({ buildConfigPath, overrideConfigPath }) {
  if (overrideConfigPath) {
    const override = await readSourceFile(overrideConfigPath);
    if (override !== null) return { source: override || null, origin: "override" };
  }
  if (buildConfigPath) {
    const build = await readSourceFile(buildConfigPath);
    if (build !== null) return { source: build || null, origin: "build" };
  }
  return { source: null, origin: "none" };
}

/** Build resource content (resources/update-source.json) from the AUTOMATE_UPDATE_SOURCE build env. */
export function updateSourceConfig(env) {
  const source = String(env.AUTOMATE_UPDATE_SOURCE ?? "").trim();
  // A shell can eat one leading backslash of a UNC path (\\server -> \server), which would ship a
  // root-relative path that never resolves; refuse anything that is not UNC, a drive path, or POSIX absolute.
  if (source && !/^\\\\[^\\]+\\[^\\]+/.test(source) && !/^[A-Za-z]:[\\/]/.test(source) && !source.startsWith("/")) {
    throw new Error(`AUTOMATE_UPDATE_SOURCE must be a UNC path (\\\\server\\share\\...) or an absolute path, got: ${source}`);
  }
  return { source };
}

export function joinUpdateSource(source, name) {
  // UNC (\\server\share) and drive paths use Windows separators; keep the source's own style.
  return source.includes("\\") ? path.win32.join(source, name) : path.join(source, name);
}
