# PDF 文字图层标注误差调研

- 日期：2026-08-12
- 范围：`原版式` PDF 阅读中「文字图层选区 → 标注定位 → 回放渲染」的误差根因与方案裁决
- 状态：**仅调研与方案裁决，未改动任何产品代码**
- 证据标注约定：**【已核实】**＝直接读取源码/依赖确认；**【推断】**＝由已核实事实推导但未运行时验证；**【未验证】**＝需补证据

> 核心结论：这不是标注坐标模型的问题。是 pdf.js text layer 本身就渲染错位了，标注只是忠实地贴在了错位的文字层上。

---

## 1. 问题界定

### 现有链路（【已核实】）

```text
PDF 页 ──pdf.js render──> <canvas>            (CSS 拉伸到页框 100%)
        └─pdf.js TextLayer─> .pdf-text-layer  (span 绝对定位，尺寸靠 CSS 变量)
                                  │
                         用户选区 Range.getClientRects()
                                  │
                    normalizePdfRects(rects, page.getBoundingClientRect())
                                  │
                          存 {x,y,w,h} ∈ [0,1]  (page 框归一化) + quote/prefix/suffix
                                  │
                    回放: span.style.left = x*100% ... 挂在 .pdf-user-highlight-layer
```

涉及文件：

| 文件 | 职责 |
|------|------|
| `src/components/PdfReader.tsx` | 页渲染、text layer 构建、高亮 overlay 回放 |
| `src/lib/annotationCapture.ts` | DOM 选区 → locator |
| `src/lib/annotations.ts` | `normalizePdfRects`、TextQuote 序列化/查找 |
| `src/App.css` | `.pdf-page` / `.pdf-text-layer` / `.pdf-user-highlight-layer` 布局 |
| `src-tauri/src/library.rs` | SQLite 持久化与 sanitize（`rects.len() <= 64`） |

关键点：**采集与回放使用同一个基准框 `.pdf-page`，两者天然自洽**。所以误差不可能来自「采集/回放坐标不匹配」。

### 真正的误差机制

误差发生在更上游：**不可见的 text layer 与可见的 canvas 之间已经错位**。标注精确地覆盖在 text layer 的 span 上，但用户看到的字形来自 canvas，于是感知为「标注偏离真实文字」。

### 成功标准

1. text layer 每个 span 的包围盒与 canvas 上对应字形的墨迹框重合，误差 < 1 CSS px；
2. 高亮在 `适宽 / 100% / 200%`、窗口缩放、高 DPI 下不漂移；
3. 已有标注可自愈到正确位置，不要求用户重做。

---

## 2. 根因假设（按可能性排序）

### R1. `--total-scale-factor` 变量链断裂，导致 text layer 所有 span 的字号失效 —— 【已核实】主因

pdfjs-dist **6.2.108** 的 text layer 把定位和尺寸拆成了两半：

**定位是百分比**，会跟随容器（`pdf.mjs:15023-15024`）：

