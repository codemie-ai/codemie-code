# Technical Research

**Task**: migrations, cli proxy analytics status, stdout logger, json output
**Generated**: 2026-11-05
**Research path**: filesystem (codegraph MCP tool not available: tool-not-found)

---

## 1. Original Context

task_context (verbatim ticket EPMCDME-16716, Bug, Minor):

Summary: [CodeMie CLI][Analytics] `codemie proxy analytics status --json` prints the migration banner to stdout before the JSON on a clean CODEMIE_HOME

Environment: CodeMie CLI 0.16.3, Windows 11, Node v24.19.0.

Description: On the first run with a clean CODEMIE_HOME, `codemie proxy analytics status --json` writes the migration progress banner to stdout and only then the JSON. The output cannot be parsed with JSON.parse. The second run with the same CODEMIE_HOME prints clean JSON.

Steps: 1) point CODEMIE_HOME at an empty dir; 2) run `codemie proxy analytics status --json > out.txt`; 3) JSON.parse(out.txt) fails; 4) second run passes.

Actual (1st run, clean home): stdout shows `🔄 Running 9 migration(s)...`, then one block per migration (`[001-config-rename] Rename config.json to codemie-cli.config.json`, `⊘ Skipped: no-old-config`, ...), then the JSON. 2nd run: JSON only.

Expected: With --json stdout contains only valid JSON on every run, including first run on a clean installation. Progress and banner messages are not written to stdout.

Impact: scripts/CI parsing `codemie proxy analytics status --json` fail on first call on a fresh machine.

Acceptance criteria:
* `codemie proxy analytics status --json` on a clean CODEMIE_HOME prints only valid JSON to stdout.
* The migration banner, if shown, does not appear in stdout when --json is used.

Focus (from caller): find where the migration runner prints its banner, where it is triggered from the CLI entrypoint (before command dispatch), how other --json commands avoid pollution, and whether any other commands with --json are affected.

---

## 2. Codebase Findings

### Existing Implementations

Root cause is confirmed in code, with two cooperating pieces:

- `bin/codemie.js:25-49` (plain JS wrapper, outside the TS build/lint) runs migrations on every startup, BEFORE `import('../dist/cli/index.js')` (line 87) and therefore before commander parses/dispatches. There is no preAction hook and `src/cli/index.ts` has no migration code.
  ```js
  // bin/codemie.js:25-28
  const isHookProcess = process.argv[2] === 'hook' || process.argv[2] === 'sound';
  if (isHookProcess) { logger.setConsoleStream(null); }
  // :31  const { MigrationRunner } = await import('../dist/migrations/index.js');
  // :36-49
  try {
    if (await MigrationRunner.hasPending()) {
      await MigrationRunner.runPending({
        silent: isHookProcess  // Show migration messages to user, except in a hook
      });
    }
  } catch (error) {
    if (isHookProcess) { logger.warn('Warning: Migration failed:', error.message); }
    else { console.error('Warning: Migration failed:', error.message); }
  }
  ```
  `silent` is keyed ONLY on the hook/sound check. Nothing considers `--json`, non-TTY, or any env var.
- `src/migrations/runner.ts` prints the banner with raw `console.log(chalk...)` (stdout), guarded only by `if (!silent)`:
  - L35 `console.log(chalk.bold(\`\n🔄 Running ${pending.length} migration(s)...\n\`))`
  - L47 `[id] description`
  - L59 `✓ Applied`, L69 `⊘ Skipped: ${reason}`, L81 `✗ Failed: ...`, L90 `✗ Error: ...`
  - L95 blank line between migrations
  - L100 `→ N migration(s) applied` (only when applied > 0)
  - Signature L15-19: `runPending(options?: { silent?: boolean; dryRun?: boolean; autoCleanup?: boolean })`, `silent` defaults to false (L20). `hasPending()` at L129-132. `autoCleanup` is an unimplemented stub (L107-116, unrelated).
  - File-log lines use `logger.info/debug` (L23, 28, 32, 44, 57, 67, 79, 88, 104) and never reach stdout.
  - Because it uses `console.log` and not `logger`, `logger.setConsoleStream(...)` cannot silence it.
