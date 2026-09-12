# 实施方案:合集/阅读清单

- 日期:2026-08-13
- 状态:**已实施**
- 定位:跨文件夹把文档组成命名清单——"考研数学"收数学一真题 PDF 与错题笔记,"组会论文"收散在各目录的 EPUB/PDF。文件系统目录是存放结构,合集是阅读结构;两者解耦,文件一个字节不动。
- 关联:存储沿用批注 v2 建立的用户库迁移链与双端同构约定(`docs/plan-annotation-review.md` §3.3 是 v4 的先例,本方案是 **v5**);进度徽标直接消费「今日视图」H0 落地的 `readingPositions`(`docs/plan-home-view.md` §3.2);失联/重绑复用 `documents` 指纹链(`docs/research-annotation-data-models.md` §5.5)。
- 契约红线:合集只存**库内相对路径字符串**,一切文件访问仍走既有 command 边界;删除合集只删清单,永不触碰文档与批注。

> 一句话:用户库迁移 v5 加 `collections` + `collection_items` 两表(IndexedDB v5 同构),8 个 CRUD commands(列表带文档数与在库数);侧栏文档树上方长出「合集」分区,行内显示格式徽标 + 阅读进度(来自 readingPositions);加入合集走 topbar 动作的轻量 popover;文档移动后由既有 rebind 链顺带迁移合集条目,未迁移的灰显保留。

---

## 1. 现状基线(全部【已核实】于本仓库源码)

| 事实 | 位置 |
|------|------|
| 用户库迁移链现状:`USER_SCHEMA_VERSION = 4`,`run_migration_chain` 按步跑 `migrate_to_v{1..4}` 单事务 + 每步写 `user_version`;**新步骤必须接 `5 => migrate_to_v5`** | `src-tauri/src/user_store.rs` L51、L589-612 |
| 升级前自动 `VACUUM INTO` 备份(有数据时),版本棘轮拒绝更高 schema | 同上 L559-584、L823-842 |
| v4 先例 DDL(`annotation_reviews`)与"迁移不回填、惰性初始化"的注释风格 | 同上 L779-803 |
| `documents` 指纹表(v3):`(library_root, relative_path) → content_hash`,消失路径**故意保留**作重绑线索 | 同上 L755-777 |
| 重绑链就绪:`detect_moved_documents` 产出候选(歧义标记),`rebind_document_annotations(old_path, new_path)` **单事务**迁移批注并删旧指纹;前端全库 tab 已有失联组 + 重绑 UI | 同上 L335-368;`src/App.tsx` L2189-2203;`src/lib/documentMoves.ts` L20-94 |
| command 模式:`State<AppState>` + `State<UserState>`、`validate_relative_library_path` + `normalize_root` 作用域、`ensure_document_in_open_library` 在场校验、跨库 ownership 校验先例 | `src-tauri/src/user_store.rs` L260-315;`src-tauri/src/library.rs` L1440-1450;`user_store.rs` L1754-1763 |
| 字段上限常量先例:`MAX_ANNOTATION_ID_CHARS = 64` 等,id 由前端生成、后端校验 | `src-tauri/src/user_store.rs` L78-82 |
| 在场集合快照 `current_root_and_document_paths` 已 pub(crate)(算"仍在库中"计数用) | `src-tauri/src/library.rs` L1671-1688 |
| Web 端 IndexedDB `reade-annotations` 当前 **`DB_VERSION = 4`**,`onupgradeneeded` 按 `oldVersion` 顺序步骤,已有 stores:`annotations`/`documents`/`annotationReviews`;新步骤接 `oldVersion < 5` | `src/lib/webAnnotations.ts` L16-46、L84-111 |
| 阅读进度数据就绪:`readingPositions`(localStorage)存 `maxScrollRatio`(scroll)/`maxPage`(pdf)单调高水位,`listLibraryReadingPositions(root)` 一次取整库 | `src/lib/readingPositions.ts` L20-44、L165-169 |
| 进度 → 展示的纯函数先例:`progressFromPosition` → `{kind:"ratio",value}` \| `{kind:"page",page}`(PDF 总页数未知,只能显示"第 N 页") | `src/lib/homeData.ts` L19-48 |
| 侧栏结构:`sidebar-content` 目前只有 `<DocumentTree/>`;树行是**整行 `<button>`**(内嵌次级按钮是无效 HTML,hover 动作需重构行结构);树由 `buildDocumentTree` 纯函数构建 | `src/App.tsx` L3317-3319;`src/components/DocumentTree.tsx` L168-196;`src/lib/tree.ts` L56-102 |
| 目录展开状态经 zustand persist 持久化并在库切换时 reconcile(合集展开态可对照该模式取舍) | `src/store/useReaderStore.ts` L186、L318-331、L591-598 |
| topbar-actions 现有:库开关/目录开关/标注工具(popover 先例 `AnnotationToolsPanel`)/阅读设置;Reade **无右键菜单体系** | `src/App.tsx` L3410-3488 |
| `selectDocument(path)` 自动回 reader 视图,任何视图点合集条目都能直接开读 | `src/store/useReaderStore.ts` L271、L407-413 |
| 批注导入/导出信封只含 annotations + fingerprints(合集不进信封 → 非目标依据) | `src/lib/backend.ts` L433-480 |

