# 方案草案：书架视图 + 自动封面

- 日期：2026-08-13（基线查证日）
- 状态：**草案（实施前需复核基线行号并升级定稿）**
- 定位：文档树之外的第二种库浏览形态——"书架"网格：PDF 用首页缩略图、EPUB 提取封面图、Markdown 用标题哈希驱动的主题色渐变生成确定性封面；角标显示阅读进度。回答"我的库里都有什么书"这种视觉化浏览需求。
- 关联：PDF 缩略走 pdf.js 已有渲染管线（`docs/plan-pdf-*` 同源）；EPUB 封面走既有 `read_epub_asset` 安全栅格图片管线；进度角标数据 = `readingPositions` 高水位（与主页继续阅读、覆盖率地图同源）。

> 一句话：侧栏库 tab 增加"书架"切换；封面三来源——PDF 首页由前端 pdf.js 渲染小图并经新 command `store_document_thumbnail` 存缓存 sqlite 新表（派生数据，纳入既有 1 GiB 治理），EPUB 用清单中首个合法 raster 图片，Markdown 由 `hash(title) → 主题 token 渐变` 纯函数即时生成（不落盘）；网格 + 进度角标 + 懒加载。

---

## 1. 现状基线（已核实于 2026-08-13，行号允许漂移）

| 事实 | 位置 |
|------|------|
| 缓存 sqlite：`document_cache` / `search_segments` / `document_links` 三表，schema 版本 1，不匹配整库删除重建 | `src-tauri/src/library.rs` L1123-1193、L27、L1068-1083 |
| 1 GiB 软上限治理：`enforce_cache_soft_limit` 按 `last_accessed ASC` 淘汰**非当前书库**条目；淘汰单文档时逐表删除 | `src-tauri/src/library.rs` L28-29、L1513-1554、L1556-1585 |
| PDF 渲染 canvas：DPR 取 `min(devicePixelRatio, 2)`；首 2 页初始即渲染，其余 IntersectionObserver 懒渲染 | `src/components/PdfReader.tsx` L387-399、L317 |
| PDF 数据经 `readDocumentRange`（256KiB chunk、单次 ≤4MiB）+ 自定义 RangeTransport 喂 pdf.js——**书架场景渲染首页同样可走此通道** | `src/components/PdfReader.tsx` L21-22、L597-602 |
| EPUB 资源：`read_epub_asset` 校验 `allowed_epub_asset`（png/jpeg/gif/webp/avif 五类 raster），前端转 Blob objectURL | `src-tauri/src/library.rs` L561-589；`src-tauri/src/documents.rs` L811-816；`src/components/EpubReader.tsx` L107-110 |
| EPUB 文档 DTO：`EpubDocument { title, chapters, assets, notes }`——assets 清单可供封面挑选 | `src-tauri/src/documents.rs` L103-108 |
| 主题 token：`--paper/--ink/--accent` 等 CSS 变量，quoteCard 已有 `readCardTheme` 读取先例 | `src/lib/quoteCard.ts` L59-82 |
| 阅读进度：`listLibraryReadingPositions(libraryRoot)` 返回全库 path→position；`progressFromPosition` 折算 ratio/page | `src/lib/readingPositions.ts` L165-169；`src/lib/homeData.ts` L42-48 |
| 树行现状：`button.document-tree__item` + 格式徽标 class | `src/components/DocumentTree.tsx` L177-209 |
| Cargo 无 image 处理 crate（Rust 侧不能栅格化，只能存前端已渲染的 PNG bytes） | `src-tauri/Cargo.toml` L20-39 |

## 2. 目标与非目标

**目标**

1. 库 tab 顶部一个"树 / 书架"切换（persist 到阅读偏好），书架为响应式网格（每格：封面 + 标题 + 格式徽标 + 进度角标）。
2. PDF 封面：进入视口时渲染第 1 页 ~240×320 逻辑像素 PNG，存缓存 sqlite；二次进入直接读缓存。
3. EPUB 封面：assets 清单中挑首个合法 raster 图（优先文件名含 cover），走 `read_epub_asset`；无图回落到生成式封面。
4. Markdown/mdx 与所有回落场景：`hash(title)` → 两个主题 token 的确定性线性渐变 + 首字符大字，纯 CSS/SVG 即时生成，主题切换自动跟随。
5. Web 端：无 pdf.js Range 与 epub 资产通道，全部用生成式封面（同一纯函数），书架照常可用。

**非目标（明确不做）**

- 不做用户自定义封面（策展式；生成规则统一）。
- 不在 Rust 侧做任何图像解码/缩放（零新依赖红线；PNG bytes 由前端 canvas 产出，Rust 只存取）。
- 不为封面新增独立缓存文件（进既有 `reade-cache.sqlite3`，受既有治理）。
- 不做书架内拖拽排序/分组（排序沿树的 Collator 规则；分组走合集）。

## 3. 设计

### 3.1 缓存 schema（版本 1 → 2）

新表 `document_thumbnails(library_root, relative_path, source_size, source_modified, width, height, png BLOB, created_at, last_accessed, PRIMARY KEY(library_root, relative_path))`。

