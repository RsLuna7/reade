# 方案草案：最近书库列表（MRU）

- 日期：2026-08-13（基线查证日）
- 状态：**草案（实施前需复核基线行号并升级定稿）**
- 定位：欢迎页与 Ctrl+O 入口提供"最近打开的书库"列表（路径 + 文档数 + 上次打开时间），点选直达；失效路径灰显可移除。多库用户（工作库/藏书库/临时库）的切换成本从"翻目录对话框"降为一次点击。
- 关联：打开动作仍走既有 `open_library(root_path)` 的校验边界（canonicalize + 扫描），MRU 只是"路径备忘录"；存储沿 `LAST_LIBRARY_KEY` 的 localStorage 先例升级为列表。桌面专属（Web 无书库选择）。

> 一句话：`src/lib/libraryMru.ts` 管理 localStorage `reade-library-mru`（≤8 条：path/title/documentCount/lastOpenedAt），`open_library` 成功后 upsert；欢迎页在"打开书库"按钮下方列出 MRU（新 command `probe_library_path(path) → exists` 批量灰显失效项）；Ctrl+O 改为先弹轻量 MRU 菜单（含"浏览文件夹…"直达原对话框）；点选调 `openLibrary(path)` 走全部既有校验。

---

## 1. 现状基线（已核实于 2026-08-13，行号允许漂移）

| 事实 | 位置 |
|------|------|
| 上次书库记忆已存在：`LAST_LIBRARY_KEY = "reade-last-library"`（单值 localStorage，App 启动时自动重开）——MRU 是它的列表化演进，兼容迁移 | `src/App.tsx` L199、L2986 |
| `open_library(root_path: String)` 接受路径参数、不弹对话框；对话框由前端经 `dialog:allow-open` capability 发起——**MRU 点选 = 直接传路径，边界不变** | `src-tauri/src/library.rs` L277-282；`src-tauri/capabilities/default.json` L8 |
| 书库根只存内存（`LibraryState.root`），Rust 无持久化——持久化职责在前端，现状即如此 | `src-tauri/src/library.rs` L166-173 |
| `LibrarySnapshot { rootPath, documents }` 返回文档列表——**documentCount 与 title（取根目录名）在打开成功时可得** | `src/lib/backend.ts` L44-47 |
| 欢迎页 `Welcome` 组件区分 web/desktop，desktop 有"打开书库"入口 | `src/App.tsx`（Welcome 一族） |
| Ctrl+O 现直接触发目录选择；快捷键改动需同步可访问名称与界面提示（项目纪律） | AGENTS.md 项目特定说明 |
| 失效路径场景：移动硬盘/网络盘断开——打开失败已有 error 通道，但预检需新能力（见 §3.2） | `src-tauri/src/library.rs` L277-309 |
| localStorage 治理先例：readingPositions 按库分组 + 上限 + 版本字段 | `src/lib/readingPositions.ts` L15、L4-5 |
| 路径是敏感展示信息但本就属用户本机（欢迎页显示完整路径可接受；无上传红线不受影响） | — |

## 2. 目标与非目标

**目标**

1. MRU 数据：`{ version: 1, entries: [{ path, title, documentCount, lastOpenedAt }] }`，上限 8 条，`open_library` 成功后 upsert 置顶；从旧 `reade-last-library` 单值一次性迁移。
2. 欢迎页：主按钮下方"最近的书库"列表（标题 + 灰字路径 + "N 篇 · 3 天前"）；失效项灰显 + title 提示"路径不可访问" + hover 出移除钮；有效项点击直接打开。
3. Ctrl+O：改为打开轻量菜单（MRU 列表 + 首项快捷数字 + "浏览文件夹…"）；再次 Ctrl+O 或 Esc 关闭；**无 MRU 时行为与现状完全一致**（直接弹目录对话框）。
4. 失效检测：新只读 command `probe_library_path(path) → bool`（exists + is_dir），欢迎页/菜单打开时批量探测；打开失败也就地标记失效。
5. 顶栏当前库名处（若有）加同一菜单入口，便于阅读中切库。

**非目标（明确不做）**

- 不做"固定收藏库"（8 条 MRU 已覆盖个人场景；置顶语义留远期）。
- 不存书库内容摘要/封面（MRU 是路径备忘录，不是库缓存）。
- 不自动打开"上次库"行为变化（既有自动重开逻辑保留，只是数据源改读 MRU 首项）。
- Web 端不出现任何 MRU UI（无文件系统语义）。

