# QA Gate Report — epmcdme-12992-session-origin-validation

**Branch**: EPMCDME-12992  
**Runner**: npm  
**Started**: 2026-07-01T14:02:00Z  
**Status**: PASSED

## Gates

| Gate        | Status  | Command                       | Notes |
|-------------|---------|-------------------------------|-------|
| license     | PASS    | `npm run license-check`       | Apache-2.0 headers OK; 457 MIT, 108 Apache-2.0 |
| lint        | PASS    | `npm run lint`                | 0 errors, 0 warnings (auto-fixed: `no-control-regex` via `\p{Cc}/gu`) |
| typecheck   | PASS    | `npm run typecheck`           | No diagnostics |
| build       | PASS    | `npm run build`               | dist/ rebuilt; all plugin assets copied |
| unit        | PASS    | `npm run test:unit`           | 148 files, 2194 passed, 1 skipped |
| integration | PASS    | `npm run test:integration`    | 27 files, 220 passed, 1 skipped |
| secrets     | SKIPPED | `npm run validate:secrets`    | No staged changes to scan (changes uncommitted) |
| commitlint  | PASS    | `npm run commitlint:last`     | 0 problems, 0 warnings |
| ui          | SKIPPED | —                             | No UI surface changed |

## Lint auto-fix applied

The ANSI sanitizer regex `[\x00-\x1F\x7F-\x9F]` triggered `no-control-regex`.  
Replaced with `\p{Cc}/gu` (Unicode Control category — identical coverage, ESLint-clean).

## Drift signal

no
