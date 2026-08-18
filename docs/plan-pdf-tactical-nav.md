# 方案定稿：PDF 战术翻页（A 批）

- 日期：2026-08-18（基线查证日）
- 状态：**定稿**
- 定位：让原版式 PDF 在「扫描教材 / 有文本层论文」两类场景里，都能像纸书一样**慢翻、快翻、按印刷页跳、回到主线**，且不打断现有三栏、分栏、双页对开、标注与回退栈。
- 来源：知乎 TactiReader 介绍文蒸馏；评估见会话 canvas。本批只做 A，B（页钉 / 锁页）与 C（QWERTY 十键、默认同步滚动等）不在范围。
- 关联：`PdfReader.tsx` 原版式工具栏与 `jump()`；`readingPositions.maxPage` 高水位；`navHistory` 只承接「有意图的跳转」。零新依赖、零新 IPC、不放宽 CSP。

> 一句话：印刷页是显示/跳转偏移（locator 仍用文件页）；A/D 单页、Shift+A/D 按步长掠过（只作用于主栏原版式）；Shift+H 跳到已有 `maxPage`。三件事共用同一套页码换算，分三刀落地，可独立回退。

---

## 0. 为什么是这三件

专业阅读是非线性的：定义、图表、附录、符号表之间来回跳。纸书赢在快翻慢翻、按**印刷页码**找引用、以及「我刚才读到哪」的主线感。Reade 已有分栏、双页对开、Ctrl+B 书签、Alt+←/→ 回退栈，但：

- 页码框只认 PDF 文件页（封面占 10 页就全部错位）。
- 原版式几乎只能点工具栏翻页；方向键仍是像素滚动。
- `maxPage` 已经记下最远页，只是没有「回到主线」的入口。

扫描件没有文本层，全库搜索帮不上；有文本层的论文也会引用「第 87 页」。所以 A 批对两种库都有用。

---

## 1. 现状基线（已核实于 2026-08-18，行号允许漂移）

| 事实 | 位置 |
|------|------|
| 原版式工具栏：上一页 / 页码框 / 下一页 / 缩放 / 适宽 / 双页 / 截取引用 | `src/components/PdfReader.tsx` 工具栏段 |
| 跳页：`jump(page)` 钳在 `[1, numPages]`，滚到页顶（offsetRatio 0）；`PdfReaderHandle` 只有 `getPosition` / `restorePosition` / `getMode` / `setMode`，**无 goToPage** | 同文件 `jump`、`PdfReaderHandle` |
| 页码框 `onChange` 即 `jump(Number(value))`，显示的是文件页；页角 `pdf-page-number` 同样是文件页 | 同文件 |
| 双页时工具栏 ± 按「对」移动（`previousSpreadPage` / `nextSpreadPage`），页码框仍是单页号 | `src/lib/pdfSpread.ts`；工具栏 onClick |
| 阅读位置：`pdf { page, offsetRatio, maxPage }`，`maxPage` 单调升高；`writeReadingPosition` **不能把 maxPage 调低** | `src/lib/readingPositions.ts` |
| 内存高水位：App `readingHighWater.maxPage`，驱动覆盖率 / 热力目录 / 书架角标 | `src/App.tsx`；`homeData.ts`；`tocCoverage.ts` |
| 回退栈：只在文档树、搜索、目录、标注、分栏等**跳转入口** `recordNavDeparture`；工具栏翻页不入栈 | `docs/plan-nav-history.md`；`src/lib/navHistory.ts` |
| 全局快捷键：`Ctrl+O/K/P/B/Z`、`Alt+←/→`、Esc 链；**无** A/D、G、H、Ctrl+G | `src/App.tsx` 全局 keydown |
| 副栏是第二个 `PdfReader`，自带工具栏，**不计时、不写进度、不入主栏历史** | `docs/plan-split-view.md` §3.3；`SecondaryPane.tsx` |
| 标注 / 搜索 / 引用卡片的「第 N 页」全部是文件页；locator.page 是物理页 | `annotationCapture.ts`、`annotationExport.ts`、`regionCard` |
| 偏好持久化：`reade-reader-preferences` partialize 白名单；加字段要改 migrate | `src/store/useReaderStore.ts` |
| 阅读位置 LRU：每库 200 篇，按 `updatedAt` 淘汰——**不能把页校正塞进 position 条目** | `readingPositions.ts` `READING_POSITIONS_LIBRARY_LIMIT` |

---

## 2. 目标与非目标

**目标**

