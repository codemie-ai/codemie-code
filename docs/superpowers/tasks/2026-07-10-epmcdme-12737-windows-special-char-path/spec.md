# Spec: Fix codemie-code on Windows with special characters in profile path

**Ticket**: EPMCDME-12737
**Branch**: EPMCDME-12737_windows-special-char-path

---

## Problem

On Windows, users whose profile directory contains `(` or similar CMD.EXE metacharacters (e.g. `C:\Users\AkshathaR(Contractor\...`) cannot run `codemie-code`. The CLI fails with:

```
'C:\Users\AkshathaR' is not recognized as an internal or external command, operable program, or batch file.
```

## Root Cause

`src/agents/core/BaseAgentAdapter.ts` lines 706–770:

1. `commandPath` is initialised to the raw unquoted binary path from plugin metadata (line 707).
2. A quoting guard at lines 712–713 wraps `commandPath` in double-quotes **only** when `getCommandPath()` returns a non-null resolved path.
3. `getCommandPath()` calls `where.exe` with the full absolute binary path. When the deep `node_modules/.../bin/` directory is not in the user's `PATH`, `where.exe` exits non-zero and `getCommandPath` returns `null`.
4. With `null` returned, execution falls through to line 754 with `commandPath` still holding the raw unquoted value.
5. `spawn(finalCommand, finalArgs, { shell: true })` is invoked on Windows, which calls `cmd.exe /d /s /c "..."`. CMD.EXE interprets bare `(` as a compound-group delimiter, truncates the command at `C:\Users\AkshathaR`, and emits the error above.

## Fix

### Production code — `src/agents/core/BaseAgentAdapter.ts`

Insert after line 750 (end of the `else if (!isWindows)` block), before `let finalCommand = commandPath`:

```typescript
// On Windows, ensure commandPath is quoted for cmd.exe regardless of how it was resolved.
// getCommandPath() may return null (binary not in PATH) leaving commandPath as the raw
// unquoted absolute path from plugin metadata. CMD.EXE treats bare '(' as a
// compound-group delimiter, so paths like C:\Users\Name(Org\...\bin\cmd.exe must be quoted.
if (isWindows && /[ ()&|<>^%[\]{}]/.test(commandPath) && !commandPath.startsWith('"')) {
  commandPath = `"${commandPath}"`;
}
```

**Why the `startsWith('"')` guard?** The `if (resolvedPath)` branch at lines 712–713 may have already quoted `commandPath`. The guard prevents double-quoting in that case.

**Regex choice:** `/[ ()&|<>^%[\]{}]/` — identical to the regex already used at line 713 for the `resolvedPath` quoting branch. Keeps the two branches consistent.

### Out of scope

`src/utils/exec.ts` line 69 has the same gap (`command` itself is never quoted before concatenation). That path is currently not triggered by the `codemie-code` spawn chain. It is deferred to a separate cleanup ticket.

## Tests

File: `src/agents/core/__tests__/BaseAgentAdapter.test.ts`

Add a `describe('run() — Windows command path quoting')` block with three test cases:

| # | Scenario | `cliCommand` | `getCommandPath` returns | Expected `spawn` first arg |
|---|---|---|---|---|
| 1 | null path, special char | `C:\Users\Name(Org\bin\cmd.exe` | `null` | `"C:\Users\Name(Org\bin\cmd.exe"` (quoted) |
| 2 | null path, clean path | `C:\Users\Normal\bin\cmd.exe` | `null` | `C:\Users\Normal\bin\cmd.exe` (unchanged) |
| 3 | resolved path with `(`, no double-quote | `C:\Users\Name(Org\bin\cmd.exe` | `C:\Users\Name(Org\bin\cmd.exe` | `"C:\Users\Name(Org\bin\cmd.exe"` (quoted exactly once) |

Mocking: `vi.mock('child_process', ...)` for spawn; dynamic import mock for `getCommandPath` following the existing `beforeEach` pattern in the file.

## Acceptance Criteria

- `codemie-code` runs successfully when the user's profile path contains `(`, spaces, or any of `()&|<>^%[]{}`.
- Clean paths (no metacharacters) are not modified.
- Paths already quoted by the `getCommandPath` branch are not double-quoted.
- The three new unit tests pass.
- Existing `BaseAgentAdapter` tests remain green.
