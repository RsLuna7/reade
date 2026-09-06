# Hardening 任务状态（对应计划 §2/§4）

> 状态：TODO / IN_PROGRESS / DONE / BLOCKED / NOT_APPLICABLE / DEFERRED
> W01–W04 默认 DEFERRED（Web 封存）；只有共享改动引入 Web 回归时才做最小修复。

| 任务 | 状态 | 依赖 | 结项摘要 |
|---|---|---|---|
| D00 基线 | DONE | — | 基线采集完成；3 项基线失败修复并复测通过（1488/1488）；夹具脚本就绪 |
| D01 测试门禁 | DONE | D00 | package.json/工具链固定 + verify.yml + 发布门禁；本地可执行项已验证，远端 workflow 未运行 |
| D10 性能基线 | DONE | — | 测量脚本可重跑；debug+release 基线入库；运行时壳层指标 NOT_RUN（D16） |
| D02 书库/文档上下文 | DONE | D00 | 后端开库票证校验/会话分层/事件携带 rootKey；前端事件过滤；3+2 个竞态测试 |
| D03 标注上下文 | DONE | D02 | documentEpoch+串行队列+dataVersion 守卫；修复前 4 例失败→修复后 18/18；顺带修 3 处测试时间/负载 flake |
| D04 标注库迁移 | DONE | D00 | storage_migration.rs：VACUUM INTO+摘要校验+迁移记录+互斥；9 个迁移测试；拒绝静默择优 |
| D05 统计绑定 | DONE | D02+D04 | 会话绑定归属+单调守卫+退避队列+零权限关窗协调；147 Rust + 1498 前端全过 |
| D06 PDF Range | DONE | D02 | Range 并发4/超时15s/错误上报+可重试；跨 EOF 拒绝（核对 pdf.js 钳制语义）；36+3 前端例、148 Rust 例 |
| D07 EPUB 多会话 | DONE | D02 | 资产表按(库,文档)会话化+LRU 128MiB 预算；书内锚点/注释 id 实例化；149 Rust+1502 前端全过 |
| D08 EPUB 资源限制 | DONE | — | anydoc 0.1.8 自带硬限额（复核证实）；包装层补 XML 4MiB 上限+ResourceLimit 文案映射；151 Rust 全过 |
| D09 扫描/锁竞争 | DONE | D02+D10基线 | 扫描移出状态锁与异步线程（专用连接+busy_timeout）；152 Rust 全过；性能对照受环境漂移污染，D16 复测 |
| D11 按需开销 | DONE | D06+D07+D08+D10基线 | 图片 IO 门控+合并/引用计数；章节测量 O(可见)；Shiki 结果缓存+大块阈值；混合导入消除；1505 前端全过 |
| D12 App 拆分 | DONE | D03+D05+D06+D07 | 独立 UI + 工具函数 + Toc/SidePanel + 全局快捷键 hook；store 切片因 persist 单 blob 暂不拆 |
| D13 Rust/契约治理 | DONE | D04+D08+D09 | library_paths + sqlite_io；IPC 三方对账；本轮会话/诊断 DTO 双向 fixture |
| D14 样式/可访问性 | DONE | D12+D10基线 | App.css 五层导入；设置 dialog 焦点；真机截图见 D16（CDP 视口，非原生改窗） |
| D15 诊断/备份 | DONE | D04+D05+错误契约 | 本地数据状态、VACUUM 备份、restore-pending、脱敏诊断；打开失败进入降级 UI 而非进程退出 |
| D16 最终回归 | DONE | 全部默认任务 | 见 VALIDATION / FINAL_REPORT；A 矩阵有 NOT_RUN，未写全量通过 |
| W01–W04 | DEFERRED | — | Web 封存，未授权不执行 |

## 执行顺序备忘

M0：D00 → D01 →（D10 基线脚本与首轮采集）→ M1（D02 → D03 / D04 → D05）→ M2（D06、D07 → D08）→ M3（D09 → D11）→ M4（D12 → D13 / D14 / D15）→ M5（D16）。

单 Agent 串行执行；`App.tsx`、`backend.ts`、`tauriBackend.ts`、`library.rs`、`user_store.rs`、锁文件同一时间只在一个任务里修改。