```js
divStyle.left = `${(100 * left / this.#pageWidth).toFixed(2)}%`;
divStyle.top  = `${(100 * top  / this.#pageHeight).toFixed(2)}%`;
divStyle.setProperty("--font-height", `${fontHeight.toFixed(2)}px`);   // 单位：PDF pt
```

**尺寸完全依赖 CSS 变量**（`pdf_viewer.css:649,657`）：

```css
--text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
font-size: calc(var(--text-scale-factor) * var(--font-height));
```

而 `--total-scale-factor` 只在 pdf.js 自带 viewer 的类名上声明（`pdf_viewer.css:6186,6238-6241`）：

```css
.pdfViewer      { --scale-factor: 1; }
.pdfViewer .page{ --user-unit: 1;
                  --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
                  --scale-round-x: 1px; --scale-round-y: 1px; }
```

Reade 用的是自己的 `.pdf-pages` / `.pdf-page` / `.pdf-text-layer`，**从不使用 `.pdfViewer` 或 `.page`**。全仓库检索 `--scale-factor` 命中 **0 次**；`TextLayer` 的 JS 也只写 `--min-font-size`、`--font-height`、`--scale-x`、`--rotate`，从不写 `--total-scale-factor`（`pdf.mjs:14881, 15025, 15085, 15089`）。

于是 `--total-scale-factor` 未定义 → `--text-scale-factor` 变成 guaranteed-invalid → `font-size` 在计算值阶段失效 → 回落为 `unset`（对 `font-size` 即 `inherit`），**每个 span 都继承同一个约 16px 的字号，与 PDF 真实字号、与缩放级别完全无关**。

连带失效的还有 `--scale-x`（`pdf.mjs:15085`）：它按「正确字号下 `measureText` 的宽度」算出横向压缩比，字号一旦错了，这个补偿就不再把 span 宽度归一到 canvas 上的字形宽度。

**预测的误差形态**（用来对照实际现象）：

| 现象 | 预测 |
|---|---|
| 每个 span 的左上角 | 正确（百分比定位不受影响） |
| 误差沿行内方向 | 从行首向行尾线性放大 |
| 大字号（标题） | 偏差最大且**偏小**（16px vs 应有 30px+） |
| 小字号（脚注） | 偏差偏大 |
| 随滚动 | 不变 |
| 随缩放 | 变化，且**非等比**（字号被钉死，位置却跟随缩放） |

误差量级估算：A4 正文 10.5pt、适宽 `scale≈1.31` 时应为 ~13.8px，实为 16px，约 **+16%**；一行 400px 宽的文本行尾累积偏差 ~64px。24pt 标题应为 ~31px，实为 16px，**约 -49%**。

> 补充线索：pdf.js 3.x 时代会在控制台报 `The --scale-factor CSS-variable must be set...`（见参考 [1][2]），**6.2.108 已移除该检查**（在 `pdf.mjs` 中检索 `CSS-variable` / `must be set` 无命中）。所以这个故障现在是**静默的**，很可能就是它一直没被发现的原因。

### R2. 页框 CSS 宽度与渲染 viewport 宽度是两个独立来源 —— 【已核实】次因

- 渲染：`viewport = page.getViewport({ scale })`，`viewport.width = rawDims.pageWidth × scale`（A4 ≈ 595.28pt）—— `PdfReader.tsx:317`
- 布局：`--pdf-page-width: ${Math.round(820 * scale)}px` —— `PdfReader.tsx:872`
- 页框：`.pdf-page { width: min(var(--pdf-page-width), 100%) }` —— `App.css:1008`
- 且 `.pdf-page canvas, .pdf-page .pdf-text-layer { width:100% !important; height:100% !important }` —— `App.css:1009`

canvas 是位图，被 CSS 拉伸到页框宽度没问题；text layer 的 span 是百分比定位所以也跟随，**但 `--font-height` 是 pt 绝对值**。这意味着即使把 `--total-scale-factor` 设成 `scale`，字号仍会与被拉伸的 canvas 差一个系数：

```text
页框CSS宽度 / (rawDims.pageWidth × scale)
```

A4 在 `scale=1`（「实际大小」按钮）下是 `820 / 595.28 ≈ 1.38`。

`fitWidth()` 恰好让两者近似相等（`scale = (clientWidth-18)/nativeWidth`，页框又被 `min(...,100%)` 夹到容器宽），**所以适宽下这一项误差很小，一旦点缩放按钮就暴露**。这解释了「误差随缩放变化」。

### R3. `/Rotate ≠ 0` 的页面额外错乱 —— 【推断，证据强】

`setLayerDimensions`（`pdf.mjs:1509-1531`）做两件事：写入 `width/height`（用的也是 `var(--total-scale-factor)`，同样失效），以及打上 `data-main-rotation` 属性。而 `pdf_viewer.css:6175-6183` 是**无作用域的全局选择器**：

```css
[data-main-rotation="90"] { transform: rotate(90deg) translateY(-100%); }
```

Reade 的 `!important` 覆盖了宽高但**保留了这个旋转 transform**，于是带 `/Rotate 90` 的页面会得到「按页框尺寸旋转 90°」的 text layer —— 与 canvas 完全对不上。这可能就是「是否仅部分 PDF 出现」的答案。未在运行时验证。

### R4. 缩略页重挂载后高亮层为空 —— 【已核实】独立小 bug

`PdfReader.tsx:399-419` 的高亮 effect 依赖是 `[highlights, pageNumber]`，不含 `renderNearby`。滚出 `IntersectionObserver` 范围（`rootMargin: 1200px`）后子树被卸载，滚回来时是新的 `<div>`，effect 不会重跑。目前靠父组件每次 render 都用 `annotations.filter(...)` 生成新数组引用「偶然」兜住了，但不保证。

### R5. 已排除的常见嫌疑

| 嫌疑 | 结论 | 依据 |
|---|---|---|
| devicePixelRatio | **不是根因** | 只影响 canvas backing store（`PdfReader.tsx:325-327`），CSS 尺寸独立；text layer 不参与 |
| 归一化坐标模型选错 | **不是根因** | 采集/回放同基准框，自洽；这正是业界主流做法 |
| 采集与回放基准不一致 | **不是** | 都用 `.pdf-page` 的 border box |
| 页面自身旋转未处理 | 部分误解 | `getViewport({scale})` 默认已应用页面 `/Rotate`；问题在 R3 的 CSS，不在坐标换算 |
| 异步布局 / 采集时机 | **不是** | 采集在 `mouseup` + `setTimeout(0)`，此时布局已稳定 |
| iframe / CSS transform | 不适用 | 无 iframe；页框上无 transform |

---

## 3. 方案对比

| # | 方案 | 原理 | 优点 | 风险 | 适用条件 |
|---|---|---|---|---|---|
| **A** | **修复 CSS 变量契约 + 统一页框宽度真值** | 以 `.pdf-page` 的**实际布局宽度**为唯一真值，推导 `--total-scale-factor = 实测宽 / rawDims.pageWidth` 并设在页元素上；页框宽度与 viewport 绑定 | 直击根因；改动 <50 行；数据模型零变更；修好后归一化 rects 真正具备缩放不变性 | 必须一次设对整条变量链（见下方陷阱）；需处理 `min(...,100%)` 夹取；`/Rotate` 页需一并处理 | 已确认 R1/R2 为根因时 |
| **C** | **quote 优先 + rects 降级**（在 A 之上叠加） | 回放时先用 `quote/prefix/suffix` 在 text layer 里重建 Range，用实时 `getClientRects()` 算矩形；存储的 rects 只作缓存/兜底 | 旧数据自动自愈，无需迁移脚本；与阅读模式/Markdown 走同一套锚定语义；对未来任何布局变化免疫 | 每次缩放/重排都要重算，需按页 memo；文字层未渲染时要延后；`findTextQuote` 在重复文本上可能误配 | 存量标注需要保住时 |
| **B** | **改存 PDF 用户空间坐标 / QuadPoints** | 采集时用 `viewport.convertToPdfPoint()` 把 client 坐标转成 PDF pt，存 pt；回放用 `convertToViewportRectangle()` 还原 | 与查看器彻底解耦；天然抗旋转；未来可导出为标准 PDF Highlight 注释 | **不能单独修好本 bug** —— 错的是 text layer 的 client rects，输入错了转换也错；需要 Rust 端 schema 变更 + 数据迁移 | 有「导出标准 PDF 注释」或「跨阅读器共享」需求时 |
| **D** | **接入 pdf.js `PDFViewer` 或 react-pdf-highlighter-extended** | 直接用上游成熟实现 | 上游维护，边界情况覆盖全 | 与 Reade 的 `PDFDataRangeTransport` 流式加载、`IntersectionObserver` 虚拟化、原版式/阅读模式双态、Tauri CSP 全面冲突；包体显著增大 | **不推荐** |

### 维度对照

| 维度 | A | A+C（主推荐） | B | D |
|---|---|---|---|---|
| 缩放/滚动/高DPI 精度 | 好 | 好 | 好（前提是 A 已修） | 好 |
| 旋转页 | 需额外处理 R3 | 需额外处理 R3 | 天然免疫 | 好 |
| 与选区/搜索高亮一致性 | 一致 | **最一致**（同一 Range 语义） | 一致 | 一致 |
| 实现复杂度 | 低 | 中低 | 中 | 高 |
| 对现有架构侵入性 | 极低 | 低 | 中（含 Rust schema） | 极高 |
| 旧标注兼容 | **旧 rects 仍是错的** | **自动修复** | 需迁移 | 需迁移 |
| 性能/包体 | 无影响 | 每页一次 Range 重建，可 memo | 无影响 | 包体 + |
| 桌面/Web 一致性 | 一致（纯前端） | 一致 | 需同步 Rust + IndexedDB 两套 | 一致 |
| 不可信 PDF 风险 | 不变 | 不变 | 不变 | 引入更多上游表面 |

---

## 4. 推荐结论

**主推荐：A + C 组合。**

即：先把 text layer 的 CSS 变量契约和页框宽度真值修对（A），再把回放改为「文本引用优先、存储 rects 兜底」（C）。

理由：

1. **A 是唯一直接消除根因的动作。** 换任何坐标系都救不了一个字号被浏览器回落成 16px 的 text layer —— 所有基于 DOM 选区的方案输入都是脏的。
2. **改完 A 之后，现有的归一化数据模型就是正确答案。** `{x,y,w,h} ∈ [0,1]` 相对页框，正是 react-pdf-highlighter 系列所说的 "Scaled" 坐标（参考 [4][5]），无需另起炉灶。B 带来的额外收益（导出标准 PDF 注释）当前没有需求驱动。
3. **C 用几乎零成本解决了迁移问题。** 存量标注的 `quote/prefix/suffix` 是从 text layer 的**文本内容**提取的，而文本内容不受 CSS 故障影响 —— **它们是干净的**。所以只要回放时按 quote 重算矩形，历史标注全部自动归位，不需要迁移脚本、不需要用户重做、也不需要写 schema 版本号。
4. **它让 PDF 原版式与阅读模式/Markdown 收敛到同一套锚定语义**（`findTextQuote` + `rangeFromOffsets` + `getClientRects`），减少一整类分叉逻辑。

**备选：B**，仅当出现「导出为标准 PDF 注释」或「标注要在其他阅读器打开」的需求时再做，且必须建立在 A 之上。

**明确不推荐：D**，以及「只加一行 `--scale-factor: 1`」这种看起来对的补丁 —— 见下方陷阱。

### 实现时必踩的陷阱（【已核实】）

只设 `--scale-factor` **无效**。因为 `--total-scale-factor: calc(var(--scale-factor) * var(--user-unit))` 里的 `--user-unit` 同样只声明在 `.pdfViewer .page` 上，仍然未定义，整条 calc 依旧是 invalid。必须二选一：

- 直接设 `--total-scale-factor`（推荐，绕开整条分解链），或
- 同时设 `--scale-factor`、`--user-unit`，以及 `setLayerDimensions` 需要的 `--scale-round-x/y`。

且正确的数值**不是 `scale`**，而是：

```text
--total-scale-factor = .pdf-page 的实际 CSS 宽度(px) / viewport.rawDims.pageWidth(pt)
```

因为 `.pdf-page` 的宽度会被 `min(820*scale, 100%)` 夹取，与 `viewport.width` 不相等（R2）。

---

## 5. 落地路线图（仅规划，不实现）

### 阶段 0 · 运行时确证（30 秒，做任何改动前先做）

打开一个 PDF，DevTools 选中任意 `.pdf-text-layer > span`：

- 看 Computed 里的 `font-size` —— 若**所有 span 都是同一个值**（约 16px），R1 成立；
- 看 Styles 里 `--total-scale-factor` 是否显示为未解析；
- 给 `.textLayer span { outline: 1px solid red }` 临时上色，肉眼看红框与字形的错位形态是否符合 R1 的预测（行首对齐、行尾发散、标题偏小）。

**这一步不通过，下面的路线图全部作废。**

### 阶段 1 · 修 text layer 对齐（R1 + R2）

| 位置 | 改动 |
|---|---|
| `PdfReader.tsx:872` | `--pdf-page-width` 不再用魔数 820，改由 `viewport.rawDims.pageWidth × scale` 推导，让页框宽度与渲染 viewport 同源 |
| `PdfReader.tsx` `PdfPage` | 用 `ResizeObserver` 观测 `.pdf-page` 实宽，写入 `--total-scale-factor = 实宽 / rawDims.pageWidth`；覆盖窄窗口被 `100%` 夹取的情况 |
| `App.css:1009` | 重新评估 `width/height: 100% !important`。若页框宽度已与 viewport 同源，应去掉 `!important`，让 `setLayerDimensions` 写入的值生效（这同时修好 R3 的旋转宽高交换） |
| `App.css:1008` | 复核 `overflow: hidden` —— 它目前在遮掩溢出的 span，修好后应确认不再需要靠它兜底 |

### 阶段 2 · 处理旋转页（R3）

确认 `/Rotate 90/180/270` 页面在阶段 1 后是否自动正确；若否，显式管理 `data-main-rotation` 与页框宽高交换，并让 `.pdf-user-highlight-layer` 使用与 text layer 相同的变换基准。

### 阶段 3 · quote 优先回放（C）

- 回放前先 `findTextQuote(collectElementText(textLayer), quote, prefix, suffix)` → `rangeFromOffsets` → `getClientRects()` → `normalizePdfRects`；
- 命中则用实时矩形（并可顺手回写缓存），未命中才退回存储的 `rects`，两者都失败才标 broken；
- 触发时机需覆盖：text layer 渲染完成、`scale` 变化、`renderNearby` 由 false→true（顺带修 R4，把 `renderNearby` 加进依赖）。

### 阶段 4 · 回归测试清单

**单元（`pnpm test`）**

- `PdfPage` 在给定 mock viewport + 页框宽度下，写入的 `--total-scale-factor` 数值正确（含 `min(...,100%)` 夹取分支）
- `normalizePdfRects` 在 `scale=1` 与 `scale=2` 下对同一逻辑选区产出**相同**分数
- quote 重建路径：给定 text layer DOM 与存量 locator，能还原出与直接选区一致的 rects
- `AppCss.test.ts`：断言不再存在会破坏 pdf.js 契约的 `!important` 覆盖
- `annotationCapture.ts` 目前**零测试**，本次应补上 PDF 分支

**Rust**：本方案不动 schema，`cargo test` 仅作回归确认。

**运行时视觉验收（不可省略，测试通过 ≠ 视觉正确）**

- 语料：A4 竖版、Letter、横版、`/Rotate 90`、中文正文、大标题、双栏、扫描件（无文字层）
- 矩阵：`适宽` / `100%` / `50%` / `200%` × 窄窗口(680px) / 宽窗口 × 明暗主题
- 缩放稳定性：适宽下建标注 → 切 100% → 切 200% → 拉窗口，高亮必须始终盖在同一批字上
- 滚动往返：滚离目标页 >1200px 再滚回，高亮仍在（R4）
- 双端一致性：Tauri WebView2 与 `pnpm dev:web` 浏览器下结果一致
- 存量数据自愈：用修复前创建的标注验证阶段 3 能否自动归位

---

## 6. 信息缺口

进入实现阶段前需要补充：

1. **阶段 0 的运行时确证结果** —— 尤其是 span 的 computed `font-size` 是否为常量。这是整份报告唯一未经运行时验证的关键环节。
2. **实际误差截图 / 录屏**，用于核对 R1 预测的形态（行首对齐、行尾发散、标题偏差最大）。若实际是「整体均匀平移」而非「发散」，说明还有未找到的第四个因素。
3. **是否只有部分 PDF 出现严重错位**；若是，提供一个坏样本，用于验证 R3（`/Rotate`）。
4. **是否存在需要保住的真实标注数据**。若没有，阶段 3 可降级为可选优化，方案退化为纯 A。
5. **是否有「导出为标准 PDF 注释 / 跨阅读器共享」的规划**。有的话，B 需要提前进路线图而不是事后补。
6. `820` 这个魔数的来历 —— 是刻意的排版宽度上限还是遗留值。若是前者，阶段 1 需改成「页框宽度独立、但 `--total-scale-factor` 从实测宽推导」的形态，而不是直接绑定 viewport。

---

## 7. 参考来源

### 本地一手证据（直接读取核实）

- `node_modules/.pnpm/pdfjs-dist@6.2.108/.../build/pdf.mjs`
  - `PageViewport` L808-889（`scale *= userUnit`、`rawDims`）
  - `setLayerDimensions` L1509-1531（`--total-scale-factor` 宽高、`data-main-rotation`）
  - `TextLayer` L14819-15145（`--min-font-size` L14881、百分比定位 L15023-15024、`--font-height` L15025、`--scale-x` L15085）
- `node_modules/.pnpm/pdfjs-dist@6.2.108/.../web/pdf_viewer.css`
  - `.textLayer` L615-662、`[data-main-rotation]` L6175-6183、`.pdfViewer` / `.pdfViewer .page` 变量声明 L6185-6241
- `src/components/PdfReader.tsx`（L317-345 渲染、L399-419 高亮回放、L628-640 fitWidth、L872 页宽）
- `src/lib/annotations.ts`（L318-336 `normalizePdfRects`）、`src/lib/annotationCapture.ts`（L54-86 PDF 分支）
- `src/App.css`（L1007-1037）

### 外部来源（已打开核对）

1. [mozilla/pdf.js PR #16162 — Warn about missing/incorrect `--scale-factor` CSS-variable](https://github.com/mozilla/pdf.js/pull/16162) — 上游明确「不能给 container 加默认值，必须由宿主设置」
2. [mozilla/pdf.js Issue #16254 — TextLayer always logs `--scale-factor` console.error](https://github.com/mozilla/pdf.js/issues/16254) — 含该检查的原始代码
3. [StackOverflow 76027650 — pdf.js pdfViewer float number rounding error](https://stackoverflow.com/questions/76027650/pdf-js-pdfviewer-float-number-rouding-error) — 自建 viewer 的设置示例
4. [react-pdf-highlighter-extended — `src/lib/coordinates.ts`](https://github.com/DanielArnould/react-pdf-highlighter-extended/blob/b58a3b387d870a44051a7d032e5f67ecabeb7909/src/lib/coordinates.ts) — Viewport ↔ Scaled 双坐标系与 `convertToViewportRectangle` 实现
5. [react-pdf-highlighter-plus 文档 — Coordinate Systems](https://github.com/QuocVietHa08/react-pdf-highlighter-plus) — 归一化 (0-1) 坐标用于存储的业界共识

> 注意：来源 1-3 描述的是 pdf.js 3.x 时期的 `--scale-factor` 机制（当时用于像素定位）。6.2.108 已演进为「百分比定位 + `--total-scale-factor` 控字号」，**并且移除了那条控制台报错**。所以外部来源只用于佐证「宿主必须设置该变量」这一契约，6.2 的具体行为以本地源码为准。
