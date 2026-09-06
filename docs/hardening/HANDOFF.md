# Hardening 交接检查点（HANDOFF）

> 每次中断前更新。格式：HEAD / 已完成 / 进行中 / 最后命令 / 未完成 / 下一条动作。

## 检查点（2026-09-06，D16 本地项结束）

- HEAD：`feature/oxx`（D12–D16 工作区；相对 `c6a73bd` 未提交直至本轮提交）。
- 已完成：D00–D15 代码；D16 本地验证、NSIS（未签名）、性能 A/B、A 矩阵部分真机、FINAL_REPORT。
- 进行中：远端 `verify.yml` 首次运行（需 push/PR）。
- 已知坑：
  - Windows Known Folder **不**走 `APPDATA` 环境变量，不能靠改环境变量做空白 profile。
  - Tauri 2 注入的是 `window.__TAURI_INTERNALS__.invoke`，没有 `window.__TAURI__.core`。
  - `LibrarySwitcherPopover` 留在 App.tsx。
  - App.test backend mock 必须带齐新 IPC。
  - 不要在真实 `com.local.reade` 用户库上做损坏/恢复演练。
