import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * public/sw.js 的策略纯函数测试：用 stub self 执行 SW 源文件，通过
 * 文件末尾的 `__readeSwTestHooks` 直接拿到实现——策略逻辑只存在
 * sw.js 一份，测试不维护第二份拷贝。事件处理器（install/activate/
 * fetch 的缓存编排）依赖真实 SW 环境，属人工验收项（见方案定稿）。
 */

interface SwTestHooks {
  classifyRequest: (
    scopePath: string,
    requestUrl: string,
    requestMode: string,
    scopeOrigin: string,
  ) => "navigation" | "shell-asset" | "content" | "bypass";
  isObsoleteShellCache: (cacheName: string, currentShellCache: string) => boolean;
  contentEvictionCount: (entryCount: number, limit: number) => number;
  SHELL_CACHE_PREFIX: string;
  CONTENT_CACHE: string;
  CONTENT_LRU_LIMIT: number;
  SHELL_LRU_LIMIT: number;
}

const SW_LOCATION = "https://owner.github.io/reade/sw.js?v=1.2.3";
const ORIGIN = "https://owner.github.io";

let hooks: SwTestHooks;

beforeAll(() => {
  const source = readFileSync(
    resolve(__dirname, "..", "..", "public", "sw.js"),
    "utf8",
  );
  const stubSelf = {
    location: { href: SW_LOCATION },
    addEventListener: () => undefined,
  } as unknown as { __readeSwTestHooks?: SwTestHooks };
  // 顶层只读取 self.location 与注册事件监听;caches/fetch 只在事件
  // 处理器内部出现,不会在求值期触碰。
  new Function("self", source)(stubSelf);
  if (!stubSelf.__readeSwTestHooks) throw new Error("sw.js 未暴露测试钩子");
  hooks = stubSelf.__readeSwTestHooks;
});

describe("sw.js version wiring", () => {
  it("derives the shell cache name from the ?v= registration query", () => {
    expect(hooks.SHELL_CACHE_PREFIX).toBe("reade-shell-v");
    expect(hooks.isObsoleteShellCache("reade-shell-v1.2.3", "reade-shell-v1.2.3")).toBe(false);
  });
});

describe("classifyRequest", () => {
  const scope = "/reade/";
  const classify = (url: string, mode = "no-cors") =>
    hooks.classifyRequest(scope, url, mode, ORIGIN);

  it("routes navigations regardless of query strings", () => {
    expect(classify(`${ORIGIN}/reade/`, "navigate")).toBe("navigation");
    expect(classify(`${ORIGIN}/reade/?doc=guides%2Fa.md`, "navigate")).toBe("navigation");
  });

  it("routes generated library data and documents to the content cache", () => {
    expect(classify(`${ORIGIN}/reade/reade-web/manifest.json`)).toBe("content");
    expect(classify(`${ORIGIN}/reade/reade-web/search.json`)).toBe("content");
    expect(classify(`${ORIGIN}/reade/reade-web/library/guides/%E9%95%BF%E6%96%87.md`)).toBe(
      "content",
    );
    expect(classify(`${ORIGIN}/reade/reade-web/library/img/cover.png`)).toBe("content");
  });

  it("routes hashed build assets and the webmanifest to the shell cache", () => {
    expect(classify(`${ORIGIN}/reade/assets/index-BjqLYnUC.js`)).toBe("shell-asset");
    expect(classify(`${ORIGIN}/reade/assets/index-D34ZxKBN.css`)).toBe("shell-asset");
    expect(classify(`${ORIGIN}/reade/reade.webmanifest`)).toBe("shell-asset");
  });

  it("bypasses cross-origin, out-of-scope and unknown same-scope requests", () => {
    expect(classify("https://evil.example/reade/assets/x.js")).toBe("bypass");
    expect(classify(`${ORIGIN}/other-app/assets/x.js`)).toBe("bypass");
    expect(classify(`${ORIGIN}/reade/sw.js?v=1.2.3`)).toBe("bypass");
    expect(classify("not a url")).toBe("bypass");
  });

  it("works at the domain root scope as well as a Pages sub-path", () => {
    expect(
      hooks.classifyRequest("/", `${ORIGIN}/reade-web/manifest.json`, "no-cors", ORIGIN),
    ).toBe("content");
    expect(hooks.classifyRequest("/", `${ORIGIN}/`, "navigate", ORIGIN)).toBe("navigation");
  });
});

describe("shell cache eviction", () => {
  it("only deletes reade shell caches from other versions", () => {
    const current = "reade-shell-v1.2.3";
    expect(hooks.isObsoleteShellCache("reade-shell-v1.2.2", current)).toBe(true);
    expect(hooks.isObsoleteShellCache(current, current)).toBe(false);
    expect(hooks.isObsoleteShellCache("reade-content-v1", current)).toBe(false);
    expect(hooks.isObsoleteShellCache("other-app-cache", current)).toBe(false);
  });
});

describe("cache limits", () => {
  it("evicts the overflow beyond the configured limit", () => {
    expect(hooks.CONTENT_LRU_LIMIT).toBe(200);
    expect(hooks.SHELL_LRU_LIMIT).toBe(300);
    expect(hooks.contentEvictionCount(0, 200)).toBe(0);
    expect(hooks.contentEvictionCount(200, 200)).toBe(0);
    expect(hooks.contentEvictionCount(201, 200)).toBe(1);
    expect(hooks.contentEvictionCount(230, 200)).toBe(30);
  });
});
