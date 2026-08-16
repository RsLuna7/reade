# AGENTS.md

> Reade 项目的 AI coding agent 工作约定。保持本文短小、可执行；较长说明写入 `docs/` 或 `README.md`。
> 当 agent 反复误解同一约束时更新本文，不要把临时任务要求永久化。

---

## 项目

Reade 是一款个人使用的本地优先长文阅读器。Windows 桌面版只读本地 Markdown、PDF 与可重排 EPUB，Web 版只把明确允许公开的 Markdown 构建为 GitHub Pages 静态站点；两者共享 React 阅读界面与安全渲染管线。

主要目标：

- 在三栏布局中提供稳定、可调且适合长文的阅读体验。
- 安全读取和检索本地文档，不执行文档携带的代码或主动上传内容。
- 保持启动、安装包与运行时开销适合个人桌面应用。
- 用同一套 UI 支持本地 Tauri backend 与静态 Web library，不复制两套阅读器。
- 标注、合集、回顾与阅读统计只落在本机，不引入账号与云同步。

## 技术栈

- Desktop shell：Tauri 2、Rust 2021、Windows WebView2
- Frontend：React 19、TypeScript 5、Vite 7、Zustand 5
- Markdown：`react-markdown`、`remark-gfm`、`remark-math`、`rehype-katex`、`rehype-slug`
- 扩展渲染：Shiki 按需加载、Mermaid 懒加载并使用 sandbox
- PDF：前端 `pdfjs-dist` 原版式渲染，Rust 侧 `pdf-inspector` 按页提取文本
- EPUB：Rust 侧 `anydoc` 转成自有安全 DTO，不执行书内 HTML/CSS
- 本地能力：`ignore`、`notify`、SQLite FTS5 trigram（持久化于应用缓存目录）
- Web 发布：Node.js 生成器、静态 manifest/search、手写 service worker、GitHub Actions / Pages
- Package manager：pnpm；不要混用 npm、Yarn 或 Bun
- Tests：Vitest + Testing Library + jsdom；Rust 内置测试

## 仓库地图

只列日常开发需要的路径：

```text
.
├── src/
│   ├── App.tsx                    # 应用编排：阅读交互、标注、导航、分栏、全局快捷键
│   ├── App.css                    # 三栏布局、主题和 Markdown 排版
│   ├── theme-boot.ts              # 首屏前写入 data-theme，避免暗色闪白
│   ├── components/                # Markdown/PDF/EPUB 渲染、文档树、标注 UI、统计与回顾视图
│   ├── lib/                       # 后端 facade、安全策略与纯函数（阅读/标注/统计/TTS/Web 运行时）
│   ├── store/                     # Zustand 阅读器状态与持久化偏好
│   ├── styles/theme-tokens.css    # 各主题系列色板
│   └── test/setup.ts              # 可选测试补丁，由需要的测试自行 import（无全局 setupFiles）
├── src-tauri/
│   ├── src/lib.rs                 # Tauri plugins、state 与全部 command 注册（IPC 契约唯一真源）
│   ├── src/library.rs             # 扫描、读取、监听、索引、搜索、快照与路径校验
│   ├── src/user_store.rs          # 标注、合集、回顾、指纹与导入导出
│   ├── src/stats.rs               # 阅读会话统计
│   ├── src/documents.rs           # PDF/EPUB 解析与安全 DTO
│   ├── src/links.rs               # Markdown 链接与 [[wiki]] 提取
│   ├── src/transfer.rs            # 导入导出文件对话框
│   ├── capabilities/default.json  # 最小桌面权限
│   └── tauri.conf.json            # 窗口、CSP 与打包配置
├── public/sw.js                   # Web PWA service worker（手写零依赖，桌面不注册）
├── examples/demo-library/         # 手工验收用文档库
├── scripts/                       # Web 静态文档库生成器及测试
├── docs/                          # WEB_DEPLOY.md、USER_GUIDE.md、roadmap-innovations.md、plan-*.md
├── .github/workflows/             # 仅有 Pages 构建部署，不跑测试与 Rust 检查
├── output/playwright/             # 已有视觉基线截图
├── package.json
└── README.md                      # 产品能力、环境要求与当前限制
```

- 架构事实优先读取 `README.md`、`package.json`、`src-tauri/Cargo.toml` 和实际源码，不凭目录名猜测。
- `dist/`、`public/reade-web/`、`node_modules/`、`src-tauri/target/`、`src-tauri/gen/schemas/` 是构建或生成内容，不直接编辑。
- `App.tsx` 与 `App.css` 都是六千行级的单体文件，`src/lib/` 有约 70 个纯函数模块。改这两个大文件时做定点编辑，不要整体重写或顺手重排。

