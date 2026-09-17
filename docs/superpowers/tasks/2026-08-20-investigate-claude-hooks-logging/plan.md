# Test-log isolation + visible hook-failure warnings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the test suite from polluting `~/.codemie/logs/`, and make real hook-execution and plugin-hooks-config failures visible to a user's terminal by default (not just under `CODEMIE_DEBUG`).

**Architecture:** Two independent, additive changes: (A) point `CODEMIE_HOME` at an OS-temp-dir path in all three `vitest.config.ts` project `env` blocks, relying on `getCodemieHome()`/`Logger.initializeLogFile()` already resolving lazily at call time; (B) add one new `Logger.notice()` method (file write always + unconditional console print, distinct from `error()`/`warn()`) and wire it into exactly two existing catch blocks (`HookExecutor.executeSingleHook`, `loadPluginHooks`), replacing their current `logger.error`/`logger.debug` calls. No other logger call sites, hook semantics, or result shapes change.

**Tech Stack:** TypeScript, Vitest, Node `fs`/`os`/`path`, existing `chalk`-based console formatting in `src/utils/logger.ts`.

**Spec:** `docs/superpowers/tasks/2026-08-20-investigate-claude-hooks-logging/spec.md`

## Global Constraints

- `HookExecutor`'s fail-open decision (`allow`) and `AggregatedHookResult`/`HookResult` shapes must not change (spec Non-goals).
- Do not touch `src/mcp/proxy-logger.ts` or `MCP_PROXY_DEBUG`/`CODEMIE_DEBUG` gating logic elsewhere.
- Do not adopt `createErrorContext`/`formatErrorForLog` in the hooks path.
- No console-visibility change for `logger.info()`/`logger.warn()`/`logger.debug()`, or for any logger caller other than the two named hook call sites.
- No refactor of `hook.ts`, `HookExecutor`'s dedup/parallel logic, `HookMatcher`, or `DecisionParser`.
- No new log-verbosity configuration surface beyond the existing `CODEMIE_DEBUG` switch.
- All file-logged args must continue to pass through `sanitizeLogArgs()` (inherited automatically by routing `notice()` through the existing `writeToLogFile()`).
- Commit per task using the repository's existing convention.

---

### Task 1: Isolate test-suite logging via `CODEMIE_HOME`

**Files:**
- Modify: `vitest.config.ts:1-91`
- Test: `src/utils/__tests__/vitest-codemie-home-isolation.test.ts` (new)

**Interfaces:**
- Consumes: `getCodemieHome()` (`src/utils/paths.ts:356`), `logger.getLogFilePath()` (`src/utils/logger.ts:273`) — both already exist, unchanged.
- Produces: nothing new consumed by later tasks; this task is independent of Tasks 2-4.

Test-first: yes — failing test asserting `CODEMIE_HOME`/the logger's resolved log path fall under the OS temp dir during a test run, which fails today because `vitest.config.ts` never sets `CODEMIE_HOME`.

- [ ] **Step 1: Write the failing test**

```ts
// src/utils/__tests__/vitest-codemie-home-isolation.test.ts
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'os';
import { logger } from '../logger.js';
import { getCodemieHome } from '../paths.js';

describe('vitest CODEMIE_HOME isolation', () => {
  it('resolves CODEMIE_HOME and the logger file path under the OS temp dir', () => {
    expect(process.env.CODEMIE_HOME).toBeDefined();
    expect(getCodemieHome().startsWith(tmpdir())).toBe(true);

    const logPath = logger.getLogFilePath();
    expect(logPath).not.toBeNull();
    expect(logPath!.startsWith(tmpdir())).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit src/utils/__tests__/vitest-codemie-home-isolation.test.ts`
Expected: FAIL — `process.env.CODEMIE_HOME` is `undefined`.

- [ ] **Step 3: Set `CODEMIE_HOME` in all three vitest projects**

At the top of `vitest.config.ts` (after the existing imports), add:

```ts
import { tmpdir } from 'os';
import { join } from 'path';

const testCodemieHome = join(tmpdir(), 'codemie-test-home');
```

