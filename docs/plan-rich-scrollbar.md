# 方案定稿：富滚动条 / minimap

- 日期：2026-08-13（基线查证日；同日复核定稿）
- 状态：**定稿（基线已复核，决策见 §6 与 §8）**
- 定位：在正文滚动区右缘叠加一条"刻度层"：标注四色点、搜索命中、书签、朗读当前句的纵向位置一目了然。不做像素级缩略图（minimap 渲染成本高、信息密度低），做的是"文档地图刻度条"。
- 关联：数据源全部来自既有体系——标注 locator（`docs/plan-*` 无前置依赖）、库搜索结果、TTS cursor（`docs/plan-read-aloud.md`）；色阶语义与目录热力（`--stats-scale-*`）及标注四色一致。

> 一句话：一个绝对定位的 `.scroll-map` 竖条叠在 `.reading-scroll` 右缘，纯前端从已加载的标注 mark / 搜索命中 / 书签 locator / TTS 当前句计算 `offsetTop / scrollHeight` 比例渲染刻度点，点击刻度跳转；零后端改动、零新依赖。

---

## 1. 现状基线（已核实于 2026-08-13，行号允许漂移）

| 事实 | 位置 |
|------|------|
| 正文滚动容器 `.reading-scroll { overflow: auto }`，正文壳 `.article-shell` 限宽居中 | `src/App.css` L1067-1083 |
| 已有全局 WebKit 滚动条样式（11px 宽 + thumb 变体）；侧栏/toc 用 `scrollbar-width: none` 隐藏 | `src/App.css` L80-99 |
| 阅读进度已是 2px 底边细线，`transform: scaleX(var(--reading-progress, 0))`，由 App.tsx 滚动事件驱动 | `src/App.css` L933-950；`src/App.tsx` L3396-3414（rAF 采样） |
| 标注 mark：`wrapRangeWithMark(range, annotationId, color, markKind)` 在正文 DOM 内产生 `.annotation-mark--{color}` 元素——**刻度层可直接查询这些元素取 offsetTop，无需重算 locator** | `src/lib/annotations.ts` L415-462；`src/App.css` L2618-2632 |
| markdown/epub locator 有 start/end 文本偏移，pdf locator 有 page/rects；书签是独立 kind | `src/lib/backend.ts` L129-168 |
| TTS 当前句：`useReadAloud` 暴露 `sentenceIndex`，句片段 `SentenceSegment { start, end, text }` 有文本偏移；高亮用 CSS Custom Highlight（`::highlight(reade-tts-active)`），**DOM 中无句级元素可查**，需经 `rangeFromTextIndex(index, start, end).getBoundingClientRect()` 求位置 | `src/lib/useReadAloud.ts` L324-325；`src/lib/ttsSegments.ts` L26-33；`src/lib/sentenceHighlight.ts` L65-76 |
| 搜索命中：`SearchResult.locator` 为 `pdfPage`/`epubChapter`/null；markdown 命中**无文档内偏移**（整篇一个 segment） | `src/lib/backend.ts` L30-42 |
| 目录热力色阶 `--stats-scale-1..4`，TOC 覆盖线 `.toc-link.is-reached`——刻度层色阶语义与其对齐 | `src/App.css` L1844-1863 |
| PDF 远页只有 `<section class="pdf-page">` 骨架（aspectRatio 占位），canvas 懒渲染——页高度仍可查询，刻度位置可算 | `src/components/PdfReader.tsx` L503-519 |
| 三档动效 `runMotion(element, slot, keyframes, options, level)` | `src/lib/motion.ts` L17-41 |

## 2. 目标与非目标

**目标**

