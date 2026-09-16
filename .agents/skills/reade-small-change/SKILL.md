---
name: reade-small-change
description: >
  Focused Reade bugfix or small-feature loop: inspect related source and tests,
  make a minimal patch, run the smallest verification, and report what was not
  verified. Use when the user asks to fix a bug, tweak one interaction, optimize
  a small reading-surface behavior, land a regression, or 修 bug / 优化小功能 /
  定点改阅读体验. Do not load for architecture redesign, Web-only features,
  AGENTS.md distillation, or visual redesign/review.
---

# Reade small change (on demand)

This skill is **not** always-on. Load it when the task is a bugfix or a small
optimization. Follow `AGENTS.md`; do not copy it here.

Do not load `vercel-composition-patterns`, design skills (`impeccable` and
similar), or `/improve-reade-agents` unless the user explicitly asked for
component API redesign, visual review, or convention distillation.

If the failure is intermittent or has no agent-runnable repro, stop guessing:
capture a pass/fail signal first. Do not patch from a plausible reading of
the code.

## 1. Inspect before editing

- Read the related implementation, existing tests, and already-dirty files.
- Keep the user's in-progress diff. Do not revert or reformat unrelated files.
- Name the intended file set before the first edit. Stay inside it unless a
  test or typecheck proves a neighbor must change.

## 2. Patch only the seam

- Prefer `src/lib/` for pure logic, the store for shared state, Rust/Tauri for
  permissions and filesystem. Do not bypass IPC from the frontend.
- Edit `App.tsx` / `App.css` only at the needed site. Do not rewrite or
  restyle the file.
- Treat Markdown, filenames, links, images, Mermaid, and the library tree as
  untrusted input. Do not relax CSP, capabilities, path checks, or Mermaid
  limits unless the task says so and includes verification.
- Desktop-only for new behavior. Do not add `IS_WEB_RUNTIME` branches or Web
  product work unless the user asked, or a shared change broke Web build/security.

## 3. Tests follow the behavior

When behavior changes, update the matching test in the same change. Pointers:

- Markdown / URL policy → `src/components/MarkdownRenderer.test.tsx`
- PDF / EPUB reading → `PdfReader.test.tsx`, `EpubReader.test.tsx`, and
  `src-tauri/src/documents.rs` when the parser DTO changes
- Tree / path normalize → `src/lib/tree.test.ts`
- Reader preferences → `src/store/useReaderStore.test.ts`
- IPC names / DTO → both TypeScript wrapper and Rust tests; commands live in
  `src-tauri/src/lib.rs`

If the same class of mistake can be caught by a test, add the test. Do not
turn it into a guideline.

## 4. Verify the smallest loop

From the repo root, PowerShell. Do not invent `pnpm lint`.

1. Run the tests that cover the files you touched.
2. If types or IPC shapes changed, run `pnpm exec tsc --noEmit`.
3. If Rust changed, run the matching `cargo test` (and clippy when the change
   is more than a string/DTO tweak).
4. Layout, scroll, TOC follow, zoom, or responsive behavior: tests passing is
   not enough. Use a real Tauri window or a screenshot. Theme and narrow width
   when those surfaces moved.

Skip the full frontend + Rust matrix unless the change crossed modules.

## 5. Report and stop

Do not commit unless the user asked in this turn.

Finish with four short facts:

1. Files and user-visible behavior
2. Why this seam (especially security or architecture)
3. Commands actually run, and their result
4. What was not verified, plus residual risk

Do not claim done without the evidence from step 4.
