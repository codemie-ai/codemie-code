# QA Gate Report — profile-scope-ownership-gaps

**Branch**: fix/profile-scope-ownership (HEAD 62c45617)
**Runner**: npm (gates from `.ai-run/guides/quality-gates.md` + `.husky/*` + `.github/workflows/ci.yml`)
**Started**: 2026-10-21T07:30:00Z
**Status**: PASSED with environment-only failures — no gate fails differently on the branch than on the merge base `173b148e` in this environment; CI must confirm the unit/cli suites.

## Gates

| Gate | Source | Status | Duration | Command | Notes |
|---|---|---|---|---|---|
| license | guide/ci | PASS | 19s | `npm run license-check` | |
| lint | guide/ci | PASS | 57s | `npm run lint` | zero warnings |
| typecheck | guide/hook | PASS | 26s | `npm run typecheck` | |
| build | guide/ci | PASS | 65s | `npm run build` | First rerun hit `ENOSPC` (drive D: full); passed after space was freed |
| unit | guide/ci | FAIL (baseline) | 377s | `npx vitest run --project unit` | 5393 passed, 3 failed: `codex.incremental-sync` (2) and `pi.incremental-sync` (1), all `waitFor` timing. The same tests fail on merge base 173b148e (3 failed there). Profile/config-related suites: all green. |
| cli (integration) | guide/ci | FAIL (baseline) | 352s | `npx vitest run --project cli` | Full parallel run: 18 failed, almost all spawn timeouts (`Hook timed out in 10000ms`, `Test timed out in 30000ms`). Sequential rerun of the 13 failing files left 6 failing: profile, list, version, workflow, skills-integration, self-update, all `beforeAll` timeouts plus networked `self-update --check`. Main build in the same run: profile, workflow and self-update fail the same way; list/version/skills-integration flap across the 10 s boundary. `codemie version` on a fresh home takes 5.9–12.3 s on the branch vs 9.3–14.5 s on main. |
| commitlint (range) | ci | PASS | 14s | `npx commitlint --from 173b148e --to HEAD` | 0 problems in all commits |
| secrets | hook/ci | PASS | 11s | gitleaks v8.30.1 `detect --pipe` over `git diff 173b148e...HEAD` | "no leaks found". Ran through a docker forwarder because the Windows Rancher docker CLI never closes stdin (the hook hangs otherwise). |
| commit-msg | hook | PASS | — | `commitlint --edit` | Ran on every commit |
| ui | guide | SKIPPED | — | (n/a) | No UI surface changed (CLI-only) |

## Isolated end-to-end (manual, CODEMIE_HOME/HOME/USERPROFILE → scratchpad)

S1 delete global in repo with local config ✓ · S2 dangling local falls back, warning logged ✓ · S3 delete last local then a global ✓ · S4/E4 fill-shape file keeps keys, legacy refused byte-identical ✓ · E1 unknown delete shows red reason ✓ · E2 global rename repairs local reference, rename onto an existing name rejected ✓ · E2b local-only rename ✓ · CR-005 malformed global stays byte-identical ✓

## Failure detail

All remaining failures are timeouts or network calls that reproduce on the merge base: `Hook timed out in 10000ms` (CLI spawn ≥ 10 s on this Windows box under load), `waitFor timed out after 1500ms` (incremental-sync timers), `self-update --check failed` (registry access). None involves profile/config behaviour.

## Drift signal

no — implemented signatures match the plan (updateLocalConfig, saveLocalProfile, renameProfile(old, new, workingDir): StorageScope, enableFallbackWarning, exitWithCommandError).
