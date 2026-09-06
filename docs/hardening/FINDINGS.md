# Hardening 审查项分类（D00 → 持续更新）

> 对应 `READE_AGENT_IMPLEMENTATION_PLAN.md` §8 的 30 项映射。每项给出分类、当前源码证据与承接任务。
> 分类规则见计划 §0.3：CONFIRMED / RISK / IMPROVEMENT / RESOLVED / NOT_APPLICABLE / DEFERRED。
> "证据"指 D00 时点 HEAD `94ef1dd` 的源码符号与行号；行号随实现推进可能漂移。

| # | 审查项 | 分类 | 承接 | 证据（当前源码） |
|---|---|---|---|---|
| 1 | 标注数据库迁出缓存语义目录 | CONFIRMED | D04 | `src-tauri/src/lib.rs:35-43`：`UserState::new(cache_directory)` 把用户库放 `app_cache_dir`；同目录还有可再生缓存 `reade-cache.sqlite3`（`AppState::new`）。stats 已在 `app_data_dir`（`stats.rs:56-59`）。 |
| 2 | 标注写操作上下文保护 | CONFIRMED | D03 | `src/lib/useDocumentAnnotations.ts`：`reload` 有 token（:96-117），但 `saveExcerpt`（:148-173）、`clearAll`（:196-207）、`undo`（:209-238）、`updateColor`（:246-264）、`saveReflection`（:266-279）、`setEnrollment`（:281-300）在 await 后直接用 `bundleRef.current` + `commitBundle`，无文档上下文捕获；`clearAll` 若切换文档后返回会把新文档 bundle 清空；`undo(clear)` 迟到会把旧文档快照写入新文档。 |
| 3 | Rust 跨库竞态 | CONFIRMED | D02 | `library.rs:300-325 open_library` 完成时无条件覆盖 `root/documents/watcher`，无请求序号；`open_document`、`read_document_range`、`read_epub_asset`、`search_documents` 等以调用瞬间 `current_root` 解析。前端 `useReaderStore.ts:346-352` 的 `activeLibraryGeneration` 只过滤前端回写，不阻止后端根被旧请求覆盖。 |
| 4 | PDF Range 错误处理 | CONFIRMED → **D06 已修复** | D06 | 修复证据：ReadeRangeTransport 上报+可重试 UI+destroy 终止（PdfReader.test.tsx "surfaces a range failure…"）；并发 4/超时 15s（"runs at most four…"、"fails a stalled…"）；Rust 跨 EOF 稳定错误（"pdf_range_reads_are_bounded_and_reject_crossing_eof"）。pdf.js worker 源码核对：range 终点钳制到 length（`Math.min(endChunk * chunkSize, this.length)`），正常流不跨 EOF。 |
| 5 | EPUB 单书缓存与分栏 | CONFIRMED | D07 | `library.rs:182-196 OpenEpubAssets/LibraryState.open_epub: Option<...>`；`open_document` 非 EPUB 时置 `None`（:402-404），`refresh_library` 亦清空（:366）。主栏 EPUB + 副栏打开任意 MD/PDF 即清空主栏资产缓存。 |
| 6 | EPUB DOM 锚点隔离 | CONFIRMED | D07 | `src/components/EpubReader.tsx` 与 `SecondaryPane.tsx` 共用 DOM id 命名空间（同书双开跳转串栏）；`EpubReader.tsx` 内 `document.getElementById` 类全局查找用于脚注/目录定位（详见 D07 实施时核对行号）。 |
| 7 | 统计绑定原书库 | CONFIRMED → **D05 已修复** | D05 | 修复证据：`stats.rs start_reading_session` 绑定 + `record_reading_session` 按绑定归属；测试 `saves_are_attributed_to_the_bound_library_and_unknown_ids_are_refused`。 |
| 8 | 已结束会话的失败重试 | CONFIRMED → **D05 已修复** | D05 | 修复证据：readingTracker 退避重试队列 + flushPending；测试 `retries a failed save with backoff…`、`flushPending drains…`。 |
| 9 | EPUB 解压/解析预算 | RESOLVED（依赖自带限额，复核证实） | D08 | 复核证据：anydoc 0.1.8 package::limits 硬限额（条目 100k / 单条目实际解压 128MiB / 总量 512MiB / XML 深度 256 / 节点 2M / 资产 128MiB），按实际解压计费，ResourceLimit 致命传播；包装层缺口已补（documents.rs：container/OPF/nav/ncx 直读 4MiB 上限 + 稳定错误文案）；测试 rejects_an_oversized_opf_with_the_budget_error、normal_epub_still_parses_within_budgets。残余 CPU 风险记录在案。 |
| 10 | 全局锁与阻塞扫描 | CONFIRMED | D09 | `library.rs:307-310`：`open_library` 在 `lock_state` 内执行 `scan_documents`（磁盘扫描，阻塞其它命令）；`AppState.inner: Arc<Mutex<LibraryState>>` 单锁覆盖 root/documents/cache/watcher/open_epub；`run_blocking` 仅用于 canonicalize 与部分读取，扫描本身持锁。 |
| 11 | EPUB 图片实际按需读取 | CONFIRMED → **D11 已修复** | D11 | 修复证据：EpubImage 走 IntersectionObserver（1.2 预热边距）才发起 IPC；共享加载器合并同 (path,assetId) 请求、并发上限 4、Blob URL 引用计数最后消费者撤销（测试 delays asset IPC…、revokes the shared blob url…）。 |
| 12 | EPUB 整书渲染与滚动测量 | RISK | D10→D11 | `EpubReader.tsx:330` IntersectionObserver 做章节几何测量；整书 DOM 是否常驻需 D10 样本实测后定级（长 EPUB 样本未跑，不得预判）。 |
| 13 | 代码高亮预算与重试 | RISK | D11 | `MarkdownRenderer.tsx:132+` 按需动态 import 语言 grammar（首屏不打入），但未见"高亮结果缓存键 / 失败 Promise 移除 / 大代码块降级"逻辑（实施时以 D10 长代码样本量化）。 |
| 14 | App 职责拆分 | CONFIRMED（结构性） | D12 | `src/App.tsx` 7021 行、`src/App.css` 8615 行单体；约 70 个 `src/lib/` 纯函数模块已有分层习惯。按 D12 顺序渐进提取。 |
| 15 | Rust 大文件拆分 | CONFIRMED（结构性） | D13 | `src-tauri/src/library.rs` 6074 行、`user_store.rs` 9636 行。 |
| 16 | Rust/TS 契约重复 | CONFIRMED | D02/D13 | 57 个命令在 `lib.rs:54-112` 手工注册；前端 `backend.ts`(954 行) + `tauriBackend.ts`(294 行) 手写 wrapper；`tauriBackend.test.ts` 已有机械对账测试（D13 升级为漏注册/拼写/参数检查）。 |
| 17 | 全局样式拆分 | CONFIRMED（结构性） | D14 | `App.css` 8615 行单文件；`src/styles/theme-tokens.css` 已有分层雏形。 |
| 18 | 错误模型与无声失败 | CONFIRMED | §3.2/D06/D15 | 全线字符串错误（`CommandResult<T> = Result<T, String>` 模式，`library.rs` 各命令）；前端 `errorMessage()` 直出字符串；PDF Range 吞错（#4）；统计失败静默（#8）。 |
| 19 | 自动测试门禁 | CONFIRMED | D01 | `.github/workflows/` 仅有 `deploy-pages.yml`（push main 构建发布，不跑测试）；`package.json` 无 `packageManager`/`engines`；无 verify 工作流。 |
| 20 | 组合场景回归 | CONFIRMED | D00–D16 | 计划 §6 验收矩阵 A01–A20 无既有覆盖；以本轮各任务测试 + 真机验收补齐。 |
| 21 | 恢复演练与启动恢复模式 | CONFIRMED | D04/D15 | `lib.rs:40-41`：`UserState::new` 失败 → `app.run().expect("error while running tauri application")` panic，无恢复入口；user_store 已有迁移备份与旧缓存救援链（`rescues_legacy_annotations_with_verified_counts_and_backfill` 等测试在库）。 |
| 22 | 工具链与依赖审计 | CONFIRMED | D01 | 无 `packageManager`/`engines` 声明；无依赖审计入口；CI 不跑任何检查。 |
| 23 | Web 主线程搜索 | DEFERRED | W01 | Web 封存（AGENTS.md）；`src/lib/webLibrary.ts` 保留现状。 |
| 24 | Web 请求合并与缓存世代 | DEFERRED | W01 | 同上。 |
| 25 | PWA 首装离线启动 | DEFERRED | W02 | `public/sw.js` 保留现状。 |
| 26 | SW scope/容量/淘汰 | DEFERRED | W02 | 同上。 |
| 27 | Web 发布版本一致性 | DEFERRED | W03 | 同上。 |
| 28 | 静态发布安全/替换 | DEFERRED | W04 | `scripts/generate-web-library.mjs` 保留现状；仅当共享改动造成构建/安全回归时最小修复。 |
| 29 | 功能层级与高级入口 | RISK（未实测） | D14 | 设置入口集中在 `App.tsx`/设置面板；"高级功能收纳、可发现性"需真机走查后定级，不凭静态印象改入口。 |
| 30 | 书库健康/本地诊断 | CONFIRMED（缺口） | D15 | 无诊断入口：无命令可查询缓存占用/失败索引数/备份时间（`lib.rs` 命令清单核对）；仅 `clear_conversion_cache`、`retry_document_index` 等单点操作。 |

