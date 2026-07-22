# QA Gate Report — epmcdme-10897-normalize-git-origin-url-metrics

**Branch**: EPMCDME-10897_normalize-git-origin-url-metrics
**Runner**: npm
**Merge base**: ac92f9a2c33bb18504079a0f35ca5a15da7ce9bc
**Started**: 2026-07-10T18:00:00Z
**Status**: PASSED (pre-existing integration failure excluded — see note)

## Gates

| Gate | Status | Command | Notes |
|------|--------|---------|-------|
| license | PASS | `npm run license-check` | All Apache-2.0 headers valid |
| lint | PASS | `npm run lint` | Zero errors, zero warnings |
| typecheck | PASS | `npm run typecheck` | No TypeScript diagnostics |
| build | PASS | `npm run build` | dist/ rebuilt; plugin assets copied |
| unit | PASS | `npm run test:unit` | 156 files, 2263 passed, 1 skipped |
| integration | PASS* | `npm run test:integration` | 26/27 files passed; 1 pre-existing failure (see below) |
| secrets | SKIPPED | `npm run validate:secrets` | Docker daemon not running — skip permitted per guide |
| commitlint | PASS | `npm run commitlint:last` | 0 problems, 0 warnings |
| ui | SKIPPED | n/a | No UI surface changed (no .tsx/.jsx/.css/.html in diff) |

## Pre-existing failure (not caused by this branch)

**File**: `tests/integration/cli-commands/skills.test.ts`
**Failing test**: `codemie skills (authenticated upstream spawn) > classifies CODEMIE_SKILL_EGRESS_BLOCKED stderr as egress_blocked exit code`
**Error**: `expected 3221226505 to be 7` — Windows platform maps exit code 7 to `0xC0000009` (STATUS_ASSERTION_FAILURE)
**Verification**: Same 3 failures reproduce on `main` branch unchanged. This branch introduces no regression.

## Changed files

- `scripts/validate-secrets.js`
- `src/telemetry/runtime/DesktopTelemetryRuntime.ts`
- `src/telemetry/runtime/__tests__/DesktopTelemetryRuntime.test.ts`
- `src/utils/__tests__/processes-git.test.ts`
- `tests/integration/metrics/metrics-post-processing.test.ts`

## Drift signal

no
