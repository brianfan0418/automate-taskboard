#!/usr/bin/env node
// Reports UI strings whose zh-TW rendering would still contain Simplified-only characters.
// Usage: node scripts/check-zh-tw-coverage.mjs [--json] [--strict]
//   --strict  exit 1 when any uncovered string is found.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAst } from "rolldown/parseAst";
import { simplifiedIn } from "./zh-tw-simplified-chars.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "web", "src");

// Intentional Simplified strings that are data or dead values, not zh-TW UI copy.
const ALLOWLIST = [
  { file: "web/src/api.ts", text: "本地用户", reason: "default actor identity data; UI renders text(\"本地用户\") in App.tsx" },
  { file: "web/src/App.tsx", text: "本地用户", reason: "default actor identity data; UI renders text(\"本地用户\")" },
  { file: "web/src/components/BoardColumn.tsx", text: "待立项", reason: "STATUS_DETAILS.label is unused; columns render taskStatusLabel()" },
  { file: "web/src/components/BoardColumn.tsx", text: "等待认领", reason: "STATUS_DETAILS.label is unused; columns render taskStatusLabel()" },
  { file: "web/src/components/BoardColumn.tsx", text: "处理中", reason: "STATUS_DETAILS.label is unused; columns render taskStatusLabel()" },
  { file: "web/src/components/BoardColumn.tsx", text: "等你确认", reason: "STATUS_DETAILS.label is unused; columns render taskStatusLabel()" },
  { file: "web/src/components/BoardColumn.tsx", text: "遇到阻碍", reason: "STATUS_DETAILS.label is unused; columns render taskStatusLabel()" },
  { file: "web/src/labels.ts", text: "改进", reason: "stored default label name; labelDisplayName() localizes it" },
];

function children(node) {
  const out = [];
  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end") continue;
    const value = node[key];
    if (Array.isArray(value)) { for (const v of value) if (v && typeof v.type === "string") out.push(v); }
    else if (value && typeof value.type === "string") out.push(value);
  }
  return out;
}

function loadTaiwanText() {
  const source = readFileSync(join(srcDir, "zh-TW.ts"), "utf8");
  const map = new Map();
  const visit = (node) => {
    if (node.type === "Property" && node.key.type === "Literal" && node.value.type === "Literal" && typeof node.value.value === "string") {
      map.set(node.key.value, node.value.value);
    }
    children(node).forEach(visit);
  };
  visit(parseAst(source, { lang: "ts" }));
  return map;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "vendor" || name === "assets") continue;
      walk(full, out);
    } else if (/\.(tsx?|mts)$/.test(name) && !/\.d\.m?ts$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== "zh-TW.ts") {
      out.push(full);
    }
  }
  return out;
}

const hasCjk = (value) => /[㐀-鿿]/.test(value);
const isString = (n) => n && ((n.type === "Literal" && typeof n.value === "string") || n.type === "TemplateLiteral");
function staticText(node) {
  if (node.type === "Literal") return String(node.value);
  if (node.type === "TemplateLiteral") {
    return node.quasis.map((q, i) => (i ? "${" + (i - 1) + "}" : "") + (q.value.cooked ?? q.value.raw)).join("");
  }
  if (node.type === "JSXText") return node.value.trim();
  return "";
}
const WRAPPERS = new Set(["TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression", "TSNonNullExpression"]);
const TYPE_CONTEXT = /^TS(LiteralType|TypeAnnotation|PropertySignature|TypeAliasDeclaration|InterfaceDeclaration|EnumMember)$/;

const keyName = (property) => property.key?.type === "Identifier" ? property.key.name : property.key?.type === "Literal" ? String(property.key.value) : "";
const sourceOf = (node, source) => source.slice(node.start, node.end);
let currentSource = "";
// True when the string sits in a branch only reachable for the Simplified ("zh") language.
function zhOnlyBranch(node, ancestors) {
  let child = node;
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const a = ancestors[i];
    if (a.type === "Property" && a.value === child && keyName(a) === "zh") return true;
    if (a.type === "ConditionalExpression" && a.test !== child) {
      const test = sourceOf(a.test, currentSource).replace(/\s+/g, " ");
      if (/language === "zh"(?!-)/.test(test) && a.consequent === child) return true;
      if (/language === "zh-TW"/.test(test) && a.alternate === child) {
        // `zh-TW ? tw : (zh-only or english)`; English carries no CJK, so any CJK here is zh.
        return true;
      }
    }
    if (a.type === "JSXElement" && a.openingElement.name?.name === "option"
      && a.openingElement.attributes.some((attr) => attr.name?.name === "value" && attr.value?.value === "zh")) return true;
    child = a;
  }
  return false;
}

const taiwan = loadTaiwanText();
const findings = [];
// W15 wording: user-visible zh-TW copy says 「任務」 (task), not 「議題」 (issue).
const RETIRED_TERM = "議題";
for (const [key, value] of taiwan) {
  if (value.includes(RETIRED_TERM)) findings.push({ file: "web/src/zh-TW.ts", line: 0, kind: "term", text: key, chars: RETIRED_TERM });
}
let scanned = 0;

