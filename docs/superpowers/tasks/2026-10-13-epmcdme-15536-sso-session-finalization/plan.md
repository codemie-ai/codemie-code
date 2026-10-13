# EPMCDME-15536: Stale-Session Reconciliation Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing `reconcileStaleSessions` fallback utility into the six agent plugins that are missing it (`claude`, `gemini`, `kimi`, `codemie-code`, `opencode`, `copilot-cli`), so a session stuck `status: "active"` forever (no clean `SessionEnd`) gets finalized the next time that plugin starts a new session — exactly as already happens for `codex` and `pi`.

**Architecture:** Two mechanical patterns, both reusing `reconcileStaleSessions` from `src/agents/core/session/stale-session-reconciliation.ts` unmodified. Pattern A (`claude`, `gemini`, `kimi`): add a brand-new `onSessionStart` lifecycle method (these plugins have none today) that calls *only* `reconcileStaleSessions` — never `processEvent(SessionStart)`, since their native hook manifests already create the session record reliably. Pattern B (`codemie-code`, `opencode`, `copilot-cli`): insert one `reconcileStaleSessions` call into each plugin's existing `onSessionStart`, alongside its existing `processEvent(SessionStart)` call.

**Tech Stack:** TypeScript, Vitest 4.x (`vi.doMock`/dynamic-import or top-level `vi.mock`, per each file's existing convention).

**Spec:** `docs/superpowers/tasks/2026-10-13-epmcdme-15536-sso-session-finalization/spec.md`

## Global Constraints

- Never duplicate `processEvent({ hook_event_name: 'SessionStart', ... })` in `claude`/`gemini`/`kimi`'s new `onSessionStart` — their native hook manifests already create the session record via the shared `codemie hook` → `handleSessionStart` path. Duplicating it double-fires session creation.
- `reconcileStaleSessions` calls are always fire-and-forget: `void reconcileStaleSessions(...).catch((error) => logger.debug(...))` — never awaited, never allowed to throw into `onSessionStart`.
- Do not modify `src/agents/core/session/stale-session-reconciliation.ts`, `src/cli/commands/hook.ts`, or any native hook manifest/installer (`hooks.json`, Gemini's `eventNameMapping`, Kimi's `kimi.hook-config-injector.ts`).
- Rely on `reconcileStaleSessions`'s defaults (30 min inactivity threshold, 24h lookback) — no overrides.
- Do not touch `codex` or `pi`'s files; their existing tests must keep passing unmodified.

## Review Focus

- **Double session-creation for claude/gemini/kimi**: if a future edit accidentally adds `processEvent(SessionStart)` next to the new `reconcileStaleSessions` call, every session would be created twice. Tasks 1-3's tests assert `processEvent` (or an equivalent spy) is never called from the new `onSessionStart`.
- **Wrong `agentName` passed to `reconcileStaleSessions`**: passing the wrong string (e.g. `'codemie-claude'` instead of `'claude'`) means `findStaleSessions` never matches that plugin's own stranded sessions. Each task's test asserts the exact first argument.
- **Reconciliation failure crashing the agent launch**: a thrown/rejected `reconcileStaleSessions` call must never propagate past `onSessionStart`. Each task's test exercises a rejected promise and asserts `onSessionStart` still resolves.
- **Pattern B regression**: adding the new call to `codemie-code`/`opencode`/`copilot-cli` must not change the existing `processEvent(SessionStart)` call's behavior or ordering. Tasks 4-6 assert the existing call still fires with the same arguments it did before.
- **Codex/pi regression**: this fix touches no codex/pi files, but a broad find-and-replace mistake is possible given the repeated pattern. The final task runs the full existing codex/pi reconciliation test suites unmodified to confirm no collateral damage.

---

### Task 1: Claude plugin — new `onSessionStart` with reconciliation

**Files:**
- Modify: `src/agents/plugins/claude/claude.plugin.ts` (imports ~line 1-26; insert new `onSessionStart` into the `lifecycle` object between `beforeRun`'s closing `},` at line 551 and the `afterRun` comment at line 553)
- Test: `src/agents/plugins/claude/__tests__/claude.plugin.lifecycle.test.ts` (new file)

**Interfaces:**
- Consumes: `reconcileStaleSessions(agentName: string, env: NodeJS.ProcessEnv, buildHookConfig: (env, sessionId) => HookProcessingConfig, opts?: ReconcileOptions): Promise<{ reconciled: number; failed: number }>` from `../../core/session/stale-session-reconciliation.js`; `HookProcessingConfig` type from `../../../cli/commands/hook.js`.
- Produces: `ClaudePluginMetadata.lifecycle.onSessionStart(sessionId: string, env: NodeJS.ProcessEnv): Promise<void>` — new, no prior consumers.

- [x] **Step 1: Write the failing test**

```ts
// src/agents/plugins/claude/__tests__/claude.plugin.lifecycle.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

describe('ClaudePluginMetadata.lifecycle.onSessionStart — stale-session reconciliation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reconciles stale claude sessions on start', async () => {
    const reconcileStaleSessions = vi.fn().mockResolvedValue({ reconciled: 0, failed: 0 });
    vi.doMock('../../../core/session/stale-session-reconciliation.js', () => ({ reconcileStaleSessions }));

    const { ClaudePluginMetadata } = await import('../claude.plugin.js');
    const env: NodeJS.ProcessEnv = { CODEMIE_AGENT: 'claude', CODEMIE_PROVIDER: 'ai-run-sso' };

    await ClaudePluginMetadata.lifecycle!.onSessionStart!('sid-1', env);

    expect(reconcileStaleSessions).toHaveBeenCalledTimes(1);
    expect(reconcileStaleSessions.mock.calls[0][0]).toBe('claude');
    expect(reconcileStaleSessions.mock.calls[0][1]).toBe(env);
    expect(typeof reconcileStaleSessions.mock.calls[0][2]).toBe('function');
  });

  it('does not duplicate processEvent(SessionStart)', async () => {
    const reconcileStaleSessions = vi.fn().mockResolvedValue({ reconciled: 0, failed: 0 });
    vi.doMock('../../../core/session/stale-session-reconciliation.js', () => ({ reconcileStaleSessions }));
    const processEvent = vi.fn();
    vi.doMock('../../../../cli/commands/hook.js', () => ({ processEvent }));

    const { ClaudePluginMetadata } = await import('../claude.plugin.js');
    await ClaudePluginMetadata.lifecycle!.onSessionStart!('sid-2', { CODEMIE_AGENT: 'claude' });

    expect(processEvent).not.toHaveBeenCalled();
  });

  it('does not throw when reconciliation rejects', async () => {
    const reconcileStaleSessions = vi.fn().mockRejectedValue(new Error('boom'));
    vi.doMock('../../../core/session/stale-session-reconciliation.js', () => ({ reconcileStaleSessions }));

    const { ClaudePluginMetadata } = await import('../claude.plugin.js');

    await expect(
      ClaudePluginMetadata.lifecycle!.onSessionStart!('sid-3', { CODEMIE_AGENT: 'claude' })
    ).resolves.toBeUndefined();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/plugins/claude/__tests__/claude.plugin.lifecycle.test.ts`
Expected: FAIL — `ClaudePluginMetadata.lifecycle.onSessionStart` is `undefined`.

- [x] **Step 3: Implement `onSessionStart(sessionId: string, env: NodeJS.ProcessEnv): Promise<void>` in `src/agents/plugins/claude/claude.plugin.ts`**

Add the import alongside the existing imports at the top of the file:
```ts
import { reconcileStaleSessions } from '../../core/session/stale-session-reconciliation.js';
```

Add a local helper near the top of the file (module scope, same place `statuslineManagedThisSession` is declared), matching the exact shape `codex`/`pi`'s `buildHookConfig` use:
```ts
function buildClaudeHookConfig(env: NodeJS.ProcessEnv, sessionId: string): HookProcessingConfig {
  return {
    agentName: env.CODEMIE_AGENT || 'claude',
    sessionId,
    provider: env.CODEMIE_PROVIDER,
    apiBaseUrl: env.CODEMIE_BASE_URL,
    ssoUrl: env.CODEMIE_URL,
    syncApiUrl: env.CODEMIE_SYNC_API_URL,
    version: env.CODEMIE_CLI_VERSION,
    profileName: env.CODEMIE_PROFILE_NAME,
    project: env.CODEMIE_PROJECT,
    model: env.CODEMIE_MODEL,
    clientType: 'codemie-claude',
  };
}
```
(This needs `import type { HookProcessingConfig } from '../../../cli/commands/hook.js';` added to the type-only import block at the top.)

Insert the new method into the `lifecycle` object, right after `beforeRun`'s closing `},` (line 551) and before the `afterRun` comment (line 553):
```ts
async onSessionStart(sessionId: string, env: NodeJS.ProcessEnv) {
  // Claude's native hooks.json -> `codemie hook` -> handleSessionStart already
  // reliably creates the session record on every real launch, so this must
  // NOT also call processEvent(SessionStart) — only reconcile stranded ones.
  void reconcileStaleSessions('claude', env, buildClaudeHookConfig).catch((error) => {
    const msg = error instanceof Error ? error.message : String(error);
    logger.debug(`[claude] Stale-session reconciliation failed (non-blocking): ${msg}`);
  });
},
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/plugins/claude/__tests__/claude.plugin.lifecycle.test.ts`
Expected: PASS (3/3)

- [x] **Step 5: Commit**

```bash
git add src/agents/plugins/claude/claude.plugin.ts src/agents/plugins/claude/__tests__/claude.plugin.lifecycle.test.ts
git commit -m "fix(agents): reconcile stale claude sessions on SessionStart"
```

---

### Task 2: Gemini plugin — new `onSessionStart` with reconciliation

**Files:**
- Modify: `src/agents/plugins/gemini/gemini.plugin.ts` (imports ~line 1-8; insert new `onSessionStart` into the `lifecycle` object between `beforeRun`'s closing `}` at line 180 and `lifecycle`'s closing `}` at line 181)
- Test: `src/agents/plugins/gemini/__tests__/gemini.plugin.lifecycle.test.ts` (new file)

**Interfaces:**
- Consumes: same `reconcileStaleSessions` signature as Task 1.
- Produces: `GeminiPluginMetadata.lifecycle.onSessionStart(sessionId: string, env: NodeJS.ProcessEnv): Promise<void>`.

- [x] **Step 1: Write the failing test**

Mirror Task 1's three tests exactly (same assertions), adjusted for Gemini:
```ts
// src/agents/plugins/gemini/__tests__/gemini.plugin.lifecycle.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('GeminiPluginMetadata.lifecycle.onSessionStart — stale-session reconciliation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reconciles stale gemini sessions on start', async () => {
    const reconcileStaleSessions = vi.fn().mockResolvedValue({ reconciled: 0, failed: 0 });
    vi.doMock('../../../core/session/stale-session-reconciliation.js', () => ({ reconcileStaleSessions }));

    const { GeminiPluginMetadata } = await import('../gemini.plugin.js');
    const env: NodeJS.ProcessEnv = { CODEMIE_AGENT: 'gemini' };

    await GeminiPluginMetadata.lifecycle!.onSessionStart!('sid-1', env);

    expect(reconcileStaleSessions).toHaveBeenCalledTimes(1);
    expect(reconcileStaleSessions.mock.calls[0][0]).toBe('gemini');
    expect(reconcileStaleSessions.mock.calls[0][1]).toBe(env);
  });

  it('does not duplicate processEvent(SessionStart)', async () => {
    const reconcileStaleSessions = vi.fn().mockResolvedValue({ reconciled: 0, failed: 0 });
    vi.doMock('../../../core/session/stale-session-reconciliation.js', () => ({ reconcileStaleSessions }));
    const processEvent = vi.fn();
    vi.doMock('../../../../cli/commands/hook.js', () => ({ processEvent }));

    const { GeminiPluginMetadata } = await import('../gemini.plugin.js');
    await GeminiPluginMetadata.lifecycle!.onSessionStart!('sid-2', { CODEMIE_AGENT: 'gemini' });

    expect(processEvent).not.toHaveBeenCalled();
  });

  it('does not throw when reconciliation rejects', async () => {
    const reconcileStaleSessions = vi.fn().mockRejectedValue(new Error('boom'));
    vi.doMock('../../../core/session/stale-session-reconciliation.js', () => ({ reconcileStaleSessions }));

    const { GeminiPluginMetadata } = await import('../gemini.plugin.js');

    await expect(
      GeminiPluginMetadata.lifecycle!.onSessionStart!('sid-3', { CODEMIE_AGENT: 'gemini' })
    ).resolves.toBeUndefined();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/plugins/gemini/__tests__/gemini.plugin.lifecycle.test.ts`
Expected: FAIL — `onSessionStart` undefined.

- [x] **Step 3: Implement `onSessionStart` in `src/agents/plugins/gemini/gemini.plugin.ts`**

Add import: `import { reconcileStaleSessions } from '../../core/session/stale-session-reconciliation.js';` and `import type { HookProcessingConfig } from '../../../cli/commands/hook.js';` to the top import block.

Add a local `buildGeminiHookConfig(env, sessionId): HookProcessingConfig` helper with the same field shape as Task 1's (replace `clientType: 'codemie-claude'` with `clientType: 'codemie-gemini'`, default `agentName` to `'gemini'`), placed above `GeminiPluginMetadata`.

Insert into the `lifecycle` object, right after `beforeRun`'s closing `}` (line 180), adding a comma after it:
```ts
    },
    async onSessionStart(sessionId: string, env: NodeJS.ProcessEnv) {
      // Gemini's native SessionStart hook already routes through the shared
      // codemie-hook -> handleSessionStart path and creates the session
      // record reliably, so this must NOT also fire processEvent(SessionStart).
      void reconcileStaleSessions('gemini', env, buildGeminiHookConfig).catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        logger.debug(`[gemini] Stale-session reconciliation failed (non-blocking): ${msg}`);
      });
    }
```
(Note: `logger` is not currently imported in `gemini.plugin.ts` — add `import { logger } from '../../../utils/logger.js';` to the top import block.)

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/plugins/gemini/__tests__/gemini.plugin.lifecycle.test.ts`
Expected: PASS (3/3)

- [x] **Step 5: Commit**

```bash
git add src/agents/plugins/gemini/gemini.plugin.ts src/agents/plugins/gemini/__tests__/gemini.plugin.lifecycle.test.ts
git commit -m "fix(agents): reconcile stale gemini sessions on SessionStart"
```

---

### Task 3: Kimi plugin — new `onSessionStart` with reconciliation

**Files:**
- Modify: `src/agents/plugins/kimi/kimi.plugin.ts` (imports ~line 1-20; insert new `onSessionStart` into the `lifecycle` object, after `enrichArgs`'s closing `},` at line 87, before `lifecycle`'s closing `},` at line 88)
- Test: `src/agents/plugins/kimi/__tests__/kimi.plugin.lifecycle.test.ts` (new file; separate from the existing `kimi.plugin.test.ts` to avoid entangling with its native-installer mock)

**Interfaces:**
- Consumes: same `reconcileStaleSessions` signature as Task 1.
- Produces: `KimiPluginMetadata.lifecycle.onSessionStart(sessionId: string, env: NodeJS.ProcessEnv): Promise<void>`.

- [x] **Step 1: Write the failing test**

Mirror Task 1's three tests, adjusted for Kimi (agent name `'kimi'`, import path `../kimi.plugin.js`):
```ts
// src/agents/plugins/kimi/__tests__/kimi.plugin.lifecycle.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('KimiPluginMetadata.lifecycle.onSessionStart — stale-session reconciliation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reconciles stale kimi sessions on start', async () => {
    const reconcileStaleSessions = vi.fn().mockResolvedValue({ reconciled: 0, failed: 0 });
    vi.doMock('../../../core/session/stale-session-reconciliation.js', () => ({ reconcileStaleSessions }));

    const { KimiPluginMetadata } = await import('../kimi.plugin.js');
    const env: NodeJS.ProcessEnv = { CODEMIE_AGENT: 'kimi' };

    await KimiPluginMetadata.lifecycle!.onSessionStart!('sid-1', env);

    expect(reconcileStaleSessions).toHaveBeenCalledTimes(1);
    expect(reconcileStaleSessions.mock.calls[0][0]).toBe('kimi');
    expect(reconcileStaleSessions.mock.calls[0][1]).toBe(env);
  });

  it('does not duplicate processEvent(SessionStart)', async () => {
    const reconcileStaleSessions = vi.fn().mockResolvedValue({ reconciled: 0, failed: 0 });
    vi.doMock('../../../core/session/stale-session-reconciliation.js', () => ({ reconcileStaleSessions }));
    const processEvent = vi.fn();
    vi.doMock('../../../../cli/commands/hook.js', () => ({ processEvent }));

    const { KimiPluginMetadata } = await import('../kimi.plugin.js');
    await KimiPluginMetadata.lifecycle!.onSessionStart!('sid-2', { CODEMIE_AGENT: 'kimi' });

    expect(processEvent).not.toHaveBeenCalled();
  });

  it('does not throw when reconciliation rejects', async () => {
    const reconcileStaleSessions = vi.fn().mockRejectedValue(new Error('boom'));
    vi.doMock('../../../core/session/stale-session-reconciliation.js', () => ({ reconcileStaleSessions }));

    const { KimiPluginMetadata } = await import('../kimi.plugin.js');

    await expect(
      KimiPluginMetadata.lifecycle!.onSessionStart!('sid-3', { CODEMIE_AGENT: 'kimi' })
    ).resolves.toBeUndefined();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/plugins/kimi/__tests__/kimi.plugin.lifecycle.test.ts`
Expected: FAIL — `onSessionStart` undefined.

- [x] **Step 3: Implement `onSessionStart` in `src/agents/plugins/kimi/kimi.plugin.ts`**

Add import: `import { reconcileStaleSessions } from '../../core/session/stale-session-reconciliation.js';` and `import type { HookProcessingConfig } from '../../../cli/commands/hook.js';` to the top import block.

Add a local `buildKimiHookConfig(env, sessionId): HookProcessingConfig` helper, same shape as Task 1's (`clientType: 'codemie-kimi'`, default `agentName` to `'kimi'`), placed above the `lifecycle:` block.

Insert into the `lifecycle` object, right after `enrichArgs`'s closing `},` (line 87):
```ts
    },
    async onSessionStart(sessionId: string, env: NodeJS.ProcessEnv) {
      // Kimi's hook injector registers SessionStart against `codemie hook`,
      // which already creates the session record reliably — do NOT also
      // fire processEvent(SessionStart) here.
      void reconcileStaleSessions('kimi', env, buildKimiHookConfig).catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        logger.debug(`[kimi] Stale-session reconciliation failed (non-blocking): ${msg}`);
      });
    },
