DONE
commit: 650f0c06
test_command: npx vitest run src/cli/commands/analytics/sync/bootstrap/__tests__/run-bootstrap.test.ts src/cli/commands/analytics/sync/__tests__/webhook-target.test.ts src/cli/commands/analytics/__tests__/analytics-sync-cli.test.ts
paths:
- src/cli/commands/analytics/sync/bootstrap/run-bootstrap.ts (new)
- src/cli/commands/analytics/sync/bootstrap/types.ts (new)
- src/cli/commands/analytics/sync/bootstrap/guided.ts (new, Task 7 placeholder)
- src/cli/commands/analytics/sync/bootstrap/__tests__/run-bootstrap.test.ts (new)
- src/cli/commands/analytics/sync/targets/webhook-target.ts (modified: optional timeoutMs)
- src/cli/commands/analytics/sync/__tests__/webhook-target.test.ts (modified: timeoutMs tests)
- src/cli/commands/analytics/index.ts (modified: createSyncBootstrapCommand, registered first in createSyncCommand)
- src/cli/commands/analytics/__tests__/analytics-sync-cli.test.ts (modified: bootstrap help/dispatch coverage)
renames: none.
reused: validateTriggerUrl/validateLookbackDays/validateIncludeExternal (config-store.ts), buildInstallCommand (install-command.ts), errorMessage (redact.ts), getBootstrapStatePath (bootstrap/state-store.ts, only for createRealBootstrapDeps — never called in the --webhook path), SyncDeliveryError (utils/errors.ts).
standards: TDD (RED observed: "Cannot find module '../run-bootstrap.js'", then GREEN); ES modules + .js extensions; @/ alias for utils imports; no `any`; explicit return types on exports; runner/deps convention mirrored from install.ts (never throws, never calls process.exit, deps-injected). Source: AGENTS.md, install.ts header comment, common.md.
concerns:
- Exact wording of the `--webhook` mode's check line, cleanup line and UPDATE_HINT, and the no-TTY message, was not specified verbatim by spec/brief (unlike the help description and step headings); I wrote them to satisfy the stated constraints (no sig anywhere, naming codemie self-update with no version, naming both --webhook and "terminal" for the no-TTY case) — reviewable/adjustable wording.
- Placed `bootstrap` first in the sync subcommand list (`['bootstrap', 'install', 'status', 'run', 'uninstall']`); brief said only "beside install/status/run/uninstall" with no explicit order.
- webhook-target.ts's timeoutMs change was implemented before its test (not a strict RED-first case, since brief's test-first list only names run-bootstrap.test.ts cases); added coverage in the existing webhook-target.test.ts and confirmed GREEN.
- `createRealBootstrapDeps()`'s prompter and the real `send`/`openUrl` wiring are not exercised by any test here (brief's test list only covers `runBootstrap`'s pure logic via injected fakes); Task 7 will exercise the prompter through the guided wizard.
- Full `npx vitest run src/cli/commands/analytics` (835 tests) and `npx tsc --noEmit` both pass; `npx eslint` on all changed files is clean.
