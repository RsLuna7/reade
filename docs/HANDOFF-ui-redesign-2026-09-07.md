# Reade 整体 UI 重设计交接

更新：2026-09-07。用于新对话继续设计讨论。

## 立即接续

用户要参与设计，当前处于需求与整体方向讨论，**不要直接开始改产品代码**。

先读本文件和 `docs/ui-redesign-workbook.md`。接着只问尚未回答的一件事：

> 三栏布局已确定。你平时主要读 PDF 教材／扫描书、EPUB 电子书，还是 Markdown 长文？

上一对话已提出这个问题，但用户尚未回答就要求交接；不要当作默认选择已提交。答案用于选择第一轮完整阅读窗口原型的内容，不影响三栏常驻这一已确认决定。

## 用户目标与协作偏好

- 用户认为按钮等控件描边太多、界面有“AI 感”，希望获得更流畅、舒服、有完成度的交互。
- 最初从侧栏开始，之后担心逐区域修改导致整体不协调，主动转向系统性设计流程。
- 用户明确说：“和我一步步来吧，你做决策以及相关的时候可以请求我的意见；我想更多的参与进去这个设计。”
- 每轮一个具体、容易回答的问题；用户两次要求重提较抽象的工具显隐问题，改成分别询问左侧、右侧是否常驻后得到明确回答。
- 给出推荐、原因和取舍，让用户参与关键决定；技术实现细节自行处理。不要重复询问已经确认的事情。
- 不因用户希望参与就每次都申请执行权限；当前需要的是设计选择与反馈。

## 已确认的设计决定

1. **第一优先使用路径：长时间读一本书，偶尔查目录、调设置。**
2. **左侧书库阅读时一直显示。**
3. **右侧章节目录也一直显示。标准桌面保持三栏常驻。** 不再主动建议默认隐藏两侧、悬停唤出或沉浸单栏。窄窗口沿用现有适配，之后另验。
4. 保留现有纸感、砖红与 Reade 品牌识别度，在整体协调基础上精修。
5. **侧栏阅读时间预估保留且常驻。** 用户不靠它选书，觉得有趣，把它当书本长度指标。不要改成剩余时间或阅读进度。
6. 用户已接受侧栏书名最多两行、时长放到下方说明行、同类文档行高一致、悬停不撑开。
7. 去掉格式徽章等重复描边，提高文字清晰度；按钮和菜单要有及时、连续的反馈。
8. 整体设计先行，再分区域实施；侧栏可以先落地，但先看它与完整阅读窗口的关系。

侧栏方案中具体字号、约 73px 行高、底栏按钮位置、动效时间只是首轮建议，不是用户逐项确认的最终设计变量。

## 工作流位置

已完成：技能检索与安装 → 侧栏评估 → 侧栏实施方案草案 → 全局源码界面盘点 → 使用路径与左右常驻确认。

接下来：

1. 确认常读格式，选取真实阅读场景。
2. 补齐该场景的完整窗口视觉证据，讨论顶部常用操作与信息优先级，不重新推翻三栏。
3. 记录产品事实，建立全局设计原则、共享颜色／文字／尺寸／组件状态／浮层／动效规则。
4. 做少量完整阅读窗口交互原型，让用户比较。避免继续只做孤立侧栏换皮。
5. 用户确认后形成正式设计规范与分批迁移计划，再开始实现和跨区域验收。

尚未创建 `PRODUCT.md` 或 `DESIGN.md`，也未选完整窗口新方案。不要把盘点记录当成已经定稿的设计系统。

## 已产出文件

- `docs/ui-redesign-workbook.md`：当前主要讨论记录；包含完整界面地图、三条使用路径、共享规则族、已确认决定和证据缺口。
- `docs/plan-sidebar-refinement.md`：侧栏子方案，状态待评审／未实施。包含布局、动效、源码映射、验证标准；服从未来整体设计系统。
- `.impeccable/critique/2026-09-07T05-04-10Z__src-app-tsx.md`：双路评估归档，26/40 为主观启发式初评，不是用户测试、性能或合规认证。
- 本文件：新对话接续入口。

本轮只增加设计文档与评估记录，**没有实现产品 UI 改版，没有提交或推送**。

## 四技能组合与停用情况

用户已明确要求四个全部安装并组合使用：

| 技能 | 用户级路径 | 分工 |
| --- | --- | --- |
| emil-design-eng | `D:/Codex/.codex/skills/emil-design-eng/SKILL.md` | 高频操作、按钮与动效手感 |
| impeccable | `D:/Codex/.codex/skills/impeccable/SKILL.md` | 全局视觉、评估与精修 |
| redesign-existing-projects | `D:/Codex/.codex/skills/redesign-existing-projects/SKILL.md` | 已有界面盘点与模板感诊断 |
| ui-ux-pro-max | `D:/Codex/.codex/skills/ui-ux-pro-max/SKILL.md` | 设计体系、信息层级和可读性参考 |

