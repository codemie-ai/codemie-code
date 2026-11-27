# Technical Research

**Task**: cli commander completion bash zsh fish (EPMCDME-17673)
**Generated**: 2026-11-24
**Research path**: filesystem

---

## 1. Original Context

Design plan for shell completions in the CodeMie CLI (EPMCDME-17673): `codemie completion <bash|zsh|fish>` printing static scripts generated from the commander tree (decision already made), based on the throwaway prototype in `~/codemie-dev/completion-proto/`. Plan only, no implementation. The task lists 10 known prototype limitations and 8 areas the plan must decide (command, generator architecture, startup side effects, docs, tests/CI, edge cases, compatibility, PowerShell/dynamic/`--opt=value` not blocked). Acceptance criteria: working Bash/Zsh/Fish; Tab offers commands, subcommands, options for the current position; suggestions reflect the real CLI only; per-shell enable/verify docs; automated or repeatable tests in all three shells. Out of scope: PowerShell, plain sh, dynamic values (profile names). (Full text in the caller's prompt.)

---

## 2. Codebase Findings

### Existing Implementations

**Program construction (limitation 1 is already solved).**
- `src/cli/program.ts` exports `createProgram(): Command`. Its doc comment says it has "no argv parsing and no side effects beyond reading package.json". It builds the root (`name('codemie')`, `.version()`, `--task <task>`, help text), adds all 29 `create*Command()` factories (`program.ts` lines near the end) and calls `applyRelatedHelp(program)`.
- `src/cli/index.ts` (52 lines) calls `createProgram()`, then branches on argv: `--task` -> `AgentCLI.run` (bypasses commander); `argv.length === 2` -> `FirstTimeExperience` welcome/quick start; else `program.parse(process.argv)`.
- `program.ts` imports `../providers/index.js` and `../frameworks/plugins/index.js` for registration side effects (plugin self-registration), so importing it loads the plugin graph. The hand-written factory list in the prototype `tree.mjs` duplicates `program.ts`; it can be dropped.
- `src/cli/__tests__/program.test.ts` already imports `createProgram` in vitest and asserts it builds without parsing.
- Other tree walkers already exist: `src/cli/related-commands.ts` (walks `cmd.commands`, reads `_hidden` at ~line 123), `src/utils/tips-validator.ts` (walks `cmd.commands`, `cmd.options`, matches aliases at line 51, `offeredFlags` at ~199). `src/cli/commands/tips.ts` obtains the root via `rootOf(command)` (parent chain), the pattern a `completion` command can use.

**Command registration style.** Each command is a file `src/cli/commands/<name>.ts` exporting `createXCommand(): Command` (`new Command('x').description(...).option(...).action(...)`), registered in `program.ts` with `program.addCommand(...)`. Simple examples: `tips.ts`, `version.ts`, `whatsnew.ts`. Tests sit in `src/cli/commands/__tests__/` (e.g. `whatsnew.test.ts`) or next to the command (`commands/proxy/__tests__/index.test.ts`). No existing `completion` code anywhere in `src` or `package.json` (grep "completion" found nothing relevant).

**Startup path of `bin/codemie.js`** (read in full, 113 lines) before `dist/cli/index.js` is imported:
- Installs EPIPE tolerance on stdout/stderr.
- `getInvocationContext({argv})` (`src/utils/invocation-context.ts`): `hook` = argv[2] is `hook`/`sound`; `scheduled` = `analytics sync run --scheduled`; `json` = `--json`/`--json=` in argv (`src/utils/machine-output.ts`). `hook` nulls the logger console stream.
- `MigrationRunner.runPending({silent: hook||scheduled||json})`. Non-silent runs `console.log` progress to **stdout** (`src/migrations/runner.ts:35,47,59,69,81`). A migration failure prints `console.error` (stderr).
- `checkAndPromptForUpdate()` runs unless `NODE_ENV=test`/`VITEST=true`, hook, scheduled or json. It prints the update banner via `console.log` (**stdout**, `src/utils/cli-updater.ts:257-264`) and may auto-update (lines 286-351).
- `shouldRunUpgradeNotice(argv, isTTY)` (`src/utils/whatsnew.ts:298`): skipped if stdout is not a TTY, if argv contains `--version|-V|--task|--help` (`OUTPUT_CONTRACT_ARGS`, line 237), or if the first non-dash arg is `hook`. So `codemie completion zsh` on a TTY would show the notice; redirected or `$(...)` it would not.
- `FirstTimeExperience.isFirstTime()` is reached only when `argv.length === 2` (bare `codemie`), not for `codemie completion bash`.
- Net: for `completion`, migrations (stdout when pending) and the update prompt (stdout, non-test) are real stdout hazards; the existing mechanism for silencing start-up is `getInvocationContext` (hook / scheduled / json flags) in `bin/codemie.js`. `hook-stdout.test.ts` and `analytics-sync-scheduled-startup.test.ts` (tests/integration) exercise that mechanism.

**Hidden / aliased / valued items in the real tree.**
- Hidden commands: `src/cli/deprecation.ts` `deprecatedCommand`/`removedCommand` set `cmd._hidden = true` directly (private field; comment notes the public API is `addCommand(cmd, {hidden:true})`). `proxy/index.ts:484` uses `proxy.addCommand(inspect, { hidden: true })`.
- Hidden options: `new Option(...).hideHelp()` (`deprecation.ts:77,105`; `analytics/index.ts:219` `--scheduled`). Installed commander 11.1.0 (`~/.nvm/.../@codemieai/code/node_modules/commander`): `Option.hidden` is a public field (`lib/option.js:32,156`), `Command._hidden` is private (`lib/command.js:68,165,283`), `Option.argChoices` set by `.choices()` (`option.js:180`).
- Aliases: no `.alias(` / `.aliases(` call found in `src` outside the tips-validator reader; the alias path is untested against real data.
- `.choices`/`argParser`: `deprecation.ts`, `update.ts`, `setup.ts`, `hook.ts`, `proxy/index.ts` and others use them (grep hits; individual usage not inspected).
- `enablePositionalOptions()` is used in `commands/analytics/index.ts:82,133` (parent/subcommand option scoping).
- Hook command `hook.ts` and `deprecation.ts` `removedCommand` use `allowUnknownOption()`.

**Prototype (`~/codemie-dev/completion-proto/`, read: tree.mjs, gen-bash/fish/zsh.mjs, test-bash.sh, test-zsh.zsh).** Walks the tree to nodes `{path, subs, opts}`, skipping `_hidden` commands and `hidden` options (matches the real API above); includes aliases as separate suggestions; adds implicit `help` and `-h/--help`; root gets `-V, --version` and `--task <task>`. Scripts skip words starting with `-` and descend only on known edges (so `--task foo profile` descends into `profile`, because `foo` is treated as a non-edge word that `break`s, see Task Statements). Bash uses `mapfile` (Bash 4+ builtin, contradicting the "Bash 3.2 compatible" claim: `mapfile`/`readarray` do not exist in 3.2), Bash `case` tables and `compgen -W`; descriptions are not shown in Bash. Zsh uses `_describe`, escaping `:` in names only; descriptions are placed unescaped except for `'`. Fish `-F` forces file completion for valued options. `test-bash.sh` compares exact sets against `codemie ... --help` output (needs a built `codemie` on PATH); `test-zsh.zsh` drives `zsh -f -i` through `zpty` with fixed `sleep 1.5` drains and asserts presence only. No fish test exists.

**Bin entry points.** `bin/` has `codemie.js` plus per-agent shortcuts (`codemie-claude.js`, `codemie-codex.js`, ..., `codemie-mcp-proxy.js`). These are separate executables outside the commander tree built by `createProgram`.

### Decisions Already in the Code
- Program construction is centralized in `createProgram()` with an explicit "no side effects" contract; entry-point logic stays in `index.ts`.
- Hidden items are marked via `_hidden` / `Option.hidden`; `related-commands.ts` states "Hidden (deprecated/removed) nodes ... must never be referenced", a precedent for filtering hidden nodes from generated output.
- Start-up silencing is decided in `bin/codemie.js` from argv alone (`getInvocationContext`), before commander parses; any `completion` silencing has to follow this argv-only pattern.
- Conventions (AGENTS.md "Common Pitfalls"): ESM with `.js` import extensions, `@/` alias, `logger.debug` not `console.log` for debug, specific error classes, no `any`, explicit return types on exports, `exec()` from `src/utils/exec.ts`.
- Policy: tests only on explicit request (AGENTS.md); git operations only on request.

### Task Statements Checked Against the Code
- "dist/cli/index.js creates the program inline, parses on import, and does not export it": **contradicted** for the current branch. `index.ts` calls `createProgram()` from `program.ts`; it still parses on import and exports nothing, but the tree is importable via `createProgram`. The published 0.16.2 package the prototype used may predate `program.ts` (unverified; the prototype's hand list suggests so). `git log` for `program.ts` shows commit 6bd03efb.
- "Bash 3.2 compatible": **contradicted** by the prototype generator output (`mapfile -t`, `for ((...))` is fine, `mapfile` is not in 3.2). Not verified by running 3.2 (only 5.2.21 installed).
- "Global options inherited by subcommands?" (limitation 9): commander does not inherit parent options into the subcommand's `options`; the root's only own options are `--task` and `-V/--version` (program.ts). Whether root options are accepted after a subcommand depends on `enablePositionalOptions` (set in `analytics` only). Not run-tested (node_modules absent in this checkout).
- "`codemie --task foo profile ...`" (limitation 2): in `index.ts`, any argv containing `--task` followed by another arg skips commander entirely and runs the built-in agent, so `--task` is not a normal subcommand path; the generated walker treats `foo` as a non-edge word and stops.
- "tips/first-run text": first-run is only for bare `codemie` (index.ts:32); `completion` is not affected. Tips are session start/end tips from `src/utils/tips.ts`; the `tips` command validates tip examples against the tree (`tips-validator.ts`), so adding a command is only affected if a tip references it (not checked).
- "Hidden commands: commander 11 `_hidden`/`hidden`": holds, see above (`Command._hidden` private, `Option.hidden` public).
- "Zsh pty tests timing-dependent": holds (fixed `sleep 1.5` in `test-zsh.zsh`).
- "CI shells available": unverified; the Ubuntu job in `.github/workflows/ci.yml` runs `npx vitest run --project unit` and `--project cli` on `ubuntu-latest` with Node 20; no step installs zsh/fish (ubuntu-latest images are assumed, not verified, to ship bash and may ship zsh/fish; confirm in CI).
- Tests-on-request: the task explicitly asks for a plan only, so no tests were written.

### Consumers of Changed Contracts
- Extracting nothing further from `index.ts` is needed; if `index.ts` is edited, its consumers are `bin/codemie.js` (dynamic `import('../dist/cli/index.js')`), `src/cli/__tests__/program.test.ts` and `tests/integration/cli-commands/help.test.ts` (uses the CLI via `tests/helpers/cli-runner.ts`, `node ./bin/codemie.js ...`).
- Adding a command to `program.ts` changes the tree seen by `related-commands.ts` (`applyRelatedHelp`), `tips-validator.ts`, `tips-coverage.test.ts` and `help.test.ts`; none were checked for exact-list assertions.
- Anything that reads `cmd.commands` and `_hidden` (related-commands, prototype) would see the same hidden semantics.

### Architecture and Layers Affected
CLI layer (`src/cli/`: `program.ts`, new command file, optionally a generator module), `bin/codemie.js` startup (argv-based quiet mode), docs. `.ai-run/guides/architecture/architecture.md` was not read in this pass beyond AGENTS.md summary ("CLI -> Registry -> Plugin"; plugin 5-layer). Guides listed in the task were not individually read (assumption: they match AGENTS.md pitfalls).

### Integration Points
`commander` ^11.1.0 (package.json:133); `createProgram` -> `providers/index.js` and `frameworks/plugins/index.js` side-effect imports; `bin/codemie.js` startup hooks; `tests/helpers/cli-runner.ts` for subprocess CLI tests.

### Patterns and Conventions
`createXCommand()` factory + `program.addCommand`; per-feature `__tests__` dirs; vitest `describe/it/expect` with dynamic `await import(...)` (see program.test.ts); argv-only start-up gating via `getInvocationContext`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists (architecture, development, integration, security, standards, testing incl. strategy/environments/risk-model, usage/project-config, quality-gates.md, project.md). Only AGENTS.md summaries were applied here; the guides were not opened in detail. User-facing docs: `docs/COMMANDS.md` ("Core Commands" code block at the top, "Global Options" ~line 420), `README.md` ("Installation" > "Verify Installation" ~line 199; "Commands" ~line 571), `docs/` also holds `AGENTS.md`, `HOOKS_TESTING.md`. Plans go under `docs/superpowers/` (specs, plans, tasks).

### Architectural Decisions
Static generation (task). `docs/ARCHITECTURE-OTLP-PLUGIN.md` is the model for contract docs (not read in detail).

### Derived Conventions
Docs list commands as `codemie <cmd>   # description` blocks in both README and COMMANDS.md.

---

## 4. Testing Landscape

### Existing Coverage
`src/cli/__tests__/program.test.ts` (tree builds), `related-commands.test.ts`, `deprecation.test.ts`; `src/cli/commands/__tests__/*` (command-level); `tests/integration/cli-commands/{help,version,list,doctor,profile,...}.test.ts` (subprocess, `CLIRunner`); `tests/integration/hook-stdout.test.ts` (stdout purity); `tests/helpers/pty-session.ts` and `interactive-helpers.ts` (existing pty helpers).

### Testing Framework and Patterns
Vitest ^4.1.5 with projects: `unit` (`src/**/*.test.ts`, setup `tests/setup/clean-env.ts`, env `NODE_ENV=test`, `CODEMIE_HOME` temp dir, 30 s timeouts), `cli`, `agent` (config `vitest.config.ts`). `npm run ci` = license-check, lint, build, `--project unit`, `--project cli`. CI (`.github/workflows/ci.yml`): build job once (Node 20), `test-ubuntu` and `test-windows` reuse the `dist` artifact; Windows job also exists, so shell-dependent tests must skip when the shell is absent or on win32.

### Coverage Gaps
No completion code, so no tests. No fish test anywhere. No test asserts alias, `choices`, or hidden-option filtering on the real tree. Zsh coverage in the prototype is presence-only.

---

## 5. Configuration and Environment

### Environment Variables
`CODEMIE_AUTO_UPDATE` (update check switch, `cli-updater.ts`), `CODEMIE_TIPS` (tips and what's-new switch), `CODEMIE_HOME` (state dir; tests redirect it), `CODEMIE_DEBUG`. None are completion-specific.

### Configuration Files
`package.json` (`bin`, scripts: `build`, `test`, `ci`, `lint`), `vitest.config.ts`, `tsconfig.json`, `.github/workflows/ci.yml`. A `files`/publish list was not checked (relevant only if generated scripts are shipped as static files rather than produced at runtime).

### Feature Flags and Deployment Concerns
None exist. Install paths for scripts (`~/.bashrc`, `~/.zshrc`, `~/.config/fish/completions/`) are user-environment facts, not repository facts.

---

## 6. Risk Indicators

- Speculative: `eval "$(codemie completion ...)"` in shell rc files runs `bin/codemie.js` on every shell start, including Node start, pending migrations (stdout) and the update check (stdout, may auto-update) described in Section 2. Silencing must key off argv in `bin/codemie.js` (existing `getInvocationContext` pattern).
- Speculative: importing `createProgram` loads the whole provider/framework plugin graph (`program.ts` side-effect imports), so command start-up time and any import-time logging are inherited by `completion`.
- Prototype generators use `mapfile` (not Bash 3.2) and unescaped description text in zsh/fish; special-character handling (`$`, backtick, `%`, `:`, non-ASCII) is unproven against real descriptions.
- `Command._hidden` is a private commander field, used by the repo already (`related-commands.ts`, `deprecation.ts`); `Option.hidden` is public. A commander upgrade could break the private read.
- Alias handling and `.choices()` values are untested on real data (no `.alias(` found in `src`).
- Test portability: zsh/fish availability on `ubuntu-latest` and on `windows-latest` unverified; pty timing in `test-zsh.zsh` is `sleep`-based.
- `--task` bypasses commander in `index.ts`; the tree has `--task` only as an option on the root, so completion of `codemie --task <word> <cmd>` follows the naive walk.
- Tips/related-commands/help tests may assert full command lists (not checked) and would be touched by registering a new command.
- Per-agent binaries (`codemie-claude`, etc.) are outside `createProgram`; their completion is not addressed by a root-tree generator.
- Guides in `.ai-run/guides/` were not read in detail; conventions rely on AGENTS.md.
- node_modules is absent in this checkout (`commander` could not be required locally); commander facts come from the installed published package (11.1.0).

---

## 7. Summary for Complexity Assessment

The work sits in the CLI layer: one new command file under `src/cli/commands/`, a registration line in `src/cli/program.ts`, a generator (tree walk plus three emitters) that can be a few small modules, a possible argv-based quiet-start tweak in `bin/codemie.js`, and docs in `README.md` and `docs/COMMANDS.md`. The biggest problem named in the task (program construction not exported) is already solved on this branch by `createProgram()` in `src/cli/program.ts`, and a tested, side-effect-free tree is importable, so no `index.ts` restructuring is required. Hidden command/option detection has working in-repo precedent.

Technical novelty is moderate: three shell dialects with escaping rules, a walker that must handle aliases, `choices`, hidden items and root-only options, and a start-up path (`bin/codemie.js`) that prints migration and update-check output to stdout and so can corrupt `eval "$(codemie completion ...)"`. Test posture: vitest unit and subprocess CLI tests are well established; there is no fish or zsh harness, the prototype's zsh pty test is timing-based and presence-only, and CI shell availability is unverified. Key risks are the stdout hygiene, shell escaping, Bash version compatibility (prototype uses `mapfile`), and cross-platform test gating (the Windows CI job).

---

## 8. External References

The task named `~/codemie-dev/completion-proto/` as the prototype: resolved and read (tree.mjs, gen-bash.mjs, gen-fish.mjs, gen-zsh.mjs, test-bash.sh, test-zsh.zsh; the generated codemie.bash/.fish/.zsh were not re-read, they are outputs of the generators). Facts used are in Section 2 ("Prototype"). The published package `~/.nvm/versions/node/v26.13.0/lib/node_modules/@codemieai/code` resolved; only its bundled `commander` 11.1.0 (`lib/command.js`, `lib/option.js`) was read, for the `_hidden`/`hidden`/`argChoices` facts. The Jira ticket EPMCDME-17673 was not fetched; its text comes from the task. Guides under `.ai-run/guides/` were listed but not individually read.
