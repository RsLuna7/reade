# 方案草案：库覆盖率知识地图（treemap）

- 日期：2026-08-13（基线查证日；同日复核基线并定稿）
- 状态：**定稿（批次 7 实施）**
- 定位：一张手写 squarified treemap 回答"这个库我读了多少、哪一块还荒着"：块面积 = 文档体量（字符数），颜色深浅 = 阅读覆盖率（`readingPositions` 高水位），点击块下钻文件夹 / 打开文档。
- 关联：覆盖率语义与目录覆盖线（`tocCoverage.ts`）、主页进度同源；色阶复用 `--stats-scale-*` 五档 token；体量数据与阅读时间预估方案（`docs/plan-reading-time-estimate.md`）共享同一"文档字符数"新契约。

> 一句话：新 command `list_document_extents() → [{ relativePath, chars }]` 从 `search_segments` 聚合 `SUM(LENGTH(content))`；前端纯函数 `squarify(nodes, rect)`（零依赖实现经典算法）把文件夹树布局成嵌套矩形，SVG 渲染、覆盖率上色，入口放阅读统计视图；Web 端用 `search.json` content 长度同构。

---

## 0. 定稿补记（实施前复核结论，2026-08-13）

1. **不再新建 command**：批次 2 阅读时间预估已落地 `list_document_extents`
   （`DocumentExtent = { relativePath, charCount, segmentCount,
   needsOcrSegments }`，TE-D6 明确与本方案共享契约），本批直接复用；
   §3.1 的"新 command"描述作废。`LENGTH()` 的 TEXT 字符数语义已由批次 2
   的 Rust 测试锚定。
2. 覆盖率折算复用批次 2 的 `highWaterCoverage(position, segmentCount)`
   纯函数（scroll 取 maxScrollRatio，PDF 取 maxPage ÷ segmentCount），
   不再另写一份。
3. 渲染定稿为 **SVG**（CT-D2 推荐项）；入口定稿为**阅读统计视图新增
   "知识地图"区块**（CT-D3：本期 Web 不提供）；上色定稿为
   `calendarLevel(coverage, 1)` 映射 `--stats-scale-0..4` 五档（CT-D4）。
4. 知识地图区块不依赖阅读会话数据：统计视图无会话记录时该区块照常渲染
   （覆盖率来自 readingPositions 与 extents，与会话无关）。

## 1. 现状基线（已核实于 2026-08-13，行号允许漂移）

| 事实 | 位置 |
|------|------|
| `DocumentInfo` 只有 `size/modified/format` 等，**无字数/字符数字段**——面积数据必须新取 | `src-tauri/src/library.rs` L76-84 |
| 全文派生数据在 `search_segments.content`（markdown 整篇 / PDF 每页 / EPUB 每章），可 `SUM(LENGTH(content))` 聚合 | `src-tauri/src/library.rs` L1136-1148 |
| 覆盖率数据源：`readingPositions` 高水位 `maxScrollRatio` / `maxPage`，`listLibraryReadingPositions(libraryRoot)` 一次取全库 | `src/lib/readingPositions.ts` L20-40、L165-169 |
| 覆盖判定先例：`coverageFromRatios(ratios, maxScrollRatio)`（标题 ratio ≤ 高水位即 reached） | `src/lib/tocCoverage.ts` L72-84 |
| 五档色阶 token `--stats-scale-0..4` 已被统计热力与 TOC 热力共用；`calendarLevel(value, max)` 分档纯函数 | `src/components/StatsView.tsx` L89-95；`src/lib/readingStats.ts` L276-279 |
| 树构建纯函数 `buildDocumentTree(documents)`，目录优先 + zh-CN Collator 排序 | `src/lib/tree.ts` L56、L40-47 |
| 统计视图为桌面专属（`!IS_WEB_RUNTIME && activeView === "stats"`）——**入口若放 stats 则 Web 缺席**（见决策点） | `src/App.tsx` L1239-1242 |
| Web 全文可得：`search.json` 每篇含 `content`，`WEB_LINKS_MAX_DOCUMENTS = 500` 的规模上限先例 | `src/lib/webLibrary.ts` L43-52；`src/lib/documentLinks.ts` L29 |
| recharts 已是依赖但无 treemap 需求覆盖（且 treemap 组件定制性差）——手写更可控 | `package.json` L18-37 |

## 2. 目标与非目标

**目标**

1. 一屏 treemap：一级块 = 顶层文件夹（含根散档聚合块），面积 ∝ 字符数合计；块内色深 = 覆盖率加权均值（0 档=未读、4 档=基本读完）。
2. 点击文件夹块 → 下钻该层重新布局（面包屑返回）；点击文档块 → `selectDocument` 打开。
3. hover/焦点显示 tooltip：名称、字符数、覆盖率百分比、内含文档数。
4. `squarify` 为确定性纯函数（同输入同布局），有单测锚定长宽比目标。

