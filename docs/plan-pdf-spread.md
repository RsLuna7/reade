# 方案定稿：PDF 双页对开

- 日期：2026-08-13（基线查证日）；定稿：2026-08-13（基线 `bdb940c` 复核）
- 状态：**定稿**
- 定位：原版式 PDF 在宽窗口可切换"双页并排"如摊开的书——读扫描版书籍、论文对照图文时一屏两页。页码/缩放/适宽语义与单页同步；窄窗自动回落单页。
- 关联：完全在 `PdfReader.tsx` 原版式渲染管线内演进（懒渲染、DPR、RangeTransport 均复用）；断点纪律沿 `App.css` 既有响应式体系；与 PDF 区域引用卡片（`docs/plan-pdf-region-card.md`）正交。

> 一句话：`.pdf-pages[data-spread]` 切成两列 grid（每行一对 `2k / 2k+1` 页，封面第 1 页单独居右），`--pdf-page-width` 语义变为"单页宽 = (容器宽-页间距)/2"；适宽计算、当前页判定（`selectCurrentPdfPage`）、`jump` 按"对"滚动各加 spread 分支；窗口 < 1180px 或页原生宽过大时自动回单页；开关状态每文档会话级记忆。

---

## 1. 现状基线（已核实于 2026-08-13，行号允许漂移）

| 事实 | 位置 |
|------|------|
| 页容器：`.pdf-pages` 纵向 flex、gap 22px；每页 `section.pdf-page`，宽 `min(var(--pdf-page-width), 100%)`，aspectRatio 占位 | `src/App.css` L1228-1231；`src/components/PdfReader.tsx` L503-519 |
| 页宽驱动：容器 `--pdf-page-width = round(nativePageWidth × scale)`；单页渲染时 host 再 inline 同步 | `src/components/PdfReader.tsx` L983、L374 |
| 缩放：`scale` state 0.5–3、按钮 ±0.1；适宽 `= (reader.clientWidth - 18) / nativeWidth` | `src/components/PdfReader.tsx` L566-567、L974-977、L714-723 |
| 懒渲染：前 2 页立即、其余 IntersectionObserver（rootMargin 1200px）；远页仅骨架 | `src/components/PdfReader.tsx` L23、L317、L511-516 |
| 当前页判定：`selectCurrentPdfPage` 按 referenceLine（toolbar 底+8px）与页块距离取最近 | `src/components/PdfReader.tsx` L158-175、L260-264 |
| 跳页：统一 `jump(page)`（滚动到页块）；`PdfReaderHandle` 无 goToPage，外部经 restorePosition/locator | `src/components/PdfReader.tsx` L684-700、L200-205 |
| DPR：`min(devicePixelRatio, 2)` 位图渲染 | `src/components/PdfReader.tsx` L387-399 |
| 文本层 `--total-scale-factor` 每页 ResizeObserver 自适应——双页下每页 host 独立计算，机制不变 | `src/components/PdfReader.tsx` L322-328 |
| 既有断点：CSS 侧 1180 / 820 / 640（App.css 无 1080）；分屏另有 JS 侧 `SPLIT_MIN_WINDOW_WIDTH = 1080` 先例 | `src/App.css` L3875-4086；`src/lib/splitView.ts` L40-44 |
| 阅读位置：`pdf { page, offsetRatio, maxPage }`——按页语义，双页模式无需改持久化形状 | `src/lib/readingPositions.ts` L20-40 |
| PDF 标注 locator 含 page + normalized rects——rect 相对单页坐标，双页布局不影响锚定 | `src/lib/annotationCapture.ts` L73-113 |

## 2. 目标与非目标

**目标**

1. 原版式工具栏新增"双页"切换钮（窄窗自动禁用）；开启后每行并排两页：第 1 页单独成行居中（书籍封面语义），此后 (2,3)、(4,5) 配对。
2. 语义同步：页码框/上一页/下一页按**对**移动（当前页仍精确到单页号）；缩放按钮作用于单页宽；"适宽"= 两页 + 间距恰好填满容器。
3. 自动回落：容器宽 < 1180px，或双页所需单页宽 < 320px（不可读阈值）时回单页并禁用按钮（状态保留，恢复宽窗自动回来）。
4. 懒渲染/DPR/文本层/标注 rect 全部照常工作。

**非目标（明确不做）**

- 不做 RTL 书籍的右→左配对（个人库以中文横排 PDF 为主，留远期）。
- 不做"封面是否独立成行"的可配置（固定第 1 页独立，符合绝大多数书籍装订语义）。
- 不做跨页拼合渲染（两页仍是独立 canvas/文本层，只是布局并排）。
- 不改 `ReadingPosition.pdf` 持久化形状；不做双页状态持久化（会话级记忆，见 PS-D3）。

## 3. 设计

### 3.1 布局

- `.pdf-pages[data-spread="true"]`：`display: grid; grid-template-columns: repeat(2, min(var(--pdf-page-width), calc(50% - 11px)))`; justify-content center；第 1 页 `grid-column: 2 / 3`（居右如书籍首页）或单行居中（实施时视觉定稿）。
- `--pdf-page-width` 在 spread 下由适宽逻辑给出 `(clientWidth - 18 - 22) / 2 / nativeWidth` 的 scale；手动缩放仍是同一 scale 语义（两页同宽）。

### 3.2 逻辑分支