```
(`logger` is already imported in `kimi.plugin.ts` — reuse it.)

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/plugins/kimi/__tests__/kimi.plugin.lifecycle.test.ts`
Expected: PASS (3/3)

- [x] **Step 5: Commit**

```bash
git add src/agents/plugins/kimi/kimi.plugin.ts src/agents/plugins/kimi/__tests__/kimi.plugin.lifecycle.test.ts
git commit -m "fix(agents): reconcile stale kimi sessions on SessionStart"
```

---

### Task 4: codemie-code plugin — add reconciliation call to existing `onSessionStart`

**Files:**
- Modify: `src/agents/plugins/codemie-code.plugin.ts` (add import near top; insert one call inside the existing `onSessionStart`, lines ~229-245, after the existing `catch` block closes)
- Test: `src/agents/plugins/__tests__/codemie-code.plugin.lifecycle.test.ts` (new file, kept separate from the large `codemie-code-plugin.test.ts` to avoid its custom `BaseAgentAdapter` mock)

**Interfaces:**
- Consumes: same `reconcileStaleSessions` signature as Task 1; reuses the plugin's existing `buildHookConfig(env, sessionId)` (already defined at line 61) and `BUILTIN_AGENT_NAME` constant (`'codemie-code'`, line 25) — no new helper needed.
- Produces: no new public interface; `onSessionStart` behavior extends.

