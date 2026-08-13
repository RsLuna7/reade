# 方案草案：全书回顾编纂视图（读书报告）

- 日期：2026-08-13（基线查证日）
- 状态：**草案（实施前需复核基线行号并升级定稿）**
- 定位：把当前文档的全部标注按章节结构穿插编纂为一页只读"读书报告"：章节标题 + 该章摘录（blockquote）+ 笔记，读完一本书后一眼回看全部收获；整页可导出 Markdown。
- 关联：标注→章节归属完全复用目录热力的 locator 归因逻辑（`tocHeat.ts` 的 buildTocHeat 输入契约）；导出复用 `annotationExport.ts` 通道；入口在标注 tab 与全库标注中枢。

> 一句话：纯函数 `buildBookDigest(toc, annotations, docTitle) → DigestSection[]`（每节 = 章节标题 + 有序标注列表，未归属者入"未分组"节）；新全屏组件 `BookDigestView`（只读排版，条目点击跳原文）；"导出 Markdown"用 `buildAnnotationsMarkdown` 的姊妹函数 `buildDigestMarkdown` 走既有下载/保存通道。零后端改动。

---

## 1. 现状基线（已核实于 2026-08-13，行号允许漂移）

| 事实 | 位置 |
|------|------|
| 标注→目录条目归因已有完整实现：`buildTocHeat` 按 locator 提示（markdown 标题偏移 / PDF 页 / EPUB 章节）把标注计数归到 TOC 条目——**编纂视图需要的是同一归因的"列表版"（返回标注分组而非计数），可从中抽公共函数** | `src/lib/tocHeat.ts` L15-18、L164（及 buildTocHeat 主体） |
| TOC 数据：markdown 由 `extractToc`（rehype-slug id + data-heading-level）、PDF outline flatten、EPUB 章节——三格式 TocItem 已统一 | `src/lib/markdown.ts`（extractToc）；`src/components/PdfReader.tsx` L646-678；`src/components/EpubReader.tsx` L273 |
| 文档级标注列表：`list_annotations(relative_path)` 桌面 / IndexedDB Web，App 内已有当前文档标注状态流 | `src-tauri/src/user_store.rs` L266-281；`src/lib/webAnnotations.ts` L17-26 |
| 导出 Markdown 先例：`buildAnnotationsMarkdown`（# 标题、## 文档、- 类型·位置·日期、> 摘录、笔记）+ 桌面保存对话框（`export_annotations_file`，Rust 侧 dialog）/ Web 下载 | `src/lib/annotationExport.ts` L87-147；`src-tauri/src/transfer.rs` L79-101 |
| 全屏视图先例：`activeView = "annotations"`（标注中枢）、"review"、"stats"——digest 可作第六 view 或复用中枢内嵌（见决策点） | `src/store/useReaderStore.ts` L69；`src/components/AnnotationHubView.tsx` L141-163 |
| 标注跳原文链：中枢/侧栏条目点击 → `scheduleAnnotationJump`（打开文档 + 定位重试） | `src/App.tsx`（annotation jump 一族） |
| 侧栏标注 tab 与中枢入口（"在中枢中打开"） | `src/App.tsx` L2521-2525、L869 |
| 排序：标注有 `sortIndex`（文档内顺序），markdown locator 有 start 偏移——章节内排序数据齐备 | `src/lib/backend.ts` L170-189、L129-168 |

## 2. 目标与非目标

**目标**

1. 入口两处：侧栏标注 tab 头部"编纂读书报告"（当前文档 ≥1 条标注时可用）；标注中枢文档分组的同名操作。
2. 视图：文档标题 + 统计行（N 条摘录 · M 条笔记）→ 按 TOC 顺序的章节小节（无标注章节跳过）→ 每条：色点 + 摘录 blockquote + 笔记（斜体）+ 位置徽标（页码/章节）；locator 无法归属的入末尾"未分组"节。
3. 条目点击 → 关闭视图并跳原文标注处；书签类标注不进编纂（无摘录文本）。
4. "导出 Markdown"：同结构（`#` 文档、`##` 章节、`>` 摘录、笔记行），走既有导出通道（桌面保存对话框 / Web 下载 .md）。

**非目标（明确不做）**

- 不做跨文档合辑（全库维度是标注中枢的地盘；本视图 = 单文档）。
- 不做可编辑排版/评语补写（Reade 只读红线：笔记编辑仍在原有标注流程里做）。
- 不做 PDF/图片位图嵌入导出（导出是纯 Markdown 文本）。
- 不持久化编纂结果（随开随算）。

