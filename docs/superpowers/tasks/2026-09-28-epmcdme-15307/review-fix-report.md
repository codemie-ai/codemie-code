DONE

CR-001 — install/macos/install.sh:128-135 — when a legacy override is migrated and the
resolved mode is not user-prefix, print a PATH-cleanup hint if $LEGACY_PREFIX/bin is
still on $PATH. Verify: `sh -n install/macos/install.sh` → EXIT=0.

CR-002 — install/windows/install.ps1:168-185 (Resolve-InstallMode) — guard the npm
prefix read: null/whitespace now returns 'portable' instead of calling .ToString() on
$null under $ErrorActionPreference='Stop'. Verify: PowerShell AST ParseFile → no parse
errors; `install.ps1 -DryRun` ran clean (EXIT=0), Mode resolved to npm-global without
crashing.

CR-003 — install/windows/install.ps1:245-264 — under -DryRun the "ran: npm config
delete prefix" line is now conditional (prints "DRY RUN: would run ..." instead);
Resolve-InstallMode gained an optional -LocationArgs param, and when
$DryRun -and $LegacyOverrideDetected the auto-mode preview now reads
`npm config get prefix --location global` instead of the still-set legacy user prefix,
so the previewed mode matches what a real run computes post-deletion. Verify: AST parse
clean; `install.ps1 -DryRun` (no legacy override present on this machine, so that branch
wasn't runtime-exercised, but the DryRun run completed cleanly with no npm config
mutations). Test-DirWritable's create/delete probe file was left as-is — it already runs
during every auto-mode DryRun today (pre-existing, not introduced by this fix) and the
spec forbids ACL-only/Test-Path-only checks, so avoiding the probe write isn't possible
without diverging from the spec's writability-check method; documented here as the
"simplest correct option" per the finding's own guidance.

CR-004 — src/utils/cli-updater.ts:275-282 — updateCli's failure-branch fallback command
now builds from `getSelfPrefixArgs(CLI_PACKAGE_NAME)` and appends --prefix when it
applies, instead of a hard-coded npm install -g line. RED:
`npx vitest run src/utils/__tests__/cli-updater.test.ts` failed (fallback omitted
--prefix). GREEN: same command passes (2/2).

CR-005 — src/utils/npm-prefix.ts:46-70,68-70 (deriveSelfPrefix) — on win32, additionally
require `existsSync(<prefix>\codemie.cmd)` before returning the derived prefix, so a
project-local dependency or npx-cache layout no longer misfires as a global install;
POSIX layout unchanged. Existing win32 tests updated to mock existsSync accordingly.
RED: `npx vitest run src/utils/__tests__/npm-prefix.test.ts` failed on the 2 new tests
(missing existsSync call / returned path instead of null). GREEN: 20/20 pass.

Full check: `npm run typecheck` → EXIT=0. Targeted suite (npm-prefix, processes, cli-bin,
doctor-checks, cli-updater) → 106/106 passed. `npx eslint` on the 4 changed/added TS
files → clean.

Commits (EPMCDME-15307 branch):
- 8664bba fix(ci): warn about stale legacy bin on PATH after macOS/Linux migration (CR-001)
- 7b33c27 fix(ci): guard Resolve-InstallMode and make -DryRun preview truthful (CR-002, CR-003)
- 90b72ff fix(utils): include derived --prefix in cli-updater's fallback command (CR-004)
- f05be6b fix(utils): require a global-install marker for win32 self prefix (CR-005)

Concerns:
- CR-003's DryRun preview for the migration branch was verified by code review and a
  DryRun run on a machine with no legacy override present (that branch wasn't runtime-
  exercised, since I could not set a real legacy override without mutating this
  machine's npm config, which is out of scope and risky). AST parse and auto-mode-only
  DryRun both passed clean.
- install.sh was verified with `sh -n` only (not executed), per instructions.
- Did not touch install/README.md — none of the five findings changed documented
  behavior.
