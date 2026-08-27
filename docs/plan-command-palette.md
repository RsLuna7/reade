# 实施方案：命令面板（Ctrl+P）

- 日期：2026-08-13
- 状态：**已实施**
- 定位：一个键盘优先的全局切换器——`Ctrl+P` 呼出浮层，单输入框模糊匹配三类条目（库内文档 / 合集 / 命令），↑↓ 选择、Enter 执行、Esc 关闭。鼠标一次都不用碰，就能换文档、开分栏、切主题。
- 关联：路线图 `docs/roadmap-innovations.md` 功能 1（批次 1）。

## 1. 现状基线（已核实于基线提交 e612720）

| 事实 | 位置 |
|------|------|
| 全局快捷键集中在一个 window keydown effect：`Ctrl+O/K/B/Z` + Esc 关闭链 | `src/App.tsx` L3211-3281 |
| Esc 链逐个关闭弹层（settings/stylePicker/annotationPanel/collectionsPopover…），朗读激活时 Esc 优先停朗读（RA-D6） | 同上 L3214-3235 |
| 弹层房子模式：`reade-motion-panel` + `role="dialog"`；居中弹窗先例 `quote-card-dialog`（fixed 定位 + `min(560px, calc(100vw - 32px))`） | `src/App.tsx` L516、`src/components/QuoteCardDialog.tsx` L109、`src/App.css` L3257 |
| 文档快照在内存：store `documents: DocumentInfo[]`（title/relativePath/format） | `src/store/useReaderStore.ts` L248 |
| 合集列表一次 IPC：`listCollections()` 双端 wrapper | `src/lib/backend.ts` L508 |
| 可复用动作齐备：`toggleTheme`/`setThemeSeries`（store）、`setActiveView`、`handleToggleSplit`（L1650）、`handleReadAloudButton`（L1550）、`setSettingsOpen`、`chooseAndOpenLibrary`（桌面）、`refreshLibrary`、`searchRef.focus()`（Ctrl+K 同款） | `src/App.tsx` |
| 合集分区展开态是组件内 state；`toggleOpen` 首开时拉取条目 | `src/components/CollectionsSection.tsx` L96-L184 |
| 格式徽标文案先例：`markdown → MD`，其余大写 | `src/components/DocumentTree.tsx` L201-203 |
| 动效三档由 `:root[data-motion]` 驱动；窄窗（≤640px）文档库是抽屉 | `src/App.css` L26-40、App `compactLibraryLayout` |

## 2. 目标与非目标

**目标**

1. `Ctrl+P` 开/关命令面板（桌面与 Web 同套 UI）；WebView2/浏览器的默认打印行为被 `preventDefault` 掉。
2. 三类条目：文档（标题+路径+格式徽标，来自内存快照，零 IPC）、合集（打开面板时拉一次 `listCollections`）、命令（仅列当前可执行的既有动作）。
3. 手写模糊匹配纯函数进 `src/lib/commandPalette.ts`：ASCII 子序列匹配 + CJK 子串匹配 + 打分排序，完整单测。
4. 键盘完备：↑↓ 循环选择、Enter 执行、Esc 关闭；combobox/listbox ARIA 结构；窄窗可用；遵守三档动效。

**非目标（明确不做）**

- 不做拼音匹配、不引入任何模糊搜索依赖（零新依赖红线）。
- 不做全文内容搜索（`Ctrl+K` 已有全文检索；面板匹配的是标题/路径/名称）。
- 不做 MRU 权重（批次 2 的功能 23 落地后再联动）。
- 不做命令自定义/快捷键改绑。

## 3. 设计

### 3.1 纯函数层：`src/lib/commandPalette.ts`

```ts
export type PaletteEntryKind = "document" | "collection" | "command";
export interface PaletteEntry {
  kind: PaletteEntryKind;
  id: string;          // doc:<path> / col:<id> / cmd:<key>
  title: string;       // 主匹配文本（权重 ×3）
  subtitle?: string;   // 路径/提示（权重 ×1）
  keywords?: string;   // 隐形别名（权重 ×2），如命令的英文名
  badge?: string;      // MD/MDX/PDF/EPUB/合集/命令
}
export const PALETTE_RESULT_LIMIT = 12;
export function filterPaletteEntries<T extends PaletteEntry>(entries, query, limit?): T[];
```

- 查询按空白切 token，**全部 token 命中**（可命中不同字段）才保留条目；条目分 = 各 token 最佳字段加权分之和。
- 单 token 对单字段：先试**连续子串**（大小写不敏感；命中得高基础分 + 前缀/词界加成 − 位置惩罚）；未中且 token 为纯 ASCII 时退**子序列匹配**（低基础分 + 连续段/词首加成）；**含 CJK 的 token 只接受子串命中**——避免"数学"子序列命中"数量学说"这类假阳性。
- 空查询：按传入顺序取前 limit 条（App 传入顺序 = 文档 → 合集 → 命令）。
- 排序：分数降序；同分按 kind 优先级（文档 > 合集 > 命令）再按原始顺序，保证稳定。

### 3.2 组件：`src/components/CommandPalette.tsx`

