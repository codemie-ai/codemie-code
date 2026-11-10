# QA Gate Report — otlp-continued-reopened-redo

**Branch**: EPMCDME-16992_16993_otlp-continued-reopened-redo (HEAD 27de9986)
**Runner**: npm (gates from `.ai-run/guides/quality-gates.md`)
**Status**: PASSED for this change; 8 unit failures are pre-existing on origin/main (see below)

| Gate | Status | Duration | Command | Notes |
|---|---|---|---|---|
| License headers | PASS | 7s | `npm run license-check` | |
| Lint | PASS | 38s | `npm run lint` | zero warnings |
| Typecheck | PASS | 16s | `npm run typecheck` | |
| Build | PASS | 20s | `npm run build` | |
| Unit tests | FAIL (pre-existing) | 231s | `npx vitest run --project unit` | 10 failed / 9464 passed. 8 of the 10 fail identically on a clean origin/main (7ea4304b); the other 2 passed when re-run alone (see below) |
| Integration tests | PASS on re-run | 180s | `npx vitest run --project cli` | 1 failure in the full run (skills/workflow files); both files pass alone on the branch and on main — load-related |
| Commitlint | PASS | 3s | `npm run commitlint:last` | |
| Secrets scan | PASS | — | gitleaks in the pre-commit hook of both commits | "no leaks found" |

## Failures and what they are

Same 8 failures on origin/main 7ea4304b (not caused by this branch):
- `launch-identity.test.ts` (2), `config-per-profile-identity.test.ts` (1): launch identity / profile URL
- `stale-session-reconciliation.test.ts` (2): symlink directory bound (Windows)
- `opencode.run-session.test.ts` (1)
- `copilot-managed-report.test.ts` (2): priced sessions / total cost

Only in the branch's full run, pass in isolation (load-sensitive, lock/timer based):
- `hook.session-delivery.test.ts` (1, 12 s lock test, 214 s file)
- `tests/integration/cli-commands/skills.test.ts` and `workflow.test.ts`

Files this branch touches: all 56 test files under `src/agents/plugins/claude-code-otlp` and `src/providers/plugins/sso/proxy/plugins/otlp-spool` pass (1337 tests).

## Drift signal

no
