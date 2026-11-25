# Technical Research

**Task**: powershell install windows npm
**Generated**: 2026-11-20
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-16967 (Bug): Windows install.ps1 aborts on benign npm stderr warnings due to global $ErrorActionPreference = 'Stop'.
Root cause: install/windows/install.ps1:12 sets $ErrorActionPreference='Stop' globally. Get-PackageVersion (~line 87) runs `$output = & $NpmPath @('view', $PackageSpec, 'version', '--registry', $RegistryUrl) 2>&1` — capturing native stderr into a variable turns each stderr line into an ErrorRecord; under global Stop this becomes a terminating NativeCommandError. A benign npm warning (e.g. unrecognized `email` key in .npmrc) aborts the installer. Unchanged since v0.10.1; PR #588 reworked npm-prefix logic but never touched this.
Repro: Windows, .npmrc with unrecognized key (email), run install script under install/windows/ -> aborts with NativeCommandError instead of completing.
Suggested fix: set $PSNativeCommandUseErrorActionPreference = $false (or otherwise avoid treating captured native stderr as terminating) around the `npm view` call in Get-PackageVersion. GitHub issue #445. Also check other native-command calls with 2>&1 under Stop in install/ scripts (including any other install scripts).

---

## 2. Codebase Findings

### Existing Implementations
Purpose: run npm natives from the installer without aborting on stderr.
- `install/windows/install.ps1:12` sets `$ErrorActionPreference = 'Stop'` script-wide (the only assignment in the file).
- `install.ps1:75-98` `Get-PackageVersion`: line 87 `$output = & $NpmPath @('view', ...) 2>&1`; then checks `$LASTEXITCODE`, throws a message including `$output -join ' '`; returns `($output | Select-Object -First 1).ToString().Trim()`. Note: with 2>&1 the first output element can be an ErrorRecord (a stderr warning) rather than the version line, so even without aborting, the returned version could be the warning text. Consumers: called once for version resolution (dry run returns 'dry-run').
- Other native calls in install.ps1, none with `2>&1` (stderr goes straight to host): line 49 `& $NodePath --version`; line 69 `Invoke-Checked` (`& $FilePath @Arguments`, checks `$LASTEXITCODE`); line 180 `npm config get prefix | Select-Object -First 1`; line 192 `npm config get userconfig | ...`; line 316 `npm ls -g --prefix ...`.
- `install/windows/clidiag.ps1`: `$ErrorActionPreference = 'Continue'` (line 95); line 386 `& taskkill.exe /T /F /PID ... 2>&1 | Out-Null` (not under Stop). Not affected.
- `install/windows/install.cmd`: wrapper only (no 2>&1 grep hit).
- `install/macos/install.sh:111`: `npm view ... 2>&1` in `if !` under shell (no Stop semantics; stderr merged into the version string, a parallel but separate issue).
- `scripts/prepare-install-artifacts.mjs:10` copies `install/windows/install.ps1` to the published `install.ps1` artifact.
- Other `.ps1` references in src (kimi, codebase-memory plugins) are third-party installer URLs, unrelated.

### Decisions Already in the Code
- Script-wide Stop with explicit `$LASTEXITCODE` checks for natives (`Invoke-Checked`). No `$PSNativeCommandUseErrorActionPreference` anywhere in repo (grep: none).
- Target PowerShell version is not declared (no `#requires`); `$PSNativeCommandUseErrorActionPreference` exists only in PS 7.3+, and Windows PowerShell 5.1 is the default on Windows.

### Task Statements Checked Against the Code
- Line 12 global Stop and line 87 `2>&1` capture: hold.
- "Other native-command calls with 2>&1 under Stop in install/": none other found in install.ps1; clidiag.ps1 line 386 is under Continue. Holds that line 87 is the only one.
- "Set `$PSNativeCommandUseErrorActionPreference = $false`": unverified for PS 5.1 behavior (the variable is PS 7.3+; the ErrorRecord-wrapping of 2>&1 under Stop in 5.1 is independent of it). Nothing in the repo confirms either way.
- "Unchanged since v0.10.1 / PR #588": not verified here (git history not examined).

### Consumers of Changed Contracts
`Get-PackageVersion` return value is the only contract; its callers are in install.ps1 (the resolved package version). None found elsewhere (grep of `Get-PackageVersion` limited to install/).

### Architecture and Layers Affected
Single standalone PowerShell script (distribution/installer layer), outside the TypeScript `src/` layers.

### Integration Points
npm CLI (`npm.cmd`) and the npm registry; published as release artifact via `scripts/prepare-install-artifacts.mjs`.

### Patterns and Conventions
Functions with `param()` blocks, `Write-Status`, `throw` with message strings, `$DryRun` early-return branches.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists (quality-gates, testing, etc.); none cover PowerShell installers. `install/README.md` documents the installers.

### Architectural Decisions
None found for error-preference handling.

### Derived Conventions
See Patterns above.

---

## 4. Testing Landscape

### Existing Coverage
No tests reference `install.ps1`, `NativeCommandError` or `PSNativeCommand` (grep over tests/, src/, scripts/ found only unrelated hits).

### Testing Framework and Patterns
Vitest for the TS project; no Pester or PowerShell test harness found.

### Coverage Gaps
install.ps1 entirely untested. Per AGENTS.md, tests are written only on explicit request.

---

## 5. Configuration and Environment

### Environment Variables
install.ps1 touches `npm_config_userconfig` (lines 175-182).

### Configuration Files
User `.npmrc` (read at line 192-201 for a `prefix` line).

### Feature Flags and Deployment Concerns
`-DryRun` switch; script is shipped as the public `install.ps1` artifact.

---

## 6. Risk Indicators

- Speculative: `2>&1` capture also puts ErrorRecord objects into `$output`, so the returned version (line 97) and the error message (line 92) may contain warning text; the fix may need to separate stdout from stderr.
- Speculative: the suggested variable is PS 7.3+ only; the script's behavior under Windows PowerShell 5.1 differs and nothing in the repo declares the supported version.
- No automated tests for the installer; verification is manual on Windows.
- macOS `install.sh:111` merges stderr into the version string by the same `2>&1` pattern (different mechanism, outside the ticket's Windows scope).

---

## 7. Summary for Complexity Assessment

The change surface is one PowerShell file (`install/windows/install.ps1`), one function (`Get-PackageVersion`, line 87), within a standalone installer outside the TypeScript layers. The only `2>&1` native capture under global Stop is that line; other native calls do not redirect stderr, and clidiag.ps1 runs under Continue.

No novel patterns are involved. There are no tests or Pester harness for the installer, and the PowerShell versions supported (5.1 versus 7.3+) are undeclared. This affects how the suggested variable behaves. Overall the task is small, with verification mostly manual on Windows.

---

## 8. External References

None named by the task (GitHub issue #445 and PR #588 are mentioned but not resolvable from the filesystem).