- [x] **Step 1: Write the failing test**

```ts
// src/agents/plugins/__tests__/codemie-code.plugin.lifecycle.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../core/BaseAgentAdapter.js', () => ({
  BaseAgentAdapter: class { metadata: any; constructor(metadata: any) { this.metadata = metadata; } },
}));

describe('CodeMieCodePluginMetadata.lifecycle.onSessionStart — stale-session reconciliation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reconciles stale codemie-code sessions on start, alongside the existing SessionStart call', async () => {
    const reconcileStaleSessions = vi.fn().mockResolvedValue({ reconciled: 0, failed: 0 });
    vi.doMock('../../core/session/stale-session-reconciliation.js', () => ({ reconcileStaleSessions }));
    const processEvent = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../cli/commands/hook.js', () => ({ processEvent }));

    const { CodeMieCodePluginMetadata } = await import('../codemie-code.plugin.js');
    const env: NodeJS.ProcessEnv = { CODEMIE_AGENT: 'codemie-code' };

    await CodeMieCodePluginMetadata.lifecycle!.onSessionStart!('sid-1', env);

    expect(processEvent).toHaveBeenCalledTimes(1);
    expect(reconcileStaleSessions).toHaveBeenCalledTimes(1);
    expect(reconcileStaleSessions.mock.calls[0][0]).toBe('codemie-code');
    expect(reconcileStaleSessions.mock.calls[0][1]).toBe(env);
  });

  it('does not throw when reconciliation rejects', async () => {
    const reconcileStaleSessions = vi.fn().mockRejectedValue(new Error('boom'));
    vi.doMock('../../core/session/stale-session-reconciliation.js', () => ({ reconcileStaleSessions }));
    vi.doMock('../../../cli/commands/hook.js', () => ({ processEvent: vi.fn().mockResolvedValue(undefined) }));

    const { CodeMieCodePluginMetadata } = await import('../codemie-code.plugin.js');

    await expect(
      CodeMieCodePluginMetadata.lifecycle!.onSessionStart!('sid-2', { CODEMIE_AGENT: 'codemie-code' })
    ).resolves.toBeUndefined();
  });
});
```

