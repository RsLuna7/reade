# 方案草案：那年今日卡

- 日期：2026-08-13（基线查证日）
- 状态：**草案（实施前需复核基线行号并升级定稿）**
- 定位：主页新卡片"那年今日"：展示一年前 / 一个月前的今天创建的标注、读过的文档，点击跳回原文。给个人库一点时间纵深感。无数据时整卡不显示。
- 关联：数据源 = 标注 `createdAt`（`list_annotations` 既有）+ 统计库会话（`list_reading_sessions` 既有）；整卡隐藏与点击跳转沿 `HomeView` 既有先例（今日回顾卡、继续阅读行）。

> 一句话：纯函数 `buildOnThisDay(annotations, sessions, documents, nowMs) → OnThisDayCard | null` 取 [365±0, 30±0] 天前本地日历日窗口内的标注（优先）与阅读会话文档（补充），每档最多 3 条；HomeView 挂新卡（null 整卡不渲染）；标注行点击走既有标注跳转链，文档行走 `selectDocument`。零后端改动。

---

## 1. 现状基线（已核实于 2026-08-13，行号允许漂移）

| 事实 | 位置 |
|------|------|
| 标注含 `createdAt/updatedAt`（ms 时间戳），`list_annotations()` 可取全库 | `src/lib/backend.ts` L170-189；`src-tauri/src/user_store.rs` L266-281 |
| 阅读会话：`list_reading_sessions(from_ms, to_ms)` 区间重叠查询，含 relativePath/title/format | `src-tauri/src/stats.rs` L84-96、L265-268 |
| 本地日历日工具已有：`localDayKey` / `dayKeyToDate`（statsView 在用，时区安全） | `src/lib/readingStats.ts`（localDayKey 一族） |
| **整卡隐藏先例**：`reviewSummary == null` 时"今日回顾"整卡不渲染；Web 隐藏"今日进度"卡 | `src/components/HomeView.tsx` L329-359、L251-287 |
| 主页行点击跳文档先例：`onClick={() => openDocument(item.relativePath)}` | `src/components/HomeView.tsx` L222-227 |
| 标注跳转链：App 已有 `scheduleAnnotationJump`（打开文档 + 重试定位）——主页可复用（标注中枢/侧栏同链路） | `src/App.tsx`（annotation jump 一族） |
| HomeView 数据模式：store + `listReadingSessions` + homeData 纯函数 | `src/components/HomeView.tsx` L102-107 |
| Web 端：标注在 IndexedDB（`webAnnotations`）可查 createdAt；**无阅读会话**——Web 只有标注档 | `src/lib/webAnnotations.ts` L17-26；`src/lib/backend.ts` L678-684 |
| 文档可能已改名/删除：标注带 relativePath，若不在当前 documents 列表则该条跳过（合集 missing 先例语义） | `src/components/CollectionsSection.tsx` L455-461 |

## 2. 目标与非目标

**目标**

1. 主页新增"那年今日"卡：两个分组——"一年前的今天"、"一个月前的今天"（其一无数据则该组不显示，两组皆无则整卡不渲染）。
2. 每组内容：当天创建的标注（摘录前 60 字符 + 来源文档标题，最多 3 条）；标注不足 3 条时补充当天读过（会话 ≥5 分钟）的文档（标题 + 当日阅读时长，最多补至 3 条）。
3. 点击标注行 → 打开原文并定位标注；点击文档行 → 打开文档。
4. "今天"按本地日历日（localDayKey）判定，跨时区/夏令时安全。

**非目标（明确不做）**

- 不做任意历史日期浏览（那是统计视图 drill-down 的职责，已存在）。
- 不做"N 年前"多档回溯（数据积累不足一年时一年档自然缺席；不为远期数据预设计）。
- 不做通知/提醒（Reade 无通知体系，不为此开权限）。
- 不缓存/持久化卡片内容（每次进主页现算，量级见 §3.3）。

## 3. 设计

### 3.1 纯函数（`src/lib/onThisDay.ts` 新建）

