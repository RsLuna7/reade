# 方案定稿：Web 移动端阅读手势

- 日期：2026-08-13（基线查证日）；2026-08-13 复核基线并升级定稿（随实现落地）
- 状态：**已实施（真机 iOS/Android 验收待完成，见下）**
- 定稿决策：MG-D1 三重守卫——JS 侧 `mobileGesturesEnabled(APP_RUNTIME, matchMedia("(max-width: 640px) and (pointer: coarse)"))`，CSS 侧媒体查询 × `:root[data-runtime="web"]`（App 挂载时写入，桌面含触屏 Windows 设备不命中）；MG-D2 复用既有 pointerup + selectionchange 双通道捕获（基线复核发现该通道已存在，无需新增）；MG-D3 滚动方向感知半隐（下滑 >48px 半隐、上滑即回、留 14px 提示带）；MG-D4 屏缘热区 24px。
- 实施落点：`src/lib/edgeSwipe.ts`（`resolveSwipeEdge`/`resolveSwipe` 纯函数 + `attachEdgeSwipe`/`attachSwipeDismiss`）、`src/components/MobileToolbar.tsx`（五钮底部工具条，「更多」直达命令面板）、`src/App.tsx`（手势接线、抽屉反向轻扫关闭、聚焦搜索、滚动半隐）、`src/App.css`（移动语境样式与 ≥44px 触控目标、朗读条/读完接着读卡上移、顶栏收敛为标题行）。
- 与草案的偏离：
  1. 触屏选区路径**无需新增**——基线复核确认 App 已有 pointerup + 220ms 防抖 selectionchange 双通道捕获（早于本案落地），本案只补 44px 触控目标样式；
  2. 手势只响应 `pointerType === "touch"`（触控笔/鼠标不触发轻扫，桌面语义交给按钮）；
  3. 程序化滚动（阅读位置恢复走 `.reading-scroll` 的 smooth 滚动，会展开成一串下滑帧）加了 1.2s 方向判定抑制窗，防止底部工具条在恢复位置时被误隐藏。
- 未验证项：真机 iOS Safari / Android Chrome 的屏缘手势与系统手势竞争、`selectionchange` 触发时序（Playwright 触屏仿真已验收，逃生门=底部工具条按钮）；底部工具条与朗读条同屏的真机安全区表现。
- 定位：窄屏（手机）上的 Web 版体验补课：底部工具条替代顶栏密集按钮、左右屏缘轻扫呼出文档树/目录抽屉、长按选区弹标注工具、触控目标 ≥44px。桌面端行为零变化。
- 关联：抽屉本体复用既有 640/820 断点的 fixed 侧栏抽屉与 toc-drawer（`App.css` 响应式体系）；选区工具条与标注动作复用 `AnnotationUi.tsx` 现状；PWA 方案（`docs/plan-web-pwa.md`）落地后本方案是"装到主屏后像原生"的另一半。

> 一句话：新增 `(max-width: 640px) and (pointer: coarse)` 语境——①底部固定工具条（树/目录/搜索/主题/更多，48px 触控高）；②屏缘 24px 热区 pointer 手势（左缘右扫开文档树抽屉、右缘左扫开目录抽屉，位移 >64px 且横向占优判定）；③触屏长按已由系统产生选区，selectionchange 后在选区旁弹既有 SelectionToolbar（坐标取选区 rect，钳制到视口）；④`.icon-button` 等交互件在 coarse 语境下 min 44×44px。纯前端 CSS+事件层。

---

## 1. 现状基线（已核实于 2026-08-13，行号允许漂移）

| 事实 | 位置 |
|------|------|
| 响应式断点：1180（缩侧栏）/ 820（单列 + toc-drawer 抽屉与 backdrop）/ 640（侧栏改 fixed 抽屉、library-toggle 显示）——**抽屉 DOM 与开合状态已存在，手势只是新的触发器** | `src/App.css` L3875-4086 |
| 通用按钮 36×36（`.icon-button`），pdf-toolbar 按钮 min-height 30px——**无 44px 触控规则，需 coarse 语境覆盖** | `src/App.css` L228-231 |
| 选区工具条：`SelectionToolbar` fixed 坐标由选区 rect 派生，桌面 mouseup 驱动——触屏需 `selectionchange` + 防抖驱动（系统长按选词后无 mouseup 语义） | `src/components/AnnotationUi.tsx` L30-48 |
| 选区捕获原语 `captureReaderSelection`（rect/locator/text）与触发时机解耦，可被触屏路径复用 | `src/lib/annotationCapture.ts`（capture 一族） |
| 标尺类 hover 功能已按 `(hover: hover)` 守卫的先例（聚焦模式方案同款约定）；运行时判定 `APP_RUNTIME`——**手势层要求 web 运行时 + coarse pointer 双守卫**（桌面触屏 Windows 设备不误伤：仅 Web 生效） | `src/lib/backend.ts` L241-242 |
| 顶栏按钮群（主题/统计/搜索等）在 640px 下已有压缩布局，但仍在顶部（拇指不可达区） | `src/App.css` L4015-4086 |
| viewport meta 已有 | `index.html` L6 |
| Web 无统计视图/无 PDF——底部工具条按钮集比桌面顶栏更小 | `src/App.tsx` L1239-1242；`src/lib/backend.ts` L298-300 |
| 朗读条 fixed 右下 24px——与底部工具条位置冲突，需上移适配 | `src/App.css` L2692-2705 |
| 阅读进度线 2px 在顶部——保留 | `src/App.css` L933-950 |

