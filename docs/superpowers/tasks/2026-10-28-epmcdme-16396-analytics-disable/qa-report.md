# QA Gate Report — epmcdme-16396-analytics-disable

**Branch**: EPMCDME-16396_analytics-disable
**Runner**: npm
**Status**: PASSED (with pre-existing, unrelated failures noted)

## Gates

| Gate | Status | Command | Notes |
|---|---|---|---|
| license-check | PASS | `npm run license-check` | No missing/stale headers. |
| lint | PASS | `npm run lint` | Zero warnings. |
| typecheck | PASS | `npm run typecheck` | No diagnostics. |
| build | PASS | `npm run build` | `dist/` rebuilt, plugin assets + statusline bundle copied. |
| unit | PASS* | `npx vitest run --project unit` | 6177 passed, 2 skipped, 14 failed across 6 files — all 14 confirmed pre-existing on the base commit (`71093df1`) before this ticket's changes, via a before/after comparison. None touch claude-code-otlp, analytics-command, analytics-status, or preferences. |
| cli (integration) | PASS* | `npx vitest run --project cli` | 278 passed, 10 skipped, 4 failed in `tests/integration/sso-claude-plugin.test.ts` — confirmed pre-existing on the base commit via the same comparison. Unrelated to this ticket (Claude plugin auto-install arg injection, not the analytics gate). |

## Pre-existing failures (not introduced by this change)

- `src/providers/core/__tests__/providers-core.test.ts` (8 tests) — `claude.enrichArgs` plugin-dir/model injection mismatches.
- `src/agents/core/__tests__/AgentCLI-model-source.test.ts` (1 test) — `CODEMIE_MODEL_SOURCE` propagation.
- `src/agents/plugins/codex/__tests__/codex.incremental-sync.test.ts` (1 test) — sync URL/credentials.
- `src/agents/plugins/opencode/__tests__/opencode.incremental-sync.test.ts` (1 test) — sync URL/credentials.
- `src/agents/plugins/pi/__tests__/pi.incremental-sync.test.ts` (1 test) — sync URL/credentials.
- `src/providers/plugins/sso/__tests__/sso.auth-gate.test.ts` (2 tests) — expects `https://codemie.example.com`, receives a real-looking lab URL; environment/config leakage on this machine, unrelated to the gate logic this ticket adds.
- `tests/integration/sso-claude-plugin.test.ts` (4 tests) — Claude plugin auto-install arg injection (`--settings`/`--model` vs `--plugin-dir`).

All were independently reproduced on a clean `git stash` of this branch's changes against the same working tree, confirming they predate and are unrelated to this ticket.

## Drift signal

no