## 2. 目标与非目标

**目标**

1. 创建/重命名/删除命名合集;把文档加入/移出合集;手动排序;双端(SQLite v5 / IndexedDB v5)同构。
2. 侧栏「合集」分区:展开显示条目(标题 + 格式徽标 + 进度徽标),点击直接开读;失联条目灰显。
3. 合集列表带 `itemCount` 与 `presentCount`("仍在库中"),一眼看出清单健康度。
4. 文档移动后条目跟着走:`rebind_document_annotations` 同事务顺带迁移 `collection_items`。
5. **删除合集不删文档**:只删 `collections` + `collection_items` 行,文档、批注、进度全部无损(确认弹层文案写明)。

**非目标(明确不做)**

- 不做嵌套合集/子清单(个人规模一层足够)。
- 不做智能合集(按规则/标签自动收录)——合集是手工策展。
- 不做多端同步、不进批注导入导出信封(§5.7 信封语义只覆盖批注域;远期若要迁移合集另行立项)。
- 不做合集与今日视图/统计的联动卡片(远期:今日视图"清单进度"卡)。
- 不做拖拽排序(见 CO-D4)、不发明右键菜单体系。

## 3. 设计

### 3.1 存储:用户库迁移 v5

`USER_SCHEMA_VERSION` 4 → 5,`run_migration_chain` 增 `5 => migrate_to_v5`(自动获得 v4 备份 `reade-user.backup-v4.sqlite3` + 棘轮):

```sql
CREATE TABLE collections (
    id TEXT PRIMARY KEY,              -- 前端 crypto.randomUUID,后端校验(≤64 字符,同批注 id 规则)
    library_root TEXT NOT NULL,
    name TEXT NOT NULL,               -- trim 非空,≤100 字符(MAX_COLLECTION_NAME_CHARS)
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX collections_by_root ON collections(library_root, created_at ASC);
CREATE TABLE collection_items (
    collection_id TEXT NOT NULL,
    library_root TEXT NOT NULL,       -- 冗余存根,查询免 JOIN、作用域过滤同构
    relative_path TEXT NOT NULL,
    position INTEGER NOT NULL,        -- 手动排序,0 起,合集内连续
    added_at INTEGER NOT NULL,
    PRIMARY KEY (collection_id, relative_path)
);
CREATE INDEX collection_items_by_collection ON collection_items(collection_id, position);
CREATE INDEX collection_items_by_path ON collection_items(library_root, relative_path);
```

- 不设外键(与 `annotation_reviews` 同派头,`user_store.rs` L781 注释先例);孤儿防御在 command 层(删合集同事务删条目)。
- `relative_path` 只存归一化相对路径字符串,不存指纹——条目身份 = 路径,路径失效由 §3.4 处理。

**Web:IndexedDB v5**(同一 `reade-annotations` 库):`onupgradeneeded` 追加 `oldVersion < 5` 步骤,新建 store `collections`(keyPath `"id"`)与 `collectionItems`(keyPath `["collectionId", "relativePath"]`,index `"collectionId"`);记录形状与桌面 camelCase 返回逐字段一致。

### 3.2 IPC 契约(8 个 commands,全部走 `State<AppState>` + `State<UserState>`)

