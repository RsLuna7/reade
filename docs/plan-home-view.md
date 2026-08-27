# 实施方案:今日视图(阅读主页)

> **部分被取代**：主页不再承载间隔回顾入口；到期队列改由 [`plan-annotation-system-redesign.md`](./plan-annotation-system-redesign.md) 的命令面板 / 全库摘录进入。本文其余主页卡片仍有效。

- 日期:2026-08-12
- 状态:**已实施**（`079f02a` 接线 `HomeView`；勿再按「未实施」施工）
- 定位:打开 Reade 后第一眼看到的"从哪继续读"聚合页。与统计视图的分工:统计回答"我读了多少"(回顾),今日视图回答"我现在读什么"(行动)。
- 关联:今日视图是「批注回顾」(`docs/plan-annotation-review.md`)的宿主入口;其 H0 里程碑(阅读位置持久化)是「热力目录」T2(已读覆盖标记)的前置。

> 一句话:不新增任何数据采集,把已有的阅读会话、逐文档进度、文档 `modified`、每日目标组装成一个"继续阅读 + 今日进度 + 库内新动态 + 今日回顾"的主页,并顺带补上"跨重启恢复阅读位置"这块地基。

---

## 1. 现状基线(全部【已核实】于本仓库源码)

| 事实 | 位置 |
|------|------|
| 视图路由只有 `ReaderView = "reader" \| "stats"`,session-only 不持久化;`setActiveView` 是白名单归一(`view === "stats" ? "stats" : "reader"`) | `src/store/useReaderStore.ts` L64-65、L520-522 |
| 冷启动流程:恢复上次库(localStorage `reade-last-library`)→ `documents.length > 0 && !currentPath && !loading` 时**自动打开第一篇文档** | `src/App.tsx` L1896-1905、L1989-2004 |
| `selectDocument` 内部固定 `activeView: "reader"`——从任何视图点开文档都会回到阅读面 | `src/store/useReaderStore.ts` L370-390 |
| 逐文档滚动位置存在 `useRef(new Map())`,**仅会话内有效,重启即丢**;恢复逻辑在 `useLayoutEffect`(`scrollTop = map.get(path) ?? 0`) | `src/App.tsx` L914、L2109-2119、L2148-2155 |
| PDF 有自己的位置恢复通道 `pdfReaderHandleRef.current.restorePosition({page, offsetRatio})`(书签跳转已用) | `src/App.tsx` L1227-1231 |
| 阅读会话桌面独占:`recordReadingSession`/`listReadingSessions(fromMs, toMs)` 走 Tauri,Web 构建直接 reject;存储 `reade-stats.sqlite3`(schema v1,additive-only,`sessions_by_time` 索引) | `src/lib/backend.ts` L363-371;`src-tauri/src/stats.rs` L110-148 |
| 聚合纯函数齐备:`aggregateByDocument`(含 `lastReadAt`)、`buildSummary`(今日/7日/streak)、`formatDuration` 等 | `src/lib/readingStats.ts` |
| `dailyGoalMinutes` 已存在且持久化(0 = 关闭) | `src/store/useReaderStore.ts` L90-101、L562 |
| `DocumentInfo.modified` 两端都有:桌面来自扫描,Web manifest 逐条校验 `modified` 为有限数字;注意单位歧义(`formatModified` 以 `< 10^10` 判定秒/毫秒) | `src/lib/backend.ts` L15-23;`src/lib/webLibrary.ts` L132-133;`src/App.tsx` L145-147 |
| 统计视图的挂载模式:`statsOpen` 时 `content-grid` 加 `hidden`、`<StatsView/>` lazy 挂载;阅读器保持挂载不卸载 | `src/App.tsx` L2540-2541、L2643-2654 |
| 统计入口按钮在侧栏 footer `.theme-controls`(仅桌面显示) | `src/App.tsx` L2395-2409 |
| 打开统计视图会结束当前阅读会话(tracker.openDocument(null)) | `src/App.tsx` L988-1003 |

## 2. 目标与非目标

**目标**

1. 新增 `home` 视图:继续阅读、今日进度、库内新动态、今日回顾四张卡片,桌面/Web 双端可用(Web 降级)。
2. 阅读位置跨重启持久化(localStorage),点"继续阅读"能回到上次读到的位置。
3. 桌面冷启动默认落在今日视图(有历史时),取代"自动打开第一篇"。

**非目标(明确不做)**

- 不新增任何数据采集(无新埋点、无 per-section 停留追踪)。
- 不做推荐算法、每日阅读计划编排、番茄钟。
- 不把 home 做成第二个统计页——图表留在 StatsView,home 只放"下一步动作"。
- 不动 CSP、capabilities、IPC 安全边界;本方案**零 Rust 改动**。

## 3. 设计

### 3.1 视图路由

