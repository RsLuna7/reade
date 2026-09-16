# Agent 按需参考

本文件承接 `AGENTS.md` 的实现细节；仅在修改相关模块时阅读。路径均相对仓库根目录。代码、配置和测试是事实来源，历史计划不代表已实现或已验收。

## 技术栈

- Desktop shell：Tauri 2、Rust 2021、Windows WebView2
- Frontend：React 19、TypeScript 5、Vite 7、Zustand 5
- Markdown：`react-markdown`、`remark-gfm`、`remark-math`、`rehype-katex`、`rehype-slug`
- 扩展渲染：Shiki 按需加载、Mermaid 懒加载并以 `securityLevel: "strict"` 内联 SVG
- PDF：前端 `pdfjs-dist` 原版式渲染，Rust 侧 `pdf-inspector` 按页提取文本
- EPUB：Rust 侧 `anydoc` 转成自有安全 DTO，不执行书内 HTML/CSS
- 本地能力：`ignore`、`notify`、SQLite FTS5 trigram（持久化于应用缓存目录）
- Web 发布：Node.js 生成器、静态 manifest/search、手写 service worker、GitHub Actions / Pages
- Package manager：pnpm；不要混用 npm、Yarn 或 Bun
- Tests：Vitest + Testing Library + jsdom；Rust 内置测试

## 实现入口

- `src/App.tsx`：应用编排；`src/App.css`：样式入口，按顺序导入 `src/styles/app-*.css`，不要随意改变级联顺序。
- `src/theme-boot.ts`：首屏主题；`src/styles/theme-tokens.css`：主题色板。
- `src/components/`：阅读器和交互组件；`src/lib/`：backend facade、安全策略与纯函数；`src/store/`：状态与偏好。
- `src/test/setup.ts`：可选测试补丁，由需要的测试自行 import。
- `src-tauri/src/lib.rs`：command 注册；`library.rs`：扫描、读取、监听、索引与路径校验；`user_store.rs`：标注、合集、回顾与迁移。
- `src-tauri/src/stats.rs`：阅读统计；`documents.rs`：PDF/EPUB 解析；`links.rs`：链接提取；`transfer.rs`：导入导出对话框。
- `src-tauri/capabilities/default.json`：权限；`src-tauri/tauri.conf.json`：CSP、窗口与打包。
- `scripts/`：Web 生成器；`public/sw.js`：仅 Web 注册的手写 service worker。
- `examples/demo-library/`：手工联调文档库；`output/playwright/`：视觉参考，不能替代当前验收。

## 测试映射

行为发生变化时：

- Markdown 渲染或 URL 策略：更新 `src/components/MarkdownRenderer.test.tsx`。
- PDF 或 EPUB 阅读行为：更新 `src/components/PdfReader.test.tsx`、`EpubReader.test.tsx` 与 `src-tauri/src/documents.rs` 的 Rust tests。
- 文档树、排序或路径规格化：更新 `src/lib/tree.test.ts`。
- 阅读设置或持久化状态：更新 `src/store/useReaderStore.test.ts`。
- 跨越前后端的契约（链接提取、相关段落片段、指纹、合集 DTO）在两侧都有孪生测试，改一侧必须同步另一侧。
- 扫描、越界路径、搜索、缓存生命周期、文件限制或标题提取：更新 `src-tauri/src/library.rs` 中的 Rust tests。
- 标注、合集、回顾、迁移链：更新 `src-tauri/src/user_store.rs` 中的 Rust tests。
- Web 生成器行为：更新 `scripts/generate-web-library.test.mjs`（它也在 `pnpm test` 范围内）。
- 先跑最小相关测试；跨模块变更完成前至少跑 `pnpm test`、TypeScript 检查、`cargo test` 和 `cargo clippy`。
- 测试通过不等于视觉正确；排版、滚动、目录跟随和响应式布局需要运行时证据。
- 已知测试盲区，改动触及时请顺手补上：`MarkdownRenderer` 的 `resolveImageSrc` 解析路径、Rust 侧 `create_watcher`、Tauri command 的端到端调用。

## 高风险实现细节

