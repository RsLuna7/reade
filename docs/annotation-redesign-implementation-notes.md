# 标注系统重设计实施账本

- 开始日期：2026-08-25
- 规格：`docs/plan-annotation-system-redesign.md`
- 状态：**下一轮进行中（D-012）：PDF/EPUB 文字选区 `createExcerpt` + 侧栏 DocumentAnnotationsView（页段/章节）。阶段 0–6 + D-011 已收口**

## 冻结基线

### 工作区原有改动

- `src/App.css`：用户已有正文居中改动，必须保留。
- `src/AppCss.test.ts`：用户已有对应回归测试，必须保留。
- `.cursor/`、`skills/`、`skills-lock.json`：用户已有未跟踪内容，不纳入本任务。

### 2026-08-25 基线验证

| 验证 | 结果 |
|---|---|
| `pnpm exec tsc --noEmit` | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 114 passed / 0 failed |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | 通过 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 通过 |
| `pnpm test` | 1249 passed / 2 failed（102 files 中 2 files 各 1 项） |

前端两项失败均为日期边界基线问题，不属于标注范围：

1. `src/components/HomeView.test.tsx`：期望“10 分钟”，跨午夜后组件计算为“0 秒”。
2. `src/components/StatsView.test.tsx`：期望“阅读 2 天”，当前日界下为“阅读 1 天”。

本任务不得修改统计产品代码掩盖这两项；最终报告单独列出。标注定向测试与新增测试必须全绿。

## 实施验收账本

- [x] 阶段 0：v5 fixture 与迁移真值
- [x] 阶段 1：模型、校验、分组、三色色板
- [x] 阶段 2：SQLite/IndexedDB v6 与双写（含 `search_annotation_entries` / `record_excerpt_review_outcome`）
- [x] 阶段 3：Markdown 最小垂直切片（静默标记 + 按章节/感悟；PDF/EPUB 仍用旧捕获）
- [x] 阶段 4：PDF/EPUB 锚点诚实度 + 文字选区 `createExcerpt`（书签仍 upsert；无文本层不可摘录）
- [x] 阶段 5：间隔回顾改为 enrollment-only；主页去掉今日回顾卡；命令面板 / 全库摘录入口；ArchiveV2 导出与 v1 导入兼容
- [x] 阶段 6：README / USER_GUIDE / 旧计划文档取代声明（Web + Tauri Markdown 明暗抽检已做；完整 §12 矩阵与 PDF/EPUB 真机仍未做）

## 暂停点（2026-08-25 晚；下一轮 PDF/EPUB 新捕获进行中）

- 阅读主路径：默认划选 →「标记 / 更多」；顶栏可开连续落笔（三色）。
- **D-012**：Markdown/PDF/EPUB 文字选区统一 `createExcerpt`；书签仍 upsert；无文本层不可摘录。
- **侧栏**：三格式均用 `DocumentAnnotationsView`（Markdown 标题 / PDF Outline 或 20 页段 / EPUB 章节）；失效与「旧版面位置」仍由下方 `AnnotationList` 诚实展示。
- HomeView/StatsView 跨午夜测试仍是基线失败，不要改。
- Web 不新增 PDF/EPUB 阅读能力。

## 偏差记录

### D-001：Excerpt 保留 `legacyTitle`

- 发现：v5 `Annotation.title` 可能来自导入或重定位时保留的用户值；原规格的 Excerpt 没有承载它，无法完成逐字节反向投影。
- 保守取舍：在 Excerpt 增加 `legacyTitle: string | null`，仅用于旧表双写、迁移 checksum 和 v1 导出；新 UI 不暴露第二套标题概念。
- 影响：纯新增兼容字段，不改变已确认交互或用户数据含义。

### D-002：Excerpt 保留 `legacySelectedText`

- 发现：v5 sanitizer 允许 mark 的 `selected_text` 为 null；新 Excerpt 为可显示性会用 locator quote 补 `sourceText`，若不另存原值，反向投影会把 null 改成文本。
- 保守取舍：新增 `legacySelectedText: string | null`；新 UI 使用非空 `sourceText`，旧表/校验和投影使用原始 legacy 值。
- 影响：只增加兼容信息，不放宽新建 Excerpt 的非空约束。

### D-003：ReadingPlace 保留旧 color/selectedText

- 发现：早期 cache-resident bookmark 行可以残留非 null `color` 或 `selected_text`；现代 UI 不生成，但 v1 rescue 测试证明它是被支持的历史形态。
- 保守取舍：ReadingPlace 新增 `legacyColor`、`legacySelectedText`，只用于反向投影与兼容导出。
- 影响：新 ReadingPlace 仍写 null，不把这些字段带回新 UI。

### D-004：不可解析 root 使用 legacy fallback

- 发现：v2 迁移曾允许坏 locator 保留并赋 `BROKEN_SORT_INDEX`；若 v6 要求所有行可解析，会让一个坏行阻断整个用户数据库启动。
- 保守取舍：每个 `library_root` 在 SAVEPOINT 内迁移；解析/对账失败只回滚该 root 的 v6 副本且不写 ready ledger，该 root 继续走旧 repository。其他 root 不受影响，任何行都不删除。
- 影响：规格原“任一坏行使整库迁移失败”收敛为“任一坏 root 禁止启用新 UI”；数据安全更强，产品迁移更可用。

