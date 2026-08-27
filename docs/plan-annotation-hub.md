# 实施方案:全库批注中枢

> **已被代码取代 / 勿按本文施工。** 产品与实现规格以 [`plan-annotation-system-redesign.md`](./plan-annotation-system-redesign.md) 为准。本文保留为历史设计记录；全库视图现称「全库摘录」，颜色不作知识分类。

- 日期:2026-08-12
- 状态:**已实施后被 v6 收口**（侧栏「全库」tab 已撤；档案，勿按本文施工）
- 定位:把现有侧栏「全库」tab 升级为真正的批注中枢——可检索、可过滤、可分文档导出、能看到失联文档的批注;二期给它一个全屏视图。桌面端激活已经建好却尚未暴露的批注 FTS 索引。
- 关联:存储与检索基建来自批注 v2(`docs/research-annotation-data-models.md` §5.2 已实现);「不再回顾」的恢复入口(回顾方案 R-D4)与手动重绑列表(研究 §5.6)预留在本中枢的 M3。

> 一句话:桌面端加一个 `search_annotations` command 直接吃现成的 `annotations_fts`(trigram),Web 端用同构纯函数过滤;侧栏 tab 先长出搜索框 + 类型/颜色筛选 + 分组折叠 + 按文档导出,二期再升全屏中枢并收编"失联文档"批注。

---

## 1. 现状基线(全部【已核实】于本仓库源码)

| 事实 | 位置 |
|------|------|
| **FTS 索引已存在但无人使用**:`annotations_fts`(FTS5,`content='annotations'`,**tokenize='trigram'**,三触发器同步),`searchable_text = selected_text + '\x1f' + note`(NFKC 归一,`unicode_normalization`) | `src-tauri/src/user_store.rs` L536-556、L1213、L42 |
| 现有 commands 只有 list/upsert/delete/clear/detect_moved/rebind;`list_annotations(None)` 返回全库 live 批注(墓碑已滤,updatedAt 降序) | 同上 L235-343;`src-tauri/src/lib.rs` L52-57 |
| 侧栏「全库」tab 已有:按文档分组、刷新、导出全库(Markdown→剪贴板)、点击跳转(跨文档 pendingAnnotationJump 链) | `src/App.tsx` L715-827、L1520-1631;`src/components/AnnotationUi.tsx` L390-501 |
| 加载策略:首次打开 tab 时 `listAnnotations()` 全量拉取;当前文档批注变化置 idle 下次重拉 | `src/App.tsx` L1520-1543 |
| 分组构建:`Map<relativePath, Annotation[]>` + 文档标题映射,**批注路径不在 documents 里时标题回退 `fileName(path)`,无失联提示** | `src/App.tsx` L1545-1561 |
| Markdown 导出纯函数 `buildAnnotationsMarkdown`(分组、位置排序、引用块、笔记、位置、日期)已有测试;导出走剪贴板,**无文件落盘、无新权限** | `src/lib/annotationExport.ts` L87-148;`src/App.tsx` L1585-1631 |
| Web 端无 FTS:`listWebAnnotations(null)` 全量 + 内存操作;IndexedDB v3 | `src/lib/webAnnotations.ts` L128-140 |
| 文档失联的既有处理:打开/刷新库时 move-detection 自动提示迁移;歧义候选仅 console.info,"集中重绑列表"是研究 §5.6 留下的空位 | `src/App.tsx` L1942-1987 |
| 库搜索输入防抖 240ms 的既有模式 | `src/App.tsx` L2006-2011 |
| `Annotation.sortIndex`(16 字符位置键)可跨文档排序;`annotationPositionLabel` 供来源文案 | `src/lib/backend.ts` L174-179;`src/lib/annotationExport.ts` L45-62 |

## 2. 目标与非目标

**目标**

1. 批注全文检索:桌面走 FTS5(激活既有索引),Web 走同构内存过滤;双端结果一致。
2. 筛选(类型 × 颜色)+ 分组折叠 + 按文档/按筛选结果导出。
3. 失联文档的批注可见、可导出(不再沉默地混在普通分组里)。
4. 二期:全屏中枢视图(与 stats/home 平级),侧栏 tab 保留为轻量入口。

**非目标(明确不做)**

- JSON 信封导出/导入(研究 §5.7)不进本方案——那是独立的互操作项目,涉及去重与墓碑语义;本中枢的导出维持"Markdown → 剪贴板"零权限路线。
- 不做批注的批量编辑/批量删除(误伤面大,单条操作已够用)。
- 不引入虚拟滚动依赖(个人规模用分组折叠 + 每组截断解决)。
- 不做跨库检索(检索范围 = 当前打开的库,与全部现有 command 的 `library_root` 语义一致)。

## 3. 设计

### 3.1 检索

**桌面:新 command `search_annotations`**

| 参数(snake_case) | 返回 |
|---|---|
| `query: String, limit: usize`(上限 500) | `Vec<Annotation>`(live,按 `sort_index` 组内可排,整体按 `relative_path, sort_index`) |

