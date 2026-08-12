# 主流阅读器批注数据模型与迁移策略对比调研

- 日期：2026-08-12
- 范围：Calibre、Zotero、KOReader、Hypothesis（含 W3C Web Annotation / EPUB CFI / PDF 标准注释基线）、Readwise（含 Kindle 迁移案例）、MarginNote 六个条目的批注数据模型、锚定、schema 版本化、导出互操作、删除同步与失锚 UX；并据此对 Reade 批注存储给出逐问题裁决与 v2 提案
- 状态：**仅调研与方案裁决，未改动任何产品代码**
- 证据标注约定：**【已核实】**＝直接读取源码 / 官方文档 / 规范原文确认；**【推断】**＝由已核实事实推导（闭源产品的第三方工作代码与插件类型定义一律不高于此级）；**【未验证】**＝社区孤证或未能回查
- 衔接：本报告 Q5 的裁决与 `docs/research-pdf-annotation-alignment.md`（PDF 文字图层对齐调研，主推荐 A+C、暂缓 B）直接衔接

> **一句话结论：六家产品在"文档身份、锚定、迁移"三件事上各自只做对了一部分，Reade 现有的 TextQuote 优先 + rects 兜底路线在六家对照下站得住甚至领先；真正的短板不在锚定而在存储层——批注寄生在"版本不匹配即删库"的缓存 SQLite 里、无 schema 版本化、无墓碑、文档身份是单点路径键。v2 提案的核心是把批注迁入独立可迁移的用户数据库，并补上内容指纹重绑链、软删除与失锚修复 UX。**

---

## 1. 调研方法

1. **并行调研**：六个条目由六个并行代理独立完成，统一按 Q1-Q7 七个研究问题 × 固定九节模板产出 profile；开源产品（Calibre 9.13.0 @`4597980`、Zotero 三仓库 @`fdec9691`/`ba173e79`/`03830733`、KOReader @`941f64c`、Hypothesis client/h @`b4d085a2`/`24395ca4`）全部浅克隆逐行核实源码；Readwise 以官方 API 文档 + 官方开源 Obsidian 插件为一手来源；MarginNote（闭源）以官方文档/FAQ 为【已核实】上限，OhMyMN 插件类型定义与第三方解析工具为【推断】级证据。
2. **交叉核验**：独立核验代理抽查 40+ 条高风险论断（DDL 逐字比对、整数映射、阈值数字、行号引用、两组跨 profile 一致性），结果：仅 3 处表述级修正（Calibre 版本号消歧、Zotero eraser 行号、Hypothesis 早停分支补全），**无一处实质事实错误**；证据分级纪律全文合格，无越级标注。
3. **完整材料**：六份 profile 与核验报告位于 `C:\Users\viper\AppData\Local\Temp\reade-annotation-research\`（`profiles\*.md`、`verification.md`）。该目录属临时产物，可能被清理；**本报告自包含**，所有被引用的 schema 片段、字段清单与阈值均已写入正文。

### 1.1 Reade 现状基线（对照锚点，全部【已核实】于本仓库源码）

- **类型**（`src/lib/backend.ts` L96-154）：`Annotation { id, relativePath, kind: highlight|underline|bookmark, color: 4色|null, note, selectedText, title, locator, createdAt, updatedAt }`；locator 四种——markdown `{quote,prefix,suffix,headingId}`、pdf `{page, view:"original"|"reading", quote,prefix,suffix, rects[0,1]归一化}`、epub `{chapterId, blockIndex, startOffset, endOffset, quote,prefix,suffix}`、bookmark `{target}`（target 内含 `scrollRatio`/`offsetRatio` 派生值）。
- **锚定**（`src/lib/annotations.ts`）：TextQuote = quote + 前后各 32 字符（`TEXT_QUOTE_CONTEXT`，L12）；`findTextQuote`（L73-110）精确 `indexOf` + 宽松前后缀 + 严格匹配优先 + `hintStart` 就近消歧，无 fuzzy；`paintTextQuoteMarks` 返回 broken ids（L342-369）；PDF 回放 `resolvePdfHighlightRects`（L520-542）quote 优先、存储 rects 兜底（即 PDF 对齐调研方案 C，已在代码中）。
- **桌面存储**（`src-tauri/src/library.rs`）：`annotations` 表（L1205-1219）——`id TEXT PRIMARY KEY, library_root, relative_path, kind, color, note, selected_text, title, locator_json, created_at, updated_at` + `(library_root, relative_path, updated_at DESC)` 索引；入库前 sanitize（id ≤64 字符 `[A-Za-z0-9_-]`、note ≤4000、title ≤200、selectedText ≤2000、rects ≤64）；删除为物理 DELETE（L744、L769）。
- **要害**：该表建在**文档缓存库**里，`CACHE_SCHEMA_VERSION = 1`（L29），`open_cache_connection`（L1103-1118）在 `user_version` 或 `auto_vacuum` 不匹配时**直接删除整个数据库文件重建**——缓存（可再生）与批注（不可再生）目前共享同一份"随时可抛弃"的生命周期。
- **Web 存储**（`src/lib/webAnnotations.ts`）：IndexedDB `reade-annotations` v1，store `annotations`（keyPath `id`，index `relativePath`），物理删除。
- **尚无**：schema 迁移链、墓碑、导出、同步、失锚修复 UX；撤销是内存栈（`useDocumentAnnotations.ts`，MAX_UNDO=20），重启即失。

---

## 2. 逐产品精要

### 2.1 Calibre —— "三处冗余防丢 + CFI 权威锚"的老牌桌面派

定位：桌面电子书管理器，批注体系随 calibre 5.0（2020）引入。源码级证据（commit `4597980`，v9.13.0）。

- **文档身份是三套并行**【已核实】：库内 `(book_id, format)`（viewer 靠目录名尾部 ` (123)` 数字反推库身份）；库外 sidecar 键 = `sha256(文件绝对路径)`；EPUB/KEPUB 另把批注 JSON 写回书内 `META-INF/calibre_bookmarks.txt`。打开书时三处全读、按 uuid/newest-wins 合并。作者 Kovid Goyal 在 Launchpad #1994917 **明确拒绝内容哈希键**："exceedingly bad idea: 1) It's very slow 2) contents of a file can be changed very easily"——立场是"多处冗余 + 打开时合并"而非单一强身份【已核实】。
- **锚定 = 纯 EPUB CFI，无文本兜底**【已核实】：高亮存 `start_cfi`/`end_cfi`（spine item 内部片段）+ `spine_name`+`spine_index`；编码时尽量加 `[id]` assertion（结构小改可自愈），解码时 id 优先于数字索引；spine_name 命中则覆盖旧索引（章节重排自愈）。**text assertion 至今是 `# TODO`**（`cfi.pyj` L394）；`highlighted_text` 只用于展示/搜索/导出，不参与再锚定。失配即静默不渲染。
- **存储 = JSON blob + 索引投影列 + 双 FTS**【已核实】（`schema_upgrades.py` L721-814，DDL 节选）：

```sql
CREATE TABLE annotations ( id INTEGER PRIMARY KEY,
    book INTEGER NOT NULL, format TEXT NOT NULL COLLATE NOCASE,
    user_type TEXT NOT NULL, user TEXT NOT NULL,
    timestamp REAL NOT NULL, annot_id TEXT NOT NULL,
    annot_type TEXT NOT NULL, annot_data TEXT NOT NULL,
    searchable_text TEXT NOT NULL DEFAULT "",
    UNIQUE(book, user_type, user, format, annot_type, annot_id));
-- 另有 unicode61 与 porter 词干两张 FTS5 external-content 表，由触发器同步
```

  `annot_data` 是权威 JSON，其余列都是它的索引化投影；写路径为整批替换（先按 `(book, format, user_type, user)` DELETE 再批量 INSERT）。`annot_id`：highlight 用 `uuid`，**bookmark 用 `title`（重名即互吞，实锤的坑）**。`searchable_text = highlighted_text + '\x1f' + notes`（NFKC 规范化）。highlight 的 `annot_data` 实录（viewer 创建处原样字段，`annotations.pyj` L264-282）【已核实】：

```json
{ "type": "highlight", "timestamp": "2026-08-12T10:00:00.000Z",
  "uuid": "Ffhc1TqYtvzmC5cEEP5Hz", "highlighted_text": "selected text ...",
  "start_cfi": "/2/4/2/1:5", "end_cfi": "/2/4/2/1:25",
  "style": {"kind": "color", "type": "builtin", "which": "yellow"},
  "spine_name": "index_split_003.html", "spine_index": 3,
  "notes": "（可选）", "toc_family_titles": ["Part I", "Chapter 2"] }
```

  另有第四处容灾：每本书目录的 `metadata.opf` 为每条批注写一个 `calibre:annotation` meta（完整 JSON），库损坏时 "Restore database" 可从 OPF 整体重建批注【已核实】。
