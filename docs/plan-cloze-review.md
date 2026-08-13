# 方案草案：回顾挖空闪卡（cloze）

- 日期：2026-08-13（基线查证日）
- 状态：**定稿（基线已复核，决策见 §6 与 §8）**
- 定位：每日回顾新增"主动回忆"档：把摘录中最显著的片段挖空显示，先回想再点开揭示，然后照常评分。**不改回顾调度算法与数据结构**——cloze 只是卡片的另一种渲染档。
- 关联：挖空片段选择复用相关段落方案已落地的 `extractRelatedFragments` 显著性启发（`src/lib/relatedFragments.ts`）；回顾流程/调度/持久化沿 `reviewScheduler.ts` + `ReviewView.tsx` 现状。

> 一句话：纯函数 `buildClozeCard(text) → { segments: (text | blank)[], answer } | null` 用 `extractRelatedFragments` 的 top-1 片段（首个原文出现位置）作为空；`ReviewView` 卡片加"回想模式"渲染档（每日回顾设置里三选一：摘录 / 挖空 / 混合），空为点击揭示的胶囊；评分按钮在揭示后才可用；调度、`ReviewState`、IPC 零改动。

---

## 1. 现状基线（已核实于 2026-08-13，行号允许漂移）

| 事实 | 位置 |
|------|------|
| 调度纯函数体系：`REVIEW_INTERVALS_DAYS = [1,3,7,14,30,60]`、`DAILY_REVIEW_LIMIT = 10`、`buildReviewQueue(candidates, nowMs, limit?, seed?)`、`ReviewState { box, dueAt, ... }`——**本方案全部不动** | `src/lib/reviewScheduler.ts` L12、L16、L20-31、L125-161 |
| 回顾卡片现状：类型徽标 + 摘录 blockquote（`.review-excerpt`）+ 笔记 + 来源行 | `src/components/ReviewView.tsx` L226-236 |
| 操作与键盘：记住了(1)/再看一次(2)/打开原文(Enter)/不再回顾；Esc 退出 | `src/components/ReviewView.tsx` L238-258、L175-184 |
| 可回顾判定：`isReviewableAnnotation`（有文本的高亮/下划线） | `src/lib/reviewScheduler.ts`（同文件） |
| 显著性启发已存在：`extractRelatedFragments`——切 run、长 run 切片、长度降序 top-6（**top-1 即"最显著片段"**） | `src/lib/relatedFragments.ts` L18、L25-27、L55、L84-87 |
| 摘录文本上限 2000 字符（`MAX_SELECTION_CHARS`，选区入库时已截断） | `src/lib/annotations.ts` L12-13 |
| 后端只存 client 计算的 box/due_at（`record_review_outcome` 校验 box 0..=5），渲染档变化不触及 Rust | `src-tauri/src/user_store.rs` L60-61、L1723-1725 |
| Web 回顾：IndexedDB `WebReviewRecord`，同一前端流程——渲染档双端天然同构 | `src/lib/webAnnotations.ts` L498-506 |
| 每日目标/回顾入口：主页"今日回顾"卡 + ReviewView 全屏 | `src/components/HomeView.tsx` L329-359 |

## 2. 目标与非目标

**目标**

1. 回顾视图头部一个渲染档选择（"摘录 / 挖空 / 混合"，persist 到阅读偏好，默认"摘录"保持现状零惊扰）。
2. 挖空档：摘录中 top-1 显著片段以胶囊 `［点击回想答案］`（宽度 ≈ 原片段）遮蔽；点击或按空格揭示（带 subtle 淡入）；**揭示前"记住了/再看一次"禁用**（防未回想就评分）。
3. 混合档：每张卡按 annotationId 哈希确定性选择摘录/挖空（同卡永远同档，可预期）。
4. 不可挖空的摘录（片段抽取为空、摘录 <12 字符、挖空后剩余上下文 <6 字符）自动回落为摘录档渲染。

**非目标（明确不做）**

- 不做多空（cloze deletion 列表）；一卡一空（top-1），认知负担与实现都最小。
- 不改调度（不因"挖空答对"给不同 box 步进——评分仍是既有二元 remembered/again）。
- 不新增数据字段（挖空位置每次由纯函数重算，确定性保证一致）。
- 不做用户手选挖空区（策展式；启发式不满意可切回摘录档）。

## 3. 设计

### 3.1 纯函数（`src/lib/clozeCard.ts` 新建）

```ts
export type ClozeCard = { prefix: string; blank: string; suffix: string };
export function buildClozeCard(excerpt: string): ClozeCard | null;
export function clozeModeForCard(annotationId: string, mode: "excerpt" | "cloze" | "mixed"): "excerpt" | "cloze";
```

- `buildClozeCard`：`extractRelatedFragments(excerpt)[0]` 为候选；在原文中定位**首次出现**（大小写不敏感、空白归一后映射回原文区间）；校验剩余上下文长度；输出三段式。
- `clozeModeForCard`：mixed 时 FNV-1a(annotationId) 奇偶决定；确定性可测。

### 3.2 UI（`ReviewView.tsx`）

- 渲染档 state 从 store 读（新 persist 字段 `reviewCardMode`，migrate）；头部三段 segmented control。
- 挖空渲染：`<blockquote class="review-excerpt">{prefix}<button class="review-cloze-blank">…</button>{suffix}</blockquote>`；揭示后 blank 替换为 `<mark class="review-cloze-answer">`（subtle 档 runMotion 淡入）。
- 键盘：空格 = 揭示（揭示前）；揭示后 1/2 评分恢复可用；Enter 打开原文不受影响。
- 完成页/空态/加载态不变。

