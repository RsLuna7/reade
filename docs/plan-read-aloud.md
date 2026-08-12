# 实施方案:本地朗读(TTS)

- 日期:2026-08-13
- 状态:**方案定稿,未实施**(M0 为实机冒烟里程碑,见 §0 与 §5)
- 定位:把正文交给 Windows 本地语音朗读,句级跟随高亮 + 极简播放控制。**离线承诺是硬约束**:只允许本地合成语音,任何会把正文文本发往网络的语音一律过滤(§3.1,安全节)。
- 关联:朗读只跟主栏(与 `docs/plan-split-view.md` SP-D3 的归属决策一致);句子定位复用批注 v2 的 offset→Range 工具链(`src/lib/annotations.ts`);朗读计时接入既有阅读追踪(RA-D4)。

> 一句话:`speechSynthesis` + `localService === true` 白名单语音,正文经 `buildTextIndex` 拍平、`Intl.Segmenter`(正则兜底)切句,一句一个 utterance 顺序排队(顺带绕开 Chromium 15 秒截断 bug),当前句用既有 `wrapRangeWithMark` 临时 mark 机制跟随高亮——零新依赖、零 Rust 改动、零权限变更。

---

## 0. 前置风险验证

结论先行:**技术路线在证据上成立,但"桌面 WebView2 实机 getVoices() 的确切输出"缺一手数据,列为 M0 冒烟必做项**(脚本见 §5 M0)。