- **迁移 = `PRAGMA user_version` + `upgrade_version_N` 方法链**【已核实】：构造时循环"读 user_version=N → 执行 `upgrade_version_N` → 写 N+1"，整链跑在一个 `BEGIN EXCLUSIVE TRANSACTION` 里，任一步异常整体 ROLLBACK 并拒绝打开库，没有部分升级状态；批注表由 `upgrade_version_23` 创建（即自库版本 24 起存在），当前最新库 `user_version=27`。独立 viewer 直连库文件写批注前做**特性检测** `pragma user_version > 23`，不满足就静默放弃入库（sidecar/书内照写）——外部写入者按版本探测能力而非硬编码假设【已核实】。`annot_data` JSON 内部无 schema version 字段，结构演进靠读取端宽容（`.get()` + 坏行跳过）。
- **删除 = 最小墓碑**【已核实】：DB 端不删行，把 `annot_data` 替换为 `{removed: true, timestamp, uuid}` 骨架、`searchable_text` 清空；官方 docstring 明言 "Removed annotations are just a skeleton used for merging of annotations"。**无墓碑 GC**（全 db 目录无清理路径）。冲突解决 = 按 uuid/title 分组、墙钟 timestamp newest-wins，无向量时钟/设备 ID，并发编辑丢一方；DB 端与 viewer 端各有一份要求同步修改的相同合并算法【已核实】。
- **多端同步已是现实**【已核实】：桌面 viewer 保存时与库中列表 merge 后整批重写；浏览器阅读器走 content server REST 端点 + 本地 IndexedDB 离线合并（`user_type='web'` 按用户隔离）；设备方向只有 Kindle/Kobo 批注单向抓回（渲染成 HTML 塞进书籍 comments 元数据，**不进 annotations 表**）。
- **失锚 UX 反面教材**【已核实】：渲染静默跳过（`if not r: continue`）；列表仍显示失锚项；用户点到时才弹 "Highlight text missing…This can happen if the book was modified. This highlight will be automatically removed."，笔记复制到剪贴板后打墓碑删除。无修复/重锚工具。可取的两点：文案解释原因、删除前兜底保住笔记。
- **导出只出不进**【已核实】：txt/MD/HTML/`{"version":1,"type":"calibre_annotation_collection","annotations":[...]}` JSON 信封（导出文件才有版本号），全仓库无导入端；MD/HTML 导出含 `calibre://view-book/...?open_at=` 深链。

### 2.2 Zotero —— "身份与路径彻底解耦 + 最完整迁移工程"的文献管理派

定位：文献管理器，批注挂在 attachment 下、由自家 reader 创建。源码级证据（zotero/reader/pdf-worker 三仓库）。

- **文档身份 = 稳定 item key，路径只是属性**【已核实】：批注是独立 item 类型，`itemAnnotations.parentItemID` 外键指向 attachment item；**表中无任何路径/文件名/hash 字段**，改名、移动、relink 均不影响批注。前提是文件由 Zotero 托管（导入即复制进自己的存储目录）——Reade 不托管文件，无此前提【已核实 + 推断】。
- **锚定 = 纯几何（PDF）/ CFI（EPUB），无 quote 锚、无自愈**【已核实】：PDF `position = {pageIndex, rects[[x1,y1,x2,y2]]}`，**PDF 点坐标、原点左下、非归一化**；EPUB（Zotero 7）用 EpubCFI 包装成 W3C FragmentSelector；快照用 CssSelector+refinedBy TextPositionSelector。定义了 TextQuoteSelector 类型但从不产出。失锚即静默不渲染，但 **"Don't discard a position we can't resolve"**——原始 position 永不清洗，文档复原即自动复活【已核实】。外部工具改页会错位，官方靠文档警告规避。
- **存储 DDL**【已核实，`userdata.sql` L228-245 逐字核对】：

```sql
CREATE TABLE itemAnnotations (
    itemID INTEGER PRIMARY KEY, parentItemID INT NOT NULL,
    type INTEGER NOT NULL,          -- 1=highlight 2=note 3=image 4=ink 5=underline 6=text
    authorName TEXT, text TEXT, textNormalized TEXT,
    comment TEXT, commentNormalized TEXT, color TEXT, pageLabel TEXT,
    sortIndex TEXT NOT NULL,        -- 预计算排序键：PDF="页(5位)|字符偏移(6位)|自页顶Y(5位)"
    position TEXT NOT NULL,         -- JSON，上限 65,000 字符，超限自动拆成多条批注
    isExternal INT NOT NULL, ...);
```

  `position` JSON 三种实录【已核实】：PDF 高亮 `{"pageIndex":9,"rects":[[56.801,318.335,279.517,330.556],[45.401,306.334,260.498,318.556]]}`（每行一个 rect，劣质 OCR 下可能每字符一个）；EPUB `{"type":"FragmentSelector","conformsTo":"http://www.idpf.org/epub/linking/cfi/epub-cfi.html","value":"epubcfi(/6/8!/4/2/12/2,/5:91,/5:99)"}`；快照 CssSelector + `refinedBy: {type:"TextPositionSelector", start, end}`。`text` = 选中原文（用户可改以修正 OCR）、`comment` = 笔记，`*Normalized` 列为搜索归一化副本由后台回填；image/ink 的外观图不入库（缓存 PNG 可重建）。Web API v3 无独立批注端点，批注按 item 处理（`annotationType/annotationText/annotationComment/annotationColor/annotationPosition/parentItem/key/version` 与 DB 列一一对应）。
- **迁移机制是六家最完整**【已核实】：`version(schema, version)` 表按域存版本（userdata 当前 129，目标版本取自 SQL 文件首行注释 `-- 129`）；`_migrateUserDataSchema` 单事务内 `for i = from+1..to` 顺序执行整数步骤；**compatibility 棘轮**（`_maxCompatibility` + version 表 compatibility 域，DB 兼容版本高于代码支持值即硬报错拒开，防旧版静默损坏新库）；**升级前强制整库备份**（`backUpDatabase({force:true})`，并记录目标版本防重复尝试轮掉好备份）；"步骤 N 未生效则在 N+1 重放"的防御模式（步骤 119 加 `authorName` 列、120 检查列存在性后重放，防上次半途失败）。批注相关步骤：112 建表（Zotero 6）、113 重建修外键并把孤儿批注写入 syncDeleteLog、126 加 normalized 列。
- **PDF 导出/导入完整可用**【已核实】：`rectsToQuads` 把 `[x1,y1,x2,y2]` 展开为 `(x1,y2, x2,y2, x1,y1, x2,y1)` 即 **Z 序（TL,TR,BL,BR）**QuadPoints，无损直映射（前提：position 本来就是 PDF 点坐标）；写 `/AP` 外观流保证第三方可见；写 `/NM "Zotero-<key>"`、`/Zotero:Key` 等私有键保证往返身份，读回时先取私有键再取 NM 前缀。导入任意来源的 Highlight/Underline/Text；Square/Ink/FreeText 仅认 Zotero 自产。导入的注释标 `isExternal=1`（只读 + 锁图标 + **永不同步**，同步 SQL 显式排除）；"Import Annotations…"（transfer）转正时**从 PDF 删除原注释**防双份漂移。早期 "Store Annotations in File" 因文件冲突丢数据被官方移除；官方 KB 明言存 DB 的首要动机就是**避免文件级不可合并冲突**——"每次改动要传整个 PDF 且两端同时批注会产生不可合并的文件冲突；存 DB 则单条批注即同步单元"【已核实】。
- **删除与同步**【已核实】：回收站（`deletedItems(itemID, dateDeleted)`）+ 同步墓碑（`syncDeleteLog(type, library, key)` UNIQUE）两级；整库单调 `Last-Modified-Version` 协议 + 增量 `?since=` + 服务器端 `/deleted?since=` 墓碑下发 + 写请求带 `If-Unmodified-Since-Version`、412 即重启同步循环；冲突用 pristine JSON 三方合并（每次成功上/下行缓存版本绑定的 pristine），自动合并不相交字段，**仅同一字段两侧都改才弹人工对话框**；"远端删除 vs 本地修改"进冲突流程，远端胜出时移出 delete log。position 超 65k 上传报错时客户端自动拆分重试。
- **失锚 UX 空白**【已核实】：无 broken 标记、无修复 UI，锚解析失败仅 console.error、正文不渲染；侧边栏仍显示（数据不丢但用户无从知晓为何点不过去）【推断-高置信】。PDF 几何锚"永远能渲染"——文件被外部改页时批注渲染在错误位置而非失锚，官方在 Zotero 内做删页/旋转时会同步修正全部批注 position。

### 2.3 KOReader —— "sidecar 内容寻址 + 无版本号迁移"的本地文件派（与 Reade 哲学最近）

定位：开源电子墨水阅读器，批注存书旁 sidecar，本地优先、不托管文件。源码级证据（@`941f64c`）。

- **文档身份 = sidecar 寻址方式，三模式**【已核实】（`docsettings.lua` L101-146）：`doc`（书旁 `.sdr/metadata.<格式>.lua`，改名即失联，有真实丢批注事故 issue #11773）/ `dir`（中央目录镜像绝对路径）/ **`hash`（partial MD5 内容寻址）**。partial MD5 = 在偏移 `lshift(1024, 2*i)`（i=-1..10，即 0、1KiB、4KiB…1GiB 指数间隔）各采样 1 KiB 拼接算 MD5，**≤12 KiB I/O 大文件瞬间完成**（`util.lua` L1094-1111）。hash 模式下 KOReader 之外改名/移动/复制均不丢；**代价：文件内容一变身份即变**，写高亮进 PDF、calibre 重转换都会让全部批注无声脱钩【已核实】。即使 doc 模式，`partial_md5_checksum` 也随 metadata 持久化，事后可用于找回；删除书籍可把 metadata 按内容哈希存档，重新获得同一文件即恢复【已核实】。
- **锚定 = 纯结构锚，无文本兜底**【已核实】：EPUB 用 crengine XPointer（实录 `pos0 = "/body/DocFragment[17]/body/p[3]/text().287"`），PDF 用页码 + `{page,x,y,zoom,rotation}` + `pboxes` 页坐标矩形；`text` 仅展示/导出。页码 `pageno` 是**派生值**，重排版只重算派生值不动锚（`updatePageNumbers`）——锚与显示值分离是其做对的一点。引擎侧防御是"冻结 DOM 解析规则"（`cre_dom_version`）而非修复锚。
- **schema = 可执行 Lua 表（`return {...}` 形式 `dofile` 读取），datetime 字符串兼作唯一 ID，无 UUID**【已核实】：sidecar 内 `annotations` 数组按书内位置升序持久化（二分插入），条目样例（PR #11563 附件实录节选）：

