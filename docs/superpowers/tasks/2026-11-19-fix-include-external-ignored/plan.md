# Fix --include-external silently ignored: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox syntax.

> **Post-rebase update.** Written against HEAD 37a2fe47, then rebased onto origin/main 8b8c5e92, which carries upstream PR #837. #837 already added `src/cli/program.ts` (`createProgram()`) and `src/cli/__tests__/program.test.ts` (3 structural tests), and turned `proxy connect desktop|vscode` into removed stubs (`resolveAliasOptions` is gone). The tasks below describe what was actually delivered (3 files, +201/-6, code commit d685952a): no factory extraction, no `index.ts` or `proxy/index.ts` change, and the proxy alias task withdrawn. The architecture-review and code-review verdicts in this directory were produced against pre-rebase commit f9eb6021 and are historical.

**Goal:** `analytics sync install|bootstrap --include-external <policy>` delivers the policy to the runner when parsed through the real root program.

**Architecture:** `createProgram()` (`src/cli/program.ts`, already extracted upstream) starts with `new Command().enablePositionalOptions()` (commander 11.1.0 needs every ancestor to enable it). Add `.allowExcessArguments(false)` to the five sync subcommands. Regression tests parse via `createProgram()` with runner modules mocked.

**Tech Stack:** TypeScript ESM (`.js` import suffixes, `@/` alias), commander 11.1.0, Vitest.

**Spec:** `docs/superpowers/tasks/2026-11-19-fix-include-external-ignored/spec.md`

Commit/git: none in this plan (AGENTS.md: git only on explicit request). Whole-suite gates and manual verification are owned by the calling flow.

## Global Constraints

- Do not rename `--include-external` or change its semantics/default.
- No change to `sync/config-store.ts` validation order, sync runners, scheduler argv (`generators.ts:36`), `bin/`, `isScheduledSyncRun`, or the `--task` argv pre-scan.
- `src/cli/commands/proxy/index.ts` and `src/cli/index.ts`: no change.
- Keep existing `src/cli/commands/analytics/__tests__/analytics-sync-cli.test.ts`.

## Review Focus

- `--include-external bogus --lookback-days 99` via root: expect the include-external error, not lookback-days (covered in Task 2).
- `analytics sync run --scheduled` (OS job argv) must still parse (Task 2).
- `proxy connect desktop|vscode` are removed stubs after #837; no proxy change (Task 3 withdrawn).
- `codemie --version` still prints and exits (Task 1).
- `codemie analytics --include-external always` is still consumed by analytics itself (Task 1).

---

### Task 1: Root positional options

**Files:**
- Modify: `src/cli/program.ts` (`createProgram()` starts with `new Command().enablePositionalOptions()` plus a comment)
- Test: `src/cli/__tests__/program.test.ts` (keep upstream's 3 structural tests, add regression tests)

**Interfaces:**
- Consumes: upstream's `createProgram(): Command`. No factory extraction in this change.

- [x] **Step 1: Write failing-first tests** in `program.test.ts` (mock the runner modules with `vi.mock`; use `exitOverride()` and `parseAsync(['node','codemie',...])`):
  - `analytics sync install --include-external always` -> `runInstall` receives `includeExternal: 'always'` (AC1).
  - `analytics sync bootstrap --include-external always` -> `runBootstrap` receives `includeExternal: 'always'` (AC2).
  - `analytics --include-external always` is still consumed by analytics: `loadAnalytics` 3rd arg `true`, `runInstall` not called (AC3).
  - `--version` still works (AC7).
- [x] **Step 2: Prove the tests detect the bug.** Removing the root `.enablePositionalOptions()` makes exactly 3 tests fail (install, bootstrap, validation order). Restored.
- [x] **Step 3: Add the root `.enablePositionalOptions()`** and run `npx vitest run src/cli/__tests__/program.test.ts`. Expected: PASS.

Test-first: yes — install/bootstrap `--include-external always` through `createProgram()` fails (runner receives no `includeExternal`) until the root enables positional options.

### Task 2: Reject stray arguments on sync subcommands, pin repro B

**Files:**
- Modify: `src/cli/commands/analytics/index.ts` (`.allowExcessArguments(false)` on `bootstrap`, `install`, `status`, `run`, `uninstall`; updated doc comment)
- Test: `src/cli/__tests__/program.test.ts`

**Interfaces:**
- Consumes: `createProgram()`.

- [x] **Step 1: Add tests**:
  - For each of the five subcommands, `analytics sync <name> extra` fails with `commander.excessArguments` (`it.each`) (AC4).
  - `analytics sync run --scheduled` reaches `runSync` (AC5).
  - Repro B: `analytics sync install --include-external bogus --lookback-days 99` through `createProgram()` using the real `runInstall`/`validateInstallOptions` (config-store not mocked): exit code 1, the include-external error is reported and not the lookback-days one.
- [x] **Step 2: Add `.allowExcessArguments(false)`** to the five subcommands (`run` keeps hidden `--scheduled`). Removing it fails the 5 stray-argument tests (mutation checked on the pre-rebase tree).
- [x] **Step 3: Run** `npx vitest run src/cli/__tests__/program.test.ts`. Expected: PASS (14 tests total).

Test-first: yes — `analytics sync install extra` is silently accepted on 8b8c5e92; fails the `commander.excessArguments` assertion until `allowExcessArguments(false)` is added.

### Task 3: Proxy alias flags (withdrawn)

Withdrawn after the rebase onto #837: `proxy connect desktop|vscode` became removed stubs that fail naming `--claude-desktop` / `--vscode`, and `resolveAliasOptions` no longer exists, so there is nothing to characterize and no comment to fix. The earlier comment-only change and the proxy alias tests were dropped. AC6 is withdrawn accordingly.

Test-first: no — nothing is delivered in this task.
