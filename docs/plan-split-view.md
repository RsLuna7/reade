# 实施方案:双栏对照阅读

- 日期:2026-08-13
- 状态:**已实施**
- 定位:中间内容栏可分裂为左右两个阅读面——左边(主栏)是"我的工作台",右边(副栏)是"参考资料"。典型场景:论文 PDF + 笔记 Markdown 对照;同一文档的两个位置对照。副栏是**降级的纯净阅读面**,不是第二个全功能阅读器。
- 关联:批注、TOC、搜索跳转、阅读追踪、位置持久化(`docs/plan-home-view.md` H0)全部只跟主栏,本方案不改这些子系统的任何契约;「本地朗读」(`docs/plan-read-aloud.md`)同样只跟主栏,两方案正交。

> 一句话:副栏是一个自管理 `readDocument` 状态的 App 级组件(session-only,不进 store、不持久化),塞进 `content-grid` 新增的一列;三个阅读器组件因为都用 `closest(".reading-scroll")` 自寻滚动根,可以零改动在副栏复用;所有"单文档假设"的下游(批注/TOC/追踪/位置)保持只认主栏,复杂度被锁在一个新组件里。

---

## 1. 现状基线(全部【已核实】于本仓库源码)

| 事实 | 位置 |
|------|------|
| 三栏布局:`reader-shell` grid = `var(--sidebar-width) minmax(0,1fr)`;`content-grid` 两列 = `minmax(0,1fr) var(--toc-width)`(200px,≤1180px 时 156px) | `src/App.css` L102-109、L952-958、L10-12、L3055-3061 |
| 阅读容器单例:`readerRef`(滚动根 `.reading-scroll`)与 `articleRef`(`.article-shell`)各一份,全部阅读交互 effect 绑定其上 | `src/App.tsx` L1147-1148、L3499-3501 |
| **三个阅读器都通过 `closest(".reading-scroll")` 自寻滚动根**,不依赖全局 ref:PDF 的 `findReadingRoot`、EPUB 的活动章节跟踪;PDF 工具栏 sticky 于自身容器 | `src/components/PdfReader.tsx` L256-258;`src/components/EpubReader.tsx` L309;`src/App.css` L1061-1076 |
| `PdfReader` 的批注/TOC 相关 props 可空转:`annotations?`/`fuzzyAnchoring?`/`readerRef?` 可选,`onTocChange`/`onActiveChange` 可传 no-op;`EpubReader` 同构 | `src/components/PdfReader.tsx` L207-223;`src/components/EpubReader.tsx` L14-26 |
| 选区捕获(批注创建)只绑定 `readerRef` 单容器;`SelectionToolbar` 全局单例 | `src/App.tsx` L2439-2506、L3764-3776 |
| 滚动记忆:会话内 `scrollPositions` Map + H0 持久化管道(rAF 采样 + 500ms debounce 落 localStorage),恢复走 `useLayoutEffect`——全部以 `currentPath`(主栏)为键 | `src/App.tsx` L1155-1163、L3069-3123、L3009-3040;`src/lib/readingPositions.ts` L185-239 |
| 阅读追踪是单文档模型:`tracker.openDocument` 跟随 `activeView === "reader" && currentPath` | `src/App.tsx` L1250-1262 |
| `selectDocument` 是主栏唯一入口:写 `currentPath/currentContent` 并强制 `activeView: "reader"` | `src/store/useReaderStore.ts` L401-421 |
| 阅读参数以 CSS 变量注入 `reader-shell` 顶层:`--reader-measure` 是 `article-shell` 的 `max-width`,分栏后两栏自然共享同一套排版参数 | `src/App.tsx` L1446-1460、L3247;`src/App.css` L969-977 |
| 响应式断点:≤1180px 收窄轨道;≤820px `content-grid` 退单列、TOC 进抽屉;≤640px 侧栏抽屉化;窗口 `minWidth: 760`,`body` min-width 680px | `src/App.css` L3055-3089、L3091-3106、L3195-3206、L54;`src-tauri/tauri.conf.json` L19 |
| PDF 内存治理先例:range transport 256 KiB 分块、页懒渲染(IntersectionObserver rootMargin 1200px)、canvas 像素比 `min(dpr, 2)`、阅读模式对 >128 MiB 文件禁用 | `src/components/PdfReader.tsx` L21-23、L330-339、L387、L965 |
| `PdfReader` 以 lazy 单例 chunk 加载,多实例共享模块;每个 `getDocument` 任务默认持有自己的 pdf.js worker | `src/App.tsx` L176 |
| `DocumentTree` 零 props、直连 store,文档点击 `selectDocument`(树条目与搜索结果两处) | `src/components/DocumentTree.tsx` L28、L144、L180、L218 |
| 副栏 markdown 可用的无批注渲染器已存在:PDF 阅读模式内部就直接用 `MarkdownRenderer`(props: `content`/`resolveImageSrc`/`onNavigate`) | `src/components/PdfReader.tsx` L1009 |
| markdown 图片资产解析 effect 与 `currentPath` 耦合(主栏专用),副栏需要自己的资产管道 | `src/App.tsx` L2972-2999 |

