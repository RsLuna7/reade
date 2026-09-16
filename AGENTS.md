# AGENTS.md

<!-- reade-agents v:2 -->

> 只保留稳定、可执行的项目约束；实现细节按下表读取，不把临时任务要求永久化。

## 项目与范围

Reade 是个人使用、本地优先的 Windows 长文阅读器，支持 Markdown、PDF 和可重排 EPUB。
使用 Tauri 2 / Rust、React / TypeScript / Vite / Zustand；版本以依赖清单为准。

- 保持三栏长文阅读体验、启动速度与安装包开销；标注、合集、回顾与统计留在本机。
- 不因局部任务引入编辑器、账号、云同步、遥测或网络依赖，不主动上传文档。
- **Web 已封存**：新功能只做桌面，不补 Web 专属 UI、`IS_WEB_RUNTIME` 体验分支或桌面功能对等实现。
- 保留现有静态站、PWA、生成器及共享阅读界面；仅用户明确要求，或共享改动引发 Web 构建/安全回归时修 Web，不推进其新功能验收。
- `APP_RUNTIME` 由 Vite mode 决定（默认/production 为 desktop，`--mode web` 为 Web），不要靠浏览器特征猜运行时。

## 动手前读取

先检查相关源码、测试、配置和已有改动，沿用现有模式。事实以代码为准，不凭目录名或历史计划猜测。

| 涉及内容 | 读取入口 |
| --- | --- |
| 产品能力、环境、依赖 | `README.md`、`package.json`、`src-tauri/Cargo.toml` |
| 模块定位、渲染、文件、存储、索引或对应测试 | [Agent 参考](docs/agent-reference.md) 的相关小节 |
| IPC | `src-tauri/src/lib.rs` 的 `generate_handler!`、`src/lib/backend.ts` 和对应实现 |
| 样式与排版 | `src/App.css` 及其导入的 `src/styles/` 文件 |
| CI 或发布 | `.github/workflows/verify.yml`、`.github/workflows/deploy-pages.yml` |
| 公约维护与纠错蒸馏 | [智能体闭环](docs/agent-skills-loop.md) |

## 修改约定

- 改动聚焦，不做无关重构、依赖升级或全仓格式化；大文件定点修改，不整体重写或顺手重排。
- 纯逻辑优先放 `src/lib/`，共享状态放 store，系统权限留在 Rust/Tauri 层。
- IPC 必须同步 Rust command、TypeScript wrapper、参数和返回类型；Rust 参数 snake_case，前端 invoke 参数 camelCase。
- 前端统一通过 `src/lib/backend.ts` facade；修改契约时同步两侧孪生测试与 command 名称对账测试。
- 保持 TypeScript 与 ES2020 兼容；不要使用未配置 polyfill 的新 API。
- Shiki、Mermaid 等重型能力继续按需加载，不提前进入首屏路径。
- 不直接编辑 `dist/`、`public/reade-web/`、`node_modules/`、`src-tauri/target/`、`src-tauri/gen/schemas/` 或打包产物；锁文件由依赖工具更新。

## 安全与数据底线

- 文档、文件名、链接、图片、Mermaid 和所选文档库均视为不可信输入。
- raw HTML 保持禁用；MDX 仅按 Markdown 展示，不执行 JSX、import 或脚本；EPUB 不执行书内 HTML/CSS。
- 文件读取使用相对路径，在 Rust canonicalize 后确认目标位于当前文档库内；禁止绝对路径、父目录逃逸与符号链接越界。
- 前端不能绕过 Tauri command 获取任意文件系统权限。
- 不放宽 CSP、capability、路径校验、文件大小或 Mermaid 限制，除非任务明确要求并附验证；新增权限需说明用户可见影响及攻击面。
- 外链只允许 http/https/mailto 且需用户确认；远程图片默认拦截；禁止 javascript/file、协议相对 URL 和任意 data 内容。
- Mermaid 保持 strict，输出经 `sanitizeMermaidSvg` 后注入；不要退回被 CSP 拦截的 data iframe。
- 库内 SVG 经 `sanitizeLibrarySvg` 后内联，不生成 SVG data URL；URL resolver 前后的 `safeUrlTransform` 校验不可删除。
- **缓存、用户数据、阅读统计是独立数据库**：清缓存或重建索引绝不能触碰用户数据和统计；缓存纯新增表不要 bump `CACHE_SCHEMA_VERSION` 导致全库重索引。
- Web 生成器只发布明确允许公开的 Markdown 与安全图片格式；其 manifest、文档 URL、搜索数据保持同源、相对 Pages 根路径。

## 命令

在项目根目录用 PowerShell；只使用 pnpm，不混用 npm、Yarn 或 Bun。不要虚构 `pnpm lint`。

```powershell
pnpm install
pnpm tauri dev
pnpm dev
pnpm test
pnpm typecheck
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm tauri build
```

Web 兼容维护使用 `pnpm dev:web`、`pnpm build:web`、`pnpm preview:web`；生成器入口是 `pnpm generate:web`。
环境失败先诊断 Node.js、pnpm、Rust、WebView2 与 Windows C++ build tools，不改产品代码掩盖问题。

## 验证与完成

- 小型局部修改：检查 → 实现 → 最小相关验证 → 汇报。
- 跨前后端、IPC、安全、架构或依赖变更：先确认契约和风险，再做最小可审查实现，运行定向测试及相关构建。
- 行为变化更新对应测试；修改 URL、HTML、资源读取、CSP、capability 或 Mermaid 必须补安全回归测试。
- 跨模块变更完成前至少运行 `pnpm test`、`pnpm typecheck`、`cargo test` 和 `cargo clippy`（Rust 使用上方 manifest 参数）；Rust 改动另查 fmt。
- 排版、滚动、目录跟随或响应式变化须用真实 Tauri 窗口或浏览器截图验证明暗主题与窄窗口；测试通过不等于视觉验收。
- CI 已含前端与 Windows Rust 验证，Pages 发布依赖 verify 门禁；不能以 CI 代替本地相关验证。
- 完成时说明修改的文件与行为、原因、实际验证结果，以及未验证项、风险和限制。

## Git

- 保留用户已有改动，不覆盖或回滚无关文件，只修改任务所需内容。
- 提交、推送、发布、建分支或初始化仓库需用户明确授权。
- 获准提交时用 `feat:`、`fix:`、`refactor:`、`docs:` 或 `test:` 加简短说明。
- 不提交 `.env`、凭据、依赖/构建产物或临时截图。

## 指令维护

- 同类失误先考虑回归测试；测试已覆盖的行为不再堆成教条。
- 一次性纠错暂存 `.agents/learnings.md`；可泛化规则先提议，得到用户确认后再改本文。
- 长流程使用按需 Skill 或参考文档，不复制到本文或嵌套 AGENTS.md；Memory 不作为规范。
- 未获明确授权不要整篇重写本文，日常纠错保持增量维护。

## Learned guidelines

Improver 只增量维护本节，最多 12 条；每条用祈使句并括号写 Why，冲突时改旧条而非叠加。
一次性补丁写 `.agents/learnings.md`，信号不足可空跑；变更本节时递增文首版本，不自行提交。

（暂无。）
