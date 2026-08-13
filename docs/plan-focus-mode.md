# 方案定稿：聚焦模式

- 日期：2026-08-13（基线查证日）；定稿：2026-08-13（基线 `ed130f2` 复核）
- 状态：**定稿**
- 定位：三个相互独立的阅读专注开关——①当前段落外降不透明度（spotlight）、②打字机滚动（当前行保持视口中部）、③阅读标尺（跟随指针的横向色带）。各自可单开，全部接入既有三档动效体系。
- 关联：与朗读句级高亮（CSS Custom Highlight，`docs/plan-read-aloud.md`）不争 DOM；动效档语义沿 `motion.ts`；设置面板与持久化沿 `useReaderStore` 阅读偏好模式。

> 一句话：spotlight 用 IntersectionObserver 标记"当前段落"并以 CSS `opacity` 淡化其余块级元素；打字机滚动在滚轮/键盘导航后把 active 块的中线校正到视口 45% 处；标尺是一条 `pointer-events: none` 的 fixed 横带跟随 pointermove；三开关入阅读设置面板、persist、双端同构，零后端改动。

---

## 1. 现状基线（已核实于 2026-08-13，行号允许漂移）

| 事实 | 位置 |
|------|------|
| 三档动效：`ReaderMotionLevel = "off"|"subtle"|"full"`；`runMotion` WAAPI 封装，off 档取消动画 | `src/lib/motion.ts` L1、L17-41 |
| 阅读设置现状：fontSize 13–26、lineHeight 1.4–2.4、contentWidth 560–1600、paragraphSpacing、fontFamily 三选——**聚焦开关是同一面板的自然延伸** | `src/store/useReaderStore.ts` L128-145 |
| persist 白名单 `partialize`（theme/readingSettings/motionLevel/…），key `reade-reader-preferences`，带版本 migrate | `src/store/useReaderStore.ts` L612-623 |
| 正文滚动容器 `.reading-scroll`，正文壳 `.article-shell` | `src/App.css` L1067-1083 |
| TTS 句级高亮用 `::highlight(reade-tts-active)`（CSS Custom Highlight API），**不产生 DOM 元素**——spotlight 的 opacity 不会与其叠加冲突，但两者同开时语义要定义（见 3.4） | `src/App.css` L2640-2642；`src/lib/sentenceHighlight.ts` L65-76 |
| TTS 播放时已有"滚动跟随当前句"（`reader.scrollTo` smooth） | `src/lib/useReadAloud.ts` L354-366 |
| EPUB 章节跟踪已有 IntersectionObserver 先例（referenceLine 在视口 18% 处） | `src/components/EpubReader.tsx` L305-341 |
| PDF 原版式按页渲染 canvas，**无段落级 DOM**——spotlight/打字机对 PDF 原版式不适用；PDF 阅读模式（`.pdf-reading-page` 内是 Markdown 渲染）可用 | `src/components/PdfReader.tsx` L503-519、L1009 |
| 标注 mark 是正文内 `<mark>` 元素，opacity 淡化会连带淡化——预期行为（非当前段的标注也应淡出） | `src/lib/annotations.ts` L415-462 |
| 阅读进度 rAF 采样先例（滚动处理的节流纪律） | `src/App.tsx` L3396-3414 |

## 2. 目标与非目标

**目标**

1. 三开关独立生效、可任意组合，存 `reade-reader-preferences`（版本迁移），双端同构。
2. spotlight：视口参考线（45%）最近的块级元素（p/li/blockquote/heading/pre 等直接子块）保持全亮，其余降至 opacity 0.35，过渡时长按动效档（off=瞬时、subtle=120ms、full=240ms）。
3. 打字机滚动：键盘（↑↓/PageUp/PageDown/空格）与滚轮停顿 160ms 后，将 active 块中线吸附到视口 45%；`prefers-reduced-motion`/off 档用 `behavior: "auto"`。
4. 标尺：高 = 当前行高（`lineHeight × fontSize` 计算）、全宽半透明色带（`--accent` 8% 透明度）跟随指针 Y，`pointer-events: none`，指针离开阅读区隐藏。
5. 适用面：Markdown、EPUB、PDF 阅读模式；PDF 原版式三开关禁用（UI 置灰 + 提示）。

**非目标（明确不做）**

- 不做"逐句 spotlight"（句级 DOM 拆分侵入渲染管线；段落级已够用，句级留给朗读高亮）。
- 不做全屏免打扰模式（隐藏侧栏等已有 toc-drawer/窄窗机制，不重复造）。
- 不持久化标尺位置等运行时状态。
- 不改 TTS 的滚动跟随逻辑（两者同开时打字机让位，见 3.4）。

## 3. 设计

### 3.1 spotlight

- `useFocusSpotlight(scrollerRef, enabled)`：对 `.article-shell` 直接块级子元素建 IntersectionObserver（阈值多档），滚动 rAF 中取距参考线最近者标 `data-focus-current`；容器加 `.focus-spotlight` class，CSS：`.focus-spotlight > :not([data-focus-current]) { opacity: .35; transition: opacity var(--focus-fade) }`。
- 嵌套列表/长代码块按顶层块整体处理（不下钻）；图片/Mermaid 同规则。