## 3. 设计

### 3.1 纯函数（`src/lib/bookDigest.ts` 新建）

```ts
export type DigestSection = { tocId: string | null; heading: string; level: number; items: Annotation[] };
export function buildBookDigest(input: {
  toc: TocItem[]; annotations: Annotation[]; format: DocumentFormat;
}): DigestSection[]
```

- 归因规则与 `buildTocHeat` 对齐（markdown：标注 start 偏移落在哪个标题区间；PDF：locator.page 对 outline 页区间；EPUB：chapterId 直配）——实施时把 tocHeat 内部的"标注→条目"匹配抽成共享函数 `attributeAnnotationToToc`，tocHeat 与 digest 共用，防两处漂移。
- 章节内排序：markdown 按 start 偏移，PDF 按 page+rects.y，EPUB 按 blockIndex/startOffset；回落 sortIndex。
- 过滤：kind === "bookmark" 或无 selectedText 的跳过（计数注明"已略过 N 条书签"）。

### 3.2 视图与导出

- `BookDigestView`（懒加载）：复用 `.article-shell` 排版变量（字号/行高设置生效），只读、无选区工具条；顶栏：返回 + 导出按钮。
- 呈现载体推荐**全屏 overlay**（不新增 `ReaderView` 枚举值，作为 reader 之上的模态层，Esc 返回）——避免第六 view 的路由/互斥矩阵膨胀（见 BD-D1）。
- `buildDigestMarkdown(sections, meta): string` → 桌面 `exportAnnotationsFile` 同款保存流（.md 进 `EXPORT_FILE_KINDS` 需扩展或直接走前端 `downloadBlobFile`，见 BD-D3）。

## 4. 改动清单（预估）

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/bookDigest.ts`（新）+ 测试 | 归因分组/排序/markdown 生成 | M |
| 2 | `src/lib/tocHeat.ts` | 抽公共 `attributeAnnotationToToc`（重构不改行为） | S-M |
| 3 | `src/components/BookDigestView.tsx`（新） | 只读排版 + 跳转 | M |
| 4 | `src/App.tsx` | 两处入口 + overlay 状态 + 跳转接线 | M |
| 5 | `src/App.css`、`docs/USER_GUIDE.md` | 样式（明暗）+ 文档 | S |

## 5. 验收标准（草案级）

- [ ] 纯函数测试：三格式归因（含边界：首标题前的标注、无 TOC 文档全入未分组）、章节内排序、书签过滤、markdown 输出快照。
- [ ] tocHeat 重构零回归（既有测试全绿）。
- [ ] 运行时双端：真实标注文档编纂——章节顺序与原文一致、点击跳回正确标注；导出 .md 在外部编辑器打开结构正确。
- [ ] 明/暗 × 宽/窄截图；`pnpm test`、`tsc --noEmit`、`cargo test`（若动 transfer）回归。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| BD-D1 | 呈现载体 | **reader 之上的全屏 overlay**（不动 ReaderView 枚举与视图互斥矩阵） | 新 activeView（路由语义更"正"，但互斥/返回逻辑改动面大；定稿时若 overlay 与既有浮层冲突再升级） |
| BD-D2 | 归因实现 | **从 tocHeat 抽共享函数**（单一真相源） | digest 独立实现（两套归因必然漂移，否） |
| BD-D3 | 导出通道 | **前端 `downloadBlobFile` 下载 .md**（双端同构、不动 Rust EXPORT_FILE_KINDS 白名单） | 扩展 `export_annotations_file` 支持 md（要动 transfer.rs 白名单，收益仅是原生保存对话框） |
| BD-D4 | 书签处理 | **跳过并计数注明** | 以"位置书签"行呈现（无文本的行在报告里是噪音） |

## 7. 风险

- markdown 标注 locator 的 start 偏移基于渲染文本索引，TOC 标题区间基于源码/渲染的对应——`buildTocHeat` 已解决过一次这个映射，共享函数是关键防线；若两者当前实现有隐藏分歧，抽取时会暴露（属良性发现）。
- 无标题长文（TOC 为空）时报告退化为平铺列表：可接受（等价于现有导出的可读版）。
- overlay 与朗读、分屏同开的交互矩阵：进入编纂视图时暂停朗读提示、分屏保持背后不动，定稿时补矩阵。
