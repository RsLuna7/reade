# 实施方案：阅读回退栈（Alt+←/→）

- 日期：2026-08-13
- 状态：**定稿**
- 定位：给"跳走了怎么回来"一个浏览器级答案——搜索结果、双链、相关段落、合集、命令面板、文档树、目录/锚点，每次跳转前记下出发点；`Alt+←` 原路返回（含滚动位置/PDF 页码），`Alt+→` 再跳回去；topbar 常驻后退/前进按钮。
- 关联：路线图 `docs/roadmap-innovations.md` 功能 2（批次 1）。

## 1. 现状基线（已核实于提交 19d136e）

| 事实 | 位置 |
|------|------|
| 会话内滚动位置已有单点记录：`scrollPositions`（Map<path, scrollTop>）滚动时随 rAF 更新，文档切换时 layout effect `reader.scrollTop = sessionTop ?? 0` 恢复——**跨文档 scroll 恢复的现成通道** | `src/App.tsx` L1198、L3540-3542、L3605 |
| PDF 位置基础设施齐备：`PdfReaderHandle.getPosition(): {page, offsetRatio}` 实时测量；`schedulePdfPositionRestore(path, position)` 带重试的跨挂载恢复循环（H0 持久化恢复在用） | `src/components/PdfReader.tsx` L200-205、`src/App.tsx` L1979-1994 |
| EPUB 章节连续排布在同一滚动容器里，滚动位置即章节位置（readingPositions 对 epub 同样记 scroll kind） | `src/App.tsx` L3623（`kind === "pdf" ? "pdf" : "scroll"`） |
| 跳转入口清单：文档树 + 搜索结果（`DocumentTree` 内部直接调 store `selectDocument`，3 处）；链接 tab `handleSelectLinkDocument`；相关段落 `handleSelectRelated`；合集 `onSelectDocument` 包装；命令面板文档条目 run；文档内 TOC `scrollToHeading` 与链接 `handleNavigate`；标注跳转 `jumpToAnnotation`/`handleSelectLibraryAnnotation` | `src/components/DocumentTree.tsx` L153/L193/L237、`src/App.tsx` |
| 全局 keydown effect 已有 Ctrl+O/K/P/B/Z 分支与 Esc 链；Alt+点击（分栏）不冲突（键 vs 点击） | `src/App.tsx` L3428-3505 |
| topbar-actions 是 icon-button 列；库切换走 `openLibrary`（重置 currentPath/搜索等 session 状态的先例位置） | `src/App.tsx` L3958+、`src/store/useReaderStore.ts` L322-349 |
| 浏览器/WebView2 的 `Alt+←` 默认是 history back——必须 `preventDefault`，否则 Web 版整页后退 | 平台行为 |

## 2. 目标与非目标

**目标**

1. 凡跳转（上表全部入口）先记录出发点 `(path, scroll 位置或 PDF 页+页内偏移)`，形成后退/前进双栈；`Alt+←`/`Alt+→` 与 topbar 按钮（禁用态正确）双入口。
2. 恢复复用既有机制：scroll 类经会话 `scrollPositions` 种子 + layout effect；PDF 经 `schedulePdfPositionRestore` 重试循环；markdown/EPUB 记滚动，PDF 记页码+偏移。
3. 栈上限 50 防膨胀；切换书库清空；连续重复位置去重（防同点堆叠）。
4. 归约逻辑为纯函数进 `src/lib/navHistory.ts` 配单测；栈状态进 Zustand store（session-only，不持久化）。

**非目标（明确不做）**

- 不跨启动持久化历史（会话级心智，与分栏布局同派头）。
- 不做历史列表 UI（长按显示清单之类）；不做鼠标侧键（MouseButton 3/4）绑定。
- 副栏（分栏）内部导航不进主栏历史（副栏是参考面，自身已有会话记忆）。
- 主页/统计等视图切换不记录（只记"文档+位置"级跳转）。

## 3. 设计

### 3.1 纯函数层：`src/lib/navHistory.ts`

```ts
export type NavPosition =
  | { kind: "scroll"; scrollTop: number }              // markdown/epub(及 pdf 兜底)
  | { kind: "pdf"; page: number; offsetRatio: number }; // PDF 页 + 页内偏移
export interface NavLocation { path: string; position: NavPosition }
export interface NavHistory { back: NavLocation[]; forward: NavLocation[] } // 栈顶在末尾
export const NAV_HISTORY_LIMIT = 50;
export const EMPTY_NAV_HISTORY: NavHistory;
export function sameNavLocation(a, b): boolean;   // 同路径且位置近似(scroll ±24px / pdf 同页且偏移 ±0.02)
export function pushNavLocation(history, location, limit?): NavHistory; // 与栈顶近似→原样返回;push 清空 forward;超限丢最旧
export function popNavBack(history, current):    { history; target } | null; // current 近似入 forward
export function popNavForward(history, current): { history; target } | null;
export function canNavBack / canNavForward(history): boolean;
```

- push 采用浏览器语义：新跳转清空 forward 栈；`current` 为 null（无打开文档）时 pop 不补对侧栈。
- forward 栈同样受 limit 约束（只经 pop 增长，自然有界，仍显式裁剪）。

### 3.2 store：session-only 栈状态

`useReaderStore` 增 `navHistory: NavHistory`（**不进 partialize**）与三个动作：`recordNavLocation(location)`（push）、`navBack(current)`/`navForward(current)`（pop 并返回 target，由 App 应用）。`openLibrary` 成功后重置 `navHistory`（切库清空；refresh 保留）。

