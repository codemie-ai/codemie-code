DONE

Commit: 3b908257 feat(analytics): show git target in sync status

Changed paths:
- src/cli/commands/analytics/sync/status.ts
- src/cli/commands/analytics/sync/__tests__/status.test.ts

Test command: `npx vitest run --project unit src/cli/commands/analytics/sync/__tests__/status.test.ts`

TDD evidence:
- RED: stashed the implementation, ran the updated test file against the original status.ts — 13 failed / 13 passed (missing `parseLastFailure` export, `parseLastRun` arity mismatch, no git block, `Last run:`/`Last successful send:` not conditional on webhook).
- GREEN: popped the stash, finished the implementation, ran test file — EXIT=0, 26 passed.
- Full suite: `npx vitest run --project unit src/cli/commands/analytics/sync` — EXIT=0, 221 passed (15 files).
- `npm run typecheck` — EXIT=0.
- `npx eslint src/cli/commands/analytics/sync/status.ts src/cli/commands/analytics/sync/__tests__/status.test.ts --max-warnings=0` — EXIT=0.

Changed exported symbols:
- `parseLastRun(log, target: TargetId)` — signature gained `target`; strips trailing ` target=<id>` from `outcome`, defaults untagged lines to `'webhook'`. Only call site is `status.ts#runStatus` (updated) and the test file (updated).
- `parseLastFailure(log, target: TargetId)` — new export, same filtering, restricted to `fail` outcomes.
- `StatusDeps.readMarker(target: TargetId, now: Date)` — gained `target`. Only implementations are the test harness (updated) and `createRealStatusDeps` (updated to route git to `gitMarkerPath()` via `readMarker(now, path)`).
- `LastRun`, `runStatus`, `createRealStatusDeps` signatures unchanged; the only external call site (`src/cli/commands/analytics/index.ts:107-108`) still calls `runStatus(createRealStatusDeps())` with no changes needed.

Helpers reused: `redactSecrets`/`errorMessage` (redact.js), `gitMarkerPath` (targets/git-target.js), `readMarker` (marker.js), `lookbackText`/`webhookHost` (format.js).

Concerns: none. Git block prints "Last successful push"/"Last failure" always when `settings.git` is set (no optional "Last run" line for git, per the plan's "optional" wording — kept scope to the required fields). Repository path with no `path` configured prints `(repository root)`.
