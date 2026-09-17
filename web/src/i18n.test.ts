// This suite is written for vitest (`npx vitest run web/src/i18n.test.ts --environment jsdom`).
// Node 22.23's default `node --test` file glob also collects `*.test.ts`, so this file must
// still be safe to load under plain `node --test`. A static `import ... from "vitest"` / `"./i18n"`
// at module scope is resolved by node's ESM loader before any code runs — it fails immediately
// (vitest is not meant to run standalone, and the extensionless `./i18n` specifier cannot be
// mapped to `./i18n.tsx` by node's resolver) regardless of any runtime branching below it.
// So every vitest/product import here is a dynamic `import()` inside the `VITEST` branch, which
// node only evaluates when it is actually reached.
//
// `export {}` forces TypeScript to treat this file as a module (required for top-level
// `await`); the local `process` ambient declares just enough of the real Node.js global
// (present at runtime under both vitest and `node --test`) since this project has no
// `@types/node` dependency.
export {};
declare const process: { env: Record<string, string | undefined> };

if (process.env.VITEST) {
  const { describe, expect, it } = await import("vitest");
  const {
    getTaskboardI18n,
    preferredTaskboardLanguage,
    resolveTaskboardLanguage,
    taskPriorityLabel,
    taskStatusLabel,
    TASKBOARD_LANGUAGE_KEY,
  } = await import("./i18n");
  const { TAIWAN_TEXT } = await import("./zh-TW");

  describe("resolveTaskboardLanguage", () => {
    it("maps Taiwan/Hant/HK/Mo variants to zh-TW", () => {
      expect(resolveTaskboardLanguage("zh-TW")).toBe("zh-TW");
      expect(resolveTaskboardLanguage("zh-Hant")).toBe("zh-TW");
      expect(resolveTaskboardLanguage("zh-HK")).toBe("zh-TW");
      expect(resolveTaskboardLanguage("zh-MO")).toBe("zh-TW");
      expect(resolveTaskboardLanguage("zh_TW")).toBe("zh-TW");
    });

    it("maps plain/CN/Hans/SG variants to zh", () => {
      expect(resolveTaskboardLanguage("zh")).toBe("zh");
      expect(resolveTaskboardLanguage("zh-CN")).toBe("zh");
      expect(resolveTaskboardLanguage("zh-Hans")).toBe("zh");
      expect(resolveTaskboardLanguage("zh-SG")).toBe("zh");
    });

    it("maps en variants to en", () => {
      expect(resolveTaskboardLanguage("en")).toBe("en");
      expect(resolveTaskboardLanguage("en-US")).toBe("en");
    });

    it("defaults unknown/missing values to zh-TW", () => {
      expect(resolveTaskboardLanguage(null)).toBe("zh-TW");
      expect(resolveTaskboardLanguage(undefined)).toBe("zh-TW");
      expect(resolveTaskboardLanguage("")).toBe("zh-TW");
      expect(resolveTaskboardLanguage("fr")).toBe("zh-TW");
    });
  });

  describe("preferredTaskboardLanguage", () => {
    it("prefers a saved value over the query value", () => {
      expect(preferredTaskboardLanguage("en", "zh-TW")).toBe("en");
    });

    it("falls back to the query value when nothing is saved", () => {
      expect(preferredTaskboardLanguage(null, "en")).toBe("en");
      expect(preferredTaskboardLanguage("", "zh-CN")).toBe("zh");
    });

    it("defaults to zh-TW when neither saved nor query is present", () => {
      expect(preferredTaskboardLanguage(null, null)).toBe("zh-TW");
      expect(preferredTaskboardLanguage(undefined, undefined)).toBe("zh-TW");
    });
  });

  describe("text()", () => {
    it("zh-TW: returns the explicit taiwanese override first", () => {
      const { text } = getTaskboardI18n("zh-TW");
      expect(text("任务面板", "Taskboard", "任務中心")).toBe("任務中心");
    });

    it("zh-TW: falls back to the TAIWAN_TEXT mapping when no override is given", () => {
      const [chinese, taiwanese] = Object.entries(TAIWAN_TEXT)[0];
      const { text } = getTaskboardI18n("zh-TW");
      expect(text(chinese, "irrelevant english")).toBe(taiwanese);
    });

    it("zh-TW: falls back to the raw Chinese string when it has no mapping entry", () => {
      const { text } = getTaskboardI18n("zh-TW");
      const unmapped = "__no_such_mapping_entry__";
      expect(TAIWAN_TEXT[unmapped]).toBeUndefined();
      expect(text(unmapped, "English")).toBe(unmapped);
    });

    it("zh: two-arg calls keep returning the raw (simplified) Chinese string", () => {
      const { text } = getTaskboardI18n("zh");
      expect(text("任务面板", "Taskboard")).toBe("任务面板");
    });

    it("en: two-arg calls keep returning the English string", () => {
      const { text } = getTaskboardI18n("en");
      expect(text("任务面板", "Taskboard")).toBe("Taskboard");
    });
  });

  describe("taskStatusLabel (zh-TW)", () => {
    it("uses Taiwan Traditional Chinese wording for every status", () => {
      expect(taskStatusLabel("zh-TW", "backlog")).toBe("待立項");
      expect(taskStatusLabel("zh-TW", "todo")).toBe("等待認領");
      expect(taskStatusLabel("zh-TW", "in_progress")).toBe("處理中");
      expect(taskStatusLabel("zh-TW", "in_review")).toBe("等你確認");
      expect(taskStatusLabel("zh-TW", "blocked")).toBe("遇到阻礙");
      expect(taskStatusLabel("zh-TW", "done")).toBe("完成");
      expect(taskStatusLabel("zh-TW", "canceled")).toBe("取消");
    });
  });

  describe("taskPriorityLabel (zh-TW)", () => {
    it("uses Taiwan Traditional Chinese wording for every priority", () => {
      expect(taskPriorityLabel("zh-TW", "none")).toBe("無優先順序");
      expect(taskPriorityLabel("zh-TW", "urgent")).toBe("緊急");
      expect(taskPriorityLabel("zh-TW", "high")).toBe("高");
      expect(taskPriorityLabel("zh-TW", "medium")).toBe("中");
      expect(taskPriorityLabel("zh-TW", "low")).toBe("低");
    });
  });

  describe("TAIWAN_TEXT values", () => {
    it("contain no common Simplified-only characters or character-by-character misconversions", () => {
      const simplifiedOnly = /[个们这时间项编辑删确认领处状态显导选择发对话记录执运错误标签优级创归档复进详评论联碍筛视图没请输网络链页题说传载预览帮账户设语应会线额动开关负责与为无数据库续务读写启远锁钮键换块条专业类从询验证过滤区组织员单双资讯讨节点击缓储构样种异响实现两边层该隐扩缩调试损坏丢断观测报汇总统计历备还销毁释权审许议码栏滚于里着么吗并将当旧离满队结际经仅办继场义广产严众体气电脑机让给问门闭画软较头顶顺须频长阅阶难见规觉订训讲访识译谈贡财败货质购费资达违连迟适递逻遗邮钥银闲闻阵险随顾馈骤紧范]/;
      const offenders = Object.entries(TAIWAN_TEXT)
        .filter(([, value]) => simplifiedOnly.test(value) || /標簽|重復|這里/.test(value))
        .map(([key, value]) => `${key} -> ${value}`);
      expect(offenders).toEqual([]);
    });

    it("uses the fixed Taiwan wording for previously misconverted entries", () => {
      expect(TAIWAN_TEXT["范围"]).toBe("範圍");
      expect(TAIWAN_TEXT["标签"]).toBe("標籤");
      expect(TAIWAN_TEXT["阻塞于"]).toBe("阻塞於");
      expect(TAIWAN_TEXT["重复"]).toBe("重複");
    });
  });

  describe("TASKBOARD_LANGUAGE_KEY", () => {
    it("is the storage key used to persist the chosen language", () => {
      expect(TASKBOARD_LANGUAGE_KEY).toBe("taskboard.language");
    });
  });

  describe("getTaskboardI18n", () => {
    it("reports zh-TW as the locale/language for the Taiwan variant", () => {
      const i18n = getTaskboardI18n("zh-TW");
      expect(i18n.language).toBe("zh-TW");
      expect(i18n.locale).toBe("zh-TW");
    });
  });
} else {
  // Built via concatenation (not a string literal) so Vite/esbuild's static import
  // scanner does not try to pre-bundle this Node builtin for the vitest/jsdom branch
  // above — this whole branch only runs under plain `node --test`, never under vitest.
  const nodeTestSpecifier = "node:" + "test";
  const { test } = await import(nodeTestSpecifier);
  test.skip(
    "web/src/i18n.test.ts is a vitest suite — run `npx vitest run web/src/i18n.test.ts --environment jsdom`",
    () => {},
  );
}