1. **A1 印刷页校正**：在当前文件页标定「对应印刷第 L 页」之后，页码框、页角、跳转按印刷页；文件页仍是内部真相。
2. **A2 键盘双轨翻页**：主栏原版式 `A`/`D` ±1 页（双页时 ±一对，与工具栏一致）；`Shift+A`/`Shift+D` ±步长（默认 10）。`G` 聚焦页码框。
3. **A3 回到主线**：一键跳到该文档已记录的最远文件页；可把主线重设为当前页（打破 `maxPage` 单调）。

**非目标（明确不做）**

- 不做 B 批页钉（Ctrl+1..5）和锁页到副栏。
- 不做 QWERTY 十键、数字键 1–9 设倍率、空格回主线、Vim 式命令模式。
- 不做默认同步滚动、旋转、画笔、`.tactinote`、原版式页内 F 查找、OCR。
- 不读 PDF 内嵌 `/PageLabels`（罗马页码、分段标签一页一类，整数偏移表达不了；避免半成品）。
- 不改标注 locator、搜索 locator、Rust 索引、覆盖率公式——它们继续用文件页。
- 不把校正写入 `readingPositions`（会被 LRU 清掉，且和「读到哪」不是一类数据）。
- 不给副栏挂键盘（两个 listener 会一起翻页）；副栏仍用自己的工具栏。
- 不把 A/D 接到阅读模式（阅读模式是文本流，继续滚轮 / 方向键滚动）。
- 不加新依赖、新 IPC、新 capability。

---

## 3. 设计

### 3.1 页码模型（A1 的唯一契约）

全程两套整数，1-based：

```
physical  =  PDF 文件页（pdf.js / locator / jump / maxPage）
printed   =  physical - offset
offset    =  physical - printed     // 标定时写入
```

例：文件第 37 页标定印刷第 26 页 → `offset = 11`。此后输入 87 → `jump(98)`。

约束：

- `printed` 标定输入必须是 ≥ 1 的整数。
- `|offset| < numPages`，且至少有一页印刷号 ≥ 1 落在 `[1, numPages]` 内，否则拒绝并提示。
- `offset = 0` 或条目删除 = 未校正，UI 与现在完全一致。
- **前置页**（`printed < 1`）：页角 / 页码框回退显示文件页，不显示 0 或负数；跳转仍按印刷号解释，映射后钳在 `[1, numPages]`。
- 负 offset 合法（节选章节：文件第 1 页 = 印刷第 120 页）。

持久化：**独立** localStorage，不进 position、不进 preferences：

```
key: reade-pdf-page-offsets
{ version: 1, libraries: { [libraryRoot]: { [relativePath]: { offset, atPhysical, updatedAt } } } }
```

- 每库上限 200，按 `updatedAt` LRU（与 position 同量级，互不淘汰）。
- 读写全部 sanitize；坏条目丢弃。
- `atPhysical` 只作调试 / 「在文件第 N 页标定」回显，换算不依赖它。

纯函数进 `src/lib/pdfPageOffset.ts`（换算、钳制、sanitize、envelope），配单测。`PdfReader` 经 `libraryRoot` + `relativePath` 读写；App 把 `libraryRoot` 从 store 传入。副栏同一 path 自动共享校正（两个实例各自读存储，无需同步事件）。

### 3.2 显示层：哪些「第 N 页」改字面、哪些不动

| 表面 | 校正后显示 | 理由 |
|------|------------|------|
| 工具栏页码框 | 印刷页；右侧仍 `/ {numPages}` 表示文件总页 | 跳转入口，必须按印刷号 |
| 页角 `pdf-page-number` | 印刷页（前置页则文件页） | 眼动落点 |
| 页码框 `title` / `aria-label` | 「印刷第 26 页，文件第 37 页，共 580 页」 | 不藏文件页 |
| 阅读模式 `Page N` 标签 | 同上规则 | 同一文档两视图不要两套数 |
| 工具栏「标定」钮 | 未校正：标定；已校正：印刷 · 文件（再点可改 / 清除） | |
| 目录 Outline 标题 | **不改** | 来自 PDF 自身字符串 |
| 标注 locator / 搜索跳页 / 引用卡片裁切 | **不改文件页** | 锚点稳定性 |
| 标注列表、金句出处、默认书签名「第 N 页」 | **本批不改** | 避免一次扫所有「第 N 页」；A1 只保证阅读面不迷路。后续可用同一 helper 补显示 |
| 覆盖率 / `maxPage` / 书架「第 N 页」 | **不改** | 高水位是物理进度 |

页码框在已校正时：**输入印刷号，内部 `jump(toPhysical)`**。未校正时行为与现在逐字节一致。

标定 UI：工具栏页码组右侧按钮「标定」。点击后在工具栏下方一条 hint（复用截取引用 `pdf-region-hint` 节奏，不新开居中大对话框）：

```
当前文件第 37 页对应印刷第 [  26  ]   [确定] [清除]
```

