# Technical Research

**Task**: sounds installer audio player exec
**Generated**: 2026-11-23
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-16959: fix `codemie install <agent> --sounds` falsely reporting 'No audio player found' on Linux/WSL-Debian even though a supported player (aplay) is installed. Reproduced in Docker Debian 12: `command -v aplay` finds /usr/bin/aplay but CLI says "No audio player found". Cause per ticket (verify at HEAD): checkAudioPlayer() in src/agents/plugins/claude/sounds-installer.ts calls exec('command', ['-v', player]); exec() defaults to shell:false and on Debian `command` is a shell builtin with no binary, so ENOENT always. Ticket proposal: delegate to commandExists() from src/utils/processes.ts — verify this on research; evaluate alternatives only if the proposal has a problem. An uncommitted failing test exists: src/agents/plugins/claude/__tests__/sounds-installer.test.ts (red: "expected null to be 'success'") — use it as Test-first; may be extended (e.g. no player found case), not rewritten. macOS (afplay) behavior must not change. Scope: audio player detection only; if the same defect (exec('command', ...)) exists elsewhere, list the locations as candidates for a separate ticket, do not fix. Also note how commandExists behaves on Windows and how tests mock exec/commandExists.

---

## 2. Codebase Findings

### Existing Implementations
- Audio detection: `src/agents/plugins/claude/sounds-installer.ts:22-47` `checkAudioPlayer()` loops `['afplay','aplay','paplay','mpg123']`, runs `await exec('command', ['-v', player])` (line 27) in try/catch; any non-throw returns the player, else logs debug and continues; returns null at end. Sole caller: `installSounds()` (~line 116) which on null prints "No audio player found" via ora spinner and returns null. Imports `exec` from `../../../utils/exec.js` (line 10); `exec` is used by no other call in this file per the import list (not verified beyond grep of line 27 hit).
- `commandExists(command)` at `src/utils/processes.ts:28-40`: runs `which <cmd>` (Unix) or `C:\Windows\System32\where.exe $PATH:<cmd>` (Windows), via `exec`; returns `result.code === 0`; catch returns false. Never throws. `$PATH:` prefix prevents cwd lookup on Windows.
- `exec` (`src/utils/exec.ts`): default shell:false (option `shell?` at line 17 overrides). So `exec('command', ...)` spawns binary `command`: exists on macOS (/usr/bin/command), absent on Debian -> ENOENT. This explains why macOS works and Linux fails; ticket cause holds.
- Other users of `commandExists`: `src/cli/commands/sound.ts:6,61`, BaseAgentAdapter, codex/kimi/opencode/copilot-cli plugins, graphify, codebase-memory, moonshot/anthropic-subscription providers (established usage).
- Other `exec('command', ...)` occurrences: grep of `src` (non-test) for `exec('command'`, `'command', ['-v'` found only `sounds-installer.ts:27`. No separate-ticket candidates found (search was literal-pattern; shell-variant spellings not exhaustively checked).

### Decisions Already in the Code
- Command-presence checks convention is `commandExists` from `src/utils/processes.ts` (see consumers above).
- Behaviour difference: `exec` rejects on non-zero exit (implied by try/catch design in checkAudioPlayer) while commandExists returns boolean; detection must use the boolean, not "did not throw".

### Task Statements Checked Against the Code
- "exec('command', ['-v', player]) at checkAudioPlayer": holds (line 27).
- "exec() defaults to shell:false": holds (exec.ts).
- "delegate to commandExists()": holds as feasible; function exists, exported, non-throwing, cross-platform. No problem found.
- "same defect elsewhere": none found in `src` (see above).

### Consumers of Changed Contracts
`checkAudioPlayer` is module-private; only `installSounds` consumes it (return string|null unchanged). `installSounds` callers not traced beyond the install command flag path. `commandExists` unchanged.

### Architecture and Layers Affected
Agent plugin layer (claude plugin installer helper) calling the utils layer.

### Integration Points
`utils/processes.ts` (commandExists -> exec -> which/where.exe); `utils/exec.ts`.

### Patterns and Conventions
Imports need `.js` extension; `@/` alias preferred over deep relative (file mixes both). Logging via `logger.debug`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
Guides per AGENTS.md (`.ai-run/guides/...`) not read; scope is a single helper.

### Architectural Decisions
None found.

### Derived Conventions
See Patterns above.

---

## 4. Testing Landscape

### Existing Coverage
`src/agents/plugins/claude/__tests__/sounds-installer.test.ts` (untracked): one test, mocks `fs/promises`, `@/utils/paths.js`, `@/utils/logger.js`, `ora`, `@/utils/exec.js` (`exec: vi.fn()`), `@/utils/processes.js` (`commandExists: vi.fn()`). `exec` mock throws ENOENT when command==='command' else returns code 0; `commandExists` resolves true only for 'aplay'. Expects `installSounds()` to equal `'success'`. Currently red because source never calls commandExists. Uses `vi.resetModules()` + dynamic import. Note mocks use `@/` paths while source imports relative `../../../utils/...`; Vitest resolves both to the same module, so either import style in source is mocked.
Existing `processes.test.ts` covers commandExists.

### Testing Framework and Patterns
Vitest, `@group unit`, dynamic-import mocking.

### Coverage Gaps
No test for the no-player-found case (commandExists all false -> null) or the afplay-first (macOS) path. `installSounds` beyond detection (script install, settings write) is mocked only partially: the test mocks only `fs/promises` mkdir, so other fs writes in installSounds run for real or are unverified in this research.

---

## 5. Configuration and Environment

### Environment Variables
None relevant found.

### Configuration Files
`getCodemiePath` used for ~/.codemie paths (mocked in test).

### Feature Flags and Deployment Concerns
`--sounds` flag on install. Windows: commandExists uses where.exe, so players would be probed (none of the four normally exist on Windows) -> null as before; before the change `exec('command')` on Windows would also fail, so no behaviour change.

---

## 6. Risk Indicators

- Speculative: if the test's `exec` mock is retained but source no longer imports `exec`, an unused import must be removed to pass lint (zero-warning policy).
- Low: macOS behaviour: `which afplay` succeeds where `/usr/bin/command -v afplay` did; same result for the first player.
- Test relies on other fs operations in installSounds not failing under mocks; unverified.
- Windows commandExists depends on hardcoded `C:\Windows\System32\where.exe`.

---

## 7. Summary for Complexity Assessment

One layer, one file of production code: `checkAudioPlayer()` in `sounds-installer.ts` (lines ~22-47). The ticket's cause is confirmed (`exec` defaults to shell:false; `command` is only a binary on macOS). The proposed `commandExists` already exists, is non-throwing, handles Windows via where.exe, and is the repo's established presence check used in ~10 modules.

No novel patterns. A red test exists and encodes the fix; gaps are the no-player and macOS-first cases. No other `exec('command', ...)` occurrences found in `src`, so no follow-up ticket candidates. Risk is low; the main caveat is the unverified behaviour of the rest of `installSounds` under the test's partial mocks.

---

## 8. External References

None named by the task
