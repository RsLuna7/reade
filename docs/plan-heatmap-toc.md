# 实施方案:热力目录

- 日期:2026-08-12
- 状态:**已实施**
- 定位:把章节目录从"位置列表"升级为"密度地图"——每个条目显示该节的批注密度,一眼看出这篇文档哪里被反复划过;二期叠加"已读覆盖"标记。主流阅读器无此形态,是纯呈现层创新。
- 关联:T2(已读覆盖)依赖「今日视图」H0 的 `maxScrollRatio`/`maxPage` 持久化(`docs/plan-home-view.md` §3.2);批注密度与「全库批注中枢」共享同一批内存数据,互不依赖。

> 一句话:一个零 DOM 测量的纯函数(`headingId`/`page`/`chapterId` → TOC 桶计数)+ 复用统计热力图的 `--stats-scale-*` 色阶,在三种格式的目录上渲染极轻的密度点;不新增 token、不动渲染器、不动 Rust。

---

## 1. 现状基线(全部【已核实】于本仓库源码)

| 事实 | 位置 |
|------|------|
| `TocItem = { id, title, level, sourceStart?, sourceEnd? }`;markdown 的 TOC 由渲染后 DOM 提取(`h1[id]..h6[id]`,rehype-slug 生成 id) | `src/lib/markdown.ts` L4-10、L67-77 |
| PDF 目录 = outline 扁平化,**id 固定为 `pdf-page-N`**;活动项跟随可见页(`onActiveChange("pdf-page-N")`) | `src/components/PdfReader.tsx` L58-64、L576 |
| EPUB 目录 = `buildEpubToc(document)`,章节 section 带 `data-chapter-id`,章内标题条目归属其章;**注意:章级条目 id 是 `domId("epub-chapter", chapter.id)` 的 FNV 哈希,不是原始 `chapterId`**,批注归属需要显式映射 | `src/components/EpubReader.tsx` L30-34、L59-88、L387 |
| **markdown 批注创建时即记录最近标题**:`headingId: nearestHeadingId(...)`;书签记录 `activeHeading` | `src/lib/annotationCapture.ts` L63、L202、L212 |
| pdf locator 有 `page`,epub locator 有 `chapterId`;bookmark target 有 `page`/`chapterId`/`headingId` | `src/lib/backend.ts` L124-163 |
| 当前文档批注已常驻内存(`useDocumentAnnotations`),TOC 渲染组件为 `TocNavigation`(items/activeId/onSelect 三 props) | `src/App.tsx` L677-713、L918-929 |
| 统计热力色阶 token `--stats-scale-0..4` 由 `color-mix(accent, paper)` 派生,自动跟随全部 4 个主题系列 | `src/styles/theme-tokens.css`(热力块);`docs/research-multi-ui-themes.md` §2 |
| 分档纯函数 `calendarLevel(seconds, max, maxLevel=4)` 已存在可复用 | `src/lib/readingStats.ts` L276-279 |
| AppCss 测试锁定:语义 token 只能定义在 theme-tokens.css、新增系列不得新增 token 名 | `src/AppCss.test.ts`;主题调研 §5.4-b |
| TOC 活动项跟随由滚动 rAF 节流回调计算(markdown)或 reader 组件上报(pdf/epub) | `src/App.tsx` L2148-2180 |

## 2. 目标与非目标

**目标**

1. 三种格式的目录条目显示本节批注密度(0-4 档色点 + 数量提示),批注增删实时更新。
2. 密度归属**零 DOM 测量**:只用 locator 已有的 `headingId`/`page`/`chapterId` 字段,O(A+T) 纯函数。
3. 二期(T2):叠加"已读到最远位置"覆盖标记,极轻视觉。

**非目标(明确不做)**

- 不做全文缩略图 minimap(滚动条旁的像素级密度条)——DOM 测量成本与三格式差异大,收益存疑,列为远期观察。
- 不做"批注密度进文档树"(库级密度徽标属全库中枢的范畴,本方案只管单文档 TOC)。
- 不做停留时长热力(需要 per-section 采集,违反"不新增数据采集"约束)。
- 不动 MarkdownRenderer/PdfReader/EpubReader 的渲染路径,不动 Rust,不加 token。

## 3. 设计

### 3.1 归属算法(纯函数 `src/lib/tocHeat.ts`)