## 3. 设计

### 3.1 存储纯函数（`src/lib/libraryMru.ts` 新建）

```ts
export type LibraryMruEntry = { path: string; title: string; documentCount: number; lastOpenedAt: number };
readLibraryMru(): LibraryMruEntry[]            // 版本校验 + 坏数据丢弃
upsertLibraryMru(entry): LibraryMruEntry[]     // path 归一比较（大小写不敏感，Windows 语义）、置顶、截 8
removeLibraryMru(path): LibraryMruEntry[]
migrateFromLastLibrary(): void                 // 旧单值 → MRU 首项（保留旧键一版，双写过渡）
```

### 3.2 IPC 契约（新只读 command）

| command | 说明 |
|---|---|
| `probe_library_path(path: String) → bool` | `Path::new(path).is_dir()`；不 canonicalize 不进入（纯存在性探测）；**不注册任何写能力** |

- 安全考量：接受任意路径字符串做存在性探测，信息面 = "目录是否存在"，且路径全部来自用户自己打开过的历史，风险可忽略；不返回目录内容。

### 3.3 UI

- 欢迎页列表：语义化 `<ul>`，行为 button；失效行 `disabled` + 移除小钮（模式同 collection-item--missing 灰显先例）。
- Ctrl+O 菜单：轻量 popover（复用现有 popover 样式族），焦点陷阱 + 方向键选择；打开成功后 toast 库名。
- 打开失败（探测通过但 open 失败，如权限）：error 通道现状展示 + 该项标失效。

## 4. 改动清单（预估）

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/libraryMru.ts`（新）+ 测试 | 存储纯函数 + 迁移 | S-M |
| 2 | `src-tauri/src/library.rs` + `lib.rs` | `probe_library_path` + 测试 | S |
| 3 | `src/lib/backend.ts` | wrapper（web 分支恒 false/不可用） | S |
| 4 | `src/App.tsx` | 欢迎页列表、Ctrl+O 菜单、upsert 接线、快捷键提示文案 | M |
| 5 | `src/App.css`、`docs/USER_GUIDE.md` | 样式 + 文档（快捷键说明更新） | S |

## 5. 验收标准（草案级）

- [ ] 纯函数测试：upsert 置顶/去重（大小写不敏感路径比较）、8 条截断、坏 JSON 容忍、旧键迁移一次性。
- [ ] Rust 测试：probe 对存在目录/不存在/文件（非目录）三态。
- [ ] 运行时：打开两个库后欢迎页出现两条；重命名其一目录 → 灰显 + 移除可用；点击有效项直达（含扫描与监听正常）；Ctrl+O 菜单键盘全流程；无 MRU 时 Ctrl+O 行为与现状一致。
- [ ] 回归：启动自动重开上次库不回归；`pnpm test`、`tsc --noEmit`、`cargo test`、`cargo clippy`。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| MR-D1 | 存储位置 | **localStorage（沿 last-library 先例）** | Rust 侧持久化（Rust 现状不存任何库路径，破坏"根只在内存"的简洁边界，否） |
| MR-D2 | 失效检测 | **新只读 probe command 批量探测** | 不探测、点击时才报错（灰显体验没了）；前端 fs 访问（违背"前端不绕过 command 拿文件系统"红线，否） |
| MR-D3 | Ctrl+O 语义 | **有 MRU 弹菜单、无 MRU 保持现状**（渐进增强，零学习成本回退） | 恒弹菜单（单库用户多一步）；新增第二快捷键（快捷键面膨胀） |
| MR-D4 | 上限 | **8 条** | 5（多库用户不够）；20（欢迎页变长列表，失去"最近"语义） |

## 7. 风险

- 本案整体低风险；主要注意 Ctrl+O 行为变化需同步 aria 与 USER_GUIDE 快捷键表（项目纪律），并保证"无 MRU"路径与现状逐字节一致。
- 路径大小写/分隔符归一在 Windows 上有坑（`D:\lib` vs `d:/lib`）：比较用统一归一函数并测试锚定，展示保留原字符串。
- probe 在断开的网络盘上可能阻塞数秒：探测放异步且逐项超时（400ms 视为失效），不阻塞欢迎页首帧。