## 应当做

- 修改前先检查相关源码、测试、配置和已有改动，沿用现有模式。
- 保持改动聚焦；前端纯逻辑优先放在 `src/lib/`，共享状态放在 store，系统权限留在 Rust/Tauri 层。
- 同步维护 TypeScript wrapper 与 Rust command 的名称、参数和返回结构。
- 把 Markdown、文件名、链接、图片、Mermaid 和所选文档库都视为不可信输入。
- 文件读取继续使用相对路径，并在 Rust 后端 canonicalize 后确认目标位于当前文档库内。
- 修改 URL、HTML、资源读取、CSP、capability 或 Mermaid 时补充安全回归测试。
- 影响排版或响应式行为时，用真实 Tauri 窗口或浏览器截图做视觉检查；不能只依赖测试通过。
- 保持 TypeScript 与 `ES2020` 兼容，不使用未配置 polyfill 的新 API。
- 重型渲染能力继续按需加载，避免把全部 Shiki grammar 或 Mermaid 提前打入首屏路径。
- Web 版通过 `pnpm generate:web` 生成内容，Pages 子路径必须继续使用相对 Vite `base`。

## 不应当做

- 不启用 raw HTML，不执行 MDX 的 JSX、`import` 或脚本。
- 不自动加载远程图片，不允许 `javascript:`、`file:`、协议相对 URL 或任意 `data:` 内容。
- 不让前端绕过 Tauri command 直接获得任意文件系统访问能力。
- 不放宽 CSP、Tauri capability、路径校验、文件大小或 Mermaid 限制，除非任务明确要求并附验证。
- 不直接编辑生成目录、锁文件内容或打包产物；锁文件只随依赖操作由工具更新。
- 不为了局部任务添加编辑器、云服务、遥测、账号或网络依赖。
- 不做无关重构、依赖升级、格式化全仓库、Git 初始化、提交或发布，除非用户明确要求。
- 不虚构 `pnpm lint`；本项目当前没有 ESLint script。
- 不把内容目录中的任意文件都公开；生成器只允许 Markdown 和明确列出的安全图片格式。

## 命令

在项目根目录使用 PowerShell 运行，不要猜命令：

```powershell
# 安装
pnpm install

# 开发
pnpm tauri dev

# 仅启动前端
pnpm dev

# Web 开发与构建
pnpm dev:web
pnpm build:web
pnpm preview:web

# 前端测试与类型检查
pnpm test
pnpm exec tsc --noEmit

# Rust 检查
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

# 前端与安装包构建
pnpm build
pnpm tauri build
```

性能预算以合成用例形式跑在默认 `cargo test` 里（`scan_is_fast_metadata_first_and_cached_search_keeps_locators`、`list_document_links_stays_fast_on_a_synthetic_link_graph`、`related_passages_meet_the_synthetic_performance_budget`）。当前没有 `--ignored` 的大库压测，不要照搬不存在的命令。

CI（`.github/workflows/deploy-pages.yml`）只在 push 到 main 时构建并发布 Web 站点，不跑 `pnpm test`、`cargo test`、`clippy` 或 `fmt`。上面这些验证只能在本地跑，不要指望 CI 兜底。

命令若因环境失败，先诊断 Node.js、pnpm、Rust、WebView2 和 Windows C++ build tools，不要修改产品代码来掩盖环境问题。

## 工作流

小型局部修改：检查 → 实现 → 运行最小相关验证 → 汇报。

跨前后端、IPC、安全策略、架构或依赖变更：

1. 读取相关实现与测试，列出接口和风险。
2. 先确定前后端契约以及安全边界。
3. 进行最小、可审查的实现。
4. 先运行定向测试，再运行类型检查、Rust 检查和相关构建。
5. 涉及界面时补做明暗主题和窄窗口视觉验收。

无法验证时，明确说明未验证的项目和原因。

## 测试

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

## 高风险区域