Confirm the exported metadata symbol name first: `grep -n "export const.*PluginMetadata" src/agents/plugins/codemie-code.plugin.ts`. Use whatever name that grep returns in place of `CodeMieCodePluginMetadata` above if different.

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/plugins/__tests__/codemie-code.plugin.lifecycle.test.ts`
Expected: FAIL — `reconcileStaleSessions` not called (only `processEvent` is).

- [x] **Step 3: Add the reconciliation call in `src/agents/plugins/codemie-code.plugin.ts`**

Add import: `import { reconcileStaleSessions } from '../core/session/stale-session-reconciliation.js';` (one `../` less than claude/gemini/kimi, since this file lives directly under `src/agents/plugins/`, not in a subdirectory).

Inside the existing `onSessionStart`, after the existing try/catch block for `processEvent` closes (after the `logger.error(...)` line and its closing `}`), add:
```ts
      void reconcileStaleSessions('codemie-code', env, buildHookConfig).catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        logger.debug(`[codemie-code] Stale-session reconciliation failed (non-blocking): ${msg}`);
      });
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/plugins/__tests__/codemie-code.plugin.lifecycle.test.ts`
Expected: PASS (2/2)

- [x] **Step 5: Commit**

```bash
git add src/agents/plugins/codemie-code.plugin.ts src/agents/plugins/__tests__/codemie-code.plugin.lifecycle.test.ts
git commit -m "fix(agents): reconcile stale codemie-code sessions on SessionStart"
```

---

### Task 5: OpenCode plugin — add reconciliation call to existing `onSessionStart`

**Files:**
- Modify: `src/agents/plugins/opencode/opencode.plugin.ts` (add import near top; insert one call inside the existing `onSessionStart`, after the existing `processEvent` try/catch, before `startOpenCodeIncrementalSync(...)`)
- Test: `src/agents/plugins/opencode/__tests__/opencode-session-lifecycle.test.ts` (extend existing file — it already mocks `processEvent`, `startOpenCodeIncrementalSync`, etc. via top-level `vi.mock`)

**Interfaces:**
- Consumes: same `reconcileStaleSessions` signature; reuses the existing `buildHookConfig(env, sessionId)` (line 79).
- Produces: no new public interface; `onSessionStart` behavior extends.

- [x] **Step 1: Write the failing test**

Add to `src/agents/plugins/opencode/__tests__/opencode-session-lifecycle.test.ts`, inside the existing top-level mocks (add one more `vi.mock` call before the `const { OpenCodePluginMetadata } = await import(...)` line):
```ts
const reconcileStaleSessions = vi.fn().mockResolvedValue({ reconciled: 0, failed: 0 });
vi.mock('../../../core/session/stale-session-reconciliation.js', () => ({ reconcileStaleSessions }));
```
And add a new test inside the existing `describe('OpenCode onSessionStart', ...)` block:
```ts
  it('reconciles stale opencode sessions on start', async () => {
    const env = baseEnv();

    await OpenCodePluginMetadata.lifecycle!.onSessionStart!('codemie-uuid-1', env);

    expect(reconcileStaleSessions).toHaveBeenCalledTimes(1);
    expect(reconcileStaleSessions.mock.calls[0][0]).toBe('opencode');
    expect(reconcileStaleSessions.mock.calls[0][1]).toBe(env);
  });

  it('does not throw when reconciliation rejects', async () => {
    reconcileStaleSessions.mockRejectedValueOnce(new Error('boom'));

    await expect(
      OpenCodePluginMetadata.lifecycle!.onSessionStart!('codemie-uuid-1', baseEnv())
    ).resolves.toBeUndefined();
  });