1. Markdown/EPUB/PDF 三格式的阅读面右缘出现刻度条：标注（按四色）、书签、当前搜索会话命中、TTS 当前句各一类刻度。
2. 点击刻度平滑滚动到对应位置；hover 显示极简 tooltip（类型 + 摘录前 24 字符）。
3. 窗口 resize / 字号调整 / 标注增删后刻度位置自动重算（ResizeObserver + 既有状态订阅）。
4. 刻度条本身不夺焦点、不遮挡原生滚动条交互，`motionLevel === "off"` 时无过渡动画。

**非目标（明确不做）**

- 不做文本缩略图 minimap（canvas 渲染整篇文本成本高，且与"策展式"审美冲突）。
- 不改原生滚动条行为与样式（刻度层是叠加物，不是滚动条替代品）。
- markdown 搜索命中不做文档内定位（索引整篇一个 segment，无偏移数据；见风险）。
- 不持久化任何刻度数据（全部运行时派生）。

## 3. 设计

### 3.1 数据模型（纯函数，`src/lib/scrollMap.ts` 新建）

```ts
type ScrollMapMark = {
  kind: "annotation" | "bookmark" | "search" | "tts";
  color?: AnnotationColor;        // annotation 用
  ratio: number;                  // 0..1，相对 scrollHeight
  label: string;                  // tooltip 文本
  targetId?: string;              // annotationId 或页号，点击跳转用
};
buildScrollMapMarks(inputs): ScrollMapMark[]   // 排序、去重（同 ratio±0.002 合并）、封顶 200 个
```

- **标注/书签**：查询 `.annotation-mark[data-annotation-id]` 首元素 `offsetTop / scroller.scrollHeight`；书签（无 mark 元素）经 locator 偏移 + `rangeFromTextIndex` 求 rect；PDF 书签按 `page / numPages` 折算。
- **TTS 当前句**：`sentenceIndex` 变化时对当前句 start/end 建 Range 求 ratio，仅 1 个刻度、样式区别（横线而非圆点）。
- **搜索命中**：仅 PDF（`pdfPage/numPages`）与 EPUB（章节元素 offsetTop）有可靠位置；markdown 命中降级为不显示。

### 3.2 渲染与交互

- 新组件 `ScrollMap`（挂在 reader 容器内，`position: absolute; right: 2px; top/bottom: 0; width: 14px; z-index` 低于浮层）；每个刻度是 6×6 圆点（annotation 四色用 `--annotation-{color}` 现有变量；search 用 `--accent`；bookmark 用现有书签图标色；tts 为 10×2 横线）。
- 点击刻度：annotation/bookmark 走既有 `performAnnotationJump` 语义（滚动 + 短暂强调）；search/PDF 走 `jump(page)`；`pointer-events` 仅刻度点自身接收，其余区域穿透。
- 重算时机：`currentPath` 变化、标注列表变化、`ResizeObserver`（正文壳）、字号/行高设置变化、TTS `sentenceIndex` 变化（仅更新单刻度）。全部走 rAF 合并，与既有阅读进度采样同节流纪律。
- 开关：阅读设置面板加"文档地图"开关（默认开），存 `useReaderStore` persist（`partialize` 增一字段，版本迁移）。

### 3.3 双端与安全

- 纯前端、双端同一实现；Web 无搜索 locator（`locator` 恒 null）时搜索刻度自然缺席。无新 IPC、无 CSP/capability 变化、无新依赖。

