# 实施方案:批注间隔重复回顾

- 日期:2026-08-12
- 状态:**方案定稿,未实施**
- 定位:Readwise Daily Review 的本地版——每天把一小批旧高亮/笔记重新递到眼前,"记住了"渐行渐远,"再看一次"明天再来。**不是 Anki**:无牌组、无逾期惩罚、无参数调优,回味优先于记忆考核。
- 关联:入口卡片挂在「今日视图」(`docs/plan-home-view.md` ④卡);存储沿用批注 v2 的用户库迁移链与双端同构约定(`docs/research-annotation-data-models.md` §5.1/§5.2)。

> 一句话:一张 `annotation_reviews` 状态表(桌面用户库 v4 / IndexedDB v4)+ 一个两端共享的 Leitner 阶梯纯函数 + 一个全屏单卡回顾视图;批注创建零成本进入回顾池(惰性初始化,不回填、不加写路径)。

---

## 1. 现状基线(全部【已核实】于本仓库源码)

| 事实 | 位置 |
|------|------|
| 用户库迁移链就绪:`PRAGMA user_version` + `migrate_to_v{N}` 单事务顺序步骤 + 升级前 `VACUUM INTO` 备份 + 版本棘轮,当前 `USER_SCHEMA_VERSION = 3` | `src-tauri/src/user_store.rs` L20-27、L51、L396-422 |
| `annotations` 表含 `kind/selected_text/note/sort_index/deleted_at`;墓碑 90 天物理清理(`purge_expired_tombstones`) | 同上 L427-441、L493-495、L624 |
| Web 端 IndexedDB `reade-annotations` 当前 `DB_VERSION = 3`,`onupgradeneeded` 按 oldVersion 顺序步骤,与桌面链对齐 | `src/lib/webAnnotations.ts` L25、L62-85 |
| `Annotation` 双端同构类型;`listAnnotations(relativePath?)` 传 null 即全库 live 批注 | `src/lib/backend.ts` L165-184、L301-307 |
| 跨文档跳转链完备:`handleSelectLibraryAnnotation` → `pendingAnnotationJump` → 文档就绪后 `scheduleAnnotationJump`(含 PDF 视图切换与懒加载重试) | `src/App.tsx` L1563-1583、L1335-1356 |
| 视图挂载模式(stats 先例):`activeView` 白名单 + lazy 组件 + `content-grid` hidden | `src/App.tsx` L2540-2541、L2643-2654 |
| 批注位置文案 `annotationPositionLabel`、种类徽标样式已有 | `src/lib/annotationExport.ts` L45-62;`src/components/AnnotationUi.tsx` |
| commands 注册处 | `src-tauri/src/lib.rs` L41-60 |

## 2. 目标与非目标

**目标**

1. 高亮/下划线(含笔记)自动进入回顾池,每天最多 N 条到期重现;两个动作:「记住了」(间隔升级)、「再看一次」(重置),外加「打开原文」「不再回顾」。
2. 双端可用:桌面(SQLite)与 Web(IndexedDB)行为同构。
3. 为今日视图提供「今日回顾」卡数据(待回顾数/今日已回顾数)。

**非目标(明确不做)**

- 不做 FSRS/SM-2 参数化记忆模型(对"回味"场景过度设计,反面参照主题调研的"策展少量"原则)。
- 不做自建卡片/填空题/正反面编辑——回顾对象只能是已有批注。
- 不做逾期红色警告、堆积焦虑 UI:到期不回顾没有任何惩罚,队列每天重新取样。
- 不做云同步;不加新权限、不联网。

## 3. 设计

### 3.1 回顾对象

- 入池:`kind ∈ {highlight, underline}` 且 `selectedText` 去空白后非空;bookmark 与空摘录排除。
- 展示单元 = 摘录原文(主体)+ 笔记(如有)+ 来源(文档标题 · `annotationPositionLabel`)。
- 批注被删除(墓碑)即自动退出队列;改色/改笔记不影响回顾状态;文档重绑(`rebind_document_annotations`)不影响(状态按批注 id 挂靠)。

### 3.2 调度模型(两端共享纯函数 `src/lib/reviewScheduler.ts`)

固定阶梯 Leitner(决策点 R-D1 推荐 A,见 §6):

```ts
const INTERVALS_DAYS = [1, 3, 7, 14, 30, 60];   // box 0..5
interface ReviewState {
  box: number;              // 0..5
  dueAt: number;            // unix ms
  lastReviewedAt: number | null;
  totalReviews: number;
  suspended: boolean;
}
// 无状态行的批注 = 隐式初始态:box 0,dueAt = createdAt + 1 天(惰性初始化)
// remembered: box = min(box+1, 5); dueAt = now + INTERVALS[box]
// again:      box = 0;             dueAt = now + 1 天
// suspend:    suspended = true(可在批注中枢恢复,本期不做恢复 UI,见非目标)
```

