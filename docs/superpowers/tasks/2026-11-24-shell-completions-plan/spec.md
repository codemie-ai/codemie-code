# Shell completions for the CodeMie CLI (EPMCDME-17673)

Design only. Implementation is a later stage. Facts below come from `technical-analysis.md`; anything marked (assumption) is unverified.

## Goal

`codemie completion <bash|zsh|fish>` prints a static completion script to stdout, generated from the live commander tree. Tab offers commands, subcommands and options for the current position, and nothing the CLI does not have.

## Design

### Command
- New `src/cli/commands/completion.ts` exporting `createCompletionCommand()`, registered in `src/cli/program.ts` like the other 29 commands. It takes one required argument constrained with `.choices(['bash','zsh','fish'])`.
- It finds the root through the parent chain, the way `src/cli/commands/tips.ts` does (`rootOf`), so it never builds a second program.
- Output is the script only, written to stdout. No banner, no tips, no first-run text. Errors go to stderr.
- A missing or unsupported shell is a commander error: message on stderr listing the allowed values, exit code 1. Nothing goes to stdout.
- `--help` describes the three shells and shows one install line per shell.

### Generator modules (`src/cli/completion/`)
- `tree.ts`: walks a `Command` into a plain model `{name, aliases, description, options[], subs[]}`. Option entries carry long and short flags, description, `takesValue` (required or optional), and `choices` from `Option.argChoices`. Hidden commands are skipped through the `_hidden` field, the same private read `related-commands.ts` already makes, kept in one helper. Hidden options are skipped through the public `Option.hidden`. It adds the implicit `help` subcommand and `-h/--help` on every node, and `-V/--version` where the root defines it.
- `bash.ts`, `zsh.ts`, `fish.ts`: pure functions `(model) => string`, one per shell. A shared `escape.ts` holds the per-shell description escaping.
- `index.ts`: `generate(shell, root)`, a registry keyed by shell name. PowerShell later means one new emitter and one registry entry.
- `index.ts` and `program.ts` stay as they are apart from the one `addCommand` line. `createProgram()` already has no side effects.

### Walk semantics
- At each position the generator offers the node's subcommands, aliases and options.
- Words starting with `-` are skipped. A known option that takes a required value also consumes the next word. Descent happens only along known command or alias edges.
- Aliases are suggested and descend to the same node as the canonical name. In Zsh and Fish an alias shows the same description as its command.
- Root options are offered at every node: the CLI accepts `--task`, `-V` and `--version` after a subcommand (for example `codemie list --version` works), so Tab after a subcommand offers them.
- `--task` makes `src/cli/index.ts` skip commander altogether, so completion after `--task <value>` offers nothing. This is accepted.
- `.choices()` values are offered after the option in Zsh and Fish (assumption: cheap to do from the model). In Bash they are offered only if the Bash emitter can do so without per-option tables growing complex, otherwise the option name alone is offered. Valued options with no choices fall back to file completion.
- Bash must run on 3.2: no `mapfile`, no associative arrays, no dependency on bash-completion. Use `case` tables, `compgen -W` and `while read` or `COMPREPLY=( $(...) )`.
- Zsh script uses `#compdef codemie` and `_describe`. It ends with a guard so both `source` (after `compinit`) and fpath autoloading work. Without compinit, the docs say to add `autoload -Uz compinit && compinit`.
- Fish script uses `complete -c codemie` with a helper function for position matching. It works on 3.x.

### Startup side effects
`bin/codemie.js` runs migrations (stdout when pending) and the update check (stdout) before commander parses, which would corrupt `source <(codemie completion bash)`.
- Extend `getInvocationContext` (`src/utils/invocation-context.ts`) with a `completion` flag: argv[2] is `completion`. It joins `hook`, `scheduled` and `json` in the existing silent set for `MigrationRunner.runPending` and skips `checkAndPromptForUpdate`.
- `shouldRunUpgradeNotice` (`src/utils/whatsnew.ts`) also treats `completion` as an output-contract command, alongside `hook`.
- Guarantee, enforced by a test: `codemie completion <shell>` with pending migrations and update checks enabled writes only the script to stdout.

### Docs
- New `docs/SHELL-COMPLETIONS.md`, with a short pointer in `README.md` (Installation) and a line in `docs/COMMANDS.md`.
- Per shell, an enable step and a verify step:
  - Bash: `source <(codemie completion bash)`, or a cached file under `~/.local/share/bash-completion/completions/codemie`.
  - Zsh: a cached file `_codemie` in a directory on `fpath`, then `compinit`.
  - Fish: `codemie completion fish > ~/.config/fish/completions/codemie.fish`.
- Cached output goes stale after upgrades, so the docs say to regenerate after `npm i -g`. Putting the `source <(...)` line in an rc file starts Node on every shell start (about the cost of one CLI start), so caching is recommended.
- WSL notes: use the Linux `codemie`, not a `/mnt/c` copy.