### 3.2 打字机滚动

- 监听 wheel/keydown 导航结束（160ms debounce）→ `scroller.scrollTo({ top: activeBlockCenter - viewport*0.45, behavior })`；用户主动拖动滚动条时不吸附（区分 wheel 与 scrollbar：pointer 按下位置在滚动条区则跳过）。
- 与阅读位置持久化（500ms trailing debounce 写 localStorage）无冲突——吸附本身触发 scroll 事件，沿既有链路记录。

### 3.3 标尺

- `ReadingRuler` 组件：fixed 定位横带，`transform: translateY()` 由 pointermove rAF 驱动；触屏（`(hover: none)`）不启用；行高变化时重算带高。

### 3.4 冲突矩阵

- TTS 播放中：打字机滚动挂起（朗读自己的跟随优先）；spotlight 保持（段落级淡化 + 句级 highlight 叠加是自然的"双层聚焦"）；停止朗读后恢复。
- 分屏（SecondaryPane）：三开关只作用于主阅读面（次窗格自管滚动，本期不接入）。

## 4. 改动清单（预估）

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/useFocusMode.ts`（新）+ 测试 | spotlight/打字机 hooks（纯逻辑部分抽函数测） | M |
| 2 | `src/components/ReadingRuler.tsx`（新） | 标尺 | S |
| 3 | `src/store/useReaderStore.ts` | `focusSpotlight/typewriterScroll/readingRuler` 三布尔 + migrate | S |
| 4 | `src/App.tsx` | 设置面板三开关、PDF 原版式禁用、TTS 让位接线 | M |
| 5 | `src/App.css`、`docs/USER_GUIDE.md` | 样式（明暗）+ 文档 | S |

## 5. 验收标准（草案级）

- [ ] 单测：active 块选择纯函数（参考线最近）、debounce 时序、store migrate。
- [ ] 运行时：长 Markdown 三开关各自与组合生效；调字号后标尺高度跟随；PDF 原版式置灰；TTS 播放时打字机让位；`motionLevel=off` 无过渡。
- [ ] `prefers-reduced-motion` 下滚动 behavior 为 auto。
- [ ] 明/暗 × 宽/窄截图 ≥4 张；全套回归测试双端 build。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| FM-D1 | spotlight 粒度 | **顶层块级元素**（零渲染管线侵入） | 句级（需拆句包 span，动渲染器，否）；视口外整段隐藏（阅读位置感丢失） |
| FM-D2 | 参考线位置 | **45% 视口高**（与 EPUB 18% 章节参考线用途不同，聚焦要居中偏上） | 50%（长段落底部提前失焦感更强） |
| FM-D3 | 三开关归属 | **阅读设置面板 + persist** | 顶栏独立按钮（顶栏已挤）；每文档记忆（状态爆炸，否） |
| FM-D4 | PDF 原版式 | **禁用并提示** | canvas 上叠段落遮罩（无段落 DOM，无从谈起，否） |

## 6.1 定稿落点（基线 `ed130f2` 复核后）

- FM-D1～FM-D4 全部按推荐执行；参考线 45%、三开关入阅读设置面板并 persist、PDF 原版式禁用（置灰 + 提示行）。
- 块容器按格式选定：Markdown `.annotated-markdown > .markdown-body`、EPUB `.epub-chapter`（章头与 `.epub-block` 同为候选块）、PDF 阅读模式 `.pdf-reading-page > .markdown-body`；容器标 `data-focus-container`，当前块标 `data-focus-current`，CSS 只淡化 `:not([data-focus-current])`。
- spotlight 与打字机合并为单 hook `useFocusMode`（共享块收集、IntersectionObserver 可见集与最近块判定），避免双 IO 重复成本；内容异步变化（Shiki/Mermaid/PDF 阅读页加载）用 childList MutationObserver 去抖重收集。
- 打字机武装窗口：wheel/导航键刷新武装时间戳，滚动事件距最近武装 ≤500ms 才参与 160ms 静止判定；吸附一次消费武装（自身滚动不再触发）；滚动条区域 pointerdown 豁免；TTS 控制条打开时挂起。
- `prefers-reduced-motion` 沿既有档位语义（系统 reduce → 默认档 off），不新增媒体查询；off 档吸附用 `behavior: "auto"`、过渡时长 0。
- PDF 原版式判定：PdfReader 新增可选 `onModeChange` 回调（现状无模式外报能力，这是本功能唯一的组件契约新增），App 据此置灰设置行并停用三效果。
- 标尺渲染于 `.reading-frame` 内 absolute 层，高度 = 字号 × 行高，触屏（`hover: none`）不渲染。

## 7. 风险

- spotlight 的 opacity 过渡在超长文档高频滚动时可能引发大面积重绘：只切换 `data-focus-current` 单元素 + 相邻元素，CSS 过渡由 GPU 合成层承担；验收带 5 万字文档实测帧率。
- 打字机吸附与用户手动微调滚动的"拉扯感"是此类功能的经典失败点：160ms 静止判定 + 滚动条拖动豁免是第一道防线，定稿前需真机调参。
- 标尺在多列/表格区域语义弱（横带覆盖整行宽）：接受，标尺本就是视觉辅助而非精确定位。