## 2. 目标与非目标

**目标**

1. 阅读面可分裂为主/副两栏:副栏可打开库内任意文档(含与主栏同一文档),三种格式都能渲染,独立滚动。
2. 主栏全功能不变:批注、TOC 跟随、搜索跳转、阅读追踪、位置持久化的行为与单栏**逐字节一致**。
3. 副栏是明确降级的阅读面(见 §3.3 能力表),复杂度不外溢。
4. 双端(桌面/Web)行为一致;窄窗自动退化。

**非目标(明确不做)**

- **不做同步滚动联动、双向对照高亮**——这两个是"对照阅读"的高阶能力,依赖跨文档锚点映射,先排除;等双栏本身被验证高频使用再立项。
- 不做副栏批注(创建与渲染都不做,v1 传空数组;只读渲染列为 S2 可选,见 SP-D2)。
- 不做第三栏、不做上下分割、不做每栏独立阅读参数(字号/行高/measure 两栏共享)。
- 不持久化分栏布局(跨重启不恢复,对齐 `activeView` session-only 语义)。
- 不动 store 的 `selectDocument`/`currentPath` 契约,不动 Rust/IPC,零新权限、零新依赖。

## 3. 设计

### 3.1 布局与分割条

- `content-grid` 增加 `data-split` 状态:分栏时 `grid-template-columns: clamp(30%, var(--split-pos, 50%), 70%) 6px minmax(0, 1fr) var(--toc-width)`;`--split-pos` 为主栏宽度占比,由分割条拖拽写入(挂在 `content-grid` 的行内 style,session-only)。
- 分割条是 6px 的 `div[role="separator"][aria-orientation="vertical"]`,pointer 事件拖拽 + rAF 节流写 `--split-pos`;键盘可达:聚焦后 ←/→ 每次 2%,`aria-valuenow` 同步。样式用 `var(--line)`/hover `var(--line-strong)`,零新 token。
- **与 `--reader-measure` 的关系(SP-D5)**:两者正交——分割条控制**栏轨道宽度**,`--reader-measure` 继续作为每栏内 `article-shell` 的 `max-width` 上限(App.css L969-977 不动)。窄轨道下 measure 不生效(轨道本身更窄),宽轨道下正文仍被 measure 锁住可读行长。不给副栏单独的 measure。
- TOC 面板保留在最右列,继续服务主栏(§3.3)。

### 3.2 副栏状态模型(SP-D1)

新组件 `src/components/SecondaryPane.tsx` + 纯函数 `src/lib/splitView.ts`:

```ts
// App.tsx 内的 App state(不进 store):
const [splitState, setSplitState] = useState<{ path: string } | null>(null);
// SecondaryPane 内部自管理:
type PaneContent =
  | { status: "loading"; path: string }
  | { status: "error"; path: string; message: string }
  | { status: "ready"; path: string; content: DocumentContent };
```

- **推荐 App state 而非 store**:store 的 `currentPath/currentContent` 与批注加载(`useDocumentAnnotations`)、TOC、追踪、位置持久化深度耦合(基线表第 6-8 行),在 store 里复制一套 `secondaryPath/secondaryContent` 会把"单文档假设"的每个消费者都变成双路由;App state + 自包含组件把全部新复杂度锁在一个文件里。`splitState` session-only,与 `activeView` 的既有语义一致(store L262-263 注释)。
- `SecondaryPane` 自己调用 `readDocument(path)`(不走 `selectDocument`,否则会抢主栏),自带加载/错误态;文档在库刷新后消失时(`documents` 里找不到 `path`)显示失联态并提供关闭。
- 副栏内部持有自己的 `paneReaderRef`(`.reading-scroll` 容器)与滚动 Map(session 内切换文档可回位;**不写 readingPositions**,见 §3.5)。
- 组件按需 lazy(`React.lazy`),不进首屏 bundle。

### 3.3 能力降级表(SP-D2/SP-D3)

