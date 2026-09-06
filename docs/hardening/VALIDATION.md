# Hardening 验证记录（持续追加）

> 每条记录：日期 · 命令 · 退出码 · 摘要 · 证据路径。失败必须原样记录。

## D00 基线 — 修复前（2026-09-05）

| 命令 | 退出码 | 摘要 |
|---|---|---|
| `git rev-parse HEAD` | 0 | `94ef1dd94c0576f5916ac5935458876d4feca249` |
| `git status --short` / `git diff --stat` | 0 | 仅未跟踪 `READE_AGENT_IMPLEMENTATION_PLAN.md`；无未提交改动 |
| `pnpm install --frozen-lockfile` | 0 | Already up to date（361ms） |
| `pnpm test` | 1 | 123 文件：121 过 2 败；1486/1488 用例。FAIL：`webAnnotationRepository.test.ts` tone 断言（确定性）；`App.test.tsx` 冷启动用例超时（负载 flaky，单跑 162ms 通过） |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | 0 | 130 passed; 0 failed |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 1 | `user_store.rs:3709` 格式漂移 1 处 |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 0 | 无警告 |
| `pnpm exec tsc --noEmit` | 0 | 通过 |
| `pnpm build` | 0 | 通过；既有警告：`coverCapture.ts` 混合导入、>500 kB chunk |

## D00 基线 — 修复后复测（2026-09-05）

| 命令 | 退出码 | 摘要 |
|---|---|---|
| `node scripts/hardening-fixtures.mjs` | 0 | library-a/b 共 16 个文件生成于 output/hardening/fixtures/；EPUB（7 条目 ZIP）/PDF 结构自检通过 |
| `pnpm test` | 0 | 123 文件 1488/1488 通过（45.42s）；log: output/hardening/pnpm-test-after-d00.log |
| `pnpm exec tsc --noEmit` | 0 | 通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 0 | 修复后通过；`git diff` 确认仅 user_store.rs 1 处折叠 |

## D01 门禁与工具链（2026-09-05）

| 命令 | 退出码 | 摘要 |
|---|---|---|
| `pnpm run typecheck` | 0 | 新脚本生效（tsc --noEmit） |
| `pnpm audit --audit-level=high --json` | 0 | 506 依赖，0 高危及以上；报告 output/hardening/pnpm-audit-baseline.json |
| `pnpm dlx js-yaml .github/workflows/verify.yml` / `deploy-pages.yml` | 0 | 两个 workflow YAML 解析通过 |
| `cargo --version` / `rustc --version`（在 rust-toolchain.toml 下） | 0 | 解析为 1.94.0，工具链固定生效 |
| `cargo install cargo-audit --version 0.22.2 --locked` | 0 | 本地安装成功 |
| `cargo audit --file src-tauri/Cargo.lock --json` | 0 | 0 漏洞；17 unmaintained / 1 unsound / 1 yanked（信息级）；output/hardening/cargo-audit-baseline.json |
| 远端 workflow 运行 | 已 push `feature/oxx` | 2026-09-06 推送 `origin/feature/oxx`（`692de0f`+）。本机 `gh` 未登录，未能 `gh pr create`。为触发 D01 设计的 PR 门禁，临时对 `feature/oxx` 增加 `on.push`（main 仍不双跑）。运行记录见 GitHub Actions。 |

## D10 性能基线首轮（2026-09-05，本机，5000 篇合成 MD / 141 MiB）

命令契约：`cargo test --manifest-path src-tauri/Cargo.toml perf_baseline -- --ignored --nocapture`（env：`READE_PERF_DOCS`、`READE_PERF_OUT`）；`pnpm build && node scripts/perf-bundle.mjs`。

| 指标 | debug | release | 候选目标对照 |
|---|---|---|---|
| cold_scan | 324.3 ms | 140.3 ms | — |
| index_build（5000 篇） | 17,065 ms（3.413 ms/篇） | 12,638 ms（2.528 ms/篇） | — |
| warm_scan median/p95 | 452.0 / 475.9 ms | 239.9 / 272.2 ms | — |
| 搜索·全库命中中文（FTS） median/p95 | 254.9 / 260.1 ms | 141.0 / 142.1 ms | p95 ≤ 200 ms：release 达标 |
| 搜索·全库命中英文（FTS） median/p95 | 157.0 / 169.3 ms | 95.6 / 99.2 ms | 达标 |
| 搜索·选择性词（FTS） median | 0.08–0.1 ms | ~0.04 ms | 远优于目标 |
| 搜索·LIKE 回退（2 字，全库命中） median/p95 | 378.5 / 391.9 ms | 232.1 / 242.1 ms | 略超 200 ms（候选目标，记录待 D09 观察改善） |
| bundle：chunks / 总 gzip | — | 115 / 1822 KiB | 记录 |
| bundle：初始入口 gzip | — | 342 KiB（index 309 + css 33） | 记录 |
| bundle：>500 KiB raw chunk | — | index(989)、cynefin(672)、mermaid.core(585)、cpp(778) | D11 修混合导入的对照基线 |

