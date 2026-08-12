# 多套 UI 风格切换：竞品调研与实施方案

- 日期：2026-08-12
- 范围：主流阅读类软件的主题/皮肤体系调研；Reade 多套 UI 风格切换的设计规格、技术架构与分阶段计划
- 状态：**仅调研与方案设计，未改动任何产品代码、配置或依赖**（本文档为唯一交付物）
- 决策状态：**2026-08-12 用户已拍板 D1–D6**（结果见第 7 节决策记录，其中 D4、D5 采用非推荐项）；**一期 M0–M2 已实施（2026-08-12）**，实施备注与 A5 实测结论见第 7 节
- 证据标注约定：
  - **【已核实】**＝直接读取本仓库源码/配置，或产品官方文档、官网、官方仓库源码确认，附链接
  - **【二手】**＝第三方评测/社区资料，可核实但非官方，附链接
  - **【推断】**＝由已核实事实推导，或个人使用印象，无直接来源

> 核心结论：阅读类产品的主题体系已收敛为「**风格系列 × 明暗模式**」的二维矩阵，且排版参数与视觉风格普遍分离管理。Reade 现有的 `series + mode` 主题模型、语义 token 单文件、Zustand 持久化三件套**已经就是这套行业结构的最小实现**——多套 UI 不需要另起炉灶，只需要把「纸感」系列泛化为 3~4 个系列，并补齐系列切换 UI 与防闪烁引导。预估新增运行时开销接近于零（每系列约 1 KB 纯 CSS，无新依赖、无字体下载）。

---

## 1. 调研结论摘要

覆盖 12 款产品（电子书阅读器 6、稍后读 3、Markdown/笔记 3；商业产品与开源社区、国内外生态均有覆盖）。五条对方案最有决定性的发现：

1. **「主题」有两种截然不同的产品定义，Reade 应选第三种混合形态。**
   - A 型「参数快照」：Kindle、Apple Books 的主题＝字体+字号+背景+间距的可保存组合，主题与排版参数深度耦合（Kindle 自定义主题连亮度都存）。
   - B 型「整套皮肤」：Bear（28+ 套）、Obsidian（社区主题＝整份 CSS）、Typora（主题＝一个 .css 文件），一次切换全部视觉语言。
   - C 型「调色板系列 × 明暗」：Readest（Default/Sepia/Solarized/Nord… × light/dark，OKLCH 派生）、Thorium（8 套固定色卡）。**C 型与 Reade 现有 `ThemeSeriesId + mode` 模型同构，演进成本最低**，且保留了 B 型「一次切换、整体协调」的体验优势，规避了 A 型把排版参数搅进主题的耦合。
2. **明暗是模式不是主题。** 主流产品把 light/dark 作为每个风格系列内部的正交维度：Obsidian 主题必须同时定义 `.theme-light/.theme-dark`；Readest 每个调色板自动生成明暗双版本；Apple Books 六主题之外再叠加 Light/Dark/Auto 背景开关。Reade 的 `toggleThemeMode`（系列内翻转）语义正确，应保留。
3. **排版参数与视觉风格分离是多数派做法。** Readwise Reader、Instapaper、Thorium、Koodo 的字号/行高/宽度设置独立于配色主题；只有 A 型产品（Kindle/Apple Books）把两者合并、再用「Customize」把耦合拆回去。Reade 现有「阅读设置」面板（字号/行高/宽度/段距/字体风格）应保持全局，不随风格套切换。
4. **色彩收敛点非常明确。** 电子书侧的背景四件套：白、米黄（sepia）、浅绿（护眼）、黑（夜间）——Kindle、Instapaper（白/米黄/灰/黑）、Thorium（8 套含 sepia/paper/night/绿底）、微信读书（背景+夜间）全部命中；Markdown 工具侧则是冷灰极简（Obsidian Minimal 约 240 万下载居社区第一）与终端配色移植（Solarized/Nord/Gruvbox 在 Bear、Readest、Obsidian 反复出现）。
5. **切换交互的通用范式：设置面板内的色卡/缩略 tile，点击即生效即预览。** Apple Books 用主题 tile+实时小预览、Thorium 用八张色卡、Instapaper 用四色块、Obsidian 主题商店用截图缩略。没有产品为个人本地切换做「确认/应用」两段式——本地切换零成本，点错点回即是撤销。

---

## 2. 项目现状核实（均【已核实】，读取本仓库源码）

| 事实 | 位置 |
|------|------|
| 语义色 token 共 19 个（17 个随主题 + `--code-bg/--code-chrome` 恒深），集中于单文件，`:root` 为浅色纸感默认，`:root[data-theme="dark"]` 覆盖深色 | `src/styles/theme-tokens.css` |
| token 头注释已写明 Radix Colors 阶梯映射指南与 TweakCN/shadcn 名称对照，即「加新主题的操作手册」已存在 | 同上 1–14 行 |
| 统计热力图 5 档色由 `color-mix(accent, paper)` 派生，自动跟随任何主题 | 同上 43–49 行 |
| 主题注册表已有 `ThemeSeriesId = "paper"`（「纸感」）概念与 `series/label/mode/themeColor` 元数据，注释明示 “Add future series here”；`toggleThemeMode` 为系列内明暗翻转 | `src/lib/themes.ts` |
| 主题持久化走 Zustand persist v3 → localStorage `reade-reader-preferences`，含 `migrate/merge/normalize` 防御链 | `src/store/useReaderStore.ts` |
| 主题应用方式：React `useEffect` 写 `document.documentElement.dataset.theme` 并同步 `<meta name="theme-color">` | `src/App.tsx` 1739–1743 行 |
| `index.html` 无任何主题引导脚本；`theme-tokens.css` 经 `main.tsx` 打入主 bundle | `index.html`、`src/main.tsx` |
| 桌面 CSP `script-src 'self'`——内联脚本会被拦截，同源外部脚本允许 | `src-tauri/tauri.conf.json` |
| 阅读排版五参数（字号/行高/宽度/段距/字体风格）经内联 `--reader-*` CSS 变量注入，与配色 token 完全解耦 | `src/App.tsx` 881–895 行 |
| 主题切换入口在侧栏 footer `.theme-controls`：系列名 label + 日/月按钮，label 的 title 已预告「后续可在此扩展更多主题系列」 | `src/App.tsx` 2188–2222 行 |
| 批注四色为固定功能色（`#ffe650/#78dc8c/#78b4ff/#ff8cbe`），不随主题 | `src/App.css` 1966–1969 行 |
| 代码块恒用深色 Shiki token；PDF 页面恒白（token 注释明示 not theme-driven）；Mermaid 一次性 `initialize` 未传主题色 | `src/AppCss.test.ts`、`theme-tokens.css` 34 行、`src/components/MarkdownRenderer.tsx` 218–227 行 |
| 测试已锁定约束：token 只能定义在 theme-tokens.css、App.css 不得重定义 `--paper/--accent`、必须存在 `:root[data-theme="dark"]` 与 `.theme-controls` | `src/AppCss.test.ts`、`src/lib/themes.test.ts` |
| 无 `@font-face`、无捆绑字体，全部系统字体栈 | `src/` 全量检索 |