## D00 阶段新增的基线发现（不在原 30 项内）

| 项 | 分类 | 说明 |
|---|---|---|
| `webAnnotationRepository.test.ts` relocate 用例期望漂移 | CONFIRMED（测试债） | 实现 `e5488f8` 有意改为"legacy 换色改写 tone"且有新用例守护；旧用例未同步。对齐孪生契约即可，非产品缺陷。 |
| `cargo fmt --check` 失败（user_store.rs:3709） | CONFIRMED（格式漂移） | 单处元组换行，`cargo fmt` 定点修复。 |
| `App.test.tsx` 冷启动用例全量负载下超时 | RISK（flaky） | 单独运行通过；全量并行偶发 5s 超时。最小处理：提高该用例超时。 |
| `open_document` PDF 打开时 `metadata` 与 `lock_state` 顺序 | RISK | `library.rs:416-434`：先 `fs::metadata` 再锁状态查 indexStatus；文件与扫描集之间无版本核对。归入 D02 文档会话一并处理，不单独立项。 |

## 复核规则

- 每项完成实施后，在本文件追加"结项证据"一行（命令、退出码、测试名），不删除原始分类。
- 静态风险未复现的（#9、#12、#13、#29）必须以测量或失败测试定级，不得凭实现预判改写历史分类。
