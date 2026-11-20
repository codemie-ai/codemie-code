# Gemini hooks open empty cmd.exe windows on Windows: Story

**Ticket**: EPMCDME-16975
**Status**: Corrected draft 2026-11-20 (supersedes the 2026-11-18 story; approved by me at the spec gate, not before)

## Complexity
**Size**: L (24/36, assessed 2026-11-18 on the original premise; the Gemini-behaviour risk that drove it is now resolved) · **Recommended flow**: sdlc-standard

## Context
- On Windows, a Gemini hook whose command is the extensionless codemie shim (`.../npm/codemie hook`) makes PowerShell start `cmd.exe /c codemie.cmd hook`, which opens a visible console window on every hook event (5 per headless turn).
- Fresh installs of current main write `.../npm/codemie.cmd hook` and do not reproduce. Installs made before 0.16.3 still hold the extensionless command and are never repaired.
- Gemini ignores a per-hook `shell` field, so the PowerShell pin is not a fix for Gemini.

## Story
**As a** developer on Windows who runs `codemie-gemini`, **I want** the installed hook commands to never open a console window, **so that** my terminal and editor focus are not stolen on every prompt and response, including after upgrading from an older version.

## Acceptance Criteria
- AC1: Given Windows and an installed Gemini `hooks.json` whose commands use the extensionless codemie shim, when the user next launches `codemie-gemini`, then every such command is rewritten to the `.cmd` shim and still invokes `codemie hook`.
- AC2: Given Windows and a fresh install, when the install completes, then every Gemini hook command uses the `.cmd` shim (regression guard; already true).
- AC3: Given hooks already on the `.cmd` shim, when the repair runs again, then nothing changes (idempotent, file not rewritten).
- AC4: Given the extensionless command and no `<shim>.cmd` file beside it, when the repair runs, then the command is left as is and the install does not fail (non-fatal).
- AC5: Given a non-Windows machine, when install or repair runs, then hook commands are unchanged.
- AC6: Given Claude hooks on Windows (quoted and unquoted paths), when install or repair runs, then the existing PowerShell pin and `& ` behavior is unchanged.
- AC7 (manual, run by me after the flow): on Windows with extensionless hooks, a `codemie-gemini` headless turn no longer opens cmd.exe windows after the repair.

## Out of Scope
- NG1: Changes to Gemini CLI or its hook executor.
- NG2: Adding `"shell": "powershell"` to Gemini hooks (no effect on Gemini, see Context).
- NG3: The OpenCode console flash (EPMCDME-16970, #494).
- NG4: Any change to the Claude pin beyond non-regression.
- NG5: A new migration, unless the plan shows the every-launch repair is not reached on `codemie-gemini` launch.

## Decisions
- D1: Done means unit tests for the rewrite (extensionless to `.cmd`, idempotence, missing `.cmd`, non-Windows) and passing quality gates, plus my manual Windows run (AC7).
- D2: The rewrite lives in the shared hook-command logic (`resolveHookCommand` / `rewriteHooksCommandTree`) and is healed by the existing every-launch `localizeInstalledHooks`. The spec decides host scope. Default: all hosts, with AC6 as the non-regression guard.

## Open Questions
- Q1: Does every `codemie-gemini` launch reach `localizeInstalledHooks` (including the up-to-date branch)? The plan must confirm it from the code before deciding NG5.

## Handoff (Stage 10)
Print the artifact lines, then remind me of AC7. Manual repro, from Jira comment 16114112: with hooks edited to `npm/codemie hook` (UTF-8 without BOM) run `codemie-gemini --model gemini-3.5-flash -p "reply with the single word ok"` and expect no windows after the repair. A script that logs new windows is at `%TEMP%\repro16975\winwatch.ps1`. Do not push and do not open a PR.
