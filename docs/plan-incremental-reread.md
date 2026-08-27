# 方案定稿：增量重读

- 日期：2026-08-13（基线查证日；同日复核基线并定稿）
- 状态：**已实施**
- 定位：常读文档更新后（笔记库、连载、协作文档），打开时提示"自上次阅读后有更新"，正文左缘标出变更段落——只重读改动的部分。缓存 sqlite 新增"上次阅读时的文本快照"（派生数据，受既有 1 GiB 治理）。
- 关联：快照失效指纹沿 `document_cache` 的 size/modified 契约；变更标记的左缘视觉语义与 TOC 覆盖线（inset 细线）一族；diff 为纯函数（TS 契约孪生思想沿相关段落方案）。

> 一句话：缓存库新表 `document_read_snapshots(library_root, relative_path, content, captured_at, source_size, source_modified)`——**离开文档时**（切换/关库/关应用前 flush）把当前正文文本写为快照；下次打开该文档时若磁盘指纹 ≠ 快照指纹 → Rust 纯函数 `diff_paragraphs(old, new)`（段落级哈希 LCS）返回变更段索引 → 前端顶部通知条 + 变更段落左缘 `--accent` 细线（点击通知条逐个跳到变更处）；确认"已读完更新"或再次离开时快照滚动更新。

---

## 1. 现状基线（已核实于 2026-08-13，行号允许漂移）

| 事实 | 位置 |
|------|------|
| 缓存库 schema v1（document_cache/search_segments/document_links），版本不匹配整库删除重建；`user_version` 写入 | `src-tauri/src/library.rs` L27、L1068-1083、L1123-1223 |
| 1 GiB 软上限 + 低水位 90%，按 `last_accessed ASC` 淘汰**非当前库**条目；单文档清除逐表删除——新表须加入两处 | `src-tauri/src/library.rs` L28-29、L1513-1585 |
| 失效指纹契约：`source_size + source_modified + converter_revision` 三元组判缓存命中 | `src-tauri/src/library.rs` L1312-1344 |
| 正文文本已派生在 `search_segments.content`（markdown 整篇/PDF 每页/EPUB 每章）——**快照可直接取自该表，无需前端回传全文** | `src-tauri/src/library.rs` L1136-1148 |
| user DB 另有 `documents` 表存 `content_hash`（v3，扫描后同步指纹）——证明"内容指纹"基础设施成熟，但其无全文，不能做 diff 源 | `src-tauri/src/user_store.rs` L955-963；`src-tauri/src/library.rs` L728 |
| 文件监听：`library-changed` 事件（300ms 防抖）→ 前端 `refreshLibrary()`——"阅读中文档被改"的感知链路已在 | `src-tauri/src/library.rs` L49、L2247-2269 |
| Markdown 渲染器给块级元素带 `data-source-start`（源码行号）——**变更段落（源文本段索引/行号）可映射到渲染 DOM 做左缘标记** | `src/components/MarkdownRenderer.tsx` L50-56 |
| 左缘细线视觉先例：`.toc-link.is-reached` inset 2px 线 | `src/App.css` L1844-1863 |
| 离开文档的时机钩子：`currentPath` 变化时已有一组状态 reset；阅读位置 500ms trailing debounce flush 同窗口 | `src/App.tsx` L3396-3414（及 path-change effect 一族） |
| Web 端无 sqlite——Web 版本期不做（search.json 无历史版本可比） | `src/lib/webLibrary.ts` L43-52 |

## 2. 目标与非目标

**目标**

1. 快照捕获：离开文档（切换/关库/退出）且该次会话阅读 ≥30s（防路过）时，Rust 把 `search_segments` 当前 content 复制为快照（含指纹）。
2. 打开文档：磁盘指纹 ≠ 快照指纹（且有快照）→ `diff_paragraphs` → 顶部通知条"自上次阅读后有更新：N 处变更"，正文左缘对变更段落画 `--accent` 细线；通知条"下一处"按钮循环跳转。
3. diff 语义：段落级（空行分段 / PDF 页 / EPUB 块），新增与修改标记，删除只计数（"另有 M 段被移除"文案，无锚点可标）。
4. 快照更新：用户点"知道了"或再次离开时快照滚到当前版本；存储受 1 GiB 治理与单文档清除覆盖。
5. 仅 Markdown/mdx 与 EPUB（文本稳定）；PDF 首版按页 hash 只提示"第 X、Y 页有变化"不画行内线。

**非目标（明确不做）**

- 不做逐字符/词级 diff 高亮（段级已回答"哪里变了"；字级高亮要在渲染管线内注入标记，侵入大）。
- 不做历史多版本（只存"上次读到的"单快照，不是版本管理器）。
- 不做 Web 版（无派生存储）。
- 不做"变更即通知"的推送（打开时提示已够，不打扰）。

## 3. 设计

### 3.1 schema 与治理（缓存库 v1→v2，或与书架方案合并 bump）

