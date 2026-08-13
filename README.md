# Reade

Reade 是一款本地优先的长文阅读器：Windows 桌面版读取 Markdown、PDF 与可重排 EPUB，Web 版仍只把公开 Markdown 构建为 GitHub Pages 静态站点。它采用三栏布局，把文档树、正文和章节目录分开滚动，并围绕中文与英文长文优化留白、字号、行高和段落节奏。

## 当前能力

- 选择本地文件夹并递归发现 `.md`、`.markdown`、`.mdx`、`.pdf`、`.epub`
- PDF 原版式连续滚动、文本层、Outline、50%–300% 缩放、适宽与按页阅读模式
- 可重排 EPUB 安全语义渲染、章节目录与 Reade 统一排版，不加载书内 HTML/CSS
- 文件树、键盘导航、自动刷新、后台增量索引与 SQLite FTS5 全文检索
- GFM、脚注、KaTeX 数学公式、Shiki 代码高亮、Mermaid 图表
- 跟随阅读位置的章节目录、阅读进度和逐文档滚动位置
- 划线高亮、下划线、短笔记与书签（桌面存本机 SQLite；Web 版 Markdown 用 IndexedDB）
- 每日回顾：高亮/下划线按固定间隔阶梯（1→60 天）到期重现，主页「今日回顾」卡一键进入
- 全库标注中枢：跨文档全文检索与类型/颜色筛选、分组折叠、按文档导出、失联文档标注集中展示
- 标注颜色语义命名：四色可自定义语义名（默认金句/疑问/行动/术语），显示于颜色选择、筛选与图例，可一键恢复默认
- 金句卡片：选区或已有高亮一键生成随主题取色的引文卡片 PNG，剪贴板复制为主、下载兜底
- 本地朗读：仅用系统本地语音逐句朗读（离线，不发送正文），句级跟随高亮、语速/语音可调
- 相关段落：选中 ≥8 字符在全库寻找词面相关的其他段落，命中直达对应页/章
- 只读双链：侧栏「链接」tab 展示反向链接与出链（含 `[[wiki]]`），断链计数、不改写文档
- 链接悬停预览：正文库内链接与侧栏链接行悬停浮出目标标题与纯文本摘录（PDF 含页数），脚注引用就地预览；外链绝不因悬停联网
- 合集/阅读清单：跨文件夹手工策展的命名清单，进度徽标、失联灰显、随重绑迁移
- 分栏对照阅读：主栏全功能 + 副栏纯净阅读面，拖拽分割条 30–70%，窄窗自动退化恢复
- 命令面板：`Ctrl+P` 模糊切换文档与合集（中文子串 + 英文缩写），直达主题、分栏、朗读等常用命令
- 阅读回退栈：跳转（搜索/双链/相关段落/合集/目录）前自动记录位置，`Alt+←/→` 或 topbar 按钮原路后退/前进
- 最近书库列表：欢迎页与侧栏书库名菜单记住最近 8 个书库一键切换，失效路径灰显可移除（桌面版）
- 阅读时间预估：文档树/继续阅读卡/目录顶部显示「约 N 分钟」，按近 90 天个人实测速度自动校准（中位数抗离群）
- 浅色/深色主题；字号、行高、段距和字体风格调节；关闭/克制/完整三档微动效
- 正文默认随窗口铺满中间栏；阅读设置可设最大正文宽度（最右为「随窗口」）
- 文档内相对链接与本地图片解析
- 桌面版完全离线；两种运行时均不执行 raw HTML
- Web 版构建期生成文档 manifest 与搜索数据，支持可分享的 `?doc=文档#章节` URL

首版定位为本地优先阅读器：支持标注与书签，不包含文档编辑、云同步、账号、自动更新与代码签名。

## 使用文档

- [Reade 新手使用说明书](docs/USER_GUIDE.md)：从安装、选择书库到 Markdown、PDF、EPUB 阅读、全文检索、设置和常见问题。
- [Web 发布说明](docs/WEB_DEPLOY.md)：面向站点维护者的 GitHub Pages 构建与发布步骤。

## 技术结构

- Desktop shell：Tauri 2 / Rust
- UI：React 19 / TypeScript / Zustand
- Motion：CSS + Web Animations API，无第三方动效运行时依赖
- PDF：PDF.js `pdfjs-dist@6.2.108`；`pdf-inspector@0.1.8` 按页提取阅读文本
- EPUB：`anydoc@0.1.8` 转换为 Reade 自有安全 DTO
- Markdown：react-markdown + remark-gfm + remark-math + rehype-katex + rehype-slug
- Extensions：Shiki（常用语言按需加载）与 Mermaid（懒加载、sandbox）
- File/search：`ignore`、`notify`、SQLite FTS5 trigram
- Web publishing：Node.js 静态库生成器、客户端延迟搜索、GitHub Actions / Pages

Rust 后端只接受相对于已选文档库的路径，并在读取前进行 canonical path 校验。PDF 通过单次最多 4 MiB 的 Range IPC 加载；超过 128 MiB 时仍可原版式阅读，但不提取文本。EPUB 上限为 128 MiB，仅允许内嵌安全栅格图片。派生文本保存在应用缓存目录的 `reade-cache.sqlite3`，使用 1 GiB 软上限、90% 低水位和增量回收，不改写用户文档库。

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

## 当前限制

- 桌面扩展首版只支持 PDF 与可重排 EPUB；fixed-layout、DRM、密码 PDF 与 SVG 书内资源会明确提示不支持。
- 暂不提供 OCR、打印、Markdown 导出和 Office 格式转换；扫描 PDF 会标明缺失页且不会冒充完整结果。
- 标注保存在本机应用数据中，不写入文档库，也不做云同步；文档大幅改动后部分高亮可能显示为定位失效。支持按文档清空与会话内撤销，不含云端同步。
- Web 搜索数据在构建时生成，第一次搜索时由浏览器加载；超大型公开文档库后续应改为分片索引。
- `.mdx` 以安全的普通 Markdown 方式只读展示，不执行 JSX 或 import。
- 外部链接需要用户确认后交给系统应用；远程图片默认不请求。
- 安装包暂不签名，也不提供自动更新。
