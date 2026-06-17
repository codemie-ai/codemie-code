# Unified Headless Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--reasoning-effort` and `--resume` unified CLI flags to all `codemie-*` wrappers (claude, codex, opencode, kimi) so callers never need to know agent-specific flags.

**Architecture:** A new shared `reasoning-effort.ts` module holds the canonical vocabulary and three pure functions. A central applier in `BaseAgentAdapter.run()` — after `transformFlags` but before spawn — reads `CODEMIE_REASONING_EFFORT` from env and dispatches to the correct strategy (`cli-flag`, `cli-config`, or `env`) declared in each agent's metadata. `--resume` flows through the existing `flagMappings`/`enrichArgs` pipeline; no central applier needed for it.

**Tech Stack:** TypeScript strict, ES modules, `.js` import extensions, Vitest for tests, Commander.js for CLI, chalk for user-facing output.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `src/agents/core/types.ts` | Modify | Add `CanonicalReasoningEffort`, `ReasoningEffortStrategy`, `ReasoningEffortConfig`; add `reasoningEffort?` to `AgentMetadata` |
| `src/env/types.ts` | Modify | Add `reasoningEffort?: CanonicalReasoningEffort` to `ProviderProfile` |
| `src/agents/core/reasoning-effort.ts` | **Create** | `normalizeReasoningEffort`, `clampToSupported`, `applyReasoningEffort` |
| `src/agents/core/__tests__/reasoning-effort.test.ts` | **Create** | Unit tests for the above module |
| `src/agents/core/AgentCLI.ts` | Modify | Register `--reasoning-effort` + `--resume` options; validate; update `configOnlyOptions`; thread into `ConfigLoader.load` |
| `src/utils/config.ts` | Modify | Emit `CODEMIE_REASONING_EFFORT` in `exportProviderEnvVars` |
| `src/agents/core/BaseAgentAdapter.ts` | Modify | Central applier + warn branch after `transformFlags` |
| `src/agents/plugins/claude/claude.plugin.ts` | Modify | Add `reasoningEffort` block; add `--resume` → `-r` to `flagMappings` |
| `src/agents/plugins/codex/codex.plugin.ts` | Modify | Add `reasoningEffort` block; extend `enrichArgs` for both resume cases |
| `src/agents/plugins/opencode/opencode.plugin.ts` | Modify | Add `reasoningEffort` block; add `--resume` → `-s` to `flagMappings` |
| `src/agents/plugins/kimi/kimi.plugin.ts` | Modify | Add `reasoningEffort` block (env strategy); add `--resume` → `-S` to `flagMappings` |
| `src/agents/plugins/__tests__/plugin-effort-resume.test.ts` | **Create** | Per-plugin spawn-arg tests for effort + resume |

---

## Task F1: Types foundation

**Test-first: no** — TypeScript type additions are verified by the build (`npm run typecheck`), not by Vitest unit tests.

**Files:**
- Modify: `src/agents/core/types.ts` (after line 245, near `flagMappings?`)
- Modify: `src/env/types.ts` (after line 55, near `model?`)

- [ ] **Step 1: Add types to `src/agents/core/types.ts`**

After the `FlagMappings` interface definition (currently ending around line 45), insert:

```ts
// ============================================================================
// Reasoning / thinking effort
// ============================================================================

export type CanonicalReasoningEffort =
  | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ReasoningEffortStrategy = 'cli-flag' | 'cli-config' | 'env';

/**
 * Declarative config for how an agent receives the reasoning effort level.
 * Lives in AgentMetadata.reasoningEffort.
 */
export interface ReasoningEffortConfig {
  strategy: ReasoningEffortStrategy;
  /** Canonical levels this agent accepts (used for clamping). */
  supportedLevels: CanonicalReasoningEffort[];
  /**
   * Optional level mapper. Identity default — clamping handles all current agents.
   * Escape hatch for a future provider that renames levels (e.g. 'thinking' instead of 'high').
   */
  mapLevel?: (level: CanonicalReasoningEffort) => string | null;
  /**
   * Where to place the injected flag/config relative to existing args.
   * Applies to cli-flag and cli-config; ignored by env. Default: 'append'.
   */
  placement?: 'prepend' | 'append';
  // cli-flag strategy (claude: --effort, opencode: --variant)
  flag?: string;
  // cli-config strategy (codex: --config model_reasoning_effort="<level>")
  configFlag?: string;  // default '--config'
  configKey?: string;   // e.g. 'model_reasoning_effort'
  // env strategy (kimi: KIMI_MODEL_THINKING_*)
  envVars?: Record<string, string>;  // '%s' replaced by the mapped level
  /**
   * Native flag/key names whose presence in pass-through args suppresses injection.
   * Strategy-aware: exact-or-= match for cli-flag, substring for cli-config, N/A for env.
   */
  userOverrideFlags?: string[];
}
```

- [ ] **Step 2: Add `reasoningEffort?` to `AgentMetadata` in `src/agents/core/types.ts`**

Find the `flagMappings?: FlagMappings;` line (currently line 245). Insert after it:

```ts
  /** Declarative reasoning-effort injection config. Omit for agents that do not support effort control. */
  reasoningEffort?: ReasoningEffortConfig;
```

- [ ] **Step 3: Add `reasoningEffort?` to `ProviderProfile` in `src/env/types.ts`**

Find `model?: string;` (currently line 55). Insert after it:

```ts
  /** Reasoning/thinking effort level. Persisted profile default; CLI flag overrides. */
  reasoningEffort?: CanonicalReasoningEffort;
```

Add the import at the top of `src/env/types.ts`:

```ts
import type { CanonicalReasoningEffort } from '../agents/core/types.js';
```

- [ ] **Step 4: Verify types compile**

```bash
npm run typecheck
```

Expected: zero errors. Fix any import cycle issues before continuing.

- [ ] **Step 5: Commit**

```bash
git add src/agents/core/types.ts src/env/types.ts
git commit -m "feat(types): add CanonicalReasoningEffort, ReasoningEffortConfig to AgentMetadata and ProviderProfile"
```

---

## Task F2: `reasoning-effort.ts` shared module (TDD)

