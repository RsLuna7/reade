# Reade

Reade 是一款共享同一阅读界面的 Markdown 阅读器：Windows 桌面版读取本地文档，Web 版把公开文档构建为 GitHub Pages 静态站点。它采用三栏布局，把文档树、正文和章节目录分开滚动，并围绕中文与英文长文阅读优化版心、字号、行高和段落节奏。

## 当前能力

- 选择本地文件夹并递归发现 `.md`、`.markdown`、`.mdx`
- 文件树、键盘导航、自动刷新与 SQLite FTS5 全文检索
- GFM、脚注、KaTeX 数学公式、Shiki 代码高亮、Mermaid 图表
- 跟随阅读位置的章节目录、阅读进度和逐文档滚动位置
- 浅色/深色主题；字号、行高、版心、段距和字体风格调节
- 文档内相对链接与本地图片解析
- 桌面版完全离线；两种运行时均不执行 raw HTML
- Web 版构建期生成文档 manifest 与搜索数据，支持可分享的 `?doc=文档#章节` URL

首版定位为只读阅读器，不包含编辑、批注、云同步、账号、自动更新与代码签名。

## 技术结构

- Desktop shell：Tauri 2 / Rust
- UI：React 19 / TypeScript / Zustand
- Markdown：react-markdown + remark-gfm + remark-math + rehype-katex + rehype-slug
- Extensions：Shiki（常用语言按需加载）与 Mermaid（懒加载、sandbox）
- File/search：`ignore`、`notify`、SQLite FTS5 trigram
- Web publishing：Node.js 静态库生成器、客户端延迟搜索、GitHub Actions / Pages

Rust 后端只接受相对于已选文档库的路径，并在读取前进行 canonical path 校验。Markdown 单文件上限为 10 MiB，本地资源上限为 25 MiB；常见构建目录和 `.gitignore` 内容会被扫描器排除。

## 本地开发

前置条件：Node.js 24、pnpm、Rust stable、Microsoft Edge WebView2 Runtime，以及 Tauri 2 所需的 Windows C++ build tools。

```powershell
pnpm install
pnpm test
pnpm tauri dev
```

生产构建：

```powershell
pnpm tauri build
```

Web 开发与静态构建：

```powershell
pnpm dev:web
pnpm build:web
pnpm preview:web
```

Web 构建默认发布 `examples/demo-library`。用 `READE_CONTENT_DIR` 指定公开 Markdown 目录，用 `READE_SITE_TITLE` 修改站点标题；完整配置和 GitHub Pages 启用步骤见 [`docs/WEB_DEPLOY.md`](docs/WEB_DEPLOY.md)。生成器只复制 Markdown 与常见安全栅格图片格式，不会把 `.env` 或任意附件自动放入公开站点。

默认生成 Windows x64 NSIS 安装包。测试阅读库位于 `examples/demo-library`，覆盖 GFM、公式、Mermaid、脚注和代码块。

## 验证命令

```powershell
pnpm test
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

## MVP 限制

- 搜索索引当前在每次打开或刷新文档库时重建，适合约 10,000 篇的个人文档库；后续若文档正文总量达到数 GiB，应改为持久化增量索引。
- Web 搜索数据在构建时生成，第一次搜索时由浏览器加载；超大型公开文档库后续应改为分片索引。
- `.mdx` 以安全的普通 Markdown 方式只读展示，不执行 JSX 或 import。
- 外部链接需要用户确认后交给系统应用；远程图片默认不请求。
- 安装包暂不签名，也不提供自动更新。