```
Also reset `reconcileStaleSessions` in the existing `beforeEach`/`afterEach` `vi.clearAllMocks()` calls (already present — no change needed there).

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/plugins/opencode/__tests__/opencode-session-lifecycle.test.ts`
Expected: FAIL — `reconcileStaleSessions` not called.

- [x] **Step 3: Add the reconciliation call in `src/agents/plugins/opencode/opencode.plugin.ts`**

Add import: `import { reconcileStaleSessions } from '../../core/session/stale-session-reconciliation.js';`

Inside the existing `onSessionStart`, after the `processEvent` try/catch block closes and before the `startOpenCodeIncrementalSync({...})` call, add:
```ts
      void reconcileStaleSessions('opencode', env, buildHookConfig).catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        logger.debug(`[opencode] Stale-session reconciliation failed (non-blocking): ${msg}`);
      });
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/plugins/opencode/__tests__/opencode-session-lifecycle.test.ts`
Expected: PASS (all tests in file, including the 2 new ones)

- [x] **Step 5: Commit**

```bash
git add src/agents/plugins/opencode/opencode.plugin.ts src/agents/plugins/opencode/__tests__/opencode-session-lifecycle.test.ts
git commit -m "fix(agents): reconcile stale opencode sessions on SessionStart"
```