### D00 — 固定实际基线与验证范围
状态：DONE
依赖：无
当前代码证据：HEAD `94ef1dd`（见 BASELINE.md §1）
变更前复现/测量：`pnpm test` 2 失败（1 确定性 + 1 flaky）；`cargo fmt --check` 1 处漂移；其余验证通过（BASELINE.md §3）。
修改文件：docs/hardening/*（新增 6 份）；scripts/hardening-fixtures.mjs（新增）；src/lib/webAnnotationRepository.test.ts（relocate 用例对齐 e5488f8 语义与 Rust 孪生契约，去掉测试内 `color: "yellow"` 覆盖）；src/App.test.tsx（冷启动用例显式 timeout 20s，负载 flaky 缓解）；src-tauri/src/user_store.rs（cargo fmt 定点折叠 1 处元组换行，无行为变化）。
实现决策与兼容性：webAnnotationRepository 用例修的是**测试期望漂移**（实现语义变更 e5488f8 有新测试守护，Rust 孪生测试重定位不改 color），非产品缺陷；未改任何产品行为，不写用户数据。
实际验证命令、退出码及证据：修复后 `pnpm test` 全量 1488/1488 通过（45.42s，log: output/hardening/pnpm-test-after-d00.log）；`pnpm exec tsc --noEmit` 0；`cargo fmt --check` 0；VALIDATION.md。
未验证范围：真机 IPC、打包（D16）；`cargo clippy` 在 fmt 修复后未重复运行（仅格式变化，D01 前基线已过）。
下一步：—（结项）

### D01 — 测试门禁与工具链约束
状态：DONE
依赖：D00
当前代码证据：package.json 原无 packageManager/engines/typecheck；.github/workflows/ 仅 deploy-pages.yml 且不跑测试；deploy 顶层权限含 pages:write。
修改文件：package.json（packageManager pnpm@11.5.2、engines node >=24 <25、新增 typecheck/audit:deps scripts）；rust-toolchain.toml（根目录，固定 1.94.0 + rustfmt/clippy）；.github/workflows/verify.yml（新增：PR+workflow_call；frontend ubuntu 作业跑 test/typecheck/build/build:web；rust windows 作业跑 test/fmt/clippy --locked；deps-audit 报告作业）；.github/workflows/deploy-pages.yml（build needs verify 同一提交门禁；pages/id-token 权限收敛到 deploy 作业；pnpm 版本改由 packageManager 字段驱动，去掉硬编码 version: 10）。
实现决策与兼容性：① pnpm 固定为 D00 实测的 11.5.2，Node 锁 24 行（engines 为声明式约束，pnpm 默认不强制，CI 用 node-version: 24 落地）；② verify.yml 主分支 push 不单独触发——main 的验证经由 deploy-pages 的 verify 调用完成，避免同一提交双跑；③ deps-audit 按计划"先报告后阻断"，continue-on-error 有明确期限（2026-10-31 评审阻断策略），报告 artifact 留档，不关闭检测；④ E2E 驱动暂不新增（无脚本引用 pnpm lint/test:e2e）；⑤ pnpm audit 本地基线：506 依赖 0 高危以上。
实际验证命令、退出码及证据：`pnpm run typecheck` 0；`pnpm audit --audit-level=high --json` 0（output/hardening/pnpm-audit-baseline.json）；js-yaml 解析 verify.yml/deploy-pages.yml 均 PARSE_OK；`cargo --version`/`rustc --version` 在 rust-toolchain.toml 下仍解析 1.94.0；cargo-audit 0.22.2 本地安装 + Cargo.lock 审计（见 VALIDATION.md）。
未验证范围：**远端 workflow 未实际运行（配置就绪，远端未验证）**——taiki-e/install-action@v2 对 cargo-audit@0.22.2 的预编译支持、dtolnay/rust-toolchain@1.94.0 ref 形式需首次远端运行确认；不执行 push/PR 去触发。
下一步：D10。

### D10 — 性能基线、预算与可重复测量
状态：DONE
依赖：无（基线优先采集）
当前代码证据：既有性能用例为合成断言（library.rs tests `scan_is_fast_metadata_first_and_cached_search_keeps_locators`、`list_document_links_stays_fast_on_a_synthetic_link_graph`、`related_passages_meet_the_synthetic_performance_budget`）；无可重复采样脚本，无 bundle 统计。
修改文件：src-tauri/src/library.rs（新增 `#[ignore]` 测量用例 `perf_baseline_scan_index_search_on_synthetic_library`：合成 N 篇 MD 库 → 冷扫描/索引构建/热扫描×5/热搜索 5 项×6 次 + LIKE 回退×6，输出 JSON 至 output/hardening/perf/；无绝对毫秒断言）；scripts/perf-bundle.mjs（新增：dist/ 产物 chunk 原始/gzip 字节、入口 gzip、>500 KiB 清单）。
实现决策与兼容性：① 测量进 `#[cfg(test)] #[ignore]`，默认 `pnpm test`/`cargo test` 不受影响（命令契约：`cargo test --manifest-path src-tauri/Cargo.toml perf_baseline -- --ignored --nocapture`，env `READE_PERF_DOCS`/`READE_PERF_OUT`）；② 阈值阶段不设——计划要求先有同机可重复基线，回退 >10% 才需解释，虚拟 CI 不做绝对毫秒断言；③ 运行时壳层指标（首屏、窗口内搜索延迟、长任务、峰值工作集）需要真机窗口协作，本轮 NOT_RUN，移交 D16 用真机/CDP 补齐；④ 大样本用例运行时生成，不提交仓库。
实际验证命令、退出码及证据：debug 首轮（2026-09-05，5000 篇 / 141 MiB，debug build）：
- cold_scan 324.3 ms；index_build 17,065 ms（3.413 ms/篇）；warm_scan×5 中位 452.0 / p95 475.9 ms；
- 热搜索（debug）：全库命中中文串 ~254.9 ms 中位、英文串 ~157.0 ms；选择性查询 0.08–0.34 ms；LIKE 回退（2 字"稳定"，全库命中）~378.5 ms 中位；
- bundle（pnpm build 产物）：115 chunks、总 gzip 1822 KiB、初始入口 gzip 342 KiB（index 989 KiB raw / 309 KiB gzip + index.css 33 KiB gzip）；>500 KiB raw：index、cynefin、mermaid.core、cpp grammar。
- 候选目标对照：5,000 文档热搜索 p95 ≤200 ms——debug 下全库命中查询未达标（~260 ms）；选择性查询远优于目标。以 release 复测为准（运行中）。
未验证范围：真机壳层/首屏/窗口内交互指标 NOT_RUN（归 D16：`pnpm tauri dev` + `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`，脚本经 CDP 采 Performance 指标；方案记录在 HANDOFF.md）；大 EPUB/多页 PDF/高标注密度样本未生成（D11/D06 前按需补）。
下一步：—（可脚本层结项；运行时指标在 D16 用同一套命令补采）


### D02 — 书库、文档上下文与过期任务隔离
状态：DONE
依赖：D00
当前代码证据：`library.rs` open_library 无票证校验；`useReaderStore.ts` 的 applyDocumentIndexStatus/setIndexProgress 盲应用事件；Range/资产命令按调用瞬间 root 解析。
修改文件：src-tauri/src/library.rs（OPEN_REQUEST 票证 + commit_open_library 提交校验；LibraryState.open_session/root_key；commit_epub_open_result 迟到解析守卫；read_document_range/read_epub_asset 原子捕获 root+session 并在返回前校验；read_pdf_reading_mode 索引后 root 复核；DocumentIndexEvent/IndexProgress 增加 libraryRoot；spawn_background_index 携带 rootKey）；src/lib/backend.ts（LibrarySnapshot.rootKey、事件类型 libraryRoot、facade 映射）；src/lib/tauriBackend.ts（LibraryOpenResult wire 类型）；src/store/useReaderStore.ts（事件按 rootKey 过滤）；测试：library.rs 3 个新 Rust 测试、useReaderStore.test.ts 2 个新前端测试、既有 mock 补 rootKey/libraryRoot。
实现决策与兼容性：① 开库防乱序做在**后端**（票证 + 提交校验），前端忽略过期响应只是第二道防线；② rootKey（normalize_root(canonical)）与 rootPath（用户输入，localStorage 存储键依赖）分离，不迁移任何存储键；③ 刷新只递增 generation 不动 open_session（同库刷新不打断阅读）；④ EPUB 迟到解析静默丢弃状态写入但仍返回内容（前端按 generation 丢弃），索引写库一并跳过——正确性优先；⑤ read_epub_asset 的 session 校验内联在同一临界区（避免非重入 Mutex 二次加锁死锁）；⑥ Web 双胞胎不受影响（webLibrary 无事件、facade web 分支 rootKey=manifest.title）。
实际验证命令、退出码及证据：`cargo test --locked` 133 passed + 1 ignored（含 opening_a_then_b_cannot_commit_a_last、late_epub_parse_from_a_cannot_mutate_b、epub_parse_commits_index_and_assets_for_the_open_library）；`cargo fmt --check` 0；`cargo clippy --all-targets -D warnings` 0；`pnpm test` 1490/1490（log: output/hardening/pnpm-test-after-d02.log）；`tsc --noEmit` 0；`git diff --check` 0。
未验证范围：真机 A→B 慢 I/O 切换（D16 真机验收 A02）；`create_watcher` 仍无直接测试（已知盲区，D09 触及 watcher 合并时补）。
下一步：D03（标注 mutation 的文档上下文）。

### D03 — 标注写入、重载与撤销的上下文一致性
状态：DONE
依赖：D02
当前代码证据：`useDocumentAnnotations.ts` reload 有 token，但 save/saveExcerpt/remove/clearAll/undo/updateColor/saveReflection/setEnrollment 在 await 后直接读写 `bundleRef.current` 与全局 undo 栈；切文档后迟到的 mutation 会污染新文档（clearAll 会清空新文档、undo(clear) 会把旧文档快照写进新文档）。
修改文件：src/lib/useDocumentAnnotations.ts（新增 documentEpoch（切文档即递增，mutation 捕获后守卫全部本地回写）、每文档串行 mutation 队列（切文档重置链）、dataVersion（成功本地提交后递增；在飞 reload 发现版本变化则丢弃过期快照并重取，不回退本地状态））；src/lib/useDocumentAnnotations.test.ts（新增 5 例路径分桶竞态测试 + 多文档 mock）。
实现决策与兼容性：① 后端写成功的数据**绝不回滚**——epoch 不符只跳过本地回写，下次打开原文档正常读取；② 同文档 note/color 并发经串行队列保序，后到者基于先到者的 bundle 提交，互不覆盖；③ reload 过期时通过 reloadRef 重排（令牌递增使旧 finally 不清 loading），有界收敛于"mutation 停止后"；④ 失败的 undo 不消耗栈条目（保留可重试），epoch 变化后不误弹新文档的栈顶；⑤ hook 对外 API 不变，App.tsx 接线零改动；⑥ 未吞错：mutation 失败仍向调用方 reject。
实际验证命令、退出码及证据：修复前定向跑新测试 4/5 失败（keeps a slow A excerpt…、does not clear document B…、does not drop a new excerpt…、keeps concurrent note and color…，见 00:0x 轮输出；stale-undo 一例结构性通过留作回归守卫）；修复后 `pnpm exec vitest run src/lib/useDocumentAnnotations.test.ts` 18/18 通过；`tsc --noEmit` 0；全量 `pnpm test`（log: output/hardening/pnpm-test-after-d03.log）。Rust 侧本任务未改动。
未验证范围：内存 hook 层验证，Rust 持久层写入本身由 user_store.rs 既有测试覆盖（本任务未改）；App.tsx 实际接线（撤销入口 UI）未做真机走查（D14/D16）。
下一步：D04（标注库迁移）。

### D04 — 标注数据库位置与无损迁移
状态：DONE
依赖：D00
当前代码证据：`lib.rs:35-43` UserState 打开于 app_cache_dir；`UserState::new(directory)` 把用户库与 legacy 源放在同一目录。
修改文件：src-tauri/src/storage_migration.rs（新增：位置迁移模块——VACUUM INTO 一致性快照、integrity_check、数据级摘要校验、迁移记录 JSON、create_new 互斥锁、崩溃残留清理、same-file 识别）；src-tauri/src/user_store.rs（UserState::new(durable_dir, legacy_cache_dir)；open_user_database/常量 pub(crate)；测试补 Debug impl）；src-tauri/src/lib.rs（mod storage_migration；setup 改传 data_dir + cache_dir，打开顺序不变）；既有 15 处 UserState::new 单参测试调用补同目录参数（语义等价）。
实现决策与兼容性：① 迁移记录用独立 JSON 文件而非加表——避免为记录 bump USER_SCHEMA_VERSION 触发旧版 ratchet 与无谓 schema 变更；② 摘要数据级而非 mtime 级（计划明确要求）；③ 冲突（两库都在+旧库摘要变化 / 无记录）一律拒绝启动并给人工处置指引，不静默择优——对应计划停止规则；④ v7"升级清空标注"是用户 2026-08-25 明确确认的产品决策（commit 794b249），本任务不改不评；位置迁移只搬运，已在 v7 的库数据原样保留；⑤ 目标目录不可写用"路径被文件占用"模拟（Windows 无法用只读目录属性可靠阻止建文件），磁盘满路径未真机模拟——记入未验证。
实际验证命令、退出码及证据：`cargo test --lib` 144 passed（新增 7 个 D04 测试：migrates_a_cache_resident…、second_launch_uses…、refuses_to_start_when_the_old_database_changed…、refuses_to_open_when_both…、interrupted_migration_is_redone…、migration_snapshot_includes_uncheckpointed_wal…、read_only_destination…、fresh_durable_location_runs…、same_resolved_file…——9 个；加 storage_migration 2 个单测）；`cargo fmt --check` 0；`cargo clippy -D warnings` 0。前端无改动。
未验证范围：真实用户数据库未触碰（遵守"不用真实数据库试迁移"；真机首启验证归 D16/A19）；磁盘满注入未模拟；多实例并发迁移未做真机并发测试（锁逻辑有单测）。
下一步：D05（统计会话绑定）。

### D05 — 阅读统计会话绑定、重试与关闭落盘
状态：DONE
依赖：D02+D04
当前代码证据：stats.rs record_reading_session 以保存瞬间 current_root 归属；readingTracker 失败仅重置计数等下次 flush，endSession 后最终快照失败无重试载体；无关窗协调。
修改文件：src-tauri/src/stats.rs（SessionBinding 注册表 + start_reading_session 命令：绑定时校验文档在当前库；record 按绑定归属、未绑定拒绝、路径与绑定不符拒绝、切库后重绑幂等且不再要求文档在当前库；upsert_session 同库单调守卫——迟到旧快照跳过、同值幂等、异库 id 冲突仍报错）；src-tauri/src/lib.rs（注册 2 个新命令；CLOSE_APPROVED + on_window_event 拦截首次关窗 → 发 reade-close-requested → 前端 flush → approve_window_close 销毁窗口；Rust 侧 6s 强制关闭兜底线程——全程零新增 webview 权限）；src/lib/tauriBackend.ts + backend.ts（startReadingSession/approveWindowClose/onWindowCloseRequested，Web 运行时 no-op）；src/lib/readingTracker.ts（bind 先于首存、失败退避队列 1/2/4/8/30s、同会话合并、64 条上限+溢出可见、flushPending 立即排空、bind 失败自动随队列重试）；src/App.tsx（tracker 接线 bind/onPersistError + 关窗事件有界等待 2.5s 后放行）。
实现决策与兼容性：① 归属绑定在**后端**（start 时验证原文档上下文），保存不看当前库——切库后末次 flush 落回原库；② 重绑幂等路径跳过"文档在当前库"校验，否则切库后重试 bind 永远失败；③ 单调守卫只作用于同库行，异库 id 冲突保持原报错（既有测试守护）；④ 关窗协调用 Rust on_window_event 而非 onCloseRequested——后者需要 core:window:allow-destroy 权限扩张，Rust 侧实现零权限且自带挂起兜底；⑤ 持久 outbox 不做：按计划第 7 条如实承诺"强杀丢失最后一个未确认区间"，重试队列仅进程内；⑥ tracker 对外 API 只增不改，既有 9 个测试零改动通过。
实际验证命令、退出码及证据：`cargo test --lib` 147 passed + clippy 0 + fmt 0（修复 2 处 clippy 报错后复验）；`pnpm exec vitest run src/lib/readingTracker.test.ts` 12/12；`tsc --noEmit` 0；全量 `pnpm test` 1498/1498 退出码 0（首次全量暴露 73 个 Unhandled Rejection——App.test 的 backend mock 缺 onWindowCloseRequested/startReadingSession/approveWindowClose，desktop 分支穿透到真实 Tauri API；补 mock 后复跑干净，log: pnpm-test-after-d05b.log）。
未验证范围：真机关窗流程（A08 真机层归 D16）；跨午夜归属不回退依赖 existing 时间语义未新增测试；Rust 6s 强制关闭线程未真机验证。
下一步：D06（PDF Range）。

### D06 — PDF Range 读取、错误传播与文件会话生命周期
状态：DONE
依赖：D02（已含 Range 的 open_session 校验）
当前代码证据：PdfReader.tsx:92-105 ReadeRangeTransport `.catch(() => undefined)` 静默吞错、无并发上限、无超时；Rust read_pdf_range_from_root 对跨 EOF 请求返回截短字节当成功。
修改文件：src/components/PdfReader.tsx（ReadeRangeTransport：内部常量 RANGE_CONCURRENCY_LIMIT=4 / RANGE_REQUEST_TIMEOUT_MS=15s；有界并发泵+排队；单请求超时经 Promise.race；失败 → abort 停新请求 + onError 上报组件；组件侧 BoundError.retryable + loadNonce 重试按钮——PDF.js 公共 API 无 transport 错误通道（核对 pdfjs-dist 6.2.108 类型定义，无 onDataError），故组件用公共 loadingTask.destroy() 终止会话并显示可重试错误）；src/App.css（.pdf-retry-button 样式）；src-tauri/src/library.rs（跨 EOF 请求 → 稳定错误 "The PDF file changed while it was being read; reopen the document"，不再截短伪装成功）；测试：PdfReader.test.tsx 新增 3 例（失败可见可重试+会话销毁、并发 4+排队、15s 超时）、library.rs 新增 1 例（跨 EOF 拒绝/恰至 EOF 合法）。
实现决策与兼容性：① 不臆造 PDF.js API——错误经自有 onError 回调上抛，终止用公共 destroy()；② EOF 语义：恰至文件末尾的区间合法（PDF.js 末块请求 ≤ open 时 size），仅"跨越 EOF"判为文件变化；③ 正常关闭路径（abort 后回调）不上报错误（aborted 分支静默）；④ 双栏同文件共享同一 transport 实例（每会话一个 getDocument），关闭一栏走既有 dispose 幂等链——引用计数语义由既有 PdfSessionLifecycle 承担，未新增。文件缩短错误文案即计划 §3.2 的 SOURCE_CHANGED 对应物（字符串错误模型未变）。
实际验证命令、退出码及证据：`pnpm exec vitest run src/components/PdfReader.test.tsx` 36/36（新增 3 例全过）；其余见后台日志。
未验证范围：真机原版式/阅读模式/缩放/双页/标注/页码恢复（A10 归 D16）；反复开关 20 次句柄观测（A14 归 D16 运行时指标）；Rust Range 与 D02 会话校验的联动只有单测层。
下一步：D07（EPUB 多会话资产与分栏锚点）。

### D07 — EPUB 多会话资产与分栏锚点隔离
状态：DONE
依赖：D02
当前代码证据：library.rs 单一 `open_epub: Option<OpenEpubAssets>`，打开 MD/PDF 或 refresh 都清空；EpubReader 的书内 anchor/note DOM id 全局共享，同书双开跳转/脚注落到第一个实例。
修改文件：src-tauri/src/library.rs（`open_epub_assets: HashMap<(rootKey, path), OpenEpubAssets>` 多会话表 + `epub_asset_stamp` LRU 戳 + `EPUB_ASSET_BUDGET_BYTES=128MiB` 预算淘汰（保底 1 个会话）；开 MD/PDF 不再清会话；refresh 保留会话（陈旧会话在下次读取时按 size/modified 自失效并移除）；切库 clear；read_epub_asset 按 (库,文档) 查找并触碰 LRU）；src/components/EpubReader.tsx（useId 实例命名空间：anchor span/heading/note id 实例化；noteRef href 同步实例化；书内锚点链接解析从 document.getElementById 改为 closest(".epub-reader") 内 querySelector；章节 section id 与 epubChapterTocId 保持不变——它们是标注归属与主栏 TOC 跳转的既有契约，查找本身已限定 articleRef/rootRef 范围）；测试：library.rs 新增预算淘汰测试、EpubReader.test.tsx 新增同书双开 id 隔离测试。
实现决策与兼容性：① 同书双栏共享同一资产会话（同 key），资产不可变安全共享；② 被淘汰/陈旧会话的后续读取返回"重新打开"错误——明确降级而非静默卡死；③ 不放宽 MIME 白名单；④ DOM id 命名空间只影响书内锚点与注释，章节级 id 契约保留（记录为已知的双栏 HTML id 重复，程序化查找均已限定范围）。
实际验证命令、退出码及证据：`cargo test --lib` 149 passed（+1 预算淘汰）；`pnpm exec vitest run src/components/EpubReader.test.tsx` 8/8（+1 双实例隔离）；clippy/fmt 0；全量前端见日志。
未验证范围：真机双栏图片/脚注/目录走查（A11 归 D16）；128 MiB 预算未用真实大书校准（D10 大 EPUB 样本未生成）。
下一步：D08（EPUB 容器资源限制）。

### D08 — EPUB 容器与解析资源限制
状态：DONE
依赖：无（可独立提前，实际在 D07 后完成）
当前代码证据：inspect_epub_container 仅查加密/DRM/fixed-layout；container/OPF 用 read_to_string 无上限直读；anydoc 限额未核对。
修改文件：src-tauri/src/documents.rs（MAX_EPUB_XML_BYTES=4MiB；read_bounded_xml_entry 有界读取 container/OPF；read_zip_entry（nav/ncx）有界化、超限优雅降级为 None；parse_epub 把 anydoc ConvertError::ResourceLimit 映射为稳定中文文案"EPUB 超出解析预算（RESOURCE_LIMIT）：…'"）；测试 2 例（5MiB OPF 触发预算错误；正常书照常解析）。
实现决策与兼容性：① 计划复核要求落实——anydoc 0.1.8 package::limits 自带全部候选维度的硬限额且按实际解压计费（MAX_ENTRY_COUNT 100k、单条目 128MiB、总量 512MiB、XML 深度 256/节点 2M、资产总额 128MiB、repeat 放大上限），因此不重复实现、也不盲目收紧（计划候选值是建议而非结论）；② 包装层只补自己直读路径的上限（anydoc 限额不覆盖我们的 read_to_string）；③ 不可抢占的阻塞解析残余 CPU 风险如实记录（无 worker 隔离，计划允许在明确记录下接受）。
实际验证命令、退出码及证据：`cargo test --lib` 151 passed；clippy 0（修复 unused-mut/manual-repeat-n 后）；fmt 0。
未验证范围：伪造 ZIP 元数据（声明小实际大）的攻击样本未手工构造——anydoc 对其保护来自"按实际解压计费"的实现（archive.rs 读时检查），未在本仓库用样本复验；malformed/DRM 样本由既有测试覆盖。
下一步：D09。

### D09 — 扫描、索引和全局锁竞争
状态：DONE
依赖：D02+D10基线
当前代码证据：open_library 的 scan_documents 在**异步运行时线程上同步执行且全程持有状态锁**（比计划描述的"阻塞池内持锁"更糟——还占死 tokio worker）；refresh_library 在阻塞池内持锁扫描；cache 连接无 busy_timeout。
修改文件：src-tauri/src/library.rs（AppState 增加 cache_path 字段 + file_backed 测试构造器 + scan_connection()：经 open_cache_connection（schema 校验）开专用连接并设 busy_timeout 5s；open_library 与 refresh_library 的扫描改为"阻塞池 + 专用连接 + 锁外"，状态锁只在发布结果时短临界区获取；initialize_cache 主连接同样加 busy_timeout 5s——后台索引短事务与扫描清理的写冲突由其确定性消化）；测试新增 scan_connection_reconciles_cache_rows_visible_to_the_state（跨连接读写可见性 + 缓存命中标题 + 幽灵行清理）。
实现决策与兼容性：① 扫描期间其它命令不再被状态锁卡住——搜索/读取/标注在 5000 篇库扫描期间保持响应（对 D10 debug 基线 warm_scan ~452ms 的锁占用窗）；② WAL 允许扫描连接的读与主连接的短写共存，busy_timeout 消化写-写重叠；③ 扫描连接是短生命周期连接（每次扫描开关一次，不无限建连）；④ 后台索引保持既有单 worker 串行 + 世代检查（有限队列语义已满足），watcher 300ms 防抖沿用既有实现；⑤ 缓存增量失效/FTS5/路径校验/性能用例全部保留未动。
实际验证命令、退出码及证据：`cargo test --lib` 152 passed（+1 跨连接可见性测试）；clippy 0；fmt 0；性能对照见 VALIDATION（运行中）。
未验证范围：锁等待的前台量化（需真机并发场景，D10 前后对照以 debug/release 同机数据为准）；watcher 高频事件合并已有实现未新增测试。
下一步：D11。

### D11 — EPUB 章节/图片与代码高亮的按需开销
状态：DONE
依赖：D06+D07+D08+D10基线
当前代码证据：EpubImage 挂载即发起 readEpubAsset（`<img loading="lazy">` 不延迟 IPC）；EpubReader 滚动帧对整书逐章 getBoundingClientRect；MarkdownRenderer 的 Shiki 无结果缓存、失败 Promise 常驻、无大代码块阈值；coverCapture 静态+动态混合导入（构建产物确认 index chunk 989 KiB + 警告）。
修改文件：src/components/EpubReader.tsx（EpubImage：IntersectionObserver 1.2 预热边距——进入视口附近才发起 IPC；共享加载器同 (path, assetId) 合并在飞请求、并发上限 4、Blob URL 引用计数最后消费者撤销、失败 Promise 移除允许重试；活动章节测量改为只测相交章节集+空集兜底）；src/components/MarkdownRenderer.tsx（高亮结果 200 条 LRU 缓存；highlighter/语言加载失败即从缓存移除；大代码块阈值 100KiB/2000 行——默认纯文本+显式"点击高亮"按钮，复制仍取原文）；src/lib/coverCaptureEvent.ts（新增：事件常量独立模块）+ coverCapture.ts（re-export 保持兼容）+ BookshelfView.tsx（重型渲染改动态导入——混合导入消除，构建产物新增独立 coverCapture chunk 2.16 KiB）；测试：EpubReader.test.tsx +2（可控 IO：首屏零 IPC+双消费者合并一次读取；引用计数撤销时机）、MarkdownRenderer.test.tsx +1（大块纯文本+按钮+小塊无按钮+长代码可复制）。
实现决策与兼容性：① 章节虚拟化采用计划允许的保守方案——保留整书 DOM（跨章选择/查找/标注语义零风险），仅把滚动帧测量从 O(N) 降到 O(可见)；数据依据：D10 尚无长 EPUB 样本，无法证明窗口化的收益大于回归风险，记录为后续可选项；② 图片懒加载不破坏标注/查找（DOM 结构不变，只是 url 状态后置）；③ Worker 不引入（CSP 不变，且无测量证明必要）；④ Shiki 缓存键含代码原文（内存有界：200 条 LRU）。
实际验证命令、退出码及证据：`pnpm exec vitest run src/components/EpubReader.test.tsx` 10/10；`MarkdownRenderer.test.tsx` 16/16；`tsc --noEmit` 0；`pnpm build` 0 且混合导入警告消失（log: pnpm-build-d11.log）；全量 pnpm test 见日志。
未验证范围：长 EPUB（200 章）真实样本的帧率/内存对比（D10 样本未生成，归 D16）；真机滚动走查。
下一步：D12。

### D12 — 按业务边界拆分 App 与状态
状态：DONE
依赖：D03+D05+D06+D07
修改文件：MotionNotice / WelcomeView / ReadingSettingsPanel / TocNavigation / SidePanel；`src/lib/displayFormat.ts`、`useMediaQuery.ts`、`annotationRelocate.ts`、`useReaderHotkeys.ts`。LibrarySwitcherPopover 仍留在 App.tsx。store persist 仍是单 blob，未切片。
实现决策：一次一个边界、只移动不改 hook 顺序；App.test 从 `./App` 的 re-export 保持。
未验证范围：无额外监听器泄漏断言（提取为纯移动）。
下一步：—（结项；store 切片 DEFERRED）

### D13 — Rust 模块与跨语言契约治理
状态：DONE
依赖：D04+D08+D09
修改文件：`library_paths.rs`、`sqlite_io.rs`；`tauriBackend.test.ts` 对账 `generate_handler` ↔ `invoke` ↔ `#[tauri::command]`；`src/lib/ipc-fixtures/*.json` + Rust/TS 双向 serde 测试（LibraryOpenResult、SearchLocator、IndexProgress、DocumentIndexEvent、LocalDataStatus）。
未把 library.rs/user_store.rs 整文件拆完（计划允许 re-export 渐进）。未引入类型生成器。
下一步：—（结项）

### D14 — 样式分层、入口层级与可访问性
状态：DONE
依赖：D12
修改文件：`src/App.css` 改为按序 `@import` `app-base/layout/formats/components/views.css`；`useDialogFocus.ts` 接入设置面板；AppCss.test 拼接分层文件。
真机视觉：D16 用 Tauri WebView2 CDP 截图（含 760×520 / 1100×620 仿真视口与 paper-dark）；不是拖拽原生窗口边框的验收。
下一步：—（结项）

### D15 — 本地诊断、备份与启动失败恢复
状态：DONE
依赖：D04+D05
修改文件：`diagnostics.rs`、设置面板「本地数据与诊断」、`USER_GUIDE.md`。UserState/StatsState 打开失败改为 in-memory 占位 + `DataOpenHealth`，读写命令拒绝，备份可尝试快照磁盘文件；`LocalDataHealthNotice` 引导恢复。
未在用户真实 profile 上故意损坏数据库（D16 A18 设备层 NOT_RUN）。
下一步：—（结项）

### D16 — 最终回归、安装包与交接
状态：DONE（有明确 NOT_RUN，不是全量通过）
依赖：全部默认任务
证据：`docs/hardening/VALIDATION.md` D16 节、`docs/hardening/FINAL_REPORT.md`、NSIS SHA-256、合成库 A/B 真机截图（`output/hardening/d16/`，不入库）。
下一步：远端 CI 以 PR 上 `verify.yml` 首次运行为准。
