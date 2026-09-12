# 实施方案:只读双链(反向链接)

- 日期:2026-08-13
- 状态:**已实施**
- 定位:把 Markdown 文档之间已经存在的引用关系(标准相对链接 + `[[wiki]]` 语法)变成可导航的双向视图——打开一篇文档就能看到"谁链到了它"和"它链向了谁"。只读:不引入编辑器,不改写任何文档。
- 关联:链接表与文档索引共用同一条扫描/重索引管线(缓存 sqlite);双端契约测试沿用「全库批注中枢」的 TS/Rust 用例表对齐模式(`docs/plan-annotation-hub.md` §5-A1);若「相关段落」(`docs/plan-related-passages.md`)后续落地,其结果面板远期可并入本方案的「链接」tab。
- 契约红线:链接目标的字符串解析语义必须与前端 `resolveLibraryPath` 逐例一致,越界一律丢弃;本方案不触碰 `resolve_existing_in_root` 的 canonicalize 校验,链接图是纯字符串层派生数据,文件访问仍走既有边界。

> 一句话:markdown 后台索引时顺带提取出链(与前端 `resolveLibraryPath` 同语义解析,契约测试锁死),存进缓存 sqlite 的新增 `document_links` 表(派生数据,重建无损);一个只读 command `list_document_links` 供侧栏第四个 tab「链接」消费;`[[wiki]]` 存原始 stem、查询时按文件名解析;Web 端用同一 TS 纯函数吃 `search.json` 全文,生成器零改动。

---

## 1. 现状基线(全部【已核实】于本仓库源码)

| 事实 | 位置 |
|------|------|
| 前端链接解析 `resolveLibraryPath`:去 `?`/`#` → percent-decode → `\`→`/` → 拒绝空串/`//` 前缀/绝对协议(`^[a-z][a-z\d+.-]*:`)→ 前导 `/` 按库根绝对、否则相对当前文档目录 → `.` 跳过、`..` 弹栈、**弹空(越界)返回 null** | `src/App.tsx` L242-265、L174-175 |
| 链接点击链 `handleNavigate`:`#` 走文内锚点;外链(`https?:`/`mailto:`)必须 `window.confirm` 后 `openExternalLink`;库内目标必须命中当前 `documents` 列表,否则提示"目标不在当前 Markdown 文档库中,已阻止打开" | `src/App.tsx` L3141-3181;`src/lib/backend.ts` L213、L295-301 |
| 渲染层 URL 白名单 `safeUrlTransform`(协议相对/file:/任意 data: 拒绝),raw HTML 禁用 | `src/lib/markdown.ts` L12-55 |
| markdown 索引 = 后台管线读全文、整篇一个 segment;`store_index_result` 单事务"删旧段 + upsert document_cache + 插新段";单文档清理 `clear_cached_document` | `src-tauri/src/library.rs` L845-867、L1200-1270、L1272-1296 |
| 缓存 sqlite(`reade-cache.sqlite3`)`CACHE_SCHEMA_VERSION = 1`;版本或 auto_vacuum 不符 → **整文件删除重建**;`initialize_cache` 每次启动跑幂等 `CREATE TABLE IF NOT EXISTS` DDL | `src-tauri/src/library.rs` L26、L946-961、L993-1078 |
| 用户库/缓存分工的成文原则:不可替代数据进 `reade-user.sqlite3`(迁移链+备份),**可再生数据留在缓存**("schema mismatch → delete the file" 仅对可再生数据可接受) | `src-tauri/src/user_store.rs` L1-11 |
| 增量失效已就绪:扫描按 `(size, modified, converter_revision)` 不符即 `clear_cached_document` + 置 Pending;消失路径的缓存行同扫描清除;后台索引有 generation 守卫 | `src-tauri/src/library.rs` L1118-1129、L1147-1161、L1166-1198、L653-700 |
| watcher 300ms 防抖发 `library-changed`,前端收到后 `refreshLibrary()` 重扫 | `src-tauri/src/library.rs` L31、L1723-1746 |
| 侧栏三 tab:`SidePanelTab = "toc" \| "annotations" \| "library"`;标注 tab 已有数量徽标;窄窗抽屉复用同一 `SidePanel` 组件 | `src/App.tsx` L877、L962-1043、L3703-3762 |
| command 注册与 wrapper 惯例:Rust snake_case 参数 ↔ `invoke` camelCase key(如 `search_documents` ↔ `{ query, limit }`) | `src-tauri/src/lib.rs` L45-73;`src/lib/tauriBackend.ts` L44 |
| 库内在场集合的快照 helper `current_root_and_document_paths(state) → (root, HashSet<path>)` 已 pub(crate),供不持库状态的模块用 | `src-tauri/src/library.rs` L1671-1688 |
| Web 端:`search.json` 携带**全部文档全文**(`WebSearchDocument.content`);生成器只发布 Markdown 与白名单图片;manifest/search 均 schema v2 | `src/lib/webLibrary.ts` L30-39;`scripts/generate-web-library.mjs` L11-21、L193-226 |
| `regex` crate 已在依赖树(协议前缀判定可用,零新依赖) | `src-tauri/Cargo.toml` L38 |
| 双端契约测试先例:TS 用例表编号为准,Rust 测试注释引用同一批编号 | `src/lib/annotationSearch.ts` L1-11;`src-tauri/src/user_store.rs` L1667-1670 |