一个现状缺口【推断】：`data-theme` 由挂载后的 `useEffect` 写入，首帧前 `:root` 走浅色默认值——深色用户冷启动理论上有一帧浅色闪烁（zustand 同步水合能保证 store 值正确，但 DOM 属性写入在 paint 之后）。多系列后闪烁面会扩大，方案须一并解决（见 5.4）。

---

## 3. 竞品逐个分析

选品理由：电子书侧取市占与口碑头部（Kindle、Apple Books、微信读书）+ 开源桌面代表（Koodo、Thorium、Readest，其中 Readest 与 Reade 同为 Tauri，架构参考价值最高）；稍后读侧取三种审美路线代表（Readwise Reader 信息密度派、Matter 排版美学派、Instapaper 极简古典派）；Markdown/笔记侧取主题生态最强的三款（Obsidian、Typora、Bear）。以桌面端体验为主，Bear/Matter 为 Apple 平台产品但主题体系参考价值高，已标注平台限制。

### 3.1 电子书阅读器

**Kindle 阅读应用（Amazon）**
- 审美定位：中性白纸电商风，视觉个性弱，功能性排版强【推断】。
- 主题系统：Layout/Font 参数可保存为**多个具名自定义主题**，另有 Compact/Standard/Large/Low Vision 四档预设；主题保存背景色、字体、行高、间距、边距（iPad 版甚至含亮度）——典型 A 型「参数快照」。页面底色四档：白/米黄 sepia/浅绿/黑。【已核实】[Amazon 官方帮助](https://www.amazon.com.au/gp/help/customer/display.html?nodeId=TABlJ4ot69emTO8jJG)；【二手】[Ebook Friendly 自定义主题实测](https://ebookfriendly.com/kindle-app-ipad-custom-themes/)
- 字体排印：官方帮助列出 Bookerly（自研阅读衬线）/Amazon Ember/OpenDyslexic 三款【已核实】；iPadOS 版实测有 8 款（另含 Baskerville、Georgia、Palatino 等）【二手，Ebook Friendly】。字号、行距、边距、对齐（左对齐/两端）、单双栏均可调。【已核实】同上
- 切换交互：阅读界面右上 `Aa` 入口，Font/Layout/Themes/More 分页签；主题 tile 点击即生效。【已核实】同上

**Apple Books（iOS/iPadOS/macOS）**
- 审美定位：系统级精致感，六套「情绪化」预设主题，重排版细节【推断】。
- 主题系统：Original / Quiet / Paper / Bold / Calm / Focus 六主题，每套＝字体+底色+间距组合；主题之上叠加 Light/Dark/Automatic 背景开关（明暗与主题正交）；每主题可 Customize（字体、加粗、行距/字距/词距/边距、两端对齐、多栏）。macOS 桌面端同样具备主题 tile 与 Customize。【已核实】[Apple 官方 macOS 指南](https://support.apple.com/guide/books/change-a-books-appearance-ibks8923126d/mac)；【二手】[iDownloadBlog 主题详解](https://www.idownloadblog.com/2022/09/21/how-to-use-themes-in-books-app-on-ipad-iphone/)
- 切换交互：工具栏 `Aa` → Themes & Settings；主题 tile 即点即换，Customize 内滑块调整时**顶部小预览实时反映**。【二手】同上
- 值得注意：iOS 16 移除拟物翻页动画引发用户反弹后，以 Slide/Curl/None 选项回归——拟物元素作为「可选情绪价值」而非默认。【二手】[TapSmart](https://www.tapsmart.com/tips-and-tricks/ipados16-books/)

**微信读书（腾讯，国内代表）**
- 审美定位：社交化阅读产品，阅读面简洁、注重护眼场景【推断】。
- 主题系统：阅读器工具栏内「阅读背景」提供多档底色 + 夜间模式；字体与字号独立设置（移动端另有字体商店）。官方帮助确认背景/夜间/字体三项均在阅读工具栏完成。【已核实】[微信读书官方帮助](https://weread.qq.com/wrpage/app/help/detail/qReadingBgAndFront)
- 桌面/Web：官方网页版 weread.qq.com 与桌面客户端提供 `Aa` 入口调字号/行距/背景色（含护眼、夜间）。【二手】[第三方使用梳理](https://www.cnblogs.com/pcdoctor/p/19598481)；网页版具体底色档位为白/米黄/绿/深色【推断，个人使用印象】
- 生态信号：网页版存在大量「护眼助手/背景颜色修改器」类第三方扩展，说明官方档位不满足重度用户的自定义需求。【已核实（扩展存在性）】[Chrome Web Store](https://chromewebstore.google.com/detail/%E5%89%8D%E5%A4%95%E9%98%85%E8%AF%BB%E5%8A%A9%E6%89%8B%E5%BE%AE%E4%BF%A1%E8%AF%BB%E4%B9%A6%E5%8A%A9%E6%89%8B/himocmagklembngmjkephklagajfbill)

**Koodo Reader（开源，Electron，Windows/macOS/Linux/Web）**
- 审美定位：功能齐全的工具型阅读器，自定义粒度大于美学预设【推断】。
- 主题系统：**双层**——应用层「皮肤」（light/night/system）+ 7 种应用主题色（支持自定义）；阅读层 20 种阅读主题色、背景/文字色自定义并可保存、夜间联动换色。【已核实】[官方 Changelog](https://www.koodoreader.com/en/changelog)、[GitHub README](https://github.com/koodo-reader/koodo-reader)；【二手】[DeepWiki 架构解析](https://deepwiki.com/koodo-reader/koodo-reader/7.3-themes-and-appearance-customization)（`themeColor/appSkin/backgroundColor/textColor` 分键存储）
- 排版：字体/字号/行距/段距/边距/亮度全开放；单栏/双栏/连续滚动三布局。【已核实】GitHub README
- 借鉴点：应用 chrome 主题色与阅读面底色分层管理；反面教训是设置项过散，缺少「一次切换整体协调」的套装感【推断】。

**Thorium Reader（EDRLab，开源桌面，无障碍标杆）**
- 审美定位：标准派+无障碍优先，视觉朴素【推断】。
- 主题系统：8 套固定色卡——neutral `#fefefe`、sepia `#faf4e8`、night `#121212`、paper `#E9DDC8`、contrast1 黑底白字、contrast2 黑底黄字、contrast3 蓝黑底、contrast4 绿底 `#C5E7CD`。源码中主题即「bg+fg 色对」数组，Radio 色卡选择。【已核实】[官方文档](https://thorium.edrlab.org/en/docs/210_reading/215_readingparameters/)、[ReaderSettings.tsx 源码](https://github.com/edrlab/thorium-reader/blob/02b67755/src/renderer/reader/components/ReaderSettings.tsx)
- 排版：字体（含 Readable/Dyslexia）、字号、行距/词距/字距/边距、分页 vs 滚动、对齐、栏数。【已核实】[DAISY 指南](https://daisy.org/guidance/info-help/guidance-training/reading-systems/thorium-epub-reader-quick-start-guide/)
- 借鉴点：高对比主题作为无障碍维度的行业基准；设置可 Save/Reset。

**Readest（开源，Tauri + Next.js——与 Reade 技术栈最接近的参照）**
- 审美定位：现代开源阅读器，主题体系工程化程度最高【推断】。
- 主题系统：调色板系列（default/gray/sepia/grass/cherry/sky/solarized/gruvbox/nord/contrast）× light/dark 自动派生：每系列只定义 `fg/bg/primary` 三个种子色，经 OKLCH 感知均匀模型生成整套明暗色板（暗色去饱和以降低眼疲劳）；支持用户自定义主题存 localStorage；`data-theme="{color}-{light|dark}"` 挂 `documentElement`，meta theme-color 同步——**与 Reade 现有机制逐点对应**。【已核实】[themes.ts 源码](https://github.com/readest/readest/blob/30727d35/apps/readest-app/src/styles/themes.ts)、[themeStore.ts 源码](https://github.com/readest/readest/blob/4c2d8022/apps/readest-app/src/store/themeStore.ts)；【二手】[DeepWiki 主题系统](https://deepwiki.com/readest/readest/3.5-theme-and-color-system)
- 借鉴点：`series-mode` 二段式 `data-theme` 命名；暗色板去饱和原则；种子色+派生的思路可用于降低人工定色工作量（但 Reade token 只有 17 个，手工定色可控，无需引入派生库）。

### 3.2 稍后读 / 文章阅读

**Readwise Reader（Web/桌面/移动，功率用户向）**
- 审美定位：信息密度优先的「收件箱式」阅读工作台，视觉克制【推断】。
- 主题系统：light/dark/auto 三态，无风格系列；重心在排版：字体（含 Atkinson Hyperlegible、OpenDyslexic）、字号 14–80px、行距（默认 1.4）、行宽三档（仅 Web）。有「长文阅读视图」专用布局（隐藏操作栏、EPUB 默认启用、可选分页滚动+两端对齐模拟书感）。【已核实】[官方 Docs：Appearance](https://docs.readwise.io/reader/docs/faqs/appearance)、[长文阅读优化指南](https://docs.readwise.io/reader/guides/workflows/longform-reading)
- 切换交互：`Aa` 图标 + 全键盘快捷键（`Cmd/Ctrl+Opt+T` 切明暗）。
- 借鉴点：「同一产品内，扫读工作台与沉浸长文是两种布局模式」——Reade 的统计视图/阅读视图分离与此同路。

**Matter（iOS/iPad/Web，设计美学标杆）**
- 审美定位：排版驱动的极简美学，三获 Apple「App of the Day」，Bookerly→Literata 一路选用高品质阅读字体【已核实（获奖与定位）】[官网](https://www.getmatter.com/)。
- 主题系统：明暗双模式 × 4 套主题（其中 Paper 主题营造报纸感）；iOS 端 10 款字体（New York、Valkyrie、Lyon、Literata…），Web 端收敛为 Literata/系统字体 + 字号/行高/行宽。【二手】[The Sweet Setup 对比评测](https://thesweetsetup.com/is-matter-or-readwise-reader-the-read-later-app-for-you/)、[Web 版早期评测](https://thesweetsetup.com/an-early-look-at-matter-on-the-web/)、[MacStories 评测](https://www.macstories.net/reviews/matter-a-fresh-take-on-read-later-apps/)
- 借鉴点：高亮色刻意做低饱和「不打扰阅读」；风格套数少而精（4 套）但每套气质完整。

**Instapaper（古典极简，2008 至今）**
- 审美定位：十余年不变的印刷排版气质【推断】。
- 主题系统：四主题——白/米黄 sepia/深灰/黑，另有 OLED true black 开关；主题只管配色，字体（Web 4 款、iOS 10+ 款，默认 Lyon 衬线）、字号、栏宽、行距独立调节。【已核实】[官方 Docs：Text Settings](https://www.instapaper.com/docs/read/text-settings)；【二手】[Perkins 无障碍评测（完整字体/色板清单）](https://www.perkins.org/resource/instapaper-accessibility-for-visual-impairment/)
- 切换交互：`Aa` 面板第一页放高频项（主题/字体/亮度），低频项（宽度/行距/对齐）收进第二页——「set-and-forget 分层」。【已核实】[官方博客 8.2 版设计说明](https://blog.instapaper.com/post/697745829686099968)

### 3.3 Markdown / 笔记类阅读界面

**Obsidian（桌面/移动，主题生态最大）**
- 审美定位：默认皮肤中性，个性完全交给社区主题生态【推断】。
- 主题系统：主题＝一份 `theme.css`（宣告式替换全部 CSS 变量），官方 API 要求同时支持 `.theme-light/.theme-dark`；社区主题数量以百计【推断，商店未给官方总数】；用户层再叠 CSS snippets（后加载覆盖）与 Style Settings 插件（图形化调主题暴露的变量）。头部主题 Minimal 约 240 万下载、Things 约 104 万——极简冷灰审美占绝对头部。【已核实】[官方主题开发文档](https://docs.obsidian.md/Themes/App+themes/Build+a+theme)、[Minimal 主题页（2.4M downloads）](https://community.obsidian.md/themes/minimal)；【二手】[主题下载量盘点](https://www.knowledgeecology.me/top-35-best-obsidian-themes-as-decided-by-its-users/)
- 切换交互：Settings → Appearance → Themes，商店带截图缩略预览，安装后下拉即切。
- 借鉴点：变量分层（主题定义变量 → snippets 覆盖）证明「语义 token 单一来源 + 后置覆盖」的可维护性；反面是无限自定义带来的用户维护负担，与个人应用定位相悖【推断】。

**Typora（桌面 Markdown 编辑/阅读）**
- 审美定位：默认 GitHub 风朴素文档感，主题即文件【推断】。
- 主题系统：6 款内置主题（github/gothic/newsprint/night/pixyll/whitey + whitey-deep），每主题＝theme 目录下一个 `.css`；官方 Theme Gallery 分发社区主题；用户层 `base.user.css`（全主题生效）与 `{theme}.user.css`（单主题生效）两级覆盖，加载顺序固定。【已核实】[官方 About Themes](https://support.typora.io/About-Themes/)、[官方 Add Custom CSS](https://support.typora.io/Add-Custom-CSS/)、[默认主题仓库](https://github.com/typora/typora-default-themes/tree/master/themes)
- 借鉴点：Newsprint（报纸米黄+衬线+窄栏）是「复古印刷」审美的教科书样本；换主题需重启/整页重载，切换体验是负面教材【推断，基于机制】。

**Bear（macOS/iOS，Apple Design Award）**
- 审美定位：温暖极简 + 自研字体 Bear Sans（基于 Clarika 定制，为长文本可读性重绘字形）。【已核实】[官方博客 Bear Sans 设计记](https://blog.bear.app/2023/08/learn-about-our-new-custom-font-bear-sans/)
- 主题系统：28+ 套精策划主题（免费 3 套），一次切换同步换掉背景/文字/标题/UI 全部颜色；大量主题移植自编辑器配色圈——Solarized、Dracula、Nord、Gruvbox、Catppuccin、Rosé Pine、Tokyo Night 等，并含 OLED 专用 true black 主题 Dieci。排版（字体/字号/行高/行宽/段距/缩进）独立于主题设置。【已核实】[官方 FAQ：主题](https://bear.app/faq/about-free-and-pro-themes-in-bear/)、[官方 FAQ：排版](https://bear.app/faq/typography-options/)
- 借鉴点：**「策展式少量精品主题」胜过「无限自定义」**——官方给出协调配色，用户不必自己当设计师；主题命名传达情绪（Olive Dunk、Academia）。

### 3.4 配色体系参照（非产品，设计资产）

**Flexoki**（Steph Ango／Obsidian CEO 出品）：为屏上读写设计的「纸墨」配色系统——暖纸底 `#FFFCF0`、油墨黑 `#100F0F`、暖单色灰阶 + 8 个从 Oklab 空间按颜料感校准的强调色，明暗双模式，明确以「模拟纸上颜料」为目标。开源 MIT，是「暖纸墨水」审美方向最可直接引用的现成色板。【已核实】[官方页](https://stephango.com/flexoki)、[GitHub（完整色值表）](https://github.com/kepano/flexoki/)

---

## 4. 审美体系归纳

从 12 款产品归纳出七个可复用的审美方向（按在阅读产品中的出现频率排序）：

| # | 方向 | 代表证据 | 适合场景 | 用户感受 |
|---|------|----------|----------|----------|
| 1 | **暖纸墨水**（纸质拟物的现代化：保留纸的色温，抛弃木纹皮革贴图） | Kindle sepia、Instapaper sepia、Thorium sepia/paper、Readest sepia、Flexoki 整套体系 | 书籍式沉浸长读、日间长时间阅读 | 温暖、低眩光、「像纸」；Apple Books 拟物翻页被删又回归说明拟物要素宜作可选项 |
| 2 | **极简留白 · 内容至上**（纯白/冷灰、克制强调色、UI 退场） | Obsidian Minimal（下载第一）、Things、Bear、Matter、Typora github | 技术文档、笔记、扫读+精读混合 | 干净、专注、现代；对图表/代码密集内容最友好 |
| 3 | **柔和深夜**（深灰底去饱和文字，非纯黑） | Thorium night `#121212`、Readest 暗板去饱和原则、各产品 dark 基线 | 夜间/暗环境 | 当代 dark mode 共识：避免纯黑高反差眩光 |
| 4 | **OLED 纯黑** | Instapaper true black 开关、Bear Dieci | OLED 屏夜读/省电 | 桌面 LCD 价值有限，属移动端细分 |
| 5 | **护眼绿**（浅绿底低刺激） | Kindle light green、微信读书护眼档、Thorium contrast4 | 久看屏幕、光线复杂环境；国内用户心智强 | 「护眼」在中文阅读生态近乎标配档位 |
| 6 | **复古印刷/打字机**（米白+衬线+窄栏+报刊气质） | Typora Newsprint、Obsidian Typewriter（32 万+下载）、Matter Paper 主题 | 慢读、写作型读者 | 情绪价值高，普适性低，适合作为可选而非默认 |
| 7 | **高对比无障碍 / 终端配色移植** | Thorium contrast1–4；OpenDyslexic/Atkinson 字体（Kindle/Readwise/Instapaper）；Solarized/Nord/Gruvbox（Bear/Readest/Obsidian） | 视觉障碍；开发者情怀 | 无障碍是维度不是风格；终端配色反映开发者用户把编辑器审美带进阅读 |

对 Reade 的适配判断【推断，基于上表与 Reade 内容形态】：Reade 的内容双形态（EPUB/PDF 书籍式长文 + 技术型 Markdown）恰好对应方向 1 与方向 2 两大主流；方向 3 应作为每个系列的暗色实现原则而非独立系列；方向 5 适合作为面向中文用户的第二梯队扩展；方向 4、6、7 收益/维护比不划算，不建议进入前两期。

---

## 5. 推荐方案

### 5.1 方案定位

**已拍板（D1）：3 个风格系列 × 明暗双模式 = 6 个主题，一期交付墨韵、清透 2 个新系列，二期补第 4 系列青瓷。** 与现有明暗主题的关系是**扩展现有 token 层**（在 `theme-tokens.css` 增加系列选择器块、在 `themes.ts` 注册系列），**不引入新的风格层**（不加第二套 CSS 文件体系、不加运行时换肤引擎）。

| 系列 | id（建议） | 审美方向 | 目标场景 | 状态 |
|------|-----------|----------|----------|------|
| 纸感 | `paper` | 暖纸 + 红陶 accent（现状） | 通用默认，均衡长文 | 已有，色值不动 |
| 墨韵 | `ink` | 暖纸墨水（方向 1 加深），Flexoki 参照，靛青 accent | 书籍式沉浸阅读（EPUB/长文） | 一期新增 |
| 清透 | `mist` | 极简留白（方向 2），冷灰 + 冷蓝 accent | 技术文档/代码密集 Markdown | 一期新增 |
| 青瓷 | `celadon` | 护眼绿（方向 5） | 久读护眼、中文用户习惯 | 二期（D1 已拍板排期） |

套数论证：Bear/Obsidian 式海量主题对个人应用是维护负债（每系列＝17 token × 2 模式的定色与全界面回归）；Kindle/Apple Books/Instapaper/Matter 收敛在 4–6 档。3 系列 6 主题已把维护面扩为现状 3 倍，是「有得选」与「养得起」的平衡点【推断】。

命名原则：沿用现有「纸感」的中文材质隐喻（Bear 的情绪化命名证明有效），UI 展示中文名，id 用英文短词。

### 5.2 各系列设计规格

以下色值为**起点建议**（墨韵直接引用 Flexoki 开源色值【已核实】，清透按 token 头注释既有的 Radix 阶梯映射规则推导【推断，需视觉调优】）。定稿以明暗 × 宽窄窗口视觉走查为准；对比度验收目标：`--ink` 对 `--paper` ≥ 7:1，`--ink-soft` ≥ 4.5:1，`--muted` 仅用于辅助文字 ≥ 3:1。

**墨韵 ink**（种子：Flexoki paper/black/blue）

| token | light | dark |
|-------|-------|------|
| `--theme-color` / `--paper` | `#f2f0e5` / `#fffcf0` | `#1c1b1a` / `#1c1b1a` |
| `--paper-raised` | `#fffdf6` | `#282726` |
| `--chrome` / `--chrome-strong` | `#f2f0e5` / `#e6e4d9` | `#161514` / `#343331` |
| `--ink` / `--ink-soft` / `--muted` | `#100f0f` / `#575653` / `#878580` | `#cecdc3` / `#9f9d96` / `#6f6e69` |
| `--line` / `--line-strong` | `rgba(16,15,15,.13)` / `.22` | `rgba(206,205,195,.1)` / `.18` |
| `--accent` / `--accent-soft` / `--accent-ink` | `#205ea6` / `#e1eaf5` / `#1a4f8c` | `#4385be` / `#253340` / `#a9c8e4` |
| `--teal` / `--teal-soft` | `#24837b` / `#def0ee` | `#3aa99f` / `#20302f` |
| `--selection` | `rgba(32,94,166,.18)` | `rgba(67,133,190,.3)` |
| `--shadow` | `0 18px 55px rgba(28,27,26,.12)` | `0 20px 60px rgba(0,0,0,.35)` |

组件风格要点：与纸感同构（同圆角/同间距），色彩差异全部由 token 表达——底更暖、墨更黑、强调色从红陶换靛青（D6 已拍板取靛青），划线选区随 accent 变蓝。**D4 已拍板：墨韵携带「书刊衬线」排版预设**——切入该系列时 `fontFamily` 自动置为 `serif`，复用现有阅读设置机制、不新增 `--font-heading` token；用户事后仍可在阅读设置中改回，改动保持到下次切换系列（实现见 5.4-c）。

**清透 mist**（Radix Slate + Blue 阶梯映射）

| token | light | dark |
|-------|-------|------|
| `--theme-color` / `--paper` | `#f0f1f3` / `#fcfcfd` | `#16181b` / `#16181b` |
| `--paper-raised` | `#ffffff` | `#1d2024` |
| `--chrome` / `--chrome-strong` | `#f1f2f4` / `#e7e9ec` | `#101214` / `#26292e` |
| `--ink` / `--ink-soft` / `--muted` | `#1c2024` / `#5c6570` / `#8b939e` | `#e6e8ea` / `#aeb4bb` / `#7b8288` |
| `--line` / `--line-strong` | `rgba(28,32,36,.1)` / `.18` | `rgba(230,232,234,.09)` / `.16` |
| `--accent` / `--accent-soft` / `--accent-ink` | `#3b6fd4` / `#e3ebfa` / `#2b57ab` | `#6ea2f5` / `#22314a` / `#a8c7fa` |
| `--teal` / `--teal-soft` | `#4d7a82` / `#e2edee` | `#7fb0b8` / `#223336` |
| `--selection` | `rgba(59,111,212,.16)` | `rgba(110,162,245,.28)` |
| `--shadow` | `0 14px 40px rgba(23,28,36,.08)` | `0 20px 60px rgba(0,0,0,.3)` |

组件风格要点：唯一带「非色彩差异」的系列——阴影明显更轻（上表已体现，仍走 `--shadow` token，无需新 token），无暖色偏移，整体更冷更平。字体排印维持系统无衬线栈。

**青瓷 celadon（二期，只给方向）**：light 底 `#edf4ea`（Thorium contrast4 `#C5E7CD` 与 Kindle 浅绿之间取低饱和值）、墨绿文字、茶褐或青绿 accent；dark 为深青 `#141f1c` 系。定稿放到二期。

### 5.3 哪些维度随套切换、哪些全局一致

| 随风格套切换 | 保持全局一致（理由） |
|---|---|
| 全部 17 个语义色 token + `--shadow` + `--theme-color`（含 meta theme-color） | 阅读排版四参数：字号/行高/宽度/段距不随系列变（调研结论 3：这是用户按眼睛调好的参数） |
| 字体风格预设（D4 拍板的例外）：切换系列时应用系列预设——墨韵→书刊衬线，纸感/清透→系统均衡；事后可在阅读设置手动覆盖，明暗翻转不触发 | — |
| 统计热力图 5 档（`color-mix` 自动派生，零成本跟随） | 三栏布局结构、断点、信息密度（AGENTS 稳定阅读体验要求；密度维度留给远期） |
| 选区色 `--selection` | 批注四色（跨主题的功能语义色，换套后旧标注必须仍可辨认【已核实现状即固定】） |
| — | 代码块恒深（`--code-bg/--code-chrome`，现有产品决策）、PDF 页面恒白（原版式保真）、Mermaid 默认主题（sandbox 一次性初始化【已核实】） |
| — | 动效等级、快捷键、图标体系、圆角与间距 |

### 5.4 技术架构（基于现有三件套演进）

**a. 主题注册表泛化（`src/lib/themes.ts`）**

- `ThemeSeriesId` 扩展为 `"paper" | "ink" | "mist"`（二期 `"celadon"`）。
- `ReaderTheme` id 采用 `${series}-${mode}` 二段式（Readest 同款【已核实】）：`paper-light / paper-dark / ink-light / ink-dark / mist-light / mist-dark`。旧 id `light/dark` 通过迁移映射为 `paper-light/paper-dark`（见 c）。
- `THEME_META` 每主题继续携带 `series/label/mode/themeColor`；`toggleThemeMode` 改为查表在当前系列内翻转（语义不变）；新增 `setSeries(theme, series)` 纯函数：保持当前 mode 换系列。
- 现有 `normalizeReaderTheme` 白名单防御链原样适用，fallback 改 `paper-light`。

**b. CSS 组织（`src/styles/theme-tokens.css`）**

- 结构从「`:root` 默认 + `[data-theme="dark"]` 覆盖」演进为「`:root` ＝ paper-light 默认值（兼防属性缺失）+ 每主题一个 `:root[data-theme="…"]` 块」，共 6 块，按系列分组、每块 17 token 齐全。
- 硬性约定（写进 AppCss 测试）：**新增系列不得新增 token 名**——17 个语义 token 是全系列公共契约，杜绝 `App.css` 里出现按系列特判的选择器；heatmap 派生块、`--code-bg/--code-chrome` 恒深块保持全局唯一。
- 体积核算：每主题块约 20 行 ≈ 0.6 KB，新增 4 块 ≈ 2.5 KB 未压缩纯 CSS，打入现有主 bundle，gzip 后可忽略【推断，按现文件 74 KB 的 App.css 与 2 KB 的 token 文件比例】。

**c. 状态与持久化（`src/store/useReaderStore.ts`）**

- `READER_PREFERENCES_VERSION` 3 → 4；`migrateReaderPreferences` 增加 id 映射（`"light"→"paper-light"`、`"dark"→"paper-dark"`），其余字段原样通过。现有 `merge` 的 normalize 链天然消化未知值（回退默认），旧版本降级安装也安全。
- 新增 action `setThemeSeries(series: ThemeSeriesId)`：内部 `setTheme(setSeries(state.theme, series))`，并按 D4 拍板同步应用系列字体预设 `updateReadingSettings({ fontFamily: SERIES_FONT_PRESET[series] })`（paper/mist → `"system"`，ink → `"serif"`）；`toggleTheme`（明暗翻转）不触发预设、不动其余排版参数。
- `partialize` 无需变化（仍持久化单字段 `theme`）——**不拆成 series+mode 两个持久化字段**，避免两字段组合校验与迁移复杂度【推断，权衡见决策点 D2】。

**d. 防闪烁（新增，冷启动路径）**

- 现状缺口：`data-theme` 由挂载后 `useEffect` 写入，深色用户首帧可能闪浅色（2 节【推断】）。
- 方案：新增极小引导模块（约 30 行）`src/theme-boot.ts`，在 `index.html` 中以 `<script type="module" src="/src/theme-boot.ts">` 置于 `main.tsx` **之前**：读 localStorage `reade-reader-preferences` → `JSON.parse` 取 `state.theme` → 白名单校验（含旧 id 映射）→ 写 `documentElement.dataset.theme` 与 meta theme-color；全程 try/catch，失败落回系统 `prefers-color-scheme`。
- CSP 约束【已核实】：桌面 CSP 为 `script-src 'self'`，**内联脚本会被拦截**，所以必须走同源外部脚本；Vite 会把该入口打成独立小 chunk，两端（Tauri/Pages）同构生效。React 侧 `useEffect` 保留为运行时同步，首帧前后各管一段。
- **实施修正（2026-08-12，【已核实】）**：Vite 构建会把同一 `index.html` 里的多个 `<script type="module">` **合并进单一页面入口**，直接在 HTML 中并列两个 script 标签时 boot 代码被并入主 bundle（实测主题落点仅从 ≈265 ms 提前到 ≈126 ms，冷启动仍要等整个主包）。实际实现改为 `vite.config.ts` 内约 60 行的 `reade:theme-boot` 插件：把 `src/theme-boot.ts` 增列为独立 rollup input，并经 `transformIndexHtml` 注入 `<head>` 首位（dev 注入源码路径，build 注入 base-aware 的 hashed chunk，产物 0.58 KB gzip 0.38 KB）。CSP 不变，仍为同源外部模块。
- 切换瞬间：一期维持瞬切（无 root 级颜色 transition，也符合 AppCss 测试对 PDF/EPUB 层禁动效的约束【已核实】）；**D5 已拍板：二期 M3 增加 View Transition 全屏 crossfade**，仅 `motionLevel === "full"` 时启用，`off/subtle` 维持瞬切。

**e. 双端一致性**

同一 `index.html`、同一 token CSS、同一 localStorage key，桌面与 Web 天然同构【已核实现状】。仅注意：Web 版 `<meta name="theme-color">` 初始值仍为纸感浅色，由 boot 脚本在首帧前改写，Pages 场景浏览器地址栏颜色随主题——现机制已支持，仅换数据源。

**f. 启动性能与包体影响评估**

- 新增 JS：boot 脚本 <1 KB（且先于主 bundle 执行完毕，不阻塞）；`themes.ts` 注册表增量 <1 KB。
- 新增 CSS：≈2.5 KB（见 b）。
- 新增依赖：**零**。新增字体下载：**零**（全部系统字体栈，已核实现状无 `@font-face`）。
- 运行时：切换主题＝改一个 DOM 属性，全部走 CSS 变量级联，无重挂载、无 JS 重算；与现状同量级。
- 结论：对启动时间与安装包体的影响在噪声范围内【推断，量级估算】。

### 5.5 切换体验

- **入口**：现有侧栏 footer `.theme-controls` 的系列 label（其 title 本就预告了扩展【已核实】）升级为按钮，点击弹出「界面风格」popover，复用现有 `settings-popover + reade-motion-panel` 模式（与阅读设置面板同款动效/无障碍语义）。明暗 Sun/Moon 按钮保持独立不动——系列与明暗两个正交操作，两个控件。
- **预览**：每系列一张色卡 tile——`paper/chrome/accent` 三色条 + 中文名（Thorium 色卡 + Apple Books tile 的合并简化【已核实来源见 3.1】），当前系列 `aria-pressed` 高亮。**点击即生效即预览**：本地切换零成本，不做 hover 临时预览与「应用/确认」两段式（调研结论 5）。
- **与阅读设置的关系**：阅读设置面板（字号/行高/宽度/段距/字体风格/动效）职责不变，不放风格选择——风格是「外观身份」，挂在主题控件旁；排版是「眼睛参数」，留在 `Aa` 面板。这与 Instapaper 高频/低频分层、Bear 主题与 Typography 分设的做法一致。按 D4 拍板，切换系列会把「字体风格」置为该系列预设值（面板中即时可见、可改回），popover 中应对此给出一行提示文案（如「已切换为书刊衬线，可在阅读设置中调整」）。
- **可访问性**：popover 内 `role="radiogroup"`；色卡按钮提供完整中文可访问名（如「墨韵·当前浅色」）；键盘 Tab/方向键循环；`Ctrl+O/Ctrl+K` 等既有快捷键不变，不为主题新增快捷键（低频操作）。
- **文档**：`docs/USER_GUIDE.md` 「设置」章节补一节「界面风格」。

---

## 6. 分阶段实施计划

每阶段独立可验收、可单独合入。工作量级：S ≈ 半天内，M ≈ 1–2 天，L ≈ 3 天+（人工校准口径）。

### M0：主题基建泛化（不新增任何可见样式）——量级 S–M

1. `themes.ts`：id 二段式、注册表泛化、`toggleThemeMode` 查表化、`setSeries` 纯函数（仍只有 paper 系列）。
2. store v4：迁移映射 `light/dark → paper-light/paper-dark`；`setThemeSeries` action。
3. `theme-tokens.css`：`[data-theme="dark"]` 选择器更名 `[data-theme="paper-dark"]`；`:root` 注释更新。
4. `theme-boot.ts` 防闪烁引导 + `index.html` 引入。
5. 测试同步：`themes.test.ts`、`useReaderStore.test.ts`（新增 v3→v4 迁移用例：持久化 `"dark"` 必须复原为 `paper-dark`）、`AppCss.test.ts`（断言改为遍历全部注册主题的 token 齐全性）、`App.test.tsx`（初始 theme 常量）。

验收：`pnpm test`、`pnpm exec tsc --noEmit` 通过；桌面与 `pnpm dev:web` 各冷启动一次验证深色偏好无白闪（人工视觉，AGENTS 要求运行时证据）；明暗切换、meta theme-color、localStorage 旧数据升级均无回归。
风险：boot 脚本读取的 persist JSON 结构（`{state:{theme},version}`）与 zustand 内部格式耦合——测试里固定该契约；旧 id 残留路径（如系统深色偏好 + 空 localStorage）需覆盖用例。

### M1：墨韵系列 + 系列切换 UI ——量级 M

1. `theme-tokens.css` 增加 `ink-light/ink-dark` 两块（5.2 规格为起点，accent 取靛青，D6 已拍板）。
2. `themes.ts` 注册「墨韵」（含两个 themeColor）与 `SERIES_FONT_PRESET` 常量。
3. `setThemeSeries` 应用系列字体预设（D4 已拍板；含 popover 内一行提示文案）。
4. `theme-controls` 系列 popover + 色卡 tile（5.5 规格）。
5. `USER_GUIDE.md` 更新（界面风格 + 字体预设行为说明）。
6. 测试：注册表↔CSS 一致性（每个注册主题在 CSS 中存在对应块且 17 token 齐全）、popover 交互用例（切系列 → `documentElement.dataset.theme` 变化、持久化写入）、字体预设用例（切系列改 `fontFamily`、切明暗不改、事后手动覆盖生效）。

验收：2 系列 × 明暗 × 宽窄窗口共 8 张截图走查（AGENTS 视觉要求）；对比度自检达 5.2 目标；重点面走查清单——统计热力图（accent 换靛青后热力图变蓝为预期行为）、批注四色在墨韵底色上的辨识度、选区色、代码块、PDF/EPUB 表面、搜索高亮。
风险：固定批注黄绿蓝粉与靛青 accent 的和谐度需实物确认；`color-mix` 派生的 stats 阶梯在新 paper 值下的第 1–2 档可能过淡；衬线预设在 Windows 字体栈的实际观感（`Noto Serif SC` 缺失时回落 `SimSun`）需截图确认。

### M2：清透系列 + 打磨 ——量级 S–M

1. `mist-light/mist-dark` token 块与注册。
2. 焦点环/选中态在三系列下的统一校准；popover 键盘循环完善。
3. 同 M1 的截图走查与测试扩展（此时断言已是遍历式，增系列近零测试成本）。

验收：3 系列 × 明暗 × 宽窄 12 张截图；`pnpm test` + `tsc` + `cargo` 检查全绿（Rust 侧无改动，跑通即可）。
风险：低——机制已在 M1 验证，本阶段纯定色与打磨。

### M3（二期，范围已按 D1/D5 拍板）——量级各 M

- 青瓷护眼系列（D1 拍板排期；同 M2 流程，色值二期定稿）。
- 切换动效（D5 拍板）：`motionLevel === "full"` 时用 `document.startViewTransition` 做全屏 crossfade（特性检测 + 局部类型声明，规避 ES2020 lib 限制；`off/subtle` 维持瞬切；需补动效回归确认不违反 AppCss 测试对 PDF/EPUB 层的禁动效约束）。
- ~~风格附带「推荐排版」提示条~~——已被 D4 拍板的「系列内建字体预设」取代，不再单独立项。
- 明确不做【推断，与定位冲突】：用户自定义配色编辑器（Koodo/Readest 有，但对单用户本地应用是过度工程）、社区主题加载（引入任意 CSS 与安全边界冲突）、OLED 纯黑档。

---

## 7. 假设与待确认决策点

**假设（若不成立需回摆方案）：**

- A1 任务模板中「设计方向需结合用户偏好」留空，按约定由我基于调研提出「书卷暖纸（墨韵）+ 极简冷灰（清透）」双方向，对应 Reade 内容双形态。
- A2 单用户、本地优先，无跨设备同步主题的需求；偏好继续只存 localStorage。
- A3 现有 17 语义 token 足以表达三个系列（清透的「轻阴影」走 `--shadow` token 本身）；若视觉走查发现表达力不足，新增 token 必须全系列同步定义并进 AppCss 测试契约。
- A4 桌面 WebView2 与 Pages 目标浏览器均为近代 Chromium（现已使用 `color-mix`【已核实】），CSS 变量/boot 脚本无兼容性障碍。
- A5 深色首帧闪烁确实存在（【推断】尚未实机复现，M0 实现前应先复现确认，若实测不闪则 boot 脚本降级为「仅提前 meta theme-color」的轻量版）。
  - **2026-08-12 实测结论（M0 前复现，【已核实】）**：闪烁存在。方法：`pnpm build:web` + `vite preview` 产物，Chromium 预置 v3 `{state:{theme:"dark"},version:3}` 后冷加载，init script 逐帧（rAF）记录 `data-theme` 并对照 Performance paint 条目。修复前 first-paint ≈ 36 ms 时 `data-theme` 尚未写入（浅色 `:root` 默认值起效），React effect 到 ≈ 265 ms 才落深色属性——约 230 ms 浅色首屏窗口。据此实现**完整版 boot 脚本**；修复后同法复测，首个记录帧（≈ 65 ms，早于 first-paint 72 ms）即为 `paper-dark`，无任何浅色帧。

**决策记录（2026-08-12 用户已拍板）：**

| # | 决策点 | 拍板结果 | 与推荐的关系 |
|---|--------|----------|--------------|
| D1 | 第三、四系列取向与先后 | 清透进一期，青瓷进二期（M3） | 采纳推荐 |
| D2 | 主题 id 迁移策略 | 全量迁移：store v4 一次性映射 `light→paper-light`、`dark→paper-dark` | 采纳推荐 |
| D3 | 代码块恒深、PDF 页恒白 | 全部系列维持，不破例 | 采纳推荐 |
| D4 | 系列是否携带字体气质 | **墨韵内建「书刊衬线」预设**：切入系列自动置 `fontFamily: serif`，事后可手动改回；纸感/清透预设为系统均衡 | **用户改选**（原推荐纯色彩层 + M3 提示条；提示条方案作废） |
| D5 | 切换瞬间过渡 | 一期瞬切；**M3 增加 View Transition crossfade**（仅 `motion=full`） | **用户改选**（原推荐仅瞬切） |
| D6 | 墨韵 accent 取色 | 靛青 `#205ea6` 家族 | 采纳推荐 |

启动方式：~~仅锁定方案，暂不实施~~ → **2026-08-12 一期 M0–M2 已实施**。A5 已先行实机复现（结论见上），boot 脚本采用完整版。

**实施备注（2026-08-12）：**

- 5.2 的墨韵/清透色值**起点即定稿，未做微调**。六主题对比度实测（Chromium computed style + WCAG 相对亮度）：`--ink` 对 `--paper` 10.77–18.62:1（目标 ≥7），`--ink-soft` 5.77–8.51:1（目标 ≥4.5），`--muted` 3.03–4.57:1（目标 ≥3），全部达标；heatmap `color-mix` 阶梯在靛青/冷蓝 accent 下按预期变为蓝系，第 1–2 档未见过淡。
- boot 脚本形态：完整版 + 独立 chunk（机制修正见 5.4-d 实施修正）。
- 切换 UI 无障碍语义按 WAI-ARIA radio group 规范实现：容器 `role="radiogroup"`，色卡 tile `role="radio"` + `aria-checked` + roving tabindex + 方向键循环选择（5.5 原文的 `aria-pressed` 与 radiogroup 语义冲突，未采用）。
- `[data-theme]` 全量块除 17 个语义 token 外统一携带 `color-scheme`；`--code-bg/--code-chrome` 只在 `:root` 定义一次（AppCss 测试锁定）。

---

## 8. 参考来源列表

**官方文档 / 官方仓库（【已核实】级）**

| 产品/资产 | 来源 |
|-----------|------|
| Kindle 阅读应用 | [Accessible Reading Options for Kindle Reading Apps — Amazon Help](https://www.amazon.com.au/gp/help/customer/display.html?nodeId=TABlJ4ot69emTO8jJG) |
| Apple Books（macOS） | [Change a book's appearance in Books on Mac — Apple Support](https://support.apple.com/guide/books/change-a-books-appearance-ibks8923126d/mac) |
| 微信读书 | [如何设置阅读界面的背景和字体 — 官方帮助](https://weread.qq.com/wrpage/app/help/detail/qReadingBgAndFront) |
| Koodo Reader | [GitHub README](https://github.com/koodo-reader/koodo-reader)、[官网](https://koodoreader.com/)、[官方 Changelog](https://www.koodoreader.com/en/changelog) |
| Thorium Reader | [Reading settings — 官方文档](https://thorium.edrlab.org/en/docs/210_reading/215_readingparameters/)、[ReaderSettings.tsx 源码（8 主题色值）](https://github.com/edrlab/thorium-reader/blob/02b67755/src/renderer/reader/components/ReaderSettings.tsx)、[无障碍说明](https://thorium.edrlab.org/en/docs/300_accessibility/310_natives/) |
| Readest | [官网](https://readest.com/)、[themes.ts 源码（调色板与派生）](https://github.com/readest/readest/blob/30727d35/apps/readest-app/src/styles/themes.ts)、[themeStore.ts 源码（data-theme 机制）](https://github.com/readest/readest/blob/4c2d8022/apps/readest-app/src/store/themeStore.ts) |
| Readwise Reader | [Appearance — 官方 Docs](https://docs.readwise.io/reader/docs/faqs/appearance)、[Long-form reading — 官方 Docs](https://docs.readwise.io/reader/guides/workflows/longform-reading) |
| Matter | [官网](https://www.getmatter.com/) |
| Instapaper | [Text Settings — 官方 Docs](https://www.instapaper.com/docs/read/text-settings)、[8.2 版设计说明 — 官方博客](https://blog.instapaper.com/post/697745829686099968) |
| Obsidian | [Build a theme — 官方开发者文档](https://docs.obsidian.md/Themes/App+themes/Build+a+theme)、[Minimal 主题页（下载数）](https://community.obsidian.md/themes/minimal) |
| Typora | [About Themes — 官方支持](https://support.typora.io/About-Themes/)、[Add Custom CSS — 官方支持](https://support.typora.io/Add-Custom-CSS/)、[默认主题仓库](https://github.com/typora/typora-default-themes/tree/master/themes) |
| Bear | [主题 FAQ — 官方](https://bear.app/faq/about-free-and-pro-themes-in-bear/)、[排版 FAQ — 官方](https://bear.app/faq/typography-options/)、[Bear Sans 设计记 — 官方博客](https://blog.bear.app/2023/08/learn-about-our-new-custom-font-bear-sans/) |
| Flexoki 配色系统 | [官方页（设计理念）](https://stephango.com/flexoki)、[GitHub（完整色值）](https://github.com/kepano/flexoki/) |
| DAISY（Thorium 指南） | [Thorium Reader Getting Started](https://daisy.org/guidance/info-help/guidance-training/reading-systems/thorium-epub-reader-quick-start-guide/) |

**第三方评测 / 社区资料（【二手】级）**

- [Ebook Friendly：Kindle 自定义主题实测](https://ebookfriendly.com/kindle-app-ipad-custom-themes/)
- [iDownloadBlog：Apple Books 六主题与 Customize 详解](https://www.idownloadblog.com/2022/09/21/how-to-use-themes-in-books-app-on-ipad-iphone/)
- [TapSmart：Books 主题与翻页动画变迁](https://www.tapsmart.com/tips-and-tricks/ipados16-books/)
- [The Sweet Setup：Matter vs Readwise Reader](https://thesweetsetup.com/is-matter-or-readwise-reader-the-read-later-app-for-you/)、[Matter Web 版评测](https://thesweetsetup.com/an-early-look-at-matter-on-the-web/)
- [MacStories：Matter 评测](https://www.macstories.net/reviews/matter-a-fresh-take-on-read-later-apps/)
- [Perkins School for the Blind：Instapaper 无障碍清单（字体/色板全表）](https://www.perkins.org/resource/instapaper-accessibility-for-visual-impairment/)
- [DeepWiki：Koodo 主题体系解析](https://deepwiki.com/koodo-reader/koodo-reader/7.3-themes-and-appearance-customization)、[DeepWiki：Readest 主题与色彩系统](https://deepwiki.com/readest/readest/3.5-theme-and-color-system)
- [Knowledge Ecology：Obsidian 主题下载量盘点（2023→2026）](https://www.knowledgeecology.me/top-35-best-obsidian-themes-as-decided-by-its-users/)
- [微信读书桌面端使用梳理（cnblogs）](https://www.cnblogs.com/pcdoctor/p/19598481)

**本仓库源码（现状核实，见第 2 节表格内路径）**：`src/styles/theme-tokens.css`、`src/lib/themes.ts`、`src/store/useReaderStore.ts`、`src/App.tsx`、`src/App.css`、`src/AppCss.test.ts`、`src/lib/themes.test.ts`、`index.html`、`src/main.tsx`、`src-tauri/tauri.conf.json`、`src/components/MarkdownRenderer.tsx`、`package.json`。
