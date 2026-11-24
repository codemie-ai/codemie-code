# QA Gate Report — EPMCDME-15375 (otlp-settings-backup-refresh-cleanup)

**Branch**: EPMCDME-15375
**Runner**: npm
**Started**: 2026-10-18T14:26:00Z
**Status**: PASSED

## Gates

| Gate  | Status | Duration | Command | Notes |
|-------|--------|----------|---------|-------|
| license-check | PASS | ~5s | `npm run license-check` | No missing/stale Apache-2.0 headers |
| lint  | PASS | ~3s | `npm run lint` | Zero errors, zero warnings |
| typecheck | PASS | ~4s | `npm run typecheck` | No diagnostics |
| build | PASS | ~6s | `npm run build` | `dist/` rebuilt, plugin assets + statusline bundled |
| unit  | PASS | 50.3s | `npx vitest run --project unit` | 353 files, 5258 passed, 2 skipped |
| integration | PASS | 35.9s | `npx vitest run --project cli` | 37 files passed, 1 skipped, 278 passed, 10 skipped |
| ui    | SKIPPED | — | (n/a) | no UI surface changed — diff is backend CLI/connector only |

## Failure detail (if any)

None — all gates passed.

## Drift signal

no