- `ReaderView` 扩为 `"home" | "reader" | "stats"`;`setActiveView` 白名单同步扩展,非法值仍落 `"reader"`。
- `activeView` 保持 session-only 不持久化(现状语义)。
- 挂载模式照抄 stats:`homeOpen = activeView === "home"`,`content-grid` 在 `statsOpen || homeOpen` 时 `hidden`,`<HomeView/>` lazy 挂载。
- 入口:侧栏 footer `.theme-controls` 新增「主页」按钮(lucide `House`),置于统计按钮左侧;**两端都显示**(统计按钮维持桌面独占)。`aria-pressed` 语义与统计按钮一致。
- home 打开时同样结束阅读会话(复用 `statsOpen` 的 tracker 分支,条件改为 `activeView !== "reader"`)。

### 3.2 阅读位置持久化(H0,独立可合)

新模块 `src/lib/readingPositions.ts`(纯函数 + localStorage 封装):

```ts
// localStorage key: "reade-reading-positions",版本信封 {version: 1, libraries: {...}}
type ReadingPosition =
  | { kind: "scroll"; scrollRatio: number; maxScrollRatio: number; updatedAt: number }   // markdown/epub
  | { kind: "pdf"; page: number; offsetRatio: number; maxPage: number; updatedAt: number };
// libraries: Record<libraryRoot, Record<relativePath, ReadingPosition>>
```

- 写入:复用 `handleReaderScroll` 已有的 rAF 节流管道,追加"落 localStorage"支路(再加 500ms trailing debounce,避免每帧写储存);PDF 走 `pdfReaderHandleRef.getPosition()`。`maxScrollRatio`/`maxPage` 单调递增,供"读到 62%"展示与热力目录 T2 使用。
- 恢复:现有 `useLayoutEffect` 优先会话内 Map(精确 scrollTop);未命中时查持久化条目——scroll 类按 `scrollRatio × (scrollHeight − clientHeight)` 恢复,pdf 类走 `restorePosition`(PDF 页懒加载,失败时复用书签跳转的重试机制)。
- 防御:每库 LRU 上限 200 条(按 `updatedAt` 淘汰);读取时逐字段校验类型与 0..1 区间,非法条目静默丢弃;`JSON.parse` 全程 try/catch。
- 键:`snapshot.rootPath` 原样作库键(Web 为 manifest title,单库场景可接受)。
- 明确权衡:`scrollRatio` 在字号/窗口变化后只有近似精度——接受,书签才是精确锚(与 `BookmarkTarget` 的"派生显示值"定位一致,见 `src/lib/backend.ts` L109-116 注释)。

### 3.3 四张卡片

新组件 `src/components/HomeView.tsx`(lazy)+ 纯函数 `src/lib/homeData.ts`(全部可单测):

| 卡片 | 数据源 | 桌面 | Web |
|------|--------|------|-----|
| ① 继续阅读 | `listReadingSessions(now−30d, now)` → `aggregateByDocument` → 过滤"仍在当前库文档列表中"→ 按 `lastReadAt` 取前 5;每条显示标题、格式徽标、相对时间、累计时长、进度百分比(来自 3.2 的 `maxScrollRatio`/`maxPage`) | ✓ | 降级:按持久化位置条目的 `updatedAt` 排序取前 5(无时长) |
| ② 今日进度 | 今日 sessions → `buildSummary`:今日已读时长 + `dailyGoalMinutes` 目标环 + 当前 streak;目标为 0 时只显示时长 | ✓ | 隐藏 |
| ③ 库内新动态 | `documents` 中 `modified > baseline` 的条目(计数 + 前 5),baseline = 上次访问 home 的时间戳(localStorage `reade-home-baseline`,按库键控);离开 home 时推进 baseline | ✓ | ✓ |
| ④ 今日回顾 | 待回顾批注数 + 「开始回顾」入口;数据接口由 `docs/plan-annotation-review.md` 提供 | ✓ | ✓ |

- 卡片全部是可点击行:①点击 → `selectDocument(path)`(store 已自动切回 reader);③点击同理;④进入回顾视图。
- ④ 的实施顺序解耦:本方案先落卡片骨架,回顾方案未合入时该卡整体隐藏(以 feature 探测函数隔离,不留死 UI)。
- 空态:无库 → 不进 home(Welcome 现状);有库无历史 → ①显示引导文案("从左侧选择一篇文档开始"),②③正常。
- `modified` 单位:比较前按 `formatModified` 的同一规则归一为毫秒,单测覆盖秒/毫秒两种输入。

### 3.4 冷启动落点(决策点 H-D1)

