# install.ps1 npm stderr fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `Get-PackageVersion` no longer aborts on benign npm stderr and returns only npm's stdout version.

**Architecture:** Inside `Get-PackageVersion` only, temporarily set a local `$ErrorActionPreference = 'Continue'` around the `npm view ... 2>&1` call, restore it in `finally`, and split `$output` into stdout lines and ErrorRecords. Works on PS 5.1 and 7+.

**Tech Stack:** PowerShell (`install/windows/install.ps1`).

**Spec:** `docs/superpowers/tasks/2026-11-20-epmcdme-16967/spec.md`

Commit per task using the repository's existing convention.

## Global Constraints

- Keep the script-wide `$ErrorActionPreference = 'Stop'` (line 12) and all other functions unchanged.
- No `$script:` or `$global:` writes to `$ErrorActionPreference`; no `$PSNativeCommandUseErrorActionPreference`.
- `-DryRun` path returns `dry-run` unchanged.

## Review Focus

- npm exits 0 with only warnings on stderr and empty stdout: must throw the existing "not found in registry" message with npm output, not a null-reference error.
- Single stdout line (scalar) vs multiple lines (array): both must work, so wrap the filtered output in `@()`.
- npm exits non-zero: the existing message is thrown, `npm output:` includes stderr text.
- A throw inside the function still restores the caller's `$ErrorActionPreference`.

### Task 1: Make Get-PackageVersion tolerant of npm stderr

**Files:**
- Modify: `install/windows/install.ps1:75-98` (`Get-PackageVersion`)

Test-first: no — the repo has no installer test or Pester harness and tests are written only on explicit request; verification is manual on Windows (done by a later stage).

- [ ] **Step 1: Edit `Get-PackageVersion`, leaving the signature and the `$DryRun` branch (lines 82-85) untouched**
  - Replace line 87 with: save `$previousPreference = $ErrorActionPreference`; in `try`, set `$ErrorActionPreference = 'Continue'` (function-local scope) and run the same `& $NpmPath @('view', ...) 2>&1`; in `finally`, restore `$ErrorActionPreference = $previousPreference`. Capture `$LASTEXITCODE` into a local inside the `try`, before anything can reset it.
  - Derive `$versionLines = @($output | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] })` (the `@()` wrap handles scalar or array) and keep `$output` whole for the message.
  - Failure condition becomes: exit code non-zero OR `$versionLines.Count -eq 0`. It throws the existing `$message` (lines 89-94) unchanged, with `npm output:` built from all `$output` items rendered via `ForEach-Object { $_.ToString() }` joined by a space so ErrorRecords show their text.
  - Return `($versionLines | Select-Object -First 1).ToString().Trim()` in place of line 97.