| 能力 | 主栏 | 副栏 | 论证 |
|------|------|------|------|
| markdown/pdf/epub 渲染 | ✓ | ✓ | PDF/EPUB 组件零改动复用(props 空转,基线表第 4 行);markdown 用 `MarkdownRenderer`(无批注层) |
| 批注创建 | ✓ | ✗ | 选区捕获 effect 只绑主栏 `readerRef`(现状即如此,零改动达成);副栏划选不出工具条 |
| 批注渲染 | ✓ | ✗(v1) | v1 副栏 `annotations` 传 `[]`/不挂 `AnnotatedMarkdown`;"副栏只读显示已有高亮"列 S2 可选项,等真实需求 |
| TOC 面板/活动项跟随 | ✓ | ✗ | `toc-panel` 继续消费主栏 `onTocChange/onActiveChange`;副栏传 no-op。**固定跟主栏而非"跟焦点栏"**:焦点栏模型要求 TOC、批注面板、`Ctrl+B` 书签、进度条、位置持久化全部感知焦点切换,交互不可预期且改动面爆炸;固定语义"右栏是参考资料"一句话讲清 |
| 库搜索/批注跳转 | ✓ | ✗ | 搜索结果与批注点击都走 `selectDocument`(改主栏),现状不动;需要"在副栏打开搜索结果"时再议 |
| 阅读追踪 activeSeconds | ✓ | ✗ | tracker 是单文档模型(基线表第 7 行);副栏停留不计时。语义:统计回答"我在读什么",主栏就是"正在读的东西" |
| 阅读位置持久化(H0) | ✓ | ✗ | 见 §3.5 |
| PDF 工具栏(翻页/缩放/阅读模式) | ✓ | ✓ | 工具栏是 `PdfReader` 内部实现,sticky 在自身滚动容器内,天然各自独立 |
| 文档内锚点/库内链接点击 | ✓ | 副栏内自导航 | 副栏内点击库内链接 → 副栏自身切换文档(`setPaneContent`),不打扰主栏;外链沿用 `openExternalLink` 确认流程;越界路径沿用主栏同款拦截文案 |
| 图片/EPUB 资产 | ✓ | ✓ | 副栏组件内部复用 `readAsset`/`readEpubAsset` 管道(与 App.tsx L2972-2999 同模式,作用域换成 pane path) |

### 3.4 进入/退出交互(SP-D4)

- **入口 1(主)**:topbar 新增「分栏」icon 按钮(lucide `Columns2`,置于目录按钮旁,`aria-pressed` 语义)。点击 → 副栏打开并**默认加载当前文档**——"同一文档两个位置对照"场景零成本可用;再换文档走入口 2。
- **入口 2**:文档树条目与搜索结果 **Alt+点击 → 在副栏打开**(`DocumentTree` 增加可选 prop `onOpenSecondary?: (path: string, locator?: SearchLocator | null) => void`,条目 `title` 提示"Alt+点击在右侧打开")。分栏未激活时 Alt+点击直接激活。
- **退出**:副栏 header(mini 标题行:文档标题 + 关闭按钮)点关闭;或 topbar 按钮再点一次。`Esc` **不**退出分栏(Esc 已重载八种关闭职责,App.tsx L2914-2927,再挂会误伤)。
- 不新增全局快捷键(v1);`Ctrl+O/K/B/Z` 语义不变(B 书签仍落主栏)。
- 动效:副栏进出用既有 `reade-motion-panel` 等级体系,`motionLevel === "off"` 无动画。

### 3.5 readingPositions 与滚动记忆的语义

- **主栏照旧**:会话 Map 与 H0 持久化管道零改动——写入键是 `currentPath`,副栏根本不经过这条管道。
- **副栏只有会话记忆**:pane 内部 `Map<path, scrollTop>`(PDF 用 `PdfReaderHandle.getPosition/restorePosition` 同款机制),重启即丢。
- 边界情形:主副栏打开**同一文档**时,只有主栏写 readingPositions——持久化位置语义是"我读到哪了",主栏就是"我";副栏滚动不污染主栏进度、不推 `maxScrollRatio` 高水位(热力目录 T2 与继续阅读百分比因此不受副栏影响)。
- 退出分栏不回写任何位置;重开分栏 + 同文档时可命中 pane 会话 Map。

### 3.6 窄窗行为(SP-D6)

