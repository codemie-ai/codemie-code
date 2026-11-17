DONE

Commit: 09e67fe2 feat(analytics): add prompt-free git client for sync

Changed paths:
- src/cli/commands/analytics/sync/targets/git-client.ts (new)
- src/cli/commands/analytics/sync/__tests__/git-client.test.ts (new)
- src/utils/errors.ts (added GitFailureCause, SyncGitError)

Test command:
`npx vitest run --project unit src/cli/commands/analytics/sync/__tests__/git-client.test.ts`

TDD evidence:
- RED: ran the test file before git-client.ts existed -> `Error: Cannot find module '../targets/git-client.js'`, EXIT=1.
- GREEN: after implementing git-client.ts -> `Test Files 1 passed (1)`, `Tests 26 passed (26)`, EXIT=0.
- Also ran full sync test dir after: `Test Files 14 passed (14)`, `Tests 195 passed (195)`.

Exported symbols added:
- `GitFailureCause`, `SyncGitError` (src/utils/errors.ts) — `SyncGitError(message, gitCause)` (field named `gitCause`, not `cause`, to avoid colliding with `Error.cause`, as the plan allowed).
- `GitRunner`, `NETWORK_TIMEOUT_MS` (120_000), `LOCAL_TIMEOUT_MS` (15_000), `gitEnv`, `classifyGitError`, `gitHint`, `createGitRunner` (src/cli/commands/analytics/sync/targets/git-client.ts); re-exports `GitFailureCause` from errors.ts.

Helpers reused:
- `exec` from `@/utils/exec.js` (non-zero code resolves, caller classifies; timeout rejects with "Command timed out after Nms").
- `redactSecrets` from `src/cli/commands/analytics/sync/redact.ts` applied to every thrown message.
- Precedent `GIT_TERMINAL_PROMPT`/`GCM_INTERACTIVE` env pattern from src/cli/commands/skills/add.ts.

Implementation notes:
- `gitEnv(base, configuredSshCommand?)`: base's `GIT_SSH_COMMAND` wins if set, else `configuredSshCommand`, else `'ssh'`; appends `-o BatchMode=yes` unless already present (never duplicates, never replaces).
- `createGitRunner`: when `process.env.GIT_SSH_COMMAND` is unset, reads `core.sshCommand` via a local, prompt-free `git config --get` (non-zero exit = unset) before building env for the real call; chooses timeout from `opts.network`; non-zero exit -> `classifyGitError(stderr)`; a rejected exec call matching `/timed out/i` -> cause `timeout`, else `other`.
- `classifyGitError` checks `protected` before `rejected` (a protected-branch push also prints `[remote rejected]`).

Verification: `npm run typecheck` EXIT=0; `npx eslint <3 changed files> --max-warnings=0` EXIT=0; pre-commit hooks (lint-staged, typecheck, gitleaks) passed on commit. `git show --stat HEAD` matches the 3 declared files exactly.

Concerns: none. Did not touch Task 1's settings/validation files.
