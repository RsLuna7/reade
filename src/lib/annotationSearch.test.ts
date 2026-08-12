import { describe, expect, it } from "vitest";
import type { Annotation } from "./backend";
import {
  annotationMatchesQuery,
  filterAnnotations,
  normalizeAnnotationQuery,
} from "./annotationSearch";

/**
 * 双端契约用例表(检索语义)。编号 C1..C16 同时约束:
 * - 本文件(纯函数 / Web 端语义);
 * - `src/lib/webAnnotations.test.ts` 的 searchWebAnnotations 抽查(含 C17..C19);
 * - `src-tauri/src/user_store.rs` 的 search_annotations Rust 测试(FTS/LIKE 双路径)。
 *
 * C1  中文 2 字查询命中 selectedText(桌面走 LIKE 回退)
 * C2  中文 3 字查询命中 selectedText(桌面走 FTS trigram)
 * C3  中文 2 字查询不命中无关文本
 * C4  英文查询大小写不敏感(≥3 字符,桌面 FTS)
 * C5  英文 2 字查询大小写不敏感(桌面 LIKE,ASCII 折叠)
 * C6  全角字母查询经 NFKC 归一命中半角文本
 * C7  半角查询命中全角存储文本(桌面写入时已 NFKC)
 * C8  note 命中
 * C9  书签 title 命中(桌面走 title LIKE 补充查询)
 * C10 墓碑排除
 * C11 `%` 按字面匹配,不作 LIKE 通配符
 * C12 `_` 按字面匹配,不作 LIKE 通配符
 * C13 双引号按字面处理,不注入 FTS 短语语法
 * C14 `OR`/`NEAR` 等 FTS 操作符按字面处理
 * C15 `*` 按字面处理,不作前缀通配符
 * C16 `\` 按字面匹配(桌面 LIKE ESCAPE 转义)
 * C17 空白查询:搜索入口返回空结果(filterAnnotations 则不过滤)
 * C18 limit 生效(搜索入口)
 * C19 查询超过 256 字符截断后再匹配(搜索入口)
 */

function makeAnnotation(id: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id,
    relativePath: "notes/a.md",
    kind: "highlight",
    color: "yellow",
    note: null,
    selectedText: "hello world",
    title: null,
    locator: {
      kind: "markdown",
      quote: "hello world",
      prefix: "",
      suffix: "",
      headingId: null,
    },
    sortIndex: "M|00000|00000000",
    createdAt: 100,
    updatedAt: 100,
    deletedAt: null,
    ...overrides,
  };
}

describe("normalizeAnnotationQuery", () => {
  it("applies NFKC, lowercases and trims", () => {
    expect(normalizeAnnotationQuery("  ｈｅｌｌｏ　ＷＯＲＬＤ  ")).toBe("hello world");
    expect(normalizeAnnotationQuery("HELLO")).toBe("hello");
    expect(normalizeAnnotationQuery("   ")).toBe("");
  });
});