| command(snake_case 参数) | wrapper(camelCase) | 返回(serde camelCase) | 校验要点 |
|---|---|---|---|
| `list_collections()` | `listCollections()` | `Vec<CollectionSummary>`:`{ id, name, created_at, updated_at, item_count, present_count }` | `present_count` 用 `current_root_and_document_paths` 在场集合逐条判定 |
| `create_collection(id: String, name: String)` | `createCollection(id, name)` | `Collection` | id ≤64 字符;name trim 非空 ≤100;同库同名允许(不设唯一约束,靠 UI 提示) |
| `rename_collection(id: String, name: String)` | `renameCollection(id, name)` | `()` | name 同上;id 必须属于当前 `library_root`(ownership 先例) |
| `delete_collection(id: String)` | `deleteCollection(id)` | `()` | 单事务删 items + 本行;**不触碰 documents/annotations** |
| `list_collection_items(collection_id: String)` | `listCollectionItems(collectionId)` | `Vec<CollectionItem>`:`{ relative_path, position, added_at, present }` | 按 `position ASC`;`present` 同上;title/format 由前端 `documents` 补(不在返回里,避免双份标题来源) |
| `add_collection_item(collection_id: String, relative_path: String)` | `addCollectionItem(collectionId, relativePath)` | `CollectionItem` | `validate_relative_library_path` + `ensure_document_in_open_library`(加入时必须在库);`position = COALESCE(MAX+1, 0)`;重复加入幂等返回既有行 |
| `remove_collection_item(collection_id: String, relative_path: String)` | `removeCollectionItem(collectionId, relativePath)` | `()` | 不存在时报错(与 `delete_annotation` 一致) |
| `reorder_collection_items(collection_id: String, ordered_paths: Vec<String>)` | `reorderCollectionItems(collectionId, orderedPaths)` | `()` | 集合必须与现有条目**恰好相等**(多/少/重复都拒),单事务重写 position 0..n-1 |

- wrapper 全部进 `src/lib/backend.ts` 按 `APP_RUNTIME` 分流;Tauri 侧 `invoke("add_collection_item", { collectionId, relativePath })` 等,参数名两端逐一对应;Web 分支落 `src/lib/webCollections.ts`(游标 + 同一校验纯函数)。
- 所有查询/写入均带 `library_root = ?` 作用域;`updated_at` 在 rename 与条目增删/重排时推进(列表按 `created_at` 稳定排序,见 CO-D4 备注)。

### 3.3 UI:侧栏「合集」分区 + topbar 加入动作(CO-D1/CO-D2)

- 新组件 `src/components/CollectionsSection.tsx`,挂在 `sidebar-content` 内 `<DocumentTree/>` **上方**;搜索模式(`searchQuery` 非空)时整段隐藏(搜索结果独占侧栏,现状语义)。
- 分区结构:标题行「合集」+ 数量 + 「新建」图标按钮(inline 输入命名,Enter 确认/Esc 取消);每个合集一行(名称 + `presentCount/itemCount` 徽标),点击展开条目列表;展开态为组件内 state(session-only,对照标注中枢折叠组的取舍,不进 persist——避免动 preferences 信封)。
- 条目行:格式徽标(复用 `document-tree__format` 样式)+ 标题(前端由 `documents` map 补;失联条目回退 `fileName(path)` 并灰显 + title 提示"文档已移动或删除")+ **进度徽标**:`listLibraryReadingPositions(rootPath)` + `progressFromPosition` → ratio 显示"62%"、pdf 显示"第 12 页"、无记录不显示;点击 → `selectDocument(path)`(失联条目不可点)。
- 条目行 hover/聚焦时显示「上移/下移/移出」小按钮(行容器用 `div[role=treeitem]` + 内部多按钮,不复用 DocumentTree 的整行 button 结构);上移/下移即时调 `reorderCollectionItems`(整序提交,失败回滚本地态)。
- **加入合集入口(CO-D2)**:topbar-actions 在标注工具旁加「加入合集」图标按钮(lucide `FolderPlus`,仅 `currentContent` 存在时显示),点击弹 popover(复用 `AnnotationToolsPanel` 的挂载/关闭模式):列出全部合集 + 当前文档在/不在的 checkbox(勾选即 `addCollectionItem`,取消即 `removeCollectionItem`)+ 底部"新建合集并加入"。
- 删除合集:合集行 overflow 菜单(展开态组头的「重命名/删除」两个文字按钮,不新造菜单组件),删除需 `window.confirm`,文案:"删除合集「X」?清单内 N 篇文档本身不会被删除。"
- 数据加载:打开库后首次展开分区时 `listCollections()`;条目在展开单个合集时按需 `listCollectionItems`;写操作后本地乐观更新 + 失败重拉(与批注列表的既有节奏一致)。

### 3.4 失联与重绑(CO-D3)