确定写 offset；清除删条目。Esc 关掉 hint（与截取引用退出一致，不 preventDefault，全局 Esc 链仍走）。

命令面板（仅当前主栏是 PDF 原版式时出现）：

- 「标定 PDF 印刷页码」→ 打开上述 hint 并聚焦输入
- 「清除页码校正」→ 删条目（无校正时不出现）

快捷键：`Ctrl+Shift+G` 打开标定（避开浏览器 Ctrl+G = 查找下一个）。`G` 在原版式且非输入焦点时聚焦页码框。

### 3.3 键盘双轨（A2）

只在 **主栏** `PdfReader` 上听键：`keyboardActive?: boolean`，App 传 `true`（且命令面板 / 设置 / 笔记框 / 引用卡片等 dialog 未打开）；`SecondaryPane` 不传（默认 false）。

| 键 | 行为 |
|----|------|
| `A` / `D`（无修饰） | ±1 文件页；双页开启时改为 ±一对（调用现成 `previousSpreadPage` / `nextSpreadPage`） |
| `Shift+A` / `Shift+D` | ±`stride` 文件页（钳入 `[1, numPages]`），**不**按对 |
| `G` | 聚焦页码框，选中文本，便于直接打印刷号 |

守卫（全部满足才消费，否则放行）：

- `keyboardActive && mode === "original" && session`
- 非 `event.ctrlKey/metaKey/altKey`（Shift 仅用于快翻）
- `!event.isComposing`
- target 不是 INPUT / TEXTAREA / contentEditable（页码框自己要能打字）
- 标定 hint 打开时，A/D 不翻页（避免和输入冲突）；G 仍可把焦点送回页码框

允许 `event.repeat`（按住连翻）。`preventDefault` 仅在实际消费时。

步长：工具栏页码组内一枚 chip，点击在 **5 / 10 / 20** 间循环，默认 10。**会话级**（`PdfReader` 模块内变量或组件 state，不写 preferences，避免 bump 偏好迁移）。chip 的 `title` 说明「Shift+A / Shift+D 一次跳 N 页」。

方向键、PageUp/Down、空格：**不劫持**，继续原生滚动（打字机模式也不作用于原版式）。

### 3.4 主线（A3）

数据：文件页 `frontier = readingHighWater.maxPage`（App 已有）。没有记录时视为 1。

工具栏（仅主栏，`frontierPage` 有传才渲染）：

- 「主线」按钮：`jump(frontier)`；`currentPage >= frontier` 时 disabled。
- 跳转前走 `onIntentionalJump?.()` → App `recordNavDeparture()`，因此 Alt+← 能回到跳走前。页码框确认跳转、标定不触发；A/D 连翻不入栈。

重设主线：打破单调。新增 `resetPdfMaxPage(libraryRoot, path, page, now)`：把该 PDF 条目的 `maxPage` 写成 `max(1, page)`，保留当前 `page`/`offsetRatio`，并更新 App `readingHighWater`。无条目则写一条 `{ page, offsetRatio: 0, maxPage: page }`。覆盖率会后退——这是用户明确说「主线从这里算」的代价。

命令面板：

- 「跳到最远页（主线）」
- 「将主线设为当前页」

快捷键（同一套守卫，仅主栏原版式）：

- `Shift+H` → 跳到主线（先 `onIntentionalJump`）
- `Ctrl+Shift+H` → 重设主线为当前文件页

不占用 `Ctrl+Home`（容易被理解成滚到文件开头）、不占用空格。

### 3.5 Handle 与 App 接线

```ts
export interface PdfReaderHandle {
  getPosition: () => PdfPagePosition | null;
  getMode: () => "original" | "reading";
  setMode: (mode: "original" | "reading") => void;
  restorePosition: (position: PdfPagePosition) => boolean;
  // 新增，供命令面板 / 主线按钮：
  jumpToPage: (physicalPage: number) => void;
  openPageCalibration: () => void;
}
```

新 props（均可选，副栏全不传即保持现状）：

```ts
libraryRoot?: string;          // A1 读写 offset
keyboardActive?: boolean;      // A2
frontierPage?: number | null;  // A3 展示/跳转
onIntentionalJump?: () => void;
onResetFrontier?: (physicalPage: number) => void;
```

`jumpToPage` 即现有 `jump` 的暴露，命令面板「跳到主线」走 App：`recordNavDeparture(); handle.jumpToPage(frontier)`。

### 3.6 安全与性能

- 存储只有相对路径、整数 offset、时间戳；打开文档仍走 canonicalize。键名不进书库文件。
- 换算 O(1)；keydown 守卫失败即 return，不碰 `jump`。
- 不增加 pdf.js worker、不改变懒渲染窗口。
- Web 版同一套 UI；Web 库目前无 PDF 也不伤害。

