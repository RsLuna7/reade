# 方案草案：竖排模式（实验档）

- 日期：2026-08-13（基线查证日）
- 状态：**已定稿（见 §8 定稿记录；实施范围以 §8 为准，§3.4 草案矩阵已被 §8 矩阵取代）**
- 定位：面向古文/诗词的每文档竖排开关：正文 `writing-mode: vertical-rl`，滚动轴变横向（从右往左读）；代码块/公式/表格保持横排孤岛。明确标注为**实验档**，默认仅 Markdown/EPUB。
- 关联：与阅读设置面板（字号/行高等）同面板但独立为"实验"分组；与标注/目录跟随/朗读高亮的适配范围必须白纸黑字（见 §3.4 适配矩阵——这是本方案的核心交付物之一）。

> 一句话：`.article-shell[data-writing="vertical"]` 切 `writing-mode: vertical-rl` + 滚动容器横向化，逐文档开关存 localStorage 映射；代码/公式/表格/图片包 `writing-mode: horizontal-tb` 孤岛；标注 mark 与 TTS 高亮天然随文字流转向（inline 语义），但选区工具条/气泡定位、目录跟随、阅读位置与进度四处坐标逻辑需要"横向轴"分支。

---

## 1. 现状基线（已核实于 2026-08-13，行号允许漂移）

| 事实 | 位置 |
|------|------|
| 正文滚动：`.reading-scroll { overflow: auto }` 纵向；阅读进度、位置持久化全部基于 `scrollTop/scrollHeight` | `src/App.css` L1067-1083；`src/App.tsx` L3396-3414 |
| `ReadingPosition.scroll` 形状：`scrollRatio/maxScrollRatio`——**比例语义可轴向无关复用**，但采样代码读的是纵向属性 | `src/lib/readingPositions.ts` L20-40 |
| 标注 mark 是 inline `<mark>` 包裹（`wrapRangeWithMark`），CSS 四色高亮/下划线——inline 装饰在竖排下由浏览器自动转向（`text-decoration` 沿字流） | `src/lib/annotations.ts` L415-462；`src/App.css` L2618-2632 |
| 选区工具条/编辑气泡用 fixed 坐标（选区 rect 派生 x/y）——竖排下 rect 语义不变（视口坐标），定位逻辑**理论上免改**，但贴边 clamp 的"上下"偏好要换轴 | `src/components/AnnotationUi.tsx` L30-48、L172-216 |
| 目录跟随：标题 `data-heading-level` 元素 + 滚动参考线（纵向 offsetTop 比较）——竖排需改为横向 offsetLeft（RTL 方向） | `src/components/MarkdownRenderer.tsx` L50-56 |
| TTS 高亮：CSS Custom Highlight，无 DOM 定位——**免改**；滚动跟随 `reader.scrollTo` 需轴向分支 | `src/lib/sentenceHighlight.ts` L65-76；`src/lib/useReadAloud.ts` L354-366 |
| 代码块横向滚动 `.markdown-body pre { overflow: auto }`、KaTeX `.katex-display { overflow-x: auto }`、EPUB 表格有 `.epub-table-scroll` 包裹 | `src/App.css` L1578-1583、L1655-1658 |
| PDF：canvas 版式固定，**竖排不适用**（默认排除）；mdx 按普通 Markdown 处理可纳入 | `src/components/PdfReader.tsx` L503-519 |
| 阅读设置 persist 模式（本开关为**每文档**记忆，走独立 localStorage 键，参照 readingPositions 的按库分组模式） | `src/lib/readingPositions.ts` L4-5 |
| TS target ES2020、WebView2（Chromium）为桌面运行时——`writing-mode/vertical-rl` 支持完备 | `tsconfig.json` L3 |

## 2. 目标与非目标

**目标**