## 2. 目标与非目标

**目标**

1. 扫描/重索引 markdown(含 mdx)时提取出链:`[text](target)`、`![alt](target)`、`[[wiki]]`(含 `[[target|alias]]`、`[[target#锚点]]`);目标可为 md/mdx/pdf/epub 文档或库内资产。
2. 解析语义与 `resolveLibraryPath` 逐例一致(相对/库根绝对/`..` 越界丢弃),以编号用例表做 Rust/TS 契约测试。
3. 新只读 command `list_document_links(relative_path)` → `{ backlinks, outgoing, brokenCount }`;文件变更经既有 watcher→refresh→重索引链自动增量更新。
4. 侧栏第四个 tab「链接」:反向链接分组列表 + 出链列表 + 断链计数;PDF/EPUB 文档同样能看到自己的反向链接。
5. Web 端同能力:同一 TS 提取纯函数运行时吃 `search.json`,生成器不改。

**非目标(明确不做)**

- 不做孤岛文档列表、全库链接图谱/可视化(远期观察项,数据层本方案已备好)。
- 不收录外部链接(`http:` 等)进链接表——正文里已可点击(带确认),链接 tab 只管库内引用网络。
- 不支持 reference-style 链接(`[text][ref]`)与 autolink;不解析 PDF/EPUB 内部的出链(它们只作为被链接目标)。
- 不做链接重命名联动、断链修复建议(只读呈现)。
- 不动渲染器、不动 CSP/capability、不放宽任何路径校验;**零新依赖**。

## 3. 设计

### 3.1 提取(Rust 纯函数,索引期)

新模块 `src-tauri/src/links.rs`(纯函数,不做 IO):

```rust
pub(crate) enum ExtractedLink {
    Resolved { target_path: String, target_kind: TargetKind, // Document | Asset(按扩展名)
               link_text: String, fragment: Option<String> },
    Wiki     { stem: String,        // 归一:trim + 小写;含 `/` 时为"去扩展名路径"
               link_text: String, fragment: Option<String> },
    // 越界(`..` 弹空)、空目标、绝对协议、`//` 前缀:提取阶段直接丢弃,不入库(与前端"阻止打开"对齐)
}
pub(crate) fn extract_document_links(source_path: &str, markdown: &str) -> Vec<ExtractedLink>
```

- 语法范围:行内 `[..](..)`/`![..](..)` 与 `[[..]]`;fenced code(``` / ~~~,复用 `extract_title` 的翻转判定)与行内 code span 内的内容跳过。
- 解析规则逐条对齐 `resolveLibraryPath`(§1 第一行),外加:目标先按 `#` 切出 fragment(与 `handleNavigate` 一致),percent-decode 失败按原文(与 `decodePath` 的 try/catch 一致);`link_text` 截断 200 字符。
- `[[wiki]]`:`|` 后为别名(取 `|` 前为目标),`#` 后为锚点;**只存归一化 stem,不在提取期解析**(见 BL-D1)——歧义随库状态变化,解析放到查询时零重索引成本。
- 单文档上限 1,000 条链接(超出截断,防手工构造的链接炸弹拖慢索引)。

### 3.2 存储(缓存 sqlite,BL-D2)

`initialize_cache` 的幂等 DDL 追加(**不 bump `CACHE_SCHEMA_VERSION`**,`IF NOT EXISTS` 附加表即可,老库自动补建;若未来改表结构再 bump——代价只是转换缓存重建,数据可再生):

