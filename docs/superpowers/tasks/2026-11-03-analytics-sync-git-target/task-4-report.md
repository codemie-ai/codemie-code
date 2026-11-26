DONE

Commit: ba5e9cc8 "feat(analytics): deliver sync reports to each configured target"

Changed paths:
- src/cli/commands/analytics/sync/run-sync.ts
- src/cli/commands/analytics/sync/marker.ts (header comment only)
- src/cli/commands/analytics/sync/__tests__/run-sync.test.ts

Test command: `npx vitest run --project unit src/cli/commands/analytics/sync/__tests__/run-sync.test.ts`

TDD evidence:
- RED: rewrote test file to new `deliver`/per-target `readMarker`/`writeMarker` shape before touching run-sync.ts; ran suite, 13/22 failing (code 1 vs 0, deliver not called, target suffix missing) — expected, since production still had old `send(url, report)` single-target shape.
- GREEN: implemented multi-target loop in run-sync.ts; ran suite again, 22/22 passing (code 0).

Exported symbols changed, call sites updated:
- New export `TargetId = 'webhook' | 'git'` from run-sync.ts.
- `SyncDeps.send(url, report)` -> `deliver(target, settings, email, report)`.
- `SyncDeps.readMarker(now)` -> `readMarker(target, now)`; `writeMarker(at)` -> `writeMarker(target, at)`.
- `formatLogLine(at, outcome, rest, target?)` — optional 4th param, backward compatible.
- Only caller of these is run-sync.ts itself (`realSyncDeps`) and the test file; `status.ts` uses `marker.ts#readMarker` directly (unchanged signature) and its own `StatusDeps.readMarker(now)` — not touched, still compiles (confirmed via `npm run typecheck`, 0 errors).

Helpers reused: `marker.ts#readMarker/writeMarker` (path param already existed), `targets/git-target.ts#GitTarget`/`gitMarkerPath`, `targets/git-client.ts#createGitRunner`/`gitHint`, `targets/webhook-target.ts#sendWebhook`, `@/utils/errors.js#SyncGitError`.

Verification: full `npx vitest run --project unit src/cli/commands/analytics/sync` — 15 files, 212 tests passed. `npm run typecheck` — clean. `npx eslint <3 changed files> --max-warnings=0` — clean. Commit went through pre-commit hooks (lint-staged, typecheck, gitleaks) without `--no-verify`.

Concerns: none outstanding. Removed Task 1's temporary git-not-implemented guard as instructed. Did not touch status.ts beyond confirming it still typechecks unmodified.
