# Hardening 交接检查点（HANDOFF）

> 每次中断前更新。格式：HEAD / 已完成 / 进行中 / 最后命令 / 未完成 / 下一条动作。

## 检查点（2026-09-06 下午，D00–D11 完成 + D12 第一批提取）

- HEAD：94ef1dd，分支 feature/oxx，全部改动未提交（遵守不自动提交）。32+ 个文件已修改，新增文件：verify.yml、rust-toolchain.toml、storage_migration.rs、coverCaptureEvent.ts、MotionNotice.tsx、WelcomeView.tsx、ReadingSettingsPanel.tsx、hardening 文档、fixtures/bundle 脚本。
- 已完成结项：D00–D11 全部（D10 运行时指标 NOT_RUN 归 D16）。状态与证据：docs/hardening/TASKS.md、VALIDATION.md、FINDINGS.md、CONTRACTS.md。
- 进行中：D12——第一批 3 个 UI 边界已提取并全绿（App.tsx 7021 → 6081 行）：
  1. src/components/MotionNotice.tsx（App.tsx 保留 import+re-export 双接线，App.test 从 ./App 的导入契约不变）；
  2. src/components/WelcomeView.tsx（Welcome + WelcomeRecentLibraries；注意 LibrarySwitcherPopover 因原区块误切已放回 App.tsx，勿再动）；
  3. src/components/ReadingSettingsPanel.tsx（面板 + ThemeStylePicker 一并迁出并导出；App.tsx import { ReadingSettingsPanel, ThemeStylePicker } + export { ReadingSettingsPanel }）。
  - 提取方法教训：多行 import 清理受 CRLF 干扰——用正则匹配 CRLF；node -e 内联脚本含反引号会被 bash substitution 破坏——复杂脚本一律写临时 .mjs 文件再执行。
- 下一条动作（D12 继续）：按计划顺序提取——全局快捷键/浮层 hooks（App.tsx 2300-5200 行区段，注意 effect 顺序不可重排）→ store slices（useReaderStore 933 行，按书库/导航/偏好职责）。每提取一个边界：tsc → 定向测试 → 全量 → 更新本文件。
- 最后命令：pnpm test 1505/1505 exit 0；pnpm build 0；cargo test --lib 152 + 1 ignored；clippy/fmt 0。
- 已知坑（勿重蹈）：
  - 机械对账测试 toBe(59)；App.test 的 backend mock 必须与 backend.ts 新导出同步（否则 Unhandled Rejection 风暴）。
  - vitest advanceTimersByTimeAsync 单次长推进不逐次触发 interval；tracker 测试 30s 步进。
  - migrate_to_v7 清空标注是用户确认的产品决策（794b249），不得修复。
  - D09 后性能复测全指标均匀 +22~50%（含未触碰指标）= 机器漂移；D16 需安静机器重跑 cargo test --release ... perf_baseline -- --ignored --nocapture 做干净 A/B。
- D12 之后队列：D13（Rust 拆分 + 契约 fixture + 对账测试升级）→ D14（样式分层 + 焦点管理，需真机截图）→ D15（诊断/备份入口）→ D16（真机验收 A01–A20、NSIS 包 SHA-256、远端 workflow 首跑、性能 A/B、FINAL_REPORT.md）。
