# AGENTS.md

> Reade 项目的 AI coding agent 工作约定。保持本文短小、可执行；较长说明写入 `docs/` 或 `README.md`。
> 当 agent 反复误解同一约束时更新本文，不要把临时任务要求永久化。

---

## 项目

Reade 是一款个人使用的 Markdown 阅读器。Windows 桌面版只读本地文档，Web 版把明确允许公开的内容构建为 GitHub Pages 静态站点；两者共享 React 阅读界面与安全渲染管线。

主要目标：

- 在三栏布局中提供稳定、可调且适合长文的阅读体验。
- 安全读取和检索本地 Markdown，不执行文档携带的代码或主动上传内容。
- 保持启动、安装包与运行时开销适合个人桌面应用。
- 用同一套 UI 支持本地 Tauri backend 与静态 Web library，不复制两套阅读器。

## 技术栈

- Desktop shell：Tauri 2、Rust 2021、Windows WebView2
- Frontend：React 19、TypeScript 5、Vite 7、Zustand 5
- Markdown：`react-markdown`、`remark-gfm`、`remark-math`、`rehype-katex`、`rehype-slug`
- 扩展渲染：Shiki 按需加载、Mermaid 懒加载并使用 sandbox
- 本地能力：`ignore`、`notify`、内存 SQLite FTS5 trigram
- Web 发布：Node.js 生成器、静态 manifest/search、GitHub Actions / Pages
- Package manager：pnpm；不要混用 npm、Yarn 或 Bun
- Tests：Vitest + Testing Library + jsdom；Rust 内置测试

## 仓库地图

只列日常开发需要的路径：

```text
.
├── src/
│   ├── App.tsx                    # 应用编排、阅读交互、链接与资源解析
│   ├── App.css                    # 三栏布局、主题和 Markdown 排版
│   ├── components/                # Markdown 渲染器与文档树
│   ├── lib/                       # Tauri IPC、Markdown 安全策略、目录树纯函数
│   ├── store/                     # Zustand 阅读器状态与持久化偏好
│   └── test/                      # 前端测试环境
├── src-tauri/
│   ├── src/library.rs             # 扫描、读取、监听、搜索与路径校验
│   ├── src/lib.rs                 # Tauri plugins、state 和 commands 注册
│   ├── capabilities/default.json  # 最小桌面权限
│   └── tauri.conf.json            # 窗口、CSP 与打包配置
├── examples/demo-library/         # 手工验收用 Markdown 文档库
├── scripts/                       # Web 静态文档库生成器及测试
├── docs/WEB_DEPLOY.md             # GitHub Pages 配置、验证与回滚
├── .github/workflows/             # Pages 自动构建和部署
├── output/playwright/             # 已有视觉基线截图
├── package.json
└── README.md                      # 产品能力、环境要求与 MVP 限制
```

- 架构事实优先读取 `README.md`、`package.json`、`src-tauri/Cargo.toml` 和实际源码，不凭目录名猜测。
- `dist/`、`public/reade-web/`、`node_modules/`、`src-tauri/target/`、`src-tauri/gen/schemas/` 是构建或生成内容，不直接编辑。

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

手动运行 10,000 文档性能验收：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --release indexes_ten_thousand_documents_within_mvp_budget -- --ignored --nocapture
```

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
- 文档树、排序或路径规格化：更新 `src/lib/tree.test.ts`。
- 阅读设置或持久化状态：更新 `src/store/useReaderStore.test.ts`。
- 扫描、越界路径、搜索、文件限制或标题提取：更新 `src-tauri/src/library.rs` 中的 Rust tests。
- 先跑最小相关测试；跨模块变更完成前至少跑 `pnpm test`、TypeScript 检查、`cargo test` 和 `cargo clippy`。
- 测试通过不等于视觉正确；排版、滚动、目录跟随和响应式布局需要运行时证据。

## 高风险区域

- **IPC 契约**：当前 commands 是 `open_library`、`refresh_library`、`read_document`、`search_documents`、`read_asset`。Rust 使用 snake_case 参数，前端 `invoke` 传 camelCase；改变一端时必须同步另一端和类型。
- **渲染安全**：raw HTML 保持禁用；Mermaid 维持 `securityLevel: "sandbox"`、50,000 字符和 500 条连线限制。
- **文件边界**：Markdown 上限 10 MiB，本地资源上限 25 MiB；禁止绝对路径、父目录逃逸和跟随符号链接越界。
- **外链与图片**：外链只允许 `http:`、`https:`、`mailto:` 且需用户确认；远程图片默认拦截；SVG data URL 不允许。
- **索引与监听**：搜索索引当前为内存 FTS5，打开或刷新文档库时重建；`library-changed` 事件只作为刷新信号，前端收到后调用 `refreshLibrary()`。
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

- `.md`、`.markdown` 和 `.mdx` 都会被发现；`.mdx` 仅按普通 Markdown 安全展示。
- 扫描遵守 `.gitignore`，不跟随符号链接，并排除常见构建/依赖目录。
- 阅读主题、阅读参数和目录展开状态存入 localStorage；文档正文和索引不持久化到前端存储。
- `Ctrl+O` 选择文档库，`Ctrl+K` 聚焦搜索；改动快捷键时同步可访问名称和界面提示。
- `examples/demo-library/` 用于功能联调，`output/playwright/` 只作为视觉参考，不是源码或自动化测试结果的替代品。
- `APP_RUNTIME` 由 Vite mode 决定：默认/production 是 desktop，`--mode web` 是 Web；不得用浏览器特征猜运行时。
