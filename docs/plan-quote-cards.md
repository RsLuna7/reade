# 实施方案:金句卡片

- 日期:2026-08-13
- 状态:**已实施**
- 定位:选中一段文字 → 生成一张随当前主题取色的引文卡片 PNG(canvas 本地渲染)→ 复制到剪贴板/保存。它是"把这句话带走"的输出通道,与批注(把这句话留在书里)互补。版式走策展路线:两档,不做自定义——呼应主题调研「策展式少量精品胜过无限自定义」(`docs/research-multi-ui-themes.md` L129)。
- 关联:入口挂在 `SelectionToolbar`(批注 v2 的选区管线);M2 从已有高亮生成卡片复用批注中枢/列表的条目动作;导出通道与批注导出的"剪贴板优先、零权限"路线一脉相承(`docs/plan-annotation-hub.md` §2 非目标同款立场)。

> 一句话:一个可注入 `measureText` 的纯排版函数(CJK/英文混排贪心断行)+ 一个从 computed style 读 17 token 契约取色的 canvas 绘制器(devicePixelRatio 恒 2x),出口首选 `navigator.clipboard.write(ClipboardItem PNG)`(仓库已有剪贴板与 caniuse 双重证据),`a[download]` 兜底;零新依赖、零 Rust 改动、零权限变更(Tauri 保存对话框列为默认不做的决策点)。

---

## 1. 现状基线(全部【已核实】于本仓库源码)

| 事实 | 位置 |
|------|------|
| `SelectionToolbar` 现有动作:四色块 + 高亮/下划线/笔记/书签 + 关闭;由 `pendingSelection && annotationTool === "view"` 驱动,位置 `toolbarPos` | `src/components/AnnotationUi.tsx` L30-97;`src/App.tsx` L3764-3776、L2466-2471 |
| 选区已被规范化捕获:`PendingSelection = { text, locator, rect }`,`text` 经 `clampSelectionText`(空白折叠 + ≤2000 字符) | `src/lib/annotationCapture.ts` L15-19;`src/lib/annotations.ts` L12、L39-43 |
| 剪贴板先例(文本):`copyTextToClipboard` = `navigator.clipboard.writeText` + `execCommand` 兜底,桌面 WebView2 下已日常工作(批注 Markdown 导出即此通道) | `src/App.tsx` L2238-2262、L2264-2273 |
| Web 端文件下载先例:`downloadTextFile`(Blob + `a[download]` + objectURL) | `src/lib/fileTransfer.ts` L12-28 |
| 桌面端 Rust 侧保存对话框先例:`export_annotations_file` 从 Rust 驱动 `blocking_save_file`,**零 capability 变更**(注释明确:capability 只管 JS 侧插件 IPC);文件名白名单当前仅 `json/csv` | `src-tauri/src/transfer.rs` L1-8、L25、L30-48、L78-101 |
| 17 语义 token 契约:`--paper/--paper-raised/--ink/--ink-soft/--muted/--accent/--accent-soft/--accent-ink/--line/--line-strong/--shadow/--selection/...`,每主题一个完整 block,新系列不得新增 token 名——**从 computed style 读这些 token 即天然四系列 × 明暗自适配** | `src/styles/theme-tokens.css` L1-19、L58-245 |
| 主题模式判定:`themeMode = THEME_META[theme].mode`;主题切换即时反映在 `document.documentElement.dataset.theme` | `src/App.tsx` L1208、L2653-2667 |
| canvas 像素比先例:PDF 渲染 `Math.min(window.devicePixelRatio \|\| 1, 2)` | `src/components/PdfReader.tsx` L387 |
| 衬线字体栈先例(卡片正文可复用):`.article-title` 的 `"Iowan Old Style", "Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif` | `src/App.css` L1018-1019 |
| 出处素材齐备:文档标题 `currentDocument.title`;批注侧有 `selectedText`(同样 ≤2000)与 `annotationPositionLabel`(位置文案) | `src/App.tsx` L1198-1201;`src/lib/backend.ts` L167-186;`src/lib/annotationExport.ts` L45 |
| CSP:`img-src 'self' asset: http://asset.localhost data: blob:`——canvas 结果以 blob URL 预览合法;`font-src 'self' data:`——不允许外部 webfont(本方案只用系统字体,无冲突) | `src-tauri/tauri.conf.json` L26 |
| capabilities 仅 `core:default`+`dialog:allow-open`+`opener:allow-open-url`;canvas/剪贴板均不需 capability | `src-tauri/capabilities/default.json` L6-10 |
| 弹层组件模式:`reade-motion-panel` + `role="dialog"`(笔记编辑器、导入确认等先例) | `src/App.tsx` L3841-3863;`src/components/AnnotationUi.tsx` L1084 |

