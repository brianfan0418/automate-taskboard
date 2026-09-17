// Amendment 11: shared-folder auto-update (manifest verification, semver, config, publish, checker).
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { UPDATE_PUBLIC_KEY_PEM } from "../shared/update-public-key.mjs";
import {
  MAX_UPDATE_NOTES_LENGTH,
  UpdateError,
  canonicalManifestString,
  compareSemver,
  evaluateManifest,
  parseManifest,
  resolveUpdateSource,
  notesSha256,
  sha256File,
  signManifest,
  truncateUpdateNotes,
  updateSourceConfig,
  verifyInstallerFile,
} from "../shared/update-manifest.mjs";
import { publishRelease, publishedInstallerName } from "../scripts/release-publish.mjs";
import { runUpdateCommand } from "../scripts/update-check.mjs";
import { generateUpdateKeys } from "../scripts/update-keygen.mjs";

function verifyManifestSignatureWithout(manifest, keys) {
  const { sigVersion: _omitted, ...rest } = manifest;
  return evaluateManifest(rest, { publicKeyPem: keys.publicPem, currentVersion: "2.0.0" });
}

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

function signedManifest(keys, overrides = {}) {
  const fields = {
    version: "2.0.1",
    installer: "AutoMateTaskboard-2.0.1-setup.exe",
    sha256: "a".repeat(64),
    size: 1234,
    notes: "修正匯入",
    ...overrides,
  };
  return { ...fields, sigVersion: 2, signature: signManifest(fields, keys.privateKey) };
}

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return directory;
}

const rejectsCode = (promiseOrFn, code) => (
  typeof promiseOrFn === "function"
    ? assert.throws(promiseOrFn, (error) => error instanceof UpdateError && error.code === code)
    : assert.rejects(promiseOrFn, (error) => error instanceof UpdateError && error.code === code)
);

test("semver compare follows major/minor/patch and prerelease precedence", () => {
  assert.equal(compareSemver("2.0.1", "2.0.0"), 1);
  assert.equal(compareSemver("2.0.0", "2.0.1"), -1);
  assert.equal(compareSemver("2.0.0", "2.0.0"), 0);
  assert.equal(compareSemver("2.10.0", "2.9.9"), 1);
  assert.equal(compareSemver("10.0.0", "9.99.99"), 1);
  assert.equal(compareSemver("2.0.1", "2.0.1-beta.3"), 1);
  assert.equal(compareSemver("2.0.1-beta.10", "2.0.1-beta.9"), 1);
  assert.equal(compareSemver("2.0.1-beta", "2.0.1-beta.1"), -1);
  assert.equal(compareSemver("2.0.1-alpha", "2.0.1-1"), 1);
  rejectsCode(() => compareSemver("2.0", "2.0.0"), "INVALID_VERSION");
  rejectsCode(() => compareSemver("v2.0.0", "2.0.0"), "INVALID_VERSION");
});

