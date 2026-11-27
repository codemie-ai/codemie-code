# EPMCDME-16982 Pi install on Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** `codemie install pi` works on Windows (`pi.cmd`) and does not re-run Pi package install when Pi is already installed.

**Architecture:** Fix is local: `shell: process.platform === 'win32'` in `pi.packages.ts`; `install.ts` marks already-installed calls with `alreadyInstalled: true`; `PiPlugin.additionalInstallation` skips on it.

**Tech Stack:** TypeScript, ES modules (`@/` alias, `.js` imports).

**Spec:** `spec.md` in this directory.

Commit per task using the repository's existing convention.

## Global Constraints

- `exec()` (`src/utils/exec.ts`) and its callers stay unchanged; diff touches only `pi.packages.ts`, `pi.plugin.ts`, `install.ts`.
- Never run the real installer, `npm link`, global installs, or `pi install`; never touch `~/.codemie`, `~/.pi`, or the global npm prefix.
- No new tests (repo policy). Verification of each task is `npm run typecheck` and `npm run lint`; the final stage owns the build and full gates.

## Task 1: Windows shell for the pi install spawn

**Files:** Modify `src/agents/plugins/pi/pi.packages.ts:35-38`

**Test-first:** no — tests only on explicit request; the change is a one-option addition, verified by typecheck/lint.

- [ ] Add `shell: process.platform === 'win32'` to the options object of the `exec(cliCommand, ['install', pkg], {...})` call, with a one-line comment that `pi` is a `.cmd` shim on Windows, as with the npm/npx spawns in `src/utils/processes.ts`.
- [ ] Run `npm run typecheck` and `npm run lint`. Expected: no errors or warnings.

## Task 2: Skip Pi package install when Pi is already installed

**Files:**
- Modify: `src/cli/commands/install.ts:138` and `:167` (the two already-installed branches only; leave `:222` unchanged)
- Modify: `src/agents/plugins/pi/pi.plugin.ts:498-502`

**Test-first:** no — tests only on explicit request; behavior (skip on `alreadyInstalled`, install otherwise) is verified by review plus typecheck/lint.

- [ ] In `install.ts`, change the two `agent.additionalInstallation(options)` calls in the already-installed branches to pass `{ ...options, alreadyInstalled: true }`. `AgentInstallationOptions` has an index signature (`types.ts:718-723`), so no type change is needed; Claude ignores the key.
- [ ] In `PiPlugin.additionalInstallation`, rename `_options` to `options`; when `options?.alreadyInstalled === true`, `logger.info` that Pi is already installed so required packages are not reinstalled, and return before calling `installRequiredPiPackages`. Otherwise behavior is unchanged. Import `logger` from `@/utils/logger.js` only if not already imported in the file.
- [ ] Run `npm run typecheck` and `npm run lint`. Expected: no errors or warnings.

## Negative-constraint pass

- Spec non-goals (no `exec()` change, no `getVersion` fix, no `CODEMIE_PI_BIN` quoting, no new tests, no PR #485 work, no self-healing): honored; Tasks 1-2 touch only the three listed files and add no tests.
- AC6 (no real installer, link, global install, `~/.codemie`/`~/.pi`): honored; every step is typecheck/lint only.
