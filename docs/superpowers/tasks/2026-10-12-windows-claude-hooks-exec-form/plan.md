# Windows Claude Hooks Exec Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On win32, every `ClaudePluginInstaller.install()` leaves the installed Claude `hooks.json` in exec form, rewriting it only when it differs.

**Architecture:** A pure generator in `src/utils/hook-command.ts`, applied through a no-op seam on `BaseExtensionInstaller` that only `ClaudePluginInstaller` overrides.

**Tech Stack:** TypeScript (ES modules, `.js` import extensions), Vitest `unit` project.

**Spec:** `docs/superpowers/tasks/2026-10-12-windows-claude-hooks-exec-form/spec.md`

## Global Constraints

- Commit per task using the repository's existing convention. Stage only the files the task names; never stage or edit `.claude/settings.json`.
- Installed paths: forward slashes, never quoted, no `${CLAUDE_PLUGIN_ROOT}`, no PATH lookup, no `.cmd`-shim or shell-string `node "…"` form.
- `install()` keeps its current `success` / `action`; a hooks-only rewrite reports `already_exists`.
- win32 is simulated with `vi.spyOn(process, 'platform' | 'execPath', 'get')` (`src/utils/__tests__/hook-command.test.ts:54-69`); expected paths are derived from test inputs.
- JSDoc at the depth of neighbouring members; no inline comments that narrate the change.

## Negative constraints

- No new read, write or warning for Gemini/Kimi (AC-5): the base seam in Task 2 does nothing and neither installer overrides it.
- No new write or content change for Claude on macOS/Linux (AC-4): Task 2's override returns before any `fs` call when not win32.
- `resolveCodemieBinary`, `resolveHookCommand`, `rewriteHooksCommandTree`, `buildDefaultHooks`, migration 006 unchanged: Task 1 only appends one export.
- A refresh failure must not reach the outer catch of `install()` (AC-6): Task 2's override has its own try/catch.
- `process.argv[1]` is not a path source: Task 2 resolves the script from `getDirname(import.meta.url)`.
- Bundled `hooks.json`, `plugin.json` (`1.0.28`), migrations and `getTargetPath()` are touched by no task.

## Review Focus

- `codemie-claude hook` stays shell-form — Task 1 test.
- Extra whitespace gives no empty `args` items — Task 1 test.
- Bare `codemie` gives `args: [scriptPath]` — Task 1 test.
- Installed file that is not valid JSON is rewritten — Task 2 test.
- Equal parsed value, different formatting: no write — Task 2 test.

---

### Task 1: Exec-form generator

Test-first: yes — `toExecFormHooks` is not exported from `hook-command.js`, so the new cases fail with "not a function".

**Files:**
- Modify: `src/utils/hook-command.ts` (append after line 129)
- Test: `src/utils/__tests__/hook-command.test.ts`

- [ ] **Step 1: Write the failing tests** in a new `describe('toExecFormHooks')`:
  - `codemie hook` with `timeout: 60` → `{ type, command: nodePath, args: [scriptPath, 'hook'], timeout: 60 }`; `codemie sound SessionStart` → `args: [scriptPath, 'sound', 'SessionStart']`.
  - Backslash inputs containing a space come out forward-slashed and unquoted in `command` and `args[0]`.
  - `echo hi` and `codemie-claude hook` entries, top-level `description` and the event structure deep-equal the input.
  - `codemie  hook ` → `args: [scriptPath, 'hook']`; `codemie` → `args: [scriptPath]`.
  - The input deep-equals a `structuredClone` taken before the call.
- [ ] **Step 2: Run** `npx vitest run src/utils/__tests__/hook-command.test.ts` — the new cases fail.
- [ ] **Step 3: Implement**, reusing the private `toForwardSlash` (`hook-command.ts:50-52`):

```ts
/**
 * Build a copy of a hooks structure in which every entry whose `command` starts with the
 * bare `codemie` token is in exec form: `command` is the node binary and `args` holds the
 * CLI script followed by the original arguments. Other values are copied unchanged.
 *
 * @param node - Hooks structure or any nested value
 * @param nodePath - Absolute path of the node executable
 * @param scriptPath - Absolute path of `bin/codemie.js`
 * @returns Deep copy with forward-slash, unquoted paths
 */
export function toExecFormHooks(node: unknown, nodePath: string, scriptPath: string): unknown {
  if (Array.isArray(node)) return node.map((item) => toExecFormHooks(item, nodePath, scriptPath));
  if (!node || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out[key] = toExecFormHooks(value, nodePath, scriptPath);
  }
  if (typeof out.command === 'string') {
    const [first, ...rest] = out.command.split(/\s+/).filter(Boolean);
    if (first === 'codemie') {
      out.command = toForwardSlash(nodePath);
      out.args = [toForwardSlash(scriptPath), ...rest];
    }
  }
  return out;
}
```

- [ ] **Step 4: Run** the same command — the whole file passes.

