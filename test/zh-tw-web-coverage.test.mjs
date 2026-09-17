// web/src zh-TW copy: no Simplified-only characters, and W15 wording (「任務」, never 「議題」).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/check-zh-tw-coverage.mjs", import.meta.url));

test("web zh-TW copy has no Simplified-only text and calls them 任務", () => {
  const report = JSON.parse(execFileSync(process.execPath, [script, "--json"], { encoding: "utf8", windowsHide: true }));
  assert.ok(report.scanned > 0);
  assert.deepEqual(report.findings, []);
});
