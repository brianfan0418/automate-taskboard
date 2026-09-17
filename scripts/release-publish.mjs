#!/usr/bin/env node
// Amendment 11: publishes a built Windows installer to the shared update folder.
//   npm run release:publish -- [--installer PATH] [--source DIR] [--private-key PEM] [--notes TEXT | --notes-file FILE] [--force]
// Defaults: source = AUTOMATE_UPDATE_SOURCE, private key = AUTOMATE_UPDATE_PRIVATE_KEY or
// ~/.automate-taskboard/update-ed25519.pem, installer = the NSIS output for package.json's version.
import { createPrivateKey, createPublicKey } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { UPDATE_PUBLIC_KEY_PEM } from "../shared/update-public-key.mjs";
import {
  MAX_UPDATE_NOTES_LENGTH,
  UPDATE_MANIFEST_NAME,
  UPDATE_SIGNATURE_VERSION,
  compareSemver,
  joinUpdateSource,
  parseManifest,
  sha256File,
  signManifest,
  verifyManifestSignature,
} from "../shared/update-manifest.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PRIVATE_KEY_PATH = path.join(os.homedir(), ".automate-taskboard", "update-ed25519.pem");

export function publishedInstallerName(version) {
  return `AutoMateTaskboard-${version}-setup.exe`;
}

export async function findNsisInstaller(root, version) {
  const candidates = [
    path.join(root, "src-tauri", "target", "x86_64-pc-windows-msvc", "release", "bundle", "nsis"),
    path.join(root, "src-tauri", "target", "release", "bundle", "nsis"),
  ];
  for (const directory of candidates) {
    let names;
    try {
      names = await readdir(directory);
    } catch {
      continue;
    }
    const match = names.find((name) => name.endsWith(`_${version}_x64-setup.exe`));
    if (match) return path.join(directory, match);
  }
  throw new Error(`No NSIS installer for version ${version} found; pass --installer PATH`);
}

async function writeAtomically(target, write) {
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await write(temporary);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function existingManifestVersion(source) {
  try {
    const text = await readFile(joinUpdateSource(source, UPDATE_MANIFEST_NAME), "utf8");
    return parseManifest(JSON.parse(text.replace(/^\uFEFF/, ""))).version;
  } catch {
    return null;
  }
}

export async function publishRelease({
  installerPath,
  source,
  privateKeyPath = DEFAULT_PRIVATE_KEY_PATH,
  version,
  notes = "",
  force = false,
  publicKeyPem = UPDATE_PUBLIC_KEY_PEM,
  root = projectRoot,
}) {
  if (!source) throw new Error("Update source is empty; set AUTOMATE_UPDATE_SOURCE or pass --source");
  if (typeof notes !== "string") throw new Error("Release notes must be a string");
  notes = notes.replace(/^\uFEFF/, "");
  if (Array.from(notes).length > MAX_UPDATE_NOTES_LENGTH) {
    throw new Error(`Release notes are too long (max ${MAX_UPDATE_NOTES_LENGTH} characters); shorten --notes / --notes-file`);
  }
  if (!version) version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
  installerPath ??= await findNsisInstaller(root, version);

  if (!publicKeyPem?.trim()) {
    throw new Error("shared/update-public-key.mjs has no public key; run `npm run update:keygen` first");
  }
  const privateKey = createPrivateKey(await readFile(privateKeyPath, "utf8"));
  const derivedPublic = createPublicKey(privateKey).export({ type: "spki", format: "pem" });
  if (derivedPublic.trim() !== publicKeyPem.trim()) {
    throw new Error("The private key does not match the public key shipped in shared/update-public-key.mjs");
  }
  if ((await stat(source).catch(() => null))?.isDirectory() !== true) {
    throw new Error(`Update source folder is not reachable: ${source}`);
  }
  const previous = await existingManifestVersion(source);
  if (previous && !force && compareSemver(version, previous) <= 0) {
    throw new Error(`Version ${version} is not newer than the published ${previous}; pass --force to republish`);
  }

  const { sha256, size } = await sha256File(installerPath);
  const installer = publishedInstallerName(version);
  const signature = signManifest({ version, installer, sha256, size, notes }, privateKey);
  const manifest = verifyManifestSignature(
    parseManifest({ version, installer, sha256, size, notes, sigVersion: UPDATE_SIGNATURE_VERSION, signature }),
    publicKeyPem,
  );

  const publishedInstaller = joinUpdateSource(source, installer);
  await writeAtomically(publishedInstaller, (temporary) => copyFile(installerPath, temporary));
  const copied = await sha256File(publishedInstaller);
  if (copied.sha256 !== sha256 || copied.size !== size) {
    throw new Error("The copied installer does not match the local build");
  }
  // latest.json last: clients never see a manifest whose installer is not in place yet.
  await writeAtomically(
    joinUpdateSource(source, UPDATE_MANIFEST_NAME),
    (temporary) => writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`),
  );
  const archived = await archiveOlderInstallers(source, installer);
  return { manifest, installerPath, publishedInstaller, archived };
}

export const ARCHIVE_FOLDER_NAME = "舊版";

// Keep only the current installer next to latest.json; older ones move into 舊版. A file still open
// (a client copying it from the previous manifest) is left for the next publish.
async function archiveOlderInstallers(source, currentInstaller) {
  const archived = [];
  const older = (await readdir(source)).filter(
    (name) => /^AutoMateTaskboard-.+-setup\.exe$/.test(name) && name !== currentInstaller,
  );
  if (older.length === 0) return archived;
  const archive = joinUpdateSource(source, ARCHIVE_FOLDER_NAME);
  await mkdir(archive, { recursive: true });
  for (const name of older) {
    try {
      await rename(joinUpdateSource(source, name), joinUpdateSource(archive, name));
      archived.push(name);
    } catch {
      // Busy or already moved; retried on the next publish.
    }
  }
  return archived;
}

async function main(argv) {
  const options = {
    source: process.env.AUTOMATE_UPDATE_SOURCE?.trim() || undefined,
    privateKeyPath: process.env.AUTOMATE_UPDATE_PRIVATE_KEY?.trim() || DEFAULT_PRIVATE_KEY_PATH,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force") options.force = true;
    else if (argument === "--installer") options.installerPath = argv[++index];
    else if (argument === "--source") options.source = argv[++index];
    else if (argument === "--private-key") options.privateKeyPath = argv[++index];
    else if (argument === "--notes") options.notes = argv[++index];
    else if (argument === "--notes-file") options.notes = await readFile(argv[++index], "utf8");
    else if (argument === "--version") options.version = argv[++index];
    else throw new Error(`Unknown option: ${argument}`);
  }
  const result = await publishRelease(options);
  console.log(JSON.stringify({
    published: result.publishedInstaller,
    version: result.manifest.version,
    sha256: result.manifest.sha256,
    size: result.manifest.size,
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