describe("annotationMatchesQuery contract cases", () => {
  const chinese = makeAnnotation("ann-cn", { selectedText: "量子纠缠是一种物理现象" });
  const english = makeAnnotation("ann-en", { selectedText: "Hello World reading notes" });
  const fullwidth = makeAnnotation("ann-full", { selectedText: "ｈｅｌｌｏ　ｗｏｒｌｄ" });

  it("C1: two-char Chinese query matches selectedText", () => {
    expect(annotationMatchesQuery(chinese, "量子")).toBe(true);
  });

  it("C2: three-char Chinese query matches selectedText", () => {
    expect(annotationMatchesQuery(chinese, "量子纠")).toBe(true);
  });

  it("C3: two-char Chinese query does not match unrelated text", () => {
    expect(annotationMatchesQuery(chinese, "引力")).toBe(false);
  });

  it("C4: English matching is case-insensitive (≥3 chars)", () => {
    expect(annotationMatchesQuery(english, "HELLO")).toBe(true);
  });

  it("C5: English matching is case-insensitive (2 chars)", () => {
    expect(annotationMatchesQuery(english, "HE")).toBe(true);
  });

  it("C6: fullwidth query is NFKC-folded onto halfwidth text", () => {
    expect(annotationMatchesQuery(english, "ｈｅｌｌｏ")).toBe(true);
  });

  it("C7: halfwidth query matches fullwidth stored text", () => {
    expect(annotationMatchesQuery(fullwidth, "hello")).toBe(true);
  });

  it("C8: note text matches", () => {
    const noted = makeAnnotation("ann-note", { selectedText: "占位", note: "回头再读这一段" });
    expect(annotationMatchesQuery(noted, "回头再读")).toBe(true);
    expect(annotationMatchesQuery(noted, "没有出现")).toBe(false);
  });

  it("C9: bookmark title matches", () => {
    const bookmark = makeAnnotation("ann-bm", {
      kind: "bookmark",
      color: null,
      selectedText: null,
      title: "第三章 力学导论",
      locator: {
        kind: "bookmark",
        target: { format: "markdown", headingId: null, scrollRatio: 0.5 },
      },
    });
    expect(annotationMatchesQuery(bookmark, "第三章")).toBe(true);
    expect(annotationMatchesQuery(bookmark, "导论")).toBe(true);
  });

  it("C11: percent is a literal, not a wildcard", () => {
    const percent = makeAnnotation("ann-pct", { selectedText: "价格上涨5%了" });
    const plain = makeAnnotation("ann-num", { selectedText: "价格上涨56元" });
    expect(annotationMatchesQuery(percent, "5%")).toBe(true);
    expect(annotationMatchesQuery(plain, "5%")).toBe(false);
  });

  it("C12: underscore is a literal, not a wildcard", () => {
    const underscore = makeAnnotation("ann-und1", { selectedText: "函数 a_b 命名" });
    const letter = makeAnnotation("ann-und2", { selectedText: "函数 axb 命名" });
    expect(annotationMatchesQuery(underscore, "a_b")).toBe(true);
    expect(annotationMatchesQuery(letter, "a_b")).toBe(false);
  });

  it("C13: double quotes stay literal", () => {
    const quoted = makeAnnotation("ann-quote", { selectedText: '他说"你好"然后离开' });
    expect(annotationMatchesQuery(quoted, '"你好"')).toBe(true);
    expect(annotationMatchesQuery(makeAnnotation("ann-plain", { selectedText: "他说你好" }), '"你好"')).toBe(
      false,
    );
  });

  it("C14: FTS operators such as OR and NEAR stay literal", () => {
    const literal = makeAnnotation("ann-or", { selectedText: "pick foo or bar today" });
    const fooOnly = makeAnnotation("ann-foo", { selectedText: "foo alone" });
    expect(annotationMatchesQuery(literal, "foo OR bar")).toBe(true);
    expect(annotationMatchesQuery(fooOnly, "foo OR bar")).toBe(false);
    const near = makeAnnotation("ann-near", { selectedText: "wrote near(2) syntax here" });
    expect(annotationMatchesQuery(near, "NEAR(2)")).toBe(true);
    expect(annotationMatchesQuery(fooOnly, "NEAR(2)")).toBe(false);
  });

  it("C15: asterisk stays literal, no prefix wildcard", () => {
    const starred = makeAnnotation("ann-star", { selectedText: "通配符abc*def测试" });
    const plain = makeAnnotation("ann-star2", { selectedText: "通配符abcZdef测试" });
    expect(annotationMatchesQuery(starred, "abc*")).toBe(true);
    expect(annotationMatchesQuery(plain, "abc*")).toBe(false);
  });

  it("C16: backslash stays literal", () => {
    const backslash = makeAnnotation("ann-bslash", { selectedText: "路径 a\\bin 下" });
    expect(annotationMatchesQuery(backslash, "a\\")).toBe(true);
    expect(annotationMatchesQuery(makeAnnotation("ann-fw", { selectedText: "路径 a/bin 下" }), "a\\")).toBe(
      false,
    );
  });

  it("C17: a blank query matches everything at the matcher level", () => {
    expect(annotationMatchesQuery(chinese, "")).toBe(true);
    expect(annotationMatchesQuery(chinese, "   ")).toBe(true);
  });
});

describe("filterAnnotations", () => {
  const items: Annotation[] = [
    makeAnnotation("ann-cn", { selectedText: "量子纠缠是一种物理现象" }),
    makeAnnotation("ann-en", { selectedText: "Hello World reading notes", kind: "underline", color: "blue" }),
    makeAnnotation("ann-dead", { selectedText: "量子纠缠已删除样本", deletedAt: 5_000 }),
    makeAnnotation("ann-bm", {
      kind: "bookmark",
      color: null,
      selectedText: null,
      title: "第三章 力学导论",
      locator: {
        kind: "bookmark",
        target: { format: "markdown", headingId: null, scrollRatio: 0.5 },
      },
    }),
  ];

  it("C10: tombstones never surface, even when the text matches", () => {
    expect(filterAnnotations(items, { query: "已删除" })).toEqual([]);
    expect(filterAnnotations(items, {}).map((item) => item.id)).toEqual([
      "ann-cn",
      "ann-en",
      "ann-bm",
    ]);
  });

  it("C17: a blank query applies no text filter", () => {
    expect(filterAnnotations(items, { query: "  " }).map((item) => item.id)).toEqual([
      "ann-cn",
      "ann-en",
      "ann-bm",
    ]);
  });

  it("intersects query with kind and colour chips", () => {
    expect(
      filterAnnotations(items, { kinds: ["underline"] }).map((item) => item.id),
    ).toEqual(["ann-en"]);
    expect(
      filterAnnotations(items, { colors: ["blue"] }).map((item) => item.id),
    ).toEqual(["ann-en"]);
    // Bookmarks carry no colour and never pass a colour filter.
    expect(
      filterAnnotations(items, { kinds: ["bookmark"], colors: ["yellow"] }),
    ).toEqual([]);
    expect(
      filterAnnotations(items, { query: "hello", kinds: ["underline"], colors: ["blue"] }).map(
        (item) => item.id,
      ),
    ).toEqual(["ann-en"]);
    expect(
      filterAnnotations(items, { query: "hello", kinds: ["highlight"] }),
    ).toEqual([]);
  });

  it("keeps input order and treats empty chip arrays as no filter", () => {
    expect(filterAnnotations(items, { kinds: [], colors: [] }).map((item) => item.id)).toEqual([
      "ann-cn",
      "ann-en",
      "ann-bm",
    ]);
  });
});