```ts
interface TocHeatEntry { count: number; level: 0 | 1 | 2 | 3 | 4 }
interface TocHeatResult {
  byId: Map<string, TocHeatEntry>;
  unassignedCount: number;   // 文首/无法归属的批注数
}
buildTocHeat(input: {
  items: TocItem[];
  annotations: Annotation[];         // live,调用方已过滤墓碑
  format: "markdown" | "pdf" | "epub";
  /** epub 专用:chapterId → 章级 TocItem.id。
   *  由 EpubReader 导出 `epubChapterTocId(chapterId)`(domId 的薄封装),
   *  App.tsx 从 currentContent.document.chapters 构建该映射传入,
   *  tocHeat 保持纯 lib、不 import 组件。 */
  epubChapterTocIds?: Map<string, string>;
}): TocHeatResult
```

逐格式归属规则(全部离线数据,无 DOM):

| 格式 | 归属键 | 规则 |
|------|--------|------|
| markdown | `locator.headingId`(mark 类)/ `target.headingId`(书签) | 直接命中 TOC id;`null`(文首选区)计入 `unassignedCount` |
| pdf | `locator.page` / `target.page` | outline 条目按扁平顺序形成页区间 `[page_i, page_{i+1})`(末项到 ∞);批注页落入哪个区间归谁;同页多个 outline 条目取**首个**;无 outline(TOC 空)→ 整体不显示热力 |
| epub | `locator.chapterId` / `target.chapterId` | 经 `epubChapterTocIds` 映射归到该章的**章级条目**(TOC id 是 domId 哈希,不能直接用 chapterId 匹配);章内标题条目不直接持有热度(其密度已含在章级);chapterId 不在映射中 → `unassignedCount` |

- 分档:`level = calendarLevel(count, maxCount)`(复用现有函数,max 归一、1..4 保底)。
- 失锚批注照常计数:`headingId`/`page` 是创建时的 hint,文档小改后仍是"大致在这一节"的最好信息;与批注列表"定位失效仍完整展示"的既有语义一致。
- 复杂度 O(A + T);万字文档(TOC ~100 项、批注 ~500 条)单次重算 < 1ms,`useMemo` 依赖 `[toc, annotations]`。

### 3.2 视觉(决策点 T-D1)

- 推荐 **A:右缘密度点**——`.toc-link` 尾部追加 `<span class="toc-heat" data-level="1..4">`,直径 6px 圆点,颜色 `var(--stats-scale-{level})`;`title` 与 `aria-label` 追加"本节 N 条标注";level 0 不渲染任何元素(无批注文档的 TOC DOM 与现状一致)。
  - 理由:与统计日历共用色阶语义("越深越多")、不侵入文字行、四个主题系列自动适配、零新 token。
- 备选 B:条目左缘 2px 竖热力条(更像"地图",但与 T2 覆盖标记的左缘位置冲突)。
- 备选 C:整行背景微染(信息最强但干扰扫读,否决——TOC 首要职责仍是导航)。
- `unassignedCount > 0` 时在 TOC 列表顶部加一行静默说明("文首另有 N 条标注",`.toc-empty` 同级样式),点击滚动到文档顶部。
- 动效:密度点无动画(TOC 属高频重渲染路径);`data-motion` 各档一致。

### 3.3 已读覆盖标记(T2,依赖今日视图 H0)

- 数据:`readingPositions` 的 `maxScrollRatio`(markdown/epub)与 `maxPage`(pdf)。
- 映射:
  - pdf:outline 条目 `page_i ≤ maxPage` → 已达;纯数据,零测量。
  - markdown/epub:需要标题在文档中的纵向位置——渲染后一次性测量(`requestIdleCallback` 中对 `h*[id]` 做 `offsetTop / scrollHeight`,缓存为 `Map<id, ratio>`,内容或排版参数变化时失效重测)。这是本方案唯一的 DOM 测量点,且不在滚动热路径上(滚动只比较缓存 ratio 与 maxScrollRatio)。
- 视觉:条目左缘 2px 边框——已达 `var(--line-strong)`、未达透明、当前活动项维持现有 accent 样式;不用对勾/百分比,避免"阅读打卡"压迫感(决策点 T-D2:默认开启,不设开关;若视觉走查觉得吵,降级为仅 hover 显示)。

### 3.4 接线

- `TocNavigation` props 追加 `heat?: TocHeatResult`(可选,未传时渲染与现状逐字节一致——保证向后兼容与快照回归)。
- `App.tsx`:`const tocHeat = useMemo(() => buildTocHeat({ items: toc, annotations, format }), [toc, annotations, currentContent?.kind])`,经 `SidePanel` 传入两处 `TocNavigation`(侧栏 + 窄窗抽屉)。
- Web 端零额外工作(批注来自 IndexedDB,数据形状相同)。

