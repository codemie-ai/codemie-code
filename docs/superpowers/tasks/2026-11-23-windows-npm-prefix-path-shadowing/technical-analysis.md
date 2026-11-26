# Technical Research

**Task**: windows installer PATH npm-prefix shadowing commandExists
**Generated**: 2026-11-23
**Research path**: filesystem

---

## 1. Original Context

Jira EPMCDME-16969, Bug:

Windows installer appends CodeMie's npm-prefix to the end of user PATH, so a stale global npm shim keeps shadowing newly installed agents

## Summary
On Windows, `codemie install opencode` reports success, but `codemie-opencode` and `codemie list` immediately report OpenCode as not installed. Root cause found by a reporter: CodeMie's active npm prefix was missing from the front of the user PATH, so an older npm shim elsewhere on PATH kept winning name resolution.
## Root Cause (confirmed on main @ HEAD)
`Add-UserPath` (`install/windows/install.ps1` lines 100-122) only appends a path to the end of the user PATH if absent — it never checks for, removes, or reorders a conflicting, already-present stale npm global dir (e.g. `%APPDATA%\npm`) ahead of it. `commandExists`/`getCommandPath` (`src/utils/processes.ts` lines 28-72), used by every agent plugin's `isInstalled()` (e.g. `opencode.plugin.ts` ~lines 527-543), resolve purely via `where.exe` first-match — no precedence/shadow check. The one related fix (PR #588 / EPMCDME-15307) explicitly deferred this exact PATH-precedence case to a future ticket that was never filed.
## Steps to Reproduce
1. On Windows, have a stale npm global shim earlier in PATH than CodeMie's npm-prefix dir.
2. Run `codemie uninstall opencode` then `codemie install opencode` — reports success.
3. Run `codemie-opencode` or `codemie list` — reports OpenCode as not installed.
## Suggested Fix
Have the Windows installer detect and reorder/fix a shadowing stale npm shim ahead of CodeMie's prefix in user PATH, or have `commandExists`/`isInstalled()` detect and report PATH-precedence shadowing explicitly (similar to the existing `isShadowedCodemieShim` check for the `codemie` binary itself).
## Reference
GitHub issue: https://github.com/codemie-ai/codemie-code/issues/493

---

## 2. Codebase Findings

### Existing Implementations

**Purpose A: put CodeMie's bin/prefix dirs on user PATH (Windows)**
- `install/windows/install.ps1:100-122` `Add-UserPath` — reads the User PATH, splits on `;`, returns "already present" if the entry exists (case-insensitive), else appends `"$current;$PathToAdd"` via `SetEnvironmentVariable('Path', ..., 'User')`. It never compares the entry's position with other entries.
- Callers `install.ps1:360-364`, portable mode only: `Add-UserPath $BinDir` (`<InstallRoot>\bin`, the codemie shims) then `Add-UserPath $PrefixDir` (`<InstallRoot>\npm-prefix`, with the comment "Agents that CodeMie installs land in the prefix itself"). `$BinDir`/`$PrefixDir` are defined at `:265-266`.
- `install.ps1:124-148` `Remove-UserPath` — the symmetric removal. It is used at `:367` when a legacy override is migrated.
- In npm-global mode (`$ResolvedMode` is not portable) no PATH edit happens. The global npm dir (`%APPDATA%\npm`) is assumed to be on PATH already.
- `install/windows/clidiag.ps1` — a diagnostic script with many PATH mentions (51 hits). I did not read it.
- Only one Windows installer script exists: `install/windows/install.ps1` (with the `install.cmd` wrapper). No installer tests were found. Under `src`, `tests`, `scripts` and `.github`, `install.ps1` is referenced only by `scripts/prepare-install-artifacts.mjs`, which packages it.

