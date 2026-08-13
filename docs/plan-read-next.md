# 方案定稿：读完接着读（read next）

- 日期：2026-08-13（基线查证日）；定稿：2026-08-13（基线 `adf73bd` 复核）
- 状态：**定稿**
- 定位：滚动到文档末尾时浮现一张轻卡片，推荐"下一篇"：合集内下一条 → 同文件夹下一篇 → 反向链接最多的相邻文档，三级回落。把"读完之后干什么"的决策成本降为一次点击。可关闭。
- 关联：合集顺序来自 `docs/plan-collections.md` 已落地的 `collection_items.position`；反链计数来自只读双链（`list_document_links`）；与主页"继续阅读"卡语义互斥——那是"回到读了一半的"，这是"读完当前的接下一篇"。

> 一句话：纯函数 `pickReadNext(context) → { path, reason } | null` 依次尝试合集顺位/树顺位/反链热度；末尾哨兵元素进入视口且滚动高水位 ≥0.98 时浮现 `ReadNextCard`（fixed 右下、可关闭、会话级不再出现）；点击走 `selectDocument`。零后端改动。

---

## 1. 现状基线（已核实于 2026-08-13，行号允许漂移）

| 事实 | 位置 |
|------|------|
| 合集数据：`list_collection_items` 返回按 `position` 排序的条目；前端 8 个 wrapper 齐备 | `src-tauri/src/user_store.rs` L588-719；`src/lib/backend.ts` L508-592 |
| 合集失联条目：`collection-item--missing` 灰显禁用——推荐时需跳过 missing | `src/components/CollectionsSection.tsx` L455-461 |
| 树排序：`buildDocumentTree` 目录优先 + `Intl.Collator` zh-CN numeric——"同文件夹下一篇"以此为准 | `src/lib/tree.ts` L56、L40-47 |
| 反链数据：`list_document_links`（桌面 sqlite `document_links` 表）/ Web 端 `documentLinks.ts` 全量解析（>500 篇禁用） | `src-tauri/src/library.rs` L1176-1193；`src/lib/documentLinks.ts` L29、L59-84 |
| 滚动高水位：`ReadingPosition.scroll.maxScrollRatio` / `pdf.maxPage`——"读完"判定数据已在 | `src/lib/readingPositions.ts` L20-40 |
| 阅读进度 rAF 采样在 App.tsx（末尾判定可搭同一链路） | `src/App.tsx` L3396-3414 |
| fixed 右下浮层先例：朗读条 `position: fixed; right: 24px; bottom: 24px; z-index: 44` | `src/App.css` L2692-2705 |
| 主页继续阅读卡：近 30 天会话/位置驱动，语义为"未读完的" | `src/lib/homeData.ts` L15-16、L55-107 |
| EPUB/PDF 阅读模式正文同为 `.reading-scroll` 滚动，PDF 原版式按页（`maxPage === numPages` 判定末页） | `src/components/PdfReader.tsx` L158-175 |
| 三档动效 `runMotion`（卡片入场按档位） | `src/lib/motion.ts` L17-41 |

## 2. 目标与非目标

**目标**

1. 触发条件：滚动到末尾（哨兵可见 且 scrollRatio ≥ 0.98；PDF 原版式为当前页 = 最末页）持续 800ms → 卡片淡入。
2. 推荐链：①当前文档所在合集（若属多个合集，取最近添加的那个）中的下一条（跳过 missing）→ ②树序中同文件夹的下一篇 → ③与当前文档互链文档中反链计数最高且未读完的 → 全空则不出卡。
3. 卡片内容：推荐理由徽标（"合集顺序 / 同文件夹 / 关联最多"）+ 标题 + 格式徽标 + 预估时长（若时长方案落地）；主按钮打开、次按钮关闭。
4. 关闭即本文档本会话不再出现；全局开关入阅读设置（persist，默认开）。

**非目标（明确不做）**

- 不做多候选轮播（一次只推一篇，策展式）。
- 不做基于内容相似度的推荐（相关段落是选区驱动的显式动作，不在此隐式化）。
- 不持久化"已关闭"状态到偏好（会话级足够，避免状态积累）。
- 不在 Web 端使用合集/反链之外的新数据源（Web 合集在 IndexedDB、链接解析有 500 篇上限，超限时只走树序回落）。

## 3. 设计

### 3.1 推荐纯函数（`src/lib/readNext.ts` 新建）

```ts
export type ReadNextSuggestion = { relativePath: string; reason: "collection" | "folder" | "backlinks" };
export function pickReadNext(input: {
  currentPath: string;
  documents: DocumentInfo[];
  collections: { id, updatedAt, items: { relativePath, missing }[] }[];
  linkCounts?: Map<string, number>;         // 与当前文档互链者的反链计数
  positions: Map<string, ReadingPosition>;
}): ReadNextSuggestion | null
```

- 树序回落用与 `buildDocumentTree` 相同的 Collator 常量（导出复用，防两处排序漂移）；"同文件夹"= 相同父路径的兄弟文档，取当前之后第一篇；当前已是末篇则不回落到下一文件夹（跨文件夹跳跃突兀）。
- backlinks 档：`list_document_links` 的出链+反链邻居里，取反链计数最高且 coverage < 0.98 者；并列取树序靠前。

