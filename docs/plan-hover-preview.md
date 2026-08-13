# 方案定稿：库内链接悬停预览卡

- 日期：2026-08-13（基线查证日；同日复核定稿）
- 状态：**定稿（基线已复核，决策见 §6 与 §8）**
- 定位：悬停 `[[wiki]]` / 相对路径库内链接 ≥400ms，浮出目标文档开头段落（或 fragment 对应章节摘录）的纯文本预览卡；脚注引用悬停就地预览脚注内容；PDF 目标显示标题+页数。降低"点过去又跳回来"的导航损耗。
- 关联：链接解析语义完全复用只读双链（`docs/plan-backlinks.md`）的 `documentLinks.ts`；桌面预览文本读缓存 sqlite 的 `search_segments`（与相关段落同一数据源，`docs/plan-related-passages.md`）；Web 用 `search.json` 全文。

> 一句话：新 Rust command `read_document_preview(relative_path, fragment?) → { title, excerpt, format, pages? }` 从 `search_segments` 取目标文档首段/指定章节的前 N 字符；前端 `MarkdownRenderer` 的 `<a>` 上挂 400ms 意图计时器，浮出纯文本预览卡（受限渲染，无任何 HTML 执行面）；Web 分支同一契约走 `search.json`。

---

## 1. 现状基线（已核实于 2026-08-13，行号允许漂移）

| 事实 | 位置 |
|------|------|
| 链接解析已模块化：`resolveLibraryPath(source, documentPath)`、`extractDocumentLinks`、`resolveWikiTargets(stems, presentPaths)` 全在 `documentLinks.ts`（App.tsx 已 import 该模块） | `src/lib/documentLinks.ts` L102-125、L163、L381-391 |
| `MarkdownRenderer` 的 `<a>`：`onNavigate` 存在时 `preventDefault` 并委托导航——**悬停事件可加在同一组件处** | `src/components/MarkdownRenderer.tsx` L390-395 |
| 脚注为 remark-gfm 默认产物：引用链到 `#user-content-fn-*`，正文在 `section[data-footnotes]`——**脚注预览可直接查本页 DOM，零 IPC** | `src/components/MarkdownRenderer.test.tsx` L20-21 |
| 桌面全文派生数据：`search_segments(content TEXT NOT NULL)` 按 markdown 整篇 / PDF 每页 / EPUB 每章分段存储 | `src-tauri/src/library.rs` L1136-1148 |
| PDF 页数可由 `search_segments` 该文档 segment 计数（或 `document_cache` 元数据）得出；`DocumentInfo` 有 title/format/size 无字数 | `src-tauri/src/library.rs` L76-84、L2095-2149 |
| 路径校验先例：`validate_relative_library_path` + `ensure_document_in_open_library` | `src-tauri/src/library.rs` L1621-1635、L1655-1665 |
| Web 全文：`search.json` 每篇 `{ relativePath, title, content }`，`loadSearchIndex()` 带实例缓存 | `src/lib/webLibrary.ts` L43-52、L428-433 |
| Web 链接视图上限先例：>500 篇禁用（`WEB_LINKS_MAX_DOCUMENTS`） | `src/lib/documentLinks.ts` L29 |
| raw HTML 禁用、外链需确认、CSP `script-src 'self'` 等红线 | `src-tauri/tauri.conf.json` L26；AGENTS.md |
| 浮层先例：RelatedPassagesPopover fixed 定位 + 坐标 props | `src/components/RelatedPassages.tsx` L61-67；`src/App.css` L3160-3172 |

## 2. 目标与非目标

**目标**

1. 悬停库内文档链接（wiki 与相对路径）≥400ms → 预览卡：目标标题 + 开头 ~300 字符纯文本 + 格式徽标；PDF 显示"PDF · 共 N 页"，fragment 指向页时给该页文本摘录。
2. 链接带 `#fragment` 且目标为 markdown 时，摘录从对应标题之后开始（在 content 内检索标题行定位，尽力而为）。
3. 脚注引用悬停：就地浮出脚注正文（本页 DOM 提取，纯文本）。
4. 键盘可达：链接聚焦 600ms 同样触发；Esc 关闭；移开即淡出。

