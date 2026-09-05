---
name: improve-reade-agents
description: >
  Distill staged agent learnings into a small AGENTS.md Learned guidelines
  patch. Use only when the user asks to improve AGENTS.md, run the improver,
  distill learnings, or update agent conventions from feedback. Do not run
  during ordinary feature or bugfix work.
disable-model-invocation: true
---

# Improve Reade agent conventions

You are the outer / Improver half of Reade's agent loop. Distill human
corrections into **generalizable** guidelines, propose a small edit, and stop
for review. You do not ship product code.

Read `docs/agent-skills-loop.md` if the loop itself is unclear.

## Inputs

- Inner skill: `AGENTS.md` (stable body + `## Learned guidelines` + `<!-- reade-agents v:N -->`)
- Staging: `.agents/learnings.md`
- Optional: the user pastes recent chat corrections

Do not scan unrelated files. Do not load `vercel-composition-patterns` or design skills.

## Step 1: Collect signals

Read `.agents/learnings.md` and any feedback the user pasted. Weight:

1. Repeated, explicit corrections with Why (strong)
2. `promote` entries (strong)
3. One-off taste, weak or conflicting notes (do not promote)
4. Anything a targeted test would catch → prefer a test, not a guideline

Silence is not a signal. If there is nothing well-supported, report
`no changes warranted` and stop. An empty run is valid.

## Step 2: Synthesize lessons

Each lesson is a **category** of mistake plus the correct handling, with Why.

Good: "Do not bump `CACHE_SCHEMA_VERSION` for additive cache tables (full reindex)."
Bad: "In yesterday's chat the agent edited the wrong file."

Never promote `one-off` entries.

## Step 3: Edit only Learned guidelines

If and only if you have at least one well-supported lesson, edit `AGENTS.md`:

- Change only `## Learned guidelines` (and the `<!-- reade-agents v:N -->` comment).
- Append or revise bullets. Each bullet is one imperative sentence plus `(why: …)`.
- If a lesson conflicts with an existing bullet, revise or remove the old one.
- At most **12** bullets. At the cap, merge overlapping items or drop the weakest.
- Increment `v:N` when this section changes.
- If a lesson belongs in an existing always-on section (Web 封存, IPC, 安全),
  say so in the proposal and **do not** silently rewrite that section.

### Guardrails

- Never rewrite the whole of `AGENTS.md`.
- Never add nested `AGENTS.md` under `tools/skills/` or `.agents/`.
- Never commit, push, or merge unless the user explicitly asked in this turn.
- Leave `.agents/learnings.md` entries that were promoted marked `promoted`
  (keep the text for audit) or move them under a `## Promoted` heading.
  Leave `one-off` entries as-is.

## Step 4: Propose, do not self-apply to main

Show a short report:

- Signals reviewed (count and kind)
- Each lesson and its evidence
- Exact guideline text added, changed, or removed
- Whether a regression test would be a better fix

Wait for the user to accept before leaving the `AGENTS.md` edit in place if
they asked for a proposal-only pass. If they asked you to apply the patch,
keep the diff small and stop after the files above.
