DONE

## Commit
54243bbd `feat(analytics): add git delivery target for sync`

## Changed paths
- `src/cli/commands/analytics/sync/targets/git-target.ts` (new)
- `src/cli/commands/analytics/sync/targets/__tests__/git-target.test.ts` (new)
- `tests/integration/analytics-sync-git-target.test.ts` (new)

Matches `git show --stat HEAD` exactly — no other files touched.

## Test commands (exact)
- Unit: `npx vitest run --project unit src/cli/commands/analytics/sync/targets/__tests__/git-target.test.ts` → 12 passed
- Integration: `npx vitest run --project cli tests/integration/analytics-sync-git-target.test.ts` → 2 passed
- Both together: `npx vitest run --project unit src/cli/commands/analytics/sync/targets/__tests__/git-target.test.ts --project cli tests/integration/analytics-sync-git-target.test.ts` → 14 passed
- Full sync suite regression: `npx vitest run --project unit src/cli/commands/analytics/sync` → 207 passed (15 files)
- `npm run typecheck` → clean
- `npx eslint src/cli/commands/analytics/sync/targets/git-target.ts src/cli/commands/analytics/sync/targets/__tests__/git-target.test.ts tests/integration/analytics-sync-git-target.test.ts --max-warnings=0` → clean

## TDD evidence
- RED: ran unit test file before `git-target.ts` existed → `Error: Cannot find module '../git-target.js'`, suite failed with 0 tests collected (expected reason: module missing).
- GREEN: after implementing `git-target.ts`, same command → `Test Files 1 passed (1)`, `Tests 12 passed (12)`.
- Integration test was written against the real module/`createGitRunner` and passed on first run against real local bare repos; strengthened immediately after with push/rebase call counters (`aPushCalls === 2`, `aRebaseCalls === 1`) to prove the rejected-push/rebase-retry code path actually executed for AC5, not just that the end state happened to look right — re-run confirmed both counters hold.

## Exported symbols
`MAX_PUSH_ATTEMPTS`, `gitWorkingCopyPath()`, `gitMarkerPath()`, `class GitTarget { id; constructor(git, email, run, dir?); deliver(report); testPush() }` — all per the plan's interface.

## Helpers reused
- `GitRunner`/`SyncGitError`/`classifyGitError` cause from Task 2's `git-client.ts`; `createGitRunner()` used in the integration test (no new git wrapper written).
- `GitSettings`/`SyncReport` from Task 1's `types.ts` (consumed as-is, `path` already posix-normalised).
- `emailSlug` imported from `report/report-generator.ts` (not duplicated), applied to `email.toLowerCase()` exactly like `report-builder.ts:65`.
- `getCodemiePath` from `src/utils/paths.ts`; `logger.debug` from `src/utils/logger.ts` for the re-clone/nothing-to-commit debug lines (no `console.log`).

## Design choices documented in code
- "Nothing to commit" detected via `git diff --cached --quiet -- <folder>` (exit 0 = no staged changes); any thrown error from that call is treated as "there are changes" rather than parsed from stderr text.
- Default branch resolution: after a fresh clone, `symbolic-ref --short HEAD`; on the refresh path for an existing copy, the same call against the existing working copy (its current branch, set to the remote default by the original clone) — documented in the `resolveBranch` docstring rather than an extra `ls-remote` round trip.
- Push retry loop makes exactly `MAX_PUSH_ATTEMPTS` (3) push calls total on sustained `rejected`; any other `gitCause` rethrows immediately with zero retries.

## Concerns
- None blocking. One pre-existing unrelated failure is known in `src/providers/plugins/sso/__tests__/sso.auth-gate.test.ts` per task instructions — not touched, not re-verified here.
- `run-sync.ts` multi-target wiring (constructing `GitTarget` from settings and delivering to both webhook and git) is explicitly a later task per Task 1's commit message; this task only adds the target class itself, matching the plan's scope.
