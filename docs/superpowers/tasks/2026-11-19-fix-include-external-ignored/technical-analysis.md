# Technical Research

**Task**: commander positional-options analytics sync include-external
**Generated**: 2026-11-19
**Research path**: filesystem

> **Post-rebase note.** Sections 1-8 record the findings as true at HEAD 37a2fe47. Upstream PR #837 has since changed several of the surfaces they describe; see "9. Post-rebase update" at the end for what is current. Statements about the uncommitted WIP and the `proxy connect` aliases are historical.

---

## 1. Original Context

Fix: codemie analytics sync install --include-external <policy> is silently ignored.
Running the real CLI with --include-external always installs the sync job with includeExternal: never, no error. Root cause: `codemie analytics` defines a boolean --include-external (src/cli/commands/analytics/index.ts:43); `analytics sync install` (line 141) and `sync bootstrap` (line 118) define --include-external <policy>. analytics and sync call .enablePositionalOptions() (index.ts:39, :82), which only works when parsing starts at analytics. The root program in src/cli/index.ts does not enable positional options (commander 11.1.0), so analytics consumes --include-external as its own boolean and leaves `always` as a stray positional; install gets no includeExternal and validateIncludeExternal(undefined) returns default 'never' (src/cli/commands/analytics/sync/config-store.ts:233). Existing test src/cli/commands/analytics/__tests__/analytics-sync-cli.test.ts parses from createAnalyticsCommand() directly so it passes.
Requested fix: (1) call .enablePositionalOptions() on root program in src/cli/index.ts. Before relying on it, check every root-level option (e.g. --task): after the change root options are only recognized before the subcommand name. Confirm no documented or internal invocation passes a root option after a subcommand (check bin/, docs, and the scheduled-job command built by src/cli/commands/analytics/sync/scheduler/). (2) Add .allowExcessArguments(false) to sync subcommands (bootstrap, install, status, run, uninstall) so stray args fail loudly; check that `run --scheduled` and the scheduler-built command still parse. (3) Tests (explicitly requested): parse through the root program, not createAnalyticsCommand(); assert `analytics sync install ... --include-external always` and `analytics sync bootstrap ... --include-external always` pass "always" to the runner, and `codemie analytics --include-external` (boolean) still works. Root program is built at module level in src/cli/index.ts so a small createProgram() factory probably needs extracting. (4) Check codemie proxy (src/cli/commands/proxy/index.ts:122 and :334): same .enablePositionalOptions() pattern, may have the same latent problem with connect subcommands reusing parent option names (not yet investigated). Do not rename --include-external. Also confirm repro B (option validation order in config-store.ts: webhook/git, format, at, includeExternal, lookbackDays — `--include-external bogus --lookback-days 99` currently reports lookback-days error, expected include-external error after the fix).
Constraints: AGENTS.md; no git operations; tests only because user explicitly requested here.

---

## 2. Codebase Findings

### Existing Implementations

Purpose: parse `--include-external <policy>` for sync commands.
- HEAD `src/cli/index.ts`: root `new Command()` built at module level, only `.option('--task <task>')` and `.version`; NO `.enablePositionalOptions()`. All ~29 `program.addCommand(createXCommand())` calls inline. `--task` is also pre-scanned from `process.argv` (`process.argv.indexOf('--task')`) before `parse`, and handed to `AgentCLI.run` (a separate Command), so root commander never parses `--task` in practice.
- HEAD `src/cli/commands/analytics/index.ts`: `createAnalyticsCommand()` calls `.enablePositionalOptions()` (l.~39), declares boolean `--include-external` (l.43). `createSyncCommand()` (`.enablePositionalOptions()`, l.~82) adds `bootstrap`, `install`, `status`, `run`, `uninstall`. `bootstrap` and `install` declare `--include-external <policy>`; `run` has hidden `--scheduled`. None call `allowExcessArguments`. Actions dynamic-import runners (`sync/bootstrap/run-bootstrap.js`, `sync/install.js`, `sync/status.js`, `sync/run-sync.js`, `sync/uninstall.js`).
- `src/cli/commands/analytics/sync/config-store.ts`: `validateInstallOptions` (l.284-297) runs webhook, git, `validateFormat`, `validateAt`, `validateIncludeExternal` (l.233; undefined -> `DEFAULT_INCLUDE_EXTERNAL`, bad value -> `SyncConfigError`), then `validateLookbackDays` (l.247). So repro B: include-external error would be reported first once the value actually arrives; today it is undefined (swallowed), so the lookback error shows. Order already matches the expected result; no change needed in config-store.