- 推荐 **A**:桌面冷启动,若「继续阅读」有候选(持久化位置或 30 天内会话非空)→ 落在 home 且**不自动打开第一篇**;无候选时维持现状。Web 保持现状不变(`?doc=` 分享路由必须直达文档,home 不得拦截)。
- 备选 B:一切照旧,home 仅手动进入(最保守,少一步惊喜也少一步价值)。
- 备选 C:桌面冷启动改为"自动打开上次阅读的文档"(跳过 home,直接续读)。
- 实现上 A 只改 `App.tsx` L1989-2004 的自动打开 effect:候选存在时置 `activeView: "home"` 并跳过 `selectDocument`。

### 3.5 视觉与动效

- 复用现有 token 与组件语言:卡片用 `--paper-raised` + `--shadow`,徽标沿用 `annotation-list-kind`/stats 的既有样式模式;**零新增 token**(AppCss 测试契约不动)。
- 入场动效走 `reade-motion-panel`/`runMotion` 既有等级体系;`motionLevel === "off"` 时无动画。
- 响应式:卡片网格 `repeat(auto-fit, minmax(280px, 1fr))`,≤640px 单列;侧栏抽屉行为不变。

## 4. 改动清单(预估)

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/readingPositions.ts`(新)+ 测试 | 位置持久化模块 | S-M |
| 2 | `src/App.tsx` | 写入/恢复接线、home 挂载、footer 入口、冷启动分支 | M |
| 3 | `src/lib/homeData.ts`(新)+ 测试 | 继续阅读/新动态/进度聚合纯函数 | S |
| 4 | `src/components/HomeView.tsx`(新)+ 测试 | 视图组件 | M |
| 5 | `src/store/useReaderStore.ts` + 测试 | `ReaderView` 扩展 | S |
| 6 | `src/App.css` | 卡片样式 | S |
| 7 | `docs/USER_GUIDE.md` | 「主页」一节 | S |

里程碑:**H0** 位置持久化(独立验收、独立可合)→ **H1** home 骨架 + ①③卡 + 入口 → **H2** ②卡 + 冷启动落点 + 视觉打磨 + 文档。④卡随回顾方案合入。

## 5. 验收标准

**H0(位置持久化)**

- [ ] 单测(`readingPositions.test.ts`):写入/读取往返;LRU 到 201 条淘汰最旧;非法 JSON、越界 ratio、未知 kind 全部安全丢弃;秒/毫秒 `updatedAt` 不混淆。
- [ ] 运行时(桌面):打开长文档滚到中部 → 完全退出应用 → 重启 → 打开同文档,恢复位置与离开点偏差 ≤ 视口高度的 5%;PDF 恢复到同一页(±0 页);EPUB 恢复偏差 ≤ 5%。
- [ ] 运行时(Web):`pnpm dev:web` 刷新页面后位置同样恢复。
- [ ] 回归:会话内切换文档再切回,行为与现状完全一致(会话 Map 优先级高于持久化)。

**H1(视图骨架)**

- [ ] 单测(`homeData.test.ts`):继续阅读过滤已删除文档;30 天窗口边界;新动态的秒/毫秒 `modified` 归一;baseline 推进后计数清零;空库/空历史空态分支。
- [ ] 组件测:footer 按钮切换 `activeView`;点击继续阅读卡触发 `selectDocument` 且视图回到 reader;卡片可 Tab 聚焦、Enter 激活;Web 构建下②卡不渲染、无 Tauri 调用(测试断言 `listReadingSessions` 未被调用)。
- [ ] 运行时:home 打开/关闭往返,阅读器状态(滚动位置、选中文档)无丢失。

**H2(完成态)**

- [ ] 冷启动矩阵人工验证:桌面「有历史/无历史」×「H-D1 选定行为」;Web `?doc=` 直达不受影响;桌面 home 停留时不产生阅读会话(查 `reade-stats.sqlite3` 佐证)。
- [ ] 目标环:`dailyGoalMinutes = 0` 时不显示环;达标当日视觉状态正确。
- [ ] 视觉走查:明/暗 × 宽(1280)/窄(720)≥ 4 张截图,含卡片空态;与统计视图并排无风格断裂。
- [ ] 全量回归:`pnpm test`、`pnpm exec tsc --noEmit` 通过;`pnpm build` 与 `pnpm build:web` 成功;Rust 侧零改动(不跑也需说明)。
- [ ] `docs/USER_GUIDE.md` 新增章节并截图。

## 6. 风险与开放问题

- localStorage 写入频率:滚动 debounce 500ms 后仍是高频路径,验收时用 Performance 面板确认无长帧(与现状对比)。
- `modified` 在部分文件系统上精度粗(FAT 2s)——新动态卡只做提示不做强一致,可接受。
- H-D1 若选 A,「打开就看到主页」对肌肉记忆是行为变更,USER_GUIDE 与首次进入时的一次性提示要写清楚回到阅读面的路径(点任意卡片或侧栏文档)。
