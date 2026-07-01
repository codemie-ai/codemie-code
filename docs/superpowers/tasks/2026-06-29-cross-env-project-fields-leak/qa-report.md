# QA Gate Report — cross-env-project-fields-leak

**Branch**: fix/cross-env-project-fields-leak
**Runner**: npm (guide-first via `.ai-run/guides/quality-gates.md`)
**Started**: 2026-06-29T13:55:00Z
**Status**: PASSED

## Gates

| Gate         | Status | Duration | Command                            | Notes |
|--------------|--------|----------|------------------------------------|-------|
| license-check | PASS  | ~5s      | `npm run license-check`            | No missing/stale headers reported. Output is dependency license summary. |
| lint         | PASS   | ~6s      | `npm run lint`                     | ESLint 9.x, `--max-warnings=0`, zero warnings. |
| typecheck    | PASS   | ~6s      | `npm run typecheck`                | `tsc --noEmit`, no diagnostics. |
| build        | PASS   | ~8s      | `npm run build`                    | `tsc && tsc-alias && npm run copy-plugin` all clean. |
| unit         | PASS   | 10.28s   | `npm run test:unit`                | 2162 pass / 1 skipped / 142 files. New tests: 13 added in `src/utils/__tests__/config-project-override.test.ts`. |
| integration  | PASS   | 24.27s   | `npm run test:integration`         | 220 pass / 1 skipped / 27 files. |
| commitlint   | PASS   | <1s      | `npm run commitlint:last` + `npx commitlint --from main --to HEAD` | All 4 commits on the branch conform to Conventional Commits. |
| ui           | SKIPPED | —       | (n/a)                              | No UI surface changed — diff is ConfigLoader internals + tests + one markdown line. `feature-verification` not required. |

## Failure detail

None.

## Drift signal

no — implementation, tests, and plan all describe the same private helper signature `shouldPreserveProjectContext(localUrl, globalUrl): boolean`, the same gate behavior at both call sites, and the same six PROJECT_FIELDS / `preserveProjectContext` shape. No type, signature, or method-name drift.
