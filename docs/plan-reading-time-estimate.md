# 方案草案：阅读时间预估

- 日期：2026-08-13（基线查证日）
- 状态：**草案（实施前需复核基线行号并升级定稿）**
- 定位：在文档树条目、主页卡片、目录条目显示"约 N 分钟"。速度先用默认值冷启动，随个人阅读数据（`reade-stats.sqlite3` 的 activeSeconds ÷ 已读字符量）自动校准。
- 关联：字符数数据与库覆盖率地图（`docs/plan-coverage-treemap.md`）共享同一 `list_document_extents` 新契约；个人速度校准依赖阅读统计会话（`record_reading_session` 既有链路）与 `readingPositions` 高水位。

> 一句话：`estimateReadingMinutes(chars, speed)` 与 `calibrateReadingSpeed(sessions, extents, positions)` 两个纯函数——后者用"每文档 activeSeconds 合计 ÷ (字符数 × 高水位覆盖率)"的中位数得出个人字符/分钟速度（样本不足回退默认 500 字/分钟）；字符数走 `list_document_extents`，结果内存缓存；树/主页/目录三处渲染徽标。

---

## 1. 现状基线（已核实于 2026-08-13，行号允许漂移）

| 事实 | 位置 |
|------|------|
| `DocumentInfo` 无字数字段（只有 size 字节）——**字符数需从 `search_segments` 聚合**（treemap 方案同一 command） | `src-tauri/src/library.rs` L76-84、L1136-1148 |
| 阅读会话：`ReadingSession { relativePath, format, startedAt, endedAt, activeSeconds }`，`list_reading_sessions(from,to)` 区间查询；Rust 无聚合 | `src-tauri/src/stats.rs` L32-40、L84-96 |
| 会话采集纪律：idle 60s、30s 落盘、最短 5s，仅桌面（`recordReadingSession` web 不可用） | `src/lib/readingTracker.ts` L49-52；`src/lib/backend.ts` L678-684 |
| 高水位覆盖率：`maxScrollRatio` / `maxPage`，全库一次可取 | `src/lib/readingPositions.ts` L20-40、L165-169 |
| 主页继续阅读卡已有"进度"展示（`progressFromPosition`）——时间徽标是同卡片的字段追加 | `src/lib/homeData.ts` L42-48；`src/components/HomeView.tsx` L200-327 |
| 树行结构 `button.document-tree__item`（标题+格式徽标）；目录条目在 TocNavigation | `src/components/DocumentTree.tsx` L177-209 |
| 时长格式化先例 `formatDuration` | `src/lib/readingStats.ts` L442-449 |
| Web 端：无 sessions；`search.json` 有全文 content 可数字符 | `src/lib/webLibrary.ts` L43-52 |

## 2. 目标与非目标

**目标**

1. 文档树条目 hover/常显"约 N 分钟"（<1 分钟显示"1 分钟内"，>3 小时显示"约 N 小时"）；主页继续阅读卡显示"剩余约 N 分钟"（按 1-覆盖率 折算）；目录面板顶部显示全文预估。
2. 个人速度校准：取近 90 天会话，按文档聚合 activeSeconds，配对该文档字符数 × 高水位得"有效读过字符"；样本 ≥5 篇且每篇 ≥120s 才启用个人速度（**中位数**抗离群），否则默认 500 字/分钟（CJK 经验值，常量导出）。
3. 纯函数 + 内存缓存（extents 已由 treemap 契约缓存；速度每次进库算一次）。
4. Web 端：默认速度 + `search.json` content 长度，无个人校准（无会话数据）。

**非目标（明确不做）**

- 不区分格式速度（PDF 扫描版 activeSeconds 对应字符数失真，统一速度 + 中位数已够稳健；留远期）。
- 不做逐章节剩余时间（目录条目级预估只按标题间字符数比例粗分，本期只做全文级）。
- 不持久化速度值（每次会话内重算，数据源本就本地）。
- 不在 Rust 端做速度计算（聚合逻辑归前端纯函数，Rust 只供原始数据——与 stats 现状分工一致）。

