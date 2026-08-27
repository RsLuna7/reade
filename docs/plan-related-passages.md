# 实施方案:相关段落发现

- 日期:2026-08-13
- 状态:**已实施**
- 定位:选中一段文字 → 在全库找出讲同一件事的其他段落。零模型、零网络:完全建立在缓存 sqlite 里已有的 FTS5 trigram 文档索引之上,是"库搜索"的选区驱动形态。
- 关联:复用 `search_documents` 的索引、返回形状(`SearchResult`/`SearchLocator`)与跳转链;查询预算沿用「全库批注中枢」的 FTS/LIKE 双路径与转义纪律(`docs/plan-annotation-hub.md` §3.1);若「只读双链」(`docs/plan-backlinks.md`)落地,本方案的结果浮层远期可并入其「链接」tab 作"相关"区。
- 契约红线:FTS MATCH 字符串全部由后端从选区文本构造,用户文本永远包在双写转义的短语引号内,FTS 语法不可注入;不改动 `search_fts` schema 与索引管线。

> 一句话:一个 Rust 纯函数把长选区切成 top-K 显著片段、OR 组合成 FTS5 trigram 短语查询,新 command `find_related_passages(text, exclude_path, limit)` 用既有 `search_fts` + bm25 返回 `SearchResult`(排除当前文档);SelectionToolbar 加「相关」按钮,结果在工具条旁的浮层里呈现,点击走既有 `selectDocument(path, locator)` 跳转;Web 端用同一片段抽取纯函数对 `search.json` 做简化计数打分。

---

## 1. 现状基线(全部【已核实】于本仓库源码)

