# Hardening 契约（持续维护）

> 目标见计划 §3。本文随任务实施更新；"已实现"小节描述当前源码真实行为。

## 1. 版本与会话分层（D02，已实现）

四层身份，禁止互相合并：

| 层 | 实现 | 谁递增 | 用途 |
|---|---|---|---|
| 书库身份 `rootKey` | Rust `LibraryState.root_key = normalize_root(canonical_root)`；经 `open_library`/`refresh_library` 返回 `LibraryOpenResult.rootKey`，存于前端 `snapshot.rootKey` | 打开的书库变化时随之变化 | 事件过滤（`DocumentIndexEvent.libraryRoot`、`IndexProgress.libraryRoot` 与 `snapshot.rootKey` 比对） |
| 打开会话 `open_session` | Rust `LibraryState.open_session: u64`，仅 `commit_open_library` 成功时 +1 | 每次成功 open_library（A→B→A = 3 个会话） | `read_document_range` / `read_epub_asset` 的迟到请求拒绝（`current_root_and_session` + `ensure_same_open_session`） |
| 扫描修订 `generation` | Rust `LibraryState.generation: u64`，open 与 refresh 都 +1（沿用旧行为） | open_library、refresh_library | 后台索引批次归属（`spawn_background_index(app, rootKey, generation, documents)`）；前端 `activeLibraryGeneration` 保持原语义 |
| 文档会话 | 尚未实现（D06/D07 落地 documentSessionId） | — | PDF Range/EPUB 资产按文档生命周期绑定 |

关键规则（已实现）：

1. **开库防乱序在后端**：`OPEN_REQUEST: AtomicU64` 发票；`commit_open_library` 提交时校验自己的票仍是最新，否则 Err（"A newer open_library request superseded this open"）且丢弃 watcher。A 慢 B 快时 A 的提交失败，后端根保持 B。
2. **EPUB 解析迟到不污染新库**：`commit_epub_open_result` 在写入前比对 `captured_root` 与当前 root；切换过则返回 `false`（不写索引、不改 documents、不设 open_epub、不发事件）。
3. **事件携带出身**：`DocumentIndexEvent.libraryRoot` / `IndexProgress.libraryRoot`（camelCase wire）。前端 `applyDocumentIndexStatus` / `setIndexProgress` 与 `snapshot.rootKey` 不符时丢弃。
4. **刷新不换会话**：`refresh_library` 只递增 `generation`，不动 `open_session`；同库刷新不打断阅读。刷新时 root 已变则 Err。
5. **Range/资产读取**：root + session 原子捕获（单次加锁）；读取后 session 校验失败即 Err（"The library changed while the document was being read; reopen it"）。字节始终来自捕获的 root。
6. **前端旧守卫保留**：`libraryRequest` / `activeLibraryGeneration` / `documentRequest` / `searchRequest` 继续负责"过期响应不回写 UI"；loading 用 `pendingOperations` 计数器，过期操作结束只减自己的计数，不会清掉新操作的 loading。
7. **存储键兼容**：`snapshot.rootPath` 仍是用户输入路径（`reade-tree-layout`、`reade-read-marks`、`reade-library-mru` 等.localStorage 键依赖它，不变）；`rootKey` 只作身份守卫，不入存储键。

## 2. 错误模型（§3.2）

D02 引入的稳定错误文案（字符串，后续统一适配为 code）：
- 开库乱序：`A newer open_library request superseded this open; ignore the stale result`
- 会话过期（Range/资产）：`The library changed while the document was being read; reopen it`
- EPUB 迟到解析：静默丢弃（返回 false），前端按 generation 过滤其响应
- 索引期间切库（reading mode）：`The library changed while the PDF was being indexed; reopen it`

## 3. 持久化与迁移（D04，已实现）