```lua
[1] = { ["chapter"] = "Objectives of Chord-Scale Theory",
        ["datetime"] = "2024-03-31 19:11:05",   -- 不可变，兼作唯一 ID
        ["drawer"] = "lighten",                  -- 有无 drawer 即"高亮 vs 书签"判别，无 kind 字段
        ["page"] = "/body/DocFragment[17]/body/p[3]/text().287",
        ["pos0"] = "/body/DocFragment[17]/body/p[3]/text().287",
        ["pos1"] = "/body/DocFragment[17]/body/p[3]/text().345",
        ["pageno"] = 213,                        -- 派生值，重排版重算
        ["text"] = "The terms ... interchangeably." },
```

  其余字段：`datetime_updated`、`color`（9 内建色名 + 自定义）、`note`（有 note 的高亮在 UI 归类为 "note"）、`text_edited`、`chapter`（冗余缓存）、`pageref`、`pboxes`（PDF 页坐标矩形）、`ext`（跨页）。旧格式（2024 前）的 `bm.notes → text`、`bm.text → note` **命名恰好交叉**，迁移代码逐条重映射【已核实】。
- **"无 schema 版本号"是显式决策，代价被源码实证**【已核实】：2024 年 highlights+bookmarks → 统一 `annotations` 数组的重构（PR #11563）中，评审提议 `version=20240318` 被作者拒绝——"annotations 键本身就是迁移旗标"（未来字段演进再加逐特性旗标）。结果：迁移代码靠 `type(bookmarks[1].page)` **形状嗅探**区分引擎格式（string=crengine、number=paging）、同一本书可被两种引擎打开还需 `annotations_paging/rolling` 备份键换轨、迁移代码承诺永久保留；旧 `bookmarks`/`highlight` 键不删作后备（承诺"测试期后删除"至今未删）。**迁移时无效 XPointer 静默丢弃**（仅 logger.warn），被自家评审人 Frenzie 痛批 "silently drops user data…I highly discourage"，讨论过弹窗最终仍未加任何 UI【已核实，PR #12494】。迁移是打开书时的惰性单向转换，无整库批处理工具。
- **唯一像样的失锚 UX 是 DOM 升级向导**【已核实】：逐指针预检统计 found/changed/lost → 明文告知丢失数 + 手动救援建议（切换渲染模式重试）→ 三选项确认 → 迁移前整份 metadata 备份 `.old_dom<版本>`；找不到的打 `not_found_not_migrated` 旗标但**无任何 UI 消费**。
- **同步**【已核实】：KOSync 只同步阅读进度（api.json 实证），不同步批注；官方批注同步 = `.annotations.lua` 文件交换（`device_id` + 导出时刻 + 全量数组），位置匹配 + 时间戳新者胜；**删除用"缺席 + 文件级时间戳"表达，无逐条墓碑**——文件丢失/时钟偏差会复活或误删条目，第三方插件（AnnotationSync、gdrive.koplugin）被迫自补 3-way merge【已核实 + README 自述】。
- **导出**【已核实】：exporter 插件 9 目标（json/markdown/html/text/my_clippings/joplin/readwise/nextcloud/xmnote）；导出到 Readwise 时 `location=页码, location_type="order"`——**位置精度坍缩为页码序，锚不出境**。PDF 双向互操作（写高亮进 PDF / 导入内嵌注释），但写入改变内容哈希、与 hash 模式互斥【已核实 + 推断】。

### 2.4 Hypothesis + W3C —— "多 selector 冗余 + fuzzy 兜底"的标准派基线

定位：Web 批注服务，W3C Web Annotation 模型的最大实现；Reade 的 TextQuote 本质是其 TextQuoteSelector 的简化版。源码 + 规范原文证据。

- **多 selector 冗余是 W3C 规范正文明确推荐**【已核实】：规范 §4.2 原文 "Multiple Selectors can be given…to maximize the chances that it will be discoverable later"；消费方 MUST 择一。规范 selector 家族：FragmentSelector / CssSelector / XPathSelector / **TextQuoteSelector**（exact + prefix/suffix，多处命中时规范说 SHOULD 视为全部命中——与 Hypothesis/Reade 的"选一个"都不同）/ **TextPositionSelector**（code point 偏移）/ RangeSelector / `refinedBy` 链式细化。注意 Hypothesis 的 RangeSelector（XPath 字符串）是 Annotator.js 时代方言，不是 W3C RangeSelector【已核实】。
- **锚定降级链，quote 是最终裁判**【已核实】（client `html.ts` L36-113）：RangeSelector（XPath）→ TextPositionSelector → TextQuoteSelector，**前两级结果必须通过 `quote.exact` 校验否则抛弃**；position.start 顺手当第 3 级的 hint。quote 匹配内部再分两级（`match-quote.ts`）：先精确 `indexOf` 收集所有命中；无命中才用 `approx-string-match` 库（Myers 1999 位并行）fuzzy，**错误预算 `maxErrors = min(256, quote.length/2)`**；候选打分权重 quote:prefix:suffix:位置 = 50:20:20:2，**只用于排序、无最低分数线**（docstring 与实现不一致，以实现为准）【已核实】。
- **PDF 锚定**【已核实】：无 RangeSelector，存 `[TextPositionSelector(全文档偏移), TextQuoteSelector, PageSelector]`；**比较前把 quote/prefix/suffix/页文本全部去空白**（PDF.js 各版本文本层空白差异是失配大头），再把偏移映射回原文本；页面未渲染时锚到占位符、滚入后重锚。TextQuote 上下文 **32 字符，与 Reade 完全相同**（`types.ts` L199）。
- **文档身份两层**【已核实】：URL 规范化（scheme→httpx、去 fragment、排序查询参数、剔除 utm/gclid 等追踪参数）+ `document_uri` 等价声明表（self-claim / rel-canonical / DOI / `urn:x-pdf:<fingerprint>`）；**本地 PDF 只靠 fingerprint URN 做身份**——"同一 PDF 两台机器互看注释"即由此实现。
- **存储的关键设计**【已核实】：Postgres 关系列管硬字段（id/created/updated/userid/text/tags[]/shared/deleted/document_id 等）+ **`target_selectors` 不透明 JSONB**（服务端不解释，仅 quote property 从中读 exact）+ `extra` JSONB 扩展逃生舱（客户端任意数据，API 返回时展开到顶层）。selector 数组实录形态：

```json
"selector": [
  { "type": "RangeSelector", "startContainer": "/div[1]/p[3]", "startOffset": 12,
    "endContainer": "/div[1]/p[3]", "endOffset": 47 },
  { "type": "TextPositionSelector", "start": 1024, "end": 1059 },
  { "type": "TextQuoteSelector", "exact": "被选中的文本",
    "prefix": "之前最多32字符", "suffix": "之后最多32字符" } ]
```

  **新增 selector 类型（EPUBContentSelector、PageSelector、ShapeSelector、MediaTimeSelector 都是后加的）零迁移**；锚定链对缺失字段容忍（switch 忽略不认识的类型，旧注释缺新 selector 不影响）。硬字段演进走 alembic（现存 176 个迁移）。客户端本地状态字段以 `$` 前缀隔离不入库（`$orphan/$anchorTimeout` 等）。
- **删除 = 软删除 + 延迟物理清除**【已核实】：`deleted=True` + 刷新 updated → Celery 定时任务清除"标记删除且 updated 距今超 10 分钟"的行、每批 ≤1000；缓冲期注释原文"给 streamer 时间处理删除"——**任何有事件消费者的系统都需要墓碑存活窗口**。编辑就地更新，无修订历史。
- **失锚 UX = Orphans 标签页**【已核实】：orphan 判定 = 所有 target"有 selector 但都解析失败"；`$orphan` 是**客户端字段不落库**，每次锚定重算（500ms 超时只影响等待 UI 不判死）；"Unanchored" 标签仅 count>0 时出现；quote 删除线展示，编辑/回复/删除功能完整保留——**数据不丢，只失去文内定位**；没有手动重锚功能，策略是"fuzzy 尽力自愈 + 诚实展示"。
- **EPUB CFI 现状**【已核实】：断言机制（文本断言 + ID 断言 + §3.5 位置修正）设计精巧，但业界采用不一致——Readium 自述回避 CFI 多年、EPUB 3.1 撤销强制超链接支持；**Hypothesis 只拿 CFI 当章节 ID**（比较前剥断言），章内仍用 quote/position。"CFI 作为精确锚已被主流实践弃用"是六家证据合流的结论。
- **PDF QuadPoints 要点**【已核实-二手收敛】：默认用户空间 pt、原点左下、y 向上；规范字面要求逆时针序，但 **Acrobat 事实标准是 Z 序（TL,TR,BL,BR），导出应写 Z 序**（pdf.js 专门做过顺序归一化；Zotero `rectsToQuads` 实际写的正是 Z 序——两份独立证据互证）。

