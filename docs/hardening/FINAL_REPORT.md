# Hardening 最终报告（D16）

> 对应 `READE_AGENT_IMPLEMENTATION_PLAN.md` §4 D16 / §6。  
> **结论：默认任务 D00–D16 已落地并有回归证据；不是「全量真机验收通过」。**  
> Web 工作包 W01–W04 保持 **DEFERRED**（功能冻结，不是失败）。

## 1. 修复的可复现问题

- 书库/文档会话隔离：过期 `open_library` 与索引事件不能覆盖当前库（D02）。
- 标注 mutation 切文档后不再污染新文档（D03）。
- 用户库迁出缓存目录，位置冲突拒绝启动而非静默择优（D04）。
- 阅读统计按会话绑定归属；关窗有界 flush（D05）。
- PDF Range 失败可见、可重试；跨 EOF 不再假成功（D06）。
- EPUB 资产按（库, 文档）会话化，并有 128 MiB LRU 预算（D07）。
- EPUB 包装层 XML 4 MiB 上限；anydoc 自带限额复核（D08）。
- 扫描移出全局状态锁，使用专用 SQLite 连接（D09）。
- EPUB 图片 IO 门控、章节测量收窄、Shiki 有界缓存（D11）。
- 用户库打开失败时进程不再直接退出：降级占位 + 设置/通知里的恢复入口；标注/统计命令拒绝写入（D15）。

`migrate_to_v7` 清空标注是既有产品决策，本轮未改。

## 2. 实施的优化与可维护性

- D10/D16 可重复性能脚本（`perf_baseline` ignored 测试 + `scripts/perf-bundle.mjs`）。
- App 抽出独立 UI 与快捷键 hook；**未**拆 persist store（单 blob）。
- `library_paths` / `sqlite_io`；IPC 命令三方对账；本轮 DTO 双向 JSON fixture。
- `App.css` 按 base → layout → formats → components → views 分层导入，选择器未改设计语言。
- 测试门禁：`verify.yml` + 发布作业依赖同一验证；工具链 `rust-toolchain.toml` 1.94.0、pnpm 11.5.2。

## 3. 实测前后指标

见 `VALIDATION.md`「D16 性能 A/B」。相对 D10 安静 release 基线：cold_scan +8%；index_build +17%；中文全库 FTS p95 179.6 ms（仍 ≤ 200 ms 候选目标）。不把 D09 脏复测当作对照。Bundle 总 gzip 1827 KiB vs 1822 KiB。

壳层：热导航 firstPaint ~184 ms（debug + Vite）。**不是** NSIS 安装后冷首屏。

## 4. 数据兼容性

- 用户库：`app_data_dir/reade-user.sqlite3`；统计：`reade-stats.sqlite3`；缓存仍可删。
- 备份：用户库 + 统计库 + 偏好 JSON；不含原书、不含转换缓存。恢复进 `restore-pending`，下次启动应用。
- 前端偏好键未迁移。
- 本轮真机 CDP 使用了本机真实 `com.local.reade` 数据目录（Windows Known Folder 不尊重 `APPDATA` 覆盖）。未做损坏库实验。

## 5. 完整验证

| 门禁 | 结果 |
|---|---|
| `pnpm test` | 1519 passed |
| `tsc --noEmit` | 0 |
| `cargo test --locked --lib` | 162 passed + 1 ignored |
| clippy `-D warnings` / fmt | 0 |
| `pnpm build` / `pnpm build:web` | 0 |
| NSIS | `Reade_0.2.0_x64-setup.exe` SHA-256 `E0CE32736F02125CC3CA7BE58148CEE13A763D22951DA9486B7A7331E8C92F4C`；**未签名** |
| 远端 `verify.yml` | 以 PR 首次运行为准（见 VALIDATION 更新） |
| A01–A20 | 见 VALIDATION；多项 NOT_RUN |

## 6. 未验证项与剩余风险

- A02/A04–A09/A12/A13/A18 真机未跑或只跑部分；隔离 profile 失败。
- 窄窗验收用 CDP `Emulation.setDeviceMetricsOverride`，不是拖窗口。
- 安装包未代码签名；未上传商店/Release。
- index_build 相对 D10 +17%，未做隔离 A/B 编译对照。
- 真实用户库若曾被本轮 CDP 打开合成书库，可能留下该 root 的统计绑定；不自动清理。

## 7. 撤回说明

若需撤回本轮桌面加固：回到 `c6a73bd` 之前的 `main`（`94ef1dd`）会丢掉 D00–D11；D12 之后尚未推送的提交可用分支回退。用户库一旦完成 D04 位置迁移，不要用旧版去「抢」缓存目录里的库。备份恢复是正向补救，不是 git revert。