test("manifest verification: good, tampered sha, bad signature, older version", () => {
  const keys = keyPair();
  const good = signedManifest(keys);
  const result = evaluateManifest(good, { publicKeyPem: keys.publicPem, currentVersion: "2.0.0" });
  assert.equal(result.newer, true);
  assert.equal(result.version, "2.0.1");

  rejectsCode(
    () => evaluateManifest({ ...good, sha256: "b".repeat(64) }, { publicKeyPem: keys.publicPem, currentVersion: "2.0.0" }),
    "BAD_SIGNATURE",
  );
  rejectsCode(
    () => evaluateManifest({ ...good, size: 1235 }, { publicKeyPem: keys.publicPem, currentVersion: "2.0.0" }),
    "BAD_SIGNATURE",
  );
  rejectsCode(
    () => evaluateManifest({ ...good, version: "9.0.0" }, { publicKeyPem: keys.publicPem, currentVersion: "2.0.0" }),
    "BAD_SIGNATURE",
  );
  const other = keyPair();
  rejectsCode(
    () => evaluateManifest(good, { publicKeyPem: other.publicPem, currentVersion: "2.0.0" }),
    "BAD_SIGNATURE",
  );
  rejectsCode(
    () => evaluateManifest({ ...good, signature: Buffer.alloc(64).toString("base64") }, { publicKeyPem: keys.publicPem, currentVersion: "2.0.0" }),
    "BAD_SIGNATURE",
  );

  // W11 review #2: the notes shown in the update dialog are covered by the signature.
  rejectsCode(
    () => evaluateManifest({ ...good, notes: "請到 http://example.test 重新輸入帳密" }, { publicKeyPem: keys.publicPem, currentVersion: "2.0.0" }),
    "BAD_SIGNATURE",
  );
  rejectsCode(
    () => evaluateManifest({ ...good, notes: "" }, { publicKeyPem: keys.publicPem, currentVersion: "2.0.0" }),
    "BAD_SIGNATURE",
  );
  // Unknown or old signature formats are refused before the signature is even checked.
  for (const sigVersion of [undefined, 1, 3, "2"]) {
    rejectsCode(
      () => evaluateManifest({ ...good, sigVersion }, { publicKeyPem: keys.publicPem, currentVersion: "2.0.0" }),
      "UNSUPPORTED_SIGNATURE_VERSION",
    );
  }
  rejectsCode(() => verifyManifestSignatureWithout(good, keys), "UNSUPPORTED_SIGNATURE_VERSION");

  const older = signedManifest(keys, { version: "1.9.9", installer: "AutoMateTaskboard-1.9.9-setup.exe" });
  assert.equal(evaluateManifest(older, { publicKeyPem: keys.publicPem, currentVersion: "2.0.0" }).newer, false);
  const same = signedManifest(keys, { version: "2.0.0" });
  assert.equal(evaluateManifest(same, { publicKeyPem: keys.publicPem, currentVersion: "2.0.0" }).newer, false);
});

test("manifest shape rejects path tricks and malformed fields", () => {
  const keys = keyPair();
  const good = signedManifest(keys);
  for (const installer of ["..\\evil.exe", "../evil.exe", "sub/evil.exe", "evil.bat", "C:\\x.exe", ""]) {
    rejectsCode(() => parseManifest({ ...good, installer }), "INVALID_MANIFEST");
  }
  rejectsCode(() => parseManifest({ ...good, sha256: "A".repeat(64) }), "INVALID_MANIFEST");
  rejectsCode(() => parseManifest({ ...good, size: 0 }), "INVALID_MANIFEST");
  rejectsCode(() => parseManifest({ ...good, size: "1234" }), "INVALID_MANIFEST");
  rejectsCode(() => parseManifest({ ...good, signature: undefined }), "INVALID_MANIFEST");
  rejectsCode(() => parseManifest([]), "INVALID_MANIFEST");
  assert.equal(
    canonicalManifestString(good),
    "automate-taskboard-update-v2\nversion=2.0.1\ninstaller=AutoMateTaskboard-2.0.1-setup.exe\n"
      + `sha256=${"a".repeat(64)}\nsize=1234\nnotesSha256=${notesSha256("修正匯入")}\n`,
  );
  assert.equal(notesSha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  rejectsCode(() => parseManifest({ ...good, notes: "x".repeat(20_001) }), "INVALID_MANIFEST");
});

test("the committed public key is an empty placeholder or a valid ed25519 SPKI key", () => {
  const keys = keyPair();
  if (UPDATE_PUBLIC_KEY_PEM === "") {
    // Public source ships no key: every manifest is refused until `npm run update:keygen` runs.
    rejectsCode(
      () => evaluateManifest(signedManifest(keys), { publicKeyPem: UPDATE_PUBLIC_KEY_PEM, currentVersion: "2.0.0" }),
      "INVALID_PUBLIC_KEY",
    );
    return;
  }
  assert.match(UPDATE_PUBLIC_KEY_PEM, /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=]+\n-----END PUBLIC KEY-----\n$/);
  // A manifest signed by another key never verifies against the shipped public key.
  rejectsCode(
    () => evaluateManifest(signedManifest(keys), { publicKeyPem: UPDATE_PUBLIC_KEY_PEM, currentVersion: "2.0.0" }),
    "BAD_SIGNATURE",
  );
});

