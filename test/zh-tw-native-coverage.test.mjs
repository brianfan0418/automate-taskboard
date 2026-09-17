import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/check-zh-tw-native-coverage.mjs", import.meta.url));

test("launcher, installer, injector and server copy has no Simplified-only Chinese", () => {
  const report = JSON.parse(execFileSync(process.execPath, [script, "--json"], { encoding: "utf8" }));
  assert.ok(report.scanned > 0);
  assert.deepEqual(report.findings, []);
});
