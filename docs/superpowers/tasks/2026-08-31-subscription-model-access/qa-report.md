# QA Gate Report — EPMCDME-14341 subscription-model-access

**Branch**: EPMCDME-14341_subscription-model-access
**Runner**: npm
**Started**: 2026-08-31
**Status**: PASSED

## Gates

| Gate | Source | Status | Command | Notes |
|------|--------|--------|---------|-------|
| license | guide | PASS | `npm run license-check` | Passed after using a writable npm cache; the default `~/.npm/_cacache` hits EACCES/EEXIST in this environment (infra, not a license violation). |
| lint | guide | PASS | `npm run lint` | ESLint `--max-warnings=0`, clean. |
| typecheck | guide | PASS | `npm run typecheck` | `tsc --noEmit` clean. |
| build | guide | PASS | `npm run build` | `tsc && tsc-alias && copy-plugin` succeeded; pricing table + plugin assets copied. |
| unit | guide | PASS | `npm run test:unit` | 3969 passed (268 files), including all new tests (enrichArgs passthrough, version-prompt-policy, launch-model-display, models message, setup summary, cli-model-env, buildConfig-empty, moonshot guard). |
| integration | guide | SKIPPED | `npm run test:integration` (`vitest run --project cli`) | Full cli project hangs locally on a subprocess/PTY negative-command test that needs the live backend/auth this sandbox lacks (log froze at `error: unknown command 'invalid-command-xyz'`); not caused by this change (that path never reaches the modified handleRun model logic). The two guards directly covering this change area — `proxy-routing-guard.test.ts` (anthropic-subscription proxy bypass) and `model-tier-e2e.test.ts` (non-subscription env pipeline) — were run in isolation: **14 passed**. CI runs the full `test:integration` unconditionally and remains the settling gate. |
| commitlint | guide | PASS | `npm run commitlint:last` | 0 problems; all branch commits are Conventional with `Refs: EPMCDME-14341`. |
| secrets | hook | PASS | `npm run validate:secrets` | Ran via `.husky/pre-commit` on every commit (podman up); Gitleaks reported "no leaks found" each time. |
| ui | guide | SKIPPED | (n/a) | No UI surface changed — diff is `.ts` under `src/` only (CLI/agents/providers), matches no `ui_globs`. Green for this mechanical phase. |

## Failure detail

None. The only non-PASS gates are SKIPPED: the UI gate (no UI surface) and the full integration suite (environment hang on an unrelated subprocess test), with targeted integration coverage substituted and passing.

## Owed to CI

- `npm run test:integration` (full `cli` project) — CI runs it for real. Locally verified via the two change-relevant guards only.

## Drift signal

no