**非目标（明确不做）**

- 不引入任何 treemap/可视化库（手写 squarified，算法 ~80 行）。
- 不做时间维度动画（"覆盖率随月份变化"留远期）。
- 不把字符数写进 manifest/DocumentInfo 等既有契约（独立新 command，避免动高风险 IPC 形状）。
- 索引未就绪的文档按 size 字节数近似兜底，不阻塞渲染。

## 3. 设计

### 3.1 数据

- 新 command `list_document_extents() → Vec<{ relative_path, chars: u64, coverage_hint: Option<f64> 不含 }>`：单条 SQL `SELECT relative_path, SUM(LENGTH(content)) FROM search_segments WHERE library_root = ? GROUP BY relative_path`；LENGTH 对 UTF-8 是字节数，除以经验系数或改 `SUM(LENGTH(CAST(content AS TEXT)))`——**实施时确认 sqlite LENGTH 文本语义（对 TEXT 返回字符数）即可直接用**。
- 覆盖率：scroll 类 `maxScrollRatio`；pdf 类 `maxPage / 总页数`（总页数由该文档 segment 计数返回，command 一并给出 `segments` 字段）；无 position 记 0。
- 聚合纯函数 `buildCoverageTree(documents, extents, positions)`：套 `buildDocumentTree` 的层级，文件夹字符数 = 子项和，覆盖率 = 按字符数加权平均。

### 3.2 布局与渲染

- `squarify(children, rect): PlacedRect[]`（`src/lib/treemap.ts` 新建）：经典 Bruls squarified 算法，按面积降序放置、行内长宽比最优化；输出归一化坐标。
- 渲染：SVG（一层 `<g>` 一级块 + hover 态），块 `fill: var(--stats-scale-N)`，标签超宽省略；`motionLevel` full 时下钻做 240ms 过渡（runMotion 语义），off 无动画。
- 规模：万篇库一级视图只渲染当前层（顶层文件夹通常 <100 块），块数封顶 400，余量聚为"其他"块。

### 3.3 入口与双端

- 入口：阅读统计视图新增"知识地图"区块（桌面）；Web 版无统计视图，本期 Web 不提供（见 CT-D3）。
- 数据请求在进入 stats 时懒加载一次，`refresh_library` 后失效重取。

## 4. 改动清单（预估）

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/treemap.ts`（新）+ 测试 | squarify + buildCoverageTree | M |
| 2 | `src-tauri/src/library.rs` + `lib.rs` | `list_document_extents` + 测试 | S-M |
| 3 | `src/lib/backend.ts` | wrapper | S |
| 4 | `src/components/CoverageTreemap.tsx`（新）+ StatsView 接线 | SVG 渲染、下钻、tooltip | M-L |
| 5 | `src/App.css`、`docs/USER_GUIDE.md` | 样式 + 文档 | S |

## 5. 验收标准（草案级）

- [ ] `squarify` 单测：面积守恒、确定性、长宽比不劣于 naive slice-and-dice（记录数值）、单块/空输入边界。
- [ ] `buildCoverageTree`：加权覆盖率、pdf 页折算、无 position 记 0、"其他"聚合。
- [ ] Rust 测试：extents 聚合正确、按 library_root 隔离。
- [ ] 运行时：demo-library 地图渲染正确；读过的文档块明显更深；点击文档块打开原文；万篇合成库首帧 < 500ms。
- [ ] 明/暗主题截图；全套回归测试。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| CT-D1 | 面积指标 | **字符数（search_segments 聚合）**，索引未就绪回退 size 字节 | 纯 size 字节（PDF 二进制体积严重失真，否） |
| CT-D2 | 渲染技术 | **SVG**（事件/无障碍/主题变量都顺） | canvas（自绘 hover/焦点/文本，成本高） |
| CT-D3 | Web 端 | **本期不提供**（统计视图本就桌面专属；Web 位置数据也少） | Web 用 search.json content 长度做轻量版（需要新入口位，留远期） |
| CT-D4 | 覆盖率上色 | **calendarLevel 五档离散色**（与全产品热力语义一致） | 连续插值色（与既有色阶体系不一致，否） |

## 7. 风险

- **覆盖率≠真读过**：滚动高水位只证明"滚过"，方案文案用"到达率"级措辞，不承诺理解度。
- markdown 整篇 segment 使字符数受代码块/front-matter 干扰：与搜索索引同源同偏差，接受。
- treemap 在层级深且块极碎时可读性差："其他"聚合 + 下钻缓解；截图验收含 500+ 文档库。
- `LENGTH()` 语义（TEXT 为字符数、BLOB 为字节数）实施时必须用测试锚定，防止面积单位错一个量级。
