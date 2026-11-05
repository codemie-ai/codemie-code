DONE

## Commit

`e768c1ff` — `feat(analytics): add git settings shape, validation and redaction for sync`

## Changed paths

- `src/cli/commands/analytics/sync/types.ts` — `GitSettings` (exported), `SyncSettings.webhookUrl` now optional, `SyncSettings.git?`, `SyncSettings.format: 'json'` (required), `InstallOptions` gains `gitRepo?`, `gitBranch?`, `gitPath?`, `format?`.
- `src/cli/commands/analytics/sync/config-store.ts` — `validateInstallOptions` validates both targets (at least one required), new `validateGitRepoUrl`, `validateGitBranch`, `validateGitPath`, `validateGitSettings`, `validateFormat`, `hasEmbeddedCredentials`; `loadSyncSettings` reads `git`/`format`, defaults `format` to `'json'`, returns `null` when neither target is usable.
- `src/cli/commands/analytics/sync/redact.ts` — `redactSecrets` also masks `scheme://user:pass@` userinfo.
- `src/utils/errors.ts` — `SyncTargetMissingError` message now names both `--webhook <url>` and `--git-repo <url>`.
- `src/cli/commands/analytics/sync/install.ts` — print the Webhook summary line only when `settings.webhookUrl` is set (minimal compile guard).
- `src/cli/commands/analytics/sync/status.ts` — same guard on the Webhook status line.
- `src/cli/commands/analytics/sync/run-sync.ts` — minimal guard: if `settings.webhookUrl` is undefined, emits `fail setup no webhook configured; git sync delivery is not implemented yet` and returns 1 (git delivery itself is a later task, not implemented here).
- Tests: `src/cli/commands/analytics/sync/__tests__/config-store.test.ts`, `__tests__/redact.test.ts` (new/updated per spec). `__tests__/run-sync.test.ts`, `__tests__/status.test.ts` — added `format: 'json'` to `BASE_SETTINGS` literals so they keep typechecking against the now-required field (pure compile-fix, no behavior/assertion changes).

## Test command (proves the task)

```
npx vitest run src/cli/commands/analytics/sync/__tests__/config-store.test.ts src/cli/commands/analytics/sync/__tests__/redact.test.ts
```
Result: `Test Files 2 passed (2)`, `Tests 40 passed (40)`.

## TDD evidence

- RED: stashed all 9 implementation files (`types.ts`, `config-store.ts`, `redact.ts`, `errors.ts`, `install.ts`, `status.ts`, `run-sync.ts`, and the two test-fixture compile fixes), leaving only the new/updated test assertions in `config-store.test.ts`/`redact.test.ts` against the original code. Ran the exact test command above: `EXIT=1`, `16 failed | 24 passed (40)` — failures for the expected reasons (missing git-target support, missing `format` field, no userinfo redaction, old `SyncTargetMissingError` text), not typos/import errors.
- GREEN: popped the stash (implementation restored), fixed a trailing-slash bug in `validateGitPath` found by the new path-normalisation test (`path.posix.normalize` keeps a trailing `/`), re-ran the same command: `EXIT=0`, `40 passed (40)`.

## Broader verification

- `npm run typecheck`: clean (`tsc --noEmit`, no output).
- `npx eslint <all changed .ts files> --max-warnings=0`: clean.
- `npx vitest run src/cli/commands/analytics/sync src/utils/errors.test.ts`: `169 passed (169)`.
- `npm test` (full suite): `411 passed | 1 failed` (`src/providers/plugins/sso/__tests__/sso.auth-gate.test.ts`, 2 assertions) and `6624 passed | 2 failed`. Verified pre-existing and unrelated: re-ran that one file with all my changes stashed out — identical `2 failed` result on the untouched tree. Not caused by this task; left as-is per scope (only the declared files are mine to touch).
- Pre-commit hook (lint-staged, typecheck, gitleaks) ran clean on commit.

## Exported/changed symbols and call sites

- `GitSettings` — new export from `types.ts`, used by `config-store.ts`.
- `SyncSettings.webhookUrl` — now optional. Call sites narrowed/guarded: `install.ts` (`printSummary`), `status.ts` (`runStatus`), `run-sync.ts` (`run`). `format.ts`'s `webhookHost(webhookUrl: string)` signature unchanged — all call sites already only invoke it inside a `webhookUrl !== undefined` guard, so no change needed there.
- `SyncSettings.format` — new required field; two test fixtures (`run-sync.test.ts`, `status.test.ts`) updated to include it in their `BASE_SETTINGS` literals (compile-only fix, not scope creep — their own test logic is untouched).
- `validateWebhookUrl` — now returns `string | undefined` instead of throwing on missing; the "at least one target required" check moved to `validateInstallOptions`.

## Helpers reused

- `redactSecrets` (existing) reused/extended rather than adding a second redaction function.
- `path.posix` (Node builtin) reused for path normalisation instead of a custom path-escape check.
- `SyncConfigError` (existing error class) reused for every new validation failure, per project convention (specific error classes, no generic `Error`).

## Concerns

- None blocking. `run-sync.ts`'s new guard message ("git sync delivery is not implemented yet") is intentionally plain/minimal per the task's instruction not to implement git delivery now — a later task is expected to replace this whole branch when it rewrites run-sync for multiple targets.
- The pre-existing SSO test failure (`sso.auth-gate.test.ts`) is unrelated to this task and was not touched; flagging it here only because `npm test` surfaces it.
