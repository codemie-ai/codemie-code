# EPMCDME-16967: install.ps1 must not abort on benign npm stderr

## Problem
`install/windows/install.ps1:12` sets `$ErrorActionPreference = 'Stop'` for the whole script. `Get-PackageVersion` (`install.ps1:75-98`) runs `npm view` with `2>&1` (line 87). Each stderr line then becomes an ErrorRecord, which Stop turns into a terminating `NativeCommandError`. A harmless npm warning, such as an unrecognized `email` key in `.npmrc`, therefore aborts the install. The same merge can put warning text into the returned version (line 97) and into the error message (line 92). (GitHub #445)

## Behavior
- Inside `Get-PackageVersion` only, npm stderr must never terminate the script. The `npm view` call must behave the same on Windows PowerShell 5.1 and PowerShell 7+.
- The returned version is taken from npm's stdout only. Stderr ErrorRecords are excluded from the version.
- On non-zero npm exit, the existing error is thrown unchanged in meaning. The `npm output:` text may include stderr, because it helps diagnosis.
- Success with warnings returns the version and the install continues.
- The global Stop preference and every other function stay as they are. Exit-code checks stay the contract for failure.

## Acceptance criteria
1. With an unrecognized key in `.npmrc`, `install.ps1` completes instead of aborting, on PS 5.1 and PS 7.x.
2. `Get-PackageVersion` returns only the version string when npm writes warnings to stderr.
3. When npm exits non-zero, the install still fails with the "was not found in registry" message.
4. The `-DryRun` path is unchanged (returns `dry-run`).
5. `$ErrorActionPreference` is restored after the call, including when it throws.

## Non-goals
- `install/macos/install.sh:111`, which has the same `2>&1` pattern but a different mechanism.
- Changing the global `$ErrorActionPreference = 'Stop'`.
- Other native calls in `install.ps1` (49, 69, 180, 192, 316). They do not redirect stderr, so they are not affected.
- `clidiag.ps1`, which runs under Continue.
- Adding Pester or other tests, or declaring a minimum PowerShell version.

## Decisions
- Use a local `$ErrorActionPreference = 'Continue'` plus filtering ErrorRecords out of `$output`, over `$PSNativeCommandUseErrorActionPreference = $false`. The variable exists only in PS 7.3+ and does not cover the 5.1 ErrorRecord wrapping. This answers how to support PS 5.1.
- Scope the change to `Get-PackageVersion`, over changing the script-wide preference. The other native calls are not affected.
- Take the version from non-ErrorRecord output only, over returning the first output element. This answers whether warning text may leak into the version.
- Keep stderr in the failure message, over dropping it. This keeps the diagnostics the current message gives.

## Verification
Manual on Windows, because there is no PowerShell test harness: run with a `.npmrc` containing `email=...` and with `-DryRun`. Also run against an unreachable registry to confirm the failure path.

## Assumptions
- The minimum supported PowerShell is undeclared. The spec requires working on 5.1 and 7+.
- The repo files do not confirm exact PS 5.1 ErrorRecord behavior, so it is verified manually.