### 2.5 Readwise（含 Kindle 案例）—— 聚合器视角的交换 schema 与去重工程

定位：批注聚合 SaaS，不产生阅读位置、只收纳各家高亮；其 Export API 是事实上的行业交换 schema。官方文档 + 官方开源插件证据。

- **文档身份 = (title, author) 字符串对，无强 ID**【已核实】：CREATE 按 title/author 聚合进 book；Reader v3 用 URL 精确匹配。真实事故链【已核实】：tracking 参数产生重复文档（官方承认并补 URL 规范化）；Kobo 导入曾"堆出上千条重复高亮"，修复方式是**改用 Kobo 自己的稳定注释 ID**；在下游改元数据/重命名文件都会造成重复。教训指向一致：**内容/字符串匹配终会翻车，救场的都是来源侧稳定 ID**。
- **锚定 = 单整数 + 类型标签的粗锚**【已核实】：`location: integer`，官方定义 **"Used to order the highlights"**——用途是排序不是重定位；`location_type ∈ page/location/none/order/offset/time_offset`（默认 order）。聚合器不持有正文，存精确锚也无法重放【推断】。
- **Kindle My Clippings.txt 反面教材**【已核实格式 +【未验证·社区共识】location 定义】：条目 = `Title (Author)` 行 + `- Your Highlight on page X | location Y-Z | Added on <日期>` + 正文 + `==========`；location 社区共识为"源文件 128 字节块序号"（Amazon 无官方定义）——**字节偏移锚，换版本/重排即全废**；append-only 日志无法表达编辑与删除；多语言格式无规范，Readwise changelog 记录了俄语措辞更换、罗马数字页码崩溃等长期修补。
- **去重与 upsert 分离**【已核实，重抓 api_deets 逐字确认】：CREATE 去重键 = **title/author/text/source_url 四元组完全相同（含 null）→ no-op**；设置过 `highlight_url` 的高亮，同 URL 新文本 = 更新而非新建。CSV 重导入曾把已删文档也算进重复而拒导，后修复为**去重集合忽略墓碑**（允许用户有意复活）【已核实】。Kindle 扩选高亮（旧短条 + 新长条并存于 append-only 日志）官方只承诺"检测并跳过重复"、算法未公开；社区参考实现 kindle-tools-ts 的判据是 **location 差 ≤5 且内容为子串或词 Jaccard >50% → 判为扩选，合并保留最长文本**【第三方推断·参考实现】——Reade 导入去重可借鉴该阈值思路。
- **CREATE 请求字段（v2，全部【已核实】自 api_deets，2026-08-12 重抓）**：`text`（唯一必填，≤8191）、`title`（≤511）、`author`（≤1024）、`source_url`（≤2047）、`source_type`（应用标识 3-64 字符）、`category`（books/articles/tweets/podcasts）、`note`（≤8191，支持 inline tag）、`location`（int）、`location_type`、`highlighted_at`（ISO 8601）、`highlight_url`（upsert 键，≤4095）。UPDATE 仅可改 `text/note/location/url/color`；color 枚举 `yellow/blue/pink/orange/green/purple`。
- **Export API 对象（v2，事实交换 schema）**【已核实】：book 级 `user_book_id/is_deleted/title/author/readable_title/source/cover_image_url/unique_url/book_tags[]/category/document_note/summary/readwise_url/source_url/external_id(仅 reader)/asin/highlights[]`；highlight 级 `id/is_deleted/text/location/location_type/note/color/highlighted_at/created_at/updated_at/external_id/end_location(实测恒 null)/url/book_id/tags[]/is_favorite/is_discard/readwise_url`。增量同步 = 首次全量分页 + `updatedAfter`；**`includeDeleted=true` 返回墓碑，官方注明 "Use it to synchronize deletions to your app"**。Reader v3 把两层结构归一为带 `parent_id` 的 Document 树（高亮即子文档）。
- **"僵尸高亮"论证**【已核实】：官方明文解释为什么不提供永久硬删——硬删后源里还在，下次同步"deleted highlight 会像僵尸一样复活"（"return from the dead like a frustrating zombie highlight"），因此 discard 在后端留副本用于对比。**这是"删除必须留墓碑"的最直白产品论证**。删除默认不双向传播；唯一例外是 Kindle 全量刷新。
- **导出一致性 = append-only + hash 合并**【已核实，官方插件源码】：所有笔记类导出目标都是 append-only（Readwise 侧的编辑不回传已导出内容）；官方 Obsidian 插件的实现——本地文件 MD5 == 服务端 `last_content_hash` → 整文件覆写 `full_content`；不等（用户改过）→ 只追加 `append_only_content`；删除文件触发 refresh 队列重导。CSV 导出列：`Highlight, Book Title, Book Author, Amazon Book ID, Note, Color, Tags, Location Type, Location, Highlighted at, Document tags`【已核实-第三方两处独立实录】；CSV 导入列：`Highlight(必填)/Title/Author/URL/Note/Location(整数)/Date`。
- **Reader 的失锚消解术**【已核实】：文档保存即冻结快照，"宁不更新也不失锚"——更新文章的唯一方式是删除重存（连带清空批注）。锚失效时高亮退化为仍完整可读的卡片（Daily Review 卡片消费完全不需要原文位置），是聚合器给"失锚降级"提供的心智模型。

### 2.6 MarginNote —— "纯几何锚 + 卡片轴心"的重学习流派（闭源，schema 结论均为【推断】）

定位：iOS/macOS 深度学习工具，摘录-脑图-闪卡一体。官方文档为【已核实】上限；Z 表结构与字段全部来自第三方 DDL 导出与 OhMyMN 插件类型定义，**一律【推断】**。

- **文档身份 = MD5 内容哈希**【推断，OhMyMN `docMd5`/`getDocumentById(md5)` + 第三方 DDL】：`ZBOOK` 有 `ZMD5/ZMD5LONG` 两列，`ZBOOKNOTE.ZBOOKMD5`（长）与 `ZBOOK.ZMD5`（短）前缀匹配。改名免疫、**内容一变全体失联**。官方兜底【已核实，MN3 FAQ】：导入**同文件名+同分辨率+同尺寸+同页数**的新文档可**自动重关联**；不满足则手动重绑。
- **锚定 = 纯几何 + 文本快照**【推断 + 官方印证】：`ZSTARTPAGE/ZENDPAGE` + `ZSTARTPOS/ZENDPOS`（"x,y" 字符串，坐标系未查明）+ 图片摘录 `selLst[{pageNo, rect, rotation}]`；`ZHIGHLIGHT_TEXT` 只是内容快照不参与重定位——官方 FAQ 明说版面变化即错位，建议用户**去外部 PDF 编辑器改文件迁就旧坐标**【已核实】。OCR（ABBYY 合成文字层 / MN4.2.1 AI OCR）结果存独立列，锚仍是几何。
- **存储 = Core Data SQLite（~30 列 ZBOOKNOTE"卡片轴心"）+ ZIP 备份**【推断，来源为第三方对生产库的 DDL 导出】：主库 `MN4NotebookDatabase/0/MarginNotes.sqlite`，核心表——`ZBOOK`（文档：`ZMD5/ZMD5LONG/ZPATH/ZFILE/ZLASTVISIT...`）、`ZTOPIC`（学习集：`ZTOPICID/ZTITLE/ZBOOKLIST(竖线分隔文档MD5)/ZSYNCDIRTY/ZDELNOTES(BLOB)...`）、`ZBOOKNOTE`（摘录/脑图节点/闪卡同一实体，官方称"卡片轴心"【已核实】——身份关联 `ZNOTEID/ZTOPICID/ZBOOKMD5/ZGROUPNOTEID`，锚定 `ZSTARTPAGE/ZENDPAGE/ZSTARTPOS/ZENDPOS`，内容 `ZHIGHLIGHT_TEXT/ZNOTES(BLOB,bplist00)/ZHIGHLIGHTS(BLOB)/ZRECOGNIZE_TEXT`，脑图 `ZMINDLINKS/ZMINDPOS/ZTYPE`，同步 `ZUSNFTS/ZUSNPROPERTIES`）、`ZMEDIA`（媒体按 MD5 内容寻址去重）、`ZBOOKNOTESYNC`（同步影子表）、`ZEPUBRANGE`（EPUB 按"字体+视口"缓存分页 range）。`.marginpkg` = ZIP 内含 `MarginNotes.sqlite`【推断，第三方工作代码直接 `zipfile.extractall` 后读取】；整库导出 `.marginbackupall` 三种粒度【已核实】。
- **版本化直到 4.3 才补课**【已核实，官方 sync-backup 页】：此前主库只有 Core Data 隐式版本；4.3 引入 **SHA-256 内容寻址对象池（loose objects + pack files）+ Manifest 快照（versionNumber + deviceId + 依赖图）+ `BackupSnapshots_v4.sqlite (schema v6)`**，官方自认不是跨库全局 ACID 事务。MN3→MN4 迁移 = 整库备份导出导入（替换/新增数据库/合并三模式）【已核实】；社区有导入无响应、卡片重复十几份的失败案例【未验证孤证】，无成功率量化数据。
- **同步失败模式官方自曝**【已核实】：CloudKit 记录级同步（CKRecord = Topic/BookNote），学习集被 `resultsLimit` 拆 batch，半失败呈现为"脑图损坏"；另有跨学习集删除传播疑似 bug 的孤证【未验证】。删除进回收站可恢复【已核实】。
- **失锚 UX 是六家唯一的正面模板**【已核实】：文档缺失时卡片**完整保留**（文档/笔记双图层分离）；官方提供**"找回失联笔记"集中列表 + 逐条手动重绑 + 条件满足自动重关联**的完整流程；但重绑后不做内容级重对齐（没有 quote 可验证——Reade 有）。
- **附带观察：图层/过滤功能制造"疑似丢数据"**【已核实，官方支持标准答复模式】：官方论坛大量"批注消失"求助实为手写图层/文档图层切换导致的可见性误解——对 Reade 的含义：任何隐藏批注的视图状态（过滤、分组折叠）都要有显式可见的入口指示，否则会转化为支持负担。

