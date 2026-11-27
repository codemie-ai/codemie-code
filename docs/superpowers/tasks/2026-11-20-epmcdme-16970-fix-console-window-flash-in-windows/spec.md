# EPMCDME-16970: Hide sh.exe console window in injected shell hooks (Windows)

## Problem
On Windows, running codemie-opencode flashes a console window during tool execution. The injected hook source `src/agents/plugins/codemie-code-hooks/shell-hooks-source.ts` spawns `sh` without `windowsHide`: `execCommandAsync()` (spawn, ~line 225, async hooks such as Stop) and `execCommand()` (execSync, ~line 202, blocking tool before/after hooks). GitHub issue #494.

## Approach
Add `windowsHide: true` to the options of both calls. It is a no-op on non-Windows and matches the repo pattern (`src/utils/exec.ts:82`, `src/utils/processes.ts`). Edits stay valid inside the template string the source is embedded in. No signature or return-shape changes.

## Acceptance criteria
1. `execCommandAsync()`'s `spawn("sh", ["-c", ...])` call passes `windowsHide: true`.
2. `execCommand()`'s `execSync` call passes `windowsHide: true`.
3. Existing options (`detached`, `stdio`, `env`, `timeout`, etc.) and hook behavior are unchanged.
4. The generated hook source remains valid JavaScript.

## Non-goals
- Changing `src/utils/processes.ts`, `exec.ts` or other spawn sites (already handled).
- Refactoring the hook source or v2 source (`shell-hooks-v2-source.ts` has no spawn sites).
- Adding tests unless requested.

## Decisions
- Include the sibling `execSync` site over fixing only `execCommandAsync`: same flash risk, same file, ticket scope extended per task instruction.
- Unconditional `windowsHide: true` over a `win32` check: no-op elsewhere, simpler inside the template string.

## Assumptions
- Line numbers are approximate (analysis section 2); the `BaseAgentAdapter.ts:928` and `sso.detached-login.ts:378` citations in the ticket were not opened.
