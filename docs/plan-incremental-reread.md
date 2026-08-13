# 方案草案：增量重读

- 日期：2026-08-13（基线查证日）
- 状态：**草案（实施前需复核基线行号并升级定稿）**
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