- 查询预处理与 `build_searchable_text` 同规:NFKC + 小写。
- **trigram 的 CJK 短查询坑**:trigram tokenizer 需要 ≥3 个字符才可匹配,而中文双字词是高频查询。规则:
  - `query` 归一后 ≥3 字符 → `annotations_fts MATCH ?`,查询串整体包成 FTS 短语(内部 `"` 双写转义后再加外层引号),杜绝 FTS 查询语法注入;
  - <3 字符 → 回退 `searchable_text LIKE '%' || ? || '%' ESCAPE '\'`(对 `%`/`_`/`\` 转义);
  - 两条路径都叠加 `library_root = ? AND deleted_at IS NULL`。
- 不引入 bm25 排序:结果按文档分组展示,组内位置排序,相关度排名对个人库无增益(简单性优先)。

**Web + 契约:纯函数 `src/lib/annotationSearch.ts`**

```ts
normalizeAnnotationQuery(raw: string): string            // NFKC + 小写 + trim
annotationMatchesQuery(a: Annotation, q: string): boolean // selectedText/note/title 归一后 includes
filterAnnotations(items, { query?, kinds?, colors? }): Annotation[]
```

- Web 端检索 = `listWebAnnotations(null)` + `filterAnnotations`(百级规模,内存足够)。
- **双端一致性约定**:桌面 FTS/LIKE 与 Web `includes` 对"连续子串"查询语义一致(trigram 恰好是子串匹配的索引化);契约用例表以 TS 测试文件为准,Rust 测试注释引用同一批用例(中文 2 字/3 字、英文大小写、NFKC 全角半角、note 命中、title 命中、墓碑排除)。
- 检索命中范围含 `title`(书签标题):桌面 `searchable_text` 现在只含 selected_text+note——**书签 title 不在 FTS 里**。处理:`search_annotations` 对 <limit 的 FTS 结果再并一条 `title LIKE` 的补充查询(同转义),避免动 schema;Web 纯函数天然覆盖。(决策点 A-D3 可改为 v5 迁移把 title 并进 searchable_text,推荐先不动 schema。)

**前端接线**

- 全库 tab 顶部加搜索框(placeholder"搜索全库标注",240ms 防抖,复用既有模式);桌面输入 ≥1 字符即调 `search_annotations`,Web 调纯函数;清空恢复全量列表。
- 筛选行:类型三态 chip(高亮/下划线/书签)× 颜色四点(复用 `annotation-color-swatch` 样式),纯前端过滤(与检索结果求交)。
- 检索/筛选状态下的计数行:"命中 N 条,来自 M 个文档"。

### 3.2 分组与失联

- 分组逻辑升级(`src/lib/annotationHub.ts` 纯函数化,现在的 `libraryGroups` useMemo 迁入):
  - 普通组:路径在 `documents` 中,按路径排序;
  - **失联组**:路径不在 `documents` 中 → 归入列表末尾的「已失联文档」区(组头灰显 + 提示"文档已移动或删除,标注仍保留"),条目不可跳转但可导出/删除;
  - 组头可折叠(本地 state,不持久化);每组默认显示前 20 条 + "展开全部 N 条"。
- 组头动作:「导出该文档」(单文档 `buildAnnotationsMarkdown` → 剪贴板);全局动作保留「导出全库」,检索/筛选激活时变为「导出当前结果」。

### 3.3 全屏中枢视图(M2)

- `activeView` 增加 `"annotations"`(沿 stats/home 的挂载模式,lazy `AnnotationHubView`);侧栏 tab 保留,tab 顶部加「在中枢中打开」链接。
- 布局:左列筛选(检索框、类型、颜色、文档列表快捷定位),右列分组卡片流(与侧栏共享同一套分组/条目组件,仅容器与密度不同);≤900px 退化为单列(筛选折叠为顶部行)。
- 入口:侧栏 footer 不再加第四个图标(拥挤),入口 = 全库 tab 内链接 + 今日视图可选卡片(批注总数,低优先)。
- 中枢内点击条目跳原文的行为与现状一致(`selectDocument` 自动切回 reader)。

### 3.4 性能

- 现状 `listAnnotations(None)` 全量返回;个人规模(≤ 数千条)下瓶颈在渲染而非 IPC。预算(进验收):2,000 条批注打开 tab < 300ms、检索一次击键(防抖后)< 100ms、中枢视图首帧 < 500ms。
- 分组折叠 + 每组截断把首屏 DOM 控制在 ~200 节点内;超预算的后手(不在本期):`search_annotations` 已天然支持 limit,可加分页参数。

### 3.5 安全

- 新 command 全部只读(SELECT);query 长度上限 256 字符,超限截断;FTS 短语包裹 + LIKE ESCAPE 转义进 Rust 测试;`library_root` 作用域与既有 command 一致;无新权限、无网络、无 schema 变更(A-D3 取推荐项时)。

## 4. 改动清单(预估)

| # | 落点 | 内容 | 量级 |
|---|------|------|------|
| 1 | `src-tauri/src/user_store.rs` + 内嵌测试 | `search_annotations`(FTS/LIKE 双路径 + title 补充查询) | M |
| 2 | `src-tauri/src/lib.rs` | 注册 command | S |
| 3 | `src/lib/annotationSearch.ts`(新)+ 测试 | 归一化 + 过滤纯函数(双端契约) | S-M |
| 4 | `src/lib/annotationHub.ts`(新)+ 测试 | 分组/失联/截断纯函数(从 App.tsx 迁入) | S-M |
| 5 | `src/lib/backend.ts` | `searchAnnotations` wrapper(Web 分支走纯函数) | S |
| 6 | `src/components/AnnotationUi.tsx` + 测试 | tab 内搜索框/筛选行/折叠组/失联组/导出粒度 | M |
| 7 | M2:`src/components/AnnotationHubView.tsx`(新)+ 测试 | 全屏中枢 | M-L |
| 8 | `src/App.css`、`docs/USER_GUIDE.md` | 样式与文档 | S |

里程碑:**A1** 检索 + 筛选 + 分组折叠 + 按文档导出(全在侧栏 tab 内,含 Rust command)→ **A2** 全屏中枢 + 失联组 → **A3(可选,另行立项)** FTS snippet 高亮、手动重绑列表(研究 §5.6)、「不再回顾」恢复入口(回顾方案 R-D4)、JSON 信封(研究 §5.7)。

## 5. 验收标准

**A1(检索与筛选)**

- [ ] Rust 测试(user_store 内嵌):
  - 中文 3+ 字查询 FTS 命中;中文 2 字走 LIKE 且命中;英文大小写不敏感;NFKC(全角字母/兼容字符)归一命中;
  - note 命中、selectedText 命中、书签 title 命中(补充查询路径);
  - 墓碑排除;`library_root` 隔离(第二个库的数据不可见);
  - 注入安全:query 含 `"`、`%`、`_`、`\`、FTS 操作符(`OR`/`NEAR`/`*`)时不报错、按字面匹配;
  - limit 生效与 500 上限;256 字符截断。
- [ ] 双端契约:`annotationSearch.test.ts` 用例表(≥12 例,覆盖上述矩阵)与 Rust 测试断言的命中集合一致(Rust 侧注释标注对应 TS 用例编号)。
- [ ] 组件测(AnnotationUi):搜索防抖后触发一次调用;筛选与检索求交;空结果态文案;组折叠/展开;「导出该文档」剪贴板内容等于单文档 `buildAnnotationsMarkdown` 输出;既有全库 tab 测试全部保持通过。
- [ ] 运行时(桌面):3 个文档 30 条真实批注,中文双字词检索 → 命中跳转正确;性能预算脚本注入 2,000 条(直接写 `reade-user.sqlite3`)后:打开 tab < 300ms、检索响应 < 100ms(console.time 佐证)。
- [ ] 运行时(Web):`pnpm dev:web` 同一批操作走通,桌面/Web 对同一查询的命中集合一致(人工抽 3 例)。
- [ ] 回归:`pnpm test`、`tsc --noEmit`、`cargo test`、`cargo clippy -D warnings` 全绿。

**A2(中枢与失联)**

- [ ] 组件测:失联组渲染(灰显、不可跳转、可导出);`activeView: "annotations"` 路由;中枢与侧栏共享组件的双容器渲染。
- [ ] 运行时:把一个有批注的文档移出库目录 → 刷新 → 批注出现在失联组且可导出;把文件移回 → 恢复普通分组(或走 move-detection 自动迁移提示,两条路径都验证);明/暗 × 宽/窄截图 ≥ 4 张(侧栏 + 中枢各一组)。
- [ ] `docs/USER_GUIDE.md` 「全库标注」章节更新;README 能力清单同步。

## 6. 决策点

| # | 决策 | 推荐 | 备选 |
|---|------|------|------|
| A-D1 | 中枢形态优先级 | **先侧栏 tab 强化(A1),后全屏(A2)**——高频价值先落地 | 直接做全屏、tab 只留摘要(一步到位但首个可用版本晚) |
| A-D2 | 检索结果排序 | **按文档分组 + 组内 sortIndex**(可预期) | bm25 相关度排序(个人库无增益,否决) |
| A-D3 | 书签 title 检索 | **command 内补充 LIKE 查询,不动 schema** | 用户库 v5 把 title 并入 searchable_text(动 FTS 触发器与回填,收益小) |
| A-D4 | 失联组的重绑操作 | **本期只读展示**,重绑走既有 move-detection;手动重绑列表进 A3 | A2 直接做手动重绑(文档选择器 + 逐条 TextQuote 验证,工作量 +L) |

## 7. 风险与开放问题

- trigram 对 1-2 字查询无索引可用,LIKE 全表扫描:2,000 条规模无感;若未来批注上万,考虑 `searchable_text` 前缀索引或最小查询长度提示。
- 检索命中不含高亮 snippet(A3 再做):侧栏条目已显示摘录前缀,可用性够。
- 失联组与 move-detection 的交互:文件移动后先出现在失联组、下次打开库时被自动迁移提示"收编"——两个机制解决同一问题的不同阶段,文案要避免让用户以为是两种东西(失联组提示语点明"若文件仍在库内新位置,刷新后会提示迁移")。