- `src/migrations/registry.ts`: static array; migrations self-register on import. `src/migrations/index.ts:25-34` imports 001-010 (10 migrations in the current tree; the ticket says 9 at CLI 0.16.3, migration 010 clear-cloned-profile-identity evidently landed later; the banner count will read 10 on current code).
- `src/migrations/tracker.ts`: ledger at `getCodemiePath('migrations.json')` (L14-16); `{version:1, migrations:[{id, appliedAt, success}]}`. `getPendingMigrations` (L124-138) filters ids recorded `success:true`. `runPending` records applied AND skipped as success (runner L62, 73) unless `dryRun`; failures are not recorded and retry. Missing file = empty history (L34-35), so clean home = all pending = banner. Corrupt file is renamed to `migrations.json.corrupt` and the banner re-prints (L42-58). With nothing pending, `runPending` is never called, hence the second run is clean.
- `src/cli/commands/proxy/analytics-command.ts`:
  - L303-307: `analytics.command('status')...option('--json', 'Emit status as JSON instead of formatted output').action((opts) => showStatus(opts))`
  - L257-268 `showStatus` (inside `withErrorHandling`): L262 (Claude) and L266 (Copilot) `console.log(opts.json ? JSON.stringify(status, null, 2) : format...)`.
  - The command itself is clean; all pollution comes from pre-command startup. `analytics-status.ts` (collect/format) and `analytics-hints.ts` have no migration code.
- `src/utils/logger.ts`: `consoleSink` (L43); `setConsoleStream(stream | null)` (L53-62; null = drop console output, file sink unaffected). Routing: `debug` -> stderr via consoleSink.error only when `CODEMIE_DEBUG` (L342); `info` file-only (L348); `success` (L353) and `status` (L359) -> stdout via consoleSink.log; `warn` (L408) / `error` (L385-393) -> stderr.
- `src/utils/whatsnew.ts:236-307`: `OUTPUT_CONTRACT_ARGS = {--version, -V, --task, --help}` and `shouldRunUpgradeNotice(argv, isTTY)` (false when non-TTY, output-contract arg, or `hook`). This is the existing "skip chatter for output-contract invocations" mechanism. `--json` is NOT in the set. It is harmless there only because the notice is TTY-gated, whereas the migration banner is not.
- `bin/codemie.js:54-61`: `checkAndPromptForUpdate` skipped only for hook processes and test env (`NODE_ENV==='test'` / `VITEST==='true'`); `src/utils/cli-updater.ts` was NOT inspected for stdout behavior in `--json` mode (open item). Migrations are not skipped in test env.

### Architecture and Layers Affected

Layers (from `.ai-run/guides/architecture/architecture.md`, CLI -> Registry -> Plugin):
- Bin wrapper / startup side effects: `bin/codemie.js` (decision point for `silent`)
- Migrations: `src/migrations/runner.ts` (print sites), `registry.ts`, `tracker.ts`, `*.migration.ts`
- Utils: `src/utils/logger.ts`, `paths.ts`, `whatsnew.ts`
- CLI (commander): `src/cli/commands/proxy/analytics-command.ts` (unchanged by the bug, may need no edit)

### Integration Points

- Dependency direction is one way: `bin/codemie.js` -> `src/migrations` -> `src/utils` / `src/env`. No cycles; migrations never import `src/cli`.
- Outbound deps of migrations: `logger.js` (runner, tracker, 001, 002, 003, 005, 006, 009, 010), `paths.js` (tracker, 001, 002, 006, 010), `atomic-write.js` (tracker), `config.js` ConfigLoader (004, 005, 007, 010), `env/types.js`, `hook-command.js` (006), `errors.js`/`slug.js` (005), `chalk` (runner only). Intra-module: 008 imports 006; 010 imports MigrationTracker.
- Inbound: effectively only `bin/codemie.js` (dynamic import of `../dist/migrations/index.js`); tests import individual migrations.
- `bin/codemie.js` imports from `dist/`, so any fix requires a rebuild before CLI integration tests run.
- Other commands with a `--json` boolean option are ALL affected by the same startup banner on a first run with a clean home, because every command goes through `bin/codemie.js`:
  - `src/cli/commands/proxy/analytics-command.ts:306` (`proxy analytics status`)
  - `src/cli/commands/proxy/index.ts:214` (`proxy status`)
  - `src/cli/commands/skills/list.ts:28`, `skills/find.ts:42`
  - `src/cli/commands/sdk/*`: `workflows.ts`, `users.ts`, `skills.ts`, `llm.ts`, `assistants.ts`, `integrations.ts`, `datasources.ts`, `categories.ts`, `assistant-builder/commands.ts`
  - Gotcha: in several `sdk/*` commands (`skills.ts` L170/196, `assistants.ts` L165/197, `integrations.ts` L234/263, `datasources.ts` L209/305/337, `categories.ts` L182/211) `--json <path>` takes a file INPUT, not an output-format switch. A naive "`--json` anywhere in argv => silent" check would false-positive there (harmless for stdout purity but semantically loose; migration messages would be hidden for non-JSON-output invocations).
  - Other machine-output flags also exposed: `log --format json|jsonl` (`src/cli/commands/log/index.ts:30,78,102`), `--print-config` (docs/COMMANDS.md:510), `--version` / `--task` (the existing control tests assert the banner DOES appear for `version`/`--version`).