## 4. 改动清单（预估）

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/scrollMap.ts`（新）+ 测试 | 刻度计算纯函数 + 合并/封顶用例 | M |
| 2 | `src/components/ScrollMap.tsx`（新） | 渲染 + 点击/hover | M |
| 3 | `src/App.tsx` | 数据接线（标注/搜索/TTS/书签）、开关 | M |
| 4 | `src/store/useReaderStore.ts` | 持久化开关字段 + migrate | S |
| 5 | `src/App.css`、`docs/USER_GUIDE.md` | 样式（明暗主题）+ 文档 | S |

## 5. 验收标准（草案级）

- [ ] 纯函数测试：ratio 计算、±0.002 合并、200 封顶、四色映射、PDF 页折算。
- [ ] 运行时：demo-library 三格式各验证刻度出现与点击跳转；字号从 13 调到 26 后刻度重算正确；TTS 播放时横线跟随当前句。
- [ ] 视觉：明/暗 × 宽/窄（640px）截图 ≥4 张；窄窗刻度条不与 toc-drawer 冲突。
- [ ] 回归：`pnpm test`、`tsc --noEmit`；标注跳转与阅读进度线不回归。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| RS-D1 | 形态 | **刻度层（点/线）** | canvas 文本缩略图（成本高、CJK 缩略不可读，否） |
| RS-D2 | 位置来源 | **优先查 DOM mark 元素，缺元素才回退 locator 偏移计算**（省一次全文索引） | 全部从 locator 重算（重复 buildTextIndex 成本） |
| RS-D3 | markdown 搜索命中 | **不显示**（索引无偏移，硬造会错） | 前端对正文再做一次子串定位（长文成本不可控，留远期） |
| RS-D4 | 开关默认值 | **默认开**（信息密度低、不打扰） | 默认关（发现性差） |

## 7. 风险

- 万字长文 + 数百标注时刻度重算的 rAF 帧预算：封顶 200 刻度 + 增量更新（TTS 只动一个），预计可控；定稿时补性能验收数字。
- PDF 远页懒渲染下 `offsetTop` 依赖 aspectRatio 占位的准确性：占位高度与实渲染高度一致（同 ratio 计算），已核实骨架先例；若发现漂移，刻度按页号/总页数折算兜底。
- 与既有右缘元素（朗读条 fixed 右下、related 浮层）的视觉拥挤：刻度条 z-index 放最低层并在浮层打开时保持穿透，截图验收把关。

## 8. 定稿补记（2026-08-13 复核）

基线复核结论：§1 全部事实成立（`.reading-scroll` 现位于 App.css L1207-1214、标注 mark 与 `data-annotation-id` 先例、`useReadAloud` 只暴露 `sentenceIndex`、搜索 markdown 命中无偏移；行号以 HEAD 为准）。落定与补充：

| # | 决策 | 结论 |
|---|------|------|
| RS-D1..D4 | 均按推荐执行 | 刻度层 / DOM mark 优先 / markdown 搜索命中不显示（诚实降级）/ 开关默认开 |
| RS-D5（新） | 布局宿主 | 主栏 `.reading-scroll` 外包一层 `.reading-frame`（相对定位，替它占据 content-grid 的原轨道），刻度层 absolute 挂 frame 右缘、`right` 让开 11px 原生滚动条；副栏不挂（纯净参考面） |
| RS-D6（新） | 封顶策略 | ±0.002 同 kind+color 合并后仍超 200 时按索引均匀抽稀（确定性、保持分布），不做首 200 截断 |
| RS-D7（新） | 点击语义 | annotation/bookmark 刻度按 id 回查标注走既有 `jumpToAnnotation`（含回退栈与强调语义）；search 与 TTS 刻度 `recordNavDeparture()` 后按 ratio 滚动容器 |
| RS-D8（新） | TTS 位置来源 | 扩展 `useReadAloud` 暴露 `getActiveSentenceRect()`（内部保存最近一次句高亮 Range），刻度层不读 CSS Highlight 注册表；`sentenceIndex` 变化只更新这一枚刻度 |
| RS-D9（新） | 三格式适配范围 | markdown：标注+书签+TTS；EPUB：标注+书签+搜索（章节）+TTS；PDF：标注（mark 缺失退页内 rects 折算）+书签+搜索（页）；PDF 原版式无 TTS（朗读本身不支持原版式） |
| RS-D10（新） | 持久化 | `useReaderStore` 增 `showScrollMap`（默认 true），进 partialize，merge 归一坏值；不升 persist 版本（缺键回默认的既有加法模式） |