---

## 3. Q1-Q7 横向对比矩阵

| 问题 | Calibre | Zotero | KOReader | Hypothesis/W3C | Readwise | MarginNote |
|---|---|---|---|---|---|---|
| **Q1 文档身份** | (book_id,fmt) + sha256(路径) + 书内嵌入，三处冗余合并；拒绝内容哈希 | 稳定 item key，路径只是属性；前提=托管文件 | sidecar 寻址三模式；**partial MD5 内容寻址**（≤12KiB） | URL 规范化 + 等价声明表 + PDF fingerprint | (title,author) 字符串对；事故后转向来源稳定 ID | MD5 内容哈希【推断】+ 文件名/版面启发式重关联 |
| **Q2 锚定** | 纯 CFI + id assertion，无文本兜底 | 纯几何(PDF)/CFI(EPUB)，永不丢弃 position | 纯结构锚(XPointer/页坐标)，锚与派生值分离 | **多 selector 冗余 + quote 终裁 + fuzzy 兜底** | 单整数排序锚；Kindle=字节偏移反面教材 | 纯几何 + 文本快照【推断】 |
| **Q3 schema** | JSON blob + 投影列 + 双 FTS5 | 硬列 + position JSON(≤65k 自动拆) + sortIndex | Lua 表；datetime 兼作 ID；drawer 有无判类型 | 关系列 + 不透明 JSONB selectors + extra 逃生舱 | 扁平记录 + 全字段长度上限 | Core Data ~30 列卡片轴心【推断】 |
| **Q4 版本化迁移** | user_version + 单事务方法链 + 特性检测 | **版本表 + 整数步骤 + 棘轮 + 强制备份 + 步骤重放** | 显式拒绝版本号→形状嗅探，迁移代码永久保留 | JSONB 零迁移 + alembic 管硬字段 | v2/v3 并行 + 前缀命名空间 | 隐式 Core Data，4.3 才补 Manifest 版本 |
| **Q5 导出互操作** | 只出不进；OPF 容灾备份 | **QuadPoints 双向 + /AP + 私有键往返身份** | 9 目标；Readwise 出口精度坍缩为页码 | W3C selector 公分母；QuadPoints Z 序告诫 | Export API + includeDeleted + CSV 双向 | ZIP+SQLite 备份；Anki 字段映射 |
| **Q6 删除同步** | 最小墓碑 + newest-wins；无 GC | 回收站 + syncDeleteLog + 版本协议 + 三方合并 | **无墓碑**（缺席+时间戳），第三方被迫 3-way | 软删 + 10 分钟延迟分批 purge | 僵尸高亮论证；is_deleted 传播 | 回收站；CloudKit 半失败=脑图损坏 |
| **Q7 失锚 UX** | 静默 + 触碰即删（笔记进剪贴板） | 静默隐藏，position 永不丢弃 | 静默丢弃被自家评审痛批；升级向导是亮点 | **Orphans 标签页：删除线 + 全功能保留** | 卡片化降级，锚断就断 | **"找回失联笔记"集中重绑列表** |

---

## 4. 逐问题裁决

### Q1 文档身份：relativePath 保留为"当前位置"，新增内容指纹重绑链

**证据小结**：六家覆盖了全部候选路线，且每条路线的失败面都有实证——纯路径键失联（Calibre sidecar、KOReader doc 模式的真实事故）；纯内容哈希在内容可变时全体失联（KOReader hash 模式、MarginNote）；字符串匹配堆重复（Readwise）；稳定 ID 最干净但前提是托管文件（Zotero）。Calibre 作者拒绝内容哈希的理由（慢、内容易变）被 KOReader 的 partial MD5（≤12 KiB）**部分反驳**——"慢"已不成立，"内容易变"依然成立。

**裁决**：Reade 不托管文件、且 Markdown 是用户随手编辑的活文件，因此**既不能学 Zotero 换稳定 ID 主键（无托管前提），也不能学 MarginNote 拿内容哈希当主键（Markdown 内容易变）**。v2 采用"**relativePath 仍是批注外键 + 新增 `documents` 指纹映射表 + 三级重绑链**"：① 路径命中（现状）；② 路径失联但指纹命中（PDF/EPUB 用 KOReader 式 partial MD5，近似不可变资产适用；Markdown 用规范化正文哈希，仅作参考信号）→ 一次性提示"迁移批注到新路径？"；③ 都失败 → 进入手动重绑 UX（见 Q7）。KOReader 已证明"即使 doc 模式也随存内容哈希备用"的价值，Reade 照做：扫描时顺手计算指纹，成本可忽略。

**否决的替代**：Zotero 式 `docId` 外键重构——无托管前提，且要求改动全部查询链与两端存储，其用户可见收益（改名不丢批注）重绑链同样能给；若未来做多端同步，再作为 v3 候选升级。纯 content-hash 主键——对可变 Markdown 直接不成立（KOReader/MarginNote 双重实证）。

**影响面**：动 Rust（扫描时算指纹 + documents 表 + 重绑 command）+ 前端提示流程；Web 端静态 manifest 可在生成器侧输出指纹，量小。

### Q2 锚定模型：TextQuote 权威地位被六家证据背书，补三层增强

**证据小结**：六家里只有 Hypothesis 做文本优先锚定——而它恰是唯一面向"内容会变的文档"（网页）的产品，与 Reade 的 Markdown 场景同构。其余五家的结构/几何锚在"文档不变"前提下精确，一旦变化即失效且无自愈（Calibre text assertion 是 TODO、Zotero 官方警告别外部改页、KOReader 静默丢弃、MarginNote 让用户改 PDF 迁就坐标）。CFI 作为精确锚被 Readium 回避、EPUB 3.1 撤销强制支持、Hypothesis 只当章节 ID 用——衰落已成事实。W3C 规范正文明确推荐多 selector 冗余。

**裁决**：**quote+context 保持权威锚不动摇**；PDF rects、epub `blockIndex/startOffset/endOffset` 这类结构/几何字段定位为**hint 与渲染缓存，永远不做权威**（现有 `resolvePdfHighlightRects` 的 quote 优先已是正确实现）。按性价比排序补三层：
1. **持久化 position hint**：markdown/epub locator 增加可选 `start`/`end`（渲染文本偏移，即现有 `hintStart` 的持久化）。锚定顺序变为：position 直达并用 quote 校验 → 精确 quote（现状）→ broken。旧数据缺字段自然跳过第一级，**零迁移**——这是 Hypothesis "selector 缺失容忍"的直接移植。
2. **PDF 失配先吃空白差异**：比较前 stripSpaces + 偏移映射回原文（Hypothesis 实证这是 PDF 失配大头），成本远低于 fuzzy。
3. **fuzzy 作可选末级兜底**：参数直接采用 Hypothesis 实测值——`maxErrors = min(256, quote.length/2)`、打分权重 50:20:20:2 仅排序；fuzzy 命中在 UI 上弱提示"非精确定位"。
另按 KOReader 教训，bookmark target 里的 `scrollRatio`/`offsetRatio` 属派生显示值，重排版应可批量重算，不应被当作锚语义依赖。

**否决的替代**：fuzzy 默认开启——Hypothesis 自己的实现没有最低分数线（docstring 与实现不一致），误锚到错误位置的风险真实存在，Reade 先做成可选开关 + UI 弱提示。RangeSelector/XPath 式结构 selector 全家桶——对 react-markdown 每次渲染重建的 DOM 不稳定，position hint + quote 终裁已覆盖其收益。

**影响面**：纯前端（`annotations.ts` + locator 类型加可选字段）；fuzzy 需引入 `approx-string-match`（约 19KB、零依赖）。

### Q3 存储 schema：现有"类型列 + locator_json"形态正确，补投影列

**证据小结**：Calibre（JSON blob + 投影列 + FTS）与 Hypothesis（关系列 + 不透明 JSONB + extra）殊途同归：**权威数据放 JSON 保演进自由，查询/排序需求物化成列**。Zotero 的 `sortIndex NOT NULL` 预计算排序键与 position 65k 上限+自动拆分是字段级工程细节；KOReader 的 datetime-兼作-ID 与 drawer-有无判类型是反面教材（Reade 已用 UUID + 显式 kind，无此问题）。