### 3.2 触发与呈现

- 末尾哨兵 `<div data-read-next-sentinel>` 挂在 `.article-shell` 尾部，IntersectionObserver + 现有滚动采样中的 ratio 双条件；800ms 驻留后 `runMotion` 淡入。
- `ReadNextCard`（懒加载组件）：fixed 右下（与朗读条同区位——朗读播放中不出卡，避免叠罗汉）；Esc 或关闭钮 dismiss；`selectDocument(path)` 打开并记 dismiss。
- 会话级 dismiss 存 module 级 `Set<currentPath>`。

### 3.3 数据成本

- 合集与文档列表已在内存；反链只在①②落空时才请求一次 `listDocumentLinks(currentPath)`（有既有缓存语义则复用）；全程零新 IPC 契约。

## 4. 改动清单（预估）

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/readNext.ts`（新）+ 测试 | 三级回落纯函数 | M |
| 2 | `src/components/ReadNextCard.tsx`（新） | 卡片 | S |
| 3 | `src/App.tsx` | 哨兵、触发、dismiss、朗读互斥 | M |
| 4 | `src/store/useReaderStore.ts` | 全局开关 persist | S |
| 5 | `src/App.css`、`docs/USER_GUIDE.md` | 样式 + 文档 | S |

## 5. 验收标准（草案级）

- [ ] 纯函数测试：合集顺位（含跳过 missing、末条不回环）、同文件夹树序、backlinks 并列决胜、全空返回 null、多合集取最近更新。
- [ ] 运行时：demo-library 构造合集验证①；无合集文档验证②；孤立文件夹末篇 + 互链验证③；关闭后重滚到底不再出现；朗读播放中不出卡。
- [ ] PDF 原版式末页触发；EPUB 末章触发。
- [ ] 明/暗 × 宽/窄截图；全套回归。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| RN-D1 | 回落链 | **合集 → 同文件夹 → 反链热度**（显式意图优先于目录结构优先于图结构） | 反链优先（把图结构凌驾于用户手工合集之上，否） |
| RN-D2 | 触发阈值 | **哨兵可见 + ratio≥0.98 + 800ms 驻留**（防误触） | 仅哨兵可见（短文档一进来就触发，吵） |
| RN-D3 | 与朗读条的区位冲突 | **朗读中不出卡** | 卡片上移避让（两个浮层叠放，视觉噪音） |
| RN-D4 | dismiss 持久性 | **会话级** | persist（用户改主意后找不回，且状态无限膨胀） |

## 6.1 定稿落点（基线 `adf73bd` 复核后）

- RN-D1～RN-D4 全部按推荐执行：合集 → 同文件夹 → 反链热度；哨兵可见 + ratio ≥ 0.98 + 800ms 驻留；朗读中不出卡；dismiss 会话级（App ref `Set<path>`，换库清空）。
- 末尾哨兵对三格式统一适用：PDF 原版式是连续滚动（`.pdf-pages` 纵向排列），最末页滚到底时哨兵同样进入视口，无需单独的"当前页 = 末页"分支；无滚动余量的短文档 ratio 恒 0，不出卡（RN-D2 反噪声语义，接受）。
- 多合集归属取 `collection.updatedAt` 最新者（§5 验收标准原文），不再引入逐条 addedAt 比较。
- 合集条目契约按现状 `CollectionItem.present`（true = 在库），跳过 present=false 条目；到达合集末条不回环、不跨合集。
- 树序回落：`tree.ts` 导出排序 collator 与文档显示名（title 优先、文件名兜底），readNext 与文档树共用一份，防两处排序漂移；当前已是同文件夹末篇时不跨文件夹。
- 反链档：`listDocumentLinks(currentPath)` 的反链来源 + 出链在库文档目标合并为邻居集；权重 = 与当前文档的链接次数（反链用 `count`，出链按出现次数）；过滤未读完（`highWaterCoverage(position, extent.segmentCount) < 0.98`，无记录视为未读）；并列按 collator 比较 relativePath（树序的可接受近似）。Web 端链接视图超 500 篇被禁用时静默落空（只走前两档）。
- 编排函数 `resolveReadNextSuggestion` 注入 `listCollections/listCollectionItems/listDocumentLinks` 依赖，纯逻辑可测；每文档结果缓存至路径变化，反链 IPC 只在前两档落空时发生一次。
- 全局开关 `readNextEnabled` 入阅读设置并 persist（默认开）。

## 7. 风险

- "同文件夹下一篇"在以日期命名的日记类库中体验极好，但在杂物文件夹中可能推荐不相关文档：理由徽标明示推荐来源，用户可判断；全局开关兜底。
- 反链档需要一次额外 IPC：仅在前两档落空时发生，且结果可缓存至 currentPath 变化；成本可控。
- 末尾判定对"底部有长脚注/附录"的文档偏早或偏晚：0.98 阈值 + 哨兵双条件已保守，定稿时用真实长文调参。
