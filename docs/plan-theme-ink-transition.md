# 方案定稿：主题切换墨水扩散过渡

- 日期：2026-08-13（基线查证日）；定稿：2026-08-13（基线 `a58c566` 复核）
- 状态：**已实施**
- 定位：日/月切换主题时，从按钮位置做一次圆形揭示（"墨水在纸上晕开"），替代当前的全屏交叉淡入。只在"完整"动效档启用；不支持 View Transitions 的引擎优雅回落到现状。零依赖。
- 关联：直接扩展 `src/lib/themeTransition.ts` 的 `applyThemeMutation`（已用 View Transitions API）；动效档语义沿 `motion.ts`；与主题体系（`themes.ts` 四系列×明暗）正交。

> 一句话：`applyThemeMutation` 增加可选 `origin: { x, y }` 参数——有 origin 且 full 档且 `document.startViewTransition` 可用时，在 `transition.ready` 后对 `::view-transition-new(root)` 播放 `clip-path: circle(0 at x y) → circle(R at x y)` 的 WAAPI 动画（R = 到四角最远距离）；其余情形回落既有行为（默认交叉淡入或同步切换）。

---

## 1. 现状基线（已核实于 2026-08-13，行号允许漂移）

| 事实 | 位置 |
|------|------|
| `applyThemeMutation(mutate, motionLevel)`：`motionLevel === "full"` 且支持时 `document.startViewTransition(mutate)`，否则同步 mutate——**扩散动画只是在此函数上加参数，不是新体系** | `src/lib/themeTransition.ts` L18-28 |
| 主题体系：四系列（paper/ink/mist/celadon）× light/dark，`toggleThemeMode` / `setSeries` 纯函数 | `src/lib/themes.ts` L12-17、L153-164 |
| 主题应用方式：`document.documentElement.dataset.theme` + `meta[name=theme-color]` 更新（View Transition 捕获全根快照，天然覆盖） | `src/App.tsx`（主题 effect） |
| 日/月按钮已有图标 opacity/scale 过渡样式（`.theme-state-icon svg`）——按钮自身动画与全屏过渡并存，无 overlay 类残留 | `src/App.css` L890-909 |
| 三档动效：off/subtle/full；off 档 `applyThemeMutation` 已走同步分支 | `src/lib/motion.ts` L1 |
| 桌面运行时 WebView2（Chromium 系）支持 View Transitions；Web 版面向任意浏览器，Firefox 旧版无 `startViewTransition`——现有代码已按能力检测回落 | `src/lib/themeTransition.ts` L18-28 |
| TS lib 为 ES2020 + DOM；`startViewTransition` 类型在现代 DOM lib 中可能缺失，现有实现已有类型守卫写法可沿用 | `tsconfig.json` L3-5 |
| CSP `style-src 'self' 'unsafe-inline'`——WAAPI 动画不产生内联 style 表安全问题；无 CSP 变更 | `src-tauri/tauri.conf.json` L26 |

## 2. 目标与非目标

**目标**

1. 点击日/月按钮：新主题以按钮圆心做圆形扩散揭示，时长 ~450ms、easing `ease-in-out`；系列切换（paper→ink 等）若也经主题按钮流程则同样适用，否则维持交叉淡入。
2. 三档语义：off = 瞬时；subtle = 既有默认交叉淡入（View Transitions 默认动画）；full = 圆形扩散。
3. 能力回落：无 `startViewTransition`（Firefox 旧版）→ 与现状完全一致（同步切换）；`prefers-reduced-motion: reduce` → 强制同步。
4. 连点防抖：过渡进行中再次点击，跳过动画直接应用（`transition.skipTransition()` 或标志位）。

**非目标（明确不做）**

- 不做旧主题"收缩消失"等反向动画变体（一种曲线，策展式）。
- 不为 Firefox 手写 clip-path overlay 模拟（双份 DOM 快照成本与视觉风险不值，回落即可）。
- 不把扩散应用于其他全局状态切换（只有主题切换有"世界翻转"语义）。
- 零新依赖、不改 CSP/capability。

## 3. 设计

### 3.1 API 变更（`src/lib/themeTransition.ts`）

```ts
export function applyThemeMutation(
  mutate: () => void,
  motionLevel: ReaderMotionLevel,
  origin?: { x: number; y: number },   // 新增：视口坐标
): void
```

- full + 支持 + origin：`const t = document.startViewTransition(mutate); t.ready.then(() => { document.documentElement.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] }, { duration: 450, easing: "ease-in-out", pseudoElement: "::view-transition-new(root)" }) })`；`r = Math.hypot(max(x, vw-x), max(y, vh-y))`。
- 需一段全局 CSS 关闭默认过渡以免叠加：`::view-transition-old(root), ::view-transition-new(root) { animation: none; mix-blend-mode: normal; }`（仅当走扩散路径时经 html 上的临时 class 圈定作用域，避免影响 subtle 档默认淡入）。
- 调用点：App.tsx 主题按钮 onClick 取 `event.currentTarget.getBoundingClientRect()` 中心传入。