test("config resolution: build resource, app-data override, empty and missing", async (t) => {
  const directory = await temporaryDirectory(t, "update-config-");
  const buildConfigPath = path.join(directory, "resources", "update-source.json");
  const overrideConfigPath = path.join(directory, "appdata", "update-source.json");
  await mkdir(path.dirname(buildConfigPath), { recursive: true });
  await mkdir(path.dirname(overrideConfigPath), { recursive: true });

  assert.deepEqual(await resolveUpdateSource({ buildConfigPath, overrideConfigPath }), { source: null, origin: "none" });

  await writeFile(buildConfigPath, JSON.stringify(updateSourceConfig({ AUTOMATE_UPDATE_SOURCE: " \\\\192.0.2.10\\共享\\updates " })));
  assert.deepEqual(await resolveUpdateSource({ buildConfigPath, overrideConfigPath }), {
    source: "\\\\192.0.2.10\\共享\\updates",
    origin: "build",
  });

  await writeFile(overrideConfigPath, `\uFEFF${JSON.stringify({ source: "D:\\updates" })}`);
  assert.deepEqual(await resolveUpdateSource({ buildConfigPath, overrideConfigPath }), { source: "D:\\updates", origin: "override" });

  // An empty override disables updates even when the build has a source.
  await writeFile(overrideConfigPath, JSON.stringify({ source: "" }));
  assert.deepEqual(await resolveUpdateSource({ buildConfigPath, overrideConfigPath }), { source: null, origin: "override" });

  await rm(overrideConfigPath);
  await writeFile(buildConfigPath, JSON.stringify(updateSourceConfig({})));
  assert.deepEqual(await resolveUpdateSource({ buildConfigPath, overrideConfigPath }), { source: null, origin: "build" });

  await writeFile(overrideConfigPath, "{not json");
  await rejectsCode(resolveUpdateSource({ buildConfigPath, overrideConfigPath }), "CONFIG_INVALID");
  await writeFile(overrideConfigPath, JSON.stringify({ source: 5 }));
  await rejectsCode(resolveUpdateSource({ buildConfigPath, overrideConfigPath }), "CONFIG_INVALID");
});

