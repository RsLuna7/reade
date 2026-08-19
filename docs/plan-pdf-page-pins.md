# 方案定稿：PDF 页钉与锁到副栏（B 批）

- 日期：2026-08-19（相对 `f775f93` 重做）
- 状态：**定稿**
- 定位：A 批解决了「按印刷页跳、快翻慢翻、回到主线」。B 批补纸书另外两件事：**随手卡住几页**（不是 Ctrl+B 知识库书签）、**把当前页摊到旁边对照**。
- 基线：`f775f93`（A 批 + 页码框斜杠留白已落地）。A 的键盘守卫、`jumpToPage`、分栏副栏、`keyboardActive` 全部复用。
- 关联：`docs/plan-pdf-tactical-nav.md` §7；`docs/plan-split-view.md`（副栏降级面，不默认同步滚动）。

> 一句话：每篇 PDF 五个文件页槽位，`Ctrl+1..5` 设、`1..5` 跳；「锁到副栏」把当前文件页写进既有分栏并 jump，不新开第三套阅读器。

---

## 1. 现状基线（已核实于 A 批落地后）

| 事实 | 位置 |
|------|------|
| 主栏原版式键盘：`keyboardActive` + IME/输入框/标定 hint 守卫；`jumpToPage` 已在 Handle 上 | `PdfReader.tsx` |
| Ctrl+B 书签是持久标注，进侧栏与回顾；设/跳都要过 UI | `App.tsx`；`user_store` |
| 分栏：`splitState: { path }`；`handleOpenSecondary(path)`；副栏自管 `readDocument`，PDF 位置走 App 持有的 `panePdfMemory` | `App.tsx`；`SecondaryPane.tsx` |
| 副栏 PDF 恢复：mount 后按 memory `restorePosition` 重试 20 次 | `SecondaryPane.tsx` |
| `onPathChange` 目前 `setSplitState({ path })`，会丢掉其它字段 | `App.tsx` SecondaryPane 接线 |
| 印刷页 offset 独立存储 `reade-pdf-page-offsets`，locator 仍是文件页 | `pdfPageOffset.ts` |
| A2 D2：数字键 1–9 **不**用来设快翻倍率（和页码框冲突）；页钉用 1–5 只在非输入焦点时消费 | 本批与 D2 不冲突：守卫同 A/D |

---

## 2. 目标与非目标

**目标**

1. **B1 页钉**：当前 PDF 五个槽。`Ctrl+1..5` 把当前**文件页**写入该槽（再按一次同一页则清除）；无修饰 `1..5` 跳到该槽（空槽不消费）。工具栏五枚 chip 可点：空=设、有=跳、Ctrl+点击=清。持久化，重启仍在。
2. **B2 锁到副栏**：主栏原版式按钮 / 命令 / `Shift+L`：开启分栏（若未开），副栏打开**同一文档**并跳到当前文件页。已分栏且已是同一文档时只 jump，不重载。窗口 <1080px 沿用既有「无法分栏」提示。

**非目标**

- 不做 QWERTY 十键、槽位命名对话框、默认同步滚动、浮动缩略锁页。
- 不把页钉做成标注（不进回顾、不进导出、不占 Ctrl+B）。
- 不改 locator；钉的是文件页。chip 文案用已有 `displayPageNumber` 显示印刷号。
- 不做 B3（标注列表 / 搜索命中 / 金句出处的印刷页字面）——仍留后续，避免本批扫所有「第 N 页」。
- 副栏不挂页钉键盘；chip 只在主栏（`onPinToSecondary` 或 `keyboardActive` 为真时渲染钉槽；锁页钮仅主栏）。

---

## 3. 设计

### 3.1 页钉存储

独立 localStorage，形状对齐 offset 信封：

```
key: reade-pdf-page-pins
{ version: 1, libraries: { [root]: { [path]: { slots: [n|null, …×5], updatedAt } } } }
```