- `bin/codemie-mcp-proxy.js` already skips migrations entirely so stdout stays clean for JSON-RPC (openwiki `quickstart.md:60,80`, `architecture/cli-surface.md:140`). This is a second precedent.

### Patterns and Conventions

- No shared mechanism exists for --json commands to avoid pollution: each command just chooses `console.log(JSON.stringify(...))` vs formatted text. No silent mode, no `argv.includes('--json')` check, no stderr routing for the migration output exists today.
- Stdout-protection precedents: (1) `isHookProcess` + `logger.setConsoleStream(null)` + `runPending({silent})` (commit 04f17cb5, #721, "fix(cli): keep hook stdout for the answer to the agent"), the template for this fix; (2) `OUTPUT_CONTRACT_ARGS`/`shouldRunUpgradeNotice`; (3) MCP proxy wrapper skipping migrations.
- Convention: stdout is reserved for the command's answer or protocol (hook answer, JSON-RPC, `--json`, `--print-config`); diagnostics go to the log file or stderr. Migration failure at startup must never be fatal (warn, and the command still runs).
- Project rules to honor: `.js` import extensions, no `console.log` for debug, ESM, `logger` over `console` (the runner violates the code-quality checklist).

Candidate fix options (for downstream planning; not a decision):
- (a) In `bin/codemie.js`, set `silent: isHookProcess || wantsMachineOutput`, where `wantsMachineOutput` is derived from `process.argv` (boolean `--json`; consider also non-TTY stdout; must not misfire on `--json <path>`). Smallest change, mirrors existing precedent. Silent mode still writes to the file log, so no diagnostics are lost.
- (b) Route runner banner to stderr (`console.error`), so `JSON.parse` of stdout passes. Breaks the interactive stdout expectation, and still pollutes when 2>&1; changes two hook-stdout control tests.
- (c) Route the banner through `logger` with a configurable sink (largest change, most consistent with code-quality guide).
- (a)+(b) combos are possible. The acceptance criteria are satisfied by silence or stderr; "banner, if shown, does not appear in stdout".

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/development/development-practices.md` (L41-52, 86-131, 278): logging rules; `warn/error/success` user-visible, `debug/info` file only, debug to stderr only with `CODEMIE_DEBUG=true`; no `console.log` for debug. No `--json`/stdout-contract rule.
- `.ai-run/guides/standards/code-quality.md` (L139-147) and `git-workflow.md` (L153): checklist "use `logger.debug()`, no `console.log`".
- `.ai-run/guides/architecture/architecture.md` (L58, 141, 208): points to logger only; nothing on migrations or stdout.
- `.ai-run/guides/testing/testing-patterns.md` (L51-54): Vitest and logger-mock patterns.
- `.ai-run/guides/usage/project-config.md` (L19-26, 209): config files and env vars; no migration env.
- `docs/COMMANDS.md:1271`: existing hook-only silent-migration contract ("A process an agent runs as a hook ... runs pending migrations silently (file log only) ... its stdout carries only its answer to the agent"). Needs an update if `--json` joins it. `docs/COMMANDS.md:1675/~1724` documents `proxy analytics status [--json]`.
- `openwiki/operations/daemon-migrations-and-diagnostics.md:57-99`: migration semantics (must not block a command; failed migrations retried; do not make the wrapper's catch fatal); lists doc and test files to update. Generated; do not hand-edit.
- `docs/superpowers/work-items/EPMCDME-16396.md`: introduced `analytics status [--json]` (AC4). The task dir `docs/superpowers/tasks/2026-11-05-epmcdme-16716-analytics-status-json-stdout/` had no prior content (no spec/plan).

### Architectural Decisions

- Commit 04f17cb5 (#721): hook stdout is the agent's protocol channel, so migrations run silent, update check and prompts are skipped, and the console stream is nulled for hooks. Added `tests/integration/hook-stdout.test.ts` and `src/utils/__tests__/logger-notice.test.ts`.
- MCP proxy wrapper skips migrations to keep stdout JSON-RPC clean.
- No ADR files cover `--json` or stdout purity. No TODO/HACK/DECISION markers in `src/migrations` or `logger.ts`.

### Derived Conventions

- Machine-readable-output invocations should be treated like hook invocations at the wrapper level: silent startup chatter, with diagnostics going to the file log.
- Argv sniffing in `bin/codemie.js` is the accepted way to gate pre-commander behavior (`isHookProcess`, `OUTPUT_CONTRACT_ARGS`), since commander options are not visible yet.

---

## 4. Testing Landscape

### Existing Coverage

- `src/migrations/__tests__/migration-runner-ordering.test.ts`: runner/registry/tracker with fake migrations and a temp `CODEMIE_HOME`; ALWAYS `silent: true`, so the banner path is never tested; no stdout spies.
- `src/migrations/__tests__/migrations-001-004`, `005-skill-slug-format`, `006-resolve-hook-command-paths`, `007-decouple-provider-workspace-config`, `009-raise-otlp-prompt-hook-timeout`, `010-clear-cloned-profile-identity` (`*.migration.test.ts`); migration 008 has NO test file. `src/utils/__tests__/config.migration.test.ts`.
- `tests/integration/hook-stdout.test.ts`: spawns real `bin/codemie.js` in a fresh temp home with a fake npm registry; strips `CODEMIE_*`, `VITEST*`, `NODE_ENV` from child env. Lines 157-174 are CONTROL tests asserting the banner (`migration(s)...`) DOES appear on stdout for `version` and `--version` (will need updating if the fix changes non-hook behavior). Lines 176-208 assert 0 stdout bytes for `hook`/`sound` and `[MigrationRunner] Found` in the file log. Lines 396-409 cover a failing migration inside a hook.
- `tests/integration/analytics/claude-analytics-disable.test.ts`: runs `proxy analytics status --json` via `runIsolatedCli` and `JSON.parse(result.stdout)` (L55-59). Lines 165-176 `beforeAll` carry a comment "Known product defect tracked in EPMCDME-16716 ... first CLI run in an empty CODEMIE_HOME prints the one-time migration banner" and work around it by priming a template home and `cpSync`-ing it per test. After the fix this workaround can be removed or complemented by a direct fresh-home test.
- `src/cli/commands/proxy/__tests__/analytics-command.test.ts`: L178 `status --json prints parseable JSON through the real command wiring (CR-004)`; L403-421 connector variants. Runs only the sub-command, not `bin/codemie.js`.
- `analytics-status.test.ts`, `analytics-advice.test.ts`, `analytics-hints.test.ts`, `daemon-status-contract.test.ts`, `index.test.ts` (proxy `--json` contracts).
- `src/utils/__tests__/logger-notice.test.ts` (console sinks, `setConsoleStream(process.stderr|null)`), other logger tests; `vitest-codemie-home-isolation.test.ts`; `src/agents/core/__tests__/BaseAgentAdapter.version-notice.test.ts:125` ("writes no banner in silent mode, so the JSON-RPC stream stays clean") is a stdout-cleanliness precedent.

### Testing Framework and Patterns

- Vitest `^4.1.5` (commander `^11.1.0`). `vitest.config.ts` projects: `unit` (`src/**/*.test.ts`), `cli` (`tests/integration/**`, excluding `agent-*`), `agent` (real network). All set `CODEMIE_HOME=<tmpdir>/codemie-test-home-<pid>`, `NODE_ENV=test`, `FORCE_COLOR=1`, alias `@` -> `/src`.
- CLI integration tests need `npm run build` first (`bin/codemie.js` imports `dist/`); `claude-analytics-disable.test.ts` throws if `dist/cli/index.js` is missing.
- Patterns: co-located `__tests__`; `vi.spyOn` in `beforeEach`, `vi.restoreAllMocks` in `afterEach`; dynamic `await import()` after spies are set (Vitest 4 rule); `vi.resetModules()` per test; `MigrationTracker.HISTORY_FILE` is static at module load, so tests set `process.env.CODEMIE_HOME` to an `mkdtempSync` dir, `vi.resetModules()`, then dynamic-import runner/registry/tracker together; `logger.close()` before removing the dir.
- Process-level: `tests/helpers/isolated-cli.ts` `runIsolatedCli({codemieHome, userHome}, args, {cwd})` (spawnSync of `bin/codemie.js`, sets `CODEMIE_HOME`/`HOME`/`USERPROFILE`, `NO_COLOR=1`, `FORCE_COLOR=0`, stdout/stderr captured separately) is the right harness for a regression test.

### Coverage Gaps

- No test runs `proxy analytics status --json` on a truly empty `CODEMIE_HOME` and asserts `JSON.parse(stdout)` (existing test is worked around by priming).
- No test of `runPending({ silent: false })` (banner path), apart from the two incidental hook-stdout control tests.
- No unit test of `bin/codemie.js` startup logic (the `silent` decision); only spawn tests.
- Nothing covers `--json` combined with migrations for other commands (`proxy status --json`, `skills list --json`, `sdk ... --json`).
- Migration 008 has no test file.
- Logger `setConsoleStream` tests do not reach the runner because it uses raw `console.log`.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_HOME`: overrides `~/.codemie`; `src/utils/paths.ts:367-373` (`getCodemieHome`), `getCodemiePath` at L385-387; read live, not cached; the migration tracker uses it (`tracker.ts:15`). Set in tests via `vitest.config.ts:32,68,91`, `tests/helpers/test-isolation.ts`, `tests/helpers/isolated-cli.ts:72`.
- `CODEMIE_DEBUG` (`true`/`1`): debug logs to stderr (`logger.ts:319-321, 342`); does not affect the banner.
- `CODEMIE_TIPS` (false/0/no): disables tips and what's-new notice (`tips.ts:133`, `whatsnew.ts:20,225`).
- `CODEMIE_AUTO_UPDATE`: update behavior (`cli-updater.ts:170`).
- `NODE_ENV=test` / `VITEST=true`: skip update check and notice only (`bin/codemie.js:54`).
- Absent: no `CODEMIE_NO_MIGRATE`, skip-migrations, `CODEMIE_SILENT`/`QUIET`, or log-level env var. The migration code reads no env vars.

### Configuration Files

- `~/.codemie/codemie-cli.config.json` (global) and `.codemie/codemie-cli.config.json` (local), schema `version: 2`; migration 001 renames `config.json` -> `codemie-cli.config.json` (`001-config-rename.migration.ts:23-24`); 010 reads it (L70).
- `<CODEMIE_HOME>/migrations.json`: migration ledger (the marker that makes run 2 silent); `.last-seen-version`: what's-new marker (unrelated).
- Migration targets: `<CODEMIE_HOME>/claude-plugin/hooks/hooks.json` and `~/.gemini/extensions/codemie/hooks/hooks.json` (006), `~/.gemini/settings.json` (003), `~/.claude/skills` and `<cwd>/.claude/skills` (005), `<CODEMIE_HOME>/sessions/*` (002).
- `src/migrations/index.ts:25-34` registers 001-010.

### Feature Flags and Deployment Concerns

- No migration flag; the only knob is `runPending({ silent, dryRun, autoCleanup })`, and only `silent` is wired (from `isHookProcess`).
- The `--json` option is invisible to `bin/codemie.js` (runs before commander parses); any gating must inspect `process.argv`.
- CI (`.github/workflows/ci.yml`): Node 20, Linux and `windows-latest`; steps `npm ci`, license-check, lint, build, `vitest run --project unit` and `--project cli` using a pre-built `dist/`. No `CODEMIE_*` env vars set. CI runners and fresh installs always start with a clean home, so every first `codemie ... --json` call emits the banner (emoji and ANSI color via chalk unless `NO_COLOR`).
- `bin/codemie.js` is plain JS outside the TS build and lint; changes there are not typechecked/linted.
- Docs to update with a fix: `docs/COMMANDS.md` (~L1271), openwiki migrations page (regenerated, do not hand-edit).

---

## 6. Risk Indicators

- Blast radius is wider than the ticket: every `--json` command (proxy status, skills list/find, ~25 sdk subcommands) and `--version`/`--task`/`--print-config` share the same startup banner on a clean home. A fix scoped only to `proxy analytics status` would be incomplete; the fix belongs in `bin/codemie.js` / `runner.ts`.
- Argv-sniffing hazard: `--json <path>` in several `sdk/*` commands is an input path, not an output switch. A blanket `argv.includes('--json')` silences migrations for those too (low harm, but a semantics decision). Argv sniffing also cannot see commander-parsed option placement/aliases.
- `bin/codemie.js` has no unit coverage and is outside tsc/eslint; regressions only surface in spawn-based integration tests that need a fresh `dist/` build.
- Existing control tests (`tests/integration/hook-stdout.test.ts:157-174`) assert the banner appears on stdout for `version`/`--version`; any behavior change for non-hook commands must update them deliberately.
- `claude-analytics-disable.test.ts:165-176` carries a priming workaround referencing this ticket; stale after the fix (cleanup opportunity, and it masks the bug until removed).
- Routing the banner to stderr (option b) leaves pollution when callers merge stderr (`2>&1`), which is common in CI scripts; silence (option a) is more robust but hides first-run migration feedback from interactive `--json` users (file log retains it).
- `checkAndPromptForUpdate` (`src/utils/cli-updater.ts`) was not inspected; it might also write to stdout in `--json` mode on a TTY. Verify before declaring stdout fully clean. Likewise `--json` with a TTY triggers what's-new notice eligibility (TTY-gated, `--json` not in `OUTPUT_CONTRACT_ARGS`).
- Banner count mismatch: ticket says 9 migrations, current tree registers 10 (010 added after 0.16.3). Tests must not hardcode the count.
- Windows: ticket repro is on Windows 11 / Node 24; CI also runs `windows-latest`. Path and chalk/ANSI behavior should be considered in the regression test.
- Project policy: tests and git operations only on explicit user request (AGENTS.md); a fix still ships with docs updates.

---

## 7. Summary for Complexity Assessment

The defect is narrow and fully localized. The banner is emitted by raw `console.log` calls in `src/migrations/runner.ts` (L35-100), and it is triggered unconditionally from the `bin/codemie.js` startup wrapper, before commander dispatch. The `silent` flag is currently keyed only on hook/sound processes. The `proxy analytics status` command code itself is correct and does not need to change. A minimal fix touches 1-2 source files (`bin/codemie.js`, optionally `src/migrations/runner.ts` or a small shared helper), plus 1-2 test files and 1-2 doc files (`docs/COMMANDS.md` migration paragraph, test for `hook-stdout`). Layers touched: bin wrapper, migrations, and utils/logger at most. No DB, API, or external-service layers are involved, and the CLI command layer is likely untouched.

Technical novelty is low: there is a direct precedent in the same file (PR #721's `isHookProcess` silent-migration path and `logger.setConsoleStream(null)`), plus `OUTPUT_CONTRACT_ARGS` in `whatsnew.ts` and the MCP proxy wrapper that skips migrations. The main design decisions are (1) how to detect machine-output invocations from `process.argv` before commander runs (boolean `--json` vs `--json <path>`, non-TTY, other output-contract flags) and (2) whether to silence versus redirect to stderr. These are small but have a cross-command blast radius: all `--json` commands, `--version`, `--task`, and `--print-config` share the same startup path and the same bug.

Test posture is mixed. The migration runner and individual migrations are well unit-tested (except 008), and a spawn-based harness exists (`tests/helpers/isolated-cli.ts`, `tests/integration/hook-stdout.test.ts`) that is a direct template for a regression test. However, the banner path (`silent:false`), the `bin/codemie.js` silent decision, and the clean-home `--json` case have no direct coverage. The existing test for the bug is worked around by priming the home, and two control tests encode the current (buggy for `--json`) behavior. Risk is low-to-medium overall: small code surface, but integration tests require a rebuilt `dist/`, `bin/codemie.js` is outside the type checker and linter, and behavior changes must be reflected in the existing control tests and docs.