### Tests (only when implementation is requested, per AGENTS.md)
- Unit (vitest, `src/cli/completion/__tests__/`): tree model on a synthetic commander tree (hidden, alias, choices, optional and required values, no-subcommand command, deep nesting). One snapshot per emitter. Escaping tests with descriptions containing `'`, `"`, `$`, backtick, `%`, `:`, `[`, `]`, backslash, and non-ASCII.
- Command: missing and unsupported shell give exit 1, stderr message, empty stdout. Stdout purity with a pending migration and update check enabled (subprocess through `tests/helpers/cli-runner.ts`, modeled on `tests/integration/hook-stdout.test.ts`).
- Sync guard: a test builds `createProgram()`, computes the expected sets from the same commander tree independently of the generator's tree model, and asserts that every non-hidden command and option appears in each script and no hidden one does.
- Behavioral, real shells, in `tests/integration/completion/`, each gated by availability of the shell binary and skipped on win32:
  - Bash: a harness sets `COMP_WORDS`, `COMP_CWORD` and calls the completion function, comparing exact sets against the model at several positions.
  - Fish: `fish -c 'source <script>; complete -C "codemie <words> "'`, exact sets.
  - Zsh: a pty harness with prompt-marker waiting (read until a unique sentinel appears, with a timeout), not fixed sleeps. Presence checks plus a negative check for hidden and unrelated names. Exact sets if the harness proves stable.
- CI: add an `apt-get install -y zsh fish` step to the Ubuntu job. Locally, the tests skip with a visible reason when a shell is missing. The Windows job skips them. Whether `ubuntu-latest` already has zsh and fish is unverified.

### Edge cases covered
Hidden commands and options, aliases, deep nesting, commands with no subcommands (options only), required and optional value options, `.choices()`, `--version`, `--help`, the root `--task` option, and special-character descriptions. Per-agent binaries (`codemie-claude` etc.) are not completed.

### Risks
- `_hidden` is a private commander field, so a commander upgrade can break it. The single helper plus the sync guard test detect that.
- Importing `createProgram` loads the plugin graph, so `completion` start-up is as slow as any command.
- Zsh pty tests can still flake. Mitigated by sentinel waiting and by the generator-level unit tests carrying most of the weight.
- Bash 3.2 is not installed locally. Compatibility is checked by a lint-style grep test for forbidden builtins (`mapfile`, `readarray`, `declare -A`) in the Bash output, and by CI on macOS if later added.
- Tips, related-commands and help tests may assert full command lists (unchecked). Registering the command can touch them.

## Task breakdown (ordered, each independently verifiable)
1. `tree.ts` model plus unit test. `npx vitest run --project unit src/cli/completion`.
2. `escape.ts` plus escaping tests.
3. Bash emitter plus snapshot, plus the Bash COMP harness test.
4. Fish emitter plus snapshot, plus the `complete -C` test.
5. Zsh emitter plus snapshot, plus the pty harness test.
6. `completion` command, registration in `program.ts`, unsupported and missing-shell tests. `npm run build && node bin/codemie.js completion bash`.
7. Startup silencing (`invocation-context`, `whatsnew`, `bin/codemie.js`) plus the stdout purity test.
8. Sync-guard test against `createProgram()`.
9. Docs (`docs/SHELL-COMPLETIONS.md`, README, COMMANDS.md) and the CI shell-install step.
10. Final run: `npm run ci`.

## Decisions
- Subcommand-style `codemie completion <shell>` over a `--completion <shell>` flag: it matches the `createXCommand()` registration style and shows up in `--help`.
- A commander error with exit code 1 for a missing or unsupported shell over a custom usage message with exit 2: it reuses the repo's existing behavior.
- Walking the live tree through `createProgram()` over the prototype's hand-written factory list: the list would drift from `program.ts`.
- A separate `src/cli/completion/` module with one emitter per shell over a single file: a future PowerShell emitter is one file and one registry entry.
- Skipping hidden commands via `_hidden` in a single helper over adding a new public marker: it follows `related-commands.ts` and needs no commander changes.
- Silencing startup through `getInvocationContext` and `shouldRunUpgradeNotice` over a `completion`-specific bypass in `bin/codemie.js`: it reuses the mechanism `hook` already uses.
- Offering root options at every node over root only: the CLI accepts them after a subcommand (`codemie list --version`).
- Static scripts with no bash-completion dependency over using `_init_completion`: it works on Bash 3.2 and without the package.
- Recommending cached files over `source <(...)` in rc files: it avoids a Node start on every shell start.
- Test stack: vitest unit and snapshot tests plus real-shell integration tests that skip when a shell is absent, over CI-only shell tests: the same checks run locally and in CI.
- A sentinel-wait Zsh pty harness over fixed sleeps: it is not timing-dependent.

## Non-goals
- PowerShell and plain `sh` completions.
- Dynamic value completion (profile names, models) and a `__complete` subcommand.
- `--opt=value` completion.
- Completion for the per-agent binaries (`codemie-claude` etc.).
- Auto-installing completions into the user's rc files.
- Changes to `src/cli/index.ts` argv routing.