```sql
CREATE TABLE IF NOT EXISTS document_links(
    id INTEGER PRIMARY KEY,
    library_root TEXT NOT NULL,
    source_path TEXT NOT NULL,
    link_kind TEXT NOT NULL,      -- 'relative' | 'wiki'
    target_path TEXT,             -- 已解析库内路径;wiki 为 NULL
    wiki_stem TEXT,               -- 归一化 stem;relative 为 NULL
    target_kind TEXT NOT NULL,    -- 'document' | 'asset';wiki 恒 'document'
    link_text TEXT NOT NULL,
    fragment TEXT,
    ordinal INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS document_links_by_source ON document_links(library_root, source_path, ordinal);
CREATE INDEX IF NOT EXISTS document_links_by_target ON document_links(library_root, target_path);
CREATE INDEX IF NOT EXISTS document_links_by_stem   ON document_links(library_root, wiki_stem);
```

- 为什么不进用户库:链接 100% 由 markdown 源派生,重建无损;进 `reade-user.sqlite3` 会把派生数据卷进 `VACUUM INTO` 备份与迁移棘轮(§1 用户库分工原则),且每次重索引双库写放大。
- 写入时机 = `store_index_result` 同一事务:先 `DELETE ... WHERE source_path = ?` 再插入(`IndexedDocument` 增加 `links: Vec<ExtractedLink>` 字段,markdown 之外恒空);`clear_cached_document` / `clear_cached_document_by_key` / `clear_cache_storage` 同事务顺带删链接行。增量更新因此完全免费:watcher → refresh → (size,modified) 失配 → 重索引 → 链接行随之重写;文档删除 → 扫描清缓存 → 链接行同删。

### 3.3 查询(新 command)

| command(snake_case 参数) | wrapper(camelCase) | 返回(serde camelCase) |
|---|---|---|
| `list_document_links(relative_path: String)` | `listDocumentLinks(relativePath)` | `DocumentLinks { backlinks: Vec<BacklinkEntry>, outgoing: Vec<OutgoingEntry>, broken_count: u64 }` |

```rust
BacklinkEntry { source_path, source_title, link_text, count }       // 按来源文档聚合,count = 该文档指向本文的链接数
OutgoingEntry { kind,               // "document" | "asset" | "wiki"
                target_path: Option<String>,  // wiki 已解析成功时也填
                raw_target: String,           // wiki stem 或已解析路径(展示用)
                link_text, present: bool,     // 目标在当前扫描集合中
                ambiguous_count: u32 }        // wiki 多候选数;非 wiki 恒 0
```

- 实现:`validate_relative_library_path` 校验入参 → `current_root_and_document_paths` 取在场集合 → 三段查询:backlinks(`document_links_by_target` 命中 + wiki stem 反查)、outgoing(按 source)、`broken_count` = 出链中 `target_kind='document'` 且不在在场集合的条数(资产存在性不做 IO 检查,不计入断链,见 §7)。
- wiki 查询时解析:用在场集合构建两张 map——`小写文件名 stem → 路径列表`、`小写去扩展名全路径 → 路径`;唯一命中 → 建边(backlinks 与 outgoing 都生效),多候选 → `ambiguous_count = n` 不建边,零命中 → `present: false`。O(D) 构建,万篇 <5ms 量级。
- `source_title` 取自内存 `documents` 快照(标题已由索引管线维护),避免再查 `document_cache`。
- 只读 SELECT、无新权限;`library_root` 作用域与全部既有查询一致。

### 3.4 前端接线与 UI(BL-D3)

- 新纯模块 `src/lib/documentLinks.ts`:① 从 `App.tsx` **原样迁入** `resolveLibraryPath`(App 改 import,行为零变化,既有链接测试全部保持通过);② TS 版 `extractDocumentLinks(sourcePath, markdown)`(与 Rust 同一契约用例表,同时是 Web 实现);③ `resolveWikiTargets(stems, presentPaths)`。
- `SidePanelTab` 扩为 `"toc" | "annotations" | "library" | "links"`,第四 tab「链接」带反链数量徽标(沿标注 tab 徽标样式);窄窗抽屉自动获得同一 tab。
- tab 内容:「反向链接 N」分组列表(每行:来源标题 + 链接文本摘录 + 次数,点击 → `selectDocument(sourcePath)`)/「出链 M」列表(在场目标可点击跳转;`present: false` 灰显"目标不在库中";wiki 歧义显示"N 个候选"不可点)/顶部断链计数行。空态:"本文档没有库内链接"。
- 加载策略:首次切到 tab 时调 `listDocumentLinks(currentPath)`;`document-index-status`(当前文档)与 `documents` 快照变化时置 idle、下次进 tab 重拉——照抄全库 tab 的 idle 模式(`src/App.tsx` L2110-2121)。
- 点击出链**只走 `selectDocument`**(目标必须 `present`),永不触发外部协议;链接表内不存在外链条目,展示层无需二次防御但测试仍断言(见 §5)。

