# Plan: warn when another agent install shadows the CodeMie-managed one, or CodeMie's prefix is not on PATH (EPMCDME-16969)

Spec: `spec.md`. Analysis: `technical-analysis.md`. Commit per task using the repository's existing convention. Vitest, `.js` import suffixes, `@/` alias, `logger` not `console` for diagnostics, no `any`.

Amended scope (user decision after reading issue #493): the reporter's real cause was CodeMie's npm prefix missing from the user PATH (zero `where.exe` matches while the managed shim exists). The classifier is `shadowed | clear | missing-on-path | missing | unknown` (D12). The "not found on PATH" hint shows on install, list, launch and doctor. AC6 narrows to: no PATH copy and no managed shim behaves as today. NG10 is removed.

## Resolved plan notes

- **Existing comparer**: `isSamePath` (`src/utils/paths.ts:239`) is `path.relative(a,b)===''` per platform. It handles win32 case and trailing separators. It does NOT handle 8.3 short names or symlinks. T2 adds an async `isSamePathResolved` beside it in `paths.ts` (realpath.native both sides, raw-path fallback on error, then `isSamePath`). The classifier compares directories (`dirname` of each match), so `.cmd` vs extensionless in one folder is not an issue.
- **Caller count** (grep `commandExists\(|getCommandPath\(` in `src`, excluding tests): 26 occurrences in 18 files. The story's "about 16" is wrong. Signatures are untouched (NG8).
- **Sites that get the check**: install, repeat-install, list, doctor, launch only. `update`, `uninstall` and `agent-targets` (`agent-targets.ts:117`) do NOT: they need only the boolean and would gain a deadline for no AC. `isInstalled()` stays boolean.
- **Managed agents**: eligible when `metadata.npmPackage` is set and the agent installs through `npm install -g`. Claude and Kimi (native installers, NG7) opt out. T4 reads `install()` of pi, codex-acp, claude-acp, codemie-code and openwiki and opts out those that do not go through the npm prefix.
- **AC1 command quoting**: T3 builds a PowerShell user-PATH command only when the dir has none of `'`, `"`, `;`, `%` or control characters; otherwise it prints the plain instruction with no copy-paste command. The dir is single-quoted. The same rule serves the hint's "add to PATH" command.
- **Timing** (where.exe, cold prefix lookup): not a plan task. The 5000 ms deadline and one lookup per surface bound the cost.

## Tasks

### T1 — Ordered match-list lookup in processes.ts
Files: `src/utils/processes.ts` (next to `commandExists`/`getCommandPath`, :28-85), `src/utils/__tests__/processes.test.ts`.
Add `getCommandMatches(command, timeoutMs?): Promise<{ status: 'answered'; matches: string[] } | { status: 'unanswered' }>`. Same `where.exe $PATH:<cmd>` / `which` call and line splitting as `getCommandPath`. Non-zero exit gives `answered` with `[]`. A throw or timeout gives `unanswered` (child killed via `exec` `timeout`). Do not touch the two existing functions.
Test-first: yes — a failing test that mocked multi-line CRLF `where.exe` output returns all lines in order, exit code 1 returns `[]`, and a rejected/timed-out exec returns `unanswered`.

### T2 — Pure classifier (five verdicts) and 8.3/symlink-aware comparer
Files: new `src/utils/path-shadow.ts`, `src/utils/paths.ts` (add `isSamePathResolved`), tests in `src/utils/__tests__/path-shadow.test.ts` and `paths.test.ts`.
New symbols: `type ShadowVerdict = { status: 'shadowed'; active: string; managedDir: string } | { status: 'missing-on-path'; managedDir: string; shimPath: string } | { status: 'missing' } | { status: 'clear' } | { status: 'unknown' }`, and `classifyShadow(input: { matches: string[] | null; managedDir: string | null; managedShimPath: string | null; samePath: (a, b) => boolean }): ShadowVerdict` (no I/O; `managedShimPath` is non-null only when the adapter found the managed shim on disk). Rules: `matches===null` or `managedDir===null` gives `unknown`; zero matches gives `missing-on-path` when `managedShimPath` is set, else `missing`; first match dir equals managedDir gives `clear`; else `shadowed` only if `managedShimPath` is set or a later match is in managedDir, otherwise `clear`.
Test-first: yes — failing tests: different dirs in multi-line output give `shadowed`; case, trailing-separator and `.cmd` vs extensionless variants of the same dir give `clear`; zero matches with a managed shim give `missing-on-path`, without one give `missing`; `null` matches give `unknown`; `isSamePathResolved` treats a symlink/short-name alias of a real dir as same (temp-dir symlink, skipped where symlinks are not permitted).

### T3 — One formatter, shared wording with active-cli
Files: `src/utils/active-cli.ts:237-241` (extract the "Put X ahead of Y on your PATH" line into an exported helper used by `formatStaleWarning`), `src/utils/path-shadow.ts` (add `formatShadowWarning(verdict, platform)` for `shadowed` and `formatNotOnPathHint(verdict, platform)` for `missing-on-path`), tests in `path-shadow.test.ts` and `active-cli.test.ts`.
`formatShadowWarning` names the active and managed locations, the copy-paste PowerShell user-PATH command (quoting rule above), "then open a new terminal", and the other remedies (remove or rename the stale copy, edit the machine-wide PATH as administrator). `formatNotOnPathHint` says the agent is "not found on PATH", names the managed shim location, gives the add-to-PATH command and "open a new terminal". It also exposes a one-line short form (`not found on PATH — shim at <dir>`) for the list row. All return `string[]`/`string` and never run anything (AC7).
Test-first: yes — failing tests: shadow output contains both locations, the new-terminal line and the admin remedy; the hint contains "not found on PATH" and the shim location; a dir containing `;` or `%` yields no copy-paste command; `formatStaleWarning` output is byte-identical before and after the extraction.

### T4 — Adapter entry point
Files: `src/agents/core/BaseAgentAdapter.ts` (near `isInstalled`, :274), `src/agents/core/types.ts` (optional `checkPathShadow?` on `AgentAdapter`), per-plugin opt-outs (claude, kimi, plus those found in the `install()` read), new test file under `src/agents/core/__tests__/`.
Add `checkPathShadow(opts?: { resolvePrefix?: boolean }): Promise<ShadowVerdict>`. Returns `unknown` when not win32, no `cliCommand`/`npmPackage`, or the agent opts out. Managed dir = `getNpmBinDir(prefix)` with prefix from `getCodemieNpmPrefix()`; with `resolvePrefix` also `getCodemieOrGlobalNpmPrefix()` (global prefix memoized, `npm-prefix.ts:124`). Without `resolvePrefix` an unresolved prefix is `unknown` and no npm is spawned. One `getCommandMatches` call under the 5000 ms deadline (`active-cli.ts:26` pattern), memoized on the instance for launch reuse (T8). The managed-shim fact: `fs.access` on `<managedDir>\<cmd>.cmd` then `<cmd>`; the found path becomes `managedShimPath`, else `null`.
Test-first: yes — failing tests with mocked lookups: shadowed, clear, missing-on-path (zero matches, shim exists), missing (zero matches, no shim), timeout gives `unknown`, non-win32 gives `unknown`, opted-out agent gives `unknown`, no npm spawn without `resolvePrefix`.

### T5 — Install and repeat-install surfaces (AC1, AC1a, AC9)
Files: `src/cli/commands/install.ts` (already-installed branches :134 and :163; after success :217), install command test under `src/cli/commands/__tests__/`.
After `spinner.succeed`/`warn`, call `checkPathShadow({ resolvePrefix: true })`: `shadowed` prints the T3 warning; `missing-on-path` prints the T3 hint; the install stays successful. In both already-installed branches print the same for those two verdicts after the existing message. `clear`, `missing` and `unknown` print nothing extra.
Test-first: yes — failing test that install with `shadowed` prints the warning and with `missing-on-path` prints the hint, both exiting 0; repeat-install prints them after "already installed"; `clear`, `missing`, `unknown` print nothing extra.

### T6 — list (AC2, AC5, AC6, AC9, AC11)
Files: `src/cli/commands/list.ts:25-37`, its test.
Before the loop compute verdicts once, concurrently (`Promise.all`) under one shared deadline (5000 ms; on expiry unfinished verdicts are `unknown`) for every agent that is not already known installed. `isInstalled()` still decides installed status; verdicts are needed for installed agents (shadowed) and for not-installed ones (missing-on-path), so run them for all agents with a `cliCommand`/`npmPackage` eligibility, skipping ineligible ones. In the loop: `shadowed` renders `Status: shadowed` with active and expected locations; `missing-on-path` renders `Status: not found on PATH` with the short hint instead of bare "not installed". `missing`, `clear`, `unknown` render exactly as today.
Test-first: yes — failing test that a shadowed agent shows both locations, a `missing-on-path` agent shows "not found on PATH" and not bare "not installed", a `missing` agent still shows plain "not installed" with no hint, and verdict lookups are all started before the first row prints.

### T7 — doctor agents check (AC3)
Files: `src/cli/commands/doctor/checks/AgentsCheck.ts` (`buildDetail` :37, and the `installedAgents` loop in `run`/`runWithItemDisplay`), `doctor-checks.test.ts`.
`shadowed` on an installed agent returns `{ status: 'warn', message, hint }` from the T3 text (hint = the put-ahead line); if a version warning also applies, append it to the message. For an agent that `isInstalled()` reports false, `getInstalledAgents()` never lists it, so doctor additionally reports `missing-on-path` agents as a `warn` with the add-to-PATH hint: collect eligible not-installed agents via `AgentRegistry` and run `checkPathShadow()` for them under one shared deadline. `clear`, `missing`, `unknown` add nothing.
Test-first: yes — failing test that a shadowed agent yields a `warn` detail with a hint, a `missing-on-path` agent yields a `warn` with the add-to-PATH hint, and `clear`/`missing`/`unknown` leave results unchanged.

### T8 — launch (AC4, AC6, AC9, AC11)
Files: `src/agents/core/AgentCLI.ts` (`handleRun` :185-189), `src/agents/core/BaseAgentAdapter.ts:870`, tests.
In `handleRun` call `checkPathShadow()` (no `resolvePrefix`) once. When `isInstalled()` is true and the verdict is `shadowed`, print the T3 warning to stderr naming the location that will run, before the agent starts. When `isInstalled()` is false and the verdict is `missing-on-path`, print the T3 hint in place of the bare "not installed — Install it with..." block (stderr, same exit code). `missing`/`unknown`/`clear` keep today's output. `BaseAgentAdapter` launch uses the first memoized match from T4 instead of a fresh `getCommandPath` when present, so launch does `isInstalled` plus one lookup, not three.
Test-first: yes — failing test that launch with `shadowed` warns on stderr before spawn, `missing-on-path` prints the hint instead of the bare install block, `missing` prints today's block, `clear` prints nothing, and `where.exe` runs once for verdict and path resolution together.

## Negative-constraint pass

- NG1/AC7 (no PATH edits, no shim removal): T3 only builds text; no task writes PATH or deletes files. NG2/NG3: no installer or POSIX script task.
- NG4: no task changes how agents are installed. NG5: only agents with `npmPackage` (T4).
- NG7: T4 opt-outs for Claude and Kimi. NG8: T1 adds a function; `commandExists`/`getCommandPath`/`isInstalled` untouched. NG9: T4 returns `unknown` off win32.
- AC6 (narrowed): `missing` (no PATH copy, no managed shim) prints nothing new in T5, T6, T7, T8. AC8: `unknown` prints nothing everywhere. NG10 is gone, so T6/T7/T8 may show the hint.
- D7 (no second comparer): T2 extends `paths.ts` beside `isSamePath` and wraps it.