---

### Task 6: Copilot CLI plugin — add reconciliation call to existing `onSessionStart`

**Files:**
- Modify: `src/agents/plugins/copilot-cli/copilot-cli.plugin.ts` (add import near top; insert one call inside the existing `onSessionStart`, lines ~154-172, after the existing try/catch closes)
- Test: `src/agents/plugins/copilot-cli/__tests__/copilot-cli.plugin.lifecycle.test.ts` (new file — no existing lifecycle test file for this plugin)

**Interfaces:**
- Consumes: same `reconcileStaleSessions` signature; reuses the existing `buildCopilotHookConfig(env, sessionId)` and `COPILOT_CLI_AGENT_NAME` constant (`'copilot-cli'`, from `./copilot-cli.constants.js`).
- Produces: no new public interface; `onSessionStart` behavior extends.

- [x] **Step 1: Write the failing test**

```ts
// src/agents/plugins/copilot-cli/__tests__/copilot-cli.plugin.lifecycle.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('CopilotCliPluginMetadata.lifecycle.onSessionStart — stale-session reconciliation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reconciles stale copilot-cli sessions on start, alongside the existing SessionStart call', async () => {
    const reconcileStaleSessions = vi.fn().mockResolvedValue({ reconciled: 0, failed: 0 });
    vi.doMock('../../../core/session/stale-session-reconciliation.js', () => ({ reconcileStaleSessions }));
    const processEvent = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../../cli/commands/hook.js', () => ({ processEvent }));

    const { CopilotCliPluginMetadata } = await import('../copilot-cli.plugin.js');
    const env: NodeJS.ProcessEnv = { CODEMIE_AGENT: 'copilot-cli' };

    await CopilotCliPluginMetadata.lifecycle!.onSessionStart!('sid-1', env);

    expect(processEvent).toHaveBeenCalledTimes(1);
    expect(reconcileStaleSessions).toHaveBeenCalledTimes(1);
    expect(reconcileStaleSessions.mock.calls[0][0]).toBe('copilot-cli');
    expect(reconcileStaleSessions.mock.calls[0][1]).toBe(env);
  });

  it('does not throw when reconciliation rejects', async () => {
    const reconcileStaleSessions = vi.fn().mockRejectedValue(new Error('boom'));
    vi.doMock('../../../core/session/stale-session-reconciliation.js', () => ({ reconcileStaleSessions }));
    vi.doMock('../../../../cli/commands/hook.js', () => ({ processEvent: vi.fn().mockResolvedValue(undefined) }));

    const { CopilotCliPluginMetadata } = await import('../copilot-cli.plugin.js');

    await expect(
      CopilotCliPluginMetadata.lifecycle!.onSessionStart!('sid-2', { CODEMIE_AGENT: 'copilot-cli' })
    ).resolves.toBeUndefined();
  });
});
```

