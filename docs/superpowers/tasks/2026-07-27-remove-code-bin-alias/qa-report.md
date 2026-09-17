# QA Gate Report — remove-code-bin-alias

**Branch**: EPMCDME-13589
**Runner**: npm
**Started**: 2026-07-27T09:10:00Z
**Status**: PASSED

## Gates

| Gate         | Status  | Command                       | Notes |
|--------------|---------|-------------------------------|-------|
| license-check | PASS   | `npm run license-check`       | All dependencies have compatible licenses |
| lint          | PASS   | `npm run lint`                | 0 errors, 0 warnings |
| typecheck     | PASS   | `npm run typecheck`           | No TypeScript diagnostics |
| build         | PASS   | `npm run build`               | dist/ rebuilt cleanly; copy-plugin succeeded |
| unit          | PASS   | `npm run test:unit`           | 162 test files, 2382 tests passed, 1 skipped |
| integration   | PASS   | `npm run test:integration`    | 28 test files, 196 tests passed, 11 skipped |
| commitlint    | PASS   | `npm run commitlint:last`     | 0 problems, 0 warnings |
| ui            | SKIPPED | —                            | No UI surface files changed (.tsx/.jsx/.css/.html) |

## Drift signal

no