| # | 结论 | 证据级 | 来源 |
|---|------|--------|------|
| 1 | WebView2(Win32,Tauri Windows 即此形态)支持 `speechSynthesis`,`getVoices()` 返回本地语音;UWP 宿主曾有返回空数组的 bug,已在 Runtime 110.0.1587.41 / 111.0.1644.0+ 修复 | 【已核实】微软员工在官方仓库确认 | [WebView2Feedback #3155](https://github.com/MicrosoftEdge/WebView2Feedback/issues/3155) |
| 2 | Edge 的在线 Natural 语音**在 WebView2 中被微软刻意禁用**("disabled in WebView2 due to cost… no plans to re-enable"),不会出现在 `getVoices()` 里;桌面端语音列表即本地语音 | 【已核实】微软在官方仓库确认 By Design | [WebView2Feedback #2660](https://github.com/MicrosoftEdge/WebView2Feedback/issues/2660) |
| 3 | Chromium Windows 的语音枚举实现:**优先枚举注册表 `HKLM\SOFTWARE\Microsoft\Speech_OneCore\Voices`,失败才回退传统 SAPI5(`SPCAT_VOICES`)**,二者取一不取并集。含义:系统"设置→时间和语言→语音"安装的 OneCore 语音会出现;仅注册到旧 SAPI5 位置的第三方语音(如 Ivona)可能不可见 | 【已核实】Chromium 源码 `content/browser/speech/tts_win.cc`(`GetVoiceTokens`) | [chromium/src tts_win.cc](https://chromium.googlesource.com/chromium/src/+/refs/tags/133.0.6943.121/content/browser/speech/tts_win.cc) |
| 4 | `SpeechSynthesisVoice.localService` 是 Baseline(2018 起全浏览器可用),本地合成语音为 `true`、远程服务语音为 `false`;Edge/Chrome 的在线语音(Natural / Google 网络语音)均报 `false` | 【已核实】MDN;实测文章佐证 Chrome 网络语音 `localService === false` | [MDN localService](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisVoice/localService);[zenn 实测](https://zenn.dev/yk_architect/articles/01a0b4c82bccb9) |
| 5 | 网上流传的"Edge 在线语音把 localService 误报为 true"**未找到权威证据**;但 localService 取值终归由浏览器实现决定,不宜作为唯一防线 | 【推断】检索未见可复现报告 | — |
| 6 | Chromium 桌面存在长 utterance ~15 秒静默截断 bug(chromium #679437 一族),通行解法是句/段级分块 + `onend` 链式排队;有社区说法称仅网络语音受影响、本地语音不受 | 【二手】多个独立来源一致(SO 高票 + 技术文章),官方未修 | [SO 42875726](https://stackoverflow.com/questions/42875726/);[SO 74474649](https://stackoverflow.com/questions/74474649/) |
| 7 | `getVoices()` 首次调用可能返回空数组,列表异步加载,需监听 `voiceschanged`(Chromium 系必现;Firefox/Safari 时序不同) | 【已核实】MDN 官方示例即此写法 | [MDN getVoices](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis/getVoices) |
| 8 | `Intl.Segmenter`(granularity "sentence")运行时:Chromium 87+(WebView2 满足)、Safari 14.1+、Firefox 125+;**TypeScript 类型在 `lib.es2022.intl.d.ts`,本仓库 `tsconfig` lib 为 ES2020,类型不可用** | 【已核实】本仓库 `node_modules/typescript/lib/lib.es2022.intl.d.ts` 含 Segmenter 声明;`tsconfig.json` L3-5 | 本仓库 |
| 9 | Safari(含 iOS)要求 `speak()` 在用户手势内触发 | 【二手】测试机构文章,与 iOS autoplay 政策一致 | [testmuai speech-synthesis](https://www.testmuai.com/learning-hub/speech-synthesis-api-browser-support/) |

由 5/6 两条不确定性得出的设计决策:**只信 `localService === true` 白名单(主防线)+ 名称含 "Online" 的语音再滤一道(纵深,零成本)+ M0 实机断网冒烟(实证)**;句级 utterance 队列本来就是跟随高亮的需要,顺带把 15 秒 bug 变成无关项。

## 1. 现状基线(全部【已核实】于本仓库源码)

| 事实 | 位置 |
|------|------|
| offset→Range 工具链齐备:`collectElementText`、`buildTextIndex`(单次树遍历拍平 + 节点表)、`rangeFromTextIndex`/`rangeFromOffsets`、`elementTextOffsetInIndex`(元素→拍平偏移) | `src/lib/annotations.ts` L272-281、L298-309、L333-346、L379-413、L353-366 |
| 临时 mark 机制先例:`wrapRangeWithMark`(拆文本节点包 `mark.annotation-mark`)+ `clearAnnotationMarks(root, annotationId)` 参数化清除;重定位预览就是"临时 id + 附加 class"用法(`RELOCATE_PREVIEW_ID` + `.annotation-relocate-preview`) | `src/lib/annotations.ts` L415-462、L464-476;`src/App.tsx` L172-173、L1901-1905;`src/App.css` L2258-2262 |
| 批注 mark 视觉:高亮四色半透明底、下划线 2px 底边;临时预览 = `outline: 2px solid var(--accent)` + `--selection` 底 | `src/App.css` L2475-2494、L2258-2262 |
| 朗读根可用的正文容器:markdown `.markdown-body`(`MarkdownRenderer` 的根 `<article>`);EPUB 整书渲染 `.epub-reader` > `.epub-chapter`;PDF 阅读视图逐页 `.pdf-reading-page` > `.markdown-body`(OCR 提示段落在其外) | `src/components/MarkdownRenderer.tsx` L413;`src/App.tsx` L1790;`src/components/EpubReader.tsx` L407-424;`src/components/PdfReader.tsx` L1009 |
| PDF 原版式文本层按可见性懒加载(rootMargin 1200px),不可见页无 DOM 文本;阅读模式数据源 `readPdfReadingMode` 返回 `pages[].markdown` + `missingPages`/`needsOcr`;>128 MiB 或 unsupported 时阅读模式禁用 | `src/components/PdfReader.tsx` L330-339、L511-516、L965;`src/lib/backend.ts` L88-95 |
| 阅读追踪:交互驱动(pointer/key/wheel/scroll),idle 60s 停表;`tracker.recordActivity()` 是公开接口——朗读不触发任何现有 activity 事件 | `src/App.tsx` L1226-1230;`src/lib/readingTracker.ts` L39-40、L49、L185-196 |
| Esc 已重载八种关闭职责(设置/风格/批注面板/抽屉/选区/笔记/编辑气泡/重定位预览) | `src/App.tsx` L2914-2927 |
| topbar 动作区(设置/标注工具等 icon 按钮,popover 用 `reade-motion-panel` 模式) | `src/App.tsx` L3410-3488 |
| `tsconfig` lib = `["ES2020","DOM","DOM.Iterable"]`;AGENTS 约束"保持 ES2020 兼容" | `tsconfig.json` L3-5 |
| CSP 无外源 connect/media;capabilities 仅 `core:default`+`dialog:allow-open`+`opener:allow-open-url`——`speechSynthesis` 不经 CSP、不需 capability | `src-tauri/tauri.conf.json` L26;`src-tauri/capabilities/default.json` L6-10 |
| 阅读设置面板已有 0.05 步进滑杆/分段按钮组等控件模式可复用 | `src/App.tsx` L495-686 |
| 运行时判定 `APP_RUNTIME`/`IS_WEB_RUNTIME` | `src/lib/backend.ts` L214;`src/App.tsx` L171 |

## 2. 目标与非目标

**目标**

1. markdown / EPUB / PDF(阅读模式)正文可被本地语音朗读,句级跟随高亮 + 自动滚动跟随。
2. 播放控制:播放/暂停/停止、上一句/下一句、语速、语音选择;当前句可视。
3. 只使用 `localService === true` 的本地语音,断网可用(M0 实证)。
4. 双端可用:桌面 WebView2 与 Web 各浏览器;无本地语音的环境显式降级为禁用态。

**非目标(明确不做)**

- 不做云 TTS、不做语音包下载引导(只用系统已装语音;提示用户去系统设置装语音属于文案,不属于功能)。
- 不做逐词 karaoke 高亮(word boundary 事件跨引擎不可靠,句级已满足跟随需求)。
- 不做后台/锁屏播放、MediaSession 集成、导出音频。
- 不朗读代码块/公式/表格(跳过,见 §3.2);不做副栏朗读(分栏方案 SP-D3 同款归属:只跟主栏)。
- 零新依赖、零 Rust 改动、零 CSP/capability 变更。

## 3. 设计

### 3.1 语音枚举与离线约束(安全)

新纯函数模块 `src/lib/ttsVoices.ts`:

```ts
loadVoices(synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]>
// 首次 getVoices() 非空即返;否则挂 voiceschanged + 2s 超时兜底(证据 #7)
filterLocalVoices(voices): SpeechSynthesisVoice[]
// 主防线: voice.localService === true
// 纵深:   排除 name 含 /\bonline\b/i 者(证据 #5,零成本黑名单)
pickDefaultVoice(voices, documentLang?: string): SpeechSynthesisVoice | null
// lang 前缀匹配(zh 文档选 zh-*)> voice.default > 列表首项
```

- **过滤后列表为空 → 朗读功能整体禁用态**(按钮 disabled + title"未检测到本地语音,可在系统设置安装"),绝不回退到在线语音——离线承诺写死在过滤器里,不是设置项。
- 语音选择与语速持久化到 store(`ttsRate` clamp 0.5-2.0、`ttsVoiceName` string,存名字而非对象,启动后按名匹配失败则回落默认),沿 `readingSettings` 的 partialize 模式。
- 安全边界:`speechSynthesis` 是浏览器内建能力,不走 IPC、不触 CSP、不需新权限;正文文本只进入本地合成器(过滤器保证),与"不主动上传内容"的项目承诺一致。M0 断网冒烟做实证。

### 3.2 朗读对象与文本提取

统一抽象:**朗读源 = 一组「(DOM 根, 拍平文本)」段**,来自 `buildTextIndex(root)`(与批注锚定同一函数,保证 offset 语义一致):

| 格式 | 朗读根 | 顺序与降级 |
|------|--------|-----------|
| markdown | `.markdown-body`(单段) | 文档顺序;天然跳过 `article-header`(标题/meta 在根外) |
| EPUB | 每个 `.epub-chapter` 一段,按 DOM 顺序 | 章节标题参与朗读(是正文的一部分);书末 `.epub-notes` 不读(注释是引用性内容) |
| PDF 阅读模式 | 每个 `.pdf-reading-page .markdown-body` 一段,按页序 | `needsOcr`/缺文本页自动跳过(该页无 `.markdown-body` 正文,OCR 提示段落在根外) |
| PDF 原版式 | **不支持直接朗读**(RA-D5) | 文本层懒加载,不可见页无 DOM 文本(基线表第 5 行);点朗读时提示并一键切到阅读模式(复用 `PdfReaderHandle.setMode("reading")` 跳转链);阅读模式被禁用(>128 MiB/unsupported)则朗读同样禁用 |

- 跳过规则:切句前对拍平文本做**段内剔除**——`pre/code`、`.katex`、`table` 子树的文本不进入句子候选(实现:`buildTextIndex` 的遍历结果按祖先过滤,或对这些子树的 offset 区间打洞)。选中剔除区间内文本时从下一句继续。
- 起播位置:默认**从当前视口位置最近的句子**开始——用 `elementTextOffsetInIndex(index, 视口内首个块元素)` 把可视位置映射为拍平 offset,再取第一个 `start ≥ offset` 的句子;控制面板另有「从头朗读」。

### 3.3 句子切分(RA-D2)

新纯函数模块 `src/lib/ttsSegments.ts`:

```ts
interface SentenceSegment { start: number; end: number; text: string }
segmentSentences(text: string, locale?: string): SentenceSegment[]
```

- 首选 `Intl.Segmenter(locale, { granularity: "sentence" })`,**运行时特征检测**(`typeof Intl !== "undefined" && "Segmenter" in Intl`);WebView2(Chromium 130+ 级别)恒可用,Web 端旧 Firefox(<125)走兜底。
- **类型问题(证据 #8)**:不改 `tsconfig` lib(避免全仓库引入 ES2022 类型面、违反 AGENTS 的 ES2020 约束);在模块内放最小 `declare` 块(仅 `Segmenter` 构造器 + `segment()` 迭代器形状,约 15 行),并在注释标明"TS lib 升级后删除"。
- 正则兜底(必须与 Segmenter 输出结构一致,单测两条路径同一批用例):以终止符收句——终止符集 = `。！？!?；;…` 与"后随空白/行尾的英文句点",终止符后紧跟的右引号/右括号(`" ' 」 』 ） ) 】 ]`)归入前句;保留 offset;无终止符的长段按换行再按 240 字符硬切。
- 上限保护:单句 >240 字符(约 12-15 秒语音,呼应证据 #6)再按逗号/顿号二次切分——高亮粒度与 15 秒 bug 双收益。
- 空白句(全空格)丢弃;`start/end` 是**拍平文本 offset**,直接喂 §3.5 的 Range 构造。

### 3.4 播放引擎

新模块 `src/lib/ttsPlayer.ts`(状态机,不碰 DOM;DOM 交给 §3.5 的 hook):

- 队列模型:`sentences[]` + `cursor`;一句一个 `SpeechSynthesisUtterance`,`onend` 推进 cursor 并 speak 下一句(证据 #6 的通行解法);`onerror` 记录并跳到下一句(单句失败不中断全文),连续 3 句失败则停止并提示。
- 已知坑位处理(全部进单测/冒烟):
  - **GC 坑**:utterance 必须持引用到 `onend` 之后(挂在 player 实例上),否则 Chromium 可能静默丢事件;
  - **cancel 语义**:`speechSynthesis.cancel()` 会触发残留 `onend`/`onerror`,用代次计数(generation)丢弃过期回调(仓库内 `librarySearchRequest`/`documentRequest` 同款模式);
  - **pause/resume**:桌面本地语音可用;Web 端部分引擎 `pause()` 不可靠(证据 #9 文章提及),暂停实现为"记住 cursor + cancel",恢复 = 从 cursor 重 speak 当前句——跨端语义统一为句粒度暂停;
  - 语速变更即时生效:改 `rate` 后 cancel + 重 speak 当前句。
- 文档切换、离开 reader 视图(`activeView !== "reader"`)、库切换 → 停止朗读(effect 依赖 `currentPath`/`activeView`)。

### 3.5 句级跟随高亮(RA-D3)

- 机制:当前句 `start/end` → `rangeFromTextIndex(index, start, end)`(失败回退 `rangeFromOffsets`)→ `wrapRangeWithMark(range, TTS_ACTIVE_ID, "yellow", "highlight")` + 每个元素加 `.tts-active-sentence` class;句推进时 `clearAnnotationMarks(root, TTS_ACTIVE_ID)` 再画下一句——**与重定位预览完全同款的"临时 id + 附加 class"用法**(基线表第 2 行),`TTS_ACTIVE_ID = "reade-tts-active"`。
- **与批注 mark 的视觉区分**:不用四色底——`.tts-active-sentence` 覆写为 `background: var(--selection); box-shadow: 0 0 0 2px var(--selection)`(或 2px `var(--accent)` 下边框),即"选区色"语义:它是瞬时状态而非用户资产;四个主题系列自动适配,零新 token。与批注 mark 叠加时(朗读句里有高亮)两层 mark 嵌套渲染,视觉可辨(选区色罩在四色上)。
- 滚动跟随:句 mark 首元素 `scrollElementWithinContainer(readerRef, el, motion)`,仅当元素不在视口内才滚(避免每句抖动);`motionLevel === "off"` 用 auto。
- 交互冲突:批注重画(`clearAnnotationMarks(root)` 全量清除,如 EpubReader L346)会顺带清掉朗读 mark——下一句推进时自愈,可接受;朗读期间用户手动划选/落批注不受影响(选区捕获与朗读 mark 互不感知)。

### 3.6 播放控制 UI

- 入口:topbar 新增「朗读」icon 按钮(lucide `AudioLines`,放设置按钮左侧;`aria-pressed` 表播放态)。PDF 原版式下点击 → 提示切阅读模式(RA-D5)。
- 控制条:激活后在阅读区底部浮动一条 `reade-motion-panel`(与重定位确认条 `.annotation-relocate-bar` 同位同模式,App.tsx L3796-3820):播放/暂停、上一句/下一句、语速(0.5-2.0,步进 0.1,复用 setting-row 滑杆样式)、语音下拉(仅本地语音)、关闭。
- 键盘(RA-D6):朗读激活时 `Esc` = 停止朗读并收起控制条(在既有 Esc 分支链最前插入,优先级高于关面板);**不新增其他全局快捷键**(v1)——`Space` 与滚动冲突,媒体键/MediaSession 在非目标里。
- 屏幕阅读器:控制条 `role="toolbar" aria-label="朗读控制"`;当前句号数/总句数以 `aria-live="polite"` 播报关键状态变更(开始/结束)。

### 3.7 与阅读追踪的关系(RA-D4,裁决)

- **裁决:朗读计入 activeSeconds**。理由:听正文与读正文同属"消费这篇文档",statistics 语义是 engagement 而非注视;且不计入会出现"听完一小时,统计为零"的直觉背离。
- 实现:每句 `onend` 时调 `trackerRef.current?.recordActivity()`(公开接口,基线表第 6 行)——句间隔恒 <60s idle 阈值,计时自然连续;暂停/停止后不再打点,60s 后自然停表。**零 schema、零 tracker 改动**。
- Web 端无追踪(桌面独占现状),无需分支。

### 3.8 双端差异

| 差异点 | 桌面(WebView2) | Web |
|--------|----------------|-----|
| 语音列表 | 仅本地语音(证据 #2,微软已代滤一道);过滤器仍生效(纵深) | Chrome/Edge 混有在线语音 → 过滤后仅剩本地;Firefox 仅本地语音;列表可能为空 → 禁用态 |
| `getVoices` 时序 | 异步,`voiceschanged` 兜底(证据 #7) | 同左;Safari 首调可能直接返回 |
| 用户手势 | 无强约束 | Safari 需手势内 `speak()`(证据 #9)——本设计一切播放都由按钮触发,天然满足 |
| 15 秒截断 | 可能不受影响(本地语音,证据 #6 附注) | Chrome + 在线语音必现——已被过滤器排除;句级队列双保险 |
| 追踪打点 | `recordActivity` 生效 | 无追踪,跳过 |

## 4. 改动清单(预估)

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/ttsSegments.ts`(新)+ 测试 | 切句(Segmenter + 正则兜底 + 二次切分)、局部类型声明 | M |
| 2 | `src/lib/ttsVoices.ts`(新)+ 测试 | 语音加载/过滤/默认挑选 | S |
| 3 | `src/lib/ttsPlayer.ts`(新)+ 测试 | 队列状态机、代次防串、错误跳句 | M |
| 4 | `src/lib/useReadAloud.ts`(新)+ 测试 | hook:提取朗读源、句高亮 wrap/clear、滚动跟随、追踪打点、生命周期停止 | M |
| 5 | `src/components/ReadAloudBar.tsx`(新)+ 测试 | 控制条 UI | S-M |
| 6 | `src/App.tsx` | topbar 入口、控制条挂载、Esc 分支、PDF 原版式引导 | S-M |
| 7 | `src/store/useReaderStore.ts` + 测试 | `ttsRate`/`ttsVoiceName` 持久化 | S |
| 8 | `src/App.css`、`docs/USER_GUIDE.md` | `.tts-active-sentence` 样式、控制条样式、「朗读」章节 | S |

里程碑:**M0** 实机冒烟(证据补全,无产品代码)→ **M1** markdown 朗读闭环(切句 + 队列 + 句高亮 + 控制条 + 入口)→ **M2** EPUB/PDF 阅读模式 + 追踪打点 + 语音/语速持久化 + 打磨文档。

## 5. 验收标准

**M0(实机冒烟,结论回填本文档 §0)**

- [ ] 在 `pnpm tauri dev` 的 DevTools console 执行冒烟脚本并记录输出表:

```js
const dump = () => console.table(speechSynthesis.getVoices().map(v => ({
  name: v.name, lang: v.lang, local: v.localService, default: v.default })));
speechSynthesis.addEventListener("voiceschanged", dump); dump();
const u = new SpeechSynthesisUtterance("离线朗读冒烟测试，第一句。Second sentence in English.");
u.voice = speechSynthesis.getVoices().find(v => v.localService && v.lang.startsWith("zh"));
u.onend = () => console.log("TTS OK");
u.onerror = (e) => console.error("TTS error:", e.error);
speechSynthesis.speak(u);
```

- [ ] 断言:语音表非空且全部 `local === true`;至少各有一个 `zh-*` 与 `en-*` 语音(没有则记录并把"引导安装系统语音"文案提级);中英文都发声、`onend` 触发。
- [ ] **断网复测**(拔网线/飞行模式):上述全部仍成立——离线承诺实证。
- [ ] Web 侧抽测:Edge 或 Chrome 跑同脚本,确认过滤前列表含 "Online" 语音、过滤后全为本地;`pnpm dev:web` 环境同样验证。
- [ ] 冒烟结果(语音表截图/文本)回填本文档附录;若与 §0 证据冲突,先修订方案再进 M1。

**M1(markdown 闭环)**

- [ ] 单测(`ttsSegments.test.ts`):中文句号/问号/感叹号/省略号切分;引号收尾(`"…句末。"`)归前句;英文缩写不误切(`e.g. / Dr.` 至少不产生空句);中英混排;>240 字符长句二次切分;offset 完整性——`segments` 无重叠、按 start 升序、除空白外不丢字符(`segments[i].end ≤ segments[i+1].start`,间隙内只允许空白);Segmenter 与正则兜底两路径跑同一批用例并断言结构一致(允许边界差异的用例单独标注);空文本/全空白输入返回空数组。
- [ ] 单测(`ttsVoices.test.ts`):`localService === false` 排除;name 含 "Online" 排除;空列表→null;lang 前缀挑选(zh 文档不选 en 语音);voiceschanged 兜底与 2s 超时(fake timers)。
- [ ] 单测(`ttsPlayer.test.ts`,mock speechSynthesis):顺序播放推进 cursor;`onerror` 跳句、连续 3 句失败停止;cancel 后过期 `onend` 不推进(代次防串);暂停=记 cursor+cancel、恢复=重 speak 当前句;语速变更重 speak 当前句。
- [ ] 组件测(`ReadAloudBar.test.tsx`):播放/暂停/上一句/下一句按钮驱动 player;Esc 停止;`aria-pressed`/`aria-live` 语义。
- [ ] 组件测(hook):朗读中当前句存在唯一 `[data-annotation-id="reade-tts-active"]` mark 且带 `.tts-active-sentence`;句推进后旧 mark 被清除;停止后无残留 mark;文档切换自动停止。
- [ ] 运行时(桌面):打开长 markdown → 从视口中部起播 → 句高亮逐句推进、视口自动跟随;中途划选落一条高亮批注,朗读不中断、批注正常保存;**连续朗读 ≥ 3 分钟不静默中断**(15 秒 bug 回归线)。
- [ ] 性能预算:100k 字符文档切句 < 50ms;单句高亮更新(offset→Range→wrap)< 10ms(console.time 佐证);朗读期间滚动无新增长帧。
- [ ] 回归:`pnpm test`、`pnpm exec tsc --noEmit`(重点:Segmenter 局部声明不泄漏到全局类型面)。

**M2(全格式与完成态)**

- [ ] 运行时:EPUB 跨章朗读连续(章节标题被朗读、notes 不读);PDF 阅读模式跨页连续、`needsOcr` 页跳过;PDF 原版式点朗读 → 提示并切换阅读模式后可播;>128 MiB PDF 朗读按钮禁用。
- [ ] 追踪验收(桌面):朗读 10 分钟、手不碰键鼠 → `reade-stats.sqlite3` 该文档新增会话 `activeSeconds ≥ 540`(允许尾部 idle 损耗);停止朗读后 60s 停表(再查一次不再增长)。
- [ ] 双端:`pnpm dev:web` 在 Chrome 与 Firefox 各走一遍 M1 运行时用例;无本地语音的环境(可用 DevTools 覆写 getVoices 模拟)按钮禁用态正确。
- [ ] 视觉走查:朗读句高亮 × 四色批注叠加 × 明/暗 ≥ 4 张截图;paper/celadon 两系列抽查 `--selection` 底的辨识度;窄窗(820 以下)控制条不遮挡正文。
- [ ] `docs/USER_GUIDE.md` 新增「朗读」章节(含"只使用本地语音"的承诺说明与系统语音安装指引);README 能力清单同步一行。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| RA-D1 | 语音允许范围 | **仅 `localService === true`,叠加 name "Online" 黑名单;列表空即禁用** | 允许在线语音(把正文发往网络,违反离线承诺,否决) |
| RA-D2 | 句子切分 | **Segmenter 特征检测 + 正则兜底;类型走模块内最小声明,不动 tsconfig lib** | 全局改 lib 到 ES2022(类型面全仓变化,违 AGENTS ES2020 约束);纯正则(白丢 Segmenter 的边界质量) |
| RA-D3 | 跟随高亮机制 | **复用 `wrapRangeWithMark` 临时 mark(重定位预览同款)** | CSS Custom Highlight API(零 DOM 突变更优雅,但需类型声明 + Firefox 140+/Safari 17.2+ 支持面 + 无既有先例;列为将来重构方向) |
| RA-D4 | 朗读是否计 activeSeconds | **计入**:句 `onend` 打 `recordActivity`,零 schema 改动 | 不计(挂机听书不算阅读——与统计"engagement"语义相悖,且实现同样要写分支) |
| RA-D5 | PDF 原版式 | **不直接朗读;引导一键切阅读模式** | 原版式按 textLayer 朗读(懒加载导致跨页断流,要预取全部页文本层——内存与复杂度不成比例,否决) |
| RA-D6 | 快捷键 | **仅"朗读激活时 Esc = 停止";不加新全局键** | `Alt+R` 播放/暂停(留待使用反馈);`Space`(与滚动冲突,否决) |

## 7. 风险与开放问题

- **最大剩余风险:桌面语音质量与覆盖**。WebView2 只暴露 OneCore/SAPI 本地语音(证据 #2/#3),中文只有 Huihui/Kangkang/Yaoyao 一档的机械感语音,与 Edge 在线 Natural 语音的差距用户可感;这是"离线承诺"的固有代价,USER_GUIDE 要明示"音质取决于系统已安装语音",不留"为什么没有 Edge 那种声音"的困惑。若某机器 OneCore 枚举成功但用户装的第三方 SAPI5 语音被遮蔽(证据 #3 的取一不取并集),同样只能文档说明,不做注册表 hack。
- `voiceschanged` 在个别环境不触发(冷启动首次 getVoices 空 + 事件缺席)→ 2s 超时兜底后仍空则禁用态;M0 若复现,把超时调优写回方案。
- 切句质量:中文引号/括号收尾、英文缩写是已列用例,但真实文档长尾(法条编号、URL、代码内联)必有误切——句粒度错误的代价只是"高亮块偏一句",可接受,不追求完美切分。
- 朗读 mark 与批注全量重画的清除竞态(§3.5):下一句自愈是设计内行为,但要在 M1 运行时用例里亲眼确认无闪烁残留。
- `speechSynthesis.speak` 期间切换主题/字号导致 reflow:mark 元素还在(不依赖坐标),无需处理;但滚动跟随的"仅视口外才滚"判定要在 reflow 后仍正确(用每句实时测量,不缓存)。