- **惰性初始化**是关键决策:批注创建路径零改动、历史批注零回填,`dueAt` 缺行时按 `createdAt + 1d` 现算(桌面 SQL `COALESCE`,Web 端同一纯函数)。
- 每日队列 `buildReviewQueue(candidates, nowMs, limit = 10, seed = localDayKey(nowMs))`:
  - 候选 = 到期(`dueAt ≤ now`)且未 suspended;
  - 排序 = 逾期越久越优先,再按"同文档打散"(轮转取样,避免连续十条来自同一本书),同分位用日期种子伪随机——同一天内队列稳定可复现;
  - `limit` 默认 10,完成后可点「再来一批」追加一轮(当日不限总量,限的是默认展示)。

### 3.3 存储

**桌面:用户库迁移 v4**(沿既有链,自动获得备份 + 棘轮):

```sql
CREATE TABLE annotation_reviews (
    annotation_id TEXT PRIMARY KEY,      -- 对应 annotations.id,不设外键
    library_root TEXT NOT NULL,
    box INTEGER NOT NULL,
    due_at INTEGER NOT NULL,
    last_reviewed_at INTEGER,
    total_reviews INTEGER NOT NULL DEFAULT 0,
    suspended INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);
CREATE INDEX reviews_due ON annotation_reviews(library_root, suspended, due_at);
```

- 孤儿清理:`purge_expired_tombstones` 顺带 `DELETE FROM annotation_reviews WHERE annotation_id NOT IN (SELECT id FROM annotations)`——墓碑物理清除后回顾状态一并消失;墓碑存活期内保留(允许"撤销删除后回顾进度不丢")。

**Web:IndexedDB v4** 新 store `annotationReviews`(keyPath `annotationId`),升级步骤追加到现有 `onupgradeneeded` 链(`oldVersion < 4`);打开库时的墓碑 purge 同步清孤儿。

### 3.4 IPC 契约(桌面新增 3 个 commands)

前端算状态、后端校验落盘——与 `sortIndex`"前端 derive、后端 validate"的既有分工一致:

| command | 参数(snake_case) | 返回 | 说明 |
|---|---|---|---|
| `list_review_queue` | `now_ms: u64, limit: usize` | `Vec<ReviewQueueItem>` | LEFT JOIN annotations,过滤墓碑/suspended/非 mark 类/空摘录,`COALESCE(due_at, created_at + 86400000) <= now_ms`,按 due 升序返回至多 `limit × 3` 条(超取,前端做同文档打散后裁到 limit) |
| `record_review_outcome` | `annotation_id, box: i64, due_at: u64, last_reviewed_at: u64, suspended: bool` | `()` | 校验:批注存在且未删;box ∈ 0..=5;due_at ∈ [now−1h, now+180d];通过后 UPSERT,`total_reviews += 1`(suspend 不加) |
| `review_summary` | `day_start_ms: u64, now_ms: u64` | `{ due_count, reviewed_today }` | 今日视图卡片用;`reviewed_today` = `last_reviewed_at ∈ [day_start, now]` 的行数(本地时区日界由前端计算传入,后端不做时区推断) |

- `ReviewQueueItem = { annotation: Annotation, review: ReviewState }`,serde camelCase 与前端类型逐字段对应。
- 前端 wrapper 加入 `src/lib/backend.ts`,Web 分支在 `src/lib/webAnnotations.ts` 用同一 `reviewScheduler` 实现同构查询(游标扫 live 批注 + reviews store 合并)。

### 3.5 回顾视图(UI)

- `activeView` 增加 `"review"`(依赖今日视图先扩好白名单;若本方案先行,则由本方案扩展)。
- `src/components/ReviewView.tsx`(lazy):单卡片流——
  - 摘录用大号衬线引用排版(`--reader-font-family` 不动,卡片局部用 serif 栈,呼应"回味"气质);颜色徽标沿用批注四色;笔记次级展示;来源行 = 文档标题 + 位置文案。
  - 主操作:「记住了」(主按钮)/「再看一次」;次操作:「打开原文」/「不再回顾」(overflow,需确认)。
  - 进度指示 `3 / 10`;完成态:今日回顾数 + 「再来一批」+ 「回到主页」。
  - 键盘:`1` 或 `Space` = 记住了,`2` = 再看一次,`Enter` = 打开原文,`Esc` = 退出回顾(队列保留,当日可回来继续)。
  - 「打开原文」复用 `handleSelectLibraryAnnotation` 跳转链;跳转前把当前队列与游标存在 App 内存 state,同日返回 review 视图继续(跨重启不保留,重开按当日种子重建,可接受)。
- 入口:今日视图④卡(主入口);无第二入口,保持信息架构克制。
- 边界态:队列为空 → "今天没有待回顾的标注",显示下次最早到期日;批注在回顾中途被删(打开原文后删除)→ 写回 outcome 失败时静默跳过该卡并前进。

### 3.6 安全与性能

- 无新权限、无网络、无新依赖;所有输入(annotation_id、box、时间戳)服务端白名单校验,沿用 `MAX_ANNOTATION_ID_CHARS` 的 id 校验函数。
- `list_review_queue` 走 `reviews_due` 索引 + annotations 主键 JOIN;万级批注下 <10ms 量级(验收含预算)。
- 回顾视图 lazy 加载,不进首屏 bundle。

