# Hardening 基线（D00）

> 采集时间：2026-09-05 · 执行分支：`feature/oxx` · 执行环境：Windows 11 真机

## 1. 仓库状态

- `git rev-parse HEAD`：`94ef1dd94c0576f5916ac5935458876d4feca249` — 与审查基线提交一致，无漂移。
- `git status --short`：仅 `?? READE_AGENT_IMPLEMENTATION_PLAN.md`（本计划文件本身，未跟踪）。
- `git diff --stat`：空。无用户未提交改动需要保留（除未跟踪计划文件）。
- 分支：`feature/oxx`（main 为默认 PR 目标）。

## 2. 环境与工具链

| 项目 | 版本 |
|---|---|
| OS | Windows 11 家庭中文版，Build 26200，x64 |
| Node.js | v24.15.0 |
| pnpm | 11.5.2 |
| rustc | 1.94.0 (4a4ef493e 2026-03-02) |
| cargo | 1.94.0 |
| WebView2 Runtime | 152.0.4191.53 / 152.0.4191.62（注册表 HKLM EdgeUpdate） |

- `package.json` 当前**没有** `packageManager` 字段与 `engines` 字段（D01 待补）。
- 锁定依赖：`pnpm-lock.yaml` 与 `src-tauri/Cargo.lock` 与源码一致（`pnpm install --frozen-lockfile` 通过，361ms "Already up to date"）。
- 关键锁定版本：`anydoc =0.1.8`、`pdf-inspector =0.1.8`、`zip =8.6.0`、`rusqlite 0.37 (bundled)`、`pdfjs-dist 6.2.108`、`shiki ^4.4.2`、`mermaid ^11.16.1`。

## 3. 验证命令基线（D00 实测，2026-09-05）

| 命令 | 结果 | 备注 |
|---|---|---|
| `pnpm install --frozen-lockfile` | PASS (exit 0) | Already up to date |
| `pnpm test` | **FAIL** | 123 个测试文件：121 通过、2 失败；1486/1488 用例通过。失败详情见 §4 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | PASS | 130 passed; 0 failed（含 3 个性能预算用例） |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | **FAIL** | `src-tauri/src/user_store.rs:3709` 有 1 处格式漂移（多行元组可折叠为单行） |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | PASS | 无警告 |
| `pnpm exec tsc --noEmit` | PASS | （D00 复核时通过） |
| `pnpm build` | PASS（有既有警告） | `coverCapture.ts` 静态+动态混合导入、>500 kB chunk（与 2026-08-30 审计一致，属既有债务） |

### 4. 基线失败用例明细

1. **`src/lib/webAnnotationRepository.test.ts` > "preserves excerpt tone and rewrites the v6 anchor on legacy relocate upsert"** — 确定性失败（单独重跑复现）。
   - 断言 `bundle.excerpts[0]?.appearance.tone` 期望 `"sage"`，实际 `"sand"`。
   - 根因：提交 `e5488f8`（2026-08-31，"已标注句子换色走 v6 appearance 接口，legacy 镜像同步更新 tone"）把 `projectAnnotationIntoV6` 的语义从"legacy upsert 一律保留旧 tone"改为"传入色映射 tone 与旧 tone 不同则改写"。`src/lib/webAnnotations.test.ts` 同步加了新用例（"recolors an existing excerpt when legacy upsert changes tone"），但**没有同步更新本用例**。
   - Rust 孪生测试 `upsert_annotation_mirrors_v6_anchor_and_refreshes_source_revision`（user_store.rs:9342）在重定位时**不改变 color**，因此通过；Web 用例额外传了 `color: "yellow"`，与孪生契约不一致。
   - 分类：**测试期望漂移**（实现语义变更有意为之且有新测试守护），非产品缺陷。处理：把 Web 用例对齐 Rust 孪生契约（重定位不改 color → tone 保留）；换色路径已由 `webAnnotations.test.ts` 覆盖。
2. **`src/App.test.tsx` > "lands on home when 30-day sessions exist without persisted positions"** — 超时（5000ms）仅在**全量套件并行负载下**出现；单独用 `-t` 过滤重跑 162ms 通过。分类：**flaky**（负载敏感超时），非功能缺陷。处理：为该用例提高超时上限（最小修改），不改产品代码。

## 5. 测试书库 A/B 合成夹具（D00 §执行 4）

