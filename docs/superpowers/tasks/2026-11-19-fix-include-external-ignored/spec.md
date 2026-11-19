# Spec: fix `--include-external <policy>` silently ignored on `analytics sync install|bootstrap`

> **Post-rebase update.** This spec was first written against HEAD 37a2fe47. The branch was then rebased onto origin/main 8b8c5e92, which includes upstream PR #837 ("redesign proxy and analytics CLI commands", 6bd03efb). #837 already added `src/cli/program.ts` with `createProgram()` (index.ts calls it and keeps the `--task` argv pre-scan) and `src/cli/__tests__/program.test.ts` with 3 structural tests. It also changed `codemie analytics --include-external` from a boolean to `--include-external [policy]` (bare form is a deprecation mapping to `always`; a guard rejects `--include-external otel|sync`), and turned `proxy connect desktop|vscode` into removed stubs that fail naming the replacement (`--claude-desktop` / `--vscode`); `resolveAliasOptions` no longer exists. The bug still reproduced on 8b8c5e92 (repro B reported the `--lookback-days` error instead of the include-external one; `analytics sync status extra` was silently accepted). The criteria below are the final, shipped ones. AC3 was reworded and AC6 was withdrawn for that reason. The architecture-review and code-review verdicts in this directory were produced against the pre-rebase commit f9eb6021 and are historical.
>
> Final change (3 files, +201/-6, code commit d685952a): `src/cli/program.ts` (`createProgram()` starts with `new Command().enablePositionalOptions()`), `src/cli/commands/analytics/index.ts` (`.allowExcessArguments(false)` on the five sync subcommands), `src/cli/__tests__/program.test.ts` (3 upstream structural tests kept, 11 regression tests added, 14 total).

## Problem