### 3.5 Web 端(BL-D4)

- `backend.ts` 新 wrapper `listDocumentLinks` 按 `APP_RUNTIME` 分流:桌面 invoke;Web 端 `loadSearchIndex()` 后对全部 `content` 跑 `extractDocumentLinks` + 内存聚合(与桌面同一返回形状),结果按 manifest 缓存,`refreshLibrary` 清除。
- 生成器**零改动**(不新增公开产物,不碰"只输出既定安全内容"边界)。
- 降级路径:`search.json` 文档数 > 500 时跳过计算,tab 显示"库过大,链接视图未启用"(常量导出,便于日后调整);若未来个人 Web 库确实变大,再评估备选 A(构建期 `links.json`,见 §6)。

### 3.6 安全

- 链接目标全程按不可信输入:提取期丢弃越界/绝对协议/`//`;入库的只有归一化相对路径字符串;查询只做集合成员判定,**不因链接表内容触碰文件系统**;跳转复用 `selectDocument` → `open_document` → `resolve_existing_in_root` 的既有 canonicalize 边界,零放宽。
- `link_text`/`raw_target` 展示为纯文本(React 默认转义,无 dangerouslySetInnerHTML)。
- 单文档 1,000 条链接上限 + `list_document_links` 返回各列表上限 500(截断加提示)。

## 4. 改动清单(预估)

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src-tauri/src/links.rs`(新)+ 内嵌测试 | 提取 + 解析纯函数、契约用例 | M |
| 2 | `src-tauri/src/library.rs` + 测试 | `document_links` DDL、`IndexedDocument.links`、事务写入/清理、`list_document_links` | M |
| 3 | `src-tauri/src/lib.rs` | 注册 command | S |
| 4 | `src/lib/documentLinks.ts`(新)+ `documentLinks.test.ts` | `resolveLibraryPath` 迁入、TS 提取/解析(契约基准 + Web 实现) | M |
| 5 | `src/lib/backend.ts` | `listDocumentLinks` wrapper(Web 分支) | S |
| 6 | `src/App.tsx` + `src/components/LinksPanel.tsx`(新)+ 测试 | 第四 tab、面板组件、idle 重拉 | M |
| 7 | `src/App.css`、`docs/USER_GUIDE.md` | 样式与文档 | S |

里程碑:**B0** 提取/解析纯函数 + Rust/TS 契约测试(无 UI、无存储,可独立合)→ **B1** 存储 + command + wrapper(Rust 测试齐)→ **B2** 「链接」tab + Web 端 + 视觉验收。远期(不在本方案):孤岛列表、全库图谱。

## 5. 验收标准

**B0(契约)**

- [ ] 契约用例表(`documentLinks.test.ts` 编号 L01…,Rust `links.rs` 测试注释引用同编号,≥16 例):同级相对(`./a.md`/`a.md`)、子目录、`../` 回退一级、`../` 越界丢弃、库根绝对(`/notes/a.md`)、`\` 分隔符、percent-encoding(中文文件名)、`?query`/`#fragment` 剥离、`//host` 丢弃、`https:`/`mailto:`/`file:`/`data:` 丢弃、空目标、`.` 段、fenced code 内链接不提取、inline code 内不提取、图片=asset kind、`[[wiki|别名]]`/`[[wiki#锚点]]` 的 stem/别名/锚点拆分。
- [ ] 断言两端对每个用例输出**同一** `(resolved 与否, target_path, kind, fragment)`;`resolveLibraryPath` 迁入后 `App.test.tsx` 既有链接/图片用例零改动通过。
- [ ] `pnpm test`、`pnpm exec tsc --noEmit`、`cargo test`、`cargo clippy -D warnings` 全绿。

**B1(存储与 command)**