**外部证据(导出通道,QC-D1/QC-D2 的依据)**

| # | 结论 | 证据级 | 来源 |
|---|------|--------|------|
| 1 | `navigator.clipboard.write` + `ClipboardItem` `image/png`:Chrome/Edge 76/79+、Safari 13.1+、Firefox 127+(2024-06 起 Baseline);需 secure context + 用户手势 | 【已核实】caniuse + MDN | [caniuse clipboard write](https://caniuse.com/mdn-api_clipboard_write)、[caniuse image/png](https://caniuse.com/mdn-api_clipboard_type_image-png)、[MDN Clipboard.write](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/write) |
| 2 | `ClipboardItem.supports("image/png")` 可做运行时特征检测(MDN 推荐写法) | 【已核实】MDN | [MDN ClipboardItem](https://developer.mozilla.org/en-US/docs/Web/API/ClipboardItem/ClipboardItem) |
| 3 | WebView2 = Chromium 内核,继承上述支持;且本仓库桌面端 `clipboard.writeText` 已实证可用(同一 clipboard-write 权限族) | 【已核实】仓库先例(基线表第 3 行)+【推断】writeText→write 同权限的外推,**PNG 写入列 Q0 冒烟** | 本仓库 |
| 4 | 旧 Firefox(<127)无 `ClipboardItem`(默认关) | 【已核实】caniuse;兜底链因此必须存在 | [wolfgangrittner.dev](https://wolfgangrittner.dev/how-to-use-clipboard-api-in-firefox/) |
| 5 | Tauri WebView2 中 blob `a[download]` 的落盘行为(下载到哪里/是否弹窗)缺一手数据 | 【推断】WebView2 默认下载行为应生效,**列 Q1 冒烟**;若不可靠则启用 QC-D2 备选 | — |

## 2. 目标与非目标

**目标**

1. 选中文字 → 工具条「卡片」→ 预览浮层(两档版式、当前主题取色)→ 一键复制 PNG 到剪贴板;Web 端另有下载兜底。
2. 卡片随四主题系列 × 明暗自动适配(计算样式取色,零硬编码色值)。
3. CJK/英文混排断行排版正确,devicePixelRatio 2x 清晰输出。
4. M2:从已有高亮/下划线批注一键生成卡片(数据即 `selectedText`)。

**非目标(明确不做)**

- 不做社交分享集成(不调系统分享、不带二维码)、不做模板商店、不做水印/署名自定义。
- 不做自定义版式编辑器(字号/配色/比例全部不可调——两档策展版式,见定位)。
- 不嵌入 webfont(系统字体栈;CSP `font-src` 不动)、不做 SVG 导出、不做批量生成。
- 不为保存文件新增权限/插件(QC-D2 默认关;真要做也走 Rust 侧对话框先例,零 capability 变更)。
- 零新依赖(不引入 html2canvas/dom-to-image——手绘 canvas 对两档固定版式足够且体积为零)。

## 3. 设计

### 3.1 交互入口

- `SelectionToolbar` 新增「卡片」按钮(书签之后、关闭之前;`disabled={!canHighlight}` 同款守卫)。工具条已有 4 色块 + 5 按钮,加一枚后在 360px 定位宽度内仍放得下(现有 `x` clamp 以 360 为界,App.tsx L2466-2468);Q1 视觉走查确认不换行。
- 点击 → 关闭工具条,打开**预览浮层**(QC-D5):居中 `role="dialog"` 的 `reade-motion-panel`,内含卡片预览图(canvas 绘制后 `toBlob` → blob URL `<img>`,CSP `img-src blob:` 已允许)、版式二选一分段按钮、主按钮「复制图片」、次按钮「下载 PNG」(Web 恒有;桌面视 Q1 冒烟结果决定去留,见证据 #5)、关闭。
- 预览即所得:预览图就是导出物本身(同一 blob),不存在二次渲染偏差。
- `Esc` 关闭浮层(挂既有 Esc 分支链);浮层打开期间选区已可释放(文本已捕获进 state)。

### 3.2 卡片渲染管线

新模块 `src/lib/quoteCard.ts`(canvas 绘制器)+ `src/lib/quoteCardLayout.ts`(纯排版函数,可注入 measure 单测):

```ts
// quoteCardLayout.ts —— 纯函数,不碰 DOM
interface QuoteCardInput { quote: string; sourceTitle: string; dateLabel: string }
interface CardLayout { lines: string[]; truncated: boolean; height: number; ... }
layoutQuoteCard(input, style: CardStyleId, measure: (text: string) => number): CardLayout

// quoteCard.ts —— 绘制器
renderQuoteCard(input, style: CardStyleId, theme: ResolvedCardTheme): Promise<Blob> // PNG
readCardTheme(root: HTMLElement): ResolvedCardTheme
// getComputedStyle(document.documentElement).getPropertyValue("--paper") 等,
// 取 --paper / --paper-raised / --ink / --ink-soft / --muted / --accent / --line;
// canvas 无法解析 var(),必须经 computed style——这是 17 token 契约的直接消费,零新 token
```

- **尺寸**:逻辑宽 720px,高度随内容自适应(clamp 480-1080);导出恒 **2x**(canvas 物理 1440 × H×2,`ctx.scale(2,2)`)——与 PDF 渲染 `min(dpr, 2)` 先例一致的上限,兼顾清晰度与文件体积,不跟随更高 dpr。
- **版式两档(QC-D4)**:
  - A「素笺」:`--paper` 底、左上 `--accent` 大引号装饰、正文左对齐(`--ink`)、底部出处行(`--muted`)+ 细分隔线(`--line`)+ 右下 "Reade" 字标(`--accent`);
  - B「衬线中轴」:`--paper-raised` 底、正文衬线居中(`.article-title` 字体栈)、上下对称留白、出处行居中。
  - 暗色主题下即为暗底卡片(token 自带),不做"强制亮底"开关。
- **字体**:正文 A 档用界面无衬线栈、B 档用衬线栈(基线表第 9 行);字号按引文长度三档阶梯(≤60 字 28px / ≤160 字 22px / 更长 18px),行高 1.7;全部系统字体,无网络加载。

### 3.3 换行排版算法(CJK/英文混排)

`layoutQuoteLines(text, maxWidth, measure)` 贪心断行,单测注入等宽 measure:

- 分词单元:优先 `Intl.Segmenter(undefined, { granularity: "word" })` 特征检测(类型处理同朗读方案 RA-D2:模块内最小声明,不动 tsconfig lib);兜底正则把文本切为「拉丁词(含内部连字符)/连续空白/单个 CJK 字符/单个其他字符」序列。
- 规则:拉丁词整词不拆(超行宽的孤词按字符硬拆);CJK 逐字可断;**简单禁则**——行首禁排 `。，、；：！？》」』)]%~…`,行尾禁排 `《「『([`(把违禁字符并入上一/下一行,一次修正即可,不做全量 kinsoku);空白折叠(输入已被 `clampSelectionText` 折叠过,双保险)。
- 截断策略:排版超过 **12 行**或 240 字符时截断到 11 行 + 末行追加"……"(`truncated: true`,预览浮层提示"引文过长,已截断");不做滚动卡片。
- 出处行:`{文档标题} · {YYYY年M月D日}`——日期取**生成当日**(卡片是"今天我摘了这句",不是批注创建日;M2 从批注生成时同样用当日,语义统一);标题超宽尾部省略。

### 3.4 导出通道(QC-D1/QC-D2)

按优先级组成降级链,新函数 `copyImageToClipboard(blob): Promise<boolean>` 放 `src/lib/quoteCard.ts`:

1. **主通道:剪贴板 PNG**——`ClipboardItem` 存在性(+ 可选 `supports("image/png")`)检测 → `navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])`。零新权限,与批注 Markdown 导出的剪贴板先例同一姿势(证据 #1-#3);成功后 notice「卡片已复制,可直接粘贴到聊天/笔记」。
2. **兜底:下载 PNG**——`downloadBlobFile(fileName, blob)`(把 `fileTransfer.downloadTextFile` 泛化出 Blob 版本,同一 objectURL 模式);文件名 `reade-quote-{YYYYMMDD}.png`。Web 端恒显示;桌面端视 Q1 冒烟(证据 #5)决定显示或隐藏。
3. **不做(默认):Tauri 保存对话框**——QC-D2 决策点。若冒烟发现 WebView2 下 blob 下载不可靠且用户确有落盘需求,启用备选:扩展 `transfer.rs`(`EXPORT_FILE_KINDS` 加 `("png", "PNG 图片")` + 增加 base64 字节通道与解码校验),沿用"Rust 驱动对话框、前端不传路径、零 capability 变更"的既有安全形态;这是唯一涉及 Rust 的备选路径,默认不做。

### 3.5 与批注的关系(QC-D3)

- **M1:仅实时选区**。`pendingSelection.text` 即引文,`currentDocument.title` 即出处——不新增任何数据读取。
- **M2:从已有高亮生成**。批注列表与全库中枢的条目 overflow 菜单加「生成卡片」(仅 `selectedText` 非空的 highlight/underline;书签无摘录不显示):引文 = `annotation.selectedText`,出处 = 文档标题(`documentTitles` 映射已有);复用同一预览浮层。不做"卡片记录/历史"——卡片是即用即走的输出,不是新的数据实体,**零存储、零 schema**。

### 3.6 安全与 CSP

- 全链路本地:选区文本 → 内存排版 → canvas → blob;无网络、无字体外联、无文件系统访问(下载走浏览器标准 `a[download]`)。
- 渲染的都是**不可信文档文本**,但 canvas `fillText` 只把字符串画成像素,无注入面;出处标题同理。唯一变长输入(引文/标题)有 2000 字符与 12 行双上限。
- CSP 零变更(blob 预览已被 `img-src blob:` 允许);capability 零变更;剪贴板写入在用户点击的手势上下文内(证据 #1 的手势要求天然满足)。

## 4. 改动清单(预估)

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/quoteCardLayout.ts`(新)+ 测试 | 混排断行、禁则、截断、字号阶梯(纯函数) | M |
| 2 | `src/lib/quoteCard.ts`(新)+ 测试 | token 取色、canvas 绘制、`toBlob`、剪贴板/下载出口 | M |
| 3 | `src/lib/fileTransfer.ts` + 测试 | `downloadTextFile` 泛化出 `downloadBlobFile` | S |
| 4 | `src/components/QuoteCardDialog.tsx`(新,lazy)+ 测试 | 预览浮层(版式切换/复制/下载/截断提示) | M |
| 5 | `src/components/AnnotationUi.tsx` + 测试 | `SelectionToolbar` 加「卡片」;M2:列表/中枢条目「生成卡片」 | S |
| 6 | `src/App.tsx` | 浮层挂载、入口接线、Esc 分支 | S |
| 7 | `src/App.css`、`docs/USER_GUIDE.md` | 浮层样式、「金句卡片」章节 | S |

里程碑:**Q0** 排版纯函数 + 绘制器 + 出口(可脱离 UI 验收,含剪贴板冒烟)→ **Q1** 工具条入口 + 预览浮层闭环 → **Q2** 批注侧入口 + 四系列视觉矩阵 + 文档。

## 5. 验收标准

**Q0(排版与出口)**

- [ ] 单测(`quoteCardLayout.test.ts`,注入 `measure = 等宽`):纯 CJK 逐字断行不超宽;纯英文整词断行、超长孤词硬拆;混排(`中文word中文`)边界正确;行首 `。」` 禁则修正、行尾 `《(` 禁则修正;60/160/240 字符三档字号阶梯;>12 行截断且 `truncated === true`、末行以"……"结尾;空串与全空白输入产出占位("　"或拒绝,行为固定并断言);出处标题超宽省略。
- [ ] 单测(`quoteCard.test.ts`,jsdom):`readCardTheme` 从带 style 的根元素读出全部所需 token、缺失 token 时回落 `:root` 默认值(theme-tokens L21-42 的防御语义);`copyImageToClipboard` 在无 `ClipboardItem` 环境返回 false 不抛错(mock navigator);`downloadBlobFile` 生成并点击 `a[download]`(spy)。
- [ ] **剪贴板冒烟(桌面)**:`pnpm tauri dev` DevTools 里执行——

```js
const c = document.createElement("canvas"); c.width = 200; c.height = 100;
c.getContext("2d").fillRect(0, 0, 200, 100);
c.toBlob(async (b) => {
  await navigator.clipboard.write([new ClipboardItem({ "image/png": b })]);
  console.log("clipboard PNG OK");
});
```

  随后粘贴到系统画图/聊天软件确认图片入板。Web 端(Edge/Chrome/Firefox ≥127)同脚本各验一次。结果回填本节;失败则按 §3.4 降级链调整主通道并修订 QC-D1。
- [ ] 回归:`pnpm test`、`pnpm exec tsc --noEmit`。

**Q1(交互闭环)**

- [ ] 组件测(`QuoteCardDialog.test.tsx`):打开即渲染预览 img(blob URL);版式切换重绘(blob 变化);「复制图片」调用出口且成功后关闭 + notice;剪贴板失败时 fallback 提示含下载引导;Esc 关闭;`role="dialog"` 与焦点管理。
- [ ] 组件测(SelectionToolbar):新按钮存在、`canHighlight=false` 时禁用;点击回调触发;既有五动作测试全数保持通过。
- [ ] 运行时(桌面):三种格式各选一段(含一段中英混排、一段 >240 字符长文)→ 生成 → 粘贴到外部应用,文字清晰(2x)、主题色正确、截断提示出现;**桌面 blob 下载冒烟**(证据 #5):点「下载 PNG」确认 WebView2 落盘行为,结果回填并按其决定桌面端该按钮去留(QC-D2)。
- [ ] 运行时(Web):`pnpm dev:web` 在 Chrome 与 Firefox 各走复制 + 下载;Firefox <127 场景以 DevTools 删除 `ClipboardItem` 模拟,确认降级到下载且提示正确。
- [ ] 性能预算:选区 → 预览可见 < 300ms(720×~900 @2x,console.time 佐证);导出 PNG 体积 < 600 KB(纯色底 + 文字的合理上限);连续生成 10 张无内存增长(blob URL 及时 revoke)。

**Q2(完成态)**

- [ ] 组件测:批注列表/中枢条目「生成卡片」仅对有摘录的 mark 类显示;书签条目不显示;点击带出正确引文与文档标题。
- [ ] **截图矩阵:版式 A/B × paper/ink/mist/celadon × 明/暗 = 16 张卡片成品**(脚本循环切主题生成,人工走查对比度——重点:暗色系底上 `--muted` 出处行的可读性、celadon 系 `--accent`(茶棕)引号装饰的辨识度)。
- [ ] 视觉走查:预览浮层明/暗 × 宽/窄(820 以下)≥ 4 张截图;工具条加按钮后在 360px 约束内不换行。
- [ ] 全量回归:`pnpm test`、`tsc --noEmit`、`pnpm build`、`pnpm build:web`;Rust 侧零改动(QC-D2 未启用时;不跑,说明即可)。
- [ ] `docs/USER_GUIDE.md` 新增「金句卡片」章节(含两档版式示例图);README 能力清单同步一行。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| QC-D1 | 导出主通道 | **剪贴板 PNG(`ClipboardItem`)**——零权限、即粘即用、与既有剪贴板导出先例同路线;证据见 §1 外部证据表 | 下载优先(多一步文件管理,弱于"复制→粘贴"的分享动线);两者并列展示(按钮权重相同会稀释主动线) |
| QC-D2 | Tauri 侧保存对话框 | **默认不做**;桌面落盘先走 blob `a[download]` 冒烟(证据 #5),不可靠再启用 | 启用备选 = 扩展 `transfer.rs` 白名单加 png + base64 通道(沿"Rust 驱动对话框、零 capability"先例,改动 S-M,含 Rust 测试:文件名校验、字节解码上限) |
| QC-D3 | 卡片来源 | **M1 实时选区;M2 已有高亮/下划线条目**(数据即 `selectedText`,零存储) | 只做实时选区(放弃"回头翻高亮做卡"的高频场景,可惜);为卡片建历史记录(新数据实体,过度设计,否决) |
| QC-D4 | 版式档位 | **两档(素笺/衬线中轴),不可自定义** | 一档(单调);三档以上或开放配色(滑向模板商店,违背策展定位,否决) |
| QC-D5 | 出口交互 | **预览浮层(版式切换 + 复制/下载)**——卡片是视觉产物,盲复制不可接受 | 点「卡片」直接复制默认版式(快一步,但用户第一次无法建立"卡片长什么样"的预期;可作为浮层内"记住版式后跳过预览"的将来选项) |
| QC-D6 | 高 DPI 策略 | **恒 2x 导出**(不跟随 dpr>2;与 PDF 渲染上限先例一致,体积可控) | 跟随实际 dpr(3x/4x 屏产出 4-8MB 级 PNG,粘贴场景无收益,否决) |

## 7. 风险与开放问题

- **canvas 文字排版是本方案的手工含量所在**:`measureText` 对连字/复杂标点簇的宽度与实际绘制存在亚像素差,累积到行尾可能溢出 1-2px——排版时预留 4% 行宽安全边距,验收截图矩阵重点看行尾;若真实字体下断行观感差,调整只发生在纯函数内,不外溢。
- 剪贴板写入在个别环境(远程桌面、剪贴板管理器占用)会抛 `NotAllowedError`——降级链已兜住(提示 + 下载),但 Q1 冒烟要覆盖一次远程桌面场景(个人使用画像里存在)。
- 系统字体栈在不同 Windows 机器上的实际命中(有无 Noto Serif SC)导致卡片观感漂移——接受(与阅读器正文同样的现实),USER_GUIDE 不承诺像素级一致。
- 工具条按钮数量逼近拥挤阈值:本方案加「卡片」后,若朗读方案未来也想进工具条(RA-D6 已推荐不进),需要先做工具条溢出设计再谈新增——两方案已协调,此处立此存照。
- `toBlob` 在极端大卡(12 行 × 2x)下的耗时未知——预算 300ms 已含余量,超预算优先降逻辑宽(720→640)而非降像素比。