- **IPC 契约**：全部 commands 注册在 `src-tauri/src/lib.rs` 的 `generate_handler!` 里（当前 44 个，分布于 `library.rs`、`user_store.rs`、`stats.rs`、`transfer.rs`）——动手前先读那份清单，不要凭记忆假设命令名。Rust 使用 snake_case 参数，前端 `invoke` 传 camelCase；前端一律经 `src/lib/backend.ts` 的 facade 调用，桌面落到 `tauriBackend.ts`、Web 落到 `webLibrary.ts` 等实现；改一端必须同步另一端和类型。
- **渲染安全**：raw HTML 保持禁用；Mermaid 维持 `securityLevel: "sandbox"`、50,000 字符和 500 条连线限制。
- **文件边界**：Markdown 上限 10 MiB（超限文件在扫描阶段就被跳过，不会出现在文档树），本地资源 25 MiB，PDF/EPUB 128 MiB，单次 PDF Range 4 MiB，封面缩略图 512 KiB / 640 px；禁止绝对路径、父目录逃逸和跟随符号链接越界。
- **外链与图片**：外链只允许 `http:`、`https:`、`mailto:` 且需用户确认；远程图片默认拦截；SVG data URL 不允许。注意 `read_asset` 的 MIME 由扩展名推断、Rust 侧不做白名单，真正的拦截在 `MarkdownRenderer.tsx` 的 `resolvedUrl`——它在 resolver 前后各做一次 `safeUrlTransform`，第二次那道校验挡的正是"库内 .svg 被解析成 `data:image/svg+xml`"，不可删。
- **索引与监听**：搜索索引是 SQLite FTS5 trigram，持久化在 `app_cache_dir/reade-cache.sqlite3`，按文件 size/mtime 与 `CONVERTER_REVISION` 增量失效，不是每次打开都全量重建；缓存 schema 不匹配会整库删除重建。watcher 只在 `open_library` 时创建，`refresh_library` 不重建；`library-changed` 事件只作为刷新信号，前端收到后调用 `refreshLibrary()`。
- **数据存储分层**：三个独立 SQLite —— `app_cache_dir/reade-cache.sqlite3`（派生文本与索引，可随时删）、`app_cache_dir/reade-user.sqlite3`（标注/合集/回顾，带迁移链与升级备份）、`app_data_dir/reade-stats.sqlite3`（阅读会话）。清缓存与重建索引的逻辑绝不能触碰后两者。缓存里纯新增表不要 bump `CACHE_SCHEMA_VERSION`，否则会触发全库重索引。
- **权限配置**：`src-tauri/capabilities/default.json` 只允许目录选择和安全外链；新增权限必须说明用户可见影响与攻击面。
- **Web 发布边界**：`READE_CONTENT_DIR` 中被生成器接收的内容最终完全公开；manifest、文档 URL 和搜索数据必须保持同源、相对 Pages 根路径。

## Git

- 保留用户已有改动，不回滚或覆盖无关文件。
- 只修改任务需要的文件；提交、推送、建分支或初始化仓库前先获得明确授权。
- 若用户要求提交，使用 `feat:`、`fix:`、`refactor:`、`docs:` 或 `test:` 加简短说明。
- 不提交 `.env`、凭据、`node_modules/`、`dist/`、`src-tauri/target/` 或临时截图。

## 完成报告

非平凡任务完成时说明：

1. 修改了什么文件和行为。
2. 为什么这样改，尤其是安全或架构取舍。
3. 实际运行了哪些验证及结果。
4. 仍未验证的内容、风险与限制。

## 项目特定说明

- 桌面版发现 `.md`、`.markdown`、`.mdx`、`.pdf`、`.epub`；`.mdx` 仅按普通 Markdown 安全展示；Web 版只发布 Markdown。
- 桌面扫描遵守 `.gitignore`，不跟随符号链接，并排除常见构建/依赖目录；Web 生成器不读 `.gitignore`，改用扩展名白名单，两者语义不同。
- 前端 localStorage 只存偏好与轻量位置：`reade-reader-preferences`、`reade-library-mru`、`reade-reading-positions`、`reade-vertical-writing`、`reade-home-baseline`、`reade-device-id`；文档正文和索引不进前端存储。Web 版的标注与合集存 IndexedDB。
- 快捷键：`Ctrl+O` 选择文档库（桌面）、`Ctrl+K` 聚焦搜索、`Ctrl+P` 命令面板、`Ctrl+B` 书签、`Ctrl+Z` 撤销标注、`Alt+←/→` 阅读回退栈、`Esc` 关闭浮层；改动时同步可访问名称和界面提示。
- `examples/demo-library/` 用于功能联调，`output/playwright/` 只作为视觉参考，不是源码或自动化测试结果的替代品。
- `docs/roadmap-innovations.md` 末尾有一份尚未完成的人工验收清单（桌面真机 9 项、Web 真实部署 4 项）。碰到清单里的功能时，别把"测试通过"当成已验收。
- `APP_RUNTIME` 由 Vite mode 决定：默认/production 是 desktop，`--mode web` 是 Web；不得用浏览器特征猜运行时。
