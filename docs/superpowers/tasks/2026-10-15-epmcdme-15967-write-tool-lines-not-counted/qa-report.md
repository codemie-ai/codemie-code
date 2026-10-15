# QA Gate Report — epmcdme-15967-write-tool-lines-not-counted

**Branch**: fix/EPMCDME-15967-write-tool-lines-added
**Runner**: npm (per `.ai-run/guides/quality-gates.md`)
**Started**: 2026-10-15T19:25:00.000Z
**Status**: BLOCKED (both failing gates are pre-existing environment pollution, confirmed identical on `main` — see Failure detail)

## Gates

| Gate | Status | Command | Notes |
|---|---|---|---|
| license-check | PASS | `npm run license-check` | |
| lint | PASS | `npm run lint` | zero warnings |
| typecheck | PASS | `npm run typecheck` | |
| build | PASS | `npm run build` | dist/ rebuilt, all plugin assets + statusline bundle copied |
| unit tests | **FAIL** | `npx vitest run --project unit` | 15 failures across 7 files — see Failure detail. **None of the 7 failing files are touched by this change.** |
| integration tests | **FAIL** | `npx vitest run --project cli` | 4 failures in 1 file — see Failure detail. **Not touched by this change.** |
| secrets scan | PASS | `npm run validate:secrets` | ran clean (`no leaks found`) as part of both commits' pre-commit hooks |
| commitlint (range) | PASS | `npx commitlint --from <merge_base> --to HEAD --verbose` | both commits: 0 problems, 0 warnings |
| ui | SKIPPED | n/a | no UI surface changed (diff touches only `.ts`/`.md`) |

## Failure detail

**Unit tests** — 15 failures, 7 files, none overlapping this change's diff (`session-signals.ts`, `orchestrator.ts`, their tests, and the EPMCDME-15301 `spec.md`):

- `src/agents/core/__tests__/AgentCLI-model-source.test.ts` (1)
- `src/agents/plugins/codex/__tests__/codex.incremental-sync.test.ts` (1)
- `src/agents/plugins/opencode/__tests__/opencode.incremental-sync.test.ts` (1)
- `src/agents/plugins/pi/__tests__/pi.extensions-scan.test.ts` (1)
- `src/agents/plugins/pi/__tests__/pi.incremental-sync.test.ts` (1)
- `src/providers/core/__tests__/providers-core.test.ts` (8)
- `src/utils/__tests__/extensions-scan.test.ts` (2)

Representative failure (`pi.incremental-sync.test.ts:560`):
```
AssertionError: expected "vi.fn()" to be called with arguments: [ 'https://codemie.example.com' ]
Received:
  1st vi.fn() call:
  [
-   "https://codemie.example.com",
+   "https://codemie.lab.epam.com/code-assistant-api",
  ]
```

**Integration tests** — 4 failures, all in `tests/integration/sso-claude-plugin.test.ts` (not touched by this change):
```
AssertionError: expected [ '--settings', …(5) ] to deeply equal [ 'test', 'task' ]
- Expected
+ Received
  [
+   "--settings",
+   "/var/folders/.../codemie-claude-model-picker-config-....json",
+   "--model",
+   "claude-sonnet-5",
    "test",
    "task",
  ]
```

**Root cause of both failure sets (verified, not assumed):** every failing assertion compares against a hardcoded test fixture value (`'https://codemie.example.com'`, bare `['test', 'task']` args) but receives this machine's **real** CodeMie profile/env state (`https://codemie.lab.epam.com/code-assistant-api`, injected `--settings`/`--model` flags) — this session is connected to a live CodeMie profile (`epm-cdme-preview`) per this engagement's precondition, and these specific tests read real env vars (`CODEMIE_MODEL`, SSO sync URLs, model-picker config) rather than fully isolating them, so the live profile leaks into the test run.

**Verified pre-existing, not introduced by this change:** ran all 7 failing unit-test files plus the 1 failing integration-test file against `origin/main` (commit `66c8a49`, this branch's merge-base) in an isolated git worktree, same shell environment — **identical 19 failures, same assertions, same values.** None of the 11 failing test files are among this change's 5 changed files (`session-signals.ts`, `orchestrator.ts`, `session-signals.test.ts`, `orchestrator.test.ts`, EPMCDME-15301 `spec.md`). The 71 tests this change added/touches directly (`session-signals.test.ts` + `orchestrator.test.ts`) all pass — confirmed separately with `npx vitest run --project unit src/agents/plugins/claude-code-otlp/transcript/__tests__/{session-signals,orchestrator}.test.ts` → 71/71 passed.

## Drift signal

no