## 4. 改动清单(预估)

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/tocHeat.ts`(新)+ 测试 | 归属 + 分档纯函数 | S-M |
| 2 | `src/App.tsx` | useMemo 接线 + SidePanel 传参 | S |
| 3 | `TocNavigation`(App.tsx 内)| 密度点渲染 + aria | S |
| 4 | `src/App.css` | `.toc-heat` 与覆盖边框样式 | S |
| 5 | T2:`src/lib/tocCoverage.ts`(新)+ 测试 | 标题位置测量缓存 + 覆盖判定 | M |
| 6 | `docs/USER_GUIDE.md` | 目录章节补两句说明 | S |

里程碑:**T0** 纯函数 + markdown 密度点(端到端最小闭环)→ **T1** pdf/epub 归属 + 视觉打磨 + 文档 → **T2** 已读覆盖(等 H0 合入后)。

## 5. 验收标准

**T0/T1(密度)**

- [ ] 单测(`tocHeat.test.ts`):
  - markdown:headingId 命中;null 进 `unassignedCount`;书签 target.headingId 参与计数;
  - pdf:页区间边界(恰在 `page_{i+1}` 归下一节)、同页双 outline 条目归首个、无 outline 返回空 Map、批注页越过末项归末项;
  - epub:chapterId 经映射命中章级条目、章内标题条目不持有热度、未知 chapterId 进 unassigned、`epubChapterTocId` 哈希封装与 `buildEpubToc` 产出的 id 一致(往返测试);
  - 分档:单条=level 1、最大节=level 4、全零文档 byId 为空;
  - 传入含墓碑数据时的防御(调用方约定 live,函数内再滤一道 `deletedAt == null`)。
- [ ] 组件测:`TocNavigation` 无 `heat` prop 时输出与现状一致(快照);有 heat 时 level>0 条目带 `data-level` 与 aria-label"本节 N 条标注";level 0 条目无附加 DOM。
- [ ] 运行时:三种格式各造 5+ 条分布不均的批注 → TOC 密度肉眼可辨且与实际分布一致;新增/删除批注后 TOC 实时更新(无需刷新);**截图矩阵:markdown/pdf/epub × 明/暗 ≥ 6 张**,另抽 celadon 系列 1 张验证色阶跟随。
- [ ] 性能:200 项 TOC × 2,000 条批注的合成用例中 `buildTocHeat` 单次 < 5ms(vitest 内粗测断言上界);滚动帧率与现状无差(DevTools Performance 抽查,无新增长帧)。
- [ ] 回归:`pnpm test`、`tsc --noEmit`;AppCss 测试不变(零新 token);无批注文档的 TOC DOM 与主干完全一致。

**T2(覆盖)**

- [ ] 单测(`tocCoverage.test.ts`):ratio 缓存失效条件(内容变/字号变);maxPage 判定边界;缓存未就绪时全部按"未达"渲染不报错。
- [ ] 运行时:读到文档 60% 处重启 → TOC 前段条目带已达边框、后段无;PDF 按页验证;明/暗截图 ≥ 2 张。
- [ ] 性能:滚动路径零新增测量(代码走查 + Performance 抽查)。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| T-D1 | 密度视觉形态 | **A 右缘色点**(6px,stats 色阶) | B 左缘竖条;C 整行背景染(否决) |
| T-D2 | 覆盖标记默认状态 | **默认开,无设置项**,视觉压到 2px 边框 | 走查后若显吵,降为 hover 才显示 |
| T-D3 | epub 章内标题条目是否细分热度 | **不细分**(章级聚合) | 用 `blockIndex` 对照章内标题的块位置细分——需要 EPUB DTO 提供标题块索引,留待有真实需求再评估 |

## 7. 风险与开放问题

- `headingId` 是创建时快照:文档标题重命名后(slug 变化)旧批注会落入 `unassignedCount`——语义上正确("原来的节没了"),但数字可能让人困惑;文首说明行的文案要涵盖这一情况("文首或已变更章节另有 N 条")。
- PDF 无 outline 的文档占比未知:该场景热力整体缺席,与"本文档没有可导航的标题"的空态一致,不做页码条兜底(非目标)。
- 与全库中枢的数据一致性:两者都消费 `useDocumentAnnotations` 的内存列表,无双写问题。