- **IPC 契约**：全部 commands 注册在 `src-tauri/src/lib.rs` 的 `generate_handler!` 里——动手前先读那份清单，不要凭记忆假设命令名。Rust 使用 snake_case 参数，前端 `invoke` 传 camelCase；前端一律经 `src/lib/backend.ts` 的 facade 调用，桌面落到 `tauriBackend.ts`、Web 落到 `webLibrary.ts` 等实现；改一端必须同步另一端和类型。名称集合由 `src/lib/tauriBackend.test.ts` 的机械对账测试守护。
- **渲染安全**：raw HTML 保持禁用；Mermaid 使用 `securityLevel: "strict"`（不要改回 sandbox iframe：`data:` iframe 会被 CSP `frame-src` 拦截，WebView2 显示“已阻止此内容”），50,000 字符和 500 条连线限制；`mermaid.render` 的结果经 `sanitizeMermaidSvg` 后再注入。
- **文件边界**：Markdown 上限 10 MiB（超限文件在扫描阶段就被跳过，不会出现在文档树），本地资源 25 MiB，PDF/EPUB 128 MiB，单次 PDF Range 4 MiB，封面缩略图 512 KiB / 640 px；禁止绝对路径、父目录逃逸和跟随符号链接越界。
- **外链与图片**：外链只允许 `http:`、`https:`、`mailto:` 且需用户确认；远程图片默认拦截；Markdown 文本里的 SVG data URL 不允许。库内 `.svg` 文件经 `read_asset` 读出后走 `sanitizeLibrarySvg`（与 Mermaid 同一消毒管线）再以内联 SVG 渲染，绝不生成 `data:image/svg+xml`。注意 `read_asset` 的 MIME 由扩展名推断、Rust 侧不做白名单；`MarkdownRenderer.tsx` 的 `resolvedUrl` 在 resolver 前后各做一次 `safeUrlTransform`，第二次那道校验挡的正是"SVG data URL 被当作 URL 渲染"，不可删。
- **索引与监听**：搜索索引是 SQLite FTS5 trigram，持久化在 `app_cache_dir/reade-cache.sqlite3`，按文件 size/mtime 与 `CONVERTER_REVISION` 增量失效，不是每次打开都全量重建；缓存 schema 不匹配会整库删除重建。watcher 只在 `open_library` 时创建，`refresh_library` 不重建；`library-changed` 事件只作为刷新信号，前端收到后调用 `refreshLibrary()`。
- **数据存储分层**：三个独立 SQLite —— `app_cache_dir/reade-cache.sqlite3`（派生文本与索引，可随时删）、`app_cache_dir/reade-user.sqlite3`（标注/合集/回顾，带迁移链与升级备份）、`app_data_dir/reade-stats.sqlite3`（阅读会话）。清缓存与重建索引的逻辑绝不能触碰后两者。缓存里纯新增表不要 bump `CACHE_SCHEMA_VERSION`，否则会触发全库重索引。
- **权限配置**：`src-tauri/capabilities/default.json` 只允许目录选择和安全外链；新增权限必须说明用户可见影响与攻击面。
- **Web 发布边界**：`READE_CONTENT_DIR` 中被生成器接收的内容最终完全公开；manifest、文档 URL 和搜索数据必须保持同源、相对 Pages 根路径。

## 运行时与产品细节

- 桌面版发现 `.md`、`.markdown`、`.mdx`、`.pdf`、`.epub`；`.mdx` 仅按普通 Markdown 安全展示；Web 版只发布 Markdown。
- 桌面扫描遵守 `.gitignore`，不跟随符号链接，并排除常见构建/依赖目录；Web 生成器不读 `.gitignore`，改用扩展名白名单，两者语义不同。
- 前端 localStorage 只存偏好与轻量位置：`reade-reader-preferences`、`reade-library-mru`、`reade-reading-positions`、`reade-tree-layout`、`reade-read-marks`、`reade-vertical-writing`、`reade-home-baseline`、`reade-device-id`；文档正文和索引不进前端存储。Web 版的标注与合集存 IndexedDB。
- 快捷键：`Ctrl+O` 选择文档库（桌面）、`Ctrl+K` 聚焦搜索、`Ctrl+P` 命令面板、`Ctrl+Shift+O` 本夹文档全名列表、`Ctrl+B` 书签、`Ctrl+Z` 撤销标注、`Ctrl+滚轮` 放大/缩小阅读（Markdown/EPUB 调字号，PDF 原版式调页面缩放）、`Alt+←/→` 阅读回退栈、`Esc` 关闭浮层；改动时同步可访问名称和界面提示。
- `examples/demo-library/` 用于功能联调，`output/playwright/` 只作为视觉参考，不是源码或自动化测试结果的替代品。
- `docs/roadmap-innovations.md` 末尾有一份尚未完成的人工验收清单（桌面真机 9 项、Web 真实部署 4 项）。碰到桌面清单里的功能时，别把"测试通过"当成已验收。Web 真实部署 4 项不再推进。
- `APP_RUNTIME` 由 Vite mode 决定：默认/production 是 desktop，`--mode web` 是 Web；不得用浏览器特征猜运行时。Web 版功能已封存，日常开发以桌面为准。

## 性能与 CI

性能预算用例包含 `scan_is_fast_metadata_first_and_cached_search_keeps_locators`、`list_document_links_stays_fast_on_a_synthetic_link_graph`、`related_passages_meet_the_synthetic_performance_budget`，随默认 `cargo test` 执行；不要假设存在 `--ignored` 大库压测。

`.github/workflows/verify.yml` 在 PR 和被调用时运行前端测试、类型检查、桌面前端构建、Web 兼容构建，以及 Windows Rust test/fmt/clippy。`.github/workflows/deploy-pages.yml` 在 main push 或手动触发时先调用 verify，再构建发布 Pages。具体门禁以 workflow 为准，本地仍需验证相关改动。

## 指令维护

详细反馈与蒸馏流程见 [智能体闭环](agent-skills-loop.md)。长流程留在 `.agents/skills/` 或 `tools/skills/`，不要复制到常驻规则或嵌套 `AGENTS.md`。Skills 经人审维护；Cursor Memory 不作为仓库规范。组件组合可按需读取 `vercel-composition-patterns`，设计评审按任务匹配 impeccable 等技能。
