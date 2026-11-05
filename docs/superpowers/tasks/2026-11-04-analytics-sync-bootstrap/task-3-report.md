DONE

commit: 87c8ec97
test_command: npx vitest run src/cli/commands/analytics/sync/bootstrap/__tests__/links.test.ts src/cli/commands/analytics/sync/bootstrap/__tests__/timezones.test.ts > docs/superpowers/tasks/2026-11-04-analytics-sync-bootstrap/test.local.log 2>&1; echo "EXIT=$?"; tail -25 docs/superpowers/tasks/2026-11-04-analytics-sync-bootstrap/test.local.log
paths:
- src/cli/commands/analytics/sync/bootstrap/links.ts
- src/cli/commands/analytics/sync/bootstrap/timezones.ts
- src/cli/commands/analytics/sync/bootstrap/__tests__/links.test.ts
- src/cli/commands/analytics/sync/bootstrap/__tests__/timezones.test.ts
renames: collector's `InputError` ported as `BootstrapInputError` (name set via `this.name = 'BootstrapInputError'`, mirroring src/utils/errors.ts CodeMieError pattern). No other call sites to update (new files).
reused: none from this repo besides the error-class shape convention in src/utils/errors.ts; logic ported verbatim from codemie-dev collector src/links.js and src/timezones.js.
standards: TDD (RED confirmed on missing module before impl, GREEN after); ES modules with .js import extensions; explicit return types on all exports; no `any`; Vitest describe/it/expect matching existing __tests__ files in sync/; tsc --noEmit and eslint clean; pre-commit hooks (lint-staged, typecheck, gitleaks) passed.
concerns: validateTriggerUrl is NOT in links.ts per task's interface spec — it already exists in src/cli/commands/analytics/sync/config-store.ts from an earlier commit (EPMCDME-16487 validateTriggerUrl work); intentionally not duplicated here. cleanPaste extended beyond the collector (which only strips ASCII quotes/<>) to also strip typographic quotes “”/‘’ per this task's spec line; covered by an added test.
