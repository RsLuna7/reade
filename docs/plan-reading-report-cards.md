# 方案草案：年度/月度阅读报告卡片（本地 Wrapped）

- 日期：2026-08-13（基线查证日）
- 状态：**草案（实施前需复核基线行号并升级定稿）**
- 定位：完全本地的"年度/月度阅读报告"：总时长/活跃天数/最长连续纪录/读得最久的书/划线最多的书/年度金句等，渲染为一组精致 PNG 卡片，可复制/下载。数据不出网，仪式感拉满。
- 关联：canvas 渲染与主题取色完全复用金句卡片管线（`docs/plan-quote-cards.md` 的 `quoteCard.ts`/`quoteCardLayout.ts`，含 17-token 主题契约）；数据聚合复用 `readingStats.ts` 纯函数族；入口放阅读统计视图（桌面专属，与 stats 现状一致）。

> 一句话：`buildReadingReport(sessions, annotations, range) → ReportData` 纯函数聚合指标；`renderReportCards(data, theme) → Blob[]` 在 `quoteCard.ts` 旁新增 3-4 张固定版式卡（总览 / 习惯 / 书单 / 金句）的 canvas 绘制，取色走 `readCardTheme` 同一契约；StatsView 头部新增"生成报告"入口（年度/月度二选一），预览对话框沿 `QuoteCardDialog` 的复制/下载出口。零后端、零新依赖。

---

## 1. 现状基线（已核实于 2026-08-13，行号允许漂移）

| 事实 | 位置 |
|------|------|
| 金句卡管线：`CARD_WIDTH = 720` 逻辑宽、`CARD_EXPORT_SCALE = 2`、`readCardTheme` 读 `--paper/--ink/--accent` 等 token（17-token 契约）、`drawQuoteCard/renderQuoteCard` 绘制 | `src/lib/quoteCardLayout.ts` L73；`src/lib/quoteCard.ts` L32、L59-82、L176-260 |
| 出口：`copyImageToClipboard(blob)` + `downloadBlobFile`（object URL + a[download]） | `src/lib/quoteCard.ts` L294-320；`src/lib/fileTransfer.ts` L12-27 |
| 预览对话框先例：`QuoteCardDialog`（blob objectURL 预览 + 下载/复制按钮） | `src/components/QuoteCardDialog.tsx` L69-70、L157-174 |
| 统计聚合纯函数族：`buildSummary`（totalSeconds/activeDays/currentStreak/longestStreak）、`aggregateByDocument`、`aggregateByHour`、`weekdayHourMatrix`、`buildTrendSeries`、`formatDuration` | `src/lib/readingStats.ts` L214-252、L152-164、L442-449 |
| 会话原始数据：`list_reading_sessions(from,to)`（StatsView 已有全量加载模式） | `src/components/StatsView.tsx` L549-584 |
| 划线数据：全库标注可查（kind/color/createdAt/selectedText） | `src/lib/backend.ts` L170-189 |
| StatsView 头部已有操作区（每日目标 / 导出 CSV·JSON / 刷新）——"生成报告"是同区第四钮 | `src/components/StatsView.tsx` L768-867 |
| 统计视图桌面专属（`!IS_WEB_RUNTIME`） | `src/App.tsx` L1239-1242 |
| 主题四系列 × 明暗，卡片随当前主题取色（金句卡先例） | `src/lib/themes.ts` L12-17 |

## 2. 目标与非目标

**目标**

1. 入口：StatsView 头部"生成报告"→ 选择范围（本月 / 今年 / 上一年，数据不足 7 个活跃天则禁用并提示）。
2. 固定四张卡（720×~900 逻辑px，2× 导出）：
   - **总览卡**：总时长、活跃天数、最长连续、文档数、对比上期百分比；
   - **习惯卡**：最常阅读时段（weekdayHourMatrix 峰值）、最长单日、格式占比；
   - **书单卡**：读得最久 Top3（时长）+ 划线最多 Top3（标注计数）；
   - **金句卡**：该期内被"做成卡片/划线"最长的摘录一条（无标注则此卡跳过）。
3. 预览对话框内可逐张切换、单张复制、"全部下载"（逐张触发既有下载出口，文件名 `reade-report-2026-总览.png` 式）。
4. 取色随当前主题（明暗/四系列），版式为策展固定两档之一（沿金句卡"素笺"骨架延伸）。

