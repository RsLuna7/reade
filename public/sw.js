/*
 * Reade Web service worker（docs/plan-web-pwa.md 定稿）。
 *
 * 手写、零依赖、经典（非 module）SW：由 Vite 从 public/ 原样拷入 dist，
 * 注册地址稳定；仅 Web 生产构建注册（src/main.tsx 编译时守卫），桌面
 * 运行时不存在本文件的注册路径。
 *
 * 缓存策略（PW-D2/PW-D3 运行时收集，无构建期清单注入）：
 * - 导航请求：network-first，离线回落 install 时预缓存的 `./`；
 * - 带内容哈希的构建产物（js/css 等 assets/）：cache-first（immutable）；
 * - `reade-web/**`（manifest/search/文档/图片）：stale-while-revalidate，
 *   内容缓存跨版本保留，条目数超过 LRU 上限时按插入序淘汰最旧者；
 * - 其余（跨域、scope 外）：不拦截，直通网络。
 *
 * 版本来自注册 URL 的 `?v=<version>`（sw.js 本身保持字节稳定）；应用壳
 * 缓存名随版本变化，activate 时把旧版本壳缓存整体迁入新缓存后删除旧
 * 缓存——"部署更新后、下一次在线导航前"这段窗口内离线，拿到的是完整
 * 的旧版应用壳（最坏情形=离线时旧版，绝不出现新 HTML 配不齐资源的
 * 白屏组合）；下一次在线导航即以 network-first 换到新版。迁移带来的
 * 陈旧 hashed 资源由壳缓存条目上限兜底淘汰。
 *
 * 安全边界：只缓存同源、同 scope 的 GET 请求；不做任何动态代码求值；
 * 不触碰跨域资源；缓存内容全部来自站点自身的静态产物。
 */

const SW_URL = new URL(self.location.href);
const VERSION = SW_URL.searchParams.get("v") || "0";
const SCOPE_PATH = new URL("./", SW_URL).pathname;

const SHELL_CACHE_PREFIX = "reade-shell-v";
const SHELL_CACHE = SHELL_CACHE_PREFIX + VERSION;
const CONTENT_CACHE = "reade-content-v1";
const CONTENT_LRU_LIMIT = 200;
// 单个构建的可达资源 ~170,单用户实际只取用其中一小部分;上限用于
// 兜底清理版本迁移遗留的陈旧 hashed 资源。
const SHELL_LRU_LIMIT = 300;

/**
 * 请求分类纯函数（swPolicy 契约；vitest 通过文件末尾的测试钩子直接
 * 执行本实现，逻辑只存在这一份）。
 * 返回 "navigation" | "shell-asset" | "content" | "bypass"。
 */
function classifyRequest(scopePath, requestUrl, requestMode, scopeOrigin) {
  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    return "bypass";
  }
  if (url.origin !== scopeOrigin) return "bypass";
  if (!url.pathname.startsWith(scopePath)) return "bypass";
  if (requestMode === "navigate") return "navigation";
  const relative = url.pathname.slice(scopePath.length);
  if (relative.startsWith("reade-web/")) return "content";
  if (relative.startsWith("assets/") || relative === "reade.webmanifest") {
    return "shell-asset";
  }
  return "bypass";
}

/** 壳缓存名是否属于其他版本（activate 清理判定）。 */
function isObsoleteShellCache(cacheName, currentShellCache) {
  return cacheName.startsWith(SHELL_CACHE_PREFIX) && cacheName !== currentShellCache;
}

/** 缓存超限时需要删除的键数量（按插入序从最旧删起）。 */
function contentEvictionCount(entryCount, limit) {
  return entryCount > limit ? entryCount - limit : 0;
}

async function enforceCacheLimit(cache, limit) {
  const keys = await cache.keys();
  const evict = contentEvictionCount(keys.length, limit);
  for (let index = 0; index < evict; index += 1) {
    await cache.delete(keys[index]);
  }
}

/**
 * 版本迁移：把旧版本壳缓存的全部条目（含导航兜底 "./" 与 hashed 资源)
 * 复制进当前壳缓存,再删除旧缓存。旧 "./" 覆盖 install 时预缓存的新
 * HTML,保证迁移窗口内离线拿到的是自洽的旧版壳。
 */
async function migrateShellCaches(currentCache) {
  const names = await caches.keys();
  for (const name of names) {
    if (!isObsoleteShellCache(name, SHELL_CACHE)) continue;
    const oldCache = await caches.open(name);
    for (const request of await oldCache.keys()) {
      const response = await oldCache.match(request);
      if (response) await currentCache.put(request, response);
    }
    await caches.delete(name);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 运行时收集方案只预缓存导航兜底页与安装元数据;hashed 资源
      // 首次访问时进入缓存(immutable 文件名天然无失效问题)。
      await cache.addAll(["./", "./reade.webmanifest"]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await migrateShellCaches(cache);
      await enforceCacheLimit(cache, SHELL_LRU_LIMIT);
      await self.clients.claim();
    })(),
  );
});

async function handleNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      // 导航成功即刷新兜底壳:下次离线拿到的是最新 hash 链的 HTML。
      await cache.put("./", response.clone());
    }
    return response;
  } catch {
    const fallback = await cache.match("./");
    if (fallback) return fallback;
    throw new Error("offline and the app shell is not cached yet");
  }
}

async function handleShellAsset(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function handleContent(event, request) {
  const cache = await caches.open(CONTENT_CACHE);
  const cached = await cache.match(request);
  const update = (async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        await cache.put(request, response.clone());
        await enforceCacheLimit(cache, CONTENT_LRU_LIMIT);
      }
      return response;
    } catch (error) {
      if (cached) return cached;
      throw error;
    }
  })();
  if (cached) {
    // stale-while-revalidate:先回缓存,后台刷新(contentHash 变化自然失效)。
    event.waitUntil(update.catch(() => undefined));
    return cached;
  }
  return update;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const kind = classifyRequest(SCOPE_PATH, request.url, request.mode, SW_URL.origin);
  if (kind === "bypass") return;
  if (kind === "navigation") {
    event.respondWith(handleNavigation(request));
    return;
  }
  if (kind === "shell-asset") {
    event.respondWith(handleShellAsset(request));
    return;
  }
  event.respondWith(handleContent(event, request));
});

// 测试钩子:vitest 用 stub self 执行本文件后直接调用纯函数
// (src/lib/swPolicy.test.ts),策略逻辑不需要第二份拷贝。
self.__readeSwTestHooks = {
  classifyRequest,
  isObsoleteShellCache,
  contentEvictionCount,
  SHELL_CACHE_PREFIX,
  CONTENT_CACHE,
  CONTENT_LRU_LIMIT,
  SHELL_LRU_LIMIT,
};
