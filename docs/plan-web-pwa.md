# 方案定稿：Web PWA 离线化

- 日期：2026-08-13（基线查证日）；2026-08-13 复核基线并升级定稿（随实现落地）
- 状态：**已实施（真实 GitHub Pages 部署验证待完成，见下）**
- 定稿决策：PW-D1 `public/` 静态文件；PW-D2 运行时收集（导航 network-first + assets cache-first，无构建期清单注入）；PW-D3 SWR + 内容 LRU 200；PW-D4 编译时常量分支（`main.tsx` 以字面量 `__READE_RUNTIME__ === "web"` 包住注册调用，桌面 bundle 经 `rg serviceWorker dist/assets` 验证零残留）。
- 实施落点：`public/sw.js`（策略 + 版本迁移 + LRU）、`public/reade.webmanifest` + `public/reade-icon-{192,512}.png`（图标由 `scripts/generate-pwa-icons.mjs` 确定性生成，零依赖手写 PNG 编码）、`vite.config.ts`（webManifestPlugin 仅 web 模式注入 link）、`src/lib/swRegistration.ts`（注册守卫）、`src/main.tsx`（条件注册）、`src/lib/webLibrary.ts`（离线未缓存文案）。
- 与草案的偏离：
  1. **版本更新不是"直接删旧壳缓存"而是"迁移后删"**：验收走查发现直接删除会产生"新 SW 激活后、下一次在线导航前"的窗口——此时新壳缓存只有 `./` + webmanifest，离线刷新得到白屏（比草案承诺的"离线时旧版"更糟）。定稿改为 activate 时把旧壳缓存条目整体迁入新缓存再删除，窗口内离线拿到自洽的旧版壳；迁移遗留的陈旧 hashed 资源由壳缓存条目上限（300）兜底淘汰。
  2. 缓存版本号取自注册 URL 的 `?v=<version>`（`__READE_VERSION__` 在注册侧注入），`sw.js` 自身保持字节稳定、不经构建注入。
  3. SW 策略纯函数的测试不维护第二份拷贝：`src/lib/swPolicy.test.ts` 以 stub `self` 执行 `public/sw.js`，通过文件尾的 `__readeSwTestHooks` 直接测同一份实现。
- 未自动化/未验证项：install/activate/fetch 的缓存编排在 jsdom 无法自动化，已以本地子路径（`/reade/`）静态服务器 + Playwright CDP offline 人工验收（离线读已访问文档、未缓存文档提示、版本迁移与旧缓存清理均通过）；**真实 GitHub Pages 部署验证待完成**——部署后按 `docs/WEB_DEPLOY.md`「PWA 与离线阅读」清单检查 scope、安装项与断网刷新；Safari/iOS 的安装与离线行为未验证。
- 定位：让 GitHub Pages 上的 Web 版可安装、可离线：service worker 缓存应用壳资源与 manifest/search/文档内容，版本化缓存更新。桌面运行时不注册 SW。零依赖（手写 SW，不引入 workbox/vite-plugin-pwa）。
- 关联：必须与相对 Vite `base: "./"` 与 Pages 子路径共存（`vite.config.ts`/AGENTS 红线）；缓存版本挂 `__READE_VERSION__` 既有注入；内容清单来自 `manifest.json`（生成器产物）。

> 一句话：`public/sw.js`（构建原样拷入 dist）+ `public/reade.webmanifest` + `index.html` 条件注入 manifest link；`main.tsx` 在 `APP_RUNTIME === "web"` 且生产构建时 `navigator.serviceWorker.register("sw.js", { scope: "./" })`；SW 策略——应用壳预缓存（install 时按注入的资源清单）、`reade-web/**`（manifest/search/文档/图片）stale-while-revalidate、缓存名带版本号 activate 清旧；生成器不动（SW 运行时按需缓存文档，不预缓存全库）。

---

## 1. 现状基线（已核实于 2026-08-13，行号允许漂移）

