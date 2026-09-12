# 方案定稿：最近书库列表（MRU）

- 日期：2026-08-13（基线查证日；同日复核基线并定稿）
- 状态：**已实施**
- 定位：欢迎页与侧栏书库名入口提供"最近打开的书库"列表（路径 + 文档数 + 上次打开时间），点选直达；失效路径灰显可移除。多库用户（工作库/藏书库/临时库）的切换成本从"翻目录对话框"降为一次点击。
- 关联：打开动作仍走既有 `open_library(root_path)` 的校验边界（canonicalize + 扫描），MRU 只是"路径备忘录"；存储沿 `LAST_LIBRARY_KEY` 的 localStorage 先例升级为列表。桌面专属（Web 无书库选择）。

> 一句话：`src/lib/libraryMru.ts` 管理 localStorage `reade-library-mru`（≤8 条：path/title/documentCount/lastOpenedAt），打开书库成功后 upsert；欢迎页在"打开书库"按钮下方列出 MRU（新只读 command `probe_library_path(path) → exists` 异步灰显失效项）；侧栏书库名点击弹出最近书库菜单（含"选择新文件夹…"直达原对话框）；**Ctrl+O 行为完全不变**（仍直接弹目录选择对话框）；点选调 `openLibrary(path)` 走全部既有校验。

---

## 1. 现状基线（定稿复核于 2026-08-13，行号允许漂移）

| 事实 | 位置 |
|------|------|
| 上次书库记忆已存在：`LAST_LIBRARY_KEY = "reade-last-library"`（单值 localStorage，App 启动时自动重开）——MRU 是它的列表化演进，兼容迁移 | `src/App.tsx` L206（常量）、L3266-3276（自动重开与写入） |
| `open_library(root_path: String)` 接受路径参数、不弹对话框；对话框由前端经 `dialog:allow-open` capability 发起——**MRU 点选 = 直接传路径，边界不变** | `src-tauri/src/library.rs` L276-302；`src-tauri/capabilities/default.json` L8 |
| 书库根只存内存（`LibraryState.root`），Rust 无持久化——持久化职责在前端，现状即如此 | `src-tauri/src/library.rs`（AppState/LibraryState） |
| `LibrarySnapshot { rootPath, documents }` 返回文档列表——**documentCount 与 title（取根目录名）在打开成功时可得** | `src/lib/backend.ts` L44-47 |
| 欢迎页 `Welcome` 组件区分 web/desktop，desktop 有"打开书库"入口 | `src/App.tsx` L311-390 |
| 侧栏书库名按钮（`library-button`）desktop 现状直接调 `chooseAndOpenLibrary()`——**本案把它改为弹最近书库菜单** | `src/App.tsx` L3900-3919 |
| Ctrl+O 现直接触发目录选择（`chooseAndOpenLibrary`）——**决策：保持不变** | `src/App.tsx` L3558-3561 |
| 失效路径场景：移动硬盘/网络盘断开——打开失败已有 error 通道，但预检需新能力（见 §3.2） | `src-tauri/src/library.rs` L276-302 |
| localStorage 治理先例：readingPositions 按库分组 + 上限 + 版本字段 | `src/lib/readingPositions.ts` L15-18 |
| 路径是敏感展示信息但本就属用户本机（欢迎页显示完整路径可接受；无上传红线不受影响） | — |

## 2. 目标与非目标

**目标**

1. MRU 数据：`{ version: 1, entries: [{ path, title, documentCount, lastOpenedAt }] }`，上限 8 条，打开书库成功后 upsert 置顶；从旧 `reade-last-library` 单值一次性迁移（迁移条目的 documentCount/lastOpenedAt 为 null，界面上不显示对应元信息）。
2. 欢迎页：主按钮下方"最近打开"列表（标题 + 灰字路径 + "N 篇 · 3 天前"）；失效项灰显 + title 提示"路径不可访问" + 移除钮；有效项点击直接打开。
3. 侧栏书库名（`library-button`）点击改为弹出最近书库菜单（当前库带"当前"徽标、失效项灰显可移除、末尾"选择新文件夹…"直达原对话框）；**MRU 为空时点击行为与现状完全一致**（直接弹目录对话框）；Esc 关闭菜单。
4. 失效检测：新只读 command `probe_library_path(path) → bool`（`is_dir` 存在性探测），欢迎页挂载/菜单打开时异步逐项探测；打开失败也就地标记失效。
5. **Ctrl+O 不变**（保肌肉记忆）：快捷键仍直接弹目录选择对话框，不接菜单。

**非目标（明确不做）**

- 不做"固定收藏库"（8 条 MRU 已覆盖个人场景；置顶语义留远期）。
- 不存书库内容摘要/封面（MRU 是路径备忘录，不是库缓存）。
- 不自动打开"上次库"行为变化（既有自动重开逻辑保留，只是数据源改读 MRU 首项）。
- Web 端不出现任何 MRU UI（无文件系统语义）。

