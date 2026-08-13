# 方案定稿：阅读时间预估

- 日期：2026-08-13（基线查证日；同日复核基线并定稿）
- 状态：**定稿（批次 2 实施）**
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
export const DEFAULT_CHARS_PER_MINUTE = 500;               // TE-D3
export const READING_SPEED_CLAMP = [150, 2000];            // TE-D1
export const CALIBRATION_MIN_SAMPLES = 5;
export const CALIBRATION_MIN_ACTIVE_SECONDS = 120;
export const CALIBRATION_MIN_COVERAGE = 0.15;
export interface ReadingSpeed { charsPerMinute: number; samples: number; calibrated: boolean }
export function calibrateReadingSpeed(input: {
  activeSecondsByPath: ReadonlyMap<string, number>;   // 90 天会话按文档聚合
  charsByPath: ReadonlyMap<string, number>;           // extents 字符数
  coverageByPath: ReadonlyMap<string, number>;        // 0..1 高水位
}): ReadingSpeed
export function highWaterCoverage(position, pageCount?): number | null   // scroll→maxScrollRatio；pdf→maxPage/pageCount
export function extentSupportsEstimate(extent): boolean   // needs_ocr 段占比 >50% 不出徽标（TE-D5）
export function estimateReadingMinutes(chars: number, cpm: number): number   // ceil, ≥1
export function estimateRemainingMinutes(extent, progress, cpm): number | null // 读完/无数据 → null
export function formatReadingEstimate(minutes: number): string   // "1 分钟内 / 约 N 分钟 / 约 N 小时"
export function formatRemainingEstimate(minutes: number): string // "剩余不足 1 分钟 / 剩余约 N 分钟…"
```

- 每文档速度样本 = `(chars × coverage) / (activeSeconds / 60)`；过滤 coverage < 0.15 或 activeSeconds < 120 或 chars ≤ 0 的噪声样本；样本 <5 回退默认；中位数输出并 clamp 到 [150, 2000] 字/分钟防坏数据。

### 3.2 数据接线（决策 2：契约与批次七 coverage-treemap 共享）

- 新 command `list_document_extents() → Vec<DocumentExtent>`，`DocumentExtent = { relativePath, charCount, segmentCount, needsOcrSegments }`：对 `search_segments` 一次 GROUP BY 聚合，零文件访问、不返回正文。字段为 treemap 预留：`charCount` 是 treemap 的瓦片面积基数，`segmentCount` 对 PDF 即页数（覆盖率 = maxPage/segmentCount 双方案共用），`needsOcrSegments` 供两方案过滤扫描版。
- 会话：进库后一次 `listReadingSessions(now-90d, now)`，前端按 path 聚合（与 StatsView 的加载模式一致，量级可控）。
- 缓存：extents 存 App state（React），随 snapshot 变化与索引完成事件重取（`indexProgress` 完成 → 重取一次，覆盖后台增量索引尚未完成时打开库的场景）；速度每库计算一次。
- Web：`WebLibraryClient.documentExtents()` 从 `search.json` 内容长度合成（segmentCount=1、needsOcr=0），默认速度、无个人校准。

### 3.3 展示

- 树条目：右侧灰字 `约 12 分钟`（窄窗 1180 断点以下隐藏，避免挤压标题）；经 `estimateForPath` prop 注入，DocumentTree 保持展示组件。
- 主页继续阅读：`剩余约 N 分钟 = estimate(charCount × (1 - coverage))`；PDF 覆盖率 = maxPage/segmentCount；读完（剩余 0）不显示。
- 目录面板顶部一行：`全文约 N 分钟 · 个人速度已校准`（未校准时不带后缀）；TocNavigation 增加可选 `estimateLine` prop，不传时 DOM 与现状逐字节一致（既有兼容契约测试保障）。

## 4. 改动清单（预估）

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/readingTimeEstimate.ts`（新）+ 测试 | 校准与预估纯函数 | M |
| 2 | `src-tauri/src/library.rs` + `lib.rs` + `backend.ts` | `list_document_extents`（若 treemap 未先行） | S-M |
| 3 | `src/components/DocumentTree.tsx`、`HomeView.tsx`、TocNavigation（App.tsx） | 三处徽标 | M |
| 4 | `src/App.css`、`docs/USER_GUIDE.md` | 样式 + 文档 | S |

## 5. 验收标准（定稿）

- [x] 纯函数测试：中位数抗离群、样本不足回退默认、clamp 边界、coverage 折算、格式化（<1min / 小时档）、OCR 占比过滤、剩余时长。
- [x] Rust 测试：extents 聚合（字符数/段数/OCR 计数、按库隔离）。
- [x] 组件测：树条目徽标、继续阅读卡剩余时长、目录顶部行与"已校准"后缀、TocNavigation 无 prop 时逐字节兼容。
- [x] 回归：`pnpm test`、`tsc --noEmit`、`cargo test`、`cargo clippy`。
- [ ] 运行时（人工，桌面）：新库冷启动显示默认速度预估；累计若干阅读后徽标数字变化（校准生效）。
- [ ] Web：默认速度徽标正常；窄窗（1180 以下）树徽标隐藏；明/暗截图。

## 6. 决策点（已定）

| # | 决策 | 结论 |
|---|------|------|
| TE-D1 | 速度统计量 | **中位数 + clamp [150, 2000]**（个人库样本少、离群多） |
| TE-D2 | 有效字符量 | **chars × 高水位覆盖率**（读一半只记一半）；PDF 覆盖率 = maxPage / segmentCount |
| TE-D3 | 默认速度 | **500 字/分钟**（CJK 阅读经验中值，常量导出可调） |
| TE-D4 | 展示位置 | **树 + 主页 + 目录顶部** 三处 |
| TE-D5 | 扫描版 PDF | **needs_ocr 段占比 >50% 的文档不显示徽标**（字符数严重失真时宁缺毋滥） |
| TE-D6 | extents 契约 | **`list_document_extents` 按决策 2 与批次七 coverage-treemap 共享**：charCount（treemap 面积基数）、segmentCount（PDF 页数/覆盖率分母）、needsOcrSegments（双方过滤扫描版） |

## 7. 风险

- 速度校准对"开着文档挂机"型用户失真：idle 60s 已过滤大头，中位数 + clamp 兜底；文案用"约"字并在 USER_GUIDE 说明估算性质。
- PDF 扫描版（needsOcr 页）字符数偏低 → 预估偏短：接受为已知偏差，OCR 页占比高的文档可在定稿时选择不显示徽标。
- 树条目多一列文本对最窄布局的挤压：1180 断点以下隐藏已缓解，截图验收把关。