**Purpose B: decide whether an agent is installed**
- `src/utils/processes.ts:28-40` `commandExists` — runs `C:\Windows\System32\where.exe $PATH:<cmd>` on win32 and `which` elsewhere. It returns `code === 0`. It has no location information.
- `src/utils/processes.ts:53-85` `getCommandPath(command, timeoutMs?, {throwIfUnanswered?})` — the same `where.exe` call. It returns the first line of stdout and drops the other matches. `where.exe` lists every PATH match in PATH order, so the full shadow list is already present in stdout and is discarded.
- `$PATH:` prefix (EPMCDME-15907) keeps where.exe from searching the cwd. Tests cover it at `src/utils/__tests__/processes.test.ts:524-531,581-588`.
- Consumers of `commandExists`:
  - `BaseAgentAdapter.isInstalled` (`src/agents/core/BaseAgentAdapter.ts:274-286`) is the default for agents.
  - Overrides: `opencode.plugin.ts:599-615` (the ticket's "~527-543" is stale; the code is at 599-615), `codex.plugin.ts:455`, `copilot-cli.plugin.ts:440`, `kimi.plugin.ts:149`.
  - Others: `opencode.sqlite-reader.ts:45` (sqlite3), `cli/commands/sound.ts:61`, `frameworks/plugins/codebase-memory.plugin.ts:143`, `graphify.plugin.ts:46,48,66`, `anthropic-subscription.auth.ts:12`, `moonshot-subscription.setup-steps.ts:30`.
- Consumers of `getCommandPath`:
  - `BaseAgentAdapter.ts:870` resolves the launch path. The launched binary is therefore the first PATH match, which is the stale shim.
  - Others: `kimi.plugin.ts:253`, `cli/commands/mcp/index.ts:8,27`, `proxy/analytics-clients.ts:170,184`, `proxy/claude-client-config-state.ts:76`, `utils/active-cli.ts:69`, `utils/installation-detector.ts:28`, `utils/hook-command.ts:86`.

**Purpose C: detect a shadowing shim (existing precedent)**
- `src/utils/hook-command.ts:38-49` `isShadowedCodemieShim(path)` — matches only the path segment `/@codemieai/codemie-opencode/` on the raw path or its realpath. It is specific to the `codemie` bin collision with the bundled agent package. It is used in `hook-command.ts:91,111,173`. It does not detect PATH-order shadowing in general.

**Purpose D: choose which npm prefix installs/uninstalls/lists use**
- `src/utils/npm-prefix.ts:178-190` `getNpmPrefixArgs()` returns `['--prefix', <codemie prefix>]` only when the running CodeMie copy's prefix differs from `npm prefix -g`, and `[]` otherwise. `getCodemieNpmPrefix` is at `:44`, `getNpmBinDir` at `:94`, `getCodemieOrGlobalNpmPrefix` at `:168`.
- It is applied at `processes.ts:318` (install -g), `:368` (uninstall -g) and `:414` (list -g). So when CodeMie runs from `<root>\npm-prefix`, agents are installed into that prefix, and the shim lands in `<prefix>` (win32 `.cmd`). If `%APPDATA%\npm` precedes `<prefix>` on PATH and holds an older shim of the same name, `where.exe` returns the stale one first.
- `cli-updater.ts:310` also uses it.

**Purpose E: diagnostics**
- `src/cli/commands/doctor/checks/NpmPrefixOverrideCheck.ts` and `AgentsCheck.ts` (under `src/cli/commands/doctor/checks/`) exist. Neither was inspected for PATH-order logic. `doctor-checks.test.ts` is the test file.

**Other touched code**: none beyond the above.

### Decisions Already in the Code
- Installer modes: `auto` resolves to `npm-global` when the npm prefix is writable, else `portable` (`install.ps1` `Resolve-InstallMode`, `:325-331`). PATH edits happen only in portable mode (`:360-364`). EPMCDME-15307 design: "does not rewrite the user's npm prefix", so the global prefix is never changed. The PATH entry is the only mechanism that makes the portable prefix visible (`docs/superpowers/tasks/2026-09-28-epmcdme-15307/design-decisions.md`).
- Append-only PATH policy: `Add-UserPath` is idempotent and never reorders. An existing entry short-circuits to "already present", even when it is positioned behind a stale dir. No reason is recorded.
- Recorded known limitation: `code-review-deferred.md` (15307) says the user PATH rewrite may flatten `%VAR%` entries. `Add-UserPath` and `Remove-UserPath` share the read/write pattern through `[Environment]::GetEnvironmentVariable/SetEnvironmentVariable('Path','User')`. This is "pre-existing" and was deferred. The same 15307 review (`code-review-final.json`) records that `$LEGACY_PREFIX/bin` stays on PATH after migration on POSIX.
- Process-wide PATH vs user PATH: the installer edits only the User scope. Machine PATH comes before User PATH in a process's effective PATH, so a Machine-scope entry can shadow regardless of reordering inside User PATH. This is a fact about how Windows composes PATH, not something read from this repo.
- Read direction: `where.exe` output is stored as full ordered match list but consumed as `paths[0]` (`processes.ts:77`) or as a boolean (`:36`).

### Task Statements Checked Against the Code
- "`Add-UserPath` (lines 100-122) only appends ... never checks for/removes/reorders": holds (`install.ps1:100-122`).
- "`commandExists`/`getCommandPath` (lines 28-72) ... `where.exe` first-match, no precedence/shadow check": holds. The actual extent is 28-85.
- "`opencode.plugin.ts` ~lines 527-543": contradicted on line numbers. The `isInstalled()` is at 599-615. The behavior described holds.
- "used by every agent plugin's `isInstalled()`": mostly holds. `BaseAgentAdapter.isInstalled` uses `commandExists`, and four plugins override with their own `commandExists` calls. Plugins with no `cliCommand` return true, so they are never checked.
- "PR #588 / EPMCDME-15307 explicitly deferred this PATH-precedence case": unverified in this repo. The deferred file lists only `%VAR%` flattening, agent installs in locked-down prefixes, and the POSIX legacy PATH. None of them is the stale-shim case. The PR/issue text is not in reach (GitHub issue #493 not fetched).
- "`codemie install opencode` reports success but `isInstalled` is false": consistent with the code. The install path does not verify resolution after `npm install -g` (`processes.ts:318`), and `isInstalled` then sees the stale shim (or none, if the old shim was removed and the prefix dir is not on PATH). Which of the two the reporter hit is not distinguishable from the code. Note that `commandExists` returns true if any shim resolves, so "not installed" implies no match at all, not a stale match. A shadowing stale shim would normally make `commandExists` return true and `codemie-opencode` launch the old binary. This is a tension in the ticket's root-cause narrative that the reproduction should confirm.
- Suggested fix, either option: both keep `commandExists`/`getCommandPath` first-match semantics in place for their ~20 consumers listed under Purpose B (nothing changes for them unless the signature does).

### Consumers of Changed Contracts
- If `commandExists`/`getCommandPath` change semantics or return shape: every consumer under Purpose B (about 25 call sites in `src/`) plus the tests in `src/utils/__tests__/processes.test.ts` (mocks `exec` and asserts the exact where.exe args at `:531,:588`).
- If `Add-UserPath` changes (reorder/remove): the two callers at `install.ps1:362,364`, and `Remove-UserPath` symmetry at `:367`. The README (`README.md:79,130`) and `install/README.md` describe installer PATH behavior. No installer tests were found.
- Searched: `Add-UserPath|Remove-UserPath` in `C:\Epam\codemie-code` (excluding node_modules); `commandExists\(|getCommandPath\(` in `src`.

### Architecture and Layers Affected
- Installer script layer (PowerShell, `install/windows/install.ps1`).
- Utils layer (`src/utils/processes.ts`, `hook-command.ts`, `npm-prefix.ts`).
- Agent plugin/adapter layer (`BaseAgentAdapter`, per-agent `isInstalled`).
- CLI/doctor layer (`src/cli/commands/doctor/checks/`), which is a possible reporting site.

### Integration Points
- `where.exe` / `which` via `src/utils/exec.ts`; the npm CLI; the Windows registry User PATH via .NET `Environment` API; the `codemie install/uninstall/list` commands via `processes.ts`.

### Patterns and Conventions
- ES modules with `.js` import suffixes and the `@/` alias. `exec()` from `src/utils/exec.ts` rather than `child_process` directly. `logger.debug` rather than console. Tests are Vitest with the exec mocked (`AGENTS.md`).
- Installer functions use `Write-Status`, `$DryRun` guards, and `Invoke-Checked`.
- Platform branching is by `os.platform() === 'win32'` inside the function.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/` was not opened beyond the AGENTS.md map. Relevant guide paths per the classifier: `architecture/architecture.md`, `development/development-practices.md`, `usage/project-config.md`.
- `docs/superpowers/tasks/2026-09-28-epmcdme-15307/` (design-decisions.md, code-review-deferred.md) is the prior task and holds the installer design.

### Architectural Decisions
- 15307: do not touch the user npm prefix; scope the portable prefix to CodeMie via `--prefix`; PATH holds `CodeMie\bin` and `CodeMie\npm-prefix`.

### Derived Conventions
- Detection helpers live beside their consumers (`isShadowedCodemieShim` in `hook-command.ts`), and tests sit in `__tests__` next to the source.

---

## 4. Testing Landscape

### Existing Coverage
- `src/utils/__tests__/processes.test.ts` covers `getCommandPath` and `commandExists` (multiple where.exe paths, CRLF, timeouts, `$PATH:`).
- `src/utils/__tests__/npm-prefix.test.ts` (per 15307 records) covers `getNpmPrefixArgs` and prefix derivation.
- `src/cli/commands/doctor/checks/__tests__/doctor-checks.test.ts` covers doctor checks.
- A test for `isShadowedCodemieShim` was not located, and I did not search for one.

### Testing Framework and Patterns
- Vitest; `exec` is spied/mocked; platform is stubbed via `os.platform`.

### Coverage Gaps
- `install/windows/install.ps1` has no tests found (no Pester or other harness found).
- No test covers PATH ordering or multi-match `where.exe` output being used for shadow detection.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_OPENCODE_BIN` (respected by `metadata.cliCommand`, per the comment at `opencode.plugin.ts:600`). `NPM_CONFIG_PREFIX` and the user `.npmrc` prefix are handled in the 15307 logic (`npm-prefix.ts`).

### Configuration Files
- User `.npmrc` prefix (`getUserNpmrcPrefix`, `npm-prefix.ts:152`); Windows User PATH registry value; `install/manifest.json` (not read).

### Feature Flags and Deployment Concerns
- Installer params `-Mode` (auto/npm-global/portable) and `-DryRun`. Installer artifacts are built by `scripts/prepare-install-artifacts.mjs`.

---

## 6. Risk Indicators

- Existing mechanism kept in place: the first-match `where.exe` resolution (`processes.ts:77`) serves ~25 callers; see Consumers of Changed Contracts.
- Ticket root-cause tension: a stale shim shadowing normally makes `commandExists` true, not false (see Task Statements). The failure mode needs reproduction before choosing a fix site.
- Stale line references in the ticket (`opencode.plugin.ts` 527-543 vs 599-615).
- Speculative: reordering User PATH rewrites the registry value through `SetEnvironmentVariable`, so the already-deferred `%VAR%` flattening issue (15307 deferred file) applies to any new rewrite.
- Speculative: Machine PATH precedes User PATH, so an installer that only reorders User PATH cannot fix a Machine-scope stale shim.
- No PowerShell test harness; installer changes are verifiable only manually or by dry-run output.
- `clidiag.ps1` and the doctor checks were not inspected and may duplicate PATH logic.

---

## 7. Summary for Complexity Assessment

The ticket touches two independent areas. One is `install/windows/install.ps1` (`Add-UserPath` at 100-122 and the portable-mode callers at 360-364). The other is the TypeScript detection path (`src/utils/processes.ts` `commandExists`/`getCommandPath`, consumed by `BaseAgentAdapter.isInstalled`, four plugin overrides and about 20 other call sites). A shadow-detection precedent exists (`isShadowedCodemieShim` in `hook-command.ts`), but it is specific to one package path, not to PATH order. Doctor checks are an adjacent reporting layer.

Technical novelty is moderate. `where.exe` already returns all matches in PATH order and the code discards all but the first, so no new OS interaction is needed on the detection side. The installer side needs a PATH-reordering behavior that has no precedent in the script (append-only today), with the known `%VAR%` flattening caveat and the Machine-vs-User PATH ordering as facts to account for.

Test posture: `processes.ts` is well covered by Vitest with a mocked `exec`. The PowerShell installer has no tests. The ticket's root-cause narrative (the "not installed" symptom) does not fully match what a first-match shadow would produce, so reproduction detail is a clarity risk.

---

## 8. External References

None named by the task as a path. Mentioned but not fetched: GitHub issue https://github.com/codemie-ai/codemie-code/issues/493 and PR #588 (unverified; no network lookup was made). The prior task records under `docs/superpowers/tasks/2026-09-28-epmcdme-15307/` were consulted instead.