四个已安装，Impeccable Windows 引擎 `--version` 返回 4.0.0，UI UX 搜索脚本已验证可运行。

原 `frontend-design` 已按用户要求停用：目录入口从 `D:/Codex/.codex/skills/frontend-design` 移至 `D:/Codex/.codex/disabled-skills/frontend-design`。该入口是指向 `C:/Users/viper/.skills-manager/skills/frontend-design` 的 Junction，原文件未删除。不要恢复或继续调用旧技能。

技能建议按阅读器实际任务取舍，不照搬营销页面的噪点、视差、大标题、替换字体、自动装依赖等。用户要求和仓库约束优先。四个技能不等于必须四个代理并行；仅按适用规则使用代理。

## 评估中已核实的事实

- 图中的格式徽标占 28px，时长至少占 6.2em，同排挤压书名；源于 `src/styles/app-layout.css`。
- 文件树已经有鼠标悬停跑马灯，不能声称没有查看长标题的路径；问题在于辨认需要等待以及键盘／关闭动效时缺乏等价静止预览。
- 纸感主题 `--muted: #8b9290` 对侧栏 `--chrome: #f3efe6` 约 2.77:1。改善必要小字清晰度；不能把所有文字一并淡化。
- 已有三档动效变量，克制档 120/180/220ms、完整档 150/220/280ms；不是完全没有动画。
- **侧栏没有通用按压动画。** 曾在中途说“已有按压反馈”过于宽泛，最终报告已更正。
- 文件夹当前 `+ / −` 和子项条件挂载是直接切换；某些旧 `.tree-chevron` 规则不匹配当前树元素。
- 库菜单／树菜单引用 `reade-motion-panel` 类，但当前没有对应通用动效实现；风格选择面板有独立约 180ms 的实际过渡。
- 已有无障碍名称、键盘导航和当前项语义，不能误报“没有键盘支持”。
- 不为了填充空白增加卡片；保留熟悉图标体系，避免把系统字体或奶油色本身当作缺陷。

## 证据与验证限制

原用户截图：
`C:/Users/viper/AppData/Local/Temp/codex-clipboard-15d9706a-372a-4631-9347-aed4dadbae94.png`

早期方向小样：
`C:/Users/viper/.codex/visualizations/2026/09/07/01a07a2f-0a7e-7b51-ac47-69b29365476a/sidebar-study.html`
这是讨论用原型，未被选为最终方案，不能当当前产品或继续实现的模板。

浏览器评估截图：
`C:/Users/viper/AppData/Local/Temp/reade-assessment-b.png`

- CLI 对 `src/App.tsx` 和 `src/components/DocumentTree.tsx` 检测为 0 项，不代表样式或体验无问题。
- 浏览器用默认 desktop Vite、全新 headless 会话；没有切到冻结 Web 模式，也没有伪造书库 backend。
- 无 Tauri 导致真实本地库不能加载，有 `transformCallback` 事件注册报错；只能核实空库外壳与风格面板，不能证明真实阅读流程正常。
- 浏览器检测 22 条包括欢迎页和误报；Ctrl K 遮挡属于误报，颜色流行度规则不算实际缺陷。
- 浏览器、Vite 1437 和 Impeccable 8419 服务已关闭；临时日志清理，证据截图保留。新对话不要假设服务仍在运行。
- 未完整验收真实 Tauri 三栏、PDF／EPUB／Markdown 阅读、暗色／窄窗口、连续快速交互或掉帧。

## 仓库状态与边界

工作目录 `D:/Agent/13_Reade/reade`。先读项目 AGENTS.md，使用 PowerShell 与 pnpm。

本任务开始时及交接前已有以下其他工作区改动，不能覆盖、回滚或顺手提交：

```text
M src-tauri/Cargo.toml
M src-tauri/src/storage_migration.rs
M src-tauri/src/user_store.rs
M src/App.test.tsx
M src/AppCss.test.ts
M src/components/ReadingSettingsPanel.tsx
M src/styles/app-components.css
?? src/lib/localDataStatusDisplay.test.ts
?? src/lib/localDataStatusDisplay.ts
```

设计任务新增的未跟踪内容为 `.impeccable/`、侧栏方案、设计工作册和本交接文件。接手时重新检查实际状态。

`src/App.css` 当前只按顺序导入五层 CSS；不要继续依赖旧公约中“大 CSS 单体”的描述。真实样式位于 `src/styles/app-base.css`、`app-layout.css`、`app-formats.css`、`app-components.css`、`app-views.css`，主题在 `theme-tokens.css`。

保持本地优先、安全渲染、现有前后端契约。当前讨论不授权改数据库、Rust、权限、依赖、Web 功能、提交或发布。
