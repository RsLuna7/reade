# Reade

Reade 是一款本地优先的长文阅读器：Windows 桌面版读取 Markdown、PDF 与可重排 EPUB，Web 版仍只把公开 Markdown 构建为 GitHub Pages 静态站点。它采用三栏布局，把文档树、正文和章节目录分开滚动，并围绕中文与英文长文优化留白、字号、行高和段落节奏。

## 当前能力

- 选择本地文件夹并递归发现 `.md`、`.markdown`、`.mdx`、`.pdf`、`.epub`
- PDF 原版式连续滚动、文本层、Outline、50%–300% 缩放（工具栏或 `Ctrl+滚轮`）、适宽与按页阅读模式；宽窗可切双页对开（封面独立、按对翻页、窄窗自动回落）
- 可重排 EPUB 安全语义渲染、章节目录与 Reade 统一排版，不加载书内 HTML/CSS
- 文件树、键盘导航、自动刷新、后台增量索引与 SQLite FTS5 全文检索
- GFM、脚注、KaTeX 数学公式、Shiki 代码高亮、Mermaid 图表
- 跟随阅读位置的章节目录、阅读进度和逐文档滚动位置
- 划线高亮、下划线、短笔记与书签（默认划选后点「标记」；顶栏可开连续落笔。桌面存本机 SQLite；Web 版 Markdown 用 IndexedDB）
- 间隔回顾：只有主动加入的摘录按固定间隔阶梯（1→60 天）到期重现；从命令面板或全库摘录进入，主页不催促
- 回顾挖空闪卡：回顾卡可切摘录/挖空/混合三档，挖空档遮住最显著片段、先回想再揭示评分（默认摘录档不变）
- 那年今日：主页卡片重现一年前/一个月前今天划下的标注与读过的文档，点击跳回原文（无痕迹时整卡隐藏）
- 全库摘录：跨文档全文检索与类型/颜色/感悟/间隔回顾筛选、分组折叠、按文档导出、失联重绑与导入；入口在标注 tab / 命令面板（二级全屏，不占阅读侧栏）
- 标注颜色：三色低彩度外观（暖砂/青灰/墨蓝）；旧四色数据仍可辨认，颜色不表示知识类别
- 金句卡片：选区或已有高亮一键生成随主题取色的引文卡片 PNG，剪贴板复制为主、下载兜底
- 阅读报告卡片：统计视图一键生成本月/今年/上一年的四张报告图卡（总览/习惯/书单/金句），本地聚合渲染、随主题取色，可复制或批量下载
- 全书回顾编纂：把当前文档全部摘录按章节结构编纂成一页只读读书报告（章节归因与目录热力同源），条目跳回原文，可导出 Markdown
- PDF 区域引用卡片：原版式下框选任意矩形区域，裁剪位图配自动出处（文档名·页码）生成引用图卡，低清缩放自动离屏重渲提质，扫描版同样可用
- 相关段落：选中 ≥8 字符在全库寻找词面相关的其他段落，命中直达对应页/章
- 只读双链数据：索引提取反向链接与出链（含 `[[wiki]]`），供「读完接着读」的关联档使用；正文库内链接可跳转，不改写文档
- 链接悬停预览：正文库内链接悬停浮出目标标题与纯文本摘录（PDF 含页数），脚注引用就地预览；外链绝不因悬停联网
- 文档地图：正文右缘刻度层标出标注三色/书签/搜索命中并可点击跳转，布局变化自动重算，密集时聚簇抽稀（可在阅读设置关闭）
- 聚焦模式：段落聚焦（当前段外降不透明度）、打字机滚动（阅读行保持视口中部）、阅读标尺（跟随指针的横向色带）三个独立开关，接入三档动效体系；PDF 原版式明确禁用
- 读完接着读：滚动到文档末尾浮现下一篇推荐卡，合集顺序 → 同文件夹 → 互链最多三级回落，理由徽标明示来源，可关闭（会话级记忆）
- 书架视图：库 tab 列表/书架一键切换（记住偏好），网格卡片 = 自动封面 + 格式徽标 + 阅读进度角标；PDF 首页缩略懒渲染进缓存、EPUB 打开时提取书内封面、Markdown 用标题哈希的主题色渐变生成式封面（Web 版全生成式）
- 库覆盖率知识地图：阅读统计内手写 squarified treemap，面积=索引字符数、色深=到达覆盖率（五档热力色阶），文件夹下钻/面包屑返回、文档瓦片直达原文（桌面版）
- 合集/阅读清单：跨文件夹手工策展的命名清单，进度徽标、失联灰显、随重绑迁移
- 分栏对照阅读：主栏全功能 + 副栏纯净阅读面，拖拽分割条 30–70%，窄窗自动退化恢复
- 命令面板：`Ctrl+P` 模糊切换文档与合集（中文子串 + 英文缩写），直达主题、分栏等常用命令
- 阅读回退栈：跳转（搜索/双链/相关段落/合集/目录）前自动记录位置，`Alt+←/→` 或 topbar 按钮原路后退/前进
- 最近书库列表：欢迎页与侧栏书库名菜单记住最近 8 个书库一键切换，失效路径灰显可移除（桌面版）
- 阅读时间预估：文档树/继续阅读卡/目录顶部显示「约 N 分钟」，按近 90 天个人实测速度自动校准（中位数抗离群）
- 增量重读：重开已读且被修改过的文档时顶部横幅提示变化规模，变更段落左缘标线并可循环跳转（Markdown 段级/EPUB 章级/PDF 页级提示）；快照存缓存独立 256 MiB 限额（桌面版）
- 竖排模式（实验）：Markdown/EPUB 每文档竖排开关（`writing-mode: vertical-rl`、从右往左横向滚动、滚轮换轴），代码块/公式/表格保持横排孤岛；聚焦模式、文档地图、位置记忆等纵向假设功能竖排下显式禁用并提示，关闭后完全恢复
- 浅色/深色主题；字号、行高、段距和字体风格调节（阅读中 `Ctrl+滚轮` 可快速调字号）；关闭/克制/完整三档微动效
- 主题切换墨水扩散：完整动效档下从日/月按钮或风格色卡位置做圆形揭示过渡（View Transitions，不支持的浏览器自动回落）
- 正文默认随窗口铺满中间栏；阅读设置可设最大正文宽度（最右为「随窗口」）
- 文档内相对链接与本地图片解析
- 桌面版默认离线；用户可在阅读设置中允许加载 Markdown 远程 HTTPS 图片。两种运行时均不执行 raw HTML
- Web 版构建期生成文档 manifest 与搜索数据，支持可分享的 `?doc=文档#章节` URL
- Web 段落分享深链：选中文字一键复制 `?doc=文档#text=…` 链接，打开时自动定位到该段并短暂高亮，文本已变更时诚实提示
- Web PWA 离线化：可安装到桌面/主屏，手写零依赖 service worker 让读过的文档断网可读（应用壳版本化更新、内容缓存 LRU 上限），桌面版不注册
- Web 移动端阅读手势：窄屏触控下底部工具条（滚动感知半隐）、左右屏缘轻扫开文档树/目录抽屉、长按选字直接出标注工具条，触控目标 ≥44px，桌面零变化

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
- Extensions：Shiki（常用语言按需加载）与 Mermaid（懒加载、`securityLevel: "strict"` 内联 SVG）
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