## 3. 设计

### 3.1 存储纯函数（`src/lib/libraryMru.ts` 新建）

```ts
export type LibraryMruEntry = {
  path: string;
  title: string;
  documentCount: number | null;   // null = 未知（旧键迁移条目）
  lastOpenedAt: number | null;    // null = 未知（旧键迁移条目）
};
normalizeLibraryPathKey(path): string          // Windows 语义：统一 \、去尾分隔符、lowercase（仅比较用，展示保留原串）
readLibraryMru(): LibraryMruEntry[]            // 版本校验 + 坏数据逐条丢弃
upsertLibraryMru(entry): LibraryMruEntry[]     // 归一键去重、置顶、截 8、写回
removeLibraryMru(path): LibraryMruEntry[]
migrateLibraryMru(): LibraryMruEntry[]         // MRU 为空且旧键有值 → 播种首项（旧键保留，双写过渡）；随后返回当前列表
formatLastOpened(ms | null, now?): string | null  // "刚刚 / N 分钟前 / N 小时前 / N 天前 / 具体日期"
```

### 3.2 IPC 契约（新只读 command）

| command | 说明 |
|---|---|
| `probe_library_path(path: String) → bool` | `Path::new(path).is_dir()`；不 canonicalize 不进入（纯存在性探测）；**不注册任何写能力** |

- 安全考量：接受任意路径字符串做存在性探测，信息面 = "目录是否存在"，且路径全部来自用户自己打开过的历史，风险可忽略；不返回目录内容。

### 3.3 UI

- 欢迎页列表：语义化 `<ul>`，行为 button；失效行 `disabled` + 移除小钮（模式同 collection-item--missing 灰显先例）。
- 侧栏菜单：轻量 popover（复用 settings-popover/collections-popover 样式族，`role="dialog"` + 标题 + 关闭钮 + Esc 关闭，与既有 popover 一致）；打开成功后 toast 库名。
- 打开失败（探测通过但 open 失败，如权限）：error 通道现状展示 + 该项标失效。

## 4. 改动清单（预估）

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/libraryMru.ts`（新）+ 测试 | 存储纯函数 + 迁移 + 相对时间格式化 | S-M |
| 2 | `src-tauri/src/library.rs` + `lib.rs` | `probe_library_path` + 测试 | S |
| 3 | `src/lib/backend.ts` + `tauriBackend.ts` | wrapper（web 分支恒 false） | S |
| 4 | `src/App.tsx` | 欢迎页列表、侧栏书库菜单、upsert 接线 | M |
| 5 | `src/App.css`、`docs/USER_GUIDE.md`、`README.md` | 样式 + 文档 | S |

## 5. 验收标准（定稿）

- [x] 纯函数测试：upsert 置顶/去重（大小写与分隔符不敏感路径比较）、8 条截断、坏 JSON 容忍、旧键迁移一次性。
- [x] Rust 测试：probe 对存在目录/不存在/文件（非目录）三态。
- [x] 组件测：欢迎页最近列表点击直达/移除；侧栏菜单打开/选择新文件夹入口；失效项灰显。
- [x] 回归：启动自动重开上次库不回归；Ctrl+O 行为与现状一致；`pnpm test`、`tsc --noEmit`、`cargo test`、`cargo clippy`。
- [ ] 运行时（人工）：打开两个真实库后欢迎页出现两条；重命名其一目录 → 灰显 + 移除可用；点击有效项直达（含扫描与监听正常）。

## 6. 决策点（已定）

| # | 决策 | 结论 |
|---|------|------|
| MR-D1 | 存储位置 | **localStorage（沿 last-library 先例）**；Rust 侧不持久化任何库路径 |
| MR-D2 | 失效检测 | **新只读 probe command 异步探测**；probe 失败/未返回视为未知（保持可点），打开失败就地标失效 |
| MR-D3 | 入口语义 | **Ctrl+O 完全不变（保肌肉记忆）**；最近书库列表放欢迎页 + 侧栏书库名点击菜单；侧栏菜单在 MRU 为空时退化为直接弹目录对话框 |
| MR-D4 | 上限 | **8 条** |
| MR-D5 | 迁移条目元信息 | documentCount/lastOpenedAt 允许 null（旧键播种无法得知），UI 缺省不显示，首次成功打开后补全 |

## 7. 风险

- 路径大小写/分隔符归一在 Windows 上有坑（`D:\lib` vs `d:/lib`）：比较用统一归一函数并测试锚定，展示保留原字符串。
- probe 在断开的网络盘上可能阻塞数秒：探测逐项异步（`spawn_blocking`），不阻塞欢迎页首帧；未返回前条目保持可点（打开失败会经 error 通道提示并就地标失效），避免慢盘被误判为失效。
- 侧栏书库名点击语义从"直接弹对话框"变为"弹菜单"：菜单内保留"选择新文件夹…"首层入口，多一次点击换来多库直达；Ctrl+O 原语义不动作为兜底。