## 4. 改动清单(预估)

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/reviewScheduler.ts`(新)+ 测试 | 状态机 + 队列取样纯函数 | M |
| 2 | `src-tauri/src/user_store.rs` + 内嵌测试 | 迁移 v4、3 个 commands、孤儿清理 | M |
| 3 | `src-tauri/src/lib.rs` | 注册 commands | S |
| 4 | `src/lib/backend.ts` / `src/lib/webAnnotations.ts` + 测试 | wrapper 与 Web 同构实现 | M |
| 5 | `src/components/ReviewView.tsx`(新)+ 测试 | 回顾视图 | M |
| 6 | `src/App.tsx` / store / `HomeView` | 视图接线 + ④卡点亮 | S-M |
| 7 | `src/App.css`、`docs/USER_GUIDE.md` | 样式与文档 | S |

里程碑:**R0** 调度纯函数 + 双端存储与 commands(可无 UI 合入)→ **R1** 回顾视图 + 今日视图卡接线 → **R2** 键盘/完成态/同文档打散打磨 + 视觉验收。

## 5. 验收标准

**R0(引擎与存储)**

- [ ] 单测(`reviewScheduler.test.ts`):状态机全转移表(隐式初始态、阶梯逐级、封顶 60 天、again 重置、suspend);队列性质——同输入同种子输出逐字节稳定、跨日种子变化、逾期优先、同文档不连续出现超过 2 条(构造 3 文档×10 条数据验证)、limit 裁剪。
- [ ] Rust 测试(user_store 内嵌):v3→v4 迁移幂等(重复打开不重复建表)、迁移前备份文件存在、`user_version = 4`;`record_review_outcome` 拒绝非法 box/越界 due_at/已删批注/未知 id;`list_review_queue` 排除墓碑、suspended、bookmark、空摘录,`COALESCE` 隐式初始态在 `createdAt + 1d` 准时出现;孤儿行随墓碑物理清除被删,墓碑存活期内保留。
- [ ] Web 测试(`webAnnotations.test.ts`,fake-indexeddb):v3→v4 升级后旧批注可读;**双端契约用例**——同一组批注/回顾状态 fixture(TS 模块内定义,Rust 测试以注释指向该文件并保持用例一致)在两端返回相同的到期 id 集合与顺序。
- [ ] `cargo test`、`cargo clippy -D warnings`、`pnpm test`、`tsc --noEmit` 全绿。

**R1(可用闭环)**

- [ ] 组件测(`ReviewView.test.tsx`):渲染摘录/笔记/来源;「记住了/再看一次」调用 wrapper 且卡片前进;键盘 1/2/Enter/Esc 路径;空队列态;写回失败跳卡不中断。
- [ ] 组件测(HomeView):`review_summary` 有到期时④卡显示数字,零到期显示"已完成"态。
- [ ] 运行时(桌面):造 15 条跨 3 个文档的高亮 → 用注入 `now` 的 dev 手段(或系统时间)推进到 D+1 → 队列出现 10 条且文档交错;「记住了」后 SQL 查询验证 `box=1`、`due_at = now + 3d`(±1min);「打开原文」跳转到正确位置且返回后队列续接。
- [ ] 运行时(Web):`pnpm dev:web` 同流程走通(IndexedDB 佐证用 DevTools)。

**R2(完成态)**

- [ ] 视觉走查:回顾卡明/暗 × 宽/窄 ≥ 4 张截图;四种批注色徽标在四个主题系列下辨识度抽查(至少 paper/ink 两系列)。
- [ ] 队列性能:注入 5,000 条批注 + 1,000 条 review 行,`list_review_queue` 往返 < 50ms(打日志计时佐证)。
- [ ] `docs/USER_GUIDE.md` 新增「每日回顾」章节;README 能力清单同步一行。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| R-D1 | 调度模型 | **A. 固定阶梯 Leitner(上文)**——可解释、可测、够用 | B. 简化 FSRS(参数多、对回味场景无增益,否决理由同"非目标") |
| R-D2 | 每日默认条数 | **10 条**,完成后可追加 | 5 / 15;不做设置项,常量导出便于日后调整 |
| R-D3 | 新批注首次到期 | **T+1 天**(创建当天不打扰) | T+0(当天即回顾,更像"当日复盘",但与"间隔"语义冲突) |
| R-D4 | 「不再回顾」的恢复入口 | **本期不做**(suspended 数据保留,恢复 UI 留给批注中枢 M3) | 回顾完成态里加"已忽略 N 条"管理入口 |

## 7. 风险与开放问题

- 时钟回拨:`due_at` 校验窗口 [now−1h, now+180d] 容忍轻微偏差;大幅回拨最坏效果是"提前到期",无数据风险。
- 队列取样在批注量极少(<10)时天天重复同几条——完成态文案引导"多划几条高亮";不做人工规避。
- `Space` 键与滚动冲突:回顾视图全屏且无滚动正文,拦截安全;组件测覆盖"焦点在按钮上时 Space 不双触发"。