当前事实（D04 后）：
- **用户库**：`app_data_dir/reade-user.sqlite3`（持久，清缓存不可触碰）。首次启动由 `storage_migration::prepare_durable_user_database` 从 `app_cache_dir/reade-user.sqlite3` 一次性迁移：
  - 快照用 `VACUUM INTO`（一致性、含 WAL 已提交数据），目标目录临时文件 → `PRAGMA integrity_check` + 按表行数/updated_at 摘要比对 → 常规迁移链初始化 → 写迁移记录 `reade-user-location.json` → 同目录 rename 发布。
  - 摘要是**数据级**（每业务表 COUNT + MAX(updated_at)，缺失表记 missing），绝不用 mtime 判新旧。
  - 旧文件**永不删除/修改**。后续启动：旧文件存在且摘要与记录一致 → 直接用新库；摘要不一致（旧版本又写入）→ 拒绝启动并提示人工择一，绝不静默择优；两库都在但无记录 → 同样拒绝。
  - 互斥：`reade-user-migrate.lock`（create_new + 内容时间戳，>10s 视为崩溃残留可打破）；失败幂等：残留 `.migrating` 临时文件下次启动清掉重做。
- **转换缓存**：`app_cache_dir/reade-cache.sqlite3`（schema 不匹配整库重建；清缓存只删行 + VACUUM，不删文件，不触碰用户库/统计库/迁移记录/备份）。
- **统计库**：`app_data_dir/reade-stats.sqlite3`（WAL, synchronous=NORMAL）。
- **救援链顺序**：lib.rs 中 UserState 先于 AppState 打开；v1 救援源仍是 cache_dir 的转换缓存库。⚠️ 既有产品决策（2026-08-25 用户确认"选 B"）：迁移链升到 v7 时清空全部标注内容（annotations/excerpts/places/reflections/enrollments/collection_items）；v7 库不受影响，仅 ≤v6 库升级时触发，属既定行为而非缺陷。
- 启动失败仍以 lib.rs setup 错误呈现（panic 路径未变）；"启动失败恢复界面"归 D15。

## 4. 阅读统计与关闭协调（D05，已实现）

- **会话绑定**：`start_reading_session`（新命令）在会话开始时校验"文档在当前打开的书库中"并绑定 `session id → (rootKey, relativePath)`。`record_reading_session` 按绑定归属，**不看保存瞬间的当前库**；未绑定的保存被拒绝（无隐式绕过）；路径与绑定不符拒绝；同 id 异 origin 拒绝；同 origin 重绑幂等（切库后重试成功——重绑不再要求文档在当前库）。
- **单调守卫**：同库行 `(active_seconds, ended_at)` 都 ≥ 新快照时跳过写入（迟到旧快照不回退、同值幂等）；异库行的同 id 写入仍报"belongs to another library"。
- **前端重试队列**（readingTracker）：持久化失败进内存队列，退避 1/2/4/8/30s；同会话新快照合并（旧的被确认后的新写覆盖清除）；上限 64 条，溢出经 onPersistError 可见（不静默丢弃）；`flushPending()` 立即排空供关窗使用；bind 失败随队列自动重试（后端幂等重绑）。
- **关闭协调**（零权限方案）：Rust `on_window_event` 拦截首次 CloseRequested → `api.prevent_close()` + 发 `reade-close-requested`；前端有界 flush（≤2.5s）后调 `approve_window_close` 命令（Rust 销毁窗口）；Rust 侧 6s 强制关闭兜底。**不使用 onCloseRequested API**（需 core:window:allow-destroy 权限扩张）。`CLOSE_APPROVED` 置位后关窗直接放行。
- **承诺边界**：重试队列仅进程内存——强杀/断电时最后一个未确认采样区间可能丢失；已确认写入不丢。持久 outbox 不做（计划 §4 D05.7 允许如实声明边界）。
- 统计绑定表仅进程内存；重启后绑定消失，未确认快照随进程消亡（同上边界）。

## 5. 锁顺序（D02/D09）

已实现（当前事实）：
- `AppState.inner: Arc<Mutex<LibraryState>>` —— 短临界区；**禁止跨 `.await` 持有**。`run_blocking` 闭包内在阻塞线程持锁的只有 `refresh_library` 的扫描与 `open_library` 的 `scan_documents`（D09 待治理：扫描持锁是已知锁竞争，见 FINDINGS #10）。
- `AppState.index_gate: Arc<Mutex<()>>` —— EPUB/PDF 解析与后台索引互斥；持锁期间不持有 inner（`open_document` EPUB 分支：gate 内解析，解析完 drop guard 后才重新加 inner）。
- 顺序：inner（短）→ index_gate（长）→ 重新 inner（短）。`read_epub_asset` 等命令绝不同时持两把锁；需要 second check 时先 drop 再取，或在同一临界区内完成（禁止对非重入 Mutex 二次加锁）。