- `open` 时条件渲染：背板（点击关闭）+ 居中 `role="dialog"` 面板（`command-palette reade-motion-panel`，仿 quote-card-dialog 的 fixed 定位，顶部 12vh，宽 `min(600px, calc(100vw - 32px))`）。
- 输入框 `role="combobox"` + `aria-activedescendant`；结果 `role="listbox"`/`option`。打开即聚焦、query 清空、选中第 0 项。
- ↑↓ 循环、Enter 执行选中项（`onExecute(entry)`）、Esc `stopPropagation` 后 `onClose`（不触发全局 Esc 链）；选中项 `scrollIntoView({ block: "nearest" })`；指针移动改选中、点击执行。
- 行内容：徽标 + 标题 + 副文本（路径省略号）；无结果显示"没有匹配的条目"。
- 动效：入场 160ms 淡入+2px 上移，仅 `:root[data-motion="full"|"subtle"]` 下有过渡，`off` 档瞬时。

### 3.3 App 接线

- state：`commandPaletteOpen`；keydown effect 加 `Ctrl+P`（`event.preventDefault()` 后 toggle——**开与关都要 preventDefault**，否则第二次触发弹系统打印）；Esc 链补 `setCommandPaletteOpen(false)` 兜底。
- 条目构建（useMemo）：
  - 文档：全部 `documents` → title/路径/格式徽标。
  - 合集：面板打开时 `listCollections()` 一次（`collectionsVersion` 参与依赖，写操作后重拉）；失败静默为空（面板降级为文档+命令）。
  - 命令（仅列当前可执行的）：切换浅色/深色、界面风格×4（`setThemeSeries`）、打开主页/返回阅读（需 snapshot）、打开阅读统计（仅桌面）、开启/退出分栏（需文档且宽窗或已开启）、开始/停止朗读（复用 `handleReadAloudButton` 的禁用判定）、打开阅读设置、聚焦全文搜索（需 snapshot；窄窗先开抽屉再聚焦）、刷新文档库（需 snapshot）、选择文档库（仅桌面）。
- 执行：文档 → `selectDocument(path)`；合集 → 清空搜索 + （窄窗）开抽屉 + 通过新增 `reveal={{id, token}}` prop 让 `CollectionsSection` 展开该合集并加载条目；命令 → 各自回调。执行后关面板。
- 安全：条目全部来自内存快照/既有 IPC wrapper；面板不触碰文件系统、不新增 command、不动 CSP/capability。

## 4. 改动清单

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/commandPalette.ts`（新）+ 测试 | 类型、打分、过滤排序 | M |
| 2 | `src/components/CommandPalette.tsx`（新）+ 测试 | 浮层组件 | M |
| 3 | `src/App.tsx` | state、Ctrl+P、条目构建、执行分发、Esc 链 | M |
| 4 | `src/components/CollectionsSection.tsx` | 新增 `reveal` prop（展开指定合集） | S |
| 5 | `src/App.css` | `.command-palette*` 样式（明暗/窄窗/动效） | S |
| 6 | `docs/USER_GUIDE.md`、`README.md` | 快捷键表 + 新章节；能力清单一行 | S |

## 5. 验收标准

- [ ] 单测（`commandPalette.test.ts`）：ASCII 子序列命中与打分（连续子串 > 子序列）；CJK 子串命中、CJK 不做子序列；多 token AND 跨字段；title>keywords>subtitle 权重；空查询顺序与 limit；大小写与空白鲁棒。
- [ ] 组件测（`CommandPalette.test.tsx`）：打开即聚焦；输入过滤；↑↓ 循环与 `aria-activedescendant`；Enter/点击执行对应条目；Esc 只关面板；无结果态。
- [ ] 集成测（`App.test.tsx`）：`Ctrl+P` 打开面板且 `preventDefault`；选文档条目调 `selectDocument`；Esc 关闭。
- [ ] `pnpm test`、`pnpm exec tsc --noEmit` 全绿。
- [ ] 视觉验收：`pnpm dev:web` + playwright 截图 明/暗 × 宽/窄 ≥4 张，存 `output/playwright/roadmap-batch1/`。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| CP-D1 | 匹配算法 | **子串优先 + ASCII 子序列兜底 + CJK 仅子串**（可解释、零依赖、CJK 无假阳性） | 全字段子序列（CJK 假阳性多）；引入 fuse.js（违反零依赖） |
| CP-D2 | 合集执行语义 | **在侧栏展开该合集**（"切到合集"=看清单；`reveal` prop 一处小改） | 直接打开合集第一篇（丢失浏览意图、App 内复制加载逻辑） |
| CP-D3 | 不可用命令 | **隐藏**（面板保持干净，条目本来就是动态构建） | 置灰禁用（多态多测试面，收益低） |
| CP-D4 | 条目上限 | **12 条平铺 + 徽标区分类型**（一屏内可 ↑↓ 遍历） | 分组标题（截断规则复杂化，个人库规模不需要） |

## 7. 风险与开放问题

- WebView2 对 `Ctrl+P` 的打印拦截依赖 `preventDefault` 在 keydown 阶段生效——桌面端实测验证；若个别环境仍弹打印，退路是 capability 层禁用打印（本版不做）。
- 万篇库逐条目打分为 O(N×token)，纯内存字符串操作，预算 <10ms；若将来变慢，先做长度早退再考虑索引。
- 合集条目在面板打开瞬间拉取，极端慢库下合集稍后才出现在结果里——可接受（文档与命令即时可用）。