## 2. 目标与非目标

**目标**

1. 底部工具条（仅 web + ≤640px + coarse）：文档树、目录、搜索、主题、更多（溢出菜单收纳其余动作），高 56px 含安全区 `env(safe-area-inset-bottom)`；顶栏在该语境下收敛为标题行。
2. 屏缘轻扫：左缘 24px 热区右扫 → 文档树抽屉；右缘左扫 → 目录抽屉；抽屉开启时反向轻扫或点 backdrop 关闭；与正文横向滚动元素（表格/代码块）冲突时热区优先（起点在屏缘即判手势）。
3. 触屏选区：系统长按/拖柄产生选区 → 300ms 防抖的 `selectionchange` → 弹 SelectionToolbar（四色/高亮/下划线/笔记/书签/相关/卡片按既有可用性）；工具条自身按钮 ≥44px。
4. 触控目标：coarse 语境全局 `min-width/min-height: 44px`（icon-button、树行、目录行、chip 类）。
5. 桌面（fine pointer / >640px / 桌面运行时）行为与视觉零变化。

**非目标（明确不做）**

- 不做翻页手势/音量键翻页（连续滚动是产品形态）。
- 不做 pull-to-refresh 自定义（浏览器默认行为不拦截）。
- 不做桌面版触屏适配（Tauri 窗口触屏用户极少，守卫明确排除，降低回归面）。
- 不引入手势库（pointer 事件手写 ~80 行）。

## 3. 设计

### 3.1 手势层（`src/lib/edgeSwipe.ts` 新建）

```ts
attachEdgeSwipe(element, { edgeWidth: 24, threshold: 64, onLeftEdgeSwipe, onRightEdgeSwipe }): () => void
```

- pointerdown 起点在热区 → 跟踪 pointermove：横向位移 >64px 且 |dx|>2|dy| 判定成功（判定前不 preventDefault，保证纵向滚动不受损）；`touch-action: pan-y` 施加于热区元素。
- 纯函数判定逻辑（`resolveSwipe(start, current)`）独立可测。

### 3.2 底部工具条

- `MobileToolbar` 组件：`position: fixed; bottom: 0; left/right: 0`，五钮 + 安全区 padding；显隐由 CSS 媒体查询控制（组件恒挂载，Web 构建才渲染）；向下滚动 48px 后自动半隐（translateY）、向上滚动即回——阅读沉浸与可达性平衡。
- 朗读条在该语境 `bottom` 上移至工具条上方。

### 3.3 触屏选区工具条

- `selectionchange` 监听（仅 coarse）：防抖 300ms，选区非空且在正文内 → `captureReaderSelection` → 打开工具条（rect 取 `getBoundingClientRect`，钳制视口，优先出现在选区上方避开系统菜单区）；选区清空即关。
- 与系统文本选择菜单（浏览器自带"复制/搜索"）共存：无法禁用，接受两层菜单短暂并存（业界常态），工具条位置避让选区正下方。

## 4. 改动清单（预估）

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/edgeSwipe.ts`（新）+ 测试 | 手势判定 | S-M |
| 2 | `src/components/MobileToolbar.tsx`（新） | 底部工具条 | M |
| 3 | `src/App.tsx` | 手势接线、selectionchange 路径、朗读条位移 | M |
| 4 | `src/App.css` | coarse 语境 44px 规则、工具条样式、顶栏收敛 | M |
| 5 | `docs/USER_GUIDE.md` | 移动端手势说明 | S |

## 5. 验收标准（草案级）

- [ ] `resolveSwipe` 单测：阈值、方向占优、热区判定。
- [ ] 真机/移动仿真（Playwright 触摸仿真 + 至少一台真机）：两侧轻扫开合抽屉；表格横滚不被误判；长按选词出工具条并完成一次高亮；底部工具条滚动半隐。
- [ ] 触控目标审计：coarse 语境下交互件 ≥44px（devtools 逐类抽查记录）。
- [ ] 桌面回归：fine pointer 下无任何视觉/行为变化（截图对比）；`pnpm test`、`tsc --noEmit`、`pnpm build`、`pnpm build:web`。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| MG-D1 | 生效守卫 | **web 运行时 + ≤640px + `(pointer: coarse)` 三重**（桌面零回归优先） | 仅媒体查询（桌面窄窗鼠标用户会看到底部工具条，行为漂移） |
| MG-D2 | 选区触发 | **selectionchange 防抖**（触屏无 mouseup 可依赖） | 自实现长按计时器（与系统选区手势打架，否） |
| MG-D3 | 底部工具条显隐 | **滚动方向感知半隐** | 常显（挤占小屏高度）；全隐靠手势（发现性差） |
| MG-D4 | 屏缘热区宽 | **24px** | 16px（难触发）；32px（与正文交互冲突面大） |

## 7. 风险

- iOS Safari 的屏缘手势（返回/前进）与左右缘轻扫存在系统级竞争：左缘尤甚——真机验收是硬门槛；若冲突不可接受，回退策略为左缘手势改为工具条按钮唯一入口（方案内建逃生门）。
- `selectionchange` 在各移动浏览器的触发时序碎片化：防抖 + 选区非空校验兜底，验收覆盖 iOS Safari 与 Android Chrome 两端。
- 底部工具条与既有 fixed 元素（朗读条、read-next 卡若落地）的窄屏 z-index/位置编排需要一张专门的浮层矩阵图，定稿时绘制。