### 3.2 边界

- `t.ready` reject（快照失败）时静默回落——mutate 已执行，主题不受影响。
- 分屏/浮层打开时同样全根快照，无特殊处理。
- 动画期间指针事件：View Transitions 默认冻结交互 ~450ms，可接受；不额外加锁。

## 4. 改动清单（预估）

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/themeTransition.ts` + 测试 | origin 参数 + 半径纯函数 `revealRadius(x,y,vw,vh)` | S-M |
| 2 | `src/App.tsx` | 按钮坐标传参 | S |
| 3 | `src/App.css` | `::view-transition-*` 作用域样式 | S |
| 4 | `docs/USER_GUIDE.md` | 动效档说明更新 | S |

## 5. 验收标准（草案级）

- [ ] 单测：`revealRadius` 四角最远距离；无 origin/无 API/off 档走既有分支（mock `startViewTransition`）。
- [ ] 运行时（桌面 WebView2）：四系列 × 明→暗/暗→明扩散方向正确、无闪白；连点无叠加动画；subtle 档仍是交叉淡入；off 瞬时。
- [ ] Web：Chromium 系扩散；Firefox（无 API）行为与现状一致（人工验证一次）。
- [ ] `prefers-reduced-motion` 强制同步；截图/录屏留档；`pnpm test`、`tsc --noEmit` 回归。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| TT-D1 | 实现机制 | **View Transitions + `::view-transition-new` clip-path**（新主题晕开、旧主题为底，方向语义正确） | 老主题 clip 收缩（视觉是"擦除"非"晕开"）；手写双层 overlay（Firefox 也能动，但要克隆渲染树，重且险） |
| TT-D2 | subtle 档行为 | **保持默认交叉淡入**（subtle=低刺激，扩散属"完整"表达） | subtle 也扩散但缩短时长（档位语义模糊化，否） |
| TT-D3 | 系列切换（非日月按钮） | **维持交叉淡入**（无自然圆心） | 从屏幕中心扩散（无来源感，动画显得随机） |
| TT-D4 | 时长 | **450ms**（对角线扫过的感知下限） | 300ms（大屏上更像闪烁）；600ms（阻塞交互过久） |

## 6.1 定稿落点（基线 `a58c566` 复核后）

- **基线勘误（TT-D2 修正）**：仓库现状 `applyThemeMutation` 只有 full 档走 View Transitions 交叉淡入，subtle/off 都是同步瞬时切换（`themeTransition.test.ts` 与 USER_GUIDE 均如此表述），并非草案 §2 所写"subtle = 交叉淡入"。定稿按现状收敛：off/subtle 行为零变化；full 无 origin 保持既有交叉淡入；full + origin 才走圆形扩散。
- **TT-D3 修订（按批次任务书）**：扩散源扩展为"日/月按钮 **和** 风格面板色卡"两个触发点；命令面板等无坐标入口不传 origin，维持交叉淡入。
- origin 传递机制：`themeTransition.ts` 增加模块级一次性坐标（`setNextThemeTransitionOrigin` / `consumeThemeTransitionOrigin`，1.5s 保鲜期防陈旧），点击处理器写入、App 主题 effect 消费后传参——不改 store 契约、不给 React 状态添加一次性事件语义。
- `startViewTransition` 返回类型本地宽化为 `{ ready?, finished?, skipTransition? }` 可选结构；`ready`/`finished` 缺失或 reject、`animate` 对伪元素抛错时全部静默清理回落（最坏 = 现状交叉淡入或瞬时）。
- 默认淡入与 clip 动画不叠加：扩散期间 html 挂 `theme-ink-reveal` class 圈定 `::view-transition-old/new(root) { animation: none }`；用引用计数管理并在 `finished.finally` 移除，连点时前一次的清理不会误伤后一次（View Transitions 自身会跳过进行中的过渡，不另加锁）。
- `prefers-reduced-motion` 沿既有档位语义（系统 reduce 令默认档为 off；用户显式选 full 视为明确意愿），不新增媒体查询——与 `runMotion`/既有主题过渡一致。
- 时长 450ms `ease-in-out`（TT-D4）；半径 = origin 到视口四角最远距离（`revealRadius` 纯函数）。

## 7. 风险

- `pseudoElement: "::view-transition-new(root)"` 的 WAAPI 定向在 Chromium 已稳定，但 WebView2 版本随系统更新分布不齐：实施时加能力探针（try/catch animate 调用），异常即回落默认过渡——最坏结果 = 现状，无损。
- 全根快照在超长文档上有一次合成开销：View Transitions 现已在用（subtle/full 淡入同样快照），无新增成本级别；若既有实现在低端机已有掉帧反馈，本方案不恶化但也不解决。
- 作用域 class 若清理不及时会让后续 subtle 淡入失效：`transition.finished.finally` 中移除，测试覆盖。