**Test-first: yes** — write a failing test for each function, then implement.

**Files:**
- Create: `src/agents/core/__tests__/reasoning-effort.test.ts`
- Create: `src/agents/core/reasoning-effort.ts`

- [ ] **Step 1: Write failing tests**

Create `src/agents/core/__tests__/reasoning-effort.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  CANONICAL_EFFORT_ORDER,
  normalizeReasoningEffort,
  clampToSupported,
  applyReasoningEffort,
} from '../reasoning-effort.js';
import type { ReasoningEffortConfig } from '../types.js';

describe('CANONICAL_EFFORT_ORDER', () => {
  it('lists all six levels weakest to strongest', () => {
    expect(CANONICAL_EFFORT_ORDER).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('normalizeReasoningEffort', () => {
  it('accepts lowercase canonical values', () => {
    expect(normalizeReasoningEffort('high')).toBe('high');
    expect(normalizeReasoningEffort('minimal')).toBe('minimal');
    expect(normalizeReasoningEffort('max')).toBe('max');
  });

  it('normalizes uppercase input to lowercase canonical', () => {
    expect(normalizeReasoningEffort('HIGH')).toBe('high');
    expect(normalizeReasoningEffort('Medium')).toBe('medium');
    expect(normalizeReasoningEffort('XHIGH')).toBe('xhigh');
  });

  it('returns undefined for unknown values', () => {
    expect(normalizeReasoningEffort('ultra')).toBeUndefined();
    expect(normalizeReasoningEffort('')).toBeUndefined();
    expect(normalizeReasoningEffort('thinking')).toBeUndefined();
  });
});

describe('clampToSupported', () => {
  const claudeSupported = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
  const codexSupported = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
  const kimiSupported = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

  it('returns the same level when it is supported', () => {
    expect(clampToSupported('high', [...claudeSupported])).toBe('high');
    expect(clampToSupported('minimal', [...codexSupported])).toBe('minimal');
    expect(clampToSupported('max', [...kimiSupported])).toBe('max');
  });

  it('clamps minimal → low for claude (minimal not supported)', () => {
    expect(clampToSupported('minimal', [...claudeSupported])).toBe('low');
  });

  it('clamps minimal → low for kimi (minimal not supported)', () => {
    expect(clampToSupported('minimal', [...kimiSupported])).toBe('low');
  });

  it('clamps max → xhigh for codex (max not supported)', () => {
    expect(clampToSupported('max', [...codexSupported])).toBe('xhigh');
  });

  it('opencode supports all six levels — no clamping needed', () => {
    const opencodeSupported = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
    for (const level of CANONICAL_EFFORT_ORDER) {
      expect(clampToSupported(level, [...opencodeSupported])).toBe(level);
    }
  });
});

describe('applyReasoningEffort — cli-flag strategy (claude)', () => {
  const claudeConfig: ReasoningEffortConfig = {
    strategy: 'cli-flag',
    flag: '--effort',
    placement: 'append',
    supportedLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    userOverrideFlags: ['--effort'],
  };

  it('appends --effort <level> to args', () => {
    const args = ['-p', 'do the thing'];
    const env: NodeJS.ProcessEnv = {};
    const result = applyReasoningEffort(args, env, claudeConfig, 'high', 'claude');
    expect(result.args).toEqual(['-p', 'do the thing', '--effort', 'high']);
  });

  it('clamps minimal → low and appends', () => {
    const args = ['-p', 'do the thing'];
    const env: NodeJS.ProcessEnv = {};
    const result = applyReasoningEffort(args, env, claudeConfig, 'minimal', 'claude');
    expect(result.args).toEqual(['-p', 'do the thing', '--effort', 'low']);
  });

  it('skips injection when --effort already present in args (exact match)', () => {
    const args = ['-p', 'task', '--effort', 'low'];
    const env: NodeJS.ProcessEnv = {};
    const result = applyReasoningEffort(args, env, claudeConfig, 'high', 'claude');
    expect(result.args).toEqual(['-p', 'task', '--effort', 'low']);
  });

  it('skips injection when --effort=<val> present in args', () => {
    const args = ['-p', 'task', '--effort=low'];
    const env: NodeJS.ProcessEnv = {};
    const result = applyReasoningEffort(args, env, claudeConfig, 'high', 'claude');
    expect(result.args).toEqual(['-p', 'task', '--effort=low']);
  });

  it('returns unchanged args when rawLevel is undefined', () => {
    const args = ['-p', 'task'];
    const env: NodeJS.ProcessEnv = {};
    const result = applyReasoningEffort(args, env, claudeConfig, undefined, 'claude');
    expect(result.args).toEqual(['-p', 'task']);
  });
});

describe('applyReasoningEffort — cli-flag strategy (opencode, prepend)', () => {
  const opencodeConfig: ReasoningEffortConfig = {
    strategy: 'cli-flag',
    flag: '--variant',
    placement: 'prepend',
    supportedLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    userOverrideFlags: ['--variant'],
  };

  it('prepends --variant <level> to args', () => {
    const args = ['run', 'do the thing'];
    const env: NodeJS.ProcessEnv = {};
    const result = applyReasoningEffort(args, env, opencodeConfig, 'medium', 'opencode');
    expect(result.args).toEqual(['--variant', 'medium', 'run', 'do the thing']);
  });
});

describe('applyReasoningEffort — cli-config strategy (codex)', () => {
  const codexConfig: ReasoningEffortConfig = {
    strategy: 'cli-config',
    configFlag: '--config',
    configKey: 'model_reasoning_effort',
    placement: 'prepend',
    supportedLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    userOverrideFlags: ['model_reasoning_effort'],
  };

  it('prepends --config model_reasoning_effort="<level>" to args', () => {
    const args = ['exec', 'do the thing'];
    const env: NodeJS.ProcessEnv = {};
    const result = applyReasoningEffort(args, env, codexConfig, 'high', 'codex');
    expect(result.args).toEqual(['--config', 'model_reasoning_effort="high"', 'exec', 'do the thing']);
  });

  it('clamps max → xhigh for codex', () => {
    const args = ['exec', 'task'];
    const env: NodeJS.ProcessEnv = {};
    const result = applyReasoningEffort(args, env, codexConfig, 'max', 'codex');
    expect(result.args).toEqual(['--config', 'model_reasoning_effort="xhigh"', 'exec', 'task']);
  });

  it('skips injection when model_reasoning_effort already in args', () => {
    const args = ['--config', 'model_reasoning_effort="low"', 'exec', 'task'];
    const env: NodeJS.ProcessEnv = {};
    const result = applyReasoningEffort(args, env, codexConfig, 'high', 'codex');
    expect(result.args).toEqual(['--config', 'model_reasoning_effort="low"', 'exec', 'task']);
  });
});

describe('applyReasoningEffort — env strategy (kimi)', () => {
  const kimiConfig: ReasoningEffortConfig = {
    strategy: 'env',
    envVars: {
      KIMI_MODEL_THINKING_MODE: 'on',
      KIMI_MODEL_THINKING_EFFORT: '%s',
      KIMI_MODEL_CAPABILITIES: 'thinking',
      KIMI_MODEL_DEFAULT_THINKING: 'true',
    },
    supportedLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  };

  it('sets all four env vars with level substituted into %s', () => {
    const args = ['-p', 'task'];
    const env: NodeJS.ProcessEnv = {};
    const result = applyReasoningEffort(args, env, kimiConfig, 'high', 'kimi');
    expect(result.args).toEqual(['-p', 'task']); // args unchanged
    expect(env.KIMI_MODEL_THINKING_MODE).toBe('on');
    expect(env.KIMI_MODEL_THINKING_EFFORT).toBe('high');
    expect(env.KIMI_MODEL_CAPABILITIES).toBe('thinking');
    expect(env.KIMI_MODEL_DEFAULT_THINKING).toBe('true');
  });

  it('clamps minimal → low for kimi before setting env var', () => {
    const env: NodeJS.ProcessEnv = {};
    applyReasoningEffort(['-p', 'task'], env, kimiConfig, 'minimal', 'kimi');
    expect(env.KIMI_MODEL_THINKING_EFFORT).toBe('low');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm run test:unit -- src/agents/core/__tests__/reasoning-effort.test.ts
```