- [ ] Rust 测试(library.rs 内嵌):索引一篇含 6 类目标的 markdown → `document_links` 行数/字段正确;改写文件重扫重索引 → 旧行被替换;删除文件重扫 → 行清空;`clear_conversion_cache` 后行清空;旧缓存库(无该表)打开自动补建;跨 `library_root` 隔离;1,001 条链接截断到 1,000。
- [ ] `list_document_links`:backlinks 聚合计数正确;wiki 唯一命中建边、双候选 `ambiguous_count=2` 不建边、新文档加入后同一查询歧义消解(不重索引);`broken_count` 只计缺失文档目标;非法路径入参(绝对/`..`)被拒。
- [ ] 契约回归:command 返回的解析结果与 B0 用例表一致(抽 5 例端到端断言)。
- [ ] 性能:合成 2,000 文档 × 平均 10 链接的缓存库,`list_document_links` 单次 < 50ms(Rust 测试 `Instant` 计时,上界宽松断言);全库索引耗时相对主干无可见回归(±10% 内,`--release` 手动对比一次并记录)。

**B2(UI 与 Web)**

- [ ] 组件测(`LinksPanel.test.tsx` + App 接线):四 tab 渲染与切换;反链条目点击触发 `selectDocument`;`present:false` 出链不可点且不触发任何 `openExternalLink`(断言 mock 未调用);空态/截断提示;标注 tab 既有测试不回归。
- [ ] 运行时(桌面):demo-library 造 3 篇互链文档(含 wiki 与 `../` 链接)→ 链接 tab 双向可见;外部编辑器新增一条链接保存 → watcher 刷新后 tab 重进显示新反链;删除被链文档 → 出链变灰、断链计数 +1。
- [ ] 运行时(Web):`pnpm dev:web` 同一批文档,链接 tab 与桌面结果一致(人工抽 3 篇对比);>500 篇降级文案路径用临时构造 manifest 验证一次。
- [ ] 截图矩阵:链接 tab 明/暗 × 宽(1280)/窄窗抽屉(720)≥ 4 张;`docs/USER_GUIDE.md` 新增「文档链接」一节。
- [ ] 全量回归:`pnpm test`、`tsc --noEmit`、`cargo test`、`cargo clippy -D warnings`、`pnpm build` 与 `pnpm build:web` 成功。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| BL-D1 | `[[wiki]]` 解析策略 | **按文件名 stem(大小写不敏感)匹配 + 查询时解析**;含 `/` 按去扩展名全路径匹配;歧义不建边、标注候选数 | 按标题匹配(标题重复率高、需维护标题索引,否);提取期解析(库变动即失效,需全量重索引,否);不支持 wiki(砍掉核心场景) |
| BL-D2 | 链接表存哪 | **缓存 sqlite `IF NOT EXISTS` 附加表,不 bump 版本**(派生数据,重建无损;未来变表再 bump,代价仅转换缓存重建) | 用户库 v5(派生数据进备份链 + 双库写放大,否);纯内存每次启动重建(万篇库启动全量读文,违背 metadata-first 扫描,否) |
| BL-D3 | UI 形态 | **侧栏第四 tab「链接」**(与目录/标注平级;PDF/EPUB 的反链有处安放;窄窗抽屉免费获得) | 文末区块(侵入三种渲染器,PDF/EPUB 无自然落点,否);全屏视图(信息密度撑不起,远期图谱再议) |
| BL-D4 | Web 端形态 | **运行时 TS 纯函数吃 `search.json`**(生成器零改动、契约只有两方);>500 篇降级停用 | 构建期输出 `links.json`(第三份实现 + 新公开产物,规模需要前不做);Web 不支持(白丢能力) |

## 7. 风险与开放问题

- **提取语义漂移是本方案最大风险**:`resolveLibraryPath` 今后在 App 侧的任何调整都必须同步 Rust 端——迁入 `src/lib/documentLinks.ts` + 双端编号用例表把这条约束固化成测试;PR 审查时把"改解析必须双端同改"写进 USER_GUIDE 旁的开发者注记。
- markdown 源里的链接是写作时语法,CommonMark 边角(嵌套括号、`<>` 包裹目标、转义)与 react-markdown 实际渲染存在长尾差异:提取器按"正文可点击的主流形式"覆盖,漏提只损失一条边不损失安全;用例表里显式固定已支持/不支持的边界。
- 资产出链不做存在性检查(避免查询期文件 IO):断链计数因此只反映文档目标,tab 文案写明"仅统计文档链接"。
- wiki stem 全库同名(如多个 `README.md`)会长期歧义:显示候选数已是诚实呈现,不自动挑选;远期图谱可给消歧 UI。
- 缓存软上限淘汰(非活跃库)会连带删除其链接行:重开该库自动重建,行为与转换缓存一致,无需特判。
