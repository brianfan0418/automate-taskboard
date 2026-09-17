// W12-B 文字大小: the web styles size text in rem relative to the browser/OS default.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const webSource = new URL("../web/src/", import.meta.url);

async function webStyleSheets() {
  const files = [
    ...(await readdir(webSource)).filter((name) => name.endsWith(".css")).map((name) => new URL(name, webSource)),
    ...(await readdir(new URL("components/", webSource)))
      .filter((name) => name.endsWith(".css"))
      .map((name) => new URL(`components/${name}`, webSource)),
  ];
  return Promise.all(files.map(async (url) => ({ url, css: await readFile(url, "utf8") })));
}

test("the root font size is a percentage of the browser default with four text size steps", async () => {
  const styles = await readFile(new URL("styles.css", webSource), "utf8");
  assert.match(styles, /html \{\s*font-size: 100%;/);
  assert.match(styles, /:root\[data-text-size="small"\] \{\s*font-size: 90%;/);
  assert.match(styles, /:root\[data-text-size="large"\] \{\s*font-size: 115%;/);
  assert.match(styles, /:root\[data-text-size="xlarge"\] \{\s*font-size: 130%;/);
  assert.doesNotMatch(styles, /html[^{]*\{[^}]*font-size:\s*[\d.]+px/);
});

test("no web style sheet hard-codes a px font size or keeps 10–11px text", async () => {
  for (const { url, css } of await webStyleSheets()) {
    assert.doesNotMatch(css, /font-size:\s*[\d.]+px/, url.pathname);
    for (const match of css.matchAll(/font-size:\s*([\d.]+)rem/g)) {
      // Only avatar/keycap glyph initials may sit under 0.75rem (12px at 標準).
      if (Number(match[1]) >= 0.75) continue;
      const before = css.slice(0, match.index);
      const selector = before.slice(before.lastIndexOf("}") + 1, before.lastIndexOf("{"));
      assert.match(selector, /avatar|kbd|gantt-bar-assignee/, `${url.pathname}: ${selector.trim()} uses ${match[1]}rem`);
    }
  }
});

test("the phone board viewport uses 16px body text at 標準", async () => {
  const styles = await readFile(new URL("styles.css", webSource), "utf8");
  assert.match(styles, /@media \(max-width: 719px\) \{\s*body \{\s*font-size: 1rem;/);
});

test("phones keep text fields at 16px or more and never auto-inflate text", async () => {
  const styles = await readFile(new URL("styles.css", webSource), "utf8");
  assert.match(styles, /-webkit-text-size-adjust: 100%;/);
  const phone = styles.slice(styles.indexOf("/* W12-B: on phones every text field"));
  assert.match(phone, /@media \(max-width: 719px\)/);
  for (const selector of [".search-field input", ".inline-media-composer", ".followup-composer textarea", ".project-menu-language select"]) {
    assert.ok(phone.includes(`:root ${selector}`), selector);
  }
  assert.equal((phone.match(/font-size: max\(1rem, 16px\);/g) ?? []).length, 2);
});

test("a fixed-height rule never sets a line box taller than itself", async () => {
  for (const { url, css } of await webStyleSheets()) {
    const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = rule[2];
      const value = (prop) => new RegExp(`(?:^|[;\s])${prop}\s*:\s*([^;]+)`).exec(body)?.[1].trim();
      const height = /^([\d.]+)rem$/.exec(value("height") ?? "");
      const lineHeight = value("line-height");
      if (!height || !lineHeight) continue;
      const fontSize = /^([\d.]+)rem$/.exec(value("font-size") ?? "");
      const lineRem = /^([\d.]+)rem$/.exec(lineHeight)?.[1]
        ?? (/^[\d.]+$/.test(lineHeight) && fontSize ? Number(lineHeight) * Number(fontSize[1]) : null);
      if (lineRem === null) continue;
      assert.ok(Number(lineRem) <= Number(height[1]) + 0.001, `${url.pathname}: ${rule[1].trim()} line-height ${lineHeight} > height ${height[0]}`);
    }
  }
});