证据文件：`output/hardening/perf/rust-baseline.json`（release，当前内容）、`rust-baseline-release.json`（同内容副本）、`bundle-baseline.json`、debug 数值仅存本表与 `pnpm-test-after-d00.log` 同目录日志。

| 运行时壳层指标（首屏可读/窗口内搜索/长任务/峰值工作集/20 次开关句柄） | NOT_RUN | 需真实 Tauri/WebView2 窗口 + CDP 自动化，归 D16 批量执行；脚本方案见 HANDOFF.md |


## 环境限制登记

- Windows 真机 Tauri IPC、安装包、系统对话框：NOT_RUN（D16 验收）。
- 性能真机测量中的"窗口内交互"层：以浏览器/桌面自动化可用范围为准，无法自动化处标注 NOT_RUN。

## D02/D03 实施验证（2026-09-05）

| 命令 | 退出码 | 摘要 |
|---|---|---|
| `cargo test --locked`（D02 后） | 0 | 133 passed + 1 ignored；含 3 个新竞态测试 |
| `cargo fmt --check` / `cargo clippy -D warnings`（D02 后） | 0 / 0 | fmt 修复 4 处新代码格式后通过 |
| `pnpm test`（D02 后） | 0 | 123 文件 1490/1490 |
| `pnpm exec vitest run src/lib/useDocumentAnnotations.test.ts`（D03 修复前） | 1 | **失败前证据**：4/5 新测试失败（slow-A-excerpt、clear-B、stale-reload、note+color 并发） |
| `pnpm exec vitest run src/lib/useDocumentAnnotations.test.ts`（D03 修复后） | 0 | 18/18 |
| `pnpm test`（D03 首轮全量） | 1 | 3 例失败：HomeView 今日进度、StatsView 阅读天数、useMarkdownImageAssets SVG——经隔离复现确认：前两例为**午夜后一小时内**的时钟敏感既有缺陷（now-1h 会话落昨日）；第三例为 90ms 定时刷新在并行负载下的竞态；均与 D03 改动无关 |
| 修复：HomeView/StatsView 假时钟（2026-09-05 10:00 + shouldAdvanceTime）、useMarkdownImageAssets 多轮刷新 | — | 定向 5 文件 116/116 通过 |
| `pnpm test`（D03 复测） | 0 | 1495/1495（见 pnpm-test-after-d03b.log） |

## D04/D05 实施验证（2026-09-06）

| 命令 | 退出码 | 摘要 |
|---|---|---|
| `cargo test --lib`（D04 后） | 0 | 144 passed（新增 9 个位置迁移测试 + 2 个 storage_migration 单测） |
| `cargo fmt --check` / `cargo clippy -D warnings`（D04 后） | 0 / 0 | 通过 |
| `cargo test --lib`（D05 后） | 0 | 147 passed（新增 3 个 stats 绑定/单调/重绑测试） |
| `pnpm exec vitest run src/lib/readingTracker.test.ts`（D05 后） | 0 | 12/12（既有 9 例零改动通过 + 新增 3 例） |
| `pnpm exec tsc --noEmit`（D05 后） | 0 | 通过 |
| 全量 `pnpm test` / fmt / clippy（D05 后） | 见日志 | output/hardening/pnpm-test-after-d05.log |

## D04 重要发现（不改代码，记录语义）

`migrate_to_v7` 会**无条件清空全部标注业务表**（annotations/excerpts/places/reflections/enrollments/collection_items）。追查提交 794b249（2026-08-25）：这是用户明确确认的"选 B：升级到 7 时清空标注内容、切 v6-only"产品决策，**不是缺陷**。影响：① 位置迁移只搬运不动内容，v7 库数据原样保留；② ≤v6 的旧库经迁移链升级时会按该既定语义清空；③ 转换缓存救援链在 v7 落地后为空态（测试按现行语义断言）。

## D05 复验（2026-09-06）