- **断点 1080px**(介于 1180 收窄与 820 单列之间):窗口宽 <1080px 时——
  - 分栏未激活:「分栏」按钮禁用(`disabled` + title 说明"窗口过窄");
  - 分栏已激活:自动退化为单栏(保主栏,副栏状态保留在内存),窗口恢复 ≥1080px 后**自动恢复分栏**(`useMediaQuery("(min-width: 1080px)")`,与 `compactLibraryLayout` 同款模式,App.tsx L182-199/L1146)。
  - 论证:1080px 下主副各得约 380-420px 正文轨道(扣除侧栏 200 + TOC 156 + 分割条),是 CJK 可读下限;760(窗口 minWidth)到 1080 之间双栏必然两头局促。
- ≤820px 的既有单列/抽屉行为完全不动(此时分栏必然已退化)。

### 3.7 性能与内存预算

- 两个 `PdfReader` 并存的内存构成:每实例一个 pdf.js worker + range transport(256 KiB 分块,不整文件驻留)+ 渲染窗口内 canvas(rootMargin 1200px ≈ 视口外各 1-2 页;单页 A4 @scale 1 dpr 2 ≈ 1640×2320×4B ≈ 15 MB)。估算:单栏 PDF 稳态 canvas ~45-75 MB,双栏翻倍。
- **预算(进验收)**:双栏各开一个 ≥100 页 PDF,滚动一轮后稳态,进程 Commit 相对"单栏开同一 PDF"基线的增量 ≤ 350 MB;双栏各自滚动无 >50ms 长帧;拖拽分割条(触发两栏 PDF 重排/`--total-scale-factor` 重算,ResizeObserver 已有,PdfReader L341-347)在 rAF 节流下无累积布局抖动。
- markdown/epub 副栏成本 = 一份 DOM,无额外预算项。
- 超预算后手(不在本期):副栏 PDF 降低渲染余量(rootMargin 减半)或副栏 canvas 像素比锁 1。

### 3.8 安全

- 副栏读文档/资产全部走既有 `readDocument`/`readAsset`/`readEpubAsset` command,路径校验、大小上限、越界拦截由 Rust 层现状保证;前端不新增任何文件访问路径。
- 零 CSP/capability 变更、零新依赖、零 Rust 改动;Web 端走 `webLibrary` 同名分支,双端行为一致。

