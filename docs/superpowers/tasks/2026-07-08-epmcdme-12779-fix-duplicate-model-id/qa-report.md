# QA Gate Report — epmcdme-12779-fix-duplicate-model-id

**Branch**: EPMCDME-12779
**Runner**: npm
**Started**: 2026-07-08T19:09:00Z
**Status**: BLOCKED (pre-existing failure in unrelated test)

## Gates

| Gate | Status | Duration | Command | Notes |
|------|--------|----------|---------|-------|
| license-check | PASS | ~5s | `npm run license-check` | No missing Apache-2.0 headers |
| lint | PASS | ~8s | `npm run lint` | Zero errors, zero warnings |
| typecheck | PASS | ~4s | `npm run typecheck` | No TypeScript diagnostics |
| build | PASS | ~30s | `npm run build` | dist/ rebuilt cleanly |
| unit | PASS | ~96s | `npm run test:unit` | 2237 passed, 1 skipped (2238 total) |
| integration | FAIL | ~140s | `npm run test:integration` | **See note** — 3 failures in skills.test.ts (pre-existing, unrelated) |
| secrets | SKIPPED | — | `npm run validate:secrets` | Docker not available (expected local skip per guide) |
| commitlint | PASS | ~2s | `npm run commitlint:last` | fix(setup) commit passes Conventional Commits |
| ui | SKIPPED | — | n/a | No UI surface changed |

## Failure detail

**Blocked gate**: integration  
**File**: `tests/integration/cli-commands/skills.test.ts`  
**Group**: "codemie skills (authenticated upstream spawn)"

```
× propagates upstream non-zero exit codes (not collapsed to 1)
  Expected: 7
  Received: 3221226505   ← Windows NT process exit code (0xBFFFxxxx range)

× classifies CODEMIE_SKILL_EGRESS_BLOCKED stderr as egress_blocked exit code
  Expected: 7
  Received: 3221226505

× add: forwards source and explicit --agent to upstream argv
  Expected exit code: 0
```

**Pre-existing status confirmed**: `git log -- tests/integration/cli-commands/skills.test.ts` shows the last modifications were commits `2cf8355` (Kimi plugin) and `75e06c6` (skills find), both on main and unrelated to this branch. None of our 7 changed files touch skills spawning or process exit code handling.

**Model-tier integration tests (directly relevant)**: 8/8 PASS in `tests/integration/model-tier-e2e.test.ts`, covering the CODEMIE_* → ANTHROPIC_* env var transformation and CLAUDE_CODE_SUBAGENT_MODEL mapping that this fix touches.

## Drift signal

No — implementation matches the plan. The positive-inclusion keyword guard, CLAUDE_CODE_SUBAGENT_MODEL fallback, and test isolation fixes are all present and passing.