Confirm the exported metadata symbol name first: `grep -n "export const.*PluginMetadata" src/agents/plugins/copilot-cli/copilot-cli.plugin.ts`. Use whatever name that grep returns in place of `CopilotCliPluginMetadata` above if different. If `beforeRun`'s `assertCopilotProviderSupported(config)` or other setup causes an import-time error under this minimal env, add the minimum additional mocks needed (follow the pattern in `copilot-cli.discovery.test.ts` for what else this plugin module needs mocked at import time).

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/plugins/copilot-cli/__tests__/copilot-cli.plugin.lifecycle.test.ts`
Expected: FAIL — `reconcileStaleSessions` not called.

- [x] **Step 3: Add the reconciliation call in `src/agents/plugins/copilot-cli/copilot-cli.plugin.ts`**

Add import: `import { reconcileStaleSessions } from '../../core/session/stale-session-reconciliation.js';`

Inside the existing `onSessionStart`, after the existing try/catch block for `processEvent` closes, add:
```ts
      void reconcileStaleSessions('copilot-cli', env, buildCopilotHookConfig).catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        logger.debug(`[copilot-cli] Stale-session reconciliation failed (non-blocking): ${msg}`);
      });
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/plugins/copilot-cli/__tests__/copilot-cli.plugin.lifecycle.test.ts`
Expected: PASS (2/2)

- [x] **Step 5: Commit**

```bash
git add src/agents/plugins/copilot-cli/copilot-cli.plugin.ts src/agents/plugins/copilot-cli/__tests__/copilot-cli.plugin.lifecycle.test.ts
git commit -m "fix(agents): reconcile stale copilot-cli sessions on SessionStart"
```

---

### Task 7: Full regression pass

**Files:** none modified — verification only.

**Interfaces:** none.

- [x] **Step 1: Run the full unit test project**

Run: `npx vitest run --project unit`
Expected: PASS — all pre-existing tests (including `src/agents/plugins/codex/__tests__/codex.reconciliation.test.ts`, `src/agents/plugins/codex/__tests__/codex.plugin.lifecycle.test.ts`, and every test touched/added in Tasks 1-6) pass with zero failures.

- [x] **Step 2: Confirm no `codex`/`pi` files, and no shared-infrastructure files, changed**

Run: `git diff --name-only origin/main...HEAD | grep -E 'codex|pi\.plugin|stale-session-reconciliation\.ts|cli/commands/hook\.ts|hooks\.json|hook-config-injector|hook-transformer'`
Expected: empty output (no matches) — confirms this fix touched zero codex/pi files and none of `stale-session-reconciliation.ts`, `hook.ts`, or any native hook manifest/injector/transformer, per the spec's "Reused, unmodified" section.

- [x] **Step 3: Commit (only if Step 1 required fix-up changes; otherwise skip — nothing to commit)**

```bash
git add -A
git commit -m "test(agents): confirm full regression pass for stale-session reconciliation wiring"
```