## 4. 改动清单(预估)

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/splitView.ts`(新)+ 测试 | `--split-pos` clamp、断点判定、pane 内容状态归约等纯函数 | S |
| 2 | `src/components/SecondaryPane.tsx`(新,lazy)+ 测试 | 自管理加载/错误/失联态、三格式渲染、内链自导航、会话滚动 Map、资产管道 | M-L |
| 3 | `src/App.tsx` | `splitState`、topbar 按钮、`content-grid` 三列化、分割条、窄窗退化 effect | M |
| 4 | `src/components/DocumentTree.tsx` + 测试 | `onOpenSecondary` prop + Alt+点击分支 | S |
| 5 | `src/App.css` | 分栏轨道、分割条、副栏 header、断点规则 | S-M |
| 6 | `docs/USER_GUIDE.md` | 「分栏对照」一节 | S |

里程碑:**S0** 布局壳 + 副栏 markdown(topbar 入口、默认当前文档、分割条可拖)→ **S1** pdf/epub 复用 + Alt+点击入口 + 窄窗退化 → **S2** 视觉/键盘打磨 + 内存验收 + 文档(可选项:副栏只读批注渲染、交换左右按钮)。

## 5. 验收标准

**S0(布局与 markdown)**

- [ ] 单测(`splitView.test.ts`):`--split-pos` clamp 到 [0.30, 0.70];非法输入(NaN/越界)回落 0.5;断点判定 1080 边界(1079 禁/1080 允)。
- [ ] 组件测(`SecondaryPane.test.tsx`):loading→ready 状态机;`readDocument` reject 显示错误态且不影响主栏;文档从 `documents` 消失 → 失联态 + 可关闭;内链点击调用自身导航而非 `selectDocument`(断言 store `selectDocument` 未被调用)。
- [ ] 组件测(App 级):topbar 按钮切换 `data-split`;分栏激活时主栏 `readerRef` 上的选区捕获/滚动 effect 仍指向主栏(在副栏容器内 dispatch selection 事件,断言 `SelectionToolbar` 不出现)。
- [ ] 回归:单栏(未分栏)下 `content-grid` DOM 与现状逐字节一致(快照);`pnpm test`、`pnpm exec tsc --noEmit` 通过。

**S1(三格式与入口)**

- [ ] 组件测:`DocumentTree` Alt+点击触发 `onOpenSecondary` 且不触发 `selectDocument`;普通点击行为不变(既有测试全数保持)。
- [ ] 运行时(桌面):主栏 markdown 笔记 + 副栏 PDF 论文对照——副栏 PDF 工具栏翻页/缩放/切阅读模式全部只作用于副栏;主栏划选批注、TOC 跳转、`Ctrl+B` 书签全部只作用于主栏;主栏批注跳转链(全库 tab 点击)不受分栏影响。
- [ ] 运行时(同文档对照):主副栏开同一 markdown,主栏滚到 30%、副栏滚到 70% → 重启应用 → 主栏恢复 30%(H0),副栏不恢复;localStorage `reade-reading-positions` 中该文档仅一条记录且 `maxScrollRatio` ≈ 0.3(副栏未污染高水位)。
- [ ] 运行时(Web):`pnpm dev:web` 同一批操作走通;`?doc=` 直达路由不受分栏影响。
- [ ] 窄窗矩阵:1280 → 拖窄到 1000(自动退单栏,主栏保留)→ 拖回 1200(分栏自动恢复,副栏文档与滚动位置不丢);820/640 既有断点行为与主干一致(截图对比)。

**S2(打磨与预算)**

- [ ] 性能验收:§3.7 预算全项——双 100+ 页 PDF Commit 增量 ≤ 350 MB(任务管理器前后对照截图);两栏滚动与拖拽分割条 DevTools Performance 无 >50ms 长帧。
- [ ] 分割条键盘操作:Tab 可聚焦、←/→ 步进 2%、`aria-valuenow` 正确(测试 + 人工)。
- [ ] 视觉走查:明/暗 × 分栏(md+pdf / md+md)× 宽(1440)/临界(1080)≥ 6 张截图;分割条在四个主题系列下辨识度抽查(paper/ink 至少各 1 张)。
- [ ] 全量回归:`pnpm test`、`tsc --noEmit`、`pnpm build`、`pnpm build:web`;Rust 侧零改动(不跑,说明即可)。
- [ ] `docs/USER_GUIDE.md` 新增章节含截图。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| SP-D1 | 副栏状态模型 | **App state + 自包含组件,session-only 不持久化**——复杂度锁进一个文件,store 单文档契约不动 | store 扩展 `secondaryPath/...`(为未来"副栏全功能"铺路,但立即污染全部单文档消费者,否决);持久化分栏布局(违背 activeView session-only 惯例,否决) |
| SP-D2 | 副栏批注渲染 | **v1 完全不渲染**(创建与显示都无) | S2 只读渲染已有高亮(传 `annotations` 但不绑选区捕获)——数据免费,但要处理批注跳转"该跳哪一栏"的歧义,等需求 |
| SP-D3 | TOC/搜索/追踪归属 | **固定跟主栏**(非焦点栏)——语义可预期,零下游改动 | 跟焦点栏:TOC/批注面板/书签/进度条/位置全部双路由,改动面 L 级且交互难预期,否决 |
| SP-D4 | 入口与默认内容 | **topbar 按钮(默认加载当前文档)+ 文档树/搜索 Alt+点击**;无新全局快捷键 | 只有 Alt+点击(可发现性差);`Ctrl+\` 快捷键(留待用户反馈) |
| SP-D5 | 分割条与 measure | **分割条调栏轨道(`--split-pos` 30-70%),`--reader-measure` 继续管每栏内正文上限,正交不干涉** | 分栏时忽略 measure(宽屏下副栏正文过宽,否决) |
| SP-D6 | 窄窗断点 | **<1080px 禁入/自动退化(保主栏、状态保留),恢复宽度自动回来** | 断点 960(每栏 <350px,CJK 排版过窄);退化后不自动恢复(状态丢失感,否决) |

## 7. 风险与开放问题

- **双 PDF 内存是最大硬风险**:预算数字(§3.7)基于 canvas 尺寸推算,实机可能因 pdf.js 内部缓存(字体、图像解码)偏高;S1 就应在真实论文 PDF 上抽测一次,超预算则提前启用"副栏渲染余量减半"后手,不拖到 S2。
- 分割条拖拽期间两个 PDF 栏连续重排(`--total-scale-factor` 重算 + canvas 重渲染):若实测卡顿,降级为"拖拽中只移动分割线幽灵,松手才应用 `--split-pos`"(一次性重排)。
- 主栏文档被删除/移动时 store 会清 `currentPath`(refreshLibrary 现状),分栏此时的表现要走查:主栏回 Welcome 而副栏仍在——可接受,但视觉上"左空右有"需要确认不诡异,必要时副栏一并关闭。
- `MarkdownRenderer` 在副栏的链接确认弹窗(`window.confirm`)是全局模态,无法标识"来自副栏"——文案已含目标 URL,可接受;不为此改造确认机制。