| 事实 | 位置 |
|------|------|
| Vite web 模式 `base: "./"`；无 PWA 插件（plugins 仅 react + themeBootPlugin）；无 workbox 依赖 | `vite.config.ts` L84-85、L82-83；`package.json` L18-52 |
| `__READE_RUNTIME__` / `__READE_VERSION__` 编译时注入——SW 注册守卫与缓存版本号的来源 | `vite.config.ts` L86-89；`src/lib/backend.ts` L241-242 |
| `index.html` 无 `<link rel="manifest">`；favicon 为空 data URI | `index.html` L1-26、L5 |
| `main.tsx` 与全 src 树无任何 service worker 代码 | `src/main.tsx` L1-11 |
| 生成器只产 `manifest.json`、`search.json`、`library/**`（白名单 Markdown+六类图片），原子替换输出目录；**不产 SW/webmanifest** | `scripts/generate-web-library.mjs` L214-230、L11-21 |
| Web 数据获取：`DEFAULT_WEB_LIBRARY_BASE_URL = "./reade-web/"` 相对拼接，`loadSearchIndex` 有内存缓存 | `src/lib/webLibrary.ts` L23、L428-433 |
| CI：push main → `pnpm build:web` → 上传 `dist` → deploy-pages@v4；Pages 为 `<owner>.github.io/<repo>/` 子路径 | `.github/workflows/deploy-pages.yml` L45-66；`docs/WEB_DEPLOY.md` L84 |
| Vite 构建产物 hashed chunk（themeBootPlugin 已处理 base 感知注入的先例——SW 预缓存清单同样要拿到 hashed 文件名） | `vite.config.ts` L23-78 |
| manifest.json 含每篇 `contentHash`——文档级缓存失效信号现成 | `scripts/generate-web-library.mjs` L193-202 |
| 桌面 CSP `default-src 'self'`：桌面不注册 SW（守卫在编译时常量，桌面 bundle 直接不含注册代码路径） | `src-tauri/tauri.conf.json` L26 |

## 2. 目标与非目标

**目标**

1. 可安装：`reade.webmanifest`（name/short_name/theme_color/icons 两枚 SVG→PNG 生成的静态图标/`start_url: "./"`/`display: standalone`/`scope: "./"`），仅 web 构建注入 link。
2. 离线可用：断网后已访问过的文档可打开、文档树/搜索可用（manifest/search 已缓存）；未访问过的文档给"离线未缓存"提示（webLibrary fetch 失败的既有错误路径细化文案）。
3. 更新策略：新部署后下次访问自动拿新版——应用壳缓存名 `reade-shell-v<__READE_VERSION__>+<build hash>`，activate 删除异名缓存；`reade-web/**` 用 stale-while-revalidate（秒开 + 后台刷新，配合 `contentHash` 变化自然失效）。
4. 与子路径共存：SW 以相对路径注册（scope 即部署子路径），`fetch` handler 只拦截 `self.registration.scope` 内请求。
5. 桌面 bundle 零变化（tree-shaking 掉 web-only 注册分支）。

**非目标（明确不做）**

- 不做"一键下载全库离线包"（后台预缓存全部文档；个人库可能很大，等真实需求再评）。
- 不做后台同步/推送通知（无服务端，违背离线红线）。
- 不引入 workbox/vite-plugin-pwa（两者都是新依赖；手写 SW ~150 行足够本需求）。
- 不做 Safari 特有的安装引导 UI。

## 3. 设计

### 3.1 文件与注入

- `public/sw.js`：经典（非 module）SW，**不经 Vite 打包**（public 原样拷贝，避免 hashed 文件名导致注册地址漂移）。
- 预缓存清单问题：`index.html` + hashed assets 在构建后才知——推荐**运行时收集**方案：SW install 只预缓存 `./`（导航请求兜底）与 webmanifest；hashed js/css 用 cache-first + 首次访问入缓存（immutable 文件名天然安全）；导航请求 network-first 回落缓存（保证拿新 html→新 hash 链）。此方案免去"构建期把清单注入 sw.js"的自定义插件复杂度。
- `index.html`：`<link rel="manifest" href="reade.webmanifest">` 经 themeBootPlugin 同款方式仅 web 模式注入（该插件已有 mode 感知先例）。
- `main.tsx`：`if (APP_RUNTIME === "web" && import.meta.env.PROD && "serviceWorker" in navigator)` 注册；`registration.update()` 于每次启动调用。