**非目标（明确不做）**

- 预览不渲染 Markdown 富格式（不做嵌套 MarkdownRenderer——递归渲染 + 图片/Mermaid 的攻击面与成本都不值；纯文本 + 换行保留）。
- 不预览外链（外链有确认对话框语义，预览会造成"已访问"错觉）。
- 不做图片/资产链接预览。
- 不缓存到磁盘（内存 LRU 即可，文档变更经 `library-changed` 自然失效）。

## 3. 设计

### 3.1 IPC 契约（新 command）

| command | wrapper | 返回 |
|---|---|---|
| `read_document_preview(relative_path: String, fragment: Option<String>)` | `readDocumentPreview(relativePath, fragment?)` | `{ title, format, excerpt: String(≤600 chars), pdfPages: Option<u32> }` |

- 路径过 `validate_relative_library_path` + `ensure_document_in_open_library`；只读 SELECT `search_segments`。
- markdown：取整篇 segment content，fragment 命中标题行则从其后起，否则从头；截 600 字符（前端再按卡片高度截断）。
- PDF：fragment 解析为页号则取该页 segment，否则第 1 页有文本的 segment；`pdfPages` = segment 计数。
- EPUB：fragment 匹配 `epubChapter` locator 则取该章，否则首章。
- 索引未就绪（`index_status != ready`）返回 excerpt 空 + 状态字段，前端显示"索引中…"。

### 3.2 前端交互

- `MarkdownRenderer` 增可选 prop `onLinkPreview(resolved, rect) / onLinkPreviewCancel`；App 层挂 `HoverPreviewCard` 组件（懒加载，同 RelatedPassages 模式）。
- 400ms 进入计时 / 200ms 离开宽限（可移入卡片内部保持打开）；同一目标 60 秒内存 LRU（上限 20 条）不重复请求；请求带序号守卫。
- 卡片：fixed 定位于链接 rect 下方（贴边 clamp），宽 ~360px，纯文本 `white-space: pre-line`，底部"打开 →"行点击即走既有 `onNavigate`。
- 脚注：`href^="#user-content-fn-"` 时不走 IPC，直接取 `section[data-footnotes]` 内对应 li 的 `textContent`。
- 触屏（无 hover）：不触发，行为回落为点击导航（媒体查询 `(hover: hover)` 守卫）。

### 3.3 Web 端

- 同一 wrapper 走 `loadSearchIndex()`：按 `relativePath` 取 content，截取逻辑与桌面同一 TS 纯函数 `buildPreviewExcerpt(content, fragment?)`（契约孪生，Rust 侧对齐用例表）。Web 无 PDF。

### 3.4 安全

- 预览是 `textContent` 级输出，不经任何 HTML 管线；无新权限；查询只读；fragment 仅作字符串检索不拼 SQL（参数化）。