1. 阅读工具区（Markdown/EPUB 文档）出现"竖排（实验）"开关；开启后正文 vertical-rl、水平滚动（初始停靠最右）、鼠标滚轮映射为横向滚动。
2. 横排孤岛：`pre`、`.markdown-code-block`、`.katex-display`、`table`（含 `.epub-table-scroll`）、`img/figure`、Mermaid 容器保持 horizontal-tb + 内部滚动，占位为竖排流中的"横块"。
3. 每文档记忆（localStorage 按库分组映射，上限与淘汰沿 readingPositions 模式）。
4. 适配矩阵内功能（§3.4 标 ✅ 的）在竖排下正确工作；标 ⛔ 的功能在竖排开启时显式禁用并提示，而不是静默坏掉。

**非目标（明确不做）**

- 不做 PDF 竖排（版式由 canvas 决定）；mdx 默认也不启用（实验面收窄）。
- 不做竖排分页/翻页模式（仍是连续滚动，只是换轴）。
- 不调整标点全角化/纵中横（`text-combine-upright` 数字处理留远期，首版接受数字侧倒）。
- 不为竖排单独设计新主题/字体（沿用现有 serif 预设即可）。

## 3. 设计

### 3.1 布局切换

- `.article-shell[data-writing="vertical"]`：`writing-mode: vertical-rl`；滚动容器 `overflow-x: auto; overflow-y: hidden`；`contentWidth` 设置在竖排下语义转为"列高"（映射到 `max-height`）。
- 打开/切换文档时若该文档记忆为竖排：初始 `scrollLeft = scrollWidth`（vertical-rl 起点在右）。
- 滚轮：`wheel` 事件 deltaY→scrollLeft（负向），仅竖排时启用；触控板横向手势天然可用。

### 3.2 横排孤岛

- 统一 class `.horizontal-island { writing-mode: horizontal-tb; max-width: ...; }` 施加于代码/公式/表格/图/Mermaid 容器；孤岛在竖排流中表现为一个固定宽块，内部滚动行为不变。

### 3.3 每文档记忆

- `src/lib/verticalWriting.ts`：`readVerticalPreference(library, path)` / `writeVerticalPreference`，localStorage 键 `reade-vertical-writing`，按库分组、条目上限 200 LRU（照抄 readingPositions 治理形状）。

### 3.4 适配矩阵（核心交付，进 USER_GUIDE）

| 功能 | 竖排下状态 | 处理 |
|---|---|---|
| 标注 mark 渲染/点击 | ✅ inline 自动转向 | 回归测试覆盖 |
| 选区工具条/气泡 | ✅ 视口 rect 定位不变 | clamp 轴向微调 |
| 阅读位置/进度 | ✅ 换轴采样 | `scrollLeft` 版采样函数（ratio 语义：右起为 0） |
| 目录跟随/跳转 | ✅ 换轴参考线 | offsetLeft + RTL 比较 |
| TTS 播放+高亮 | ✅ | 滚动跟随换轴 |
| 库内搜索跳转（hash 定位） | ✅ | scrollIntoView 由浏览器处理 |
| 聚焦模式（若已落地） | ⛔ 首版禁用 | spotlight 参考线/标尺全是纵向假设 |
| 分屏 SecondaryPane | ⛔ 次窗格不支持竖排 | 主窗格开关不影响次窗格 |
| 打印/导出类 | 不受影响（无此功能） | — |

