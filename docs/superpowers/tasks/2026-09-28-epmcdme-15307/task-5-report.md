DONE

Commit: 042ab62 "fix(ci): stop Windows installer from rewriting user npm prefix"
Changed paths: install/windows/install.ps1 (only file in commit; verified via `git show --stat HEAD`)

Verification commands and results:
- `powershell -NoProfile -Command "$null = [System.Management.Automation.Language.Parser]::ParseFile('install/windows/install.ps1',[ref]$null,[ref]$e); $e"` → no output (no parse errors).
- `powershell -NoProfile -ExecutionPolicy Bypass -File install/windows/install.ps1 -DryRun` → resolved `Mode: npm-global` on this machine, no `npm config set prefix` call, all npm/file mutations printed as `DRY RUN: ...`, no legacy override detected (no migration block triggered).
- `powershell -NoProfile -ExecutionPolicy Bypass -File install/windows/install.ps1 -Mode portable -DryRun` → `npm install` line includes `--prefix <PrefixDir>`, shim writes and PATH check all printed as DRY RUN, no npm config prefix write anywhere.
- Both runs logged to docs/superpowers/tasks/2026-09-28-epmcdme-15307/test.local.log and read back; confirmed no `npm config set prefix` or `npm config delete prefix` was executed for real (all under DRY RUN or skipped since no legacy override present on this machine).

Summary of new behavior/functions:
- `-Mode` now `ValidateSet('auto','npm-global','portable')`, default `auto`.
- New `Test-DirWritable`: walks up to the nearest existing ancestor, then create+delete-probes a random temp file (no ACL/Test-Path-only checks).
- New `Resolve-InstallMode`: `npm config get prefix` writable → `npm-global`, else `portable`; prints via `Write-Status 'Mode'`.
- New `Remove-UserPath`: mirrors `Add-UserPath`, strips `$BinDir` from user PATH, DryRun-safe.
- Migration block (runs before mode resolution, unconditional on `-Mode`): detects `npm config get prefix --location user` exactly equal (case-insensitive, trailing `\` trimmed) to `$PrefixDir`; lists stranded packages (`npm ls -g --prefix $PrefixDir --depth=0`), runs `Invoke-Checked npm config delete prefix --location user` with a printed revert command, removes stale shims + PATH entry when the resolved mode isn't portable, and prints reinstall/cleanup guidance.
- Removed the `npm config set prefix ... --location user` call entirely; portable installs pass `--prefix $PrefixDir` to `npm install -g` instead.
- `@codemieai:registry` write now prints its revert command (`npm config delete @codemieai:registry --location user`).

Concerns:
- Commit scope `ci` was used (no `install`/`installer` scope exists in commitlint scope-enum); this matches the two prior commits that touched this same file (`4b7b35c`, `a9af611`), so it's precedented but semantically odd for an installer behavior change.
- `npm ls -g --prefix $PrefixDir --depth=0` and the `npm config get prefix --location user` read both run unconditionally, even under `-DryRun`, since they are read-only; this matches `Resolve-InstallMode`'s own read and is dry-run safe, but differs from `Get-PackageVersion`, which fully skips its npm call under `-DryRun`.
- Could not exercise the legacy-override migration branch live (this machine has no legacy prefix set), so that code path was verified by reading, not by a real dry run hitting it.
