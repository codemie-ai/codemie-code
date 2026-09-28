DONE

Commit: f90b3cf (docs(ci): document installer modes, defaults, and prefix migration)
Changed paths: install/README.md

Verification: docs-only task, no test command specified. Reviewed the rendered diff manually (`git show --stat HEAD` confirms only install/README.md changed, 40 insertions/3 deletions).

Summary:
- Updated the `-Mode` parameter row to `auto|npm-global|portable`, default `auto`.
- Added a new "What each mode changes" table covering both installers, noting neither mode writes `prefix` to `.npmrc`.
- Documented the `@codemieai:registry` revert command.
- Added an "Upgrading from an older installer" section: exact-match detection, stranded-package listing, delete-and-report, mode re-resolution, stale-shim/PATH cleanup on Windows, reinstall guidance, `codemie doctor` detection, and the manual `npm config delete prefix --location user` fallback.
- Fixed "Windows Defaults" (now describes `auto` resolving to `npm-global`/`portable`) and "macOS/Linux Defaults" (now describes `--prefix`-based install, no `.npmrc` write).

Concerns:
- Used commit scope `ci` (matching task 6), not `install`, because commitlint's scope-enum in commitlint.config.cjs does not include `install`, `docs`, or `readme`; the first commit attempt with `docs(install): ...` was rejected by the commit-msg hook.
- Left the separate "Default Paths" subsection under "Windows Installation Wizard" (the GUI `.exe` wizard, a different codepath) untouched — that describes the prebuilt Connect wizard binary, which is out of scope per the ticket's non-goals ("Changes to the CodeMie Connect wizard... flagged to its owners").
- Did not touch install/windows/install.ps1, install/macos/install.sh, or any other task's files/commits.