- 文档改名/移动后,`collection_items.relative_path` 失配 → `present: false` 灰显(§3.3),**数据保留不自动删**。
- 推荐:`rebind_annotation_rows` 的既有事务里追加两句——`UPDATE OR IGNORE collection_items SET relative_path = ?new WHERE library_root = ? AND relative_path = ?old` + `DELETE FROM collection_items WHERE library_root = ? AND relative_path = ?old`(处理"目标路径已在同一合集"的主键冲突残留)。语义:用户在既有失联重绑 UI 里确认一次,批注和合集条目**一起**跟着内容走;Web 端 `rebindWebDocumentAnnotations` 同步补同构逻辑。
- 不为合集单独做失联列表/重绑 UI(批注失联组已是同一入口;无批注但进了合集的文档移动后,靠灰显 + 手动移出/重加,接受——见 §7)。

### 3.5 安全与性能

- 全部写入经 id/name/path 白名单校验;`relative_path` 永不用于文件访问(打开文档走 `selectDocument` → `open_document` 的 canonicalize 边界);无新权限、无网络、零新依赖、不动 CSP/capability。
- 规模预算:个人库合集 ≤50 × 条目 ≤500;`list_collections` 双计数一条 SQL + 内存集合判定,万篇库 <10ms;进度徽标读 localStorage 一次成 map,O(items) 查找。