- `spread: boolean` state；`fitWidth()`、翻页步长（±2，首页边界 ±1）、`selectCurrentPdfPage`（reference 距离最近的页仍是单页号，无需改——grid 中每页仍是独立 section）三处加分支。
- `jump(page)`：目标页所在行滚动到 referenceLine（同现逻辑，页块定位即行定位）。
- 回落监测：既有 reader ResizeObserver 中判定容器宽与单页可读宽，越界时 `setSpread(false)` 但保留"用户意图"标志，恢复时自动重开。
- 会话级记忆：module 级 `Map<relativePath, boolean>`（同 SecondaryPane 的 scrollMemory 模式）。

### 3.3 性能

- 双页使同屏渲染页数翻倍：IntersectionObserver rootMargin 从 1200px 降到 800px（spread 时），维持在渲染页数 ≤6 的预算；DPR 上限 2 不变。

## 4. 改动清单（预估）

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/components/PdfReader.tsx` | spread state、适宽/翻页/回落分支、按钮 | M-L |
| 2 | `src/App.css` | grid 布局 + 断点 | S-M |
| 3 | `src/lib/`（可选） | `spreadLayout.ts` 纯函数（配对/适宽计算）便于测试 | S |
| 4 | `docs/USER_GUIDE.md` | 说明 | S |

## 5. 验收标准（草案级）

- [ ] 纯函数测试：页配对（首页独立）、适宽 scale 计算、回落阈值。
- [ ] 运行时：书籍型 PDF 开双页——封面独立、(2,3) 并排、页码/翻页/适宽/缩放语义正确；跳转 locator（搜索命中第 7 页）落到正确行；标注在双页下创建与回显正确（rect 锚定）。
- [ ] 窗口从 1440 拖窄到 1000：自动回单页；拖回：自动恢复双页。
- [ ] 渲染预算：spread 下同屏 canvas ≤6（devtools 佐证）；滚动无明显掉帧。
- [ ] 明/暗截图；阅读模式与单页路径零回归；全套测试。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| PS-D1 | 宽窗断点 | **1180px**（与 CSS 全局断点体系对齐） | 1080px（有 `SPLIT_MIN_WINDOW_WIDTH = 1080` 的 JS 侧先例，若希望"双页与分屏同门槛"可选此值——需定稿时拍板） |
| PS-D2 | 配对方式 | **第 1 页独立，(2k,2k+1) 配对**（装订语义） | (1,2)(3,4) 配对（书籍跨页图会被拆错对） |
| PS-D3 | 状态记忆 | **每文档会话级**（同 scrollMemory 模式） | persist（宽度环境相关的状态持久化易产生"打开就被回落"的困惑） |
| PS-D4 | 翻页步长 | **双页下 ±2（边界 ±1），页码框输入仍单页号** | 页码也改"对"编号（与 locator/标注页号语义冲突，否） |

## 6.1 定稿落点（基线 `bdb940c` 复核后）

- **PS-D1 拍板**：双页可用性 = 窗口宽 ≥ **1180px**（与 CSS 全局断点体系对齐）**且** reader 容器宽 ≥ 680px（= 2 × 320px 可读单页 + 22px 列距 + 18px 滚道余量）。草案的"容器宽 < 1180px"字面上不可行——三栏布局下窗口 1440 时容器仅约 940px，若按容器 1180 判定，双页在草案自己的验收场景（窗口 1440 开双页）都无法启用；改为窗口 + 容器双条件后，验收场景"1440 → 1000 → 1440"语义不变。容器监测用 ResizeObserver + window resize 双通道。
- PS-D2 按推荐：第 1 页独立占**右列**（`grid-column: 2`，装订语义：封面是右页）；(2k, 2k+1) 配对，偶数页左列贴中缝、奇数页右列贴中缝；单页文档整行居中。
- PS-D3 按推荐：会话级 module `Map<relativePath, boolean>` 记忆用户意图；窄窗自动回单页（intent 保留），恢复宽窗自动回来。
- PS-D4 按推荐：上一页/下一页按对移动（±2，首页边界 ±1），页码框仍输入/显示单页号；`jump`、`selectCurrentPdfPage`、locator 语义零改动（grid 中每页仍是独立 section）。
- 适宽：spread 下 scale = (容器宽 − 18 − 22) / 2 / 原生页宽；**切换双页/单页时自动重跑适宽**（fitWidth 依赖 spreadActive，既有"加载即适宽"effect 顺带覆盖切换时机），手动缩放在切换后需要重新调整——记录为已知取舍。
- 懒渲染：spread 时 IntersectionObserver rootMargin 从 1200px 收到 800px（渲染页数预算 ≤6），margin 经 prop 传入 PdfPage。
- 切换保位：沿 switchMode 模式（capturePosition → pendingPositionRef → 既有恢复 effect 增加 spreadActive 依赖）。
- 纯函数进 `src/lib/pdfSpread.ts`：配对/步长/适宽/可用性判定，全部单测锚定。
- 视觉验收现实约束：浏览器无 Tauri IPC，真实 PDF 渲染无法在 Web 端复现——布局用单测 + 静态 stub 页面容器截图佐证；真实 PDF 对开端到端体验列入桌面真机待验收。

## 7. 风险

- `selectCurrentPdfPage` 在并排两页距参考线等距时的取舍会影响页码显示抖动：取左页（阅读顺序在前）并加 8px 滞后，实施时以既有函数的测试形态锚定。
- 横向页（宽>高的 PDF）双页并排后单页过小：回落阈值（单页宽 <320px）覆盖此场景，自动回单页。
- grid 迁移可能扰动既有单页布局（flex→grid 条件切换）：spread=false 时保持原 flex 类名路径不变，样式隔离在 `[data-spread]` 下，降低回归面。