Add `CODEMIE_HOME: testCodemieHome,` alongside the existing `FORCE_COLOR`/`NODE_ENV` entries in each of the three `env` blocks: the `unit` project (`vitest.config.ts:23-26`), the `cli` project (`:58-61`), and the `agent` project (`:80-83`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit src/utils/__tests__/vitest-codemie-home-isolation.test.ts`
Expected: PASS

- [ ] **Step 5: Confirm the existing per-test override still passes unmodified**

Run: `npx vitest run --project agent src/agents/plugins/codex/__tests__/codex.reconciliation.test.ts`
Expected: PASS — its own `mkdtemp` + `process.env.CODEMIE_HOME` save/restore in `beforeEach`/`afterEach` (`codex.reconciliation.test.ts:40-53`) narrows isolation further per test file and is unaffected by the config-level default.

- [ ] **Step 6: Commit**

---

### Task 2: Add `Logger.notice()` — always-visible console warning + file log

**Files:**
- Modify: `src/utils/logger.ts:314-344` (add new method after `error()`)
- Test: `src/utils/__tests__/logger-notice.test.ts` (new)

**Interfaces:**
- Consumes: `Logger.writeToLogFile(level: string, message: string, ...args: unknown[]): void` (private, existing, `logger.ts:167`), `Logger.getLogFilePath(): string | null` (existing, `logger.ts:273`), `chalk` (existing import).
- Produces: `logger.notice(message: string, ...args: unknown[]): void` — new public method on the exported `logger` singleton. Always writes to the file log via the existing `writeToLogFile('notice', message, ...args)` path (inheriting `sanitizeLogArgs()` for free); always prints a `⚠`-prefixed, `chalk.yellow` line to the console via `console.warn`, regardless of `isDebugMode()`, followed by a pointer to `getLogFilePath()` when available. No stack trace is ever printed to console. Tasks 3 and 4 call this method; no other change to `Logger`'s public surface.

Test-first: yes — failing tests asserting (a) `logger.notice()` prints to console even when `CODEMIE_DEBUG` is unset, and (b) it always writes an entry to the file log — both fail today because `notice()` does not exist.

- [ ] **Step 1: Write the failing tests**

```ts
// src/utils/__tests__/logger-notice.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile } from 'fs/promises';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { logger } from '../logger.js';

const ORIGINAL_CODEMIE_HOME = process.env.CODEMIE_HOME;
const ORIGINAL_DEBUG = process.env.CODEMIE_DEBUG;

async function waitForLogContent(logPath: string, marker: string, timeoutMs = 2000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const contents = await readFile(logPath, 'utf-8').catch(() => '');
    if (contents.includes(marker)) return contents;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Log file did not contain marker "${marker}" within ${timeoutMs}ms`);
}

describe('Logger.notice', () => {
  beforeEach(async () => {
    process.env.CODEMIE_HOME = await mkdtemp(join(tmpdir(), 'codemie-logger-notice-'));
    delete process.env.CODEMIE_DEBUG;
  });

  afterEach(() => {
    if (ORIGINAL_CODEMIE_HOME === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = ORIGINAL_CODEMIE_HOME;
    if (ORIGINAL_DEBUG === undefined) delete process.env.CODEMIE_DEBUG;
    else process.env.CODEMIE_DEBUG = ORIGINAL_DEBUG;
    vi.restoreAllMocks();
  });

  it('prints a ⚠ warning to console even when CODEMIE_DEBUG is unset', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logger.notice('hook failed: boom');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('⚠');
    expect(warnSpy.mock.calls[0][0]).toContain('hook failed: boom');
  });

  it('always writes an entry to the file log', async () => {
    logger.notice('plugin hooks.json malformed');
    const logPath = logger.getLogFilePath();
    expect(logPath).not.toBeNull();
    const contents = await waitForLogContent(logPath!, 'plugin hooks.json malformed');
    expect(contents).toContain('[NOTICE]');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit src/utils/__tests__/logger-notice.test.ts`
Expected: FAIL — `logger.notice is not a function`.

- [ ] **Step 3: Implement `Logger.notice()`**

Add immediately after the `error()` method (`src/utils/logger.ts:344`, before the closing `}` of the `Logger` class):

```ts
  notice(message: string, ...args: unknown[]): void {
    // Always write to log file
    this.writeToLogFile('notice', message, ...args);

    // Always print to console, regardless of debug mode — this is the one
    // logger level meant to surface real failures to a normal terminal run.
    const logPath = this.getLogFilePath();
    const suffix = logPath ? ` (see ${logPath})` : '';
    console.warn(chalk.yellow(`⚠ ${message}${suffix}`));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit src/utils/__tests__/logger-notice.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

---

### Task 3: Surface `HookExecutor` failures via `logger.notice()`

**Files:**
- Modify: `src/hooks/executor.ts:397-404`
- Test: `src/hooks/__tests__/executor.test.ts` (extend existing file)

**Interfaces:**
- Consumes: `logger.notice(message: string, ...args: unknown[]): void` (Task 2).
- Produces: no new exports; `executeSingleHook`'s return shape (`HookResult`, `decision: 'allow'`) is unchanged — only the log call inside the existing `catch` block changes.

Test-first: yes — failing test asserting that when a hook throws, `console.warn` is called with a `⚠`-prefixed message even without `CODEMIE_DEBUG` set, while the fail-open `decision: 'allow'` behavior (already covered by the existing "should handle SessionStart hook failure gracefully" test at `executor.test.ts:89-113`) is preserved.

- [ ] **Step 1: Write the failing test**

Add a new `it` block inside the existing `describe('executeSessionStart', ...)` block in `src/hooks/__tests__/executor.test.ts`, alongside the existing failure test at line 89:

```ts
		it('should print a visible notice when a hook fails, without requiring CODEMIE_DEBUG', async () => {
			delete process.env.CODEMIE_DEBUG;
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			const config: HooksConfiguration = {
				SessionStart: [
					{
						hooks: [{ type: 'command', command: '/test/hook.sh' }],
					},
				],
			};

			execSpy.mockRejectedValue(new Error('Hook script not found'));

			const executor = new HookExecutor(config, mockContext);
			const result = await executor.executeSessionStart();

			expect(result.decision).toBe('allow');
			expect(warnSpy).toHaveBeenCalled();
			expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('⚠'))).toBe(true);
		});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit src/hooks/__tests__/executor.test.ts -t "should print a visible notice"`
Expected: FAIL — `warnSpy` was never called (the catch block still calls `logger.error`, whose console half is gated behind `isDebugMode()`).

- [ ] **Step 3: Replace `logger.error` with `logger.notice` in the catch block**

In `src/hooks/executor.ts:397-404`, change the single line `logger.error(\`Hook execution failed: ${error}\`);` to `logger.notice(\`Hook execution failed: ${error}\`);`. Nothing else in the `catch` block (the fail-open `return`) changes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit src/hooks/__tests__/executor.test.ts`
Expected: PASS (both the new test and the pre-existing fail-open test at line 89).

- [ ] **Step 5: Commit**

---

### Task 4: Surface malformed plugin `hooks.json` via `logger.notice()`

**Files:**
- Modify: `src/plugins/loaders/hooks-loader.ts:46-50`
- Test: `src/plugins/loaders/__tests__/hooks-loader.test.ts` (new — first test file in this directory)

**Interfaces:**
- Consumes: `logger.notice(message: string, ...args: unknown[]): void` (Task 2); `loadPluginHooks(pluginDir: string, manifest: PluginManifest): Promise<HooksConfiguration | null>` (existing, unchanged signature/return).
- Produces: no new exports; only the log call inside `loadPluginHooks`'s `catch` block changes.

Test-first: yes — failing test asserting that a malformed `hooks/hooks.json` under a plugin directory produces a console `⚠` notice (instead of the current debug-only, invisible-by-default log line) while `loadPluginHooks` still resolves to `null`.

- [ ] **Step 1: Write the failing test**

```ts
// src/plugins/loaders/__tests__/hooks-loader.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadPluginHooks } from '../hooks-loader.js';
import type { PluginManifest } from '../../core/types.js';

describe('loadPluginHooks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints a visible notice and returns null for a malformed hooks.json', async () => {
    const pluginDir = await mkdtemp(join(tmpdir(), 'codemie-plugin-hooks-'));
    await mkdir(join(pluginDir, 'hooks'), { recursive: true });
    await writeFile(join(pluginDir, 'hooks', 'hooks.json'), '{ this is not valid json');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manifest: PluginManifest = { name: 'test-plugin' };

    const result = await loadPluginHooks(pluginDir, manifest);

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('⚠'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit src/plugins/loaders/__tests__/hooks-loader.test.ts`
Expected: FAIL — `warnSpy` was never called (the catch block still calls `logger.debug`, which never prints to console).

- [ ] **Step 3: Replace `logger.debug` with `logger.notice` in the catch block**

In `src/plugins/loaders/hooks-loader.ts:46-50`, change the `logger.debug(...)` call to `logger.notice(...)`, keeping the same message content (`` `[plugin] Failed to parse hooks from ${hooksPath}: ${error instanceof Error ? error.message : String(error)}` ``).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit src/plugins/loaders/__tests__/hooks-loader.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

---

## Self-Review Notes

**Spec coverage:**
- Test-log pollution / `CODEMIE_HOME` isolation → Task 1.
- Existing per-test `CODEMIE_HOME` overrides keep passing → Task 1, Step 5.
- New `Logger` notice level (file always, console always, distinct symbol/color, no stack trace, points to `getLogFilePath()`) → Task 2.
- `HookExecutor.executeSingleHook` wired to the new method, fail-open unchanged → Task 3.
- `loadPluginHooks` wired to the new method → Task 4.
- Characterization/regression tests for all three behaviors + the `CODEMIE_HOME` smoke test → Tasks 1-4, each Step 1.
- Sanitization preserved → Task 2's `notice()` routes through the existing `writeToLogFile()`, which already calls `sanitizeLogArgs()`; no parallel implementation introduced.

**Negative-constraint pass:**
- Fail-open semantics / `AggregatedHookResult`/`HookResult` shape: Task 3 changes only the log call inside the existing `catch`, verified unchanged by asserting `result.decision === 'allow'` in both the pre-existing and new tests — no task alters `DecisionParser.merge`, `createEmptyResult`, or the returned shape.
- `src/mcp/proxy-logger.ts` / `MCP_PROXY_DEBUG`: not referenced by any task.
- `createErrorContext`/`formatErrorForLog`: not used by Task 2's `notice()`, which stays consistent with the existing `writeToLogFile`/plain-string convention already used by `error()`/`warn()`/`debug()` in this file.
- Console-visibility for `logger.info()`/`warn()`/`debug()`: untouched — `warn()` and `debug()` keep their current bodies; only `executor.ts:399` and `hooks-loader.ts:47` are edited, and both replace a call with `logger.notice(...)`, not a change to `warn()`/`debug()` themselves.
- No refactor of `hook.ts`, `HookExecutor` dedup/parallel logic, `HookMatcher`, `DecisionParser`: none of the four tasks touch those files/methods beyond the one-line swap in `executeSingleHook`'s catch block.
- No new log-verbosity config surface: Task 2 adds a method, not an env var or config flag; `isDebugMode()`/`CODEMIE_DEBUG` semantics for every other level are unchanged.
- No correlation against `~/.codemie/sessions/*.json`: no task reads or references `SessionStore` or session files.

**Type consistency:** `logger.notice(message: string, ...args: unknown[]): void` is defined once in Task 2 and called with that exact signature (single string argument) in Tasks 3 and 4; `loadPluginHooks(pluginDir: string, manifest: PluginManifest): Promise<HooksConfiguration | null>` keeps its existing signature and return type used by Task 4's test.
