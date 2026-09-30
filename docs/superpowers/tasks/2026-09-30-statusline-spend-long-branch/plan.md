# Statusline: keep session spend visible with long branch names - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The session cost segment stays visible on narrow (13-14") terminals when the git branch or project name is long.

**Architecture:** No width signal is used (stdout is piped, so `process.stdout.columns`/`COLUMNS` are likely undefined). Two changes in `buildStatusLine()`: (1) cap project (10) and branch (20) with ellipsis truncation; (2) move the session cost segment to sit immediately before the context bar. All other segments keep their order.

**Tech Stack:** TypeScript (ESM), Vitest, esbuild bundle. No new imports or dependencies.

Commit per task using the repository's existing convention (Conventional Commits, `.ai-run/guides/standards/git-workflow.md`).

**Ticket:** EPMCDME-15429 (MR/PR/commit reference). The guide mandates `<type>(<scope>): <subject>` with an allowed scope (use `agents`), and says NOT to put the ticket key in the subject. Reference it in the commit body footer instead, for example `Refs: EPMCDME-15429`. Use the same `fix(agents): ...` format for the MR/PR title.

## Acceptance criteria

- [ ] Session cost (`$N.NNNN`) is present within the first ~100 visible columns for typical inputs, including a 40+ char branch and a 25+ char project name.
- [ ] A long branch or project name cannot push the cost segment out of view.
- [ ] Project and branch names are truncated with an ellipsis: project to 10 visible characters and branch to 20, brackets and parens excluded.
- [ ] Segment order is project | budget | branch | model | cost | context bar | tokens | duration, and output for short inputs differs only by the cost position.

## Assumptions

- "Spend amount" means the session cost segment. The budget segment (`$X (NN%) resets <date>`) is unchanged and stays right after the project name.
- Width is not detected. Honoring `process.stdout.columns`/`COLUMNS` is out of scope (unverified signal, not needed for the criteria).
- Budgets apply to the inner name text, with the ellipsis included: truncate to budget-1 characters plus `…`. The surrounding `[ ]` and `( )` are added outside the budget. Named constants: `MAX_PROJECT_CHARS = 10`, `MAX_BRANCH_CHARS = 20`.
- With a typical ~30-char budget segment and a `[Claude Sonnet 5]`-length model, the cost ends near column 99. Without a budget segment it ends near column 70.
- The model label is deliberately not capped (out of scope). A very long routed `model → actualModel` label can still push cost further right; this is a known residual.
- `statusline.ts` is the only deployed statusline. Legacy `session-status.mjs` and the stale installer comment are out of scope.

## Files

- Modify: `src/agents/plugins/claude/plugin/statusline.ts` (`buildStatusLine`, lines 610-640, plus a new helper and constants above it)
- Test: `src/agents/plugins/claude/plugin/__tests__/statusline.test.ts` (`describe('buildStatusLine')`, lines 173-220)

### Task 1: Truncation helper and project/branch caps

- [ ] **Step 1: Write failing tests.** Add `truncate` to the test file's imports from `../statusline.js`. Add a `describe('truncate')` block and `buildStatusLine` tests.
  - `truncate('short', 10)` returns `'short'`. `truncate('a'.repeat(30), 10)` returns 9 `a`s plus `…`, length exactly 10. A string exactly at the limit is returned untouched. Non-string or empty input returns `''`.
  - `buildStatusLine` with a 45-char branch: strip ANSI, extract the text inside `(` `)`, and assert it is exactly 20 characters ending in `…` and that the full branch is absent. A 25+ char `projectName` gives exactly 10 characters inside `[` `]`, ending in `…`. In both cases `$1.5000` is still present.
- [ ] **Step 2: Implement.** Add the helper and constants below (new symbols). In `buildStatusLine`, wrap `projectName` (line 613) with `MAX_PROJECT_CHARS` and `branch` (line 616) with `MAX_BRANCH_CHARS`, adding the brackets and parens outside the truncation.
- [ ] **Step 3: Run** `npx vitest run src/agents/plugins/claude/plugin/__tests__/statusline.test.ts` and confirm it passes.
- [ ] **Step 4: Commit** with a `fix(agents): ...` subject and the ticket footer described in the header.

Test-first: yes - a 45-char branch must render as exactly 20 inner characters ending in `…`, which fails until `truncate` exists and is applied.

```ts
const MAX_PROJECT_CHARS = 10;
const MAX_BRANCH_CHARS = 20;

// Ellipsis-truncate to at most `max` visible characters (code points, so surrogate pairs are not split).
export function truncate(text, max) {
  if (typeof text !== 'string') return '';
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}
```

### Task 2: Move session cost before the context bar

- [ ] **Step 1: Write failing tests.**
  - Update the existing test at `statusline.test.ts:201-206` (budget ordering). Keep its project < budget < branch assertions and add `indexOf('(main)') < indexOf('$1.5000')`, `indexOf('[Claude Sonnet 5]') < indexOf('$1.5000')` and `indexOf('$1.5000') < indexOf('████░░░░░░')`, so the test fails until the cost moves.
  - Add a worst-case test with a 60-char `projectName`, an 80-char branch, budget text `'$12.34 (41%) resets 7/15/2026'` and the `basic` model. Strip ANSI with `line.replace(/\x1b\[[0-9;]*m/g, '')`. Assert the visible `$1.5000` ends at or before column 100, and that in the raw line the cost precedes the bar, `in:` and `1m 5s`.
- [ ] **Step 2: Implement.** In `buildStatusLine` (lines 610-640), move the session-cost `if` block (lines 627-634, comment included) to directly after the model push (line 617) and before `const bar = ctxBar(ctxPct)` (line 619). Leave every other segment where it is.
- [ ] **Step 3: Run** the statusline test file, then `npm run typecheck`. Both must pass.
- [ ] **Step 4: Commit** with a `fix(agents): ...` subject and the ticket footer described in the header.

Test-first: yes - with the current order the cost renders after the bar and stats, so the ordering assertions and the column-100 bound fail until the block is moved.

## Self-review

- negative-constraints: (1) "do NOT reorder segments generally" is honored because Task 2 moves only the cost block and every other segment keeps its position. (2) "no dependence on a width signal, no optional width detection" is honored because Tasks 1-2 use fixed constants and ordering only. (3) "drop routed-model and other caps" is honored because only project and branch are capped, and model, budget text and everything else stay uncapped. (4) "no new imports, esbuild-bundleable, no security.js/keytar" is honored because `truncate` is a local pure function. (5) "budget behavior unchanged" is honored because budget text is neither capped nor moved. (6) The guide's "no ticket key in the commit subject" is honored by putting the ticket in the body footer.
- Coverage: criteria 1-2 map to Tasks 1-2, criterion 3 maps to Task 1, and criterion 4 maps to Task 2. The existing ordering test is updated in Task 2 Step 1.
- Names used consistently: `truncate`, `MAX_PROJECT_CHARS`, `MAX_BRANCH_CHARS`, `buildStatusLine`.