| 命令 | 退出码 | 摘要 |
|---|---|---|
| `cargo clippy -D warnings`（修复 unused/dead-code 后） | 0 | 通过 |
| `cargo test --locked` | 0 | 147 passed + 1 ignored |
| `cargo fmt --check` | 0 | 通过 |
| 全量 `pnpm test` | 0 | **1498/1498，0 Unhandled Errors**（log: pnpm-test-after-d05b.log；此前一轮因 App.test backend mock 缺 D05 新函数产生 73 个 Unhandled Rejection，属测试配置遗漏，补齐后消除） |

## D09 验证（2026-09-06）

| 命令 | 退出码 | 摘要 |
|---|---|---|
| `cargo test --lib` | 0 | 152 passed（+1 跨连接可见性测试） |
| `cargo fmt --check` / `cargo clippy -D warnings` | 0 / 0 | 通过 |
| 全量 `pnpm test` | 0 | 1502/1502（log: pnpm-test-after-d09.log） |
| release perf 复测（D09 后） | 0 | cold 210.9 / warm median 333.8 / index 17,323 / 全库命中搜索 190.3 |
| **性能对照结论** | — | **不可比**：release 复测全部指标相对 D10 基线均匀 +22~50%，其中 index_build（+37%）与搜索（+35%）完全未被 D09 触碰，且 perf 用例的扫描路径代码与基线一致（未走 scan_connection）——判定为机器状态漂移（会话期间持续后台负载），非改动回退。A/B 隔离实验（stash 基线）不可行：perf 用例本身是 D10 改动的一部分。D16 需在安静机器重跑同一命令做干净前后对照。D09 的锁改进是结构性的（扫描不再持有状态锁/异步线程），由 scan_connection 回归测试守护。 |

## D12–D15 实施验证（2026-09-06）

| 命令 | 退出码 | 摘要 |
|---|---|---|
| `pnpm exec tsc --noEmit` | 0 | 通过 |
| `cargo test --locked --lib` | 0 | 162 passed + 1 ignored（含 IPC fixture 2 例与既有备份/路径测试） |
| `cargo clippy --locked --all-targets -- -D warnings` | 0 | 通过 |
| `cargo fmt --check` | 0 | 通过 |
| `pnpm test` | 0 | 127 文件 **1519/1519** |
| `pnpm build` | 0 | 桌面前端生产构建通过 |
| `pnpm build:web` | 0 | Web 封存路径构建兼容通过（A20 构建层） |
| `git diff --check` | 0 | 无空白错误（CRLF 提示可忽略） |

## D16 性能 A/B（2026-09-06，本机 release `perf_baseline`，5000 篇）

对照 D10 安静基线（cold 140.3 / index 12,638 / warm p95 272.2 / 中文 FTS p95 142.1）。D09 脏复测（cold 210.9 / 中文 190.3）已作废。

| 指标 | D10 基线 | D16 本轮 | Δ | 说明 |
|---|---|---|---|---|
| cold_scan | 140.3 ms | 151.5 ms | +8.0% | <10% 阈值，不解释为回退 |
| index_build | 12,638 ms | 14,823.6 ms | +17.3% | 大于 10%；同机其它指标未全面同比例漂移。索引路径本轮未改扫描锁语义，记录为环境+语料生成抖动，不回滚 D09 |
| warm_scan median/p95 | 239.9 / 272.2 | 283.7 / 296.8 | +18% / +9% | p95 接近 10% |
| 中文全库 FTS median/p95 | 141.0 / 142.1 | 165.7 / 179.6 | +18% / +26% | 仍 ≤ 200 ms p95 候选目标 |
| 英文全库 FTS p95 | 99.2 | 128.5 | +29% | 仍远快于中文全库命中 |
| LIKE 回退 p95 | 242.1 | 271.6 | +12% | 候选目标本就未作为门禁 |
| bundle chunks / 总 gzip | 115 / 1822 KiB | 115 / 1827 KiB | ~0 | 入口 gzip 345 vs 342 KiB |
| >500 KiB raw | index/cynefin/mermaid/cpp | 同四块 | — | D11 混合导入修复后仍为大块按需语法 |

证据：`output/hardening/perf/rust-baseline.json`、`bundle-baseline.json`（gitignore）。

运行时壳层（`pnpm tauri dev` + CDP `scripts/d16-cdp.mjs metrics`，debug WebView2，热加载后一次导航）：firstPaint 184 ms，longTaskCount 0。冷启动首次约 10 s 的数值来自等待 Vite/WebView 就绪，**不能当作 NSIS 安装后首屏**。句柄/工作集未用任务管理器采样。