**裁决**：桌面 `annotations` 表保持现形态，v2 增补：① `sort_index TEXT NOT NULL` 预计算排序键（统一 `段/页(5位)|字符偏移(6-8位)` 风格，三种格式可比），列表排序不再解析 locator JSON 或按时间凑合；② `searchable_text`（`selectedText + '\x1f' + note`，NFKC 规范化）+ FTS5 external-content 表 + 触发器同步——Reade 已有 FTS5 基础设施，成本低、批注全文检索免费到手；③ `deleted_at INTEGER NULL`（见 Q6）。locator JSON 对 Rust 保持宽容解析（serde 默认忽略未知字段，已满足"加可选字段零迁移"）；新增 locator **kind** 仍需两端同步，属 IPC 契约常规。Web IndexedDB 记录形状与桌面行保持同构。

**否决的替代**："全 JSON 单列"（连 kind/color 也进 JSON）——丢掉排序/过滤/检索的 SQL 能力，Calibre 的投影列存在本身就是对该方案的否定；"全硬列"（locator 拆列）——每加一种锚就改 DDL，Hypothesis 的 JSONB 零迁移实证了相反方向。

**影响面**：动 Rust（DDL + 触发器 + 投影列写入）+ 前端类型；属 v2 迁移的一部分。

### Q4 版本化与迁移：先把批注从"一次性缓存"里救出来

**证据小结**：Zotero 的组合拳最完整（版本表 + 单事务整数步骤 + compatibility 棘轮 + 升级前强制备份 + 步骤重放防御）；Calibre 的 user_version + EXCLUSIVE TRANSACTION 是最小可行版；KOReader 实证了"没有版本号"的长期代价（形状嗅探 + 迁移代码永久保留 + 静默丢数据）；Hypothesis 实证了"JSON 字段 + 缺失容忍"能把大多数演进变成零迁移；MarginNote 实证了"隐式版本 + 整库导来导去"的用户代价。

**裁决**：Reade 当前最大的存储风险不是没有迁移链，而是**批注与可抛弃缓存同库共命运**——`open_cache_connection` 在版本不匹配时删除整个数据库文件（`library.rs` L1103-1118），这对索引缓存是合理策略，对批注是定时炸弹：**下一次 `CACHE_SCHEMA_VERSION` 递增就会清空所有用户批注**。v2 必须做：
1. **拆库**：新建独立 `reade-user.sqlite3`（批注 + 未来阅读统计等用户数据），缓存库维持"不匹配即重建"；用户库采用 `PRAGMA user_version` + 顺序整数步骤单事务迁移（Calibre 最小版），升级前 `VACUUM INTO` 备份一次（Zotero），版本高于代码支持时**硬拒绝打开并提示升级应用**（棘轮），绝不静默重建。
2. **首次迁移（v1→v2）**即"把 annotations 表从缓存库搬进用户库"，天然成为迁移链的第一个案例。
3. **IndexedDB 侧**用原生 `onupgradeneeded` 承载相同的逻辑步骤编号，TS 侧维护一份与 Rust 对应的迁移映射，保证双端 Annotation JSON 始终同构。
4. 涉及锚定语义的未来迁移，照抄 KOReader DOM 升级向导的流程骨架：**dry-run 统计重锚成功率 → 明文告知 → 用户确认 → 备份后执行**。

**否决的替代**：在缓存库内就地做迁移——"版本不匹配即重建"对索引缓存是**特性**（省去为可再生数据写迁移），应保留，问题只在批注不该住在里面；KOReader 式"键存在性即版本"——其维护者已用两年迁移代码证明这条路的长期成本。

**影响面**：动 Rust（新库文件 + 连接管理 + 迁移链 + 搬表）为主，前端仅感知路径无关；是 v2 提案里工作量最大也最不能省的一项。

### Q5 导出与互操作：方案 B 维持不进存储层，导出走"页尺寸快照 + 适配器"

**证据小结**：Zotero 证明"存 DB + 导出时烧注"是可完整闭环的工程（QuadPoints 直映射 + /AP 外观流 + 私有键往返身份 + isExternal/transfer 状态机），且官方明确其动机是避免文件级冲突；Zotero 直映射的前提是它本来就存 PDF 点坐标。Hypothesis/pdf.js/Zotero 三方互证 QuadPoints 要写 **Z 序**。Readwise Export API + CSV 是聚合生态的事实入口。KOReader 警示：写批注进 PDF 会改变内容哈希，与内容寻址身份互斥。

**裁决**：**PDF 对齐调研中方案 B（改存 PDF 用户空间坐标）维持"不进路线图"的结论，且本调研给出替代它的终局形态**：pdf locator 新增可选字段 `pageWidth`/`pageHeight`（创建时的页面 pt 尺寸快照，加字段零迁移），归一化 rects 从此**离线可换算**为 QuadPoints（`x_pt = x·W；y_top = H − y·H；y_bot = H − (y+h)·H`，每 rect 一个 Z 序 quad）——存储层保持归一化渲染便利，导出层获得 Zotero 级能力，B 的全部收益在不动存储的前提下拿到。导出规划两条通道：
1. **原生 JSON 信封**（借 Calibre 信封 + KOReader 设备字段 + Readwise 墓碑语义）：`{formatVersion: 1, generator, exportedAt, deviceId, documents: [{relativePath, contentHash, annotations: [...]}]}`，含 `deletedAt` 墓碑（`includeDeleted` 可选），并做**导入端**（Calibre 只出不进是明确短板）。
2. **Readwise 兼容 CSV**：列对齐其导入规范（`Highlight/Title/Author/URL/Note/Location/Date`），Markdown 高亮 `location_type=order`、PDF 用 `page`——Reade 用户批注可直接进聚合生态。
写回 PDF（烧注导出副本）列为后续可选项，实施时照抄 Zotero：写 `/AP` + `/NM "Reade-<id>"` 私有键；并在文档中注明"写回会改变文件内容指纹"（Q1 重绑链会兜住，但应提示用户）。

**否决的替代**：方案 B（存储改 PDF 点坐标）——见上，页尺寸快照以零迁移成本取得同等导出能力；"批注写回源 PDF 作为主存储"——Zotero 官方以丢数据为由移除过同类功能（Store Annotations in File），且与 Q1 的内容指纹身份互斥（KOReader 实证）。

**影响面**：locator 加字段是纯前端；导出/导入器桌面端落 Rust 或前端皆可（数据都过 IPC，建议前端实现保双端一致）；烧注 PDF 需引入 PDF 写库，单独评估。

### Q6 删除与同步：立即上墓碑，同步语义现在就定调

**证据小结**：正面——Calibre 最小墓碑、Zotero 两级删除 + syncDeleteLog、Hypothesis 软删 + 延迟 purge、Readwise "僵尸高亮"论证 + `includeDeleted` 传播 + "去重集合忽略墓碑"细节；反面——KOReader 无墓碑逼得第三方全员自补 3-way merge，Calibre 无墓碑 GC、墙钟 newest-wins 丢并发编辑。

**裁决**：趁 schema 年轻，v2 直接加 `deleted_at INTEGER NULL`（两端），所有查询过滤；物理清除给明确策略（如清空文档批注时立即 purge、墓碑保留 90 天后台清理），不学 Calibre 的无限墓碑。删除/合并语义现在定调：**逐条 LWW（updatedAt）+ 墓碑传播**；单用户单机下墙钟够用，未来若做设备间同步，导出信封已带 `deviceId + exportedAt`（KOReader 的这两个字段值得直接抄，它缺的墓碑我们有）。导入去重按 Readwise 模式：确定性内容指纹（`hash(relativePath + kind + quote + start)`) no-op 跳过，UUID 只做内部主键不参与去重；**去重集合排除墓碑**，给用户留有意复活的路径。

**否决的替代**：向量时钟/CRDT——单用户单机场景过度设计，六家里最重的 Zotero 也只用"整库版本号 + pristine 三方合并"；无墓碑硬删——四家正面证据 + KOReader 反面实证，不再讨论。

**影响面**：两端存储 schema + 查询层小改；随 v2 迁移一并落地。

### Q7 失锚 UX：Hypothesis 的标签页 + MarginNote 的重绑 + Zotero 的"永不丢弃"三合一

**证据小结**：反面占多数——Calibre 静默跳过且触碰即删（最激进）、Zotero 静默隐藏（但 position 永不丢弃）、KOReader 静默丢弃（被自家评审痛批）、Kindle 锚断就断无任何补救；正面样本两个半——Hypothesis Orphans 标签页（分组 + 删除线 + 全功能保留 + 不持久化 orphan 状态）、MarginNote "找回失联笔记"集中重绑（但重绑后无内容级验证）、KOReader 升级向导（半个：只在引擎升级时出现）。Readwise 提供心智模型：失锚是**降级为卡片**，不是错误。

**裁决**：Reade 的 broken 标记已是正确起点，v2 补全为完整闭环：
1. **展示**：批注列表（`AnnotationUi.tsx`）增加"未锚定"分组，仅 count>0 时显示（Hypothesis 式），quote 删除线样式，笔记/颜色/删除操作完整保留（卡片降级）。
2. **不持久化 broken**：锚定状态每次渲染重算（现有 `paintTextQuoteMarks` 返回值已如此），locator **永不被清洗改写**（Zotero 原则）——文档改回去批注自动复活。
3. **修复动作**：每条失锚批注提供"在文档中搜索此文本"（跳到最近似位置，用户确认后以新 quote/context 重写 locator——Reade 有 quote 可自动验证重绑结果，这是超越 MarginNote 的点）；文档级失联（Q1 路径断）提供集中重绑入口，选择新文档后逐条跑 TextQuote 验证并报告成功率（KOReader 向导的 dry-run 思想）。
4. **文案**：解释原因（"文档内容可能已被修改"）——Calibre 唯一值得抄的部分；绝不自动删除。