**非目标（明确不做）**

- 不做社交分享集成（复制/下载即出口，符合"不上传"红线）。
- 不做自定义指标/拖拽排版（策展式固定版式）。
- 不做 Web 版（无统计数据源；与 stats 视图边界一致）。
- 不做 GIF/动画卡（PNG 静态即可）。
- 不持久化报告（随点随生成，数据源就在本地）。

## 3. 设计

### 3.1 数据聚合（`src/lib/readingReport.ts` 新建）

```ts
export type ReportRange = { kind: "month" | "year"; startMs: number; endMs: number; label: string };
export function buildReadingReport(input: {
  sessions: ReadingSession[]; annotations: Annotation[]; documents: DocumentInfo[]; range: ReportRange;
}): ReadingReportData | null    // 活跃天 < 7 返回 null
```

- 全部复用 `readingStats` 既有聚合（buildSummary 限定 range、aggregateByDocument 取 Top、weekdayHourMatrix 峰值格）；对比上期 = 同长度前移窗口再算一次。
- 金句挑选：range 内 createdAt 的高亮/下划线中 `selectedText` 最长者（与 cloze 的"长度≈显著"同一朴素启发）。

### 3.2 渲染（`src/lib/reportCards.ts` 新建，与 `quoteCard.ts` 并列）

- 每张卡一个 `drawXxxCard(ctx, data, theme, scale)`；排版原语（标题行、大数字、分隔线、来源行）抽小工具与 `quoteCard.ts` 共享（若共享需小幅重构导出，注意不改其对外 API）。
- 数字动效无（静态 PNG）；字体沿 canvas 可用的系统字体栈（金句卡同款）。
- `renderReportCards(data, theme): Promise<{ title: string; blob: Blob }[]>`。

### 3.3 UI

- `ReportDialog`（懒加载）：范围选择 → 生成（loading）→ 横向缩略切换 + 大图预览 + 复制/下载/全部下载；Esc 关闭。

## 4. 改动清单（预估）

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/readingReport.ts`（新）+ 测试 | 聚合与上期对比 | M |
| 2 | `src/lib/reportCards.ts`（新） | 四张卡 canvas 绘制 | M-L |
| 3 | `src/components/ReportDialog.tsx`（新）+ StatsView 接线 | 入口与预览 | M |
| 4 | `src/App.css`、`docs/USER_GUIDE.md` | 对话框样式 + 文档 | S |

## 5. 验收标准（草案级）

- [ ] 聚合测试：range 边界（跨年/闰月）、上期对比、活跃天不足返回 null、Top3 并列决胜、金句挑选。
- [ ] 运行时：真实数据生成年度/月度各一组；四系列 × 明暗抽查 4 组取色正确；复制到剪贴板与下载文件均可打开；2× 导出清晰度检查。
- [ ] 空档回退：无标注时金句卡缺席、其余三张正常。
- [ ] 回归：金句卡片功能不回归（若共享了排版原语）；`pnpm test`、`tsc --noEmit`。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| RC-D1 | 卡片组构成 | **固定四张（总览/习惯/书单/金句）** | 单张长图（信息过载、复制场景差）；可勾选生成（配置面膨胀） |
| RC-D2 | 与金句卡的代码关系 | **共享排版原语小工具，卡片绘制各自独立**（避免把金句卡改成"通用卡片框架"的过度抽象） | 抽通用 CardRenderer 框架（premature abstraction，否） |
| RC-D3 | 入口范围 | **本月/今年/上一年 三档** | 任意区间选择器（配置面大，Wrapped 语义是"固定周期"） |
| RC-D4 | 数据门槛 | **活跃天 ≥7 才可生成**（防空报告尴尬） | 无门槛（新用户生成一张空卡，体验差） |

## 7. 风险

- canvas 排版是纯手工坐标活，四张卡的明暗 × 四系列 = 8 组视觉验收工作量不小：验收矩阵先写死在方案里，实施按矩阵逐格截图。
- "17-token 契约"若因主题演进而变化，金句卡与报告卡需同步——两者读同一 `readCardTheme`，单点维护，风险可控。
- 长书名/长金句的截断与换行是 canvas 绘制的经典坑：排版原语必须带 `ellipsize(text, maxWidth)` 与逐行断行工具并配单测。