`codemie analytics sync install|bootstrap --include-external always` installs with `includeExternal: never` and no error. The root commander program (built by `createProgram()` in `src/cli/program.ts`, previously inline in `src/cli/index.ts`) does not call `.enablePositionalOptions()`, so `analytics` consumes `--include-external` as its own option (originally a boolean; after #837 `[policy]`) and leaves `always` as a stray positional for the sync subcommand. The sync subcommand then receives no value, and `validateIncludeExternal(undefined)` returns the default `never` (`sync/config-store.ts:233`). Commander 11.1.0 applies positional behaviour only when every ancestor enables it; the root is the only one that does not. The existing test parses from `createAnalyticsCommand()` directly, so it never sees the bug. Installs made before the fix with `--include-external always|windows` stored `never`: affected machines should re-run `codemie analytics sync install` and check `codemie analytics sync status`.

## Goals

1. The root program enables positional options, so `--include-external <policy>` reaches `install` and `bootstrap`.
2. Stray positional arguments on the sync subcommands fail loudly instead of being swallowed.
3. A regression test parses through the real root program.

## Design

- In `createProgram()` (`src/cli/program.ts`, added upstream by #837), build the root as `new Command().enablePositionalOptions()` with an explanatory comment. This is the root fix. No factory extraction is part of this change, and `src/cli/index.ts` is untouched (it calls `createProgram()` and keeps the `--task` argv pre-scan).
- Add `.allowExcessArguments(false)` to the five sync subcommands (`bootstrap`, `install`, `status`, `run`, `uninstall`) in `src/cli/commands/analytics/index.ts`.
- `proxy`: no change. After #837, `proxy connect desktop|vscode` are removed stubs that fail naming `--claude-desktop` / `--vscode`, and `resolveAliasOptions` is gone, so the earlier alias concern no longer exists.
- Tests in `src/cli/__tests__/program.test.ts` parse through `createProgram()` (see AC8).
- Config validation order (`config-store.ts:284-297`) already reports an include-external error before a lookback-days error once the value arrives. No change.

## Compatibility checks (done in research)

- Root options are `--task`, `--version` and `--help` only. (Re-verified after the rebase.) `--task` is read from raw `process.argv` before commander parses. Documented uses (`docs/COMMANDS.md`, `docs/AUTHENTICATION.md`, `src/providers/integration/setup-ui.ts`) put `--task` before any subcommand or use the separate per-agent CLI. No known invocation places a root option after a subcommand.
- The scheduled job runs `analytics sync run --scheduled` (`sync/scheduler/generators.ts:36`). It has no root option and no extra argument, so `allowExcessArguments(false)` does not affect it. `isScheduledSyncRun` and `bin/codemie.js` read `process.argv` directly.

## Acceptance criteria

- AC1: `analytics sync install --include-external always` through the root program calls the install runner with `includeExternal: "always"`.
- AC2: `analytics sync bootstrap --include-external always` through the root program calls the bootstrap runner with `includeExternal: "always"`.
- AC3: `codemie analytics --include-external always` (no sync) is still consumed by analytics itself: `loadAnalytics` receives the include-external flag as `true` and `runInstall` is not called. (Originally a boolean `--include-external`; #837 made it `[policy]`.)
- AC4: an extra positional argument on each of `bootstrap`, `install`, `status`, `run` and `uninstall` errors with a "too many arguments" failure.
- AC5: `analytics sync run --scheduled` still parses and reaches the run runner with `scheduled: true`.
- AC6: withdrawn. `proxy connect desktop|vscode` are now removed stubs (#837) and `resolveAliasOptions` no longer exists, so there is no alias flag-position behaviour to pin. Proxy needs no change.
- AC7: `codemie --version` still works.
- AC8: `src/cli/__tests__/program.test.ts` (14 tests: upstream's 3 structural tests plus 11 regression tests) parses via `createProgram()`. The regression tests cover install and bootstrap `--include-external always`, analytics' own `--include-external always`, repro B through the real `runInstall`/`validateInstallOptions` (exit code 1, include-external reported rather than lookback), five stray-argument cases (`commander.excessArguments`), `sync run --scheduled` reaching `runSync`, and `--version`. Gates on the rebased code (`CI=1`, `CODEMIE_*` unset, 127.0.0.2 alias present): license-check, lint, typecheck, build and commitlint pass; unit 639/639 files (12033 passed, 2 skipped); cli project 47 files passed + 1 skipped (389 passed, 10 skipped). The itLocal real-transcript tests skip under `CI=1`. gitleaks ran at commit time with no leaks. Mutation check: removing the root `.enablePositionalOptions()` makes exactly 3 tests fail (install, bootstrap, validation order); removing `allowExcessArguments` fails the 5 stray-argument tests (checked on the pre-rebase tree).

## Non-goals

- Do not rename `--include-external` or change its semantics or default.
- No change to `config-store.ts` validation order or to the sync runners.
- No change to how `--task` is handled (argv pre-scan stays).
- No change to scheduler argv generation, `bin/`, or `isScheduledSyncRun`.
- No change to `src/cli/commands/proxy/index.ts` or `src/cli/index.ts`, and no `createProgram()` extraction (upstream did it).
- No migration of already-installed jobs that silently got `never`. Users re-run install.
- No git operations.

## Decisions

- Reuse upstream's `createProgram()` (#837) rather than extracting one: it already solves how tests reach the root program without executing `index.ts`.
- Enable positional options on the root over renaming or re-scoping `--include-external`: it fixes the shared cause, and the task forbids renaming.
- Apply `.allowExcessArguments(false)` to all five sync subcommands over install and bootstrap only: stray arguments should fail the same way across the group. This was the task's request.
- Leave `proxy` untouched: the aliases it would have protected are removed stubs after #837.
- Keep `--task` on the argv pre-scan over moving it into commander: out of scope.
- Add tests despite the AGENTS.md default: the task explicitly requested them.

## Assumptions

- Before the fix, upstream's `createProgram()` did not enable positional options on the root (verified by building origin/main and running repro B).
- Behaviour was verified with commander 11.1.0 in an isolated script. Guides under `.ai-run/guides/` were not read during research.

## Risks

- A user script that passes a root option after a subcommand would now fail. None is known, because the only root option, `--task`, is read from argv.
- Sync subcommands now reject previously tolerated stray words. This is intended.
- Machines that installed before the fix with `--include-external always|windows` still hold a stored `never`; they must re-run `codemie analytics sync install`.