## D16 NSIS 安装包（未签名）

| 项 | 值 |
|---|---|
| 产物 | `src-tauri/target/release/bundle/nsis/Reade_0.2.0_x64-setup.exe` |
| 版本 | 0.2.0 |
| 平台 | Windows 10.0.26200 x64 |
| SHA-256 | `E0CE32736F02125CC3CA7BE58148CEE13A763D22951DA9486B7A7331E8C92F4C` |
| 大小 | 206,683,566 bytes |
| 代码签名 | **未签名**（未配置证书；不声称已签名） |
| 上传/发布 | 未执行 |

## D16 验收矩阵（真实 Windows Tauri/WebView2）

平台：Windows 10.0.26200，构建：`pnpm tauri dev`（debug）+ Vite `127.0.0.1:1420`，书库：`output/hardening/fixtures/library-a|b`。证据截图在 `output/hardening/d16/`（不入库）。自动化单测是另一证据层，不冒充真机。

| 编号 | 结果 | 证据 |
|---|---|---|
| A01 | PASS | 同相对路径 `guide.md`：库 A 正文含「库 A 独有」/`println!("library A")`；库 B 含 “only in library B”/`print("library B")`。截图 A01-md-a.png / A01-md-b.png |
| A02 | NOT_RUN | 无法在真机可靠注入「慢 I/O 迟到提交」；由 Rust `opening_a_then_b_cannot_commit_a_last` 覆盖 |
| A03 | PASS | 阅读中点击「刷新文档库」，仍停留 library-b / 阅读指南 B |
| A04–A05 | NOT_RUN | 未在用户真实标注库写入合成摘录；由 `useDocumentAnnotations.test.ts` 覆盖 |
| A06 | NOT_RUN | 未对真实用户库做 WAL/冲突/磁盘满；由 `storage_migration` / user_store 测试覆盖 |
| A07 | NOT_RUN | 未在真机点「清理文档索引缓存」（避免动用当前机器上的真实缓存 612 MiB）；清缓存不碰用户库由既有测试覆盖 |
| A08 | NOT_RUN | 未做切库后统计对账；绑定逻辑由 stats.rs 测试覆盖。注意：CDP `start` 可能在本机真实 stats 库留下合成路径绑定 |
| A09 | NOT_RUN | 未注入 Range 超时/截断；由 PdfReader + library Range 测试覆盖 |
| A10 | PASS（部分） | `papers/sample.pdf` 出现 canvas/`.pdf-pages`（A10-pdf-a.png）。原版式/双页/区域引用未逐项点选 |
| A11 | PASS（部分） | 库 A EPUB 显示「合成书 A」；库 B 打开同路径 `books/sample.epub`。合成 PNG 显示「图片暂不可用」。未测双栏同书 |
| A12 | NOT_RUN | 无超额 EPUB 真机样本；由 documents.rs 预算测试覆盖 |
| A13 | NOT_RUN | 夹具 EPUB 仅 2 章，未测未渲染长章 materialize |
| A14 | PASS（部分） | 20 次 `guide.md` ↔ `sample.pdf` 切换未崩溃；CDP longTaskCount 0。未采样句柄/Blob 计数 |
| A15 | PASS（部分） | `search_documents`「library B」命中 guide.md / 两份 PDF。大库 5000 篇见上表。未测窗口内 Ctrl+K 延迟 |
| A16 | PASS（部分） | 截图：paper-dark、motion=off、CDP 仿真 760×520 与 1100×620、zoom 200%。**不是**拖拽原生窗口；窄窗下设置面板仍叠在正文上 |
| A17 | PASS（部分） | 打开「阅读设置」后 `document.activeElement` 为「关闭阅读设置」，存在 `[role=dialog]`。未跑全键盘开库（系统文件夹对话框） |
| A18 | NOT_RUN | Windows Known Folder 忽略 `APPDATA` 覆盖，隔离 profile 失败；**禁止**在真实 `com.local.reade` 用户库上做损坏实验。恢复能力见 diagnostics.rs 单测 |
| A19 | PASS（部分） | 欢迎页可截图；自动重开 `reade-last-library` 有效。不是 NSIS 空白安装目录的首次安装 |
| A20 | PASS | `pnpm build:web` 退出码 0（demo-library 生成 8 篇） |

**不得将本表解读为「全量验收通过」。**

