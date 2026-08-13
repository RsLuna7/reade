# 方案草案：标注颜色语义命名

- 日期：2026-08-13（基线查证日）
- 状态：**草案（实施前需复核基线行号并升级定稿）**
- 定位：给黄/绿/蓝/粉四色赋予可改的语义名（默认"金句/疑问/行动/术语"），显示在颜色选择器 tooltip、全库筛选器与图例中。让四色从"随手挑的颜色"变成个人标注体系。**纯展示层，不改标注数据结构。**
- 关联：四色常量与筛选来自标注体系现状（`annotations.ts`/`annotationSearch.ts`/`AnnotationUi.tsx`）；持久化走 `useReaderStore` 阅读偏好（localStorage，双端同构）。

> 一句话：store 新增 `annotationColorNames: Record<AnnotationColor, string>`（persist + migrate，默认 金句/疑问/行动/术语）；`ANNOTATION_COLOR_LABELS` 的消费点改为"色名（颜色）"组合文案；设置面板加四行改名输入（≤6 字符）；筛选器 chip 与标注中枢图例显示色名。数据库、IPC、导出格式零改动。

---

## 1. 现状基线（已核实于 2026-08-13，行号允许漂移）

| 事实 | 位置 |
|------|------|
| 四色字面量：`AnnotationColor = "yellow"|"green"|"blue"|"pink"`（backend 类型）+ `ANNOTATION_COLORS` 运行时数组 | `src/lib/backend.ts` L105；`src/lib/annotations.ts` L11 |
| Rust 侧枚举同构（DB 存小写色名，Highlight/Underline 必须带色）——**存储层完全不动** | `src-tauri/src/user_store.rs` L115-120、L2101-2115、L2222-2224 |
| 选区工具条色块：仅有 `aria-label`（"以黄色高亮"式中文色名），**无 title tooltip**——命名后两者都要接 | `src/components/AnnotationUi.tsx` L81-82 |
| 编辑气泡改色组、列表条目改色 swatch、全库筛选四色圆点（`annotation-color-swatch--*`）——三处消费点 | `src/components/AnnotationUi.tsx` L172-216、L378-424、L545-576 |
| 筛选模型 `AnnotationFilterOptions { query?, kinds?, colors? }`（按色过滤已存在，只差把 chip 文案换成色名） | `src/lib/annotationSearch.ts` L48-55、L63-77 |
| persist 白名单与版本迁移机制（`partialize`/migrate，key `reade-reader-preferences`）——**偏好放这里，双端天然同构** | `src/store/useReaderStore.ts` L612-623 |
| Rust user DB 无 preferences 表（后端不存偏好，本方案维持该边界） | `src-tauri/src/user_store.rs`（schema v1-v5 全览） |
| 导出 Markdown 的条目行含"类型"徽标文案（`buildAnnotationsMarkdown`）——是否带色名见决策点 | `src/lib/annotationExport.ts` L87-147 |
| 回顾卡、金句卡不展示颜色语义——不在本方案范围 | `src/components/ReviewView.tsx` L226-236 |

## 2. 目标与非目标

**目标**

1. 默认命名：黄=金句、绿=疑问、蓝=行动、粉=术语；设置面板"标注"分组四行输入可改（trim、≤6 字符、空则回落默认名）。
2. 展示点全覆盖：选区工具条色块 tooltip+aria-label（"金句（黄）"）、编辑气泡改色组、列表条目 swatch title、全库筛选 chip 文案、标注中枢左列新增四色图例。
3. persist 双端同构（localStorage）；重置按钮一键回默认。
4. 类型安全：色名查询统一经 `getColorName(color, names)` 纯函数（含回落），不散落字符串拼接。

**非目标（明确不做）**

- 不改颜色值本身、不增第五色（四色是数据契约，`docs/plan-*` 多处依赖）。
- 不把色名写入标注数据/导出 JSON/CSV 的结构字段（纯展示；见 CN-D3 导出 Markdown 的例外讨论）。
- 不做"按名筛选"的新检索语法（筛选仍是点 chip，名字只是 chip 的脸）。
- 不做每库独立命名（个人标注体系应跨库一致；每库命名是状态膨胀）。

## 3. 设计

### 3.1 状态与纯函数

```ts
// useReaderStore 新增
annotationColorNames: Record<AnnotationColor, string>;   // persist, migrate 补默认
setAnnotationColorName(color, name): void;               // trim + slice(0,6) + 空回落
// src/lib/annotations.ts 新增
export const DEFAULT_COLOR_NAMES = { yellow: "金句", green: "疑问", blue: "行动", pink: "术语" } as const;
export function colorDisplayName(color, names): string;          // "金句"
export function colorAccessibleLabel(color, names): string;      // "金句（黄色）"
```

### 3.2 消费点改造

- `SelectionToolbar` / `AnnotationEditBubble` / 列表 swatch：`aria-label` 与 `title` 换 `colorAccessibleLabel`（保留颜色词，无障碍不丢信息）。
- 筛选 chip：圆点 + 色名文本；图例：标注中枢 filters 列一个小节四行"● 金句（黄）"。
- 设置面板：四行 `input`（前置色点），onBlur 提交；"恢复默认"按钮。

### 3.3 双端

- 纯前端 + localStorage persist，桌面/Web 自动一致；Web 的 IndexedDB 标注数据不涉及。

## 4. 改动清单（预估）

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/annotations.ts` + 测试 | 默认名与两个纯函数 | S |
| 2 | `src/store/useReaderStore.ts` + 测试 | 字段 + setter + migrate | S |
| 3 | `src/components/AnnotationUi.tsx` + 测试 | 四处展示点 + 图例 | M |
| 4 | `src/App.tsx` | 设置面板输入组 | S-M |
| 5 | `src/App.css`、`docs/USER_GUIDE.md` | 图例/输入样式 + 文档 | S |

## 5. 验收标准（草案级）

- [ ] 纯函数测试：默认回落、6 字符截断、accessible label 含色词。
- [ ] store 测试：migrate 旧版本偏好补默认名；persist 往返。
- [ ] 组件测：工具条色块 title/aria-label、筛选 chip 文案、改名后即时反映。
- [ ] 运行时双端：改名 → 工具条/气泡/筛选/图例四处同步；重置恢复；明/暗截图。
- [ ] 回归：标注四动作与筛选行为零变化；`pnpm test`、`tsc --noEmit`。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| CN-D1 | 默认命名 | **金句/疑问/行动/术语**（阅读场景最常见四分法，与产品"金句卡片"词汇呼应） | 重点/问题/待办/概念（"待办"暗示任务管理，超出阅读器语义） |
| CN-D2 | 存放位置 | **阅读偏好（localStorage，跨库全局）** | Rust user DB 新 preferences 表（为纯展示偏好开 schema 迁移，不成比例，否） |
| CN-D3 | 导出 Markdown | **本期不带色名**（导出是数据出口，掺入易变的展示名会让重复导出 diff 噪音大） | 条目行追加"·金句"（可读性好；若用户反馈强烈再加，作为导出选项） |
| CN-D4 | 名字长度 | **≤6 字符**（chip/tooltip 排版可控） | 不限（长名撑爆筛选行） |

## 7. 风险

- 本方案是 21 案中风险最低的纯展示层改动；主要注意点是 `aria-label` 改动会波及既有组件测试的文案断言，实施时同步更新测试而非放宽断言。
- 用户把四色改成彼此易混的名字（如都叫"重点"）是自由的代价：输入不做唯一性强制，图例常显提供纠错线索。
