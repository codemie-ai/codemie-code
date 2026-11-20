# Technical Research

**Task**: shell-hooks windowsHide spawn codemie-code-hooks
**Generated**: 2026-11-20
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-16970 (Bug). Summary: Add windowsHide: true to execCommandAsync()'s detached sh spawn to stop console-window flash on Windows.
On Windows, a brief sh.exe (Git Bash) console window flashes during tool execution when running codemie-opencode. Root cause: execCommandAsync() in src/agents/plugins/codemie-code-hooks/shell-hooks-source.ts (~lines 234-238) spawns `sh -c <command>` with detached: true but no windowsHide option. This is the hooks-injection source for the codemie-code/opencode plugins. A similar fix (d9421f9d, "hide detached daemon console window on Windows") only touched spawnDetached() in src/utils/processes.ts (proxy daemon). Suggested fix: add windowsHide: true to the spawn options in execCommandAsync(), matching the pattern at src/utils/exec.ts:77, BaseAgentAdapter.ts:928, sso.detached-login.ts:378. No separate acceptance criteria. GitHub issue #494. Also check for any other sibling spawn sites in the injected hook sources that lack windowsHide.

---

## 2. Codebase Findings

### Existing Implementations
Purpose: child processes spawned by injected hook source do not show a console window on Windows.
- `src/agents/plugins/codemie-code-hooks/shell-hooks-source.ts:220-241` `execCommandAsync()` — `spawn("sh", ["-c", command], {env, stdio:["pipe","ignore","ignore"], detached:true})` at line 225; no `windowsHide`. Used for async hooks (Stop).
- Same file, `execCommand()` ~line 195-218 — `execSync(command, {input, timeout, env, encoding, maxBuffer, stdio})` at line 202; no `windowsHide`. Sync path for blocking hooks (tool execute before/after). Sibling site, same flash risk.
- `shell-hooks-v2-source.ts` — no spawn/exec calls (grep: only event-name matches); it routes through the v1 helpers.
- `reasoning-sanitizer/` — no spawn/exec sites found.
- Existing windowsHide usage: `src/utils/exec.ts:82` (`windowsHide: isWindows`), `src/utils/processes.ts:125,273,723`, `src/cli/commands/skills/lib/run-skills-cli.ts:117` (`os.platform()==='win32'`). Cited BaseAgentAdapter.ts:928 and sso.detached-login.ts:378 not opened.
- Other touched code: `inject-hooks.ts`, `index.ts` (consumers of the source string).

### Decisions Already in the Code
- Hook source is a template string injected into the OpenCode host process (note `"\\n"` escaping at ~line 258); edits must stay valid inside the template and run on plain Node child_process.
- Convention: windowsHide is set unconditionally true (processes.ts tests) or conditionally on win32 (exec.ts, skills); both are no-ops on non-Windows.

### Task Statements Checked Against the Code
- "execCommandAsync spawns sh -c with detached:true, no windowsHide": holds (line 225-229; line numbers ~234-238 in ticket are approximate).
- "Check sibling spawn sites": one found, `execSync` at line 202, also lacking windowsHide.
- d9421f9d touched only spawnDetached: not verified against git history.

### Consumers of Changed Contracts
Spawn options only; `execCommandAsync` return is void, `execCommand` return shape unchanged. Callers are within shell-hooks-source.ts. Test file `__tests__/shell-hooks-source.test.ts` imports the source.

### Architecture and Layers Affected
Agent plugin layer: `codemie-code-hooks` injection source (used by codemie-code and opencode plugins).

### Integration Points
Child_process `spawn`/`execSync` on Windows launching Git Bash `sh`.

### Patterns and Conventions
Existing windowsHide pattern above; `processes-detached.test.ts` asserts spawn options via a mock.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists (architecture, development, integration, ...); no guide specific to this source read.

### Architectural Decisions
None found.

### Derived Conventions
See Patterns above.

---

## 4. Testing Landscape

### Existing Coverage
`src/agents/plugins/codemie-code-hooks/__tests__/shell-hooks-source.test.ts` — exists; grep for `spawn|windowsHide` returned no matches there.

### Testing Framework and Patterns
Vitest; mock-based option assertion in `src/utils/__tests__/processes-detached.test.ts`.

### Coverage Gaps
No assertion on spawn/execSync options in the hook source tests.

---

## 5. Configuration and Environment

No env vars, flags or deployment config involved.

---

## 6. Risk Indicators

- Sibling site `execSync` (shell-hooks-source.ts:202) also lacks windowsHide; ticket names only execCommandAsync.
- Speculative: the source is a template string; changes must remain valid inside it.
- Low risk overall: option is a no-op on non-Windows.

---

## 7. Summary for Complexity Assessment

Single file (`shell-hooks-source.ts`), one agent-plugin layer, two spawn sites lacking `windowsHide` (spawn at line 225, execSync at line 202). v2 source and reasoning-sanitizer have none. Pattern already established in the repo; no novelty.

Tests: file exists but does not assert spawn options. Risk is minimal; the main one is scope (one vs. both sites).

---

## 8. External References

None named by the task.
