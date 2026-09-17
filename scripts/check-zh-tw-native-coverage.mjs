#!/usr/bin/env node
// Reports Simplified-only Chinese in user-visible strings OUTSIDE web/src: the Tauri launcher
// (tray menu, dialogs, status window), installer config, the Codex App injector/userscript,
// server API error messages and CLI output. web/src is covered by scripts/check-zh-tw-coverage.mjs.
// Usage: node scripts/check-zh-tw-native-coverage.mjs [--json] [--strict] [--root <repo>]
//   --strict  exit 1 when any uncovered string is found.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { simplifiedIn } from "./zh-tw-simplified-chars.mjs";

const rootArg = process.argv.indexOf("--root");
const root = rootArg > 0
  ? resolve(process.argv[rootArg + 1])
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Directories scanned recursively, with the file extensions that can carry UI copy.
const SCAN = [
  { dir: "src-tauri/src", ext: /\.rs$/ },
  { dir: "src-tauri", ext: /\.(json|nsh|nsi)$/, shallow: true },
  { dir: "src-tauri/capabilities", ext: /\.json$/ },
  { dir: "inject", ext: /\.(m?js)$/ },
  { dir: "scripts", ext: /\.(m?js)$/ },
  { dir: "server", ext: /\.(m?js)$/ },
  { dir: "cli", ext: /\.(m?js)$/ },
  { dir: "shared", ext: /\.(m?js)$/ },
  { dir: "integrations", ext: /\.(m?js)$/ },
];
const SKIP_FILES = new Set([
  "scripts/check-zh-tw-coverage.mjs",
  "scripts/check-zh-tw-native-coverage.mjs",
  "scripts/zh-tw-simplified-chars.mjs",
]);

// Intentional Simplified text: matchers for third-party UI labels, stored data identities, and
// agent-facing protocol text. `text: "*"` covers the whole file; `exact` must equal the whole literal;
// `contains` is removed from the literal before checking what is left (e.g. inside SQL).
const ALLOWLIST = [
  { file: "inject/automate-taskboard.user.js", exact: ["新建任务", "新对话", "拉取请求", "站点", "项目", "任务", "对话", "显示", "个人资料"],
    reason: "matchers for Codex App's own zh-CN sidebar/button labels (Traditional variants sit alongside)" },
  { file: "server/jira-integration.mjs", exact: ["拒绝", "待立项", "验收", "评审", "测试", "挂起", "紧急"],
    reason: "matchers for Jira workflow status/priority names (Traditional variants sit alongside)" },
  { file: "server/app.mjs", exact: ["本地用户"], reason: "default actor identity data; web renders text(\"本地用户\")" },
  { file: "server/database.mjs", contains: ["本地用户"], reason: "stored default actor name; web renders text(\"本地用户\")" },
  { file: "shared/domain.mjs", exact: ["改进"], reason: "stored default label name; web labelDisplayName() localizes it" },
  { file: "shared/taskboard-automation.mjs", text: "*",
    reason: "Codex automation name is the identity used to find existing automations; prompt is agent protocol asserted by tests" },
];

function walk(dir, ext, shallow, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (shallow || name === "node_modules" || name === "target" || name === "gen") continue;
      walk(full, ext, shallow, out);
    } else if (ext.test(name)) out.push(full);
  }
  return out;
}

// String literals: "..." and '...' (single line), `...` (may span lines). Comments are skipped.
function literals(source, rust) {
  const found = [];
  let i = 0;
  const lineAt = (offset) => source.slice(0, offset).split("\n").length;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") { i = source.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === "/" && next === "*") { const end = source.indexOf("*/", i + 2); i = end < 0 ? source.length : end + 2; continue; }
    if (rust && c === "'") {
      // Rust lifetimes/char literals never carry UI copy; skip a char literal if present.
      const m = /^'(?:\\.|[^'\\\n])'/.exec(source.slice(i, i + 12));
      i += m ? m[0].length : 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) {
        if (source[j] === "\\") j += 1;
        else if (c !== "`" && source[j] === "\n") break;
        j += 1;
      }
      found.push({ text: source.slice(i + 1, j), line: lineAt(i) });
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return found;
}

const findings = [];
let scanned = 0;
for (const { dir, ext, shallow } of SCAN) {
  for (const file of walk(join(root, dir), ext, shallow)) {
    const rel = relative(root, file).replaceAll("\\", "/");
    if (SKIP_FILES.has(rel)) continue;
    const source = readFileSync(file, "utf8");
    const isJson = rel.endsWith(".json");
    const rules = ALLOWLIST.filter((rule) => rule.file === rel);
    if (rules.some((rule) => rule.text === "*")) continue;
    for (const literal of literals(source, rel.endsWith(".rs") && !isJson)) {
      if (!/[㐀-鿿]/.test(literal.text)) continue;
      scanned += 1;
      if (rules.some((rule) => rule.exact?.includes(literal.text))) continue;
      let rest = literal.text;
      for (const rule of rules) for (const text of rule.contains ?? []) rest = rest.split(text).join("");
      const bad = simplifiedIn(rest);
      if (bad.length) findings.push({ file: rel, line: literal.line, text: literal.text.slice(0, 120), chars: bad.join("") });
      // W15 wording: user-visible zh-TW copy says 「任務」 (task), not 「議題」 (issue).
      if (literal.text.includes("議題")) findings.push({ file: rel, line: literal.line, text: literal.text.slice(0, 120), chars: "議題" });
    }
  }
}

if (process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify({ scanned, uncovered: findings.length, findings }, null, 2) + "\n");
} else {
  for (const f of findings) process.stdout.write(`${f.file}:${f.line}\t${JSON.stringify(f.text)}\t(${f.chars})\n`);
  const byFile = findings.reduce((acc, f) => ({ ...acc, [f.file]: (acc[f.file] ?? 0) + 1 }), {});
  process.stdout.write(`\nscanned CJK strings: ${scanned}; uncovered: ${findings.length} ${JSON.stringify(byFile)}\n`);
}
if (process.argv.includes("--strict") && findings.length) process.exitCode = 1;