**否决的替代**：持久化 broken 标志——失锚是"文档 × 批注"的关系状态，只有渲染时重算才始终准确（Hypothesis `$orphan` 不落库的理由），落库会产生脏标志；失锚自动删除——Calibre 的做法，直接违反"用户数据不可再生"原则。

**影响面**：纯前端（`AnnotationUi.tsx` + `useDocumentAnnotations.ts` + 少量 `annotations.ts` 辅助函数）。

---

## 5. Reade 标注存储 v2 提案（草案，不实现）

> 每条标注【出处】与解决的具体问题。落地顺序即编号顺序：1-3 是地基（一次迁移做完），4-6 是增量，7-8 随功能排期。

**速查表**（影响面 / 主要落点 / 相对工作量）：

| # | 提案 | 影响面 | 主要落点 | 工作量 |
|---|---|---|---|---|
| 5.1 | 拆分用户数据库 + 迁移链 | 动 Rust | `library.rs`（或新 `user_store.rs`） | 大 |
| 5.2 | schema v2 字段（墓碑/排序键/FTS/指纹表） | 两端存储 | `library.rs` + `webAnnotations.ts` | 中 |
| 5.3 | locator 可选字段追加 | 纯前端（IPC 类型同步） | `backend.ts` + `annotationCapture.ts` | 小 |
| 5.4 | 锚定解析链升级 | 纯前端 | `annotations.ts` | 中 |
| 5.5 | 文档指纹重绑链 | 动 Rust + 前端提示 | 扫描管线 + `App.tsx` | 中 |
| 5.6 | 失锚 UX | 纯前端 | `AnnotationUi.tsx` | 中 |
| 5.7 | 导出/导入 | 前端为主 | 新模块 + 少量 IPC | 中 |
| 5.8 | 不做清单 | — | 设计约束 | — |

### 5.1 拆分用户数据库（解决：批注与一次性缓存共命运）

- 桌面端新建 `reade-user.sqlite3`：`annotations` 表迁入（v1→v2 迁移第一步），未来 `reading_sessions` 等用户数据同库；缓存库（FTS 索引等）维持现有"版本不匹配即重建"策略不变。
- 迁移机制【Zotero + Calibre】：`PRAGMA user_version` + `migrate_to_v{N}` 顺序整数步骤 + 单事务整体回滚 + 升级前 `VACUUM INTO reade-user.backup-v{N}.sqlite3` + 版本高于代码支持时硬拒绝打开（棘轮），提示"请升级 Reade"。
- 落点：`src-tauri/src/library.rs`（或拆出 `user_store.rs`）；`open_cache_connection` 语义不变。

### 5.2 schema v2 字段（解决：无排序键、无检索、无墓碑、锚定无 hint）

```sql
-- reade-user.sqlite3 · user_version = 2
CREATE TABLE annotations (
    id TEXT PRIMARY KEY,             -- 现状保留（UUID，≤64 字符白名单）
    library_root TEXT NOT NULL,
    relative_path TEXT NOT NULL,     -- 仍是文档外键 = "当前位置"（Q1 裁决）
    kind TEXT NOT NULL, color TEXT, note TEXT, selected_text TEXT, title TEXT,
    locator_json TEXT NOT NULL,      -- 权威锚，Rust 宽容解析【Hypothesis JSONB】
    sort_index TEXT NOT NULL,        -- 预计算排序键【Zotero】
    searchable_text TEXT NOT NULL DEFAULT '',  -- selected_text+note，NFKC【Calibre】
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    deleted_at INTEGER              -- 墓碑【Calibre/Readwise/Hypothesis】
);
CREATE INDEX annotations_by_doc ON annotations(library_root, relative_path, updated_at DESC);
-- annotations_fts (FTS5 external-content) + 同步触发器【Calibre】
CREATE TABLE documents (             -- 指纹映射【KOReader/MarginNote/Zotero】
    library_root TEXT NOT NULL, relative_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,      -- pdf/epub: partial-MD5(12×1KiB 指数采样)；md: 规范化正文哈希
    file_size INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (library_root, relative_path)
);
```

- IndexedDB 同步升级到 v2：`annotations` store 加 `deletedAt/sortIndex` 字段与 `relativePath+deletedAt` 复合查询路径，`documents` store 存生成器输出的指纹；`onupgradeneeded` 步骤编号与桌面逻辑对齐。
- `sort_index` 编码草案（对齐 Zotero 的"定宽数字段拼接、字符串序即文档序"思路，三种格式统一 16 字符）：

```text
markdown: "M|00000|<start 偏移 8 位>"        -- 无分段概念，段位恒 0；start 来自 5.3 的 position hint
pdf:      "P|<page 5 位>|<start 偏移 8 位>"   -- 偏移缺失（纯 rects 旧数据）时用 y×10000 兜底
epub:     "E|<chapter 序 5 位>|<start 8 位>"  -- chapter 序取 spine 索引
bookmark: 同上按 target 推导，偏移位用 scrollRatio×10^8
```

  写入端在 upsert 时由 locator 推导（Rust 侧或前端算好传入均可，建议前端算、Rust 只校验格式），历史行在 v1→v2 迁移中批量回填。

### 5.3 TS 类型演进（解决：locator 缺 hint、PDF 导出缺页尺寸、派生值混入锚）

```ts
// 全部为可选字段追加，旧数据零迁移【Hypothesis "缺失容忍"】
markdown: { quote, prefix, suffix, headingId, start?, end? }        // 持久化 position hint
epub:     { chapterId, blockIndex, startOffset, endOffset,          // 降级为 hint（Q2 裁决）
            quote, prefix, suffix, start?, end? }
pdf:      { page, view, quote, prefix, suffix, rects,
            pageWidth?, pageHeight? }                               // pt 快照 → QuadPoints 离线可换算【Zotero】
Annotation: { ..., deletedAt?: number | null }
```

- `BookmarkTarget` 的 `scrollRatio/offsetRatio` 在文档注释中标注为"派生显示值，可重算"【KOReader 锚/派生分离】。

### 5.4 锚定解析链升级（解决：同 quote 多命中歧义、PDF 空白失配、无兜底）

顺序：position hint 直达 + quote 校验 → 精确 quote（现状，hintStart 消歧）→ PDF/EPUB 空白规范化重试【Hypothesis stripSpaces】→（可选开关）fuzzy `maxErrors=min(256, quote.length/2)`、打分 50:20:20:2 仅排序、命中标"非精确"【Hypothesis 实测参数】→ broken。落点：`src/lib/annotations.ts`，纯函数可测。

### 5.5 文档身份重绑链（解决：改名/移动即失联）

打开文档 / 刷新库时：relativePath 命中 → 正常；未命中但 `documents.content_hash` 在新路径出现 → 提示一次"检测到文档已移动，迁移 N 条批注？"（事务内 UPDATE relative_path）【KOReader hash 模式 + 其"doc 模式也随存哈希"的备用身份设计】；都未命中 → 批注进"文档失联"集中列表，手动重绑 + TextQuote 逐条验证报告成功率【MarginNote"找回失联笔记"骨架 + KOReader 向导的 dry-run 统计】。落点：Rust 扫描管线（算指纹）+ `refresh_library` 后置检查 + 前端提示。

### 5.6 失锚 UX（解决：broken 只有标记没有出路）

"未锚定"分组（count>0 才显示）+ quote 删除线 + 完整操作【Hypothesis Orphans 标签页】+ "在文档中搜索此文本"重锚（成功后经确认重写 locator）【MarginNote 重绑 + Reade 独有的 quote 自动验证】+ 失锚即降级为可读卡片而非错误态【Readwise】+ 永不自动删除、永不改写原 locator【Zotero "Don't discard"；Calibre 触碰即删为反面】。落点：`AnnotationUi.tsx`。

### 5.7 导出/导入（解决：数据无出口，方案 B 的替代终局）

- JSON 信封（完整形态草案）【Calibre 信封 + KOReader deviceId/exportedAt + Readwise 去重/僵尸论证】：

```json
{ "formatVersion": 1,
  "type": "reade_annotation_collection",
  "generator": "reade/0.x",
  "exportedAt": 1765500000000,
  "deviceId": "d3f0...-uuid",
  "includeDeleted": true,
  "documents": [ {
      "relativePath": "notes/topic.md",
      "contentHash": "pmd5:9a3c...",
      "annotations": [ { "id": "…", "kind": "highlight", "color": "yellow",
                          "note": null, "selectedText": "…", "title": "…",
                          "locator": { "kind": "markdown", "quote": "…", "prefix": "…",
                                       "suffix": "…", "headingId": "h-…", "start": 1024 },
                          "createdAt": 1765400000000, "updatedAt": 1765400000000,
                          "deletedAt": null } ] } ] }
```

  导入端规则：确定性指纹 `hash(relativePath + kind + quote + start)` 命中 → no-op 跳过；指纹集合**排除墓碑**（允许有意复活）；同 id 冲突按 updatedAt LWW；来自其他库（contentHash 命中而 relativePath 不同）时走 5.5 重绑链。
- Readwise 兼容 CSV（`Highlight/Title/Author/URL/Note/Location/Date`，Markdown 高亮 `location_type=order`、PDF 用 `page`）。
- 后续可选：烧注 PDF 副本导出——Z 序 QuadPoints + `/AP` + `/NM "Reade-<id>"`【Zotero/Hypothesis/pdf.js 三方互证】；提示用户"写回会改变文件内容指纹"。

