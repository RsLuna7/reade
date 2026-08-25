# Handoff：Reade 标注系统重设计

- 日期：2026-08-25（傍晚更新）
- 分支：`main`（未提交）
- 状态：**阶段 0–6 代码已接线；Web 视觉抽检 + Desktop Tauri Markdown 明暗截图已落盘；D-009 已修。真实 PDF / 桌面划词静默标记 / EPUB 窄窗仍缺；PDF/EPUB 新捕获仍走旧路径**
- 规格真源：`docs/plan-annotation-system-redesign.md`
- 实施账本：`docs/annotation-redesign-implementation-notes.md`
- 视觉证据：`output/playwright/annotation-redesign-2026-08-25/`（含 `VISUAL-REPORT.md`）

## 1. 接手前必须知道

1. 完整阅读根目录 `AGENTS.md`、规格和实施账本。
2. 不要回滚或覆盖用户原有的 `src/App.css`、`src/AppCss.test.ts` 改动：
   - `.article-shell` 居中；
   - vertical writing 下 `margin-inline: 0`；
   - 对应 “centers a measured article” 测试。
3. 不提交、不发布，除非用户另行授权。
4. 阶段 0–6 代码与 D-009 Web 备份修复已接线。不要开始 PDF/EPUB `createExcerpt` 新捕获。
5. `.cursor/`、`skills/`、`skills-lock.json` 是用户已有未跟踪内容，不纳入本任务。

## 2. 已确认的产品方向

- 阅读时只做静默标记；保存不得自动切换右侧标注 tab。
- 感悟通常读完后由用户主动补写；系统不做文末提醒、主页到期卡或收件箱催促。
- 三种低彩度、非语义颜色：`sand/sage/slate`（暖砂/青灰/墨蓝）。
- 用户主动复盘时：按原文章节查看全部重点，或切“我的感悟”只看带 Reflection 的条目。
- 新摘录不自动加入间隔回顾；只有 `ReviewEnrollment` 才有队列资格。
- 旧数据必须迁移、对账、双写、可回滚；PDF 旧 rect 不得冒充精确文本定位。

## 3. 已完成并落盘

### 3.1 规格与账本

- `docs/plan-annotation-system-redesign.md`
- `docs/annotation-redesign-implementation-notes.md`（含 D-001..D-009）
- 本 handoff；视觉报告见 `output/playwright/.../VISUAL-REPORT.md`

### 3.2 TypeScript 阶段 0/1

- `annotationMigrationFixture.ts` / `annotationModel.ts` / `annotationValidation.ts` / `annotationOutline.ts` 及对应测试
- `App.css` 三色 `--excerpt-*` tokens + `AppCss.test.ts`

### 3.3 Rust / 前后端阶段 2–6

- `USER_SCHEMA_VERSION = 6`；v6 DDL、ledger、双写、MIG 测试
- Commands 已注册；`backend.ts` / `tauriBackend.ts` / IndexedDB v6 twin
- Markdown 静默标记 MVS；PDF/EPUB 锚点诚实度（新捕获仍 `upsertAnnotation`，D-006 双写）
- Enrollment-only 回顾；主页无「今日回顾」；ArchiveV2；README / USER_GUIDE 已更新

### 3.4 Web 修复与抽检

- **D-009**：`webAnnotationV6.ts` 备份先读后写，消除 `TransactionInactiveError` /「标注升级未完成」
- Web：`01-mark-keeps-toc`、窄窗 bottom sheet、色板抽样、按章节面板等（见视觉报告）

### 3.5 Desktop Tauri 抽检（本轮）

- `pnpm tauri dev` 已能跑起；先前与 `pnpm dev:web` 抢 1420 端口，需先释放
- 用户库 `.New`（非 demo-library）上用 **UIA + PrintWindow** 自动截得：
  - `tauri-01-md-toc-light.png`
  - `tauri-02-md-annotations-light.png`
  - `tauri-03-md-annotations-dark.png`
- `tauri-05-pdf-annotations-panel.png`：**点选未切入 PDF**，画面仍是 Markdown，不可当作 PDF 证据
- 划词「标记」桌面自动化仍不可靠；Cursor `computer-use` 本会话无工具挂载

## 4. 历史编译阻塞（已解决，勿当当前状态）

早期 handoff 曾记录 `user_store.rs` command 外壳缺 helper、`cargo check` E0425。**现已全部补齐并接线**。若再出现编译错误，按当前源码诊断，不要按本节旧清单照搬。

## 5. 推荐接手顺序（残余验收）

1. Desktop：用户划词一次或加固选区自动化 → 截「标记后仍停在目录」
2. Desktop：在用户库点开真实 PDF → 验收「旧版面位置」/ GeometricFallback 并截图（勿依赖 demo-library）
3. EPUB 窄窗；可选连续手工标记约 20 次
4. 仍不要开始 PDF/EPUB `createExcerpt`，除非用户明确授权

## 6. 当前验证状态

| 验证 | 结果 |
|---|---|
| `pnpm exec vitest run src/lib/webAnnotations.test.ts src/lib/webAnnotationRepository.test.ts` | 28 passed（含 v5→v6 备份回归） |
| Web 视觉抽检（色板 + 关键场景） | 已落盘 |
| Desktop Tauri Markdown 明暗 · 目录/标注面板 | 已落盘（`tauri-01`…`03`） |
| Desktop 划词静默标记保 TOC | 未做（自动化难） |
| Desktop 真实 PDF GeometricFallback | 未做（`tauri-05` 失败） |
| EPUB 窄窗 / 连续 20 次标记 | 未做 |
| HomeView / StatsView 跨午夜日期测试 | 基线失败，不要改 |

下一接手：优先补桌面划词证据与真实 PDF 截图。方案代码侧已完成。不要开始 PDF/EPUB `createExcerpt`。

## 7. 工作区文件边界

任务相关已修改/新增（不完全列表）：

```text
docs/plan-annotation-system-redesign.md
docs/annotation-redesign-implementation-notes.md
docs/HANDOFF-annotation-redesign-2026-08-25.md
docs/USER_GUIDE.md
README.md
output/playwright/annotation-redesign-2026-08-25/*   # 含 VISUAL-REPORT.md、Web + tauri-*.png
src/lib/annotation*.ts
src/lib/webAnnotation*.ts
src/lib/backend.ts
src/lib/tauriBackend.ts
src-tauri/src/user_store.rs
src-tauri/src/lib.rs
src/App.css
src/AppCss.test.ts
src/App.tsx
src/components/AnnotationUi.tsx
src/components/DocumentAnnotationsView.tsx
src/lib/annotationCapture.ts
src/lib/useDocumentAnnotations.ts
src/lib/useDocumentAnnotationBundle.ts
src/store/useReaderStore.ts
```

PDF/EPUB **新捕获**路径未改成 `createExcerpt`。不纳入：`.cursor/`、`skills/`、无关改动。

## 8. 完成定义

不要把「方案代码接线」或「Web/MD 抽检」当成全部完成。最终仍需：

- 真实 Tauri 关键证据（划词静默标记、PDF 诚实锚点、可选 EPUB 窄窗）；
- 全量测试/构建与未验证项如实报告；
- 用户授权前不做 PDF/EPUB `createExcerpt`。