---

## 4. 改动清单（按刀）

三刀顺序：A1 → A2 → A3（A2/A3 用 A1 的页码框语义；A3 用 A2 的守卫）。每刀一个 `feat:` 提交，方案本文随 A1 或紧邻提交入库。

| 刀 | 落点 | 内容 | 量级 |
|----|------|------|------|
| A1 | `src/lib/pdfPageOffset.ts` + 测试 | envelope、换算、sanitize、LRU | S-M |
| A1 | `PdfReader.tsx` / `App.css` | libraryRoot、页码框/页角、标定 hint、Ctrl+Shift+G、G | M |
| A1 | `App.tsx` | 传入 libraryRoot；命令面板两条 | S |
| A1 | `docs/USER_GUIDE.md` | 印刷页校正 | S |
| A2 | `PdfReader.tsx` | keyboardActive、A/D、Shift+A/D、stride chip | S-M |
| A2 | `PdfReader.test.tsx` | 守卫、单页/双页步长、输入框不抢键 | S |
| A2 | `USER_GUIDE` 快捷键表 | | S |
| A3 | `readingPositions.ts` + 测试 | `resetPdfMaxPage` | S |
| A3 | `PdfReader.tsx` / `App.tsx` | 主线钮、Shift+H、Ctrl+Shift+H、命令、nav 记录 | S-M |
| A3 | `USER_GUIDE` | 主线 | S |

---

## 5. 验收标准

**A1**

- [ ] 未校正：页码框 / 页角 / 跳转与现在一致。
- [ ] 文件第 37 页标定印刷 26：框显示 26，输入 87 落到文件第 98 页；页角为 26；title 含文件 37。
- [ ] 文件第 1 页（印刷 −10）页角仍显示 1，不出现 0 或负数。
- [ ] 重启后校正还在；清校正后立即回到文件页。
- [ ] 同一 PDF 分栏：主副栏都按校正显示（副栏无键盘）。
- [ ] 旧书签 / 搜索命中仍按文件页落地，位置不漂。
- [ ] 纯函数测试覆盖正/负 offset、钳制、坏 JSON、LRU。

**A2**

- [ ] 主栏原版式：A/D 翻 1 页（双页时翻一对）；Shift+A/D 翻 stride；chip 5/10/20。
- [ ] 焦点在搜索框、页码框、笔记、命令面板时 A/D 不翻页。
- [ ] 副栏打开同一 PDF 时按 A 只翻主栏。
- [ ] 阅读模式、Markdown、EPUB 按 A 不翻页。
- [ ] 中文 IME 合成期间不翻页。

**A3**

- [ ] 读到第 40 页再回到第 10 页，「主线」跳回 40，且 Alt+← 回到 10。
- [ ] 当前页已是最远页时按钮 disabled。
- [ ] 「将主线设为当前页」后覆盖率按新 maxPage；再往前读会重新抬高。
- [ ] `resetPdfMaxPage` 单测：调低、无条目、非法页。

**共同**

- [ ] `pnpm test` 相关文件 + `pnpm exec tsc --noEmit`。
- [ ] 明/暗主题、窄窗工具栏不挤爆（标定 hint 可折行）。
- [ ] 真机：一本带封面偏移的扫描教材 + 一篇普通论文 PDF。

---

## 6. 决策点（已锁定，实施前若要改只改这里）

| # | 决策 | 锁定值 | 若改则影响 |
|---|------|--------|------------|
| D1 | 慢翻键 | `A`/`D`（左手，对齐源文） | 可改 `[`/`]`，避免误触字母 |
| D2 | 快翻 | `Shift+A`/`D` + 会话步长 5/10/20 | 不要数字键 1–9（和页码框冲突） |
| D3 | 主线键 | `Shift+H` 跳转 / `Ctrl+Shift+H` 重设 | 不要空格、不要 Ctrl+Home |
| D4 | 校正存储 | 独立 `reade-pdf-page-offsets` | 不要塞进 `readingPositions` |
| D5 | 「第 N 页」文案范围 | 只改阅读面（工具栏、页角、阅读模式标签） | 标注列表 / 金句出处留后续 |
| D6 | 内嵌 PageLabels | 不做 | 罗马页码教材仍靠手标定 |
| D7 | 提交 | 三刀三 `feat:`，可独立 revert | 不要合成一个大提交 |

---

## 7. 明确留给 B 批

- 3–5 个页钉（与 Ctrl+B 标注书签分家）。
- 「把当前页钉到副栏」（走现有分栏，不默认同步滚动）。
- 把 `formatPrintedPage` 接到标注列表、引用卡片、搜索命中的显示层。
