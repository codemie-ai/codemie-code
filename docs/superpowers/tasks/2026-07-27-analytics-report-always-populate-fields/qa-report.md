# QA Gate Report — EPMCDME-13643

**Branch**: EPMCDME-13643_analytics-report-always-populate-fields
**Base**: origin/main @ 31720f4
**Runner**: npm (from `.ai-run/guides/quality-gates.md`, guide-first)
**Started**: 2026-07-27T10:45:00Z
**Status**: PASSED — with pre-existing baseline noise called out below

## Gates

| Gate | Status | Command | Notes |
|---|---|---|---|
| license-check | PASS | `npm run license-check` | headers report is dep summary only; no source-file violations |
| lint | BASELINE-FAIL | `npm run lint` | 5 files with pre-existing errors; **none touched by this branch**. See "Pre-existing baseline noise" below. |
| typecheck | PASS | `npm run typecheck` | `tsc --noEmit` clean |
| build | PASS | `npm run build` | dist rebuilt, copy-plugin succeeded |
| test:unit | PASS | `npm run test:unit` | 162 files, 2397 passed, 1 skipped |
| test:integration | BASELINE-FAIL | `npm run test:integration` | 19/29 file suites pass; 3 skills.test.ts assertion fails + 6 files failed to load due to missing `node-pty` package. **None touch this branch's code.** See "Pre-existing baseline noise" below. |
| commitlint (range) | PASS | `npx commitlint --from origin/main --to HEAD` | all 4 commits follow Conventional Commits |

## Pre-existing baseline noise (not caused by this branch)

The lint and integration-test gates fail on `main` for reasons unrelated to this change. Every failing file/test is either untouched by this branch's diff or blocked on a missing optional dependency in the local test harness.

### Lint — 5 files with pre-existing errors (all untouched by this branch)

| File | Errors | Last touched |
|---|---|---|
| `assets/skills-sh-egress-guard.cjs` | 7 (no-undef: process, Buffer) | ac0163d (skills egress guard PR) |
| `scripts/compare-codex-conversations.mjs` | 32 (no-undef) | 60fbed2 (Codex sync PR) |
| `scripts/postinstall.mjs` | 11 (no-undef) | c594663 (Claude Code bump) |
| `scripts/prepare-install-artifacts.mjs` | 3 (no-undef) | 4b7b35c (native bootstrap) |
| `src/agents/plugins/claude/plugin/statusline.mjs` | 13 (no-undef) | 4a393d4 (statusline consolidation) |

Confirmed via `git diff --name-only origin/main...HEAD` — none of these files are in this branch's changed set.

### Integration tests — pre-existing env issue + Windows subprocess crash

- **6 test-file "failures"** (`doctor.test.ts`, `error-handling.test.ts`, `help.test.ts`, `list.test.ts`, `profile.test.ts`, `version.test.ts`, `workflow.test.ts`, `skills-integration.test.ts`) — all failed at import with `Cannot find package 'node-pty' imported from tests/helpers/pty-session.ts`. Missing optional dependency in the local harness; not a code failure.

- **3 test assertion failures** in `tests/integration/cli-commands/skills.test.ts`:
  - `add: forwards source and explicit --agent to upstream argv` — argv arity mismatch (subprocess spawn behavior in skills.sh CLI).
  - `propagates upstream non-zero exit codes` — actual exit `3221226505` (0xC0000005 = Windows Access Violation) instead of expected `7`. The skills.sh child process is segfaulting on Windows.
  - `classifies CODEMIE_SKILL_EGRESS_BLOCKED stderr as egress_blocked exit code` — same Windows subprocess crash.

None of these touch `src/cli/commands/analytics/**` or `src/agents/core/BaseAgentAdapter.ts` — the only surfaces this branch modifies.

## This branch's own tests

- `payload-builder.test.ts` — 20 passed (11 pre-existing + 6 fallback derivation + 1 regression-guard split + 1 NaN/Infinity fix-up regression + 1 duration=0 + zero-sessions edge case)
- `analytics-cli-metadata.test.ts` — 9 passed (5 pre-existing + 1 --last periodEnd + 3 --session/--project/--branch/bare wiring)
- `BaseAgentAdapter-session-report.test.ts` — 12 passed (8 pre-existing + 4 ConfigLoader fallback)

All new coverage GREEN on the current HEAD (021a0cd). Typecheck + lint on the touched files is clean.

## Drift signal

**no** — implementation matches the approved spec. `buildPayload` remains pure, `ReportMeta` fields stay optional, precedence order (`ctx → derived → omit`) is implemented as documented, `session-report.ts` untouched, CLI surface unchanged.