## 4. 改动清单(预估)

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src-tauri/src/user_store.rs` + 内嵌测试 | 迁移 v5、8 个 commands、rebind 事务追加 | M-L |
| 2 | `src-tauri/src/lib.rs` | 注册 8 个 commands | S |
| 3 | `src/lib/webCollections.ts`(新)+ 测试;`src/lib/webAnnotations.ts`(v5 升级步骤 + rebind 同构) | Web 同构层 | M |
| 4 | `src/lib/collections.ts`(新)+ 测试 | 校验/排序/进度映射纯函数(双端契约点) | S |
| 5 | `src/lib/backend.ts` | 8 个 wrapper 双分支 | S-M |
| 6 | `src/components/CollectionsSection.tsx`(新)+ 测试 | 侧栏分区 | M |
| 7 | `src/App.tsx` | topbar 按钮 + popover + 分区挂载与数据流 | M |
| 8 | `src/App.css`、`docs/USER_GUIDE.md` | 样式与文档 | S |

里程碑:**C0** 迁移 v5 + commands + Web 同构层(无 UI,双端测试齐,可独立合)→ **C1** 侧栏分区 + topbar 加入动作(可用闭环)→ **C2** 排序/失联灰显/rebind 迁移 + 视觉验收。

## 5. 验收标准

**C0(存储与 commands)**

- [ ] Rust 测试(user_store 内嵌):v4→v5 迁移幂等(重复打开不重复建表)、迁移前 `reade-user.backup-v4.sqlite3` 存在、`user_version = 5`、既有四表数据无损;棘轮拒绝 v6 库。
- [ ] Rust 测试(CRUD):空 name/101 字符 name/65 字符 id 被拒;跨 `library_root` 的 rename/delete/add 被拒(ownership);`add_collection_item` 对不在库文档被拒、重复加入幂等且 position 不变;`position` 连续递增;`reorder` 集合不等(多一条/少一条/重复)被拒、成功后顺序持久;`delete_collection` 后 items 清空而 `annotations`/`documents` 行数不变(**删合集不删文档**的直接断言);`list_collections` 的 `item_count`/`present_count`(构造一条失联路径)正确。
- [ ] Web 测试(`webCollections.test.ts` + `webAnnotations.test.ts`,fake-indexeddb):v4→v5 升级后旧批注/回顾数据可读;**双端契约 fixture**——同一批操作序列(建 2 合集、加 5 条目、重排、删 1 合集)在两端产出相同的 `listCollections`/`listCollectionItems` 快照(TS 模块内定义用例,Rust 测试注释对齐编号)。
- [ ] 两端类型同步:8 个 wrapper 的 invoke key 与 Rust 参数名逐一核对(测试断言拼写);`CollectionSummary`/`CollectionItem` TS 类型与 serde camelCase 输出字段一致(tsc + 一条端到端反序列化测试)。
- [ ] `cargo test`、`cargo clippy -D warnings`、`pnpm test`、`tsc --noEmit` 全绿。

**C1(可用闭环)**

- [ ] 组件测(`CollectionsSection.test.tsx`):空态(无合集时只有新建入口);新建 → 列表出现;展开加载条目;条目点击调 `selectDocument`;失联条目灰显不可点;进度徽标:ratio→"62%"、pdf→"第 3 页"、无记录不渲染(mock `listLibraryReadingPositions`);搜索模式下分区隐藏。
- [ ] 组件测(App 接线):topbar 按钮仅在有文档打开时出现;popover 勾选/取消触发 add/remove 且计数徽标更新;"新建合集并加入"一步完成。
- [ ] 运行时(桌面):demo-library 建"考研数学"合集收 3 个目录下的 md/pdf/epub → 重启应用合集仍在(SQLite 持久化);读到 PDF 第 5 页后合集行显示"第 5 页"。
- [ ] 运行时(Web):`pnpm dev:web` 同流程走通(DevTools 查 IndexedDB v5 佐证)。

**C2(完成态)**

- [ ] Rust 测试(rebind):`rebind_document_annotations` 后 `collection_items` 的 old→new 迁移;目标已在同合集时旧行被清、不重复;无合集条目的 rebind 行为不变(既有测试回归)。
- [ ] 运行时:把合集内文档移到新目录 → 刷新 → 条目灰显;经全库 tab 重绑确认 → 条目恢复可点且路径已更新(Web 端同流程);上移/下移后重启顺序保持;删除合集确认弹层文案含"不会被删除"。
- [ ] 截图矩阵:合集分区(展开态 + 失联灰显)× 明/暗 ≥ 4 张,窄窗(720)下 popover 与分区各 1 张;`docs/USER_GUIDE.md` 新增「合集」一节;README 能力清单同步一行。
- [ ] 全量回归:`pnpm test`、`tsc --noEmit`、`cargo test`、`cargo clippy -D warnings`、`pnpm build`、`pnpm build:web`。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| CO-D1 | 信息架构 | **侧栏文档树上方「合集」分区**(合集是"从哪开始读"的入口,与树同屏零切换;搜索时让位) | 全屏合集视图(为 ≤50 条数据开新 activeView,重);侧栏第四 tab(「链接」方案已竞争该位,且合集与文档树同为"选文档"心智,不该分 tab) |
| CO-D2 | 加入合集交互 | **topbar 动作 + popover**(作用于当前文档,复用 `AnnotationToolsPanel` 模式,零新组件体系) | 文档树行 hover 动作(树行是整行 button,嵌套按钮需重构行结构 + 触控不可达);右键菜单(Reade 无此体系,不为单功能发明) |
| CO-D3 | 失联条目处理 | **rebind 事务顺带迁移 + 未重绑灰显保留**(与批注"内容即身份"同语义,一次确认两类数据一起走) | 仅灰显失联、永不自动迁移(用户每次移动文件要手工重加,清单在整理库时必然腐坏);按指纹即时自动改写(无确认环节,歧义场景危险,否) |
| CO-D4 | 条目排序交互 | **hover/聚焦上移下移按钮 + `position` 字段**(键盘可达、无依赖;合集列表本身按 `created_at` 固定序不重排) | 拖拽排序(需引入依赖或大量手写 DnD,窄窗/触控边界多,否);仅按加入时间排(手动策展场景里顺序即大纲,砍掉伤核心价值) |

## 7. 风险与开放问题

- **无批注文档的失联盲区**:重绑链靠"该路径有 live 批注"触发(`detect_moved_rows` 只查 annotated 路径),纯合集成员移动后不会出现在重绑候选里,只能灰显——个人库可手动移出重加,接受;若日后痛,扩展 detect 把"合集成员"也纳入缺失路径来源(数据结构已备好,`collection_items_by_path` 索引就是为它留的)。
- IndexedDB 复合 keyPath(`["collectionId","relativePath"]`)在 fake-indexeddb 与真实浏览器行为需一并验证(C0 测试 + C1 运行时双覆盖);若遇兼容性坑,退路是拼接字符串主键 `${collectionId}\u001f${relativePath}`(记录在 webCollections.ts 注释)。
- 进度徽标依赖 H0 的 localStorage 数据:换机器/清存储后徽标消失但合集无损——徽标定位是"提示"不是"记录",USER_GUIDE 写明。
- `list_collections` 的 `present_count` 依赖内存扫描快照:库刚打开、扫描未完成的瞬间可能少计——分区在 `snapshot` 就绪后才渲染(与 DocumentTree 同一数据门槛),实际不可见。
- 同名合集允许创建可能造成困惑:新建时前端做同名提示(不做硬约束,重命名即可解),观察使用再定。