### 3.3 App：捕获、应用与入口

- `captureCurrentNavLocation()`：pdf → `pdfReaderHandleRef.getPosition()`（不可测退 scroll 0）；其余 → `readerRef.scrollTop`；无文档 → null。
- `recordNavDeparture()`：捕获后 `recordNavLocation`。加在：链接 tab、相关段落、合集包装、命令面板文档条目、`jumpToAnnotation`、`handleSelectLibraryAnnotation`、`scrollToHeading`（同文档 TOC/PDF 页/EPUB 章节跳转）、`handleNavigate` 的锚点与跨文档两分支；`DocumentTree` 新增可选 prop `onBeforeSelect`（3 处 selectDocument 前调用）。
- `applyNavLocation(target)`：scroll 类先 `scrollPositions.set(path, top)`——同文档直接赋 `reader.scrollTop`，跨文档交给既有 layout effect；pdf 类走 `schedulePdfPositionRestore`（同/跨文档通吃）；跨文档补 `selectDocument(path)`。
- `Alt+←/→`：全局 keydown 无修饰分支前加 alt 分支，`preventDefault`（拦 WebView2/浏览器整页后退）；topbar-actions 头部加 lucide `ArrowLeft/ArrowRight` 图标按钮，`disabled={!canNavBack/Forward}`，title 带快捷键。
- 恢复导航自身不触发 `recordNavDeparture`（记录点全部在显式跳转入口，天然无需抑制标志）；`popNavBack` 把当前位置放入 forward 栈，往返对称。

### 3.4 安全与性能

- 栈只存相对路径字符串与数字，不触文件系统；打开文档仍走 `selectDocument` → 后端 canonicalize 边界。零新依赖、无新 IPC、不动 CSP/capability。
- 每次跳转 O(1) push（≤50 项小数组拷贝）；捕获为一次 DOM 读取（pdf 为一次页测量，与既有书签捕获同成本）。

## 4. 改动清单

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/navHistory.ts`（新）+ 测试 | 类型与归约纯函数 | S-M |
| 2 | `src/store/useReaderStore.ts` + 测试 | navHistory 状态、三动作、openLibrary 清空 | S |
| 3 | `src/App.tsx` | 捕获/应用、Alt+←/→、topbar 按钮、各入口记录 | M |
| 4 | `src/components/DocumentTree.tsx` | `onBeforeSelect` prop（3 处） | S |
| 5 | `src/App.test.tsx` | 集成："搜索跳转 → Alt+← 回原位" 等 | S-M |
| 6 | `docs/USER_GUIDE.md`、`README.md` | 快捷键表 + 说明；能力清单一行 | S |

## 5. 验收标准

- [ ] 单测（`navHistory.test.ts`）：push 清空 forward；近似栈顶去重；上限 50 丢最旧；back/forward 往返对称（current 入对侧栈）；current 为 null 的 pop；canNavBack/Forward。
- [ ] store 测试：recordNavLocation/navBack/navForward 状态迁移；openLibrary 后 navHistory 清空。
- [ ] 集成（App.test.tsx）：搜索结果跳转 → `Alt+←` 回到原文档且 `scrollTop` 还原 → `Alt+→` 回到搜索命中文档；后退按钮禁用态（空栈）与可用态；`Alt+←` 事件被 `preventDefault`。
- [ ] `pnpm test`、`pnpm exec tsc --noEmit` 全绿。
- [ ] 视觉验收：topbar 按钮明/暗 × 宽/窄截图，存 `output/playwright/roadmap-batch1/`；Web 运行时手工走查"链接跳转 → Alt+← 返回"。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| NH-D1 | 记录点位置 | **显式跳转入口逐处记录**（捕获需要 DOM/PdfReader 在场，且恢复导航天然不触发记录，无需抑制标志） | store `selectDocument` 自动记录（捕获器要注入 store、恢复导航要加抑制标志、同文档锚点跳仍要另记——更复杂不更省） |
| NH-D2 | 位置表示 | **scroll 记 px、PDF 记页+偏移**（与会话 scrollPositions/PDF 恢复循环两条现成通道逐一对应） | 统一记 ratio（换字号/窗口后近似，而会话内 px 是精确的；ratio 留给跨启动的 readingPositions） |
| NH-D3 | 栈的归属 | **Zustand store session 状态**（共享状态进 store 的架构约定；topbar 按钮与快捷键共享禁用态） | App useState（违反约定）；模块级单例（不可测） |
| NH-D4 | 主页等视图切换 | **不记录**（历史是"文档+位置"级；主页往返有自己的按钮心智） | 记录 activeView 变化（栈里混入非位置条目，恢复语义复杂化） |

## 7. 风险与开放问题

- PDF 位置捕获在原版式大文档上是一次页几何测量（与书签捕获同款）；跳转是低频动作，可接受。
- 文档被移动/删除后栈内路径失效：`selectDocument` 报错提示（既有行为），栈条目已消费不复推——接受，不做失联清理。
- Web 版 `Alt+←` 与浏览器手势（触摸板两指滑动）无法拦截后者——文档写明快捷键与按钮为准。
- 字号/窗口尺寸在跳转往返之间变化时，px 级 scroll 恢复会有偏差（会话内低频，接受；与既有会话恢复同精度）。