test("publish script signs, copies the installer and writes latest.json atomically", async (t) => {
  const directory = await temporaryDirectory(t, "update-publish-");
  const keys = keyPair();
  const privateKeyPath = path.join(directory, "secrets", "key.pem");
  await mkdir(path.dirname(privateKeyPath), { recursive: true });
  await writeFile(privateKeyPath, keys.privatePem);
  const source = path.join(directory, "share");
  await mkdir(source);
  const installerPath = path.join(directory, "AutoMate Taskboard_2.0.1_x64-setup.exe");
  await writeFile(installerPath, Buffer.from("fake installer 2.0.1"));

  const result = await publishRelease({
    installerPath,
    source,
    privateKeyPath,
    version: "2.0.1",
    notes: "修正匯入與自動更新",
    publicKeyPem: keys.publicPem,
  });
  assert.equal(result.manifest.installer, publishedInstallerName("2.0.1"));
  assert.deepEqual((await readdir(source)).sort(), ["AutoMateTaskboard-2.0.1-setup.exe", "latest.json"]);
  const manifest = JSON.parse(await readFile(path.join(source, "latest.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest).sort(), ["installer", "notes", "sha256", "sigVersion", "signature", "size", "version"]);
  const verified = evaluateManifest(manifest, { publicKeyPem: keys.publicPem, currentVersion: "2.0.0" });
  assert.equal(verified.newer, true);
  assert.equal(manifest.sigVersion, 2);
  assert.deepEqual(await sha256File(path.join(source, manifest.installer)), { sha256: manifest.sha256, size: manifest.size });

  // Republishing the same or an older version needs --force.
  await assert.rejects(
    publishRelease({ installerPath, source, privateKeyPath, version: "2.0.1", publicKeyPem: keys.publicPem }),
    /not newer/,
  );
  await publishRelease({ installerPath, source, privateKeyPath, version: "2.0.1", publicKeyPem: keys.publicPem, force: true });

  // A private key that does not match the shipped public key is refused before anything is written.
  const other = keyPair();
  await assert.rejects(
    publishRelease({ installerPath, source, privateKeyPath, version: "2.0.2", publicKeyPem: other.publicPem }),
    /does not match/,
  );
  await assert.rejects(
    publishRelease({ installerPath, source: "", privateKeyPath, version: "2.0.2", publicKeyPem: keys.publicPem }),
    /Update source is empty/,
  );
  // Over-long notes are refused at publish time (the checker would truncate them anyway).
  await assert.rejects(
    publishRelease({
      installerPath, source, privateKeyPath, version: "2.0.2", publicKeyPem: keys.publicPem,
      notes: "長".repeat(MAX_UPDATE_NOTES_LENGTH + 1),
    }),
    /too long/,
  );
  const newer = await publishRelease({
    installerPath, source, privateKeyPath, version: "2.0.2", publicKeyPem: keys.publicPem,
    notes: "長".repeat(MAX_UPDATE_NOTES_LENGTH),
  });
  assert.equal((await readdir(source)).some((name) => name.includes(".tmp-")), false);
  // A newer publish moves the previous installer into 舊版 and leaves only the current one beside latest.json.
  assert.deepEqual(newer.archived, ["AutoMateTaskboard-2.0.1-setup.exe"]);
  assert.deepEqual((await readdir(source)).sort(), ["AutoMateTaskboard-2.0.2-setup.exe", "latest.json", "舊版"]);
  assert.deepEqual(await readdir(path.join(source, "舊版")), ["AutoMateTaskboard-2.0.1-setup.exe"]);
});

test("notes truncation keeps short notes and ends long notes with an ellipsis", () => {
  assert.equal(truncateUpdateNotes("短說明"), "短說明");
  const long = truncateUpdateNotes("說".repeat(MAX_UPDATE_NOTES_LENGTH + 500));
  assert.equal(Array.from(long).length, MAX_UPDATE_NOTES_LENGTH);
  assert.ok(long.endsWith("\u2026"));
  assert.ok(Buffer.byteLength(long, "utf8") < 8 * 1024);
  assert.equal(truncateUpdateNotes("😀".repeat(5), 3), "😀😀\u2026");
});

test("checker truncates long signed notes, rejects an oversized share installer before copying and keeps only the current download", async (t) => {
  const directory = await temporaryDirectory(t, "update-check-size-");
  const keys = keyPair();
  const source = path.join(directory, "share");
  await mkdir(source);
  const buildConfigPath = path.join(directory, "update-source.json");
  await writeFile(buildConfigPath, JSON.stringify({ source }));
  const tempDirectory = path.join(directory, "temp");
  await mkdir(tempDirectory);
  await writeFile(path.join(tempDirectory, "AutoMateTaskboard-2.0.0-setup.exe"), "old installer");
  await writeFile(path.join(tempDirectory, "AutoMateTaskboard-2.0.1-setup.exe.partial-99999"), "stale partial");
  const base = { buildConfigPath, overrideConfigPath: path.join(directory, "missing.json"), tempDirectory };
  const options = { publicKeyPem: keys.publicPem };

  const installerBytes = Buffer.from("installer bytes");
  const { sha256 } = await (async () => {
    const file = path.join(directory, "build.exe");
    await writeFile(file, installerBytes);
    return sha256File(file);
  })();
  // A manifest signed directly (bypassing the publish limit) with very long notes.
  const notes = "更新說明".repeat(5_000);
  const fields = { version: "2.0.1", installer: "AutoMateTaskboard-2.0.1-setup.exe", sha256, size: installerBytes.length, notes };
  await writeFile(path.join(source, "latest.json"), JSON.stringify({ ...fields, sigVersion: 2, signature: signManifest(fields, keys.privateKey) }));

  const available = await runUpdateCommand({ ...base, command: "check", currentVersion: "2.0.0" }, options);
  assert.equal(available.status, "available");
  assert.equal(Array.from(available.notes).length, MAX_UPDATE_NOTES_LENGTH);
  assert.ok(Buffer.byteLength(JSON.stringify(available), "utf8") < 8 * 1024);

  // An installer on the share larger than the signed size is refused without writing to temp.
  await writeFile(path.join(source, "AutoMateTaskboard-2.0.1-setup.exe"), Buffer.alloc(4 * 1024 * 1024, 1));
  await rejectsCode(runUpdateCommand({ ...base, command: "prepare", currentVersion: "2.0.0" }, options), "SIZE_MISMATCH");
  assert.deepEqual(await readdir(tempDirectory), []);

  await writeFile(path.join(source, "AutoMateTaskboard-2.0.1-setup.exe"), installerBytes);
  const ready = await runUpdateCommand({ ...base, command: "prepare", currentVersion: "2.0.0" }, options);
  assert.equal(ready.status, "ready");
  assert.deepEqual(await readdir(tempDirectory), ["AutoMateTaskboard-2.0.1-setup.exe"]);
});

test("checker: disabled, available, none, prepare verifies the copy, tampering is refused", async (t) => {
  const directory = await temporaryDirectory(t, "update-check-");
  const keys = keyPair();
  const privateKeyPath = path.join(directory, "key.pem");
  await writeFile(privateKeyPath, keys.privatePem);
  const source = path.join(directory, "share");
  await mkdir(source);
  const buildConfigPath = path.join(directory, "update-source.json");
  const tempDirectory = path.join(directory, "temp");
  const base = { buildConfigPath, overrideConfigPath: path.join(directory, "missing.json"), tempDirectory };
  const options = { publicKeyPem: keys.publicPem };

  await writeFile(buildConfigPath, JSON.stringify({ source: "" }));
  assert.deepEqual(await runUpdateCommand({ ...base, command: "check", currentVersion: "2.0.0" }, options), { status: "disabled" });

  await writeFile(buildConfigPath, JSON.stringify({ source }));
  await rejectsCode(runUpdateCommand({ ...base, command: "check", currentVersion: "2.0.0" }, options), "MANIFEST_MISSING");

  const installerPath = path.join(directory, "build.exe");
  await writeFile(installerPath, Buffer.from("installer bytes"));
  await publishRelease({ installerPath, source, privateKeyPath, version: "2.0.1", notes: "說明", publicKeyPem: keys.publicPem });

  const available = await runUpdateCommand({ ...base, command: "check", currentVersion: "2.0.0" }, options);
  assert.equal(available.status, "available");
  assert.equal(available.version, "2.0.1");
  assert.equal(available.notes, "說明");
  assert.equal((await runUpdateCommand({ ...base, command: "check", currentVersion: "2.0.1" }, options)).status, "none");
  await rejectsCode(runUpdateCommand({ ...base, command: "prepare", currentVersion: "2.0.1" }, options), "NOT_NEWER");
  await rejectsCode(
    runUpdateCommand({ ...base, command: "prepare", currentVersion: "2.0.0", expectVersion: "2.0.2" }, options),
    "VERSION_CHANGED",
  );

  const ready = await runUpdateCommand({ ...base, command: "prepare", currentVersion: "2.0.0", expectVersion: "2.0.1" }, options);
  assert.equal(ready.status, "ready");
  assert.equal(ready.installerPath, path.join(tempDirectory, "AutoMateTaskboard-2.0.1-setup.exe"));
  assert.equal(await readFile(ready.installerPath, "utf8"), "installer bytes");

  // Swapping the installer on the share (same size, different bytes) fails the SHA-256 check.
  await writeFile(path.join(source, "AutoMateTaskboard-2.0.1-setup.exe"), Buffer.from("installer bytez"));
  await rejectsCode(runUpdateCommand({ ...base, command: "prepare", currentVersion: "2.0.0" }, options), "SHA256_MISMATCH");
  await writeFile(path.join(source, "AutoMateTaskboard-2.0.1-setup.exe"), Buffer.from("short"));
  await rejectsCode(runUpdateCommand({ ...base, command: "prepare", currentVersion: "2.0.0" }, options), "SIZE_MISMATCH");
  assert.equal((await readdir(tempDirectory)).some((name) => name.includes(".partial-")), false);

  // Editing latest.json (e.g. pointing at another hash) breaks the signature.
  const manifest = JSON.parse(await readFile(path.join(source, "latest.json"), "utf8"));
  await writeFile(path.join(source, "latest.json"), JSON.stringify({ ...manifest, sha256: "0".repeat(64) }));
  await rejectsCode(runUpdateCommand({ ...base, command: "check", currentVersion: "2.0.0" }, options), "BAD_SIGNATURE");
  // Editing only the notes breaks the signature too (W11 review #2).
  await writeFile(path.join(source, "latest.json"), JSON.stringify({ ...manifest, notes: "請重新輸入帳密" }));
  await rejectsCode(runUpdateCommand({ ...base, command: "check", currentVersion: "2.0.0" }, options), "BAD_SIGNATURE");

  await rm(path.join(source, "latest.json"));
  await rm(path.join(source, "AutoMateTaskboard-2.0.1-setup.exe"));
  await verifyInstallerFile(ready.installerPath, { size: 15, sha256: (await sha256File(ready.installerPath)).sha256 });
});

test("keygen refuses to write the private key inside the repository and writes the public module", async (t) => {
  const directory = await temporaryDirectory(t, "update-keygen-");
  const repositoryRoot = path.join(directory, "repo");
  await mkdir(path.join(repositoryRoot, "shared"), { recursive: true });
  await assert.rejects(
    generateUpdateKeys({
      repositoryRoot,
      privateKeyPath: path.join(repositoryRoot, "key.pem"),
      publicModulePath: path.join(repositoryRoot, "shared", "update-public-key.mjs"),
    }),
    /inside the repository/,
  );
  const privateKeyPath = path.join(directory, "secrets", "key.pem");
  const publicModulePath = path.join(repositoryRoot, "shared", "update-public-key.mjs");
  const result = await generateUpdateKeys({ repositoryRoot, privateKeyPath, publicModulePath });
  const module = await import(`file://${publicModulePath.replaceAll("\\", "/")}`);
  assert.equal(module.UPDATE_PUBLIC_KEY_PEM, result.publicKeyPem);
  await assert.rejects(generateUpdateKeys({ repositoryRoot, privateKeyPath, publicModulePath }), /already exists/);
});

test("updateSourceConfig rejects a UNC path that lost a leading backslash", () => {
  assert.throws(() => updateSourceConfig({ AUTOMATE_UPDATE_SOURCE: "\\192.0.2.10\\share\\updates" }), /UNC path/);
  assert.equal(updateSourceConfig({ AUTOMATE_UPDATE_SOURCE: "\\\\192.0.2.10\\share\\updates" }).source, "\\\\192.0.2.10\\share\\updates");
  assert.equal(updateSourceConfig({ AUTOMATE_UPDATE_SOURCE: "D:\\updates" }).source, "D:\\updates");
  assert.equal(updateSourceConfig({}).source, "");
});