- `CACHE_SCHEMA_VERSION` 1→2：既有策略是不匹配整库删重建（缓存是 disposable，可接受，写入 changelog 提示首次启动重索引）。
- 失效：指纹（size+modified）不匹配即删行重生成；`clear_cached_document*` 与 1 GiB 治理的逐表删除加上本表。
- 单图预算：240×320@2x PNG 典型 20-80 KiB，万篇 PDF 库最坏 ~0.8 GiB——治理已覆盖，但"当前书库不淘汰"的现状意味着单库可超限（见风险）。

### 3.2 IPC 契约（两个新 command）

| command | wrapper | 说明 |
|---|---|---|
| `read_document_thumbnail(relative_path)` | `readDocumentThumbnail` | 命中返回 `{ png: base64, width, height }`，未命中 null；更新 last_accessed |
| `store_document_thumbnail(relative_path, png: Vec<u8>, width, height)` | `storeDocumentThumbnail` | 校验 PNG magic bytes + ≤512 KiB 上限；路径过既有校验 |

### 3.3 前端

- `BookshelfView` 组件：CSS grid `repeat(auto-fill, minmax(148px, 1fr))`；IntersectionObserver 懒加载封面（同 PdfReader/Mermaid 的 rootMargin 模式）；渲染队列串行（同一时间只解一个 PDF，防内存峰值）。
- PDF 首页渲染：复用 RangeTransport + `getDocument`，`page.render` 到离屏 canvas（宽 240 逻辑像素、DPR≤2），`canvas.toBlob("image/png")` → store command；组件卸载 abort。
- 生成式封面纯函数 `coverGradient(title): { from, to, angle }`：FNV-1a hash → 从 8 组预设 token 对（`--accent` 系 + `--paper-raised` 系）确定性取色；SVG 内联渲染。
- 进度角标：`progressFromPosition` → ratio 百分比或"N/M 页"，右下小徽标；未读不显示。

### 3.4 安全

- store 侧校验 PNG 魔数与大小上限，路径走 `validate_relative_library_path`；BLOB 不再被任何管线解析执行；`img` 用 `data:image/png;base64`（CSP `img-src data:` 已允许）。

## 4. 改动清单（预估）

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src-tauri/src/library.rs` + `lib.rs` | schema v2、两 command、治理接线、测试 | L |
| 2 | `src/lib/coverArt.ts`（新）+ 测试 | 哈希渐变纯函数 | S |
| 3 | `src/components/BookshelfView.tsx`（新） | 网格 + 懒加载 + 渲染队列 | L |
| 4 | `src/lib/backend.ts`、`src/App.tsx`、store | wrapper、视图切换、persist | M |
| 5 | `src/App.css`、`docs/USER_GUIDE.md` | 样式 + 文档 | S-M |

## 5. 验收标准（草案级）

- [ ] Rust 测试：thumbnail 存取、指纹失效、magic bytes 拒绝、512 KiB 拒绝、治理删除含新表。
- [ ] 前端测试：渐变确定性（同 title 同色）、进度角标折算、懒加载触发。
- [ ] 运行时：含 PDF/EPUB/MD 的库切书架，首屏 < 1s（封面渐进出现）；重进秒开（缓存命中）；明暗主题下生成式封面随主题变色。
- [ ] Web：`pnpm dev:web` 书架可用（全生成式封面）。
- [ ] 回归：全套测试 + `cargo clippy` + 双端 build。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| BC-D1 | PDF 缩略图生成方 | **前端 pdf.js 渲染、Rust 只存 BLOB**（零新 Rust 依赖） | Rust 侧栅格化（需引入渲染 crate，违背零依赖，否） |
| BC-D2 | 存储位置 | **缓存 sqlite 新表 + schema bump**（受既有治理与失效指纹） | 独立文件目录（需新一套治理与清理，否）；IndexedDB（桌面数据应归 Rust 层） |
| BC-D3 | EPUB 封面挑选 | **assets 中优先名含 cover 的合法 raster，否则首图，再否则生成式** | 解析 OPF `<meta name="cover">`（anydoc DTO 未暴露该字段，需动转换器，重） |
| BC-D4 | 书架入口 | **库 tab 内"树/书架"切换** | 独立 activeView（多一个全屏视图，导航复杂化） |

## 7. 风险

- **schema bump 即整库重建**：既有策略对 disposable 缓存可接受，但万篇库首开重索引耗时需在发布说明中写明；实施时确认另一 agent 是否也在动 schema，避免版本号冲突。
- **"当前书库不淘汰"** 意味着大 PDF 库的缩略图可使当前库缓存超 1 GiB 软上限：属既有治理语义，方案不改它，但在文档写明；必要时后续为 thumbnails 单独设子预算。
- 前端渲染队列在低端机上可能拖慢滚动：串行 + 懒加载 + abort 已是保守策略，验收带 200+ PDF 库实测。
- EPUB "首个 raster 即封面" 的启发式会挑错图（如出版社 logo）：接受为 MVP 语义，回落链路保证总有封面。