for (const file of walk(srcDir)) {
  const source = readFileSync(file, "utf8");
  const rel = relative(root, file).replaceAll("\\", "/");
  currentSource = source;
  const lineStarts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (offset) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; } return lo + 1; };
  const ast = parseAst(source, { lang: file.endsWith("x") ? "tsx" : "ts" });
  const visit = (node, ancestors) => {
    const parentNode = ancestors.at(-1);
    const isCandidate = (node.type === "Literal" && typeof node.value === "string") || node.type === "TemplateLiteral" || node.type === "JSXText";
    if (isCandidate && parentNode?.type !== "TaggedTemplateExpression" && parentNode?.type !== "ImportDeclaration"
      && !(parentNode?.type === "Property" && parentNode.key === node) && !ancestors.some((a) => TYPE_CONTEXT.test(a.type))) {
      const raw = staticText(node);
      if (raw && hasCjk(raw)) {
        scanned += 1;
        let outer = node;
        let depth = ancestors.length - 1;
        while (depth >= 0 && WRAPPERS.has(ancestors[depth].type)) { outer = ancestors[depth]; depth -= 1; }
        const parent = ancestors[depth];
        let kind = "hard-coded";
        let rendering = raw;
        const siblingTw = parent?.type === "Property" && parent.value === outer && ancestors[depth - 1]?.type === "ObjectExpression"
          ? ancestors[depth - 1].properties.find((p) => p.type === "Property" && keyName(p) === `${keyName(parent) === "zh" ? "tw" : keyName(parent).replace(/^chinese/, "taiwanese")}`)
          : undefined;
        if (ancestors.some((a, i) => a.type === "CallExpression" && a.arguments.length >= 3 && ancestors[i + 1] === a.arguments[0] && ancestors[i + 1] !== node)) {
          // Nested inside the zh argument of a call that already passes an explicit zh-TW argument.
          kind = "call+tw";
          rendering = "";
        } else if (zhOnlyBranch(node, ancestors) || ALLOWLIST.some((a) => a.file === rel && (a.text === "*" || a.text === raw))) {
          kind = "zh-only";
          rendering = "";
        } else if (siblingTw && keyName(parent) !== keyName(siblingTw)) {
          kind = "property+tw";
          rendering = isString(siblingTw.value) ? staticText(siblingTw.value) : "";
        } else if (parent?.type === "Property" && parent.value === outer && /^chinese/.test(keyName(parent)) && !(node.type === "TemplateLiteral" && node.expressions.length)) {
          kind = "property";
          rendering = taiwan.get(raw) ?? raw;
        } else if (parent?.type === "CallExpression" && parent.arguments.length >= 2 && parent.arguments.includes(outer)) {
          const index = parent.arguments.indexOf(outer);
          if (index === 0) {
            const tw = parent.arguments[2];
            if (tw) { kind = "call+tw"; rendering = isString(tw) ? staticText(tw) : ""; }
            else if (node.type === "TemplateLiteral" && node.expressions.length) { kind = "template"; }
            else { kind = "call"; rendering = taiwan.get(raw) ?? raw; }
          } else { kind = "tw-arg"; rendering = ""; }
        } else if (parent?.type === "ArrayExpression" && parent.elements.length >= 2 && parent.elements[0] === outer
          && isString(parent.elements[1]) && !hasCjk(staticText(parent.elements[1]))) {
          if (parent.elements[2]) { kind = "tuple+tw"; rendering = isString(parent.elements[2]) ? staticText(parent.elements[2]) : ""; }
          else { kind = "tuple"; rendering = node.type === "TemplateLiteral" && node.expressions.length ? raw : (taiwan.get(raw) ?? raw); }
        } else if (parent?.type === "ArrayExpression" && parent.elements.length >= 3 && parent.elements[2] === outer) {
          kind = "tw-arg"; rendering = "";
        }
        const bad = simplifiedIn(rendering);
        if (bad.length) findings.push({ file: rel, line: lineOf(node.start), kind, text: raw, chars: bad.join("") });
        // W15 wording: zh-TW calls them 「任務」, never 「議題」.
        const zhTwText = kind === "tw-arg" ? raw : rendering;
        if (kind !== "zh-only" && zhTwText.includes(RETIRED_TERM)) {
          findings.push({ file: rel, line: lineOf(node.start), kind: "term", text: raw, chars: RETIRED_TERM });
        }
      }
    }
    ancestors.push(node);
    for (const child of children(node)) visit(child, ancestors);
    ancestors.pop();
  };
  visit(ast, []);
}

if (process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify({ scanned, uncovered: findings.length, findings }, null, 2) + "\n");
} else {
  for (const f of findings) process.stdout.write(`${f.file}:${f.line}\t[${f.kind}]\t${JSON.stringify(f.text)}\t(${f.chars})\n`);
  const byKind = findings.reduce((acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] ?? 0) + 1 }), {});
  process.stdout.write(`\nscanned CJK strings: ${scanned}; uncovered: ${findings.length} ${JSON.stringify(byKind)}\n`);
}
if (process.argv.includes("--strict") && findings.length) process.exitCode = 1;