Purpose: scheduled job command.
- `src/cli/commands/analytics/sync/scheduler/generators.ts:36`: args are `['analytics','sync','run','--scheduled']`; no root option involved. `src/utils/scheduled-run.ts:12,20` (`isScheduledSyncRun`, tokens `analytics sync run`) and `bin/codemie.js` read `process.argv` directly, independent of commander.

Other touched code: `src/cli/commands/proxy/index.ts` (see Decisions). Existing test `src/cli/commands/analytics/__tests__/analytics-sync-cli.test.ts` parses `createAnalyticsCommand()` directly.

### Decisions Already in the Code
- `.enablePositionalOptions()` on `analytics`, `sync`, `proxy`, `connect` so descendants can reuse option names (comments at those sites). Root is the only ancestor without it. Commander 11.1.0 (`node_modules/commander/package.json`; `package.json:133` `^11.1.0`): positional behaviour applies only if every ancestor enables it.
- `proxy connect` aliases (`desktop`, `vscode`) reuse `--profile/--verbose/--force/--insiders`; HEAD `resolveAliasOptions` (proxy/index.ts ~l.110) merges `command.parent.opts()` with leaf opts (leaf wins), documented as a workaround for flags landing on the `connect` level.
- `--task` is handled by raw `process.argv` scan, not by commander.

### Task Statements Checked Against the Code
- "root does not enable positional options; analytics swallows the flag": holds. Reproduced with commander 11.1.0 in a scratch script (/tmp, outside repo) mirroring the tree: without root positional, `analytics sync install --include-external always` -> `too many arguments for 'install'` once allowExcessArguments(false) is set (stray `always`), and without it, install gets no includeExternal. With root positional: `install {"includeExternal":"always"}`.
- "after change root options only recognized before subcommand": holds. `analytics --task x sync run` -> `unknown option '--task'` with root positional (without it, root consumed it). No documented/internal invocation does this: docs (`docs/COMMANDS.md:8,409`, `docs/AUTHENTICATION.md:189-228`) use `codemie --task "..."` (before any subcommand, and intercepted by argv scan) or `codemie-claude --task` (separate AgentCLI program). `src/providers/integration/setup-ui.ts:282-284` same. Scheduler command has no root option. Only root options are `--task`, `--version`, `--help`.
- "run --scheduled and scheduler command still parse": holds (scratch: `run {"scheduled":true}` under both configs; `run --scheduled x` errors with allowExcessArguments(false)).
- "proxy may have the same latent problem": partially. Under commander 11.1.0 scratch test: WITHOUT root positional, `proxy connect desktop --profile p` binds `--profile` to `connect` (parent) leaving leaf empty (this is what the HEAD merge workaround handles); WITH root positional it binds to the leaf (`desktop {"profile":"p"}`), and `proxy connect --profile p desktop` still binds to `connect`. `resolveAliasOptions` merge handles both, so behaviour is correct either way; only its comment becomes stale. Other proxy subcommands (`start`, `disconnect`, `inspect`) use no ancestor-shared names found in grep of option lists (disconnect/connect are siblings).
- Repro B: holds as described (see config-store order above).