Expected: `Cannot find module '../reasoning-effort.js'` or similar.

- [ ] **Step 3: Implement `src/agents/core/reasoning-effort.ts`**

```ts
import type { CanonicalReasoningEffort, ReasoningEffortConfig } from './types.js';
import { logger } from '../../utils/logger.js';
import chalk from 'chalk';

export const CANONICAL_EFFORT_ORDER: CanonicalReasoningEffort[] =
  ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function normalizeReasoningEffort(raw: string): CanonicalReasoningEffort | undefined {
  const lower = raw.toLowerCase();
  return CANONICAL_EFFORT_ORDER.includes(lower as CanonicalReasoningEffort)
    ? (lower as CanonicalReasoningEffort)
    : undefined;
}

/** Pure — no side effects. Returns the nearest supported level (by canonical order). */
export function clampToSupported(
  level: CanonicalReasoningEffort,
  supported: CanonicalReasoningEffort[],
): CanonicalReasoningEffort {
  if (supported.includes(level)) return level;
  const idx = CANONICAL_EFFORT_ORDER.indexOf(level);
  // Walk up from the requested level to find the nearest supported one
  for (let i = idx - 1; i >= 0; i--) {
    if (supported.includes(CANONICAL_EFFORT_ORDER[i])) return CANONICAL_EFFORT_ORDER[i];
  }
  // If nothing lower found, walk up
  for (let i = idx + 1; i < CANONICAL_EFFORT_ORDER.length; i++) {
    if (supported.includes(CANONICAL_EFFORT_ORDER[i])) return CANONICAL_EFFORT_ORDER[i];
  }
  return level; // unreachable if supported is non-empty
}

function hasUserOverride(args: string[], config: ReasoningEffortConfig): boolean {
  if (!config.userOverrideFlags?.length) return false;
  if (config.strategy === 'cli-config') {
    // substring match: look for the configKey embedded in any arg
    return args.some(arg => config.userOverrideFlags!.some(key => arg.includes(key)));
  }
  // cli-flag: exact match or --flag=value form
  return args.some(arg =>
    config.userOverrideFlags!.some(
      flag => arg === flag || arg.startsWith(flag + '=')
    )
  );
}

export function applyReasoningEffort(
  args: string[],
  env: NodeJS.ProcessEnv,
  config: ReasoningEffortConfig,
  rawLevel: string | undefined,
  agentName: string,
): { args: string[] } {
  if (!rawLevel) return { args };

  const normalized = normalizeReasoningEffort(rawLevel);
  if (!normalized) {
    logger.debug(`[${agentName}] reasoning-effort: unrecognized level '${rawLevel}', skipping`);
    return { args };
  }

  if (hasUserOverride(args, config)) {
    logger.debug(`[${agentName}] reasoning-effort: native override detected, skipping injection`);
    return { args };
  }

  const clamped = clampToSupported(normalized, config.supportedLevels);
  if (clamped !== normalized) {
    logger.debug(`[${agentName}] reasoning-effort: clamped '${normalized}' → '${clamped}'`);
    console.error(
      chalk.dim(`  ℹ  [${agentName}] --reasoning-effort '${normalized}' not supported; using '${clamped}'`)
    );
  }

  const mappedLevel = config.mapLevel ? (config.mapLevel(clamped) ?? clamped) : clamped;

  if (config.strategy === 'env') {
    for (const [key, template] of Object.entries(config.envVars ?? {})) {
      env[key] = template === '%s' ? mappedLevel : template;
    }
    return { args };
  }

  if (config.strategy === 'cli-flag') {
    const flag = config.flag!;
    const pair = [flag, mappedLevel];
    const placement = config.placement ?? 'append';
    return { args: placement === 'prepend' ? [...pair, ...args] : [...args, ...pair] };
  }

  if (config.strategy === 'cli-config') {
    const flag = config.configFlag ?? '--config';
    const pair = [flag, `${config.configKey!}="${mappedLevel}"`];
    const placement = config.placement ?? 'append';
    return { args: placement === 'prepend' ? [...pair, ...args] : [...args, ...pair] };
  }

  return { args };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm run test:unit -- src/agents/core/__tests__/reasoning-effort.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agents/core/reasoning-effort.ts src/agents/core/__tests__/reasoning-effort.test.ts
git commit -m "feat(agents): add reasoning-effort shared module with normalize, clamp, apply"
```

