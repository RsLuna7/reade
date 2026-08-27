# 方案定稿：PDF 区域引用卡片

- 日期：2026-08-13（基线查证日；同日复核基线并定稿）
- 状态：**已实施**
- 定位：原版式 PDF 下框选一个矩形区域 → 裁剪该区域位图 + 自动出处（文档名 · 第 N 页）→ 走金句卡片的预览/复制/下载既有出口。对无法选中文字的扫描版 PDF 尤其有用（图表、公式、影印段落都能"摘"下来）。
- 关联：位图来自 `PdfReader` 已渲染的页 canvas（DPR 语义必须对齐）；出卡管线复用 `quoteCard.ts` 的主题取色与 `QuoteCardDialog` 出口（`docs/plan-quote-cards.md`）；与 PDF 双页对开（`docs/plan-pdf-spread.md`）正交但共享页宿主结构。

> 一句话：PDF 工具栏加"截取引用"模式钮 → 页面上覆盖十字光标框选层（每页一个，随 `.pdf-page` 定位）→ 松手后从该页 canvas `drawImage` 裁出选区（乘 renderedPixelRatio 换算）→ `renderRegionCard(bitmap, meta, theme)` 在卡片画布上排版"位图 + 出处行"→ 复用 QuoteCardDialog 的复制/下载出口。零后端、零新依赖。

---

## 1. 现状基线（已核实于 2026-08-13，行号允许漂移）

| 事实 | 位置 |
|------|------|
| 页 canvas 渲染：位图尺寸 = viewport × `min(devicePixelRatio, 2)`，CSS 尺寸为逻辑宽——**裁剪坐标必须乘实际 pixelRatio（非当前 DPR，而是渲染时用的那个）** | `src/components/PdfReader.tsx` L387-399 |
| 每页宿主 `section.pdf-page`（aspectRatio 占位），近页才有 canvas；远页无位图可裁——**框选只在已渲染页可用** | `src/components/PdfReader.tsx` L503-519 |
| 页宽由 `--pdf-page-width` 控制、缩放 `scale` 0.5–3——裁剪清晰度随当前缩放（见 §3.3 提质策略） | `src/components/PdfReader.tsx` L983、L566-567 |
| 文本层覆盖在 canvas 上（`.pdf-text-layer`）——框选模式需临时禁用文本层指针事件防选字冲突 | `src/components/PdfReader.tsx` L406-407 |
| PDF 标注已有 normalized rects 先例（page + view + rects [0..1]）——框选区间沿同一归一化语义 | `src/lib/annotationCapture.ts` L73-113 |
| 卡片管线：`CARD_WIDTH = 720`、2× 导出、`readCardTheme` 主题 token、`copyImageToClipboard`/`downloadBlobFile` 出口 | `src/lib/quoteCard.ts` L32、L59-82、L294-320 |
| 预览对话框 `QuoteCardDialog { source: { quote, sourceTitle } }`——区域卡需要"图片源"变体（新 dialog 或扩展 props，见决策点） | `src/components/QuoteCardDialog.tsx` L23-26 |
| 当前文档标题/页号可得（DocumentInfo.title + currentPage state） | `src/components/PdfReader.tsx` L969-971 |
| CSP `img-src ... blob:`、canvas 同源无污染（位图来自本地渲染）——`toBlob` 无 taint 风险 | `src-tauri/tauri.conf.json` L26 |
| Web 版无 PDF（readDocumentRange 桌面专属）——本功能桌面专属，天然一致 | `src/lib/backend.ts` L298-300 |

## 2. 目标与非目标

**目标**

1. 原版式工具栏"截取引用"钮进入框选模式（Esc 退出）：十字光标、页面上拖出半透明选框（仅限单页内，跨页拖动钳制到起始页）。
2. 松手 → 生成卡片：裁剪位图按卡片宽度（720 逻辑px − 内边距）等比缩放放置，下方出处行"《文档标题》 · 第 N 页"，主题 token 取色的纸面底与细分隔线。
3. 复制 PNG / 下载 PNG（文件名 `reade-引用-<标题>-p<N>.png`）；再次框选覆盖上一次。
4. 最小选区门槛（逻辑 24×24px），过小视为误触忽略。

**非目标（明确不做）**

- 不做 OCR（离线 OCR 是独立重课题；本功能定位就是"位图摘录"）。
- 不把区域引用存为标注（无文本、rects-only 标注会让回顾/导出/检索全线出现"空文本"分支；本期即用即走，留远期与标注体系一并设计）。
- 不做多区域拼合、不做涂抹/箭头等编辑（策展式）。
- 不支持阅读模式（有真文本，走既有金句卡）与 Web（无 PDF）。

## 3. 设计

### 3.1 框选层

- `RegionSelectLayer`：模式开启时在每个**已渲染**页宿主内挂 `position:absolute; inset:0` 覆盖层（`z-index` 高于文本层），pointerdown/move/up 记录页内逻辑坐标，实时画选框 div；未渲染页不挂层（视觉上无光标变化即不可选）。
- 归一化：`rect / 页逻辑尺寸 → [0..1]`（与标注 rects 同语义），便于未来复用。

### 3.2 裁剪

```ts
cropPdfRegion(canvas: HTMLCanvasElement, normRect, renderedPixelRatio): Promise<ImageBitmap>
```

- 源坐标 = normRect × canvas 位图尺寸（位图已含 pixelRatio，无需再乘）；`createImageBitmap(canvas, sx, sy, sw, sh)`。
- **提质策略**：若选区位图短边 < 480px（缩放太小导致模糊），对该页用 pdf.js 以更高 scale 离屏重渲一次再裁（一次性、按需），保证卡片清晰度；重渲失败回落直接裁。

### 3.3 卡片绘制与出口

