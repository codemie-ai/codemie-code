# QA Gate Report — fix/registered-assistants-empty-tab

**Branch**: fix/registered-assistants-empty-tab
**Runner**: npm
**Started**: 2026-06-23T16:33:00Z
**Status**: PASSED

## Gates

| Gate          | Status  | Duration | Command                        | Notes                                 |
|---------------|---------|----------|--------------------------------|---------------------------------------|
| license-check | PASS    | ~3s      | `npm run license-check`        | 457 MIT + 110 other packages OK       |
| lint          | PASS    | ~4s      | `npm run lint`                 | Zero errors, zero warnings            |
| typecheck     | PASS    | ~8s      | `npm run typecheck`            | No diagnostics                        |
| build         | PASS    | ~15s     | `npm run build`                | `dist/` rebuilt, copy-plugin OK       |
| unit          | PASS    | ~27s     | `npm run test:unit`            | 2095 passed, 3 skipped (local-only transcripts) |
| integration   | PASS    | ~200s    | `npm run test:integration`     | 220 passed, 1 skipped                 |
| ui            | SKIPPED | —        | (n/a)                          | No UI surface changed                 |

## Failure detail

None.

## Drift signal

no