生成脚本：`scripts/hardening-fixtures.mjs`（新增，Node 零依赖）。输出目录：`output/hardening/fixtures/`（`output/` 已在 `.gitignore`，不入库）。

- `library-a/`、`library-b/`：同相对路径不同内容（`guide.md`、`notes/same-name.md`、`assets/pic.png` 不同字节）、重复标题锚点、`[[wiki]]` 链接、含公式/代码块/中文长段落的 MD；A/B 各含不同 PDF（lopdf 风格最小 PDF 手工构造）与 EPUB（ZIP 结构最小合成书，章节含图片与脚注锚点）。
- 标注依赖运行时数据库，不预置；竞态测试使用内存/临时目录数据库（Rust tests）与 mock（vitest），见各任务。
- 合成迁移数据库：D04 实施时由 Rust 测试在 `tempfile` 临时目录生成，不落 `output/`。

## 6. 原有行为事实（核对当前源码得出）

- **启动与数据分层**（`src-tauri/src/lib.rs:34-50`）：`UserState` 打开于 `app_cache_dir`（注释说明其初始迁移会先从 legacy cache 救援标注）；`AppState`（转换缓存/索引）也在 `app_cache_dir`；`StatsState` 在 `app_data_dir`。→ D04 的"标注库迁往 app_data_dir"目标确认仍未实现。
- **Rust 书库竞态**（`library.rs:300-325 open_library`）：完成后无条件 `current.root = Some(root)`，无请求序号校验；A 慢 B 快时 A 迟到的完成会覆盖后端根目录。前端 `useReaderStore.openLibrary`（useReaderStore.ts:402-439）有 `libraryRequest` 序号过滤——**前端会忽略 A 的响应，但后端 root 已被 A 覆盖**，此后 B 的读取按 A 的根解析。用户提示的前端忽略≠后端解决，在此确认为真实缺陷（D02 CONFIRMED）。
- **单一 EPUB 资产缓存**（`library.rs:189-196 LibraryState.open_epub: Option<OpenEpubAssets>`；`open_document` 对非 EPUB 打开直接置 `None`，405-404 行；`refresh_library` 也置 `None`）：主副栏双 EPUB、EPUB+MD 混合场景互相清缓存（D07 CONFIRMED）。
- **PDF Range 静默吞错**（`PdfReader.tsx:92-105 ReadeRangeTransport`）：`.catch(() => undefined)`，读取失败不上报、不退出加载态（D06 CONFIRMED）。Rust 侧 `read_document_range`（library.rs:513）每次调用以 `current_root` 重新解析相对路径，无文档会话绑定（D06 CONFIRMED）。
- **统计归属**（`stats.rs:76-84 record_reading_session`）：保存时以 `current_root` 归属；`upsert_session` 拒绝同 id 异库（251-257）。前端 `readingTracker.ts:145-149` 失败仅重置计数等待下次 flush，`endSession`（166-171）后 `session = null`，失败的最终快照没有重试载体（D05 CONFIRMED）。
- **标注 mutation 上下文**（`useDocumentAnnotations.ts`）：`reload` 有 token（96-117），但 `save/saveExcerpt/remove/clearAll/undo/updateColor/saveReflection/setEnrollment` 均 await 后直接读写 `bundleRef.current` 与全局 undo 栈，无文档上下文捕获（D03 CONFIRMED，详见 FINDINGS.md #2）。
- **EPUB 图片按需读取**（`EpubReader.tsx:108,122`）：`readEpubAsset` 在图片组件 effect 中立即发起，`<img loading="lazy">` 只延迟浏览器取用，不延迟 IPC 读取（D11 CONFIRMED）。
- **导出范围**（`annotationTransfer.ts:902-957 ARCHIVE_TYPE/ReadeUserDataArchiveV2`）：checksums 覆盖 documents/excerpts/places/reflections/reviewEnrollments/collections；**不含阅读统计（reade-stats.sqlite3）与偏好/位置**（D15 CONFIRMED 缺口）。
- **命令清单**：`lib.rs:54-112 generate_handler!` 57 个命令，与 AGENTS.md 记载一致。

## 7. 未验证 / 环境限制

- Tauri 真机 IPC、安装包、系统对话框：D00 未涉及（后续 D16 以真机为准）。
- `pnpm tauri build` 未在本轮运行（留到 D16）。
- `pnpm build:web` 未在 D00 运行（Web 封存，仅在共享改动可能回归时运行）。