### Task 2: Per-install refresh in the Claude installer

Test-first: yes — under simulated win32 a second `install()` returning `already_exists` leaves the shell-form `hooks.json` in place, so the exec-form assertion fails.

**Files:**
- Modify: `src/agents/core/extension/BaseExtensionInstaller.ts` (new member beside `localizeInstalledHooks`, 520-537; one call after the branch ending at 700)
- Modify: `src/agents/plugins/claude/claude.plugin-installer.ts`
- Create: `src/agents/plugins/claude/__tests__/claude.plugin-installer.hooks.test.ts`
- Modify: `src/agents/plugins/claude/__tests__/plugin-installer.test.ts:35-39`

**Interfaces:**
- Consumes: `toExecFormHooks(node, nodePath, scriptPath)` from Task 1; `getDirname` (`src/utils/paths.ts:440`).

- [ ] **Step 1: Write the failing tests** in the new file (`plugin-installer.test.ts` automocks `fs/promises`). Harness: `src/agents/core/extension/__tests__/BaseExtensionInstaller.hooks.test.ts:15-65` plus the logger `vi.doMock` from `src/migrations/__tests__/006-resolve-hook-command-paths.migration.test.ts:33-35`. Source fixture `hooks.json`: `description`, `codemie hook` with `timeout: 60`, `codemie sound SessionStart`, `echo hi`. Subclass the dynamically imported `ClaudePluginInstaller`, overriding `getSourcePath`, `getTargetPath` and `getCodemieScriptPath` (a real temp file). `expected` = `toExecFormHooks(<fixture>, process.execPath, <script path>)` under the spies, `execPath` spied to a path containing a space. Cases:
  - win32, fresh install: `copied`; then bump the source manifest version: `updated`; installed file deep-equals `expected` both times (AC-1).
  - Install under `linux` (file holds `/abs/codemie hook`), then win32: `already_exists`, file deep-equals `expected` (AC-2).
  - win32, installed file is exec form with another node path: rewritten to `expected` (AC-2).
  - win32, installed file is compact `JSON.stringify(expected)`: raw bytes identical afterwards (AC-3).
  - win32, installed file is `not json`: rewritten to `expected`.
  - win32, `getCodemieScriptPath()` returns a missing path: `{ success: true, action: 'already_exists' }`, raw bytes unchanged, `logger.warn` called (AC-6).
  - `linux`, second `install()`: `already_exists`, raw bytes unchanged and still shell form (AC-4).
- [ ] **Step 2: Run** `npx vitest run src/agents/plugins/claude/__tests__/claude.plugin-installer.hooks.test.ts` — the win32 cases fail.
- [ ] **Step 3: Add the base seam** beside `localizeInstalledHooks` and call `await this.refreshInstalledHooks(targetPath);` once, after the if/else ending at line 700 and before the result object (702), so it runs for `copied`, `updated` and `already_exists` but not after the verification-failure return (686-695).

```ts
/**
 * Bring the installed hooks file in line with the current environment. Runs on every
 * successful install, including when the extension is already up to date. The default
 * does nothing; overrides must not throw.
 *
 * @param _targetPath - Installed extension directory
 */
protected refreshInstalledHooks(_targetPath: string): Promise<void> {
  return Promise.resolve();
}
```

- [ ] **Step 4: Override in `ClaudePluginInstaller`.** Add `protected getCodemieScriptPath(): string` returning `join(getDirname(import.meta.url), '../../../../bin/codemie.js')` (same depth as `src/cli/commands/proxy/daemon-manager.ts:102-104`) and `protected async refreshInstalledHooks(targetPath)`, which in this order:
  1. returns unless `process.platform === 'win32'`;
  2. in one try/catch: loads `toExecFormHooks` by dynamic `import()` as `BaseExtensionInstaller.ts:524` does, `access()`es the script path, reads and parses `join(this.getSourcePath(), 'hooks', 'hooks.json')`, builds `expected = toExecFormHooks(parsed, process.execPath, scriptPath)`;
  3. reads and parses `join(targetPath, 'hooks', 'hooks.json')`, a read or parse error meaning "different";
  4. writes `JSON.stringify(expected, null, 2)` only when `isDeepStrictEqual(installed, expected)` (`node:util`) is false;
  5. on an error from step 2 or 4 calls `logger.warn` with `this.agentName` and the message, worded like `BaseExtensionInstaller.ts:533-536`, and returns.
- [ ] **Step 5: Pin the platform in `plugin-installer.test.ts`.** In `beforeEach` (35-39), after `vi.resetAllMocks()`, add `vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')` so the order-sensitive `readFile` mocks (79-103, 146-177) describe one branch on both CI jobs; the existing `afterEach` restores it.
- [ ] **Step 6: Run** `npx vitest run src/agents/plugins/claude/__tests__ src/agents/core/extension/__tests__ src/agents/plugins/gemini/__tests__ tests/integration/sso-claude-plugin.test.ts` — all pass.