### 5.8 明确不做清单（反面证据背书）

- 不用 CFI/XPointer 类结构路径做权威锚【Readium 回避 + EPUB 3.1 撤销 + Hypothesis 只当章节 ID + Calibre text-assertion TODO】。
- 不拿内容哈希当 Markdown 文档主键【KOReader hash 模式对可变文件的失效 + MarginNote 全体失联】。
- 不用 datetime/title 当批注身份【KOReader datetime-ID + Calibre bookmark 重名互吞】。
- 不用"缺席 + 时间戳"表达删除【KOReader `.annotations.lua` 复活/误删风险】。
- 不做"版本不匹配即静默重建"的用户数据库【Reade 自身缓存策略对批注的危害，本报告 Q4】。

### 5.9 v1→v2 迁移执行清单与验证计划（供实施时展开）

**迁移步骤**（全部在打开库时一次完成，单事务 + 事前备份）：

1. 检测旧缓存库中存在 `annotations` 表且新用户库不存在或 `user_version < 2`。
2. 创建/打开 `reade-user.sqlite3`；若已存在且版本更高 → 硬拒绝（棘轮），提示升级应用。
3. `VACUUM INTO reade-user.backup-v1.sqlite3`（用户库已有数据时）；缓存库只读挂载。
4. 建 v2 表结构（5.2）→ `INSERT INTO user.annotations SELECT ..., NULL AS deleted_at` 搬数据，`sort_index`/`searchable_text` 就地推导回填 → 校验行数一致 → 提交。
5. 缓存库中的旧表**保留一个版本周期**再删（KOReader"旧键作后备"的合理部分），期间只读。
6. dry-run 报告：迁移条数、sort_index 回填失败数（落日志，不阻塞）。

**验证计划**（对齐 AGENTS.md 的测试位置约定）：

- Rust（`src-tauri/src/library.rs` 或新模块内置 tests）：迁移幂等性（重复打开不重复搬）；棘轮拒绝（user_version=99 的库）；备份文件存在性；搬运前后行数与字段逐一相等；墓碑过滤（`deleted_at IS NOT NULL` 不出现在 list 结果）；重绑链三分支（路径命中 / 指纹命中 / 双失败）。
- 前端（`src/lib/annotations.test.ts` 等）：锚定链新顺序（position hint 命中/失效回退/quote 校验拒绝）；locator 新旧形状互相反序列化（缺 `start`/`pageWidth` 的旧数据不报错）；`sort_index` 推导的三格式排序性质测试；导出信封 round-trip（导出→导入 no-op）。
- Web（`src/lib/webAnnotations.test.ts`，如新增）：IndexedDB v1→v2 `onupgradeneeded` 升级后旧记录可读、新字段默认值正确。
- 运行时验收（不可省略）：真实库升级一次，确认批注全量在场；失锚 UX 的明暗主题与窄窗口截图（涉及界面）。

---

## 6. 信息缺口

**各 profile 遗留的未验证项（汇总）**：

- Calibre：PDF 无批注支持为【推断】（未逐行验证 PDF 打开路径）；exim 打包细节、第三方插件生态兼容性未验证；重转换后 CFI 失效缺社区实测案例。
- Zotero：pdf-worker 删页/旋转时批注 position 修正算法细节、`calibre.ts` 字段映射、Web 在线阅读器失锚行为未深读/未验证。
- KOReader：partial MD5 首采样点的 LuaJIT `lshift(1024,-2)` 回绕语义为位运算推断；书籍换版本后 XPointer 实际命中率未做真机实验；第三方同步插件 3-way merge 仅 README 自述。
- Hypothesis/W3C：PDF.js fingerprint 计算方式为【推断】；PDF 32000-1 原文未取得（ISO 收费），QuadPoints 语义靠三方独立来源收敛；`pdf.ts` L512-514 suffix 早停疑似笔误为推断（只影响性能）。
- Readwise：CSV 导出列来自第三方实录（建议实测一次）；Kindle location=128 字节块是社区共识非官方定义；My Clippings 去重算法官方未公开。
- MarginNote：**全部 Z 表 schema 结论为【推断】上限**；`ZSTARTPOS` 坐标系、各 BLOB 内部格式、MN4 原生 Markdown 导出、迁移成功率均未查到。

**本报告自身限制**：

1. 六家产品的运行时行为均以源码/文档静态分析为主，未做实机安装验证（KOReader/Calibre 的失锚表现、Zotero 的导入导出往返）。
2. v2 提案的 partial-MD5 指纹对 Reade 实际文档库的碰撞率/刷新成本未做基准测试；`sort_index` 编码已给草案（5.2）但三格式的排序正确性需要性质测试佐证。
3. 提案落地涉及 IPC 契约变更（新 command、locator 字段），按 AGENTS.md 需两端同步 + 安全回归测试；5.9 给出了测试方向清单，逐条用例仍需实施时展开。
4. 5.7 的 JSON 信封与 CSV 未与真实 Readwise 账户做导入实测（CSV 列规范本身来自第三方转录，见 Readwise 条目缺口）。

---

## 7. 参考来源

> 六份完整 profile（含精确到行号的全部引用）与交叉核验报告存于 `C:\Users\viper\AppData\Local\Temp\reade-annotation-research\`；下为各条目最关键的一手来源。

**Calibre**（github.com/kovidgoyal/calibre @ `4597980`，v9.13.0）：`src/calibre/db/schema_upgrades.py` L721-814（annotations DDL/FTS/触发器）、`db/backend.py` L2696-2720（墓碑删除）、`db/annotations.py` L48-70（newest-wins 合并）、`src/pyj/read_book/cfi.pyj` L240-244/L394（id assertion / text assertion TODO）、`gui2/viewer/annotations.py`（三处存储）；Launchpad #1994917（作者拒绝内容哈希）；「New in calibre 5.0」 calibre-ebook.com/new-in/fourteen。

**Zotero**（zotero @ `fdec9691`、reader @ `ba173e79`、pdf-worker @ `03830733`）：`resource/schema/userdata.sql` L228-245（itemAnnotations DDL）、`xpcom/schema.js` L2898+（迁移循环/棘轮/强制备份）、`xpcom/annotations.js` L29-36（type 映射/65k 上限）、reader `src/common/types.ts` L74-79（PDFPosition）、pdf-worker `src/pdf/annotations/write.js` L24-39（rectsToQuads Z 序）；官方 KB "Why does Zotero store PDF annotations in its database…"（zotero.org/support/kb/annotations_in_database）；Web API v3 Syncing 文档。

**KOReader**（github.com/koreader/koreader @ `941f64c`）：`frontend/docsettings.lua` L101-146（三模式）、`frontend/util.lua` L1094-1111（partial MD5）、`frontend/apps/reader/modules/readerannotation.lua` L66-83/L159-236/L255-336（字段注释/迁移/设备同步）、`readerrolling.lua` L1402-1594（DOM 升级向导）；PR #11563（统一重构与版本号讨论）、PR #12494（静默丢弃争议）、PR #13372（.annotations.lua 同步）、PR #10945 + issue #10892/#11773（hash 模式动机与事故）。

**Hypothesis / W3C**（client @ `b4d085a2`、h @ `24395ca4`）：client `src/annotator/anchoring/match-quote.ts` L99/L111-150（fuzzy 阈值与打分）、`anchoring/html.ts` L36-113（降级链）、`anchoring/types.ts` L199（32 字符上下文）、h `h/models/annotation.py`（target_selectors JSONB）、`h/services/annotation_delete.py`（软删+延迟 purge）、`h/util/uri.py`（URL 规范化）；W3C Web Annotation Data Model（w3.org/TR/annotation-model/ §4.2）；EPUB CFI（idpf.org/epub/linking/cfi/）；readium/annotations discussion #2（CFI 回避）；mozilla/pdf.js #12675（QuadPoints Z 序）。

**Readwise / Kindle**：Highlights API v2（readwise.io/api_deets，2026-08-12 重抓核验）、Reader API v3（readwise.io/reader_api）、docs.readwise.io（导入导出/changelog/llms.txt）、help.readwise.io article 49（Kindle 两条导入路径）；readwiseio/obsidian-readwise `src/main.ts` L373-417（hash 追加合并）；koreader exporter `target/readwise.lua` L63-88（生态最小对齐样本）；robertmartin8/KindleClippings 等解析器（My Clippings 格式实录）。

**MarginNote**（闭源，【推断】级为主）：官方 sync-backup 页（marginnote.com/en/features/sync-backup/，4.3 对象池/Manifest/CloudKit 失败模式，2026-08-12 重抓核验）、MN3 FAQ Q2（faq.marginnote.cn，自动重关联条件与找回失联笔记）、MN3 手册（manual.marginnote.com.cn）；marginnoteapp/ohmymn @ `fb0e209`（`MbBookNote.ts`/`NoteDatabase.ts` 类型定义）；rkanuj/marginnote-extractor（DDL.sql）、Cheendfdf/marginnote-obsidian-sync（MD5 前缀匹配）。

**Reade 本仓库（现状基线）**：`src/lib/backend.ts` L96-154、`src/lib/annotations.ts`、`src/lib/webAnnotations.ts`、`src/lib/useDocumentAnnotations.ts`、`src-tauri/src/library.rs` L25-29/L1103-1118/L1205-1219/L1724-1805、`docs/research-pdf-annotation-alignment.md`（方案 A+C/B 结论衔接）。
