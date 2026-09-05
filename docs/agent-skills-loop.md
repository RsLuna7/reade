# Reade 智能体闭环

把一次会话里会消失的纠错，变成可审查、可版本化、下次自动生效的文件。
不把自我进化 Agent 做进阅读器产品，也不上云端编排。

## 三层分别是什么

| 层 | 是什么 | Reade 落点 |
| --- | --- | --- |
| 内层 / Base Skill | 稳定程序：「如何在本仓库做事」 | 根目录 `AGENTS.md`（always-on） |
| 人类反馈 | 工作现场的纠偏，写清 Why | 聊天里纠正；可选写入 `.agents/learnings.md` |
| 外层 / Improver | 离线蒸馏，只提小补丁，人审后才生效 | `/improve-reade-agents`（`.agents/skills/improve-reade-agents/`） |

## Skills ≠ Memory ≠ always-on Rules

- **Skills**（`.agents/skills/*/SKILL.md`、`tools/skills/*/SKILL.md`）：按需加载的流程。启动时只看到 name/description，匹配任务后才读正文。适合长清单、组件组合、设计评审。
- **`AGENTS.md` / always-on rules**：每次任务都进上下文。只放短、稳定、全仓库都适用的公约。越长越稀释。
- **Cursor Memory**：推理时自动写入、一直在变，不是仓库规范。可复用的纠错不要只存在 Memory 里。

嵌套目录里的 `AGENTS.md` 也会被 Cursor 当 always-on 注入。领域技能只用 `SKILL.md` + `references/`，不要再放一份 `AGENTS.md`。

## 怎么给反馈

1. 当场纠正即可；Agent 可以提议「是否写入 Learned guidelines」，**等你点头再改 `AGENTS.md`**。
2. 一次任务的口味、尚未重复的失误：写入 `.agents/learnings.md`，标成 one-off 或待蒸馏。
3. 同类失误能用测试抓住时，**先补回归测试**，不必再写成自然语言教条。
4. 需要蒸馏时，手动调用 `/improve-reade-agents`。Improver 只改 `## Learned guidelines` 的增量，禁止整篇重写 `AGENTS.md`，禁止自行提交或合入。

## 当前范围

- **做**：公约短小、Learned guidelines 有上限、大 Skill 按需加载、测试当 verifier。
- **不做**：Warp Oz、定时云 Agent、Issue 点赞工厂、DSPy/GEPA、产品内嵌自我进化 Agent。