- `renderRegionCard(bitmap, { title, page }, theme)`（`quoteCard.ts` 旁新函数）：卡宽 720、2× 导出；位图等比放置（超高时按卡片最大高 900 逻辑px 缩放）；出处行排版复用金句卡来源行原语。
- 预览：扩展 `QuoteCardDialog` 支持 `source: { kind: "image", bitmap, sourceTitle, page }` 变体（版式切换隐藏，因为区域卡只有一档版式）；复制/下载按钮复用。

## 4. 改动清单（预估）

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/pdfRegion.ts`（新）+ 测试 | 归一化/裁剪坐标纯函数 | S-M |
| 2 | `src/components/PdfReader.tsx` | 模式钮 + RegionSelectLayer + 提质重渲 | M-L |
| 3 | `src/lib/quoteCard.ts`（或并列新文件） | `renderRegionCard` | M |
| 4 | `src/components/QuoteCardDialog.tsx` | image source 变体 | S-M |
| 5 | `src/App.css`、`docs/USER_GUIDE.md` | 选框/光标样式 + 文档 | S |

## 5. 验收标准（实施回填）

- [x] 纯函数测试：任意方向拖拽归一化、越界钳制、最小门槛（双轴）、同一归一化矩形在 ratio 1/1.5/2 位图上的换算、边缘取整钳制、提质重渲触发/目标/4096 封顶/无收益跳过、1:1 裁剪参数、文件名清洗——`pdfRegion.test.ts` 15 例。
- [x] 卡片合成测试：横/竖位图适配与超高钳制、标题省略保页号后缀、绘制顺序与取色、2× 渲染——`regionCard.test.ts` 7 例。
- [x] 组件测试：无回调不渲染入口、模式开关挂层/根类名/Esc 退出、拖拽选框绘制、切阅读模式自动退出——`PdfReader.test.tsx` 新增 4 例；对话框 region 变体（渲染管线切换、隐藏版式切换、文件名/复制出口）——`QuoteCardDialog.test.tsx` 新增 2 例。
- [x] 受控 harness 视觉：合成位图喂真实 QuoteCardDialog region 变体，浅色/青瓷深色两张（`output/playwright/roadmap-batch5/region-card-*.png`）——暗色下 PDF 位图保持白底浮于暗纸面、细线框与出处行取色正确。
- [x] `pnpm test`、`tsc --noEmit` 全绿；CSP/capability/Rust 零改动。
- [ ] **桌面真机待验收**（Web 无 PDF、纯浏览器无 Tauri IPC，无法在本环境端到端验证）：真实 PDF 上的框选手感与选框视觉、50% 缩放下提质重渲的实际清晰度、跨屏 DPR 变化后裁剪对位、剪贴板 PNG 粘贴到外部应用。裁剪/重渲/合成逻辑均有单测锚定，风险集中在交互手感而非坐标正确性。

## 6. 决策点

| # | 决策 | 定稿 | 备选 |
|---|------|------|------|
| RG-D1 | 位图来源 | **已渲染页 canvas 直接裁 + 低清时按需离屏重渲**；裁剪坐标一律按"归一化 × 实际位图尺寸"换算（对位图本身归一,天然免疫 DPR 漂移）；重渲阈值=裁剪短边 <480px,目标短边 960px,页位图长边封顶 4096px,失败回落直接裁 | 永远重渲高清（每次框选都付整页渲染成本）；只裁现有（50% 缩放下卡片糊） |
| RG-D2 | 是否存为标注 | **不存（即用即走）**——rects-only 无文本标注会污染回顾/导出/检索的全部文本假设 | 存为新 kind（跨层改动大，需独立方案，远期） |
| RG-D3 | 预览容器 | **扩展 QuoteCardDialog 为 source 判别联合**（`kind:"region"` 变体：隐藏版式切换、标题改"引用卡片"、文件名走 `regionCardFileName`；复制/下载/错误态全复用） | 新独立 dialog（重复三套出口逻辑，否） |
| RG-D4 | 跨页框选 | **钳制到起始页**（框选层挂在每页宿主内,坐标天然页内相对） | 支持跨页拼合（否） |

**定稿补充决策**

- 框选层实现为 `PdfPage` 内的 pointer 捕获覆盖层（仅 `regionActive && renderNearby` 时挂载,未渲染页无层即不可选）；模式激活时根元素挂 `pdf-region-select-active`,CSS 关闭文本层 pointer-events 防选字冲突,退出即恢复。
- Esc 退出模式由 PdfReader 自己的 window 监听处理（不 preventDefault,App 全局 Esc 链的收尾行为保持不变）；切换文档/切到阅读模式自动退出。
- 裁剪与合成走纯函数：`normalizeRegionRect`/`regionSourceRect`/`planRegionUpscale`/`cropRegionFromSource`（pdfRegion.ts,注入 canvas 工厂可测）+ `layoutRegionCard`/`renderRegionCard`（regionCard.ts,注入 measure/canvas）。
- 视觉验收现实约束照草案：Web 无 PDF、纯浏览器无 Tauri IPC——卡片合成用受控 harness（对话框喂合成 canvas）截图,框选交互的真实 PDF 端到端列入"桌面真机待验收",不伪造。

## 7. 风险

- `renderedPixelRatio` 与当前 `devicePixelRatio` 在跨屏拖动窗口后可能不一致：裁剪必须读渲染时记录的 ratio（挂 dataset 于 canvas），不能现取 DPR——用例表锚定。
- 提质重渲对超大页（A0 海报型 PDF）有内存峰值：重渲 scale 封顶（位图长边 ≤4096px），超限直接裁并接受清晰度。
- 框选层与双页对开叠加时每页独立覆盖层的坐标系不受布局影响（页内相对坐标），两方案可并行实施，但合并时需一次联测。