| 事实 | 位置 |
|------|------|
| **FTS5 文档索引确切形态**:`search_fts` 是 external-content 表(`content = 'search_segments'`,`content_rowid = 'id'`,**非 contentless**),两列 `title, content`,`tokenize = 'trigram'`,insert/delete/update 三触发器同步 | `src-tauri/src/library.rs` L1029-1047 |
| **索引粒度**:markdown/mdx 整篇一个 segment(locator NULL);PDF 每页一段(`pdfPage`,1-based);EPUB 每章一段(`epubChapter`) | 同上 L845-867、L869-905、L907-936 |
| **snippet 与 bm25 均可用且已在生产查询中使用**:`snippet(search_fts, 1, '', '', ' … ', 28)`、`-bm25(search_fts, 5.0, 1.0) AS score`(title 权重 5、content 权重 1),`ORDER BY score DESC` | 同上 L1458-1490 |
| 现有查询构造:整个查询 trim 后包成**单个 FTS 短语**(内部 `"` 双写再加外层引号);<3 字符走 LIKE 回退(`escape_like` 转义 `\`/`%`/`_`,NOCASE) | 同上 L1469-1472、L1492-1522、L1841-1846 |
| limit 语义:`clamp(1, MAX_SEARCH_LIMIT=100)`,默认 30;空查询返回空 | 同上 L29-30、L1464-1468 |
| `SearchResult { result_id, relative_path, title, snippet, score, format, locator }`;`result_id = path:locatorKind:locatorValue`;TS 端同构类型 | 同上 L74-89、L1524-1559;`src/lib/backend.ts` L27-39 |
| **跳转链现状**:搜索结果点击 → `selectDocument(relativePath, locator)`;`currentLocator` 传入 PdfReader/EpubReader 完成页/章定位;markdown locator 为 null → 落在持久化阅读位置(有显式 locator/待跳标注/hash 时持久化恢复让位) | `src/components/DocumentTree.tsx` L204-239;`src/store/useReaderStore.ts` L271、L407-413;`src/App.tsx` L3009-3040、L3541、L3554 |
| SelectionToolbar 现有动作:高亮/下划线/笔记/书签,由 `pendingSelection`(`{ text, locator, rect }`,文本已经 `clampSelectionText` 截断)驱动,`annotationTool === "view"` 时出现 | `src/App.tsx` L3764-3776;`src/components/AnnotationUi.tsx` L45-97;`src/lib/annotationCapture.ts` L15-19 |
| 批注检索先例(同类查询纪律):归一 → ≥3 字符 FTS 短语 / <3 LIKE,查询 256 字符截断、结果上限 500;前端 240ms 防抖模式 | `src-tauri/src/user_store.rs` L72-76、L1580-1605、L1625-1700;`src/App.tsx` L2136-2158 |
| Web 搜索能力边界:`search.json` 含全部文档全文;`searchWebDocuments` = 空白分词、每词 `includes` 必中、计数打分,**locator 恒 null** | `src/lib/webLibrary.ts` L30-39、L234-284 |
| 双端契约先例:TS 用例表编号为准、Rust 注释对齐 | `src/lib/annotationSearch.ts` L1-11 |
| command 注册处;`search_documents` 是同步 `#[tauri::command] fn`,持锁查缓存连接 | `src-tauri/src/lib.rs` L45-73;`src-tauri/src/library.rs` L527-544 |

## 2. 目标与非目标

**目标**

1. 选中 ≥8 字符文本 → 「相关」动作 → 全库(排除当前文档)返回至多 12 条相关段落,带 snippet 与跳转 locator。
2. 查询构造对 CJK 与英文都稳健:不依赖分词器,只依赖 trigram 子串语义;换行/软换行不会杀死召回(片段策略,见 §3.2)。
3. 复用 `SearchResult` 返回形状与 `selectDocument(path, locator)` 跳转链,前端零新跳转逻辑。
4. Web 端降级可用:同一片段抽取契约 + `search.json` 简化打分。

**非目标(明确不做)**

- 不做 embedding/向量检索/ML 相似度(个人库、零依赖红线;trigram 词面重叠对"我在哪也写过这个"够用)。
- 不做跨库检索(作用域 = 当前打开的库,与全部既有 command 一致)。
- 不做无选区的自动推荐(不主动打扰;入口只有选区工具条)。
- 不改 `search_fts` schema、不为 markdown 引入更细段落粒度(整篇 segment 是现状,详见 §7 风险)。
- 不做结果内高亮命中词(snippet 已给上下文;留远期)。

## 3. 设计

### 3.1 IPC 契约(新 command)

| command(snake_case 参数) | wrapper(camelCase) | 返回 |
|---|---|---|
| `find_related_passages(text: String, exclude_path: Option<String>, limit: Option<u32>)` | `findRelatedPassages(text, excludePath, limit = 12)` | `Vec<SearchResult>`(serde camelCase,与 `search_documents` 完全同形) |

- `text` 上限 2,000 字符(与 `MAX_ANNOTATION_TEXT_CHARS` 一致,选区来源本就被 `clampSelectionText` 截断;超限服务端再截);归一后不足 3 字符返回空。
- `exclude_path` 过 `validate_relative_library_path` 后作 `AND s.relative_path != ?`;`limit` clamp 1..50,默认 12。
- 同步 command、只读 SELECT,注册进 `lib.rs`;wrapper 进 `src/lib/backend.ts` 按 `APP_RUNTIME` 分流,Tauri 侧 `invoke("find_related_passages", { text, excludePath, limit })`。

### 3.2 查询构造(核心,Rust 纯函数 + TS 契约孪生)

`src-tauri/src/library.rs` 新纯函数(TS 孪生 `src/lib/relatedFragments.ts` 供 Web 与契约测试):

```rust
/// 选区文本 → 显著片段列表(已按显著性排序、去重、封顶)。
fn extract_related_fragments(text: &str) -> Vec<String>   // 契约函数,两端同实现
/// 片段列表 → FTS5 MATCH 字符串:每片段 `"` 双写后包引号,以 " OR " 连接。
fn build_related_match(fragments: &[String]) -> Option<String>
```

规则(全部进契约用例表):

1. 空白归一:任意空白串(含换行)折叠为单空格,首尾 trim。
2. **切 run**:按空白 + 标点(ASCII 标点与常用 CJK 标点 `,。;:!?、「」『』()《》…—·"'`)切成连续字符 run——这是对"选区跨行、索引文本换行位置不同"的关键防御:片段内部不含空白/标点,trigram 匹配不再受换行影响。
3. **长 run 切片**:>12 字符的 run 按 8 字符步长切成不重叠窗口(CJK 长句由此变成多个可独立命中的片段)。
4. 过滤:片段 <3 字符丢弃(trigram 下限);大小写不敏感去重。
5. **显著性排序**:字符长度降序(trigram 语义下越长越有区分度),同长按原文位置升序——确定、可测,不引入词频表。
6. 取 top 6 为查询片段(常量 `RELATED_MAX_FRAGMENTS = 6` 导出)。

SQL(与 `search_index` 同构,仅三处不同——MATCH 串、排除条件、bm25 权重):

```sql
SELECT s.id, s.relative_path, s.title,
       snippet(search_fts, 1, '', '', ' … ', 28),
       -bm25(search_fts, 2.0, 1.0) AS score,      -- RP-D2:title 降权到 2.0
       s.format, s.locator_kind, s.locator_value
FROM search_fts JOIN search_segments s ON s.id = search_fts.rowid
WHERE search_fts MATCH ?1 AND s.library_root = ?2 AND s.relative_path != ?3
ORDER BY score DESC, s.relative_path ASC, s.ordinal ASC
LIMIT ?4
```

- OR 组合天然让"命中片段更多的段落"获得更高 bm25 分;每个 segment 只出现一行(无需去重)。
- 复用 `search_result_from_row` 与 `collect_search_rows`,`result_id`/locator 解析零新代码。
- 注入安全:片段来自 run 切分(已剔除引号外的语法字符),再经 `"` 双写 + 外层引号,`OR`/`NEAR`/`*` 均为字面量——与既有 `fts_phrase` 同一纪律,测试覆盖。

### 3.3 入口与呈现(RP-D4)

- `SelectionToolbar` 增加「相关」按钮(props 加 `onFindRelated`、`canFindRelated`):`pendingSelection.text` 去空白后 ≥8 字符时可用(常量 `RELATED_MIN_SELECTION_CHARS = 8`),不足时禁用 + title 提示"至少选中 8 个字符"。
- 点击后:关闭工具条 → 在选区矩形旁挂 **浮层面板** `RelatedPassagesPopover`(新组件,复用 `annotation-toolbar`/`AnnotationToolsPanel` 的定位与 `reade-motion-panel` 动效模式):加载态 → 结果列表(每行:文档标题 + 格式徽标 + snippet + PDF"第 N 页"/EPUB"章节"标签,同 `document-tree__result` 的信息结构)→ 点击行 `selectDocument(path, locator)` 并关闭浮层;`Esc`/点击外部关闭。
- 无防抖需求(点击触发,非输入流);但按钮在请求返回前禁用(防连点),请求带序号守卫(沿 `librarySearchRequest` 模式)防过期结果覆盖。
- 空结果态:"没有找到相关段落";错误态显示 message。
- 与全屏视图互斥:浮层只在 reader 视图存在(选区本就只在阅读面产生)。

### 3.4 Web 端(RP-D5)

- `findRelatedPassages` 的 Web 分支:`loadSearchIndex()` → 对每篇(排除 `excludePath`)用 **同一** `extractRelatedFragments` 的输出做小写 `includes` 计数:`score = Σ min(count(fragment), 3) × fragment.length`;>0 进入候选,排序取 top limit,`snippet` 用 `searchSnippet`(既有函数)围绕首个命中片段生成,`locator: null`。
- 语义一致性:trigram 与 `includes` 同为"子串匹配",契约锁的是**片段抽取**(两端逐字节一致);打分公式两端不同(bm25 vs 计数)按文档化差异接受——与库搜索桌面/Web 的既有分工完全一致。
- markdown locator 为 null 的跳转体验与桌面一致(落持久化位置)。

### 3.5 性能

- 索引零新写入,查询走既有 `search_fts` trigram 索引;6 短语 OR、LIMIT 12。
- 预算(进验收):合成 5,000 segments(均 ~2 KiB 正文)库上单次查询 **< 500ms**(Rust 测试宽松上界);真实万篇库人工验收目标 < 300ms、浮层从点击到首帧 < 600ms。
- 前端浮层列表 ≤ 50 行 DOM,无虚拟滚动需求。

### 3.6 安全

- 查询文本不落盘、不出网;MATCH 构造见 §3.2 注入纪律;`exclude_path` 走 `validate_relative_library_path`;返回内容全部来自本地索引;无新权限、无 schema 变更、零新依赖。

## 4. 改动清单(预估)

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src/lib/relatedFragments.ts`(新)+ `relatedFragments.test.ts` | 片段抽取契约函数 + 用例表 | S-M |
| 2 | `src-tauri/src/library.rs` + 内嵌测试 | `extract_related_fragments`/`build_related_match`/`find_related_passages` | M |
| 3 | `src-tauri/src/lib.rs` | 注册 command | S |
| 4 | `src/lib/backend.ts`(+ `src/lib/webLibrary.ts` 若简化打分放此)| wrapper 双分支 | S-M |
| 5 | `src/components/AnnotationUi.tsx`(工具条按钮)+ `src/components/RelatedPassages.tsx`(新)+ 测试 | 入口 + 浮层 | M |
| 6 | `src/App.tsx` | 接线(state、请求守卫、跳转) | S-M |
| 7 | `src/App.css`、`docs/USER_GUIDE.md` | 样式与文档 | S |

里程碑:**P0** 片段抽取双端契约(纯函数,可独立合)→ **P1** command + wrapper(Rust 测试齐,可用 devtools 手调)→ **P2** 工具条入口 + 浮层 + Web 简化打分 + 视觉验收。

## 5. 验收标准

**P0(片段契约)**

- [ ] 契约用例表(`relatedFragments.test.ts` 编号 F01…,Rust 测试注释对齐,≥12 例):纯 CJK 长句切片(24 字 → 3 片)、中英混排、跨换行选区(`foo\nbar` 与 `foo bar` 产出相同片段)、标点切分(顿号/句号/引号)、<3 字符片段丢弃、大小写去重、top-6 截断顺序(长度降序+位置升序)、全标点/全空白输入 → 空、2,000 字符截断、含 `"`/`OR`/`NEAR`/`*` 的文本片段保持字面。
- [ ] `build_related_match`:空片段列表 → None;含 `"` 片段双写转义;输出串手工 `sqlite3` 验证可被 FTS5 解析(记录在测试注释)。
- [ ] `pnpm test`、`tsc --noEmit`、`cargo test`、`cargo clippy -D warnings` 全绿。

**P1(command)**

- [ ] Rust 测试(library.rs 内嵌,基于 `AppState::in_memory` + 手插 segments 的既有模式):
  - 三格式命中:markdown 结果 locator None、PDF 带 `pdfPage`、EPUB 带 `epubChapter`,`result_id` 形状正确;
  - `exclude_path` 生效(自文档段落不出现);跨 `library_root` 隔离;
  - 片段多命中的 segment 分数高于单命中(bm25 排序断言相对序,不断言绝对值);
  - 注入:选区含 `" OR "`、`*`、`NEAR(` 时不报错且按字面匹配;
  - 归一后 <3 字符 → 空;limit clamp 1..50;`exclude_path` 传 `../x` 被拒。
- [ ] 性能:测试内构造 5,000 segments,单次查询 `Instant` 计时 < 500ms。
- [ ] 两端类型同步:`findRelatedPassages` wrapper 的参数名(`text`/`excludePath`/`limit`)与 Rust snake_case 逐一对应,返回直接落 `SearchResult[]` 类型(tsc 保证);`tauriBackend.test.ts` 或等价测试断言 invoke key 拼写。

**P2(UI 与 Web)**

- [ ] 组件测:选区 <8 字符按钮禁用;点击后浮层出现且请求参数含当前文档为 `excludePath`;结果行点击调 `selectDocument(path, locator)`(PDF 用例断言 locator 透传);Esc 关闭;过期响应(序号守卫)不渲染;空态/错误态文案;SelectionToolbar 既有四动作测试不回归。
- [ ] 运行时(桌面):demo-library 三格式各造相似段落 → 选中 markdown 段落点「相关」→ 浮层列出 PDF/EPUB 命中,点击分别落到正确页/章;选中含换行的 PDF 文本 → 仍有召回(片段策略验证);万篇合成库(脚本生成)查询 < 300ms(console 计时佐证)。
- [ ] 运行时(Web):`pnpm dev:web` 同一操作走通;同一选区桌面/Web 命中文档集合抽 3 例对比,差异仅限排序(记录)。
- [ ] 截图矩阵:浮层 明/暗 × 宽/窄 ≥ 4 张(含加载态与空态各 1);`docs/USER_GUIDE.md` 新增「相关段落」一节。
- [ ] 全量回归:`pnpm test`、`tsc --noEmit`、`cargo test`、`cargo clippy -D warnings`、`pnpm build`、`pnpm build:web`。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| RP-D1 | 查询构造 | **run 切分 + 长 run 8 字符切片 + 长度优先 top-6 OR 短语**(换行免疫、CJK 免分词、确定可测) | 整选区单短语(索引文本换行即失配,PDF 场景召回崩,否);LIKE 多模式全表扫(万篇库线性扫全文,预算不可控,否) |
| RP-D2 | 排序 | **`-bm25(search_fts, 2.0, 1.0)`**(相关段落任务里正文重叠是主信号,title 降权但保留) | 沿用库搜索的 (5.0, 1.0)(标题词偶合会顶掉真正文命中);无权重 bm25(标题命中被埋没) |
| RP-D3 | 自命中排除 | **整篇排除 `exclude_path`**(简单、可预期,顺带解决"当前位置附近"问题;本文档内重复主题不是本功能要回答的) | 仅排除命中所在 segment(markdown 整篇=一个 segment,等价于 A 却更绕);不排除(结果首位永远是自己,噪音) |
| RP-D4 | 结果呈现 | **SelectionToolbar 旁浮层**(阅读上下文不丢、交互与工具条连续、不动三 tab 布局) | 侧栏第四 tab(与双链方案的「链接」tab 抢位,且选区驱动的瞬时结果不适合常驻 tab);全屏视图(重) |
| RP-D5 | Web 端 | **简化复用**:同一片段抽取 + `search.json` includes 计数打分(子串语义两端一致,契约只锁片段抽取) | Web 不支持(藏按钮,白丢能力);Web 端完整 bm25(需引入 FTS 类库,违背零依赖,否) |

## 7. 风险与开放问题

- **最大风险——markdown 粒度**:markdown 整篇是一个 segment,命中一篇长文时 snippet 只给一个最佳窗口、跳转落在持久化位置而非命中处。这是既有库搜索的同款限制,本方案不为它动索引 schema(为 markdown 引入分节 segment 是独立且高危的索引改造);缓解:snippet 已给足上下文,浮层内容本身可读。若日后做分节,双链/搜索/相关三方同时受益。
- **trigram 对高频片段的区分度**:选区若全是常见词(如"因此我们可以"),top-6 片段全为高频串,bm25 仍会给出大量弱相关命中——属词面方法的固有边界,文案不承诺"语义相似",按钮命名「相关」而非「相似」。
- 长度优先的显著性启发在"最长片段恰是引用的公共套话"时失灵:接受,不引入词频统计(需要额外索引,收益存疑,远期再评)。
- OR 短语数与性能:6 片段上限经预算测试锚定;若真实库超预算,先降 `RELATED_MAX_FRAGMENTS` 再考虑两段式(先 3 片段,不足再补查)。
- 浮层定位在窄窗/选区贴边时可能溢出视口:复用工具条已有的 clamp 定位逻辑,截图矩阵含窄窗用例把关。