- 槽内是 ≥1 的文件页整数；`null` 为空。sanitize 时丢非整数、`<1`、超长数组裁成 5。
- 每库 200 篇 LRU（按 `updatedAt`）。
- 同页多槽允许（定义页钉两次没坏处）。
- `src/lib/pdfPagePins.ts` 纯函数 + 读写；同页 fan-out `subscribePdfPagePins`（分栏不显示 chip，主要为热重载/测试）。

### 3.2 键盘与工具栏（仅主栏原版式）

守卫与 A2 相同（含标定 hint 打开时不设/不跳）。

| 键 | 行为 |
|----|------|
| `Ctrl+1..5`（含 Meta） | 槽已是当前页 → 清空；否则写入当前文件页 |
| `1..5` / `Numpad1..5` 无修饰 | 槽有值 → `onIntentionalJump` + `jump`；空槽忽略（不 preventDefault） |
| Chip 单击 | 空 → 设；有 → 跳（记回退栈） |
| Chip Ctrl+单击 | 清空 |
| `Shift+L` | 锁到副栏 |

Chip 标签：空显示槽号 `1`；有值显示印刷号（`displayPageNumber`）。`title` 含槽号、印刷/文件页、快捷键。

### 3.3 锁到副栏

```ts
splitState: { path: string; pinPage?: number; pinSeq?: number } | null
```

- `handlePinToSecondary(physicalPage)`：宽窗不足则 notice；否则 `panePdfMemory.set(path, { page, offsetRatio: 0 })`，`setSplitState({ path: currentPath, pinPage, pinSeq: prev+1 })`。
- `SecondaryPane` 新增 `pinPage` / `pinSeq`：每次 `pinSeq` 变化把 memory 写成该页，并对已挂载的 `jumpToPage` 做与 restore 相同的有限重试（同文档已打开时 restore effect 不会因 Map 原地写入而重跑）。
- `onPathChange` 改为合并 path、清掉 `pinPage`（副栏自己点链接换文档后不再钉旧页）。
- 不入主栏 nav 历史（主栏没跳）。不写 `readingPositions`。

命令面板（主栏 PDF 原版式）：「把当前页钉到副栏」。

### 3.4 安全与性能

- 只存相对路径与整数页号。零新 IPC。
- 不增加第三个 pdf.js worker：副栏本来就会为对照打开第二份阅读器。

---

## 4. 改动清单

| # | 落点 | 量级 |
|---|------|------|
| 1 | `src/lib/pdfPagePins.ts` + 测试 | S-M |
| 2 | `PdfReader.tsx` / CSS / 测试 | M |
| 3 | `SecondaryPane.tsx` + 测试 | S |
| 4 | `App.tsx` splitState、命令、锁页回调 | S |
| 5 | `docs/USER_GUIDE.md` | S |

一笔 `feat:`（B1+B2 同一交互面，拆开会让副栏接线悬空）。

---

## 5. 验收

- [ ] Ctrl+2 钉当前页，翻走后按 `2` 跳回；再 Ctrl+2 清除，`2` 不再跳。
- [ ] 页码框聚焦时按 `2` 只改输入，不跳钉。
- [ ] 副栏打开同一 PDF 时按 `2` 只动主栏。
- [ ] 重启后钉还在；印刷页校正后 chip 显示印刷号，跳的仍是文件页。
- [ ] 锁到副栏：未分栏则打开并停在该页；已分栏再锁另一页，副栏 jump 不重载主栏。
- [ ] 窄窗锁页给出既有宽度提示。
- [ ] `pnpm test` 相关文件 + `tsc --noEmit`。

---

## 6. 决策点（锁定）

| # | 锁定值 |
|---|--------|
| D1 | 5 槽，数字键 1–5，不用 QWERTY |
| D2 | 存文件页；chip 用印刷号显示 |
| D3 | Ctrl 再按同一页 = 清除（不必 Alt+槽） |
| D4 | 锁页走现有分栏，不默认同步滚动 |
| D5 | 标注/搜索「第 N 页」字面仍不动 |
