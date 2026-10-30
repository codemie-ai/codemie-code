---
schema: sdlc-factory/code-review@1
decision: request-changes
reviewed_head: 84baa5927bdadbea9fda6357b23f377066c4bcde
---

# Code review — 2026-10-29-epmcdme-16530

**Decision:** request-changes (final round, confidence low)  
**Reviewed head:** `84baa59` · **Rounds:** final

Acceptance skipped (no spec), so confidence is low; the change itself is sound but alters the X-CodeMie-Branch derivation source, which the repo guide treats as CRITICAL and requires recorded security-review sign-off that is absent (CR-002), and the real-git tests do not scrub inherited GIT_* env (CR-001, reachability unconfirmed). 1 deferred (tag/branch name collision yields 'heads/<name>', identical to the old rev-parse behaviour; see code-review-deferred.local.md), 7 dismissed as noise.

## Open — 2

### CR-001 · code · major — Test git helper inherits ambient GIT_* environment

`src/utils/__tests__/processes-git-branch.test.ts:10` · not re-checked

**Problem:** The git() helper and detectGitBranch run real git with the inherited process environment. lint-staged runs `vitest related` inside the pre-commit hook (package.json lint-staged config), where git exports repo-location variables such as GIT_DIR, GIT_INDEX_FILE or GIT_WORK_TREE. Nothing scrubs them before `git init`, `git commit` and detectGitBranch run in the temp dirs.

**Impact:** Inside a hook the test git commands could be redirected at the outer repository, producing flaky or wrong results or mutating the real repo's state. Reachability was not confirmed (the existing commit may have passed the hook), so severity is capped at major.

**Recommendation:** Run the test git commands, and detectGitBranch, with GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE (and similar GIT_* repo-location vars) removed from process.env, e.g. delete them in a beforeAll and restore in afterAll, and pass an explicit env to execFileSync in git().

### CR-002 · evidence · major — Attribution header derivation change lacks CRITICAL sign-off

`src/utils/processes.ts:611` · not re-checked

**Problem:** detectGitBranch() switched from `git rev-parse --abbrev-ref HEAD` to `git symbolic-ref --short -q HEAD`, so it now emits a branch for unborn-HEAD repositories. It is the derivation source of X-CodeMie-Branch. security-practices.md ('CRITICAL: Project & User Attribution Headers') and the git-workflow.md review checklist require such a change to be marked CRITICAL with security-review sign-off before merge; nothing in the commit range records this.

**Impact:** Merging without the required sign-off violates the repo's blocking workflow policy for attribution headers, which can cross-attribute analytics between repositories and branches.

**Recommendation:** Record the change as CRITICAL in the PR description and obtain security-review sign-off, applying the 'CRITICAL: Project & User Attribution Headers' reviewer checklist in .ai-run/guides/security/security-practices.md (no competing injector, unknown attribution yields no header, no log leak).

## Pre-existing (not blocking) — 1

- **Tag with same name as branch yields `heads/<name>`** — `src/utils/processes.ts:613` — `git symbolic-ref --short` (like the old `rev-parse --abbrev-ref`) disambiguates to `heads/main` when a tag named `main` exists; a HEAD symref outside `refs/heads` (e.g. `refs/remotes/..`) would also be reported as a branch name. Pre-existing: verified the previous `git rev-parse --abbrev-ref HEAD` returns the identical `heads/main` for the same repo, so this change neither introduces nor worsens it.

## Coverage

Standards: commit-format pass · code-quality pass · security partial