- 新表 `document_read_snapshots(library_root TEXT, relative_path TEXT, content TEXT NOT NULL, source_size INTEGER, source_modified INTEGER, captured_at INTEGER, PRIMARY KEY(library_root, relative_path))`。
- 加入 `clear_cached_document*`、`enforce_cache_soft_limit` 的逐表删除；快照单条上限沿 Markdown 10 MiB 红线（超限不存）。

### 3.2 IPC 契约（三个新 command）

| command | 说明 |
|---|---|
| `capture_read_snapshot(relative_path)` | 从 search_segments 拷贝 content + 当前指纹（内部完成，前端不传全文） |
| `read_snapshot_diff(relative_path)` | 有快照且指纹不同 → `{ changedSegments: [{ index, kind: added|modified }], removedCount, capturedAt }`；否则 null |
| `acknowledge_read_snapshot(relative_path)` | 快照滚动到当前版本（= capture 的别名语义） |

- diff 纯函数 `diff_paragraphs(old: &str, new: &str) -> Vec<ChangedSegment>`：空行分段 → 段 hash → LCS（段数 ×段数 DP，段数封顶 5,000，超限降级为"整篇有更新"提示）；Rust 内嵌测试 + 用例表。

### 3.3 前端

- 打开文档流程加一次 `readSnapshotDiff`（异步，不阻塞渲染）；结果到达后：通知条（复用既有 notice 模式）+ 对 `data-source-start` 映射段落挂 `data-changed` 属性 → CSS 左缘线。
- 段索引→DOM 映射：markdown 用源行号区间（diff 时同步返回每段起始行）；EPUB 用块索引。
- 离开钩子：currentPath 变化 effect + `beforeunload`/Tauri 关窗前 flush，调 `capture_read_snapshot`（fire-and-forget，失败静默）。

