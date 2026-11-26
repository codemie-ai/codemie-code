# Spec: warn when an agent is missing from PATH or shadowed by another install (EPMCDME-16969, #493)

Scope source: `story.md` (Draft; AC1-AC8 and NG1-NG6 carried from it, AC9-AC11 and NG7-NG9 added by this spec). Analysis: `technical-analysis.md`.

## Problem

`codemie install <agent>` reports success once npm exits cleanly and never checks which copy PATH resolves to (`src/utils/processes.ts:318`). The launched binary is the first `where.exe` match (`BaseAgentAdapter.ts:870`, `processes.ts:77`). `commandExists`/`getCommandPath` discard every match but the first (`processes.ts:28-85`). The story counts "about 16" callers of the shared lookup; the analysis lists about 25 call sites. The plan fixes the count with a grep.

The ticket's stated root cause (a stale shim shadowing the new one) does not match its symptom. A shadowing stale shim makes `commandExists` return true (`processes.ts:36`), so `list` would show the agent as installed and launch the old binary.

**Confirmed cause (issue #493, reporter's comment; the attached debug gist holds only session-sync noise and no install or PATH data):** CodeMie's npm prefix (`...\AppData\Local\CodeMie\npm-prefix`) was missing from the user PATH, so `where.exe` found zero matches for the freshly installed opencode. An old `codemie` shim in `AppData\Roaming\npm` was in use, and no stale opencode copy existed. The primary fix is therefore the "missing on PATH" hint (AC9). Shadowing detection (AC1-AC5) stays as the ticket's secondary case.

## Approach

Report only.

- **Lookup helper**: a new helper next to `commandExists`/`getCommandPath` in `processes.ts` returns the full ordered `where.exe` match list. The old functions keep their signatures. They may become thin wrappers over it when next touched.
- **Classifier**: a pure function over (ordered matches, managed location, whether a managed shim exists) returns `shadowed | clear | missing-on-path | missing | unknown`. It does no I/O; the adapter supplies the shim-exists fact. It uses the existing path comparer (the plan names it). No second comparer is written.
  - `shadowed`: a managed shim exists and the first match is elsewhere.
  - `clear`: the first match is the managed copy.
  - `missing-on-path`: the lookup completed with zero matches AND the managed shim exists.
  - `missing`: the lookup completed with zero matches and no managed shim exists (nothing anywhere).
  - `unknown`: the lookup failed or timed out, or the managed location is unresolved.
- **Managed location**: the bin dir of the CodeMie-or-global npm prefix (`npm-prefix.ts:44,94,168`). An unresolved prefix gives `unknown`. In non-portable mode it is the global npm dir, so a shadow there is still detected.
- **One entry point, one formatter**: a single adapter-level method returns the verdict for an agent. A single message formatter renders it. Install, repeat-install, list, doctor and launch all call these two and repeat no lookup, timeout or wording of their own.
- **Shared wording**: the formatter shares its "put X ahead of Y" wording with the stale-version warning in `src/utils/active-cli.ts`. The verdicts are not shared, because that check compares versions and this one compares locations.
- `isInstalled()` stays boolean.
- Covers only agents with a CodeMie-managed npm location. Windows only for acceptance.

## Acceptance criteria

- AC1: After `codemie install <agent>`, a `shadowed` verdict warns, naming both locations. It gives the command to put the new location ahead of the old one on the user PATH and says a new terminal is needed. It also names the other remedies (remove or rename the stale copy, or edit the machine-wide PATH as administrator), because a user-PATH change cannot help when the stale copy is in a machine-wide PATH folder. (story AC1)
- AC1a: Running `codemie install <agent>` again, when the agent is already installed and `shadowed`, shows the same warning instead of a bare "already installed". (story AC1a)
- AC2: `codemie list` marks a `shadowed` agent as shadowed, with the active location and the expected CodeMie location. It does not show it as plainly installed or plainly missing. (story AC2)
- AC3: `codemie doctor`'s agents check reports `shadowed` as a warning with a fix hint, and reports `missing-on-path` with the AC9 hint. Both come through the same adapter entry point and formatter, so no extra code path is needed. (story AC3)
- AC4: Launching a `shadowed` agent prints a warning naming the location that will run, before it starts. (story AC4)
- AC5: A `clear` verdict shows no shadowing message and output is unchanged. (story AC5)
- AC6: With no copy on PATH AND no managed shim (`missing`), `list` and launch report "not installed" exactly as today, with no hint. Zero matches WITH a managed shim is AC9. (story AC6, narrowed by AC9)
- AC7: Warnings change nothing: no PATH edits, no file or shim removal, no reinstall. (story AC7)
- AC8: An `unknown` verdict (lookup fails or times out, or the managed location or prefix is unresolved) leaves behavior as today with no message. (story AC8)
- AC9: A `missing-on-path` verdict (completed lookup, zero matches, managed shim exists on disk) shows a hint with the managed location and "put it on PATH / open a new terminal". It appears in three places.
  - After a successful install. The install still counts as successful.
  - On `codemie list`, next to the agent's row instead of a bare "not installed". The state and wording say "not found on PATH", not "installed".
  - On agent launch, replacing the bare "<agent> CLI is not installed - Install it with..." message.
  - It is warn only: no PATH change. An `unknown` verdict (timeout, failed lookup, unresolved prefix) keeps today's behavior with no hint.
- AC10: Path comparison does not give false shadow warnings for the same install written differently: case, trailing separators, `.cmd` vs extensionless shim in one folder, 8.3 short names, symlinks. This reuses the existing comparer. If it misses one of these, extend it in place. Unit tests cover the classifier with multi-line `where.exe` output and different directories.
- AC11: Bounded cost.
  - `list` computes all verdicts once, concurrently, under one shared deadline. It skips agents with no managed shim, which can only be `missing`. Agents with a managed shim that `commandExists` reports absent are still classified, since they are the `missing-on-path` case.
  - Launch reuses a single lookup (not a third beside its existing two) and treats an unresolved prefix as `unknown`, without spawning npm just for this check.
  - Exception for #493: when the derived prefix has no managed shim and the agent is nowhere on PATH, `list` and `doctor` (never launch) fall back to the npm-config prefix (`npm prefix -g`) to find a shim installed under another global prefix. That lookup is memoized per process, so npm is spawned at most once, bounded by the 5000 ms deadline. Any failure gives `missing`.
  - Running that npm lookup from a neutral working directory is tracked separately as EPMCDME-17866, because the same exposure exists in other shell-spawned commands.
  - The lookup child process is killed on timeout.
  - A timeout gives `unknown`, with no message.
  - The deadline follows the 5000 ms pattern in `active-cli.ts`.

## Non-goals

- NG1: Changing the user or machine PATH, or deleting stale shims, from the CLI or the Windows installer. The installer stays append-only. (story NG1)
- NG2: Changing how the Windows installer orders PATH entries. (story NG2) If reorder is revisited, the user's stated preference is to move only CodeMie's own entries and warn about the rest. This is a preference, not scope.
- NG3: The macOS and Linux installer scripts. (story NG3)
- NG4: Installing agents differently, for example forcing install into CodeMie's own location. (story NG4)
- NG5: Shadow detection for non-agent tools (`sqlite3`, `pipx`, sound players). (story NG5)
- NG6: A test harness for the Windows installer script. (story NG6)
- NG7: Agents with their own native installers (Claude, Kimi) and agents without a CodeMie-managed npm location.
- NG8: Changing `isInstalled()` semantics or `codemie uninstall`, or changing the `commandExists`/`getCommandPath` signatures.
- NG9: Shadow or missing-on-PATH warnings on Linux and macOS (no acceptance there).

## Decisions

- D1: Report shadowing only, over reordering PATH in the installer or doing both — user
- D2: "Shadowed" means a managed copy exists and the first PATH match differs, over warning on any non-first match (story D2)
- D3: Share the warning wording and one formatter with the `active-cli.ts` stale-version check, over sharing its verdict (versions vs locations differ) or building separate wording
- D4: A new pure location classifier over the full match list, over changing `commandExists`/`getCommandPath` return shapes
- D5: The managed location is the bin dir of the CodeMie-or-global npm prefix, with unresolved meaning `unknown`, over portable-prefix-only detection
- D6: One adapter entry point and one formatter for all surfaces, over per-surface lookup, timeout and message code
- D7: Reuse the existing path comparer, over a second one for AC10
- D8: Cover only agents with a managed npm location, over also Claude and Kimi native installers — user
- D9: Windows-only acceptance, over all platforms — user
- D10: The warn-only "missing on PATH" hint on install, list, launch and doctor, over install-time only. This reverses the earlier install-only choice, after the #493 evidence that the reporter's real case was a missing PATH entry — user
- D11: The reporter's cause is recorded as confirmed (prefix missing from user PATH, zero `where.exe` matches), over leaving the symptom mismatch open — user
- D12: Split the classifier's missing result into `missing-on-path` and `missing`, over one `missing` verdict, so a managed shim with no PATH match is distinguishable from nothing anywhere

## Open risks and plan notes

- Machine PATH precedes User PATH (Windows behavior, not asserted in the repo), so the AC1 message names remedies beyond the user PATH.
- The hint cannot fix the PATH, so a user who ignores it still sees a non-working agent. It points to the remedy only (NG1).
- Plan: the copy-paste PATH command in AC1 and AC9 must quote or reject paths containing quote, semicolon or percent.
- Plan: decide whether `update`, `uninstall`, agent-targets need the check and its deadline. This spec requires only install, repeat-install, list, doctor and launch.
- Plan: which agents beyond OpenCode, Codex, Copilot CLI and Gemini have a managed npm location is unconfirmed (pi, codex-acp, claude-acp and codemie-code override install).
- Plan: time `where.exe` (long PATH, antivirus) and a cold npm prefix lookup, 20 runs each on Windows. Confirm that the existing comparer handles case, trailing separators and 8.3 names.
- The ticket's `opencode.plugin.ts` line numbers are stale (`isInstalled()` is at 599-615). The claim that PR #588 deferred this case is not verified in the repo.