## 4. 改动清单（预估）

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/verticalWriting.ts`（新）+ 测试 | 每文档记忆 | S |
| 2 | `src/App.css` | vertical 布局 + 孤岛 + 明暗验证 | M |
| 3 | `src/App.tsx` | 开关 UI、滚轮映射、位置/进度/目录跟随换轴分支 | **L** |
| 4 | `src/components/EpubReader.tsx` | 章节跟踪换轴 | M |
| 5 | `docs/USER_GUIDE.md` | 实验档说明 + 适配矩阵 | S |

## 5. 验收标准（草案级）

- [ ] 每文档记忆单测（分组/LRU/坏数据）。
- [ ] 运行时：诗词样章竖排右起、滚轮横滚、代码/公式/表格孤岛正确；标注四动作全流程；目录点击与跟随；TTS 播放高亮+跟随；关闭开关完全恢复。
- [ ] 阅读位置：竖排下关闭再打开落回原位；竖排↔横排切换位置比例近似保持。
- [ ] 明/暗 × 宽/窄截图 ≥6 张（含孤岛特写）；全套回归（横排路径零回归是硬门槛）。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| VW-D1 | 作用粒度 | **每文档开关**（古文只是库的一角） | 全局开关（切换成本高、误伤）；front-matter 声明（引入文档驱动行为，接近执行语义，否） |
| VW-D2 | 位置采样 | **换轴复用 `scroll` 形状（ratio 语义右起）** | 新增 `verticalScroll` kind（持久化 schema 膨胀，否） |
| VW-D3 | 聚焦/分屏等纵向假设功能 | **竖排时显式禁用** | 逐一适配（首版成本失控，实验档不值） |
| VW-D4 | 数字纵中横 | **首版不做**（接受侧倒） | `text-combine-upright: digits 2`（局部适配再评） |

## 7. 风险

- **成本远超一般草案**：App.tsx 的滚动采样、目录跟随、TTS 跟随、恢复位置四处都有纵向轴假设，换轴分支侵入面大且回归风险高——这是 21 案中实施成本最高的之一，建议排期靠后并以"横排零回归"为第一验收门槛。
- WebView2 对 vertical-rl 的成熟度整体良好，但 `scrollLeft` 在 RTL 滚动容器中的取值符号存在浏览器史遗差异：实施前先写探针测试锚定 WebView2/Chromium 行为。
- 标注 rect 类 locator（PDF）不涉及；但 markdown 偏移 locator 在竖排/横排间完全同构（文本偏移与视觉无关）——此点是方案可行的关键支撑，已核实 mark 管线基于文本偏移而非坐标。
- 实验档心智：UI 明确标"实验"，出现问题的第一响应是"关掉开关一切恢复"，不承诺与全部功能组合兼容。

## 8. 定稿记录（2026-08-13，实施前复核）

用户已拍板：保留实验档，**允许诚实收窄——宁可范围小而稳，不要半坏的全支持**。据此把草案 §3.4 里三处"换轴适配"（阅读位置采样、目录跟随参考线、TTS 跟随滚动）降级为**显式禁用**：这三处都深嵌在 `App.tsx` 的滚动热路径（rAF 采样管道、标题参考线扫描、朗读跟随），换轴分支的侵入面与回归风险（草案 §7 自己标注"21 案中实施成本最高之一"）与实验档的价值不成比例。跳转类（目录点击、锚点、标注/书签/搜索/重读跳转）保留支持——它们走集中式 scroll 工具函数，一处加轴分支全部受益。

拍板与实施决策：

| # | 决策 | 定稿 |
|---|------|------|
| VW-D1 | 作用粒度 | 每文档开关（按草案）；开关落在阅读设置面板"竖排模式（实验）"分组，仅 `format === "markdown" || "epub"` 可用（mdx/PDF 置灰并提示）。记忆存 `reade-vertical-writing`（按库分组、200 条 LRU、坏数据静默丢弃，照抄 readingPositions 治理形状；只存开启项，缺席即横排） |
| VW-D2 | 阅读位置 | **收窄为竖排下暂停**（偏离草案"换轴复用"）：不采样、不恢复；横排存值原样保留，退出竖排立即恢复生效。理由：RTL 滚动容器 `scrollLeft` 符号存在浏览器史遗差异（草案 §7），把它写进持久化数据会让坏值跨会话传播。阅读进度条保留（只读展示，`|scrollLeft|/range` 换轴） |
| VW-D3 | 纵向假设功能 | 竖排激活时显式禁用：聚焦模式三开关（含打字机滚动；走既有 `focusUnavailableReason` 置灰通道）、文档地图刻度层（不渲染不测量）、朗读**自动跟随滚动**（播放与句级高亮保留）、目录**跟随高亮**（点击跳转保留）、阅读位置记忆、读完接着读（高水位在竖排下不推进，自然不触发，列入矩阵如实告知）。禁用清单集中写在开关的设置提示里 |
| VW-D4 | 数字纵中横 | 不做（按草案，接受数字侧倒） |
| VW-D5（新） | 滚动轴分支落点 | `writing-mode: vertical-rl` 加在滚动容器 `.reading-scroll[data-writing="vertical"]` 上（而非 article-shell）：滚动坐标系随之翻转，`scrollLeft = 0` 即右缘阅读起点，打开文档天然落在开头。`src/lib/scroll.ts` 的 `scrollElementWithinContainer`/`scrollContainerByRatio` 按 `container.dataset.writing === "vertical"` 走 `scrollIntoView({ block: "start" })` / `scrollLeft = -(max·ratio)` 分支——目录点击、文内锚点、标注/书签/搜索/增量重读跳转一处受益 |
| VW-D6（新） | 分栏 | 主栏竖排允许；副栏（SecondaryPane）恒横排不受影响（按草案 ⛔ 行收窄陈述） |
| VW-D7（新） | contentWidth | 竖排下"内容宽度"设置不生效（列高恒为视口高，`max-width` 解除）；字号/行高/段距语义自洽（行进方向随字流转向） |

### 定稿适配矩阵（进 USER_GUIDE）

| 功能 | 竖排下状态 |
|---|---|
| 标注 mark 渲染/点击/编辑气泡、选区工具条四动作 | ✅ inline 装饰与视口坐标天然转向 |
| 目录点击跳转、文内锚点、搜索/标注/书签跳转 | ✅ 走 VW-D5 轴分支 |
| TTS 播放 + 句级高亮 | ✅（自动跟随滚动除外） |
| 增量重读横幅/边缘标记/下一处 | ✅ 跳转走 VW-D5 |
| 阅读进度条 | ✅ 换轴只读展示 |
| 分栏对照 | ✅ 主栏竖排、副栏恒横排 |
| 聚焦模式（段落聚焦/打字机/标尺） | ⛔ 置灰并提示 |
| 文档地图刻度层 | ⛔ 竖排时不渲染 |
| 朗读自动跟随滚动 | ⛔ 播放保留、跟随暂停 |
| 目录跟随高亮 | ⛔ 点击跳转保留 |
| 阅读位置记忆 | ⛔ 暂停采样与恢复；横排存值保留 |
| 读完接着读 | ⛔ 竖排下不触发 |
| PDF / mdx | ⛔ 开关置灰 |

已知边界（如实标注）：横排孤岛（代码块/公式/表格/Mermaid）为正交流（orthogonal flow）排版，Chromium 支持完备但极端宽表格在竖排流中占位较大，孤岛内部滚动保留；标题栏（article-header）随正文竖排，属实验档观感的一部分。退出竖排移除 `data-writing` 后所有覆盖样式与禁用项立即恢复。

实施后补记（2026-08-13 视觉验收）：headless Chromium 151 截图中观察到孤岛/含 KaTeX 内容在越过滚动口左缘时 paint 不被裁剪（渗到侧栏上方）；hit-test、布局、滚动全部正确，且 `overflow`、`contain: paint`、`clip-path`、`transform`、`z-index: 9999` 遮挡全部无效——判定为 Chromium 合成器层级的已知类缺陷（或 headless 截图回读伪影），CSS 侧无解。未能在有头 WebView2 复核（验收时桌面被占用）。处置：按实验档心智如实记录，不阻塞功能；若真实桌面运行复现，第一响应是关闭开关（完全恢复），后续再评估孤岛降级方案。