## 4. 改动清单（预估）

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/previewExcerpt.ts`（新）+ 测试 | 摘录截取契约纯函数 | S-M |
| 2 | `src-tauri/src/library.rs` + `lib.rs` | command + 注册 + 测试 | M |
| 3 | `src/lib/backend.ts` | wrapper 双分支 | S |
| 4 | `src/components/HoverPreviewCard.tsx`（新）+ `MarkdownRenderer.tsx` | 卡片 + 悬停接线 | M |
| 5 | `src/App.tsx`、`src/App.css`、`docs/USER_GUIDE.md` | 状态、样式、文档 | S-M |

## 5. 验收标准（草案级）

- [ ] 契约测试：fragment 命中/未命中、600 截断、空文档、索引中状态；Rust 测试含路径越界拒绝。
- [ ] 组件测：400ms 前移开不请求；LRU 命中不重复 invoke；Esc/移开关闭；脚注预览不发 IPC。
- [ ] 运行时双端：wiki 链接、相对链接、PDF 链接（页数徽标）、脚注各验证一例；明/暗截图。
- [ ] 回归：链接点击导航与外链确认不回归；`pnpm test`、`tsc --noEmit`、`cargo test`、`cargo clippy`。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| HP-D1 | 预览内容形态 | **纯文本摘录**（零执行面、成本低） | 受限 Markdown 子集渲染（嵌套渲染管线，攻击面与维护成本大，否） |
| HP-D2 | 桌面数据源 | **`search_segments`**（已有派生全文，免重读磁盘/重转换） | 每次 `read_document` 原文（PDF/EPUB 要走转换，重） |
| HP-D3 | fragment→章节定位 | **content 内检索标题行，尽力而为** | 建标题偏移索引（新派生数据，收益小） |
| HP-D4 | 触发延迟 | **hover 400ms / focus 600ms** | 即时触发（闪烁打扰）；modifier+hover（发现性差） |

## 7. 风险

- markdown 整篇一个 segment：fragment 定位靠文本检索标题行，同名标题或 setext 变体可能定位偏差——尽力而为语义写入 USER_GUIDE，不承诺精确。
- 索引未就绪 / `indexStatus: failed` 的文档预览为空态：与库搜索同款限制，卡片显示状态文案即可。
- 悬停预览与悬停即将出现的其他浮层（标注气泡）在链接落于 mark 内时可能竞争：预览计时器在任何浮层 open 时挂起，定稿时补交互矩阵。

## 8. 定稿补记（2026-08-13 复核）

基线复核结论：§1 的全部事实仍成立（`documentLinks.ts` 的 `resolveLibraryPath` L102-125、`MarkdownRenderer.tsx` 的 `<a>` 分支 L378-400、`search_segments` schema L1205-1219、`validate_relative_library_path` L1690、`ensure_document_in_open_library` L1724、`webLibrary.loadSearchIndex` L429-434；行号以当日 HEAD `5bc756b` 为准）。落定与修正如下：

| # | 决策 | 结论 |
|---|------|------|
| HP-D1..D4 | 均按推荐执行 | 纯文本摘录 / `search_segments` / 标题行检索尽力而为 / hover 400ms + focus 600ms |
| HP-D5（新） | `[[wiki]]` 的悬停面 | **草案假设 wiki 在正文渲染为 `<a>`，与事实不符**：阅读面对 `[[wiki]]` 按纯文本渲染（双链只在侧栏「链接」tab 物化为可点行）。定稿不为预览改变链接渲染语义；wiki 的悬停预览落在侧栏「链接」tab 的出链/反链行上（同一张卡、同一数据源），正文悬停只覆盖真实存在的相对路径 `<a>` 链接与脚注引用 |
| HP-D6（新） | fragment→标题匹配规则 | 仅匹配 ATX 标题（`#{1,6} `），按「标题文本不区分大小写直等 ∨ slug 近似（小写、空格→`-`、去非字母数字标点）」双通道；setext 标题不匹配（尽力而为，落回文档开头） |
| HP-D7（新） | 契约孪生 | `buildPreviewExcerpt(content, fragment?)` 的 TS 实现在 `src/lib/previewExcerpt.ts`，Rust 孪生 `build_preview_excerpt` 在 `library.rs`；两端共用编号用例表 PE01..（documentLinks L01.. 惯例） |
| HP-D8（新） | 卡片挂载面 | 仅主栏（副栏是纯净参考面，不挂）；触屏 `(hover: hover)` 媒体查询守卫；其他浮层（选区工具条/标注气泡/相关段落/金句卡/命令面板/笔记编辑/重定位条）open 时预览挂起 |
| HP-D9（新） | DTO | `read_document_preview(relative_path, fragment?) → { title, format, excerpt, pdfPages, indexStatus }`；`indexStatus` 直接取自当前扫描集的 `DocumentInfo`，excerpt 空 + pending/indexing 时前端显示「索引中…」 |
