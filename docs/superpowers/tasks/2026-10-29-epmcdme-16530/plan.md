# EPMCDME-16530 (CLI) Verification and PR Prep Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the already-committed fix (3a357dd7, branch `EPMCDME-16530_unborn-head-branch`) is green and produce the PR title/body artifacts.

**Architecture:** No new implementation. The fix changes `detectGitBranch()` in `src/utils/processes.ts` to `git symbolic-ref --short -q HEAD`. Source of truth: `docs/superpowers/plans/2026-10-30-epmcdme-16530-cli-unborn-head-branch.md`. The backend companion (`codemie` repo, commit 6f8b552c6) is out of this repo's diff.

**Tech Stack:** TypeScript (ES modules), Node.js >= 20, Vitest, git CLI.

## Global Constraints

- Do NOT push, open a PR, or create a branch; the user opens the PR later via `sdlc-factory:mr-creator`.
- Do NOT modify source or test files; if a check fails because of this change, stop and report.
- Commit per task using the repository's existing convention (expected: nothing to commit; the only new file is the PR body under the task dir).

## Acceptance criteria

- [ ] A repository with no commits (unborn HEAD) makes `detectGitBranch()` return its branch name (e.g. `main`, `feature/x`).
- [ ] Detached HEAD and a non-git directory still return `undefined`.
- [ ] `git diff origin/main...HEAD --name-only` lists only `src/utils/processes.ts` and `src/utils/__tests__/processes-git-branch.test.ts`.
- [ ] `npm run lint`, `npm run typecheck`, `npm run build` pass with zero warnings.
- [ ] The failure in `src/agents/plugins/pi/__tests__/pi.incremental-sync.test.ts` is confirmed pre-existing and unrelated (it fails identically on `origin/main`).
- [ ] PR title and body artifacts exist, with the CRITICAL-change line.

### Task 1: Scope and static checks

**Files:** none modified.

Test-first: no — change already committed with its tests

- [ ] **Step 1:** Run `git diff origin/main...HEAD --name-only` and confirm exactly the two files above.
- [ ] **Step 2:** Run `npm run lint && npm run typecheck && npm run build`. Expected: zero warnings, no errors.

### Task 2: Targeted tests and unrelated-failure check

**Files:** none modified.

Test-first: no — change already committed with its tests

- [ ] **Step 1:** Run `npx vitest run src/utils/__tests__/processes-git-branch.test.ts src/utils/__tests__/processes-git.test.ts src/utils/__tests__/processes.test.ts --reporter=verbose`. Expected: all PASS (6 real-git tests including unborn HEAD, detached HEAD, non-repo).
- [ ] **Step 2:** Run the repro: `npx vitest run --config docs/superpowers/tasks/2026-10-29-epmcdme-16530/repro/vitest.config.ts docs/superpowers/tasks/2026-10-29-epmcdme-16530/repro/branch-detection.repro.test.ts --reporter=verbose`. Expected: 4 passed.
- [ ] **Step 3:** Run the consumer suites listed in Task 1 Step 6 of the CLI plan (BaseAgentAdapter, OtlpAgentAdapter, claude-code-otlp plugin, Pi incremental-sync, DesktopRepositoryResolver, DesktopTelemetryRuntime, `src/providers/plugins/sso/proxy/plugins/__tests__`). Expected: all PASS except `pi.incremental-sync.test.ts`.
- [ ] **Step 4:** If `pi.incremental-sync.test.ts` fails, reproduce on a clean `origin/main` checkout (use a temporary `git worktree` outside the repo; remove it afterwards) and record that it fails identically.

### Task 3: PR artifacts

**Files:**
- Create: `docs/superpowers/tasks/2026-10-29-epmcdme-16530/pr-body.md`

Test-first: no — documentation artifact, no behavior

- [ ] **Step 1:** Write `pr-body.md` with: first line `# fix(analytics): detect git branch in repositories without commits` (the PR title); a summary citing ticket EPMCDME-16530 and the root cause (unborn HEAD made `git rev-parse --abbrev-ref HEAD` exit 128, so `X-CodeMie-Branch` was not sent); the before/after table from the "Background" section of the CLI plan (unborn HEAD, commit on `main`, detached HEAD, not a repo); the repro command from Task 2 Step 2; a verification section with the actual results of Tasks 1-2 (including the unrelated Pi failure); a coordination note that the backend fix is in a separate repo; and the line **"CRITICAL change: changes the derivation of `X-CodeMie-Branch` — security-review sign-off required"** (`.ai-run/guides/standards/git-workflow.md:148`).
- [ ] **Step 2:** Re-read `pr-body.md` and confirm the title string is exact, the CRITICAL line is verbatim, and no secrets or local paths with usernames appear.
