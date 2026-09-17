# QA Gate Report — EPMCDME-13675

**Branch**: EPMCDME-13675
**Runner**: npm
**Started**: 2026-07-30T11:40:00Z
**Second run after fix-up**: 2026-07-30T12:12:00Z
**Status**: PASSED

## Gates

| Gate           | Source | Status  | Duration | Command                       | Notes |
|----------------|--------|---------|----------|-------------------------------|-------|
| license-check  | guide  | SKIPPED | —        | `npm run license-check`       | Local npm cache permission error (`EACCES: mkdir '/Users/Evgenii_Kurdakov/.npm/_cacache/...'`) prevents `npx license-checker` from resolving; enable locally with `sudo chown -R $USER ~/.npm && npm cache clean --force`. CI runs the same gate unconditionally against a fresh cache. |
| lint           | guide  | PASS    | ~15s     | `npm run lint`                | Zero errors, zero warnings across all `.ts` under `{src,tests}/`. |
| typecheck      | guide  | PASS    | ~10s     | `npm run typecheck`           | `tsc --noEmit` clean. |
| build          | guide  | PASS    | ~20s     | `npm run build`               | `tsc && tsc-alias && copy-plugin` succeeded. |
| unit           | guide  | PASS    | ~3.5s    | `npm run test:unit`           | **2400 passed, 1 skipped, 0 failed.** First run had 2 pre-existing failures in `config-project-override.test.ts`; root-caused to `ConfigLoader.GLOBAL_CONFIG` being resolved at class-load time (before test spies could take effect) on dev machines whose real `~/.codemie/codemie-cli.config.json` has an empty `profiles: {}`. Fixed in commit `f3bb571` by converting the two static fields to getter/setter pairs with memoized overrides; production behavior unchanged. |
| integration    | guide  | PASS    | ~5s      | `npm run test:integration`    | 196 passed, 11 skipped across 28 test files. Includes updated `incremental-conversation-processing.test.ts` (14/14) with the drain-loop assertion. |
| commitlint     | guide  | PASS    | <1s      | `npm run commitlint:last`     | `f3bb571 fix(utils): resolve ConfigLoader.GLOBAL_CONFIG lazily ...` matches Conventional Commits. |
| ui             | guide  | SKIPPED | —        | (n/a)                         | No UI surface changed. Diff touches only `.ts`, `.jsonl`. |

## Drift signal

no

## Recommendation

Proceed to Stage 8.