### 3.3 双端

- 纯前端渲染档，桌面/Web 自动同构；Web 的 persist 同走 `reade-reader-preferences`。

## 4. 改动清单（预估）

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/clozeCard.ts`（新）+ 测试 | 挖空构造 + 模式选择纯函数 | S-M |
| 2 | `src/components/ReviewView.tsx` + 测试 | 渲染档控件、揭示交互、评分门控 | M |
| 3 | `src/store/useReaderStore.ts` | `reviewCardMode` persist + migrate | S |
| 4 | `src/App.css`、`docs/USER_GUIDE.md` | 胶囊/答案样式（明暗）+ 文档 | S |

## 5. 验收标准（草案级）

- [ ] 纯函数测试：top-1 片段定位（含空白归一映射）、上下文过短回落、CJK/英文混排、mixed 确定性、空输入 null。
- [ ] 组件测：揭示前评分禁用、空格揭示、揭示后 1/2 可用、回落卡片按摘录渲染、档位切换即时生效。
- [ ] 运行时双端：真实标注走一轮挖空回顾；打开原文跳转正常；明/暗截图。
- [ ] 回归：摘录档与现状逐像素等价（默认档零变化）；`pnpm test`、`tsc --noEmit`。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| CZ-D1 | 挖空选择 | **`extractRelatedFragments` top-1**（已有显著性契约，零新启发式） | 独立 TF 词频启发（需要新索引，收益不明，否）；随机片段（不可预期，回忆价值低） |
| CZ-D2 | 评分门控 | **揭示前禁用评分**（保证"先想后看"的方法论成立） | 不门控（用户可跳过回想，功能退化为花哨摘录） |
| CZ-D3 | 档位默认值 | **摘录（现状）**（回顾是既有习惯流，默认不变最稳） | 默认混合（对既有用户是未经同意的行为变化） |
| CZ-D4 | 挖空持久性 | **每次重算（确定性纯函数）** | 存挖空区间进 ReviewState（数据结构膨胀 + 迁移成本，违背"只是渲染档"定位，否） |

## 7. 风险

- top-1 片段是"最长 run 切片"而非语义关键词：挖掉的可能是长而平庸的短语——接受为词面启发的边界；混合档与摘录档提供逃生门，文案不承诺"考点提取"。
- 空白归一后映射回原文区间的实现要小心 CJK/多空格边界：契约用例表必须含全角空格、换行、连续空白的映射用例。
- 揭示门控对"只想快速过一遍"的用户增加点击成本：档位是 opt-in 的，默认档不变。

## 8. 定稿补记（2026-08-13 复核）

基线复核结论：§1 的全部事实仍成立（行号以当日 HEAD `81aaf81` 为准；ReviewView 卡片/键盘/评分结构未变）。一处实现简化：**`extractRelatedFragments` 的片段是摘录的字面子串**（切 run 只在分隔符处断开、不改写字符，去重保留首次出现的原始大小写，且标注摘录上限 2,000 = 片段抽取上限 2,000），因此草案 §3.1 的"大小写不敏感、空白归一后映射回原文区间"不需要——`excerpt.indexOf(top)` 即为首次出现区间，保留 `indexOf` 未命中 → 回落摘录档的防御分支。落定与修正如下：

| # | 决策 | 结论 |
|---|------|------|
| CZ-D1..D4 | 均按推荐执行 | top-1 片段 / 揭示前禁用评分 / 默认摘录档 / 每次重算不落库 |
| CZ-D5（新） | 回落判定的精确规则 | 摘录 trim 后 <12 code point、无可用片段、片段未命中（防御）、或挖空后前后文合并的**非空白** code point <6 → `buildClozeCard` 返回 null，按摘录档渲染 |
| CZ-D6（新） | mixed 的确定性映射 | `FNV-1a(annotationId)`（reviewScheduler 的 seededRank 同族实现）为偶数 → 挖空，奇数 → 摘录；同卡永远同档 |
| CZ-D7（新） | 键盘契约 | 揭示前：`空格` = 揭示（焦点在按钮上时交给原生激活，防双触发），`1`/`2` 静默忽略，`Enter` 打开原文、`Esc` 退出不变；揭示后完全恢复既有键位（`1`/`空格` = 记住了、`2` = 再看一次）。「不再回顾」不属评分，不受门控 |
| CZ-D8（新） | 胶囊宽度近似 | 纯展示启发 `clozeBlankWidthEm`：CJK（code point >0x2E7F）计 1em、其余计 0.55em，钳制 2.5–16em；不承诺像素级等宽 |
| CZ-D9（新） | persist 落点 | store 新增 `reviewCardMode`（"excerpt"/"cloze"/"mixed"，默认 "excerpt"），进 partialize/migrate/merge，坏值经 `normalizeReviewCardMode` 回落默认；不进 `resetReaderPreferences`（与 dailyGoalMinutes/ttsRate 同类：非排版偏好） |
| CZ-D10（新） | 档位控件位置 | 卡片存在时才显示（完成页/空态/加载态不显示），置于卡片上方的 `radiogroup`，`aria-label="回顾卡片样式"`；切换即时对当前卡生效并重置揭示态 |