---

## Task F3: AgentCLI plumbing + config.ts export (TDD)

**Test-first: yes** — verify that `collectPassThroughArgs` excludes `reasoningEffort` but includes `resume` by adding to the existing AgentCLI test pattern (which doesn't exist yet — create it), and verify `exportProviderEnvVars` emits `CODEMIE_REASONING_EFFORT`.

**Files:**
- Modify: `src/agents/core/AgentCLI.ts`
- Modify: `src/utils/config.ts`

- [ ] **Step 1: Write failing tests**

Create `src/agents/core/__tests__/AgentCLI-effort.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ConfigLoader } from '../../../utils/config.js';

describe('exportProviderEnvVars — reasoningEffort', () => {
  it('emits CODEMIE_REASONING_EFFORT when config.reasoningEffort is set', () => {
    const env = ConfigLoader.exportProviderEnvVars({
      provider: 'openai',
      baseUrl: 'https://example.com',
      apiKey: 'test-key',
      model: 'gpt-4o',
      reasoningEffort: 'high',
    });
    expect(env.CODEMIE_REASONING_EFFORT).toBe('high');
  });

  it('does not emit CODEMIE_REASONING_EFFORT when not set', () => {
    const env = ConfigLoader.exportProviderEnvVars({
      provider: 'openai',
      baseUrl: 'https://example.com',
      apiKey: 'test-key',
      model: 'gpt-4o',
    });
    expect(env.CODEMIE_REASONING_EFFORT).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
npm run test:unit -- src/agents/core/__tests__/AgentCLI-effort.test.ts
```

Expected: FAIL — `CODEMIE_REASONING_EFFORT` is undefined even when `reasoningEffort: 'high'` is passed.

- [ ] **Step 3: Add `reasoningEffort` to `ConfigLoader.load` call in `AgentCLI.ts`**

In `AgentCLI.ts`, the `ConfigLoader.load` call is at lines 177–184. Change it to:

```ts
      const config = await ConfigLoader.load(process.cwd(), {
        name: options.profile as string | undefined,
        provider: options.provider as string | undefined,
        model: options.model as string | undefined,
        apiKey: options.apiKey as string | undefined,
        baseUrl: options.baseUrl as string | undefined,
        timeout: options.timeout as number | undefined,
        reasoningEffort: options.reasoningEffort as string | undefined,
      });
```

- [ ] **Step 4: Add `--reasoning-effort` and `--resume` options to `setupProgram` in `AgentCLI.ts`**

After the `--task` option (line 77), add:

```ts
      .option('--reasoning-effort <level>', 'Reasoning/thinking effort: minimal|low|medium|high|xhigh|max')
      .option('--resume <session-id>', 'Resume an existing session by ID')
```

- [ ] **Step 5: Add `'reasoningEffort'` to `configOnlyOptions` in `collectPassThroughArgs`**

Line 433 currently reads:
```ts
const configOnlyOptions = ['profile', 'provider', 'apiKey', 'baseUrl', 'timeout', 'model', 'silent', 'status', 'jwtToken'];
```

Change to:
```ts
const configOnlyOptions = ['profile', 'provider', 'apiKey', 'baseUrl', 'timeout', 'model', 'silent', 'status', 'jwtToken', 'reasoningEffort'];
```

Do **not** add `'resume'` — it must flow through to per-agent transforms.

- [ ] **Step 6: Add validation after `ConfigLoader.load` in `handleRun`**

After the `config` is loaded (after line 184), insert:

```ts
      // Validate --reasoning-effort (catches both CLI and profile defaults)
      if (config.reasoningEffort) {
        const { normalizeReasoningEffort } = await import('../core/reasoning-effort.js');
        const normalized = normalizeReasoningEffort(config.reasoningEffort);
        if (!normalized) {
          console.error(chalk.red(`\n✗ Invalid --reasoning-effort '${config.reasoningEffort}'`));
          console.error(chalk.white('  Valid values: minimal, low, medium, high, xhigh, max\n'));
          logger.error(`Invalid --reasoning-effort value '${config.reasoningEffort}'`);
          process.exit(1);
        }
        config.reasoningEffort = normalized; // store canonical lowercase
      }

      // Validate --resume (must have a non-empty value)
      if (options.resume !== undefined && !options.resume) {
        console.error(chalk.red('\n✗ --resume requires a session id\n'));
        process.exit(1);
      }
```

**Note on import path:** `AgentCLI.ts` is in `src/agents/core/AgentCLI.ts`, so the relative import is `'./reasoning-effort.js'` not `'../core/reasoning-effort.js'`. Use `'./reasoning-effort.js'`.

- [ ] **Step 7: Add `CODEMIE_REASONING_EFFORT` to `exportProviderEnvVars` in `src/utils/config.ts`**

After line 1347 (`if (config.model) env.CODEMIE_MODEL = config.model;`), add:

```ts
    if (config.reasoningEffort) env.CODEMIE_REASONING_EFFORT = config.reasoningEffort;
```

- [ ] **Step 8: Run tests to confirm they pass**

```bash
npm run test:unit -- src/agents/core/__tests__/AgentCLI-effort.test.ts
```

Expected: both tests pass.

- [ ] **Step 9: Run typecheck to confirm no type errors**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 10: Commit**

```bash
git add src/agents/core/AgentCLI.ts src/utils/config.ts src/agents/core/__tests__/AgentCLI-effort.test.ts
git commit -m "feat(cli): register --reasoning-effort and --resume options; thread through config pipeline"
```

---

## Task F4: BaseAgentAdapter central injection (TDD)

**Test-first: yes** — add a test to the existing `BaseAgentAdapter.test.ts` that verifies `applyReasoningEffort` is called and produces the correct args when `CODEMIE_REASONING_EFFORT` is set.

**Files:**
- Modify: `src/agents/core/BaseAgentAdapter.ts`
- Modify: `src/agents/core/__tests__/BaseAgentAdapter.test.ts`

- [ ] **Step 1: Read the existing BaseAgentAdapter test to understand the test harness**

Read `src/agents/core/__tests__/BaseAgentAdapter.test.ts` fully to see how the `TestAdapter` is set up and how `run()` is invoked. You need to understand the mock structure before adding a test.

- [ ] **Step 2: Write a failing test**

In `src/agents/core/__tests__/BaseAgentAdapter.test.ts`, add a new `describe` block at the end:

```ts
describe('reasoning effort injection', () => {
  it('appends --effort <level> to spawn args when CODEMIE_REASONING_EFFORT is set and metadata.reasoningEffort is defined', async () => {
    // This test asserts the spawn args by capturing what the adapter would pass.
    // The TestAdapter in this file sets cliCommand to a no-op; we only care about
    // transformedArgs, which we can capture by overriding spawn or inspecting the
    // enrichArgs/transformFlags chain. Follow the existing pattern in this test file.

    // Set up a metadata with reasoningEffort defined
    const metadataWithEffort: AgentMetadata = {
      ...minimalMetadata, // use whatever minimal fixture the test file defines
      reasoningEffort: {
        strategy: 'cli-flag',
        flag: '--effort',
        placement: 'append',
        supportedLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        userOverrideFlags: ['--effort'],
      },
    };

    // Run the adapter with CODEMIE_REASONING_EFFORT set
    // Assert the captured spawn args include '--effort', 'high'
    // (Implementation detail: adapt to the spy/capture mechanism used by the existing tests.)
  });
});
```

**Important:** Read the existing test file first — the exact mock/spy pattern depends on how `run()` is tested there. If it intercepts `spawn`, use the same interceptor.

- [ ] **Step 3: Run test to confirm it fails**

```bash
npm run test:unit -- src/agents/core/__tests__/BaseAgentAdapter.test.ts
```

Expected: FAIL — `--effort` not present in captured args.

- [ ] **Step 4: Add the central applier to `BaseAgentAdapter.ts`**

In `BaseAgentAdapter.ts`, lines 547–552 are the `transformFlags` block:

```ts
    if (this.metadata.flagMappings) {
      const { transformFlags } = await import('./flag-transform.js');
      transformedArgs = transformFlags(enrichedArgs, this.metadata.flagMappings, this.extractConfig(env));
    } else {
      transformedArgs = enrichedArgs;
    }
```

Immediately after this block (before line 554 — the `=== Agent Configuration ===` debug section), insert:

```ts
    // Central reasoning-effort injection (Approach A).
    // Runs after enrichArgs and transformFlags so args are in final form.
    if (this.metadata.reasoningEffort && env.CODEMIE_REASONING_EFFORT) {
      const { applyReasoningEffort } = await import('./reasoning-effort.js');
      transformedArgs = applyReasoningEffort(
        transformedArgs,
        env,
        this.metadata.reasoningEffort,
        env.CODEMIE_REASONING_EFFORT,
        this.metadata.name,
      ).args;
    } else if (env.CODEMIE_REASONING_EFFORT) {
      // Agent declared no reasoningEffort block — warn and continue (spec §6.4).
      logger.warn(`[${this.metadata.name}] --reasoning-effort is set but not supported; ignoring`);
      console.error(chalk.yellow(`⚠  --reasoning-effort is not supported for ${this.displayName}; ignoring.`));
    }
```

`chalk` is already imported at the top of `BaseAgentAdapter.ts` (line 16).

- [ ] **Step 5: Run tests to confirm they pass**

```bash
npm run test:unit -- src/agents/core/__tests__/BaseAgentAdapter.test.ts
```

Expected: all tests pass, including the new one.

- [ ] **Step 6: Commit**

```bash
git add src/agents/core/BaseAgentAdapter.ts src/agents/core/__tests__/BaseAgentAdapter.test.ts
git commit -m "feat(agents): add central reasoning-effort injection in BaseAgentAdapter after transformFlags"
```

---

## Task F5: claude plugin — `reasoningEffort` block + `--resume` flag mapping (TDD)

**Test-first: yes**

**Files:**
- Create: `src/agents/plugins/__tests__/plugin-effort-resume.test.ts`
- Modify: `src/agents/plugins/claude/claude.plugin.ts`

- [ ] **Step 1: Write failing tests for claude**

Create `src/agents/plugins/__tests__/plugin-effort-resume.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { transformFlags } from '../../core/flag-transform.js';
import { applyReasoningEffort } from '../../core/reasoning-effort.js';
import { ClaudePluginMetadata } from '../claude/claude.plugin.js';
import { CodexPluginMetadata } from '../codex/codex.plugin.js';
import { OpenCodePluginMetadata } from '../opencode/opencode.plugin.js';
import { KimiPluginMetadata } from '../kimi/kimi.plugin.js';
import type { AgentConfig } from '../../core/types.js';

const mockConfig: AgentConfig = { provider: 'test', model: 'test-model' };

// ── claude ───────────────────────────────────────────────────────────────────

describe('claude plugin — reasoning effort', () => {
  it('appends --effort high after --task → -p transform', () => {
    // Simulate the pipeline: transformFlags first, then applyReasoningEffort
    const raw = ['--task', 'do the thing'];
    const afterTransform = transformFlags(raw, ClaudePluginMetadata.flagMappings!, mockConfig);
    // afterTransform = ['-p', 'do the thing']
    const env: NodeJS.ProcessEnv = {};
    const { args } = applyReasoningEffort(
      afterTransform, env, ClaudePluginMetadata.reasoningEffort!, 'high', 'claude'
    );
    expect(args).toEqual(['-p', 'do the thing', '--effort', 'high']);
  });

  it('clamps minimal → low', () => {
    const afterTransform = ['-p', 'task'];
    const { args } = applyReasoningEffort(
      afterTransform, {}, ClaudePluginMetadata.reasoningEffort!, 'minimal', 'claude'
    );
    expect(args).toContain('low');
    expect(args).not.toContain('minimal');
  });
});

describe('claude plugin — --resume flag mapping', () => {
  it('maps --resume <id> to -r <id>', () => {
    const args = ['-p', 'do the thing', '--resume', 'abc-123'];
    const result = transformFlags(args, ClaudePluginMetadata.flagMappings!, mockConfig);
    expect(result).toEqual(['-p', 'do the thing', '-r', 'abc-123']);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm run test:unit -- src/agents/plugins/__tests__/plugin-effort-resume.test.ts
```

Expected: FAIL — `ClaudePluginMetadata.reasoningEffort` is undefined; `--resume` not mapped.

- [ ] **Step 3: Add `reasoningEffort` block and `--resume` mapping to claude plugin**

In `src/agents/plugins/claude/claude.plugin.ts`, the `flagMappings` block is at lines 96–101:

```ts
  flagMappings: {
    '--task': {
      type: 'flag',
      target: '-p',
    },
  },
```

Change to:

```ts
  flagMappings: {
    '--task': {
      type: 'flag',
      target: '-p',
    },
    '--resume': {
      type: 'flag',
      target: '-r',
    },
  },

  reasoningEffort: {
    strategy: 'cli-flag',
    flag: '--effort',
    placement: 'append',
    supportedLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    userOverrideFlags: ['--effort'],
  },
```

You'll need to add the `ReasoningEffortConfig` type import if types.ts doesn't auto-infer — check whether `AgentMetadata` import already covers it. It does: `AgentMetadata` is imported from `types.js`, and `reasoningEffort?: ReasoningEffortConfig` is now part of `AgentMetadata`, so no new import needed.

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm run test:unit -- src/agents/plugins/__tests__/plugin-effort-resume.test.ts
```

Expected: claude tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agents/plugins/claude/claude.plugin.ts src/agents/plugins/__tests__/plugin-effort-resume.test.ts
git commit -m "feat(claude): add reasoningEffort block and --resume flag mapping"
```

---

## Task F6: codex plugin — `reasoningEffort` block + `enrichArgs` resume (TDD)

**Test-first: yes**

**Files:**
- Modify: `src/agents/plugins/codex/codex.plugin.ts`
- Modify: `src/agents/plugins/__tests__/plugin-effort-resume.test.ts`

- [ ] **Step 1: Write failing tests for codex — add to `plugin-effort-resume.test.ts`**

Append to the test file:

```ts
// ── codex ────────────────────────────────────────────────────────────────────

describe('codex plugin — reasoning effort', () => {
  it('prepends --config model_reasoning_effort="high" before exec', () => {
    // enrichArgs transforms ['--task', 'do the thing'] → ['exec', ..., 'do the thing']
    // Then applyReasoningEffort prepends the config flag
    const args = ['exec', 'do the thing']; // post-enrichArgs
    const { args: result } = applyReasoningEffort(
      args, {}, CodexPluginMetadata.reasoningEffort!, 'high', 'codex'
    );
    expect(result[0]).toBe('--config');
    expect(result[1]).toBe('model_reasoning_effort="high"');
    expect(result.slice(2)).toEqual(['exec', 'do the thing']);
  });

  it('clamps max → xhigh for codex', () => {
    const args = ['exec', 'task'];
    const { args: result } = applyReasoningEffort(
      args, {}, CodexPluginMetadata.reasoningEffort!, 'max', 'codex'
    );
    expect(result[1]).toBe('model_reasoning_effort="xhigh"');
  });
});

describe('codex plugin — enrichArgs resume handling', () => {
  const enrichArgs = CodexPluginMetadata.lifecycle!.enrichArgs!;

  it('emits exec resume <id> <task> when --task and --resume are both present', () => {
    const args = ['--task', 'do the thing', '--resume', 'session-123'];
    // Note: enrichArgs may also inject --model, --config flags from config. We only test
    // that the subcommand structure is correct by checking the final slice.
    const result = enrichArgs(args, mockConfig);
    // Find 'exec', 'resume', 'session-123' in order
    const execIdx = result.indexOf('exec');
    expect(execIdx).toBeGreaterThanOrEqual(0);
    expect(result[execIdx + 1]).toBe('resume');
    expect(result[execIdx + 2]).toBe('session-123');
    // Task prompt is last
    expect(result[result.length - 1]).toBe('do the thing');
    // --resume pair is stripped
    expect(result).not.toContain('--resume');
  });

  it('emits resume <id> when --resume present but no --task', () => {
    const args = ['--resume', 'session-456'];
    const result = enrichArgs(args, mockConfig);
    expect(result[0]).toBe('resume');
    expect(result[1]).toBe('session-456');
    expect(result).not.toContain('--resume');
  });

  it('emits exec <task> (no resume) when only --task is present', () => {
    const args = ['--task', 'do the thing'];
    const result = enrichArgs(args, mockConfig);
    const execIdx = result.indexOf('exec');
    expect(execIdx).toBeGreaterThanOrEqual(0);
    // No 'resume' subcommand
    expect(result[execIdx + 1]).not.toBe('resume');
    expect(result[result.length - 1]).toBe('do the thing');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm run test:unit -- src/agents/plugins/__tests__/plugin-effort-resume.test.ts
```

Expected: codex tests fail — `reasoningEffort` undefined, `enrichArgs` doesn't handle `--resume`.

- [ ] **Step 3: Add `reasoningEffort` block to codex plugin metadata**

In `src/agents/plugins/codex/codex.plugin.ts`, add after the `envMapping` block (around line 134) in the metadata object:

```ts
  reasoningEffort: {
    strategy: 'cli-config',
    configFlag: '--config',
    configKey: 'model_reasoning_effort',
    placement: 'prepend',
    supportedLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    userOverrideFlags: ['model_reasoning_effort'],
  },
```

- [ ] **Step 4: Extend `enrichArgs` in codex plugin to handle `--resume`**

The existing `enrichArgs` at line 240 transforms `--task` to `exec <task>`. Replace the task-transform block (lines 243–253) with the new logic that also handles `--resume`:

```ts
    enrichArgs(args: string[], config: AgentConfig) {
      let enriched = args;

      // 1. Handle --resume and --task together to build the correct subcommand.
      const resumeIdx = enriched.indexOf('--resume');
      const resumeId = resumeIdx !== -1 && resumeIdx < enriched.length - 1
        ? enriched[resumeIdx + 1]
        : undefined;

      // Strip --resume <id> pair before subcommand construction
      if (resumeId) {
        enriched = [...enriched.slice(0, resumeIdx), ...enriched.slice(resumeIdx + 2)];
      }

      const taskIndex = enriched.indexOf('--task');
      if (taskIndex !== -1 && taskIndex < enriched.length - 1) {
        const taskValue = enriched[taskIndex + 1];
        const rest = [...enriched.slice(0, taskIndex), ...enriched.slice(taskIndex + 2)];
        const head = resumeId ? ['exec', 'resume', resumeId] : ['exec'];
        enriched = [...head, ...rest, taskValue];
      } else if (resumeId) {
        // Interactive resume: no --task present
        enriched = ['resume', resumeId, ...enriched.filter(a => a !== '--resume')];
      }
      // else: no --task, no --resume → existing interactive behavior (unchanged)

      // 2–4: model injection, custom provider, session tuning (unchanged below)
```

Keep steps 2–4 exactly as they were.

- [ ] **Step 5: Run tests to confirm they pass**

```bash
npm run test:unit -- src/agents/plugins/__tests__/plugin-effort-resume.test.ts
```

Expected: all codex tests pass. Existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/agents/plugins/codex/codex.plugin.ts src/agents/plugins/__tests__/plugin-effort-resume.test.ts
git commit -m "feat(codex): add reasoningEffort block and enrich enrichArgs for --resume subcommand routing"
```

---

## Task F7: opencode plugin — `reasoningEffort` block + `--resume` flag mapping (TDD)

**Test-first: yes**

**Files:**
- Modify: `src/agents/plugins/opencode/opencode.plugin.ts`
- Modify: `src/agents/plugins/__tests__/plugin-effort-resume.test.ts`

- [ ] **Step 1: Write failing tests — append to `plugin-effort-resume.test.ts`**

```ts
// ── opencode ─────────────────────────────────────────────────────────────────

describe('opencode plugin — reasoning effort', () => {
  it('appends --variant high after enrichArgs (run <task>) transform', () => {
    // Simulate: enrichArgs produces ['run', 'task'], then applyReasoningEffort appends
    const args = ['run', 'do the thing'];
    const env: NodeJS.ProcessEnv = {};
    const { args: result } = applyReasoningEffort(
      args, env, OpenCodePluginMetadata.reasoningEffort!, 'high', 'opencode'
    );
    expect(result).toEqual(['run', 'do the thing', '--variant', 'high']);
  });

  it('passes max through unchanged for opencode (all levels supported)', () => {
    const { args: result } = applyReasoningEffort(
      ['run', 'task'], {}, OpenCodePluginMetadata.reasoningEffort!, 'max', 'opencode'
    );
    expect(result).toContain('max');
  });
});

describe('opencode plugin — --resume flag mapping', () => {
  it('maps --resume <id> to -s <id>', () => {
    const args = ['run', 'task', '--resume', 'sess-abc'];
    const result = transformFlags(args, OpenCodePluginMetadata.flagMappings!, mockConfig);
    expect(result).toEqual(['run', 'task', '-s', 'sess-abc']);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm run test:unit -- src/agents/plugins/__tests__/plugin-effort-resume.test.ts
```

Expected: opencode tests fail.

- [ ] **Step 3: Add `reasoningEffort` block and `flagMappings` to opencode plugin**

In `src/agents/plugins/opencode/opencode.plugin.ts`, find `OpenCodePluginMetadata` (line 17). Add inside the metadata object:

```ts
  flagMappings: {
    '--resume': {
      type: 'flag',
      target: '-s',
    },
  },

  reasoningEffort: {
    strategy: 'cli-flag',
    flag: '--variant',
    placement: 'append',
    supportedLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    userOverrideFlags: ['--variant'],
  },
```

**Placement matters:** put these after `envMapping` (lines 29–33) and before the `lifecycle` key, so they don't conflict with the existing lifecycle structure.

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm run test:unit -- src/agents/plugins/__tests__/plugin-effort-resume.test.ts
```

Expected: all opencode tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agents/plugins/opencode/opencode.plugin.ts src/agents/plugins/__tests__/plugin-effort-resume.test.ts
git commit -m "feat(opencode): add reasoningEffort block and --resume → -s flag mapping"
```

---

## Task F8: kimi plugin — `reasoningEffort` block + `--resume` flag mapping (TDD)

**Test-first: yes**

**Files:**
- Modify: `src/agents/plugins/kimi/kimi.plugin.ts`
- Modify: `src/agents/plugins/__tests__/plugin-effort-resume.test.ts`

- [ ] **Step 1: Write failing tests — append to `plugin-effort-resume.test.ts`**

```ts
// ── kimi ─────────────────────────────────────────────────────────────────────

describe('kimi plugin — reasoning effort (env strategy)', () => {
  it('sets all four KIMI_MODEL_THINKING_* env vars', () => {
    const args = ['-p', 'do the thing'];
    const env: NodeJS.ProcessEnv = {};
    const { args: resultArgs } = applyReasoningEffort(
      args, env, KimiPluginMetadata.reasoningEffort!, 'high', 'kimi'
    );
    expect(resultArgs).toEqual(['-p', 'do the thing']); // args unchanged
    expect(env.KIMI_MODEL_THINKING_MODE).toBe('on');
    expect(env.KIMI_MODEL_THINKING_EFFORT).toBe('high');
    expect(env.KIMI_MODEL_CAPABILITIES).toBe('thinking');
    expect(env.KIMI_MODEL_DEFAULT_THINKING).toBe('true');
  });

  it('clamps minimal → low for kimi', () => {
    const env: NodeJS.ProcessEnv = {};
    applyReasoningEffort(['-p', 'task'], env, KimiPluginMetadata.reasoningEffort!, 'minimal', 'kimi');
    expect(env.KIMI_MODEL_THINKING_EFFORT).toBe('low');
  });
});

describe('kimi plugin — --resume flag mapping', () => {
  it('maps --resume <id> to -S <id>', () => {
    const args = ['-p', 'task', '--resume', 'sess-xyz'];
    const result = transformFlags(args, KimiPluginMetadata.flagMappings!, mockConfig);
    expect(result).toEqual(['-p', 'task', '-S', 'sess-xyz']);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm run test:unit -- src/agents/plugins/__tests__/plugin-effort-resume.test.ts
```

Expected: kimi tests fail.

- [ ] **Step 3: Add `reasoningEffort` block and `--resume` mapping to kimi plugin**

In `src/agents/plugins/kimi/kimi.plugin.ts`, the `flagMappings` block is at lines 55–58:

```ts
  flagMappings: {
    '--task': { type: 'flag', target: '-p' },
    '--model': { type: 'flag', target: '--model' },
  },
```

Change to:

```ts
  flagMappings: {
    '--task': { type: 'flag', target: '-p' },
    '--model': { type: 'flag', target: '--model' },
    '--resume': { type: 'flag', target: '-S' },
  },

  reasoningEffort: {
    strategy: 'env',
    envVars: {
      KIMI_MODEL_THINKING_MODE: 'on',
      KIMI_MODEL_THINKING_EFFORT: '%s',
      KIMI_MODEL_CAPABILITIES: 'thinking',
      KIMI_MODEL_DEFAULT_THINKING: 'true',
    },
    supportedLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm run test:unit -- src/agents/plugins/__tests__/plugin-effort-resume.test.ts
```

Expected: all kimi tests pass. All prior plugin tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/agents/plugins/kimi/kimi.plugin.ts src/agents/plugins/__tests__/plugin-effort-resume.test.ts
git commit -m "feat(kimi): add reasoningEffort env bundle and --resume → -S flag mapping"
```

---

## Task F9: Full test suite + typecheck + build

**Test-first: no** — this is a validation task.

**Files:** none new.

- [ ] **Step 1: Run the full unit test suite**

```bash
npm run test:unit
```

Expected: all tests pass. If any existing test fails due to a changed import or type, fix it now.

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: zero errors. Common issues to watch for:
- `CanonicalReasoningEffort` import cycles between `types.ts` and `env/types.ts` — if one exists, forward-declare in `env/types.ts` as a local literal union type instead of importing.
- `reasoningEffort` field in `CodeMieConfigOptions` — `CodeMieConfigOptions = ProviderProfile`, so `ConfigLoader.load` should accept it after Step F3.

- [ ] **Step 3: Run build**

```bash
npm run build
```

Expected: zero errors. The `dist/` directory should contain the compiled output.

- [ ] **Step 4: Spot-check the compiled output**

```bash
node -e "import('./dist/agents/core/reasoning-effort.js').then(m => console.log(Object.keys(m)))"
```

Expected output contains: `CANONICAL_EFFORT_ORDER normalizeReasoningEffort clampToSupported applyReasoningEffort`.

- [ ] **Step 5: Commit planning artifacts (CI requirement)**

```bash
git add docs/superpowers/specs/2026-06-17-unified-headless-sessions-design.md docs/superpowers/plans/2026-06-17-unified-headless-sessions.md docs/superpowers/runs/
git commit -m "chore: add SDLC planning artifacts for unified-headless-sessions"
```

---

## Acceptance criteria checklist

After F9, verify manually or via your test assertions:

- [ ] `CANONICAL_EFFORT_ORDER` = `['minimal','low','medium','high','xhigh','max']`
- [ ] `normalizeReasoningEffort('HIGH')` = `'high'`; `normalizeReasoningEffort('ultra')` = `undefined`
- [ ] `clampToSupported('minimal', ['low','medium','high','xhigh','max'])` = `'low'` (claude/kimi)
- [ ] `clampToSupported('max', ['minimal','low','medium','high','xhigh'])` = `'xhigh'` (codex)
- [ ] claude: `applyReasoningEffort(['-p','T'], {}, claudeConfig, 'high', 'claude')` = `{args: ['-p','T','--effort','high']}`
- [ ] codex: `applyReasoningEffort(['exec','T'], {}, codexConfig, 'high', 'codex')` = `{args: ['--config','model_reasoning_effort="high"','exec','T']}`
- [ ] opencode: `applyReasoningEffort(['run','T'], {}, opencodeConfig, 'high', 'opencode')` = `{args: ['run','T','--variant','high']}`
- [ ] kimi: env vars `KIMI_MODEL_THINKING_MODE=on`, `KIMI_MODEL_THINKING_EFFORT=high`, `KIMI_MODEL_CAPABILITIES=thinking`, `KIMI_MODEL_DEFAULT_THINKING=true` are set; args unchanged
- [ ] codex `enrichArgs(['--task','T','--resume','id'], config)` → contains `exec resume id T` in order
- [ ] codex `enrichArgs(['--resume','id'], config)` → starts with `resume id`
- [ ] claude `transformFlags(['--resume','abc'], mapping)` → `['-r','abc']`
- [ ] opencode `transformFlags(['--resume','abc'], mapping)` → `['-s','abc']`
- [ ] kimi `transformFlags(['--resume','abc'], mapping)` → `['-S','abc']`
- [ ] `exportProviderEnvVars({reasoningEffort:'high',...})` → `env.CODEMIE_REASONING_EFFORT = 'high'`
- [ ] `exportProviderEnvVars({...})` (no effort) → `env.CODEMIE_REASONING_EFFORT` is undefined

---

## Open verification item (post-implementation)

**Q4 — Kimi env bundle sufficiency:** Run one live session after implementation:

```bash
codemie-kimi --reasoning-effort high --task "list the files in the current directory and tell me your thinking process"
```

Inspect whether the response contains reasoning/thinking content. If thinking does not activate, add `KIMI_MODEL_PROVIDER_TYPE` and/or `KIMI_MODEL_MAX_CONTEXT_SIZE` to the `envVars` block in `kimi.plugin.ts` and rerun.
