# QA Gate Report — sast-hardcoded-secrets

**Branch**: fix/sast-hardcoded-secrets
**Runner**: npm
**Started**: 2026-07-03T12:00:00Z
**Status**: PASSED

## Gates

| Gate         | Status  | Command                        | Notes                              |
|--------------|---------|--------------------------------|------------------------------------|
| license-check | PASS   | `npm run license-check`        | exit 0; no missing headers         |
| lint          | PASS   | `npm run lint`                 | 0 errors, 0 warnings               |
| typecheck     | PASS   | `npm run typecheck`            | no diagnostics                     |
| build         | PASS   | `npm run build`                | dist/ rebuilt cleanly              |
| unit          | PASS   | `npm run test:unit`            | 2205 passed, 1 skipped (145 files) |
| integration   | PASS   | `npm run test:integration`     | 220 passed, 1 skipped (27 files)   |
| secrets       | PASS   | `npm run validate:secrets`     | no leaks detected                  |
| commitlint    | PASS   | `npm run commitlint:last`      | 0 problems, 0 warnings             |
| ui            | SKIPPED | n/a                           | no UI surface changed              |

## Failure detail

None.

## Drift signal

no