### Consumers of Changed Contracts
- Root program export/shape: only `src/cli/index.ts` builds it (HEAD). Grep for `createProgram`/`cli/index` imports in src: none at HEAD.
- `process.argv` consumers independent of commander: `bin/codemie.js`, `isScheduledSyncRun`, `--task` scan. Not affected by positional option change.
- `allowExcessArguments(false)` on sync subcommands: consumers are the OS job (`run --scheduled`, no extra args) and documented user commands; `bootstrap` prints an install command (webhook/git/format options only, no positionals) per its description.

### Architecture and Layers Affected
CLI layer only (`src/cli/index.ts`, `src/cli/commands/analytics/index.ts`, optionally comments in `src/cli/commands/proxy/index.ts`); sync runners untouched.

### Integration Points
Commander 11.1.0; scheduler (launchd/systemd/schtasks) generators for the argv; `bin/codemie.js` argv sniffing.

### Patterns and Conventions
`createXCommand()` factories per command; dynamic-imported runners; ESM with `.js` imports, `@/` alias (AGENTS.md).

#### Uncommitted WIP at HEAD 37a2fe47 (historical; superseded, see section 9)
- `src/cli/program.ts` (120 lines): `createProgram()` extracted from index.ts (name/description/version read, `.option('--task')`, help text, all addCommand calls, returns program). Verified it ends with `return program;`; I did not confirm in detail that `.enablePositionalOptions()` is present on the root (grep for it across src returned nothing outside analytics/proxy in the filtered output, so confirm by reading program.ts).
- `src/cli/index.ts`: now `const program = createProgram();`; the argv `--task` scan and first-time-experience logic stay.
- `analytics/index.ts`: adds `.allowExcessArguments(false)` to all five sync subcommands and expands the doc comment.
- `proxy/index.ts`: comment-only rewrite of `resolveAliasOptions` doc.
- `src/cli/__tests__/program.test.ts`: mocks the runners and parses via `createProgram()`; cases: install/bootstrap `--include-external always`, boolean `analytics --include-external`, stray args rejected, `run --scheduled`, proxy connect alias flags (before and after alias name), `--version`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` referenced by AGENTS.md (architecture, testing-patterns, development-practices) not read in this pass; conventions derived from code. `docs/COMMANDS.md` documents `--task` as pre-subcommand only.

### Architectural Decisions
Inline comments at the `.enablePositionalOptions()` sites (analytics, sync, proxy, connect) record the option-name-reuse rationale.

### Derived Conventions
Vitest, dynamic-import mocking via `vi.mock` of runner modules.

---

## 4. Testing Landscape

### Existing Coverage
`src/cli/commands/analytics/__tests__/analytics-sync-cli.test.ts` parses from `createAnalyticsCommand()` (bypasses root, hence false pass). WIP adds `src/cli/__tests__/program.test.ts`.

### Testing Framework and Patterns
Vitest; `vi.mock` of runner module paths; commander `exitOverride` throwing used in WIP test.

### Coverage Gaps
No HEAD test parses through the root program; no test for stray-argument rejection; proxy alias flag binding via root untested at HEAD.

---

## 5. Configuration and Environment

### Environment Variables
None relevant.

### Configuration Files
None relevant.

### Feature Flags and Deployment Concerns
Existing installed scheduled jobs call `analytics sync run --scheduled`; unaffected. Users who already installed with `--include-external` silently got `never`.

---

## 6. Risk Indicators

- Speculative: any user script placing a root option after a subcommand would begin to fail (only `--task`, handled by argv scan, so effectively none found).
- Speculative: `allowExcessArguments(false)` makes previously tolerated stray words on sync subcommands errors (intended).
- (Historical) Root positional flips alias flag binding in `proxy connect desktop|vscode`; correct only because `resolveAliasOptions` merged parent opts. Moot after #837: the aliases are removed stubs and `resolveAliasOptions` is gone.
- `--task` argv scan runs before commander, so `codemie analytics ... --task x` would hit the AgentCLI path regardless of positional setting (pre-existing quirk; `taskIndex` scan ignores position).
- (Historical) WIP root `.enablePositionalOptions()` presence was not confirmed here; the final code has it (section 9).

---

## 7. Summary for Complexity Assessment

Small CLI-layer fix: root program lacks `.enablePositionalOptions()` (commander 11.1.0), so `analytics` swallows `--include-external`. At HEAD 37a2fe47 the surface was `src/cli/index.ts` (plus an extracted factory), five `.allowExcessArguments(false)` calls in `src/cli/commands/analytics/index.ts`, and a new test through the root; proxy needed no behavioural change, only a stale comment. After the rebase the final surface is smaller (section 9).

Verified with an isolated commander 11.1.0 reproduction that positional-at-root fixes the binding, `run --scheduled` still parses, stray args fail, `--task` after a subcommand is rejected but no documented/internal invocation does that, and proxy aliases work in both flag positions. Repro B ordering already matches the expected outcome with no config-store change.

Test posture: existing test bypasses the root; a WIP test covers the gap. Low novelty, low risk.

---

## 8. External References

None named by the task.

---

## 9. Post-rebase update

The branch was rebased onto origin/main 8b8c5e92. Upstream PR #837 (6bd03efb, "redesign proxy and analytics CLI commands") changed the surface:

- It already added `src/cli/program.ts` with `createProgram()` (`src/cli/index.ts` calls it and keeps the `--task` argv pre-scan) and `src/cli/__tests__/program.test.ts` with 3 structural tests. So no factory extraction is needed here.
- `codemie analytics --include-external` is no longer a boolean: it is `--include-external [policy]`. The bare form is a deprecation mapping to `always`, and a guard rejects `--include-external otel|sync`.
- `proxy connect desktop|vscode` became removed stubs that fail naming the replacement (`--claude-desktop` / `--vscode`). `resolveAliasOptions` no longer exists, so the "Decisions Already in the Code" note on it and the proxy findings above no longer apply; proxy needs no change.

The bug still reproduced on 8b8c5e92: building origin/main and running repro B reported the `--lookback-days` error instead of the include-external one, and `analytics sync status extra` was silently accepted.

Final change (branch fix/include-external-ignored, code commit d685952a; 3 files, +201/-6):

1. `src/cli/program.ts`: `createProgram()` starts with `new Command().enablePositionalOptions()` plus a comment. This is the root fix.
2. `src/cli/commands/analytics/index.ts`: `.allowExcessArguments(false)` on `bootstrap`, `install`, `status`, `run`, `uninstall`, and an updated doc comment.
3. `src/cli/__tests__/program.test.ts`: upstream's 3 structural tests kept, plus 11 regression tests through `createProgram()` (install and bootstrap `--include-external always`; `analytics --include-external always` still consumed by analytics; repro B through the real `runInstall`/`validateInstallOptions`; 5 stray-argument cases; `sync run --scheduled`; `--version`). 14 tests total.

Not changed: `src/cli/index.ts`, `src/cli/commands/proxy/index.ts`, config-store, the sync runners. The earlier comment-only proxy change and the proxy alias tests were dropped.

Still true after the rebase: no root option is passed after a subcommand anywhere (`bin/`, docs, scheduler argv `analytics sync run --scheduled`; `--task` is read from raw `process.argv` before commander), and the config-store validation order already reports include-external before lookback-days once the value arrives.

Verification: removing the root `.enablePositionalOptions()` makes exactly 3 tests fail (install, bootstrap, validation order); the `allowExcessArguments` mutation fails the 5 stray-argument tests (checked on the pre-rebase tree). Gates on the rebased code (`CI=1`, `CODEMIE_*` unset, 127.0.0.2 alias present): license-check, lint, typecheck, build and commitlint pass; unit 639/639 files (12033 passed, 2 skipped); cli project 47 files passed + 1 skipped (389 passed, 10 skipped); itLocal real-transcript tests skip under `CI=1`; gitleaks ran at commit time with no leaks.

Affected machines: installs made before the fix with `--include-external always|windows` stored `never`. Re-run `codemie analytics sync install` and check `codemie analytics sync status`.