```ts
export type OnThisDayEntry =
  | { kind: "annotation"; annotationId: string; relativePath: string; excerpt: string; docTitle: string }
  | { kind: "document"; relativePath: string; title: string; activeSeconds: number };
export type OnThisDayGroup = { label: "一年前" | "一个月前"; dayKey: string; entries: OnThisDayEntry[] };
export function buildOnThisDay(input: {
  annotations: Annotation[];
  sessions: ReadingSession[];        // 桌面；Web 传 []
  documents: DocumentInfo[];
  nowMs: number;
}): OnThisDayGroup[]                  // 空数组 = 整卡不渲染
```

- 目标日：`nowDate - 365 天`、`nowDate - 1 个月`（日历月减法，1月31日→12月31日边界规则进用例表）；比较用 `localDayKey(createdAt) === localDayKey(targetDate)`。
- 过滤：标注需 `relativePath` 存在于当前 documents（改名失联跳过）；tombstone（deletedAt）跳过；文档档要求当日会话合计 ≥300s 且去重。
- 排序：标注按 createdAt 升序（当天时间线感）。

### 3.2 数据接线与呈现

- HomeView 挂载时（桌面）并行取：全库标注（App 已有全库标注数据流则复用，否则一次 `listAnnotations()`）+ 两个目标日各一次 `listReadingSessions(dayStart, dayEnd)`（窄窗口查询，量小）。
- 卡片样式沿主页既有卡（section + 列表行 + 徽标）；组标题右侧灰字显示具体日期（如"2025年8月13日"）。
- Web：仅标注档（sessions 传空数组），其余同构。

### 3.3 性能

- 标注全库一次载入在标注中枢已是既有量级；会话查询限定两个单日窗口。主页首帧不阻塞：卡片数据 useEffect 异步填充，加载中不渲染（与今日回顾卡模式一致）。

## 4. 改动清单（预估）

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/onThisDay.ts`（新）+ 测试 | 分组/过滤/日历边界纯函数 | M |
| 2 | `src/components/HomeView.tsx` | 新卡 + 数据接线 + 跳转 | M |
| 3 | `src/App.tsx` | 标注跳转链暴露给主页（若尚未） | S |
| 4 | `src/App.css`、`docs/USER_GUIDE.md` | 样式 + 文档 | S |

## 5. 验收标准（草案级）

- [ ] 纯函数测试：日历月边界（1/31→12/31、3/31→2/28、闰年 2/29）、时区日界（23:59 创建的标注归属正确）、失联/tombstone 过滤、300s 门槛、3 条封顶与补充逻辑、两组皆空返回 []。
- [ ] 组件测：空数据整卡不渲染；标注行点击调用跳转链参数正确。
- [ ] 运行时：构造一年前/一月前时间戳的测试数据（sqlite 手插或临时改系统时钟均可，方式记录在验收注记）验证展示与跳转；明/暗截图。
- [ ] Web：仅标注档正常；回归 `pnpm test`、`tsc --noEmit`。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| OD-D1 | 数据档位 | **标注优先、会话文档补位**（标注是更强的"当时在想什么"信号） | 只标注（新用户长期空卡）；只会话（信息弱） |
| OD-D2 | 时间窗 | **精确当日（本地日历日）** | ±1 天模糊窗（"今日"语义被稀释，且逻辑复杂化） |
| OD-D3 | 空态 | **整卡不显示**（HomeView 既有先例，不给用户看空壳） | 显示"暂无回忆"占位（噪音） |
| OD-D4 | 月减法边界 | **日历月钳制（31→当月末日）**（Date setMonth 原生行为会溢出到下月，需修正并测试锚定） | 固定 30 天（"一个月前"语义漂移） |

## 7. 风险

- 依赖数据积累：新库前 30 天此卡恒空——整卡隐藏使其零成本；无需为演示造假数据。
- 标注 `relativePath` 因文档改名失联时条目消失（而非跳错）：与合集 missing 同语义，可接受；若"检测移动文档"（`detect_moved_documents` 已有）日后接入主页，可自动愈合。
- 验收需要历史时间戳数据，人工构造步骤必须写进验收注记，防"看起来没坏其实没测"。