### D-005：PDF 未绘制页保持 unchecked

- 发现：原版式按页懒渲染；未进入视口的页没有 text layer，不能把存储 rect 标成 geometricFallback，否则列表会把尚未验证的条目说成「旧版面位置」。
- 保守取舍：有存储 rect 但 text layer 未就绪时为 `unchecked`，不进 broken，也不进 geometric 集合。用户滚动到该页后再判定 exact / approximate / geometric / detached。
- 影响：列表诚实状态随已绘制页逐步出现，符合 Unchecked「不显示红色错误」。

### D-006：`upsert_annotation` 在 v6 ready 时双写

- 发现：阶段 4 文件表未列 `user_store.rs`，但 Desktop `upsert_annotation` 原先只写 legacy 表。Markdown `createExcerpt` 之后的重定位会改 locator 却不刷新 v6 `source_revision`，与 Web `projectAnnotationIntoV6` 分叉。
- 保守取舍：ledger ready 时 `upsert_annotation` 事务内 legacy 写入 + `mirror_legacy_annotation_into_v6`；保留已有 Excerpt tone / `legacy_color` / `created_at`，并用当前文档指纹刷新 `source_revision`。未 ready 的 fallback root 仍只写旧表。不把 PDF/EPUB 新捕获改成 `createExcerpt`。
- 影响：旧捕获路径（PDF/EPUB 选区、书签、重定位）在已迁移库上与 Web 一样进入 v6；新 UI 捕获仍只有 Markdown `createExcerpt`。

### D-007：全库定位状态筛选未做

- 发现：`AnchorResolution` 只在打开文档时按当前 revision 计算，全库列表没有每条摘录的 exact/detached 状态。
- 保守取舍：阶段 5 落地「有感悟 / 已加入间隔回顾」筛选；来源文档仍用左列文档导航。不伪造全库定位状态 chip。
- 影响：规格「默认筛选含定位状态」延后，避免把未检查条目标成失效。

### D-008：ArchiveV2 extras 在标注导入之后尽力补写

- 发现：现有 `import_annotations` 只写 v5 行；把 reflections / enrollments / collections 放进同一 SQLite 事务需要新的 Rust command。
- 保守取舍：导出写完整 v2（v5 documents + 能收集到的 v6 extras + collections + 偏好 + checksum）。导入先走现有 dry-run/确认写 v5；确认后再逐条 `upsertReflection` / `setReviewEnrollment`。过期 `dueAt` 可能导致进度恢复失败，不回滚已导入标注。v1 envelope 继续可读。
- 影响：回滚物比 v1 完整；跨进程单事务和完整 Leitner 进度还原仍待专门 command。

### D-009：IndexedDB v5 备份先读后写

- 发现：`backupLegacyStores` 并行打开源库只读事务与备份库写事务；Chromium 会在空写事务上过早 auto-commit，后续 `put` 抛 `TransactionInactiveError: The transaction has finished`，迁移 ledger 停在 `pending`，`createExcerpt` 报「标注升级未完成」。
- 保守取舍：先把源库各 store `getAll` 读进内存快照并等事务完成，再打开备份库写入；失败后若 meta 带 `error` 允许重试备份。
- 影响：Web 新建摘录恢复可用；fake-indexeddb 与真浏览器行为对齐。Desktop SQLite 路径不受影响。

### D-010：移除顶栏旧标注工具并统一三色 chrome

- 发现：顶栏 `AnnotationToolsPanel`（浏览/高亮/下划线 + 四色荧光）与静默选区工具条并存；改色气泡、列表、全库筛选、Hub 图例、ScrollMap、`--annot-*` UI chrome 仍用旧四色。
- 保守取舍：删除顶栏入口与连续落笔路径；改色/筛选/设置只暴露 sand/sage/slate；砂色筛选含 legacy pink；`--annot-*` 别名到 `--excerpt-*`。PDF/EPUB 侧栏仍用 `AnnotationList`（已三色），新捕获仍不改 `createExcerpt`。`annotationTool` / `highlightColor` 等 store 字段保留兼容，UI 不再驱动。
- 影响：阅读主路径只剩划选 →「标记 / 更多」；旧粉数据在筛选暖砂时仍可见。

### D-012：PDF/EPUB 文字选区改走 createExcerpt

- 发现：阶段 3–4 故意让 PDF/EPUB 新捕获继续 `upsertAnnotation`；v6 模型、`buildExcerptDraftFromPending` 与捕获器早已支持 pdfText/epub。
- 保守取舍：`handleSaveMark` 在 content.kind 与 locator.kind 同为 markdown/pdf/epub 时统一 `createExcerpt`；书签与其它非选区路径仍 upsert。扫描 PDF 无文本层时 `captureReaderSelection` 仍返回 null，不伪造文字摘录。侧栏三格式共用 `DocumentAnnotationsView`；broken / approximate / geometricFallback 仍叠 `AnnotationList`。
- 影响：Desktop PDF/EPUB 静默标记进入 v6 Excerpt + 三色 appearance + 按页段/章节回看；不改变锚点诚实度回报与 Web 格式边界。

任何后续偏离规格的保守取舍都必须先写在此处，再继续实现。
