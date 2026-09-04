# QA Gate Report — EPMCDME-14148

**Branch**: `EPMCDME-14148`
**Merge base**: `origin/main` @ `d7097a2a` (rebased; originally cut from `1d5cc22b`)
**Runner**: npm (guide-first from `.ai-run/guides/quality-gates.md`)
**Started**: 2026-09-03T18:05:00Z
**Status**: PASSED (with two SKIPPED gates owed to CI — see below)

> **Re-run after rebase.** `origin/main` advanced by one commit (`d7097a2a`, revert of the LiteLLM/SSO setup enforcement gate) while this work was in progress. The branch was rebased onto it and every gate below was re-run against the rebased tree. That commit also **renamed the test scripts** — `test:unit` and `test:integration` no longer exist in `package.json`; the commands below are the current equivalents. The unit count drops from 3969 to 3939 because the revert removed its own tests, not because anything here regressed.

## Gates

| Gate | Source | Status | Duration | Command | Notes |
|---|---|---|---|---|---|
| license | guide | PASS | 8s | `npm run license-check` | Required `npm_config_cache` override; `~/.npm/_cacache` is not writable in this environment |
| lint | guide | PASS | 2s | `npm run lint` | `--max-warnings=0`; `no-useless-catch` did not fire on either new catch |
| typecheck | guide | PASS | 2s | `npm run typecheck` | |
| build | guide | PASS | 2s | `npm run build` | |
| unit | guide | PASS | 5s | `npx vitest run --project unit` | **3939 passed / 3939**, 267 files, 0 failures (post-rebase) |
| integration | guide + ci | **PARTIAL** | — | `npx vitest run --project cli` | See below — pre-existing local hangs, not caused by this branch |
| commitlint | guide + ci | PASS | 0s | `npx commitlint --from origin/main --to HEAD --verbose` | 0 problems, 0 warnings across all 7 commits |
| secrets | hook | **SKIPPED** | 0s | `npm run validate:secrets` | Self-skipped — see below |
| affected | guide | N/A | — | — | No changed-file-aware command configured in this project |
| ui | guide | SKIPPED | — | — | No UI surface changed — green outcome |

## Integration — partial, and why

The `cli` vitest project cannot complete locally in this environment. Confirmed hanging files: `tests/integration/cli-commands/doctor.test.ts` and `tests/integration/cli-commands/list.test.ts`; the full-project run produced no output at all across two attempts (600s and ~10 min).

**This is pre-existing and not caused by this branch.** Verified directly: `codemie doctor` was run against both the branch's `bin/codemie.js` and `origin/main`'s version inside the repo, and **both hang identically at 40s**. An earlier comparison that appeared to implicate this branch was invalid (main's `bin/codemie.js` had been copied outside the repo, so its `../dist/...` imports could not resolve and it died instantly on module-not-found rather than actually running).

Files that do complete locally, all passing:

| File | Result |
|---|---|
| `cli-commands/non-interactive-auth.test.ts` | 4 / 4 passed — the AC2 regression suite added by this change |
| `cli-commands/version.test.ts` | 2 / 2 passed |
| `cli-commands/help.test.ts` | 2 / 2 passed |
| `cli-commands/error-handling.test.ts` | 2 / 2 passed |

The `version` / `help` / `error-handling` files are the ones that exercise `bin/codemie.js`, which this change modifies, so the entrypoint change is covered by the files that do run. The remainder is owed to CI, which runs `npm run test:integration` in a clean container.

## Secrets — SKIPPED, not PASS

The gate exited 0 in 0s. Per the self-skipping rule that is not a pass. Exact output:

```
No staged changes to scan
```

`scripts/validate-secrets.js` scans the **staged** git diff, and the working tree is clean because all work is committed — so it did no work.

**Coverage is nonetheless real**: `.husky/pre-commit` chains `npm run validate:secrets`, so gitleaks ran against the staged diff of **every one of the 7 commits** on this branch during the session, reporting `no leaks found` each time. To run it here deliberately you would need staged changes present (and podman running, which it is).

Worth flagging: this gate is **hook-only**. `npm run ci` is `license-check && lint && build && test:unit && test:integration` — it does **not** include `validate:secrets`, so CI will not re-run it.

## Additional verification beyond the gate list

- All 12 CLI entrypoints (`bin/codemie.js` + 11 agent binaries) execute `--version` successfully, exit 0 — confirming the new `process-guards` import resolves post-build in every one.
- End-to-end acceptance behaviour re-confirmed after every fix-up round: exit 1, single actionable stderr line, no stack trace.

## Drift signal

**no** — the implementation matches `spec.md`. Every symbol the spec names (`getSdkClient`, `handleSdkError`, `promptReauthentication`, `isNonInteractiveEnvironment`, `installProcessGuards`) exists with the described signature. The one deliberate deviation from the spec's first draft — installing the guards per bin entrypoint rather than from `AgentCLI` — was made in response to code-review finding CR-006 and is recorded in `code-review-check.json`.

## Outcome

`PASSED`. Nothing local blocks this branch. Two gates are owed to CI: the full integration suite (locally unrunnable, pre-existing) and the secrets scan (hook-only, already run per-commit).
