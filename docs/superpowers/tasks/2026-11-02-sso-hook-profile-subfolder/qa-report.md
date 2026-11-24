# QA Gate Report — sso-hook-profile-subfolder

**Branch**: fix/EPMCDME-16308-sso-hook-profile
**Runner**: npm (gates taken verbatim from `.ai-run/guides/quality-gates.md`)
**Started**: 2026-11-02T10:42:59Z
**Status**: PASSED

HEAD `d3ecf8c9` (4 commits on top of merge base `3f1e5b02`). All `CODEMIE_*` variables were unset for every gate, because this shell runs inside a codemie-launched session and the ambient variables break an unrelated existing test (`AgentCLI-model-source.test.ts`).

## Gates

| Gate | Status | Duration | Command | Notes |
|------|--------|----------|---------|-------|
| license | PASS | 6s | `npm run license-check` | |
| lint | PASS | 38s | `npm run lint` | zero errors, zero warnings |
| typecheck | PASS | 17s | `npm run typecheck` | |
| build | PASS | 26s | `npm run build` | |
| unit | PASS | 83s | `npx vitest run --project unit` | 402 files, 6551 passed, 2 skipped |
| integration | PASS (on 3rd full run) | 80s | `npx vitest run --project cli` | 38 files passed, 1 skipped, 299 tests passed, 10 skipped. See notes below. |
| commitlint (last) | PASS | 3s | `npm run commitlint:last` | |
| commitlint (range) | PASS | 4s | `npx commitlint --from 3f1e5b02… --to HEAD` | all 4 commits |
| secrets | PASS (no-op) | 4s | `npm run validate:secrets` | reported "No staged changes to scan"; nothing was scanned locally, CI runs it unconditionally |
| affected tests | SKIPPED | — | (n/a) | no changed-file-aware command configured |
| ui | SKIPPED | — | (n/a) | no UI surface changed |

## Notes on the integration gate

The first two full runs of `npx vitest run --project cli` did **not** pass; the third did.

- Run 1 (178s): 4 files failed — `help`, `version`, `profile`, `workflow` (`tests/integration/cli-commands/`) — all `Hook timed out in 10000ms` in `beforeAll` (`cli.run(...)` spawning the CLI), with every test in them skipped.
- Run 2 (3689s wall clock — the machine stalled): 3 failures, `help.test.ts` again (hook timeout) and two `hook-stdout.test.ts` cases (`Test timed out in 30000ms`).
- Isolation: those files pass when run alone — `help/version/profile/workflow` 9/9, `hook-stdout` + `help` 17/17. A bare `node bin/codemie.js --help` took ~1s when measured afterwards.
- Run 3: clean, exit 0, 80s.

The failures were timeouts that moved between files and never asserted anything, and they came from machine contention, not from the code under test. The change under review touches only the OTLP hook auth-profile resolution and its unit tests, not CLI startup or `codemie hook` stdout. I did not run the suite against a clean `origin/main` to prove the flake exists there too, so "pre-existing flake" is inferred from the evidence above rather than measured.

## Failure detail

None in the final state.

## Drift signal

no — the implementation matches `plan.md` (the one deliberate deviation: the plugin tests dropped the planned `ConfigLoader.load` not-called assertion, because the plugins' project-identity path legitimately calls `ConfigLoader.load` after the gate; recorded in `code-review-check.json`).
