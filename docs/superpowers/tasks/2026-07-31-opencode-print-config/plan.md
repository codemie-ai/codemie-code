# --print-config for codemie-opencode Implementation Plan

> **For agentic workers:** this plan is executed inline by `sdlc-standard` Stage 5 (TDD in the current session, no subagent dispatch). If resuming outside that flow, use superpowers:executing-plans task-by-task.

**Goal:** Add a `--print-config` flag to `codemie-opencode` that prints the real generated opencode config (redacted) to stdout and exits without spawning opencode.

**Architecture:** Reuse the existing `env.OPENCODE_CONFIG_CONTENT` / `env.OPENCODE_CONFIG` channel that `opencode.plugin.ts`'s `beforeRun` already populates. `BaseAgentAdapter.run()` gains an optional third `{ dryRun }` argument; when set, it runs the pipeline through `executeBeforeRun` unchanged (real config, real network call), then reads the config back out of `env`, redacts secrets, prints it, and returns before `spawn()`. `AgentCLI.ts` declares the flag, guards it to the opencode agent only, and reuses the existing "auto-silent" mechanism (`setSilentMode`) so no interactive prompts or banners pollute stdout.

**Tech Stack:** TypeScript, Commander.js, Vitest.

## Global Constraints

- Node.js >= 20, ES modules, all relative imports use the `.js` extension (per `AGENTS.md`).
- No `any` in new code; explicit return types on exported functions.
- `spawn` is imported directly from `child_process` in `BaseAgentAdapter.ts` today (not the project's `exec()` helper) — this plan follows that existing precedent, not `processes.ts`.
- Tests are included for this task (explicit user request — overrides the repo's default "tests only on explicit request" policy for this task only).
- Test files live in `__tests__/` subdirectories next to the code they cover, matching existing layout (`src/agents/core/__tests__/*.test.ts`).

---

## File Structure

- **Create** `src/agents/core/config-redaction.ts` — `redactSecrets(value: unknown): unknown`. Pure, recursive, single responsibility: mask values of keys matching `/apikey|token|secret|authorization/i` anywhere in a JSON-like structure.
- **Create** `src/agents/core/__tests__/config-redaction.test.ts`.
- **Create** `src/agents/core/print-config.ts` — `extractGeneratedConfig(env: NodeJS.ProcessEnv): unknown`. Reads `env.OPENCODE_CONFIG_CONTENT` (parse) or falls back to reading+parsing the file at `env.OPENCODE_CONFIG`; throws a descriptive error if neither is set.
- **Create** `src/agents/core/__tests__/print-config.test.ts`.
- **Modify** `src/agents/core/types.ts` — `AgentAdapter.run()` signature gains an optional third parameter.
- **Modify** `src/agents/core/BaseAgentAdapter.ts` — `run()` signature + dry-run short-circuit after `executeBeforeRun`.
- **Modify** `src/agents/core/__tests__/BaseAgentAdapter.test.ts` — add a `dry-run print-config` describe block.
- **Modify** `src/agents/core/AgentCLI.ts` — declare `--print-config`, extend the silent-mode auto-detection, guard to opencode only, forward `dryRun` to `adapter.run()`.
- **Create** `src/agents/core/__tests__/AgentCLI-print-config.test.ts`.
- **Create** `tests/integration/opencode/print-config.test.ts` — exercises the real `opencode.plugin.ts` `beforeRun` output through the real `extractGeneratedConfig` + `redactSecrets`.

---

### Task 1: `redactSecrets` utility

**Files:**
- Create: `src/agents/core/config-redaction.ts`
- Test: `src/agents/core/__tests__/config-redaction.test.ts`

**Interfaces:**
- Produces: `redactSecrets(value: unknown): unknown` — later tasks import this from `../config-redaction.js`.

**Test-first: yes — a test asserting `apiKey`/`headers.Authorization`-style keys come back masked while other keys are untouched.**

- [ ] **Step 1: Write the failing test**

```typescript
// src/agents/core/__tests__/config-redaction.test.ts
import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../config-redaction.js';

describe('redactSecrets', () => {
  it('masks top-level keys matching apiKey/token/secret/authorization (case-insensitive)', () => {
    const input = {
      apiKey: 'proxy-handled',
      ApiKey: 'another-value',
      token: 'abc123',
      secret: 'shh',
      Authorization: 'Bearer xyz',
      model: 'gpt-5',
    };

    expect(redactSecrets(input)).toEqual({
      apiKey: '***REDACTED***',
      ApiKey: '***REDACTED***',
      token: '***REDACTED***',
      secret: '***REDACTED***',
      Authorization: '***REDACTED***',
      model: 'gpt-5',
    });
  });

  it('masks matching keys nested inside a headers object without touching sibling keys', () => {
    const input = {
      provider: {
        'codemie-proxy': {
          options: {
            baseURL: 'https://example.invalid/',
            apiKey: 'proxy-handled',
            headers: { Authorization: 'Bearer real-token', 'X-Trace-Id': 'trace-1' },
          },
        },
      },
    };

    expect(redactSecrets(input)).toEqual({
      provider: {
        'codemie-proxy': {
          options: {
            baseURL: 'https://example.invalid/',
            apiKey: '***REDACTED***',
            headers: { Authorization: '***REDACTED***', 'X-Trace-Id': 'trace-1' },
          },
        },
      },
    });
  });

  it('recurses into arrays without mutating the input', () => {
    const input = [{ apiKey: 'a' }, { apiKey: 'b' }];
    const result = redactSecrets(input);
    expect(result).toEqual([{ apiKey: '***REDACTED***' }, { apiKey: '***REDACTED***' }]);
    expect(input).toEqual([{ apiKey: 'a' }, { apiKey: 'b' }]); // original untouched
  });

  it('passes through primitives unchanged', () => {
    expect(redactSecrets('hello')).toBe('hello');
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets(undefined)).toBe(undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/core/__tests__/config-redaction.test.ts`
Expected: FAIL — `Cannot find module '../config-redaction.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/agents/core/config-redaction.ts

const SECRET_KEY_PATTERN = /apikey|token|secret|authorization/i;

/**
 * Recursively redacts values whose object key matches a secret-like name
 * (apiKey, token, secret, authorization — case-insensitive), at any depth.
 * Does not mutate the input.
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SECRET_KEY_PATTERN.test(key) ? '***REDACTED***' : redactSecrets(val);
    }
    return result;
  }

  return value;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/core/__tests__/config-redaction.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agents/core/config-redaction.ts src/agents/core/__tests__/config-redaction.test.ts
git commit -m "feat(agents): add redactSecrets config-redaction utility"
```

---

### Task 2: `extractGeneratedConfig` utility

**Files:**
- Create: `src/agents/core/print-config.ts`
- Test: `src/agents/core/__tests__/print-config.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `extractGeneratedConfig(env: NodeJS.ProcessEnv): unknown` — later tasks import this from `../print-config.js`.

**Test-first: yes — tests for the inline-JSON path, the temp-file path, and the "neither set" error path.**

- [ ] **Step 1: Write the failing test**

```typescript
// src/agents/core/__tests__/print-config.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { extractGeneratedConfig } from '../print-config.js';

describe('extractGeneratedConfig', () => {
  const tempFiles: string[] = [];

  afterEach(() => {
    while (tempFiles.length) {
      const f = tempFiles.pop();
      if (f) {
        try { unlinkSync(f); } catch { /* already removed */ }
      }
    }
  });

  it('parses env.OPENCODE_CONFIG_CONTENT when present', () => {
    const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'gpt-5' }) } as NodeJS.ProcessEnv;
    expect(extractGeneratedConfig(env)).toEqual({ model: 'gpt-5' });
  });

  it('reads and parses the file at env.OPENCODE_CONFIG when CONTENT is absent', () => {
    const path = join(tmpdir(), `print-config-test-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify({ model: 'from-file' }), 'utf-8');
    tempFiles.push(path);

    const env = { OPENCODE_CONFIG: path } as NodeJS.ProcessEnv;
    expect(extractGeneratedConfig(env)).toEqual({ model: 'from-file' });
  });

  it('prefers OPENCODE_CONFIG_CONTENT over OPENCODE_CONFIG when both are set', () => {
    const path = join(tmpdir(), `print-config-test-${Date.now()}-b.json`);
    writeFileSync(path, JSON.stringify({ model: 'from-file' }), 'utf-8');
    tempFiles.push(path);

    const env = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'inline' }),
      OPENCODE_CONFIG: path,
    } as NodeJS.ProcessEnv;
    expect(extractGeneratedConfig(env)).toEqual({ model: 'inline' });
  });

  it('throws a descriptive error when neither env var is set', () => {
    expect(() => extractGeneratedConfig({} as NodeJS.ProcessEnv)).toThrow(
      'Could not generate opencode config: CODEMIE_BASE_URL is missing or invalid',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/core/__tests__/print-config.test.ts`
Expected: FAIL — `Cannot find module '../print-config.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/agents/core/print-config.ts
import { readFileSync } from 'fs';

/**
 * Reads the opencode config beforeRun() generated back out of env — either the
 * inline OPENCODE_CONFIG_CONTENT channel or the OPENCODE_CONFIG temp-file
 * fallback. Throws if beforeRun's early-return path (missing/invalid
 * CODEMIE_BASE_URL) left neither populated.
 */
export function extractGeneratedConfig(env: NodeJS.ProcessEnv): unknown {
  if (env.OPENCODE_CONFIG_CONTENT) {
    return JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  }

  if (env.OPENCODE_CONFIG) {
    return JSON.parse(readFileSync(env.OPENCODE_CONFIG, 'utf-8'));
  }

  throw new Error('Could not generate opencode config: CODEMIE_BASE_URL is missing or invalid');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/core/__tests__/print-config.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agents/core/print-config.ts src/agents/core/__tests__/print-config.test.ts
git commit -m "feat(agents): add extractGeneratedConfig helper for print-config"
```

---

### Task 3: `BaseAgentAdapter.run()` dry-run support

**Files:**
- Modify: `src/agents/core/types.ts` (`AgentAdapter.run` signature, ~line 720)
- Modify: `src/agents/core/BaseAgentAdapter.ts` (`run()`, ~lines 376–408 for signature, insert after ~line 578)
- Test: `src/agents/core/__tests__/BaseAgentAdapter.test.ts`

**Interfaces:**
- Consumes: `redactSecrets` from Task 1 (`../config-redaction.js`), `extractGeneratedConfig` from Task 2 (`../print-config.js`).
- Produces: `BaseAgentAdapter.run(args: string[], envOverrides?: Record<string, string>, runOptions?: { dryRun?: boolean }): Promise<void>` — Task 4 calls this with `{ dryRun: true }`.

**Test-first: yes — a test that injects `OPENCODE_CONFIG_CONTENT` via the mocked `executeBeforeRun` and asserts `spawn` is never called, the printed JSON is redacted, and the promise resolves; plus a test for the "neither env var set" error path.**

- [ ] **Step 1: Write the failing test**

Add this `describe` block to `src/agents/core/__tests__/BaseAgentAdapter.test.ts` (after the existing `describe('run() — Windows command path quoting', ...)` block, before the file's closing). It needs its own `beforeEach`/`afterEach` because it overrides the file-level `executeBeforeRun` mock per test.

```typescript
  describe('run() — dry-run print-config', () => {
    class DryRunAdapter extends BaseAgentAdapter {}

    const dryRunMetadata: AgentMetadata = {
      name: 'opencode',
      displayName: 'OpenCode',
      description: 'Dry-run print-config tests',
      npmPackage: null,
      cliCommand: 'opencode',
      envMapping: {},
      supportedProviders: ['ai-run-sso'],
      silentMode: true,
    };

    let consoleLogSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      vi.clearAllMocks();
      consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { executeBeforeRun } = await import('../lifecycle-helpers.js');
      vi.mocked(executeBeforeRun).mockImplementation((_adapter: any, _lifecycle: any, _name: any, env: any) =>
        Promise.resolve(env),
      );
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    it('prints the redacted config and never spawns when the inline channel is populated', async () => {
      const { executeBeforeRun } = await import('../lifecycle-helpers.js');
      vi.mocked(executeBeforeRun).mockImplementation((_adapter: any, _lifecycle: any, _name: any, env: any) =>
        Promise.resolve({
          ...env,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            model: 'codemie-proxy/gpt-5',
            provider: { 'codemie-proxy': { options: { apiKey: 'proxy-handled' } } },
          }),
        }),
      );
      const adapter = new DryRunAdapter(dryRunMetadata);

      await adapter.run([], {}, { dryRun: true });

      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const printed = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(printed).toEqual({
        model: 'codemie-proxy/gpt-5',
        provider: { 'codemie-proxy': { options: { apiKey: '***REDACTED***' } } },
      });
    });

    it('reads from the OPENCODE_CONFIG temp-file fallback when CONTENT is absent', async () => {
      const { writeFileSync, unlinkSync } = await import('fs');
      const { join } = await import('path');
      const { tmpdir } = await import('os');
      const path = join(tmpdir(), `basadapter-dryrun-${Date.now()}.json`);
      writeFileSync(path, JSON.stringify({ model: 'from-file' }), 'utf-8');

      try {
        const { executeBeforeRun } = await import('../lifecycle-helpers.js');
        vi.mocked(executeBeforeRun).mockImplementation((_adapter: any, _lifecycle: any, _name: any, env: any) =>
          Promise.resolve({ ...env, OPENCODE_CONFIG: path }),
        );
        const adapter = new DryRunAdapter(dryRunMetadata);

        await adapter.run([], {}, { dryRun: true });

        expect(vi.mocked(spawn)).not.toHaveBeenCalled();
        const printed = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
        expect(printed).toEqual({ model: 'from-file' });
      } finally {
        unlinkSync(path);
      }
    });

    it('rejects with a descriptive error and never spawns when neither env var is populated', async () => {
      const adapter = new DryRunAdapter(dryRunMetadata);

      await expect(adapter.run([], {}, { dryRun: true })).rejects.toThrow(
        'Could not generate opencode config: CODEMIE_BASE_URL is missing or invalid',
      );
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    });

    it('does not short-circuit when dryRun is not set (regression guard)', async () => {
      const adapter = new DryRunAdapter(dryRunMetadata);

      await adapter.run([], {});

      expect(vi.mocked(spawn)).toHaveBeenCalledOnce();
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/core/__tests__/BaseAgentAdapter.test.ts -t "dry-run print-config"`
Expected: FAIL — TypeScript error / runtime `spawn` called (the third `run()` argument doesn't exist yet, so all 4 new tests fail: the first three because `spawn` IS called (no short-circuit exists) and console.log is never invoked, the last one is a false-pass until the others are red).

- [ ] **Step 3: Write minimal implementation**

In `src/agents/core/types.ts`, update the `AgentAdapter.run` signature (~line 720):

```typescript
  run(args: string[], env?: Record<string, string>, options?: { dryRun?: boolean }): Promise<void>;
```

In `src/agents/core/BaseAgentAdapter.ts`, add imports near the top (with the other local imports):

```typescript
import { redactSecrets } from './config-redaction.js';
import { extractGeneratedConfig } from './print-config.js';
```

Change the `run()` signature (~line 376):

```typescript
  async run(
    args: string[],
    envOverrides?: Record<string, string>,
    runOptions?: { dryRun?: boolean },
  ): Promise<void> {
```

Immediately after the `beforeRun` lifecycle hook call (currently ~line 578: `env = await executeBeforeRun(this, this.metadata.lifecycle, this.metadata.name, env, this.extractConfig(env));`), insert the short-circuit:

```typescript
    if (runOptions?.dryRun) {
      const generatedConfig = extractGeneratedConfig(env);
      console.log(JSON.stringify(redactSecrets(generatedConfig), null, 2));
      return;
    }
```

This runs before `Object.assign(process.env, env)`, before `enrichArgs`/flag transforms, and well before the `spawn()` call — none of that code executes in dry-run mode.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/core/__tests__/BaseAgentAdapter.test.ts`
Expected: PASS (all existing tests plus the new 4)

- [ ] **Step 5: Commit**

```bash
git add src/agents/core/types.ts src/agents/core/BaseAgentAdapter.ts src/agents/core/__tests__/BaseAgentAdapter.test.ts
git commit -m "feat(agents): support dryRun short-circuit in BaseAgentAdapter.run()"
```

---

### Task 4: `--print-config` CLI flag wiring

**Files:**
- Modify: `src/agents/core/AgentCLI.ts` (`setupProgram()` ~line 69–82, `handleRun()` ~lines 167–178 and ~line 398)
- Test: `src/agents/core/__tests__/AgentCLI-print-config.test.ts`

**Interfaces:**
- Consumes: `adapter.run(args, env, { dryRun })` from Task 3.
- Produces: nothing consumed by later tasks — this is the CLI-facing task.

**Test-first: yes — tests for: opencode + `--print-config` forwards `{ dryRun: true }` to `run()`; a non-opencode agent + `--print-config` errors and exits 1 without calling `run()`; opencode without the flag calls `run()` with no third argument (regression guard).**

- [ ] **Step 1: Write the failing test**

```typescript
// src/agents/core/__tests__/AgentCLI-print-config.test.ts
import { describe, it, expect, vi } from 'vitest';
import { AgentCLI } from '../AgentCLI.js';
import type { AgentAdapter } from '../types.js';
import { ConfigLoader } from '../../../utils/config.js';
import { ProviderRegistry } from '../../../providers/core/registry.js';

class ExitError extends Error {
  constructor(public code?: string | number | null) {
    super(`process.exit:${code}`);
  }
}

function createAdapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    name: 'opencode',
    displayName: 'OpenCode',
    description: 'Test adapter for print-config',
    metadata: {
      name: 'opencode',
      displayName: 'OpenCode',
      description: 'Test adapter for print-config',
      npmPackage: null,
      cliCommand: 'opencode',
      envMapping: {},
      supportedProviders: [],
    },
    install: async () => {},
    uninstall: async () => {},
    isInstalled: async () => true,
    run: async () => {},
    getVersion: async () => null,
    getMetricsConfig: () => undefined,
    ...overrides,
  };
}

function mockHandleRunDependencies() {
  vi.spyOn(ConfigLoader, 'load').mockResolvedValue({
    name: 'default',
    provider: 'litellm',
    model: 'gpt-5',
    baseUrl: 'https://example.invalid',
    apiKey: 'test-key',
    timeout: 0,
    debug: false,
    allowedDirs: [],
    ignorePatterns: ['node_modules'],
  } as Awaited<ReturnType<typeof ConfigLoader.load>>);
  vi.spyOn(ConfigLoader, 'exportProviderEnvVars').mockReturnValue({
    CODEMIE_API_KEY: 'test-key',
  });
  vi.spyOn(ProviderRegistry, 'getProvider').mockReturnValue({ requiresAuth: true } as never);
  vi.spyOn(ProviderRegistry, 'getSetupSteps').mockReturnValue(null as never);
}

describe('handleRun --print-config', () => {
  it('forwards { dryRun: true } to adapter.run() for the opencode agent', async () => {
    mockHandleRunDependencies();
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(createAdapter({ run })) as unknown as {
      handleRun: (args: string[], options: Record<string, unknown>) => Promise<void>;
    };

    await cli.handleRun([], { printConfig: true });

    expect(run).toHaveBeenCalledWith(expect.any(Array), expect.any(Object), { dryRun: true });
  });

  it('calls adapter.run() with no third argument when --print-config is not passed', async () => {
    mockHandleRunDependencies();
    const run = vi.fn().mockResolvedValue(undefined);
    const cli = new AgentCLI(createAdapter({ run })) as unknown as {
      handleRun: (args: string[], options: Record<string, unknown>) => Promise<void>;
    };

    await cli.handleRun([], {});

    expect(run).toHaveBeenCalledWith(expect.any(Array), expect.any(Object), undefined);
  });

  it('rejects with exit code 1 and never calls adapter.run() for a non-opencode agent', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new ExitError(code);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cli = new AgentCLI(createAdapter({ name: 'claude', run })) as unknown as {
      handleRun: (args: string[], options: Record<string, unknown>) => Promise<void>;
    };

    await expect(cli.handleRun([], { printConfig: true })).rejects.toMatchObject({ code: 1 });

    expect(run).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/core/__tests__/AgentCLI-print-config.test.ts`
Expected: FAIL — `run` is called with only 2 arguments (test 1 fails: `undefined` !== `{ dryRun: true }`); test 3 fails because there is no guard, so `run` gets called instead of `process.exit(1)`.

- [ ] **Step 3: Write minimal implementation**

In `src/agents/core/AgentCLI.ts`, add the flag in `setupProgram()` next to the other boolean flags (~line 81, right after `--no-analytics-report`):

```typescript
      .option('--print-config', 'Print the generated opencode config and exit without starting opencode')
```

In `handleRun()`, extend the silent-mode auto-detection (~lines 167–170) so print-config never leaks banners/prompts to stdout:

```typescript
      // Auto-enable silent mode in non-interactive mode (--task flag present)
      // or when only printing the generated config (--print-config).
      // This suppresses welcome/goodbye messages and interactive prompts.
      const isNonInteractiveMode = !!options.task;
      const shouldBeSilent = options.silent || isNonInteractiveMode || !!options.printConfig;
```

Immediately after that block (still before `ConfigLoader.load`, ~line 178), add the opencode-only guard:

```typescript
      // --print-config only makes sense for opencode: it's the only agent that
      // generates its own on-the-fly config via a beforeRun hook.
      if (options.printConfig && this.adapter.name !== 'opencode') {
        console.error(chalk.red(`\n✗ --print-config is not supported for ${this.adapter.displayName}\n`));
        process.exit(1);
      }
```

At the call site (~line 398), forward the intent:

```typescript
      // Run the agent (welcome message will be shown inside)
      await this.adapter.run(agentArgs, providerEnv, options.printConfig ? { dryRun: true } : undefined);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/core/__tests__/AgentCLI-print-config.test.ts`
Expected: PASS (3 tests)

Then run the full CLI unit suite to check for regressions:

Run: `npx vitest run src/agents/core/__tests__/`
Expected: PASS (all files, including `AgentCLI-resume.test.ts`, `AgentCLI-effort.test.ts`, `BaseAgentAdapter.test.ts`)

- [ ] **Step 5: Commit**

```bash
git add src/agents/core/AgentCLI.ts src/agents/core/__tests__/AgentCLI-print-config.test.ts
git commit -m "feat(agents): add --print-config flag to codemie-opencode"
```

---

### Task 5: Integration test against the real opencode plugin

**Files:**
- Create: `tests/integration/opencode/print-config.test.ts`

**Interfaces:**
- Consumes: `extractGeneratedConfig` (Task 2, `src/agents/core/print-config.js`), `redactSecrets` (Task 1, `src/agents/core/config-redaction.js`), `OpenCodePluginMetadata` (existing export from `src/agents/plugins/opencode/opencode.plugin.js`).
- Produces: nothing — this is a leaf verification test.

**Why this test calls `beforeRun` directly instead of going through `BaseAgentAdapter.run()`:** the full `run()` pipeline also invokes `executeOnSessionStart`, which for opencode writes a real `.claude/skills/` directory into the CWD and starts a background incremental-sync watcher (see the `SIDE EFFECT (user-visible, accepted)` comment in `opencode.plugin.ts`'s `onSessionStart`). That's existing, unrelated behavior — Tasks 3/4's unit tests already prove the `dryRun` short-circuit and CLI wiring in isolation with those hooks mocked. This integration test's job is narrower and complementary: prove that the REAL `beforeRun` output (not a hand-rolled fixture) round-trips correctly through the real `extractGeneratedConfig` + `redactSecrets`, so a future change to the config shape can't silently break print-config without a test failing. Only `ensureSessionFile` (a real filesystem write into `~/.codemie/sessions/`, called from inside `beforeRun` itself) needs mocking to keep this hermetic.

**Test-first: yes — the test asserts on the real, unmocked config assembly (network-call fallback path), so there is no "minimal implementation" step; this task only adds a test.**

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/opencode/print-config.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/agents/core/session/ensure-session.js', () => ({
  ensureSessionFile: vi.fn(() => Promise.resolve()),
}));

import { OpenCodePluginMetadata } from '../../../src/agents/plugins/opencode/opencode.plugin.js';
import { extractGeneratedConfig } from '../../../src/agents/core/print-config.js';
import { redactSecrets } from '../../../src/agents/core/config-redaction.js';

describe('print-config against the real opencode plugin', () => {
  it('produces a redacted, well-formed config from a realistic env (network fetch fails and falls back to static models)', async () => {
    const env = {
      CODEMIE_SESSION_ID: 'test-session-print-config',
      CODEMIE_BASE_URL: 'https://example.invalid', // RFC 2606 reserved TLD: fails fast, no real network dependency
      CODEMIE_MODEL: 'gpt-5-2-2025-12-11',
      CODEMIE_TIMEOUT: '600',
    } as NodeJS.ProcessEnv;

    const resultEnv = await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {});

    const generated = extractGeneratedConfig(resultEnv);
    const redacted = redactSecrets(generated) as Record<string, unknown>;

    expect(redacted.model).toContain('codemie-proxy/');
    const provider = redacted.provider as Record<string, any>;
    expect(provider['codemie-proxy'].options.apiKey).toBe('***REDACTED***');
    expect(provider['codemie-proxy'].options.baseURL).toBe('https://example.invalid/');
  });

  it('extractGeneratedConfig throws when CODEMIE_BASE_URL is missing (beforeRun early-return path)', async () => {
    const env = { CODEMIE_SESSION_ID: 'test-session-no-url' } as NodeJS.ProcessEnv;

    const resultEnv = await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {});

    expect(() => extractGeneratedConfig(resultEnv)).toThrow(
      'Could not generate opencode config: CODEMIE_BASE_URL is missing or invalid',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project cli tests/integration/opencode/print-config.test.ts`

(Check `vitest.config.ts`'s `projects` array first — this file must land in the project whose `include` covers `tests/integration/**/*.test.ts` and is excluded from the `agent-*` real-network project; if the CLI-integration project name differs from `cli`, use that name instead.)

Expected: FAIL — module not found (`print-config.ts`/`config-redaction.ts` don't exist yet if Tasks 1–2 weren't run first; if they were, this test should already pass, confirming Task 1/2's implementation matches the real plugin's output shape without further changes).

- [ ] **Step 3: Write minimal implementation**

No production code changes — this task only adds the test. If Step 2 fails for any reason other than a missing module (e.g. the real `provider['codemie-proxy']` key differs from what's asserted), fix the assertion to match the actual verified output; do not change `opencode.plugin.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project cli tests/integration/opencode/print-config.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add tests/integration/opencode/print-config.test.ts
git commit -m "test(agents): verify print-config against the real opencode beforeRun output"
```

---

## Manual Verification (after Task 5)

Run the full unit + CLI-integration suite once more to confirm no regressions across the whole change:

```bash
npx vitest run --project unit --project cli
```

Then do a real smoke check with the actual binary (requires a configured profile):

```bash
node bin/codemie-opencode.js --print-config
```

Expected: pretty-printed JSON config on stdout, redacted `apiKey`/`headers` fields, process exits 0, no opencode process starts.

```bash
node bin/codemie-claude.js --print-config
```

Expected: `✗ --print-config is not supported for Claude Code` on stderr, exit code 1.