## 3. 设计

### 3.1 纯函数（`src/lib/readingTimeEstimate.ts` 新建）

```ts
export const DEFAULT_CHARS_PER_MINUTE = 500;
export function calibrateReadingSpeed(input: {
  sessionsByPath: Map<string, number>;      // activeSeconds 合计
  extents: Map<string, number>;             // 字符数
  coverage: Map<string, number>;            // 0..1 高水位
}): { charsPerMinute: number; samples: number; calibrated: boolean }
export function estimateReadingMinutes(chars: number, cpm: number): number   // ceil, ≥1
export function formatEstimate(minutes: number): string
```

- 每文档速度样本 = `(chars × coverage) / (activeSeconds / 60)`；过滤 coverage < 0.15 或 activeSeconds < 120 的噪声样本；中位数输出并 clamp 到 [150, 2000] 字/分钟防坏数据。

### 3.2 数据接线

- extents：复用/等待 `list_document_extents`（若 treemap 方案未先行，本方案自带该 command，两方案实施时合并为一）。
- 会话：进库后一次 `listReadingSessions(now-90d, now)`，前端按 path 聚合（与 StatsView 的加载模式一致，量级可控）。
- 缓存：`Map` 挂 module 级 + `library-changed`/refresh 失效；树条目徽标从缓存同步读取，未命中显示占位省略（不闪烁）。

### 3.3 展示

- 树条目：右侧灰字 `约 12 分钟`（窄窗 1180 断点以下隐藏，避免挤压标题）。
- 主页继续阅读：`剩余约 N 分钟 = estimate(chars × (1 - coverage))`。
- 目录面板顶部一行：`全文约 N 分钟 · 个人速度已校准`（未校准时不带后缀）。

## 4. 改动清单（预估）

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/readingTimeEstimate.ts`（新）+ 测试 | 校准与预估纯函数 | M |
| 2 | `src-tauri/src/library.rs` + `lib.rs` + `backend.ts` | `list_document_extents`（若 treemap 未先行） | S-M |
| 3 | `src/components/DocumentTree.tsx`、`HomeView.tsx`、TocNavigation（App.tsx） | 三处徽标 | M |
| 4 | `src/App.css`、`docs/USER_GUIDE.md` | 样式 + 文档 | S |

## 5. 验收标准（草案级）

- [ ] 纯函数测试：中位数抗离群、样本不足回退默认、clamp 边界、coverage 折算、格式化（<1min / 小时档）。
- [ ] 运行时（桌面）：新库冷启动显示默认速度预估；累计若干阅读后徽标数字变化（校准生效，devtools 打印 charsPerMinute 佐证）。
- [ ] Web：默认速度徽标正常。
- [ ] 窄窗（1180 以下）树徽标隐藏；明/暗截图；全套回归。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| TE-D1 | 速度统计量 | **中位数 + clamp**（个人库样本少、离群多） | 平均值（一次挂机会话即污染）；EWMA（顺序敏感、难测） |
| TE-D2 | 有效字符量 | **chars × 高水位覆盖率**（读一半只记一半） | 全文 chars（把"翻了翻"当"读完"，速度虚高） |
| TE-D3 | 默认速度 | **500 字/分钟**（CJK 阅读经验中值，常量可调） | 按语言探测分默认值（探测不可靠，留远期） |
| TE-D4 | 展示位置 | **树 + 主页 + 目录顶部** 三处 | 加书架角标（等书架方案落地再接） |

## 7. 风险

- 速度校准对"开着文档挂机"型用户失真：idle 60s 已过滤大头，中位数 + clamp 兜底；文案用"约"字并在 USER_GUIDE 说明估算性质。
- PDF 扫描版（needsOcr 页）字符数偏低 → 预估偏短：接受为已知偏差，OCR 页占比高的文档可在定稿时选择不显示徽标。
- 树条目多一列文本对最窄布局的挤压：1180 断点以下隐藏已缓解，截图验收把关。