## 4. 改动清单（预估）

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src-tauri/src/library.rs` + `lib.rs` | schema、三 command、diff 纯函数、治理接线、测试 | **L** |
| 2 | `src/lib/backend.ts` | 三 wrapper | S |
| 3 | `src/App.tsx` | 打开/离开钩子、通知条、跳转 | M |
| 4 | `src/components/MarkdownRenderer.tsx` / EpubReader | 变更段属性标记 | S-M |
| 5 | `src/App.css`、`docs/USER_GUIDE.md` | 左缘线样式 + 文档 | S |

## 5. 验收标准（草案级）

- [ ] diff 测试：增/删/改/移动段落、CRLF/BOM 归一（对齐 normalizedTextFingerprint 纪律）、5,000 段降级、空旧文/空新文。
- [ ] Rust 测试：快照存取、指纹判定、治理删除含新表、10 MiB 拒绝。
- [ ] 运行时：读文档 →外部编辑器改两段→ 重开：通知条 + 两条左缘线 + "下一处"跳转；点"知道了"后重开无提示；30s 门槛生效（路过不留快照）。
- [ ] 万篇库容量抽查：快照只为读过的文档存在（非全库），体积可控（devtools/sqlite 佐证）。
- [ ] 全套回归 + `cargo clippy`；明/暗截图。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| IR-D1 | 快照来源 | **Rust 从 search_segments 自取**（前端不回传全文，IPC 轻） | 前端传正文（大 payload 过 IPC，且与索引文本可能不一致） |
| IR-D2 | 捕获时机 | **离开文档 + ≥30s 阅读门槛**（"上次读到的版本"语义准确） | 打开即快照（读前快照使"更新"提示滞后一轮）；定时快照（写放大） |
| IR-D3 | diff 粒度 | **段落级 hash LCS** | 行级（Markdown 软换行噪音大）；字符级 Myers（成本高、收益是行内高亮但本期不做） |
| IR-D4 | PDF | **页 hash 提示、不画行内线**（阅读模式页对应关系稳定） | 完整支持（页内 diff 对扫描版无意义，OCR 文本噪音大，否） |

## 7. 风险

- **存储放大是本案最大风险**：快照 ≈ 又存一份读过文档的全文。缓解：只存读过（30s 门槛）+ 10 MiB 上限 + 治理接线；但"当前库不淘汰"的既有语义下重度用户单库缓存可能明显增长——方案如实标注，必要时给快照独立子预算（如 256 MiB LRU）作定稿选项。
- schema bump 与书架封面方案都动缓存库：**两案必须协调一次 bump**（版本号冲突会互相触发整库重建），实施顺序需用户/实施方拍板。
- `data-source-start` 映射对深度嵌套结构（列表内段落）可能粗粒度：左缘线落在最近的带行号块上，可接受；用例表锚定嵌套场景。
- 监听触发的 `refreshLibrary` 会更新 search_segments——打开中的文档被外部修改时，快照（旧）与 segments（新）的读写顺序要在 Rust 侧加测试防竞态。

## 8. 定稿记录（2026-08-13，实施前复核）

基线复核结论：§1 表中除两处外全部成立。两处出入及处理：

1. **`data-source-start` 实际只有标题（h1–h6）携带**（`MarkdownRenderer.tsx` 的 heading 工厂），并非"块级元素"普遍带有。定稿：给 `p/ul/ol/blockquote/table/div` 与 `pre` 链（普通 pre / 代码块 figure / Mermaid 容器）补 `data-source-start/end` 位置戳（沿标题先例，纯附加属性，无行为变化），变更标记与行号映射建立在其上。
2. **EPUB 收窄到章级**：`blocks_plain` 对嵌套块（列表/表格/引用）每项产出多行，快照文本行与渲染 DOM 的块索引没有稳定一一对应；按"明确收窄优于半坏映射"，EPUB 变更定位到章（`.epub-chapter` 容器边缘标记 + 章级跳转），不做草案 §3.3 设想的块级索引。Markdown/mdx 维持段级（完整形态），PDF 维持页级提示（IR-D4 原样）。

拍板与实施决策：

| # | 决策 | 定稿 |
|---|------|------|
| IR-D1 | 快照来源 | Rust 从 `search_segments` 自取（按草案）；多段格式（PDF 页/EPUB 章）以 `\u{1E}` 记录分隔符拼接为单行 `content`，diff 时按分隔符还原段列表 |
| IR-D2 | 捕获时机 | 微调为**双点捕获**：打开后驻留满 30s 即捕获一次（定时器，覆盖崩溃/直接关窗，语义＝"到达阅读门槛即视为已读该版本"）；离开/切换文档时再捕获，但**仅当磁盘指纹自打开起未变**（防止把阅读期间被外部改写、用户从未看过的新版本误记为已读）；横幅"知道了"= 立即捕获（无门槛）。`beforeunload` 不再单独挂钩——30s 定时捕获已覆盖关窗场景 |
| IR-D2b | acknowledge 命令 | 折叠进 `capture_read_snapshot`（前端直接调用，无门槛语义在前端），IPC 面从 3 个 command 收敛为 2 个：`capture_read_snapshot`、`read_snapshot_diff` |
| IR-D3 | diff 算法 | 段级 hash + **前后缀裁剪 + 中段 LCS DP**；中段面积 > 4,000,000 格（≈8 MiB u16 表）时降级为多重集近似（移动段不标）；任一侧段数 > 5,000 时降级为"整篇有更新"（`truncated`，无逐段标记）。added/modified 区分：LCS 对齐后按顺序把新增段与移除段配对为 modified，余量为 added/removedCount |
| IR-D4 | PDF | 页 hash 提示"第 X、Y 页有变化"，不画行内线、不提供"下一处"跳转（按草案） |
| IR-D5（新） | 快照子预算 | **独立 256 MiB LRU 子预算**（用户拍板）：按 `last_accessed ASC` 独立淘汰（含当前库，与 1 GiB"当前库不淘汰"语义解耦）、低水位 90%；主 1 GiB 治理测量时**减去快照表字节**，快照永不挤占文档缓存的淘汰预算；单条快照沿 10 MiB 红线超限不存 |
| IR-D6（新） | 清理联动 | **快照的生命周期与缩略图相反**：`clear_cached_document` 兼任"文件已变更"的失效钩子，若在此删快照，文件一变快照即灭、功能自毁——故失效路径与主预算 LRU 逐出（`clear_cached_document_by_key`）**保留**快照（快照价值恰是"比当前版本旧"，且有独立 256 MiB 预算兜底）；删除发生在：文档从库中消失（`scan_documents` 快照孤儿清扫，`document_thumbnails` 先例）、整库清空（`clear_cache_storage`）、快照子预算 LRU |
| IR-D7（新） | 横幅形态 | 既有 notice 为 4.2s 瞬态 toast，不适合承载循环跳转；新增驻留式 `RereadBanner`（reading-frame 顶部覆盖条）：文案 + "下一处"（markdown 循环跳块 / EPUB 循环跳章）+ "知道了"（确认并滚动快照）。变更标记为 `data-reread-changed` 属性 + 左缘 accent 细线（`.toc-link.is-reached` inset 线族） |
| IR-D8（新） | 索引滞后 | 打开时若 `document_cache` 指纹 ≠ 磁盘指纹（后台重索引未完成），`read_snapshot_diff` 返回 null 不出横幅；前端在 `indexStatus` 变化时重查一次，索引完成后横幅自然出现 |

schema（`CREATE TABLE IF NOT EXISTS` 纯附加，不 bump `CACHE_SCHEMA_VERSION`，`document_links`/`document_thumbnails` 先例）：

```sql
CREATE TABLE IF NOT EXISTS document_read_snapshots(
    library_root TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    content TEXT NOT NULL,          -- 段落文本，多段格式以 U+001E 分隔
    source_size INTEGER NOT NULL,   -- 捕获时的 document_cache 指纹（同事务读取）
    source_modified INTEGER NOT NULL,
    captured_at INTEGER NOT NULL,
    last_accessed INTEGER NOT NULL,
    PRIMARY KEY(library_root, relative_path)
);
```

已知边界（如实标注）：捕获指纹取自捕获事务内的 `document_cache` 行（内容与指纹恒自洽）；若文件在打开后 30s 内被外部改写**且**后台完成重索引，30s 捕获会存入用户未读的新版本、错过一轮横幅（窗口极小，不误报只漏报）。阅读中文档不热重载（既有行为），离开捕获的指纹门用打开时刻的 size/modified 判定。