### 3.2 fetch 策略

| 请求 | 策略 |
|---|---|
| 导航（HTML） | network-first，离线回落缓存的 `./` |
| hashed assets（js/css） | cache-first（immutable） |
| `reade-web/manifest.json` / `search.json` | stale-while-revalidate |
| `reade-web/library/**` | stale-while-revalidate（文档与图片） |
| 其他/跨域 | 不拦截（直通） |

### 3.3 更新与清理

- 缓存名：壳 `reade-shell-v{version}`、内容 `reade-content-v1`（内容缓存跨版本保留，靠 SWR 刷新）；activate 时删除非当前名的 shell 缓存 + `clients.claim()`。
- 内容缓存体积治理：library 缓存条目 LRU 上限 200 条（SW 内简单计数淘汰），防无限膨胀。

### 3.4 安全

- SW 只服务同 scope 静态资源，无任何动态代码求值；不缓存跨域；CSP 不变（Pages 无 CSP header，桌面不受影响）；`sw.js` 与 webmanifest 是静态文件，不含用户内容。

## 4. 改动清单（预估）

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `public/sw.js`（新） | 策略实现 + LRU | M |
| 2 | `public/reade.webmanifest` + 图标（新） | 安装元数据 | S |
| 3 | `vite.config.ts` | web 模式注入 manifest link（沿 themeBootPlugin 模式） | S |
| 4 | `src/main.tsx` | 条件注册 | S |
| 5 | `src/lib/webLibrary.ts` | 离线未缓存错误文案细化 | S |
| 6 | `docs/WEB_DEPLOY.md`、`docs/USER_GUIDE.md` | 部署验证清单增补 | S |

## 5. 验收标准（草案级）

- [ ] `pnpm build:web && pnpm preview:web`：Lighthouse PWA 可安装项通过；断网刷新应用壳可开；访问过的文档离线可读、未访问的有提示。
- [ ] 更新流：改版本号重新构建 → 二次访问后旧 shell 缓存被清（devtools 佐证）。
- [ ] 子路径：`vite preview` 带 `--base` 模拟子路径（或直接部署验证一次）scope 正确、无根路径请求泄漏。
- [ ] 桌面：`pnpm build` 产物 grep 无 serviceWorker 注册（tree-shaking 验证）；桌面运行零变化。
- [ ] SW 单测（可选 jsdom 受限，允许以人工验收 + 代码走查替代，写明未自动化项）。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| PW-D1 | SW 产出方 | **`public/` 静态文件，Vite 原样拷贝**（注册地址稳定、免插件） | 生成器输出 sw（生成器职责是内容不是应用壳，否）；vite-plugin-pwa（新依赖，否） |
| PW-D2 | 预缓存清单 | **运行时收集（导航 network-first + assets cache-first）**——免构建期清单注入 | install 期全清单预缓存（需自写 manifest 注入插件，复杂度高，首屏收益小） |
| PW-D3 | 文档内容策略 | **SWR + LRU 200**（读过的离线可用，符合"个人常读集"心智） | 全库预缓存（大库流量与存储失控）；network-only（离线全废） |
| PW-D4 | 桌面守卫 | **编译时常量分支（bundle 级排除）** | 运行时 UA 探测（违背"不得用浏览器特征猜运行时"红线，否） |

## 7. 风险

- SW 是"部署后才真实"的组件：preview 环境与 Pages 子路径行为差异（scope、404 路由）必须以一次真实部署验证收尾，方案将其列为硬验收项。
- 缓存更新 bug 的代价是"用户看到旧版且不自愈"：network-first 导航 + 版本化 shell 名把最坏情形限制为"离线时旧版"；仍建议在 WEB_DEPLOY 的回滚章节补"bump 版本强制刷新"操作。
- jsdom 无 SW 环境，自动化测试覆盖有限：以纯函数拆分（策略路由函数可单测）+ 人工验收矩阵弥补，未自动化项如实列出。
