# Kimi Code Agent Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class `kimi` agent plugin (and `kimi-acp` variant) to CodeMie Code that runs Kimi Code CLI through the user's own Moonshot subscription and syncs metrics to CodeMie via existing `codemie hook` infrastructure.

**Architecture:** Mirror the `anthropic-subscription` + `GeminiHookTransformer` patterns. Hook injection and env cleanup live in the provider wildcard `beforeRun`; the agent supplies a `HookTransformer` and `SessionAdapter`; `AgentCLI` is updated to know about the new agents.

**Tech Stack:** TypeScript 5.3+, Node.js 20+, Vitest, Commander.js, TOML (for Kimi config), npm.

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `src/providers/plugins/moonshot-subscription/moonshot-subscription.template.ts` | Provider template: `authType: 'none'`, env exports, wildcard `beforeRun` hook. |
| `src/providers/plugins/moonshot-subscription/moonshot-subscription.setup-steps.ts` | Interactive setup: verify `kimi`, optionally enable CodeMie analytics, build config. |
| `src/providers/plugins/moonshot-subscription/index.ts` | Barrel export. |
| `src/agents/plugins/kimi/kimi.paths.ts` | Path helpers for `~/.kimi-code/` and session directories. |
| `src/agents/plugins/kimi/kimi.hook-config-injector.ts` | Idempotently inject CodeMie hooks into `~/.kimi-code/config.toml`. |
| `src/agents/plugins/kimi/kimi.hook-transformer.ts` | Transform Kimi hook payloads to internal `BaseHookEvent` format. |
| `src/agents/plugins/kimi/kimi.session.ts` | Discover and parse Kimi `wire.jsonl` sessions. |
| `src/agents/plugins/kimi/session/processors/kimi.metrics-processor.ts` | Extract `MetricDelta`s from parsed Kimi sessions. |
| `src/agents/plugins/kimi/kimi.extension-installer.ts` | Install CodeMie Kimi skills to `~/.kimi-code/skills/`. |
| `src/agents/plugins/kimi/kimi.plugin.ts` | Main `KimiPlugin` adapter and metadata. |
| `src/agents/plugins/kimi/kimi-acp.plugin.ts` | ACP variant (`cliCommand: 'kimi'`, `enrichArgs` prepends `acp`). |
| `bin/codemie-kimi.js` | Thin CLI entry point for the main agent. |
| `bin/codemie-kimi-acp.js` | Thin CLI entry point for the ACP variant. |

### Modified files

| File | Change |
|---|---|
| `src/agents/core/types.ts` | Add `hookConfig?: { eventNameMapping?: Record<string, string> }` to `AgentMetadata` so `GeminiPluginMetadata` and `KimiPluginMetadata` are typed. |
| `src/agents/core/AgentCLI.ts:456` | Add `kimi` and `kimi-acp` to `getAgentMetadata()` map (or refactor to read from adapter). |
| `src/agents/registry.ts` | Register `KimiPlugin` and `KimiAcpPlugin`. |
| `src/providers/index.ts` | Import moonshot-subscription provider for side-effect registration. |
| `package.json` | Add `codemie-kimi` and `codemie-kimi-acp` to `bin`. |
| `src/agents/__tests__/registry.test.ts` | Update agent count and add assertions for `kimi`/`kimi-acp`. |

---

## Task 0: Pre-Implementation Analysis

Before writing any implementation code, inspect the real Kimi Code CLI to confirm formats.

**Files:** none (exploration only)

- [ ] **Step 0.1: Clone Kimi Code CLI source or inspect an installed binary**

Run:
```bash
# Option A: clone source
rtk git clone https://github.com/MoonshotAI/kimi-code.git /tmp/kimi-code-source

# Option B: install binary (if Node ≥ 22.19.0)
npm install -g @moonshot-ai/kimi-code
```

- [ ] **Step 0.2: Capture hook payload samples**

Create a test hook script and add it to `~/.kimi-code/config.toml`:
```toml
[[hooks]]
event = "SessionStart"
command = "tee /tmp/kimi-session-start.json"
timeout = 5

[[hooks]]
event = "Stop"
command = "tee /tmp/kimi-stop.json"
timeout = 5

[[hooks]]
event = "UserPromptSubmit"
command = "tee /tmp/kimi-user-prompt.json"
timeout = 2
```

Run `kimi -p "hello"` in a test project and inspect `/tmp/kimi-*.json`.
Expected output: JSON files with base fields `hook_event_name`, `session_id`, `cwd` plus event-specific fields.

- [ ] **Step 0.3: Inspect `wire.jsonl` schema**

Locate the latest session directory:
```bash
ls -la ~/.kimi-code/sessions/*/*/
```

Read `agents/main/wire.jsonl` and identify:
- Message/event entry types
- Tool call fields (name, input, output, status)
- File operation fields
- Model name location

- [ ] **Step 0.4: Confirm work-dir key encoding**

Compare the directory name under `~/.kimi-code/sessions/` with the sha256 of the project path to confirm `wd_<slug>_<first-12-chars-of-sha256>`.

---

## Task 1: Add `hookConfig` to `AgentMetadata`

`GeminiPluginMetadata` already uses `hookConfig.eventNameMapping`, but the field is not declared in `AgentMetadata`. Add it so TypeScript accepts it for Kimi too.

**Files:**
- Modify: `src/agents/core/types.ts:296`

- [ ] **Step 1.1: Write the failing type-check scenario**

Create a temporary type test file:
```typescript
// /tmp/type-test.ts (delete after verification)
import type { AgentMetadata } from './src/agents/core/types.js';

const meta: AgentMetadata = {
  hookConfig: {
    eventNameMapping: {
      'PostCompact': 'PreCompact',
    },
  },
} as any;
```

Run:
```bash
npx tsc --noEmit /tmp/type-test.ts
```

Expected: error because `hookConfig` is not in `AgentMetadata`.

- [ ] **Step 1.2: Add the type declaration**

Edit `src/agents/core/types.ts` and insert after `extensionsConfig?: AgentExtensionsConfig;` (around line 296):

```typescript
  // === Hook Configuration ===
  /**
   * Hook event name mapping for agents whose native hook names differ
   * from the internal names used by src/cli/commands/hook.ts.
   */
  hookConfig?: {
    eventNameMapping?: Record<string, string>;
  };
```

- [ ] **Step 1.3: Re-run type check**

```bash
npx tsc --noEmit /tmp/type-test.ts
```

Expected: no error.

- [ ] **Step 1.4: Run the project type check**

```bash
npm run build
```

Expected: passes.

- [ ] **Step 1.5: Commit**

```bash
git add src/agents/core/types.ts
rtk git commit -m "feat(kimi): add hookConfig to AgentMetadata type"
```

---

## Task 2: Kimi Path Helpers

Create utility functions for Kimi data directory paths.

**Files:**
- Create: `src/agents/plugins/kimi/kimi.paths.ts`
- Test: `src/agents/plugins/kimi/__tests__/kimi.paths.test.ts`

- [ ] **Step 2.1: Write the failing test**

Create `src/agents/plugins/kimi/__tests__/kimi.paths.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { getKimiCodeHome, getKimiSessionsDir, getKimiSessionDir, getKimiMainWirePath } from '../kimi.paths.js';

describe('kimi.paths', () => {
  it('returns default home from env', () => {
    const home = getKimiCodeHome();
    expect(home).toMatch(/\.kimi-code$/);
  });

  it('respects KIMI_CODE_HOME', () => {
    process.env.KIMI_CODE_HOME = '/tmp/kimi-test';
    const home = getKimiCodeHome();
    expect(home).toBe('/tmp/kimi-test');
    delete process.env.KIMI_CODE_HOME;
  });

  it('computes session directory from cwd and session id', () => {
    const dir = getKimiSessionDir('/tmp/my-project', 'sess-123');
    expect(dir).toContain('sess-123');
  });

  it('returns main wire path', () => {
    const path = getKimiMainWirePath('/tmp/my-project', 'sess-123');
    expect(path).toMatch(/agents\/main\/wire\.jsonl$/);
  });
});
```

Run:
```bash
npx vitest run src/agents/plugins/kimi/__tests__/kimi.paths.test.ts
```

Expected: FAIL (modules not found).

- [ ] **Step 2.2: Implement path helpers**

Create `src/agents/plugins/kimi/kimi.paths.ts`:
```typescript
import { homedir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

export function getKimiCodeHome(): string {
  return process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code');
}

export function getKimiConfigPath(): string {
  return join(getKimiCodeHome(), 'config.toml');
}

export function getKimiSessionsDir(): string {
  return join(getKimiCodeHome(), 'sessions');
}

export function encodeKimiWorkDirKey(cwd: string): string {
  const normalized = cwd.trim().toLowerCase();
  const slug = normalized.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20) || 'project';
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return `wd_${slug}_${hash}`;
}

export function getKimiSessionDir(cwd: string, sessionId: string): string {
  return join(getKimiSessionsDir(), encodeKimiWorkDirKey(cwd), sessionId);
}

export function getKimiMainWirePath(cwd: string, sessionId: string): string {
  return join(getKimiSessionDir(cwd, sessionId), 'agents', 'main', 'wire.jsonl');
}

export function getKimiUserSkillsDir(): string {
  return join(getKimiCodeHome(), 'skills');
}
```

- [ ] **Step 2.3: Run the tests**

```bash
npx vitest run src/agents/plugins/kimi/__tests__/kimi.paths.test.ts
```

Expected: PASS.

- [ ] **Step 2.4: Commit**

```bash
git add src/agents/plugins/kimi/kimi.paths.ts src/agents/plugins/kimi/__tests__/kimi.paths.test.ts
rtk git commit -m "feat(kimi): add path helpers for Kimi data directories"
```

---

## Task 3: Kimi Hook Config Injector

Create the component that idempotently edits `~/.kimi-code/config.toml` to add CodeMie hooks.

**Files:**
- Create: `src/agents/plugins/kimi/kimi.hook-config-injector.ts`
- Test: `src/agents/plugins/kimi/__tests__/kimi.hook-config-injector.test.ts`

- [ ] **Step 3.1: Check for an existing TOML parser in the project**

Run:
```bash
rtk grep -E "@iarna/toml|smol-toml|toml" package.json
```

If none found, the plan will install `@iarna/toml`.

- [ ] **Step 3.2: Write the failing test**

Create `src/agents/plugins/kimi/__tests__/kimi.hook-config-injector.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { KimiHookConfigInjector } from '../kimi.hook-config-injector.js';

describe('KimiHookConfigInjector', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kimi-hooks-'));
    process.env.KIMI_CODE_HOME = tmpDir;
  });

  afterEach(() => {
    delete process.env.KIMI_CODE_HOME;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates config.toml with CodeMie hooks when none exists', async () => {
    const injector = new KimiHookConfigInjector();
    const result = await injector.inject();

    expect(result.success).toBe(true);
    expect(result.created).toBe(true);
    expect(existsSync(join(tmpDir, 'config.toml'))).toBe(true);

    const content = readFileSync(join(tmpDir, 'config.toml'), 'utf-8');
    expect(content).toContain('[[hooks]]');
    expect(content).toContain('command = "codemie hook"');
    expect(content).toContain('event = "SessionStart"');
  });

  it('is idempotent across multiple injections', async () => {
    const injector = new KimiHookConfigInjector();
    await injector.inject();
    await injector.inject();

    const content = readFileSync(join(tmpDir, 'config.toml'), 'utf-8');
    const matches = content.match(/command = "codemie hook"/g) || [];
    expect(matches.length).toBe(6); // one per configured event
  });

  it('backs up existing config before first modification', async () => {
    const configPath = join(tmpDir, 'config.toml');
    writeFileSync(configPath, 'default_model = "test"\n', 'utf-8');

    const injector = new KimiHookConfigInjector();
    await injector.inject();

    expect(existsSync(`${configPath}.codemie-backup`)).toBe(true);
    const content = readFileSync(configPath, 'utf-8');
    expect(content).toContain('default_model = "test"');
    expect(content).toContain('[[hooks]]');
  });
});
```

Run:
```bash
npx vitest run src/agents/plugins/kimi/__tests__/kimi.hook-config-injector.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3.3: Install TOML parser if needed**

If no TOML parser exists:
```bash
npm install @iarna/toml
```

- [ ] **Step 3.4: Implement the injector**

Create `src/agents/plugins/kimi/kimi.hook-config-injector.ts`:
```typescript
import { readFile, writeFile, access, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import { getKimiConfigPath } from './kimi.paths.js';
import { logger } from '../../../utils/logger.js';

// Dynamic import avoids failing if the package is not present
const loadToml = async () => {
  try {
    return await import('@iarna/toml');
  } catch {
    throw new Error('TOML parser @iarna/toml is required for Kimi hook injection. Run: npm install @iarna/toml');
  }
};

export interface HookInjectionResult {
  success: boolean;
  created: boolean;
  configPath: string;
  error?: string;
}

const CODEMIE_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'PreCompact',
];

const MANAGED_MARKER = '# CodeMie-managed hooks - do not edit manually';

export class KimiHookConfigInjector {
  async inject(): Promise<HookInjectionResult> {
    const configPath = getKimiConfigPath();

    try {
      let existingContent = '';
      let created = false;

      if (existsSync(configPath)) {
        existingContent = await readFile(configPath, 'utf-8');
      } else {
        created = true;
      }

      if (this.hasManagedHooks(existingContent)) {
        logger.debug('[kimi-hook-injector] CodeMie hooks already present, skipping injection');
        return { success: true, created: false, configPath };
      }

      if (!created) {
        await copyFile(configPath, `${configPath}.codemie-backup`);
      }

      const toml = await loadToml();
      const parsed: any = existingContent ? toml.parse(existingContent) : {};
      parsed.hooks = parsed.hooks || [];

      for (const event of CODEMIE_HOOK_EVENTS) {
        parsed.hooks.push({
          event,
          command: 'codemie hook',
          timeout: event === 'SessionEnd' ? 10 : 5,
        });
      }

      const output = toml.stringify(parsed);
      const markedOutput = `${MANAGED_MARKER}\n${output}`;
      await writeFile(configPath, markedOutput, 'utf-8');

      logger.info(`[kimi-hook-injector] Injected CodeMie hooks into ${configPath}`);
      return { success: true, created, configPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[kimi-hook-injector] Failed to inject hooks: ${message}`);
      return { success: false, created: false, configPath, error: message };
    }
  }

  async restore(): Promise<void> {
    const configPath = getKimiConfigPath();
    const backupPath = `${configPath}.codemie-backup`;

    if (existsSync(backupPath)) {
      await copyFile(backupPath, configPath);
      logger.info(`[kimi-hook-injector] Restored original ${configPath}`);
    }
  }

  private hasManagedHooks(content: string): boolean {
    return content.includes(MANAGED_MARKER);
  }
}
```

- [ ] **Step 3.5: Run the tests**

```bash
npx vitest run src/agents/plugins/kimi/__tests__/kimi.hook-config-injector.test.ts
```

Expected: PASS.

- [ ] **Step 3.6: Commit**

```bash
git add src/agents/plugins/kimi/kimi.hook-config-injector.ts src/agents/plugins/kimi/__tests__/kimi.hook-config-injector.test.ts package.json package-lock.json
rtk git commit -m "feat(kimi): add hook config injector for ~/.kimi-code/config.toml"
```

---

## Task 4: Kimi Hook Transformer

Create the transformer that maps Kimi hook payloads to internal `BaseHookEvent` format.

**Files:**
- Create: `src/agents/plugins/kimi/kimi.hook-transformer.ts`
- Test: `src/agents/plugins/kimi/__tests__/kimi.hook-transformer.test.ts`

- [ ] **Step 4.1: Write the failing test**

Create `src/agents/plugins/kimi/__tests__/kimi.hook-transformer.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { KimiHookTransformer } from '../kimi.hook-transformer.js';

describe('KimiHookTransformer', () => {
  const transformer = new KimiHookTransformer();

  it('transforms SessionStart payload', () => {
    const input = {
      hook_event_name: 'SessionStart',
      session_id: 'sess-123',
      cwd: '/tmp/my-project',
      source: 'startup',
    };

    const result = transformer.transform(input);

    expect(result.hook_event_name).toBe('SessionStart');
    expect(result.session_id).toBe('sess-123');
    expect(result.cwd).toBe('/tmp/my-project');
    expect(result.source).toBe('startup');
    expect(result.permission_mode).toBe('default');
    expect(result.transcript_path).toMatch(/agents\/main\/wire\.jsonl$/);
  });

  it('transforms Stop payload', () => {
    const input = {
      hook_event_name: 'Stop',
      session_id: 'sess-123',
      cwd: '/tmp/my-project',
    };

    const result = transformer.transform(input);
    expect(result.hook_event_name).toBe('Stop');
    expect(result.transcript_path).toMatch(/sess-123\/agents\/main\/wire\.jsonl$/);
  });

  it('preserves unknown event names', () => {
    const input = {
      hook_event_name: 'PostToolUse',
      session_id: 'sess-123',
      cwd: '/tmp/my-project',
    };

    const result = transformer.transform(input);
    expect(result.hook_event_name).toBe('PostToolUse');
  });
});
```

Run:
```bash
npx vitest run src/agents/plugins/kimi/__tests__/kimi.hook-transformer.test.ts
```

Expected: FAIL.

- [ ] **Step 4.2: Implement the transformer**

Create `src/agents/plugins/kimi/kimi.hook-transformer.ts`:
```typescript
import type { HookTransformer, BaseHookEvent } from '../../core/types.js';
import { getKimiMainWirePath } from './kimi.paths.js';

export class KimiHookTransformer implements HookTransformer {
  readonly agentName = 'kimi';

  transform(event: unknown): BaseHookEvent {
    const raw = event as Record<string, unknown>;
    const sessionId = String(raw.session_id ?? '');
    const cwd = String(raw.cwd ?? process.cwd());

    const transformed: BaseHookEvent = {
      hook_event_name: String(raw.hook_event_name ?? ''),
      session_id: sessionId,
      transcript_path: sessionId ? getKimiMainWirePath(cwd, sessionId) : '',
      permission_mode: 'default',
      cwd,
      ...(raw.source && { source: String(raw.source) }),
      ...(raw.reason && { reason: String(raw.reason) }),
    };

    return transformed;
  }
}
```

- [ ] **Step 4.3: Run the tests**

```bash
npx vitest run src/agents/plugins/kimi/__tests__/kimi.hook-transformer.test.ts
```

Expected: PASS.

- [ ] **Step 4.4: Commit**

```bash
git add src/agents/plugins/kimi/kimi.hook-transformer.ts src/agents/plugins/kimi/__tests__/kimi.hook-transformer.test.ts
rtk git commit -m "feat(kimi): add hook payload transformer"
```

---

## Task 5: Moonshot Subscription Provider

Implement the provider that enables native Kimi subscription auth and analytics sync.

**Files:**
- Create: `src/providers/plugins/moonshot-subscription/moonshot-subscription.template.ts`
- Create: `src/providers/plugins/moonshot-subscription/moonshot-subscription.setup-steps.ts`
- Create: `src/providers/plugins/moonshot-subscription/index.ts`
- Test: `src/providers/plugins/moonshot-subscription/__tests__/moonshot-subscription.template.test.ts`

- [ ] **Step 5.1: Write the provider template test**

Create `src/providers/plugins/moonshot-subscription/__tests__/moonshot-subscription.template.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { MoonshotSubscriptionTemplate } from '../moonshot-subscription.template.js';

describe('MoonshotSubscriptionTemplate', () => {
  it('has authType none and requires no auth', () => {
    expect(MoonshotSubscriptionTemplate.requiresAuth).toBe(false);
    expect(MoonshotSubscriptionTemplate.authType).toBe('none');
  });

  it('exports empty api key and codemie urls', () => {
    const env = MoonshotSubscriptionTemplate.exportEnvVars!({
      codeMieUrl: 'https://codemie.example.com',
      codeMieProject: 'my-project',
    } as any);

    expect(env.CODEMIE_API_KEY).toBe('');
    expect(env.CODEMIE_URL).toBe('https://codemie.example.com');
    expect(env.CODEMIE_SYNC_API_URL).toBe('https://codemie.example.com/api/');
    expect(env.CODEMIE_PROJECT).toBe('my-project');
  });

  it('has recommended models', () => {
    expect(MoonshotSubscriptionTemplate.recommendedModels.length).toBeGreaterThan(0);
  });
});
```

Run:
```bash
npx vitest run src/providers/plugins/moonshot-subscription/__tests__/moonshot-subscription.template.test.ts
```

Expected: FAIL.

- [ ] **Step 5.2: Implement the provider template**

Create `src/providers/plugins/moonshot-subscription/moonshot-subscription.template.ts`:
```typescript
import type { ProviderTemplate } from '../../core/types.js';
import type { AgentConfig } from '../../../agents/core/types.js';
import { registerProvider } from '../../core/decorators.js';
import { ensureApiBase } from '../../core/codemie-auth-helpers.js';

const MOONSHOT_SUBSCRIPTION_DEFAULT_MODEL = 'kimi-for-coding';

export const MoonshotSubscriptionTemplate = registerProvider<ProviderTemplate>({
  name: 'moonshot-subscription',
  displayName: 'Moonshot Subscription',
  description: 'Native Kimi Code CLI authentication using your Moonshot subscription',
  defaultBaseUrl: 'https://api.moonshot.ai/v1',
  requiresAuth: false,
  authType: 'none',
  priority: 16,
  defaultProfileName: 'moonshot-subscription',
  recommendedModels: [
    MOONSHOT_SUBSCRIPTION_DEFAULT_MODEL,
    'kimi-k2',
  ],
  capabilities: ['streaming', 'tools', 'function-calling', 'vision'],
  supportsModelInstallation: false,
  supportsStreaming: true,

  agentHooks: {
    '*': {
      async beforeRun(env: NodeJS.ProcessEnv, config: AgentConfig): Promise<NodeJS.ProcessEnv> {
        if (config.agent !== 'kimi') {
          return env;
        }

        const updated = { ...env };

        // Native Kimi subscription auth relies on ~/.kimi-code/config.toml (written by /login).
        // Explicit env vars override that flow.
        delete updated.KIMI_MODEL_API_KEY;
        delete updated.KIMI_MODEL_BASE_URL;
        delete updated.KIMI_MODEL_NAME;

        try {
          const { AgentRegistry } = await import('../../../agents/registry.js');
          const agent = AgentRegistry.getAgent('kimi');
          const injectorType = agent?.metadata?.name === 'kimi'
            ? await import('../../../agents/plugins/kimi/kimi.hook-config-injector.js')
            : null;

          if (injectorType) {
            const injector = new injectorType.KimiHookConfigInjector();
            await injector.inject();
          }
        } catch (error) {
          const { logger } = await import('../../../utils/logger.js');
          const msg = error instanceof Error ? error.message : String(error);
          logger.error(`[moonshot-subscription] Hook injection failed: ${msg}`);
          logger.warn('[moonshot-subscription] Continuing without hooks - metrics may not be captured');
        }

        return updated;
      }
    }
  },

  exportEnvVars: (config) => {
    const env: Record<string, string> = {
      CODEMIE_API_KEY: '',
    };

    if (config.codeMieUrl) {
      env.CODEMIE_URL = config.codeMieUrl;
      env.CODEMIE_SYNC_API_URL = ensureApiBase(config.codeMieUrl);
    }
    if (config.codeMieProject) {
      env.CODEMIE_PROJECT = config.codeMieProject;
    }

    return env;
  },

  setupInstructions: `
# Moonshot Subscription Setup Instructions

Use this option when Kimi Code CLI is authenticated with your Moonshot account and you want CodeMie to use that native login flow directly.

## Prerequisites

1. Install Kimi Code CLI
2. Run \`kimi\` and authenticate with \`/login\`

## Notes

- No API key is stored in CodeMie for this provider.
- Kimi Code CLI reads credentials from \`~/.kimi-code/config.toml\`.
- CodeMie injects lifecycle hooks into Kimi config to capture metrics.
`
});
```

- [ ] **Step 5.3: Implement setup steps**

Create `src/providers/plugins/moonshot-subscription/moonshot-subscription.setup-steps.ts`:
```typescript
import inquirer from 'inquirer';
import type { ProviderCredentials, ProviderSetupSteps } from '../../core/types.js';
import { ProviderRegistry } from '../../core/registry.js';
import type { CodeMieConfigOptions } from '../../../env/types.js';
import { logger } from '../../../utils/logger.js';
import { ConfigurationError } from '../../../utils/errors.js';
import { MoonshotSubscriptionTemplate } from './moonshot-subscription.template.js';
import {
  DEFAULT_CODEMIE_BASE_URL,
  authenticateWithCodeMie,
  promptForCodeMieUrl,
  selectCodeMieProject
} from '../../core/codemie-auth-helpers.js';
import { commandExists } from '../../../utils/processes.js';

export const MoonshotSubscriptionSetupSteps: ProviderSetupSteps = {
  name: 'moonshot-subscription',

  async getCredentials(_isUpdate = false): Promise<ProviderCredentials> {
    logger.info('Moonshot Subscription Setup');
    logger.info('This provider uses Kimi Code CLI native authentication.');
    logger.info('CodeMie will not store a Moonshot API key for this profile.');

    const kimiInstalled = await commandExists('kimi');
    if (!kimiInstalled) {
      throw new ConfigurationError('Kimi Code CLI is not installed. Run `codemie install kimi` first.');
    }

    logger.info('Make sure you have run `kimi` and authenticated with `/login`.');

    const answers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'enableCodeMieAnalytics',
        message: 'Login to CodeMie platform to enable analytics sync?',
        default: false
      }
    ]);

    let codeMieUrl: string | undefined;
    let codeMieProject: string | undefined;
    let userEmail: string | undefined;

    if (answers.enableCodeMieAnalytics) {
      codeMieUrl = await promptForCodeMieUrl(
        DEFAULT_CODEMIE_BASE_URL,
        'CodeMie platform URL for analytics sync:'
      );

      logger.info('Authenticating to CodeMie platform...');
      const authResult = await authenticateWithCodeMie(codeMieUrl, 120000);

      if (!authResult.success) {
        throw new ConfigurationError(`CodeMie authentication failed: ${authResult.error || 'Unknown error'}`);
      }

      logger.success('CodeMie authentication successful');
      logger.info('Fetching available projects...');
      ({ project: codeMieProject, userEmail } = await selectCodeMieProject(authResult));
      logger.success('Analytics sync enabled for CodeMie platform');
    }

    return {
      baseUrl: MoonshotSubscriptionTemplate.defaultBaseUrl,
      apiKey: '',
      additionalConfig: {
        authMethod: 'manual',
        codeMieUrl,
        codeMieProject,
        userEmail
      }
    };
  },

  async fetchModels(_credentials: ProviderCredentials): Promise<string[]> {
    return [...MoonshotSubscriptionTemplate.recommendedModels];
  },

  async selectModel(
    credentials: ProviderCredentials,
    models: string[]
  ): Promise<string | null> {
    if (credentials.additionalConfig?.codeMieUrl) {
      return models[0] || MoonshotSubscriptionTemplate.recommendedModels[0] || 'kimi-for-coding';
    }
    return null;
  },

  buildConfig(
    credentials: ProviderCredentials,
    selectedModel: string
  ): Partial<CodeMieConfigOptions> {
    return {
      provider: 'moonshot-subscription',
      baseUrl: credentials.baseUrl || MoonshotSubscriptionTemplate.defaultBaseUrl,
      apiKey: '',
      model: selectedModel,
      authMethod: 'manual',
      codeMieUrl: credentials.additionalConfig?.codeMieUrl as string | undefined,
      codeMieProject: credentials.additionalConfig?.codeMieProject as string | undefined,
    };
  }
};

ProviderRegistry.registerSetupSteps('moonshot-subscription', MoonshotSubscriptionSetupSteps);
```

- [ ] **Step 5.4: Create barrel export**

Create `src/providers/plugins/moonshot-subscription/index.ts`:
```typescript
export { MoonshotSubscriptionTemplate } from './moonshot-subscription.template.js';
export { MoonshotSubscriptionSetupSteps } from './moonshot-subscription.setup-steps.js';
```

- [ ] **Step 5.5: Run the tests**

```bash
npx vitest run src/providers/plugins/moonshot-subscription/__tests__/moonshot-subscription.template.test.ts
```

Expected: PASS.

- [ ] **Step 5.6: Commit**

```bash
git add src/providers/plugins/moonshot-subscription/
rtk git commit -m "feat(kimi): add moonshot-subscription provider"
```

---

## Task 6: Kimi Session Adapter and Metrics Processor

Implement parsing of Kimi `wire.jsonl` and extraction of metrics.

**Files:**
- Create: `src/agents/plugins/kimi/kimi.session.ts`
- Create: `src/agents/plugins/kimi/session/processors/kimi.metrics-processor.ts`
- Test: `src/agents/plugins/kimi/__tests__/kimi.session.test.ts`

- [ ] **Step 6.1: Create sample wire.jsonl fixture**

Create `src/agents/plugins/kimi/__tests__/fixtures/sample-wire.jsonl`:
```jsonl
{"type":"session.start","sessionId":"sess-123","cwd":"/tmp/project","timestamp":"2026-06-13T10:00:00Z"}
{"type":"user.prompt","content":"refactor auth","timestamp":"2026-06-13T10:00:01Z"}
{"type":"tool.call","toolName":"Read","toolInput":{"file_path":"src/auth.ts"},"timestamp":"2026-06-13T10:00:02Z"}
{"type":"tool.result","toolName":"Read","status":"success","timestamp":"2026-06-13T10:00:03Z"}
{"type":"tool.call","toolName":"Write","toolInput":{"file_path":"src/auth.ts","content":"..."},"timestamp":"2026-06-13T10:00:04Z"}
{"type":"tool.result","toolName":"Write","status":"success","timestamp":"2026-06-13T10:00:05Z"}
{"type":"session.end","sessionId":"sess-123","timestamp":"2026-06-13T10:00:06Z"}
```

**Note:** Adjust the fixture schema after Step 0.3 confirms the real `wire.jsonl` format. The plan uses a plausible placeholder; replace it with the actual schema.

- [ ] **Step 6.2: Write the failing test**

Create `src/agents/plugins/kimi/__tests__/kimi.session.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { KimiSessionAdapter } from '../kimi.session.js';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

describe('KimiSessionAdapter', () => {
  const metadata = {
    name: 'kimi',
    displayName: 'Kimi Code',
    dataPaths: { home: '.kimi-code' },
  } as any;

  it('parses sample wire.jsonl', async () => {
    const adapter = new KimiSessionAdapter(metadata);
    const filePath = resolve(__dirname, 'fixtures', 'sample-wire.jsonl');
    const session = await adapter.parseSessionFile(filePath, 'codemie-sess-uuid');

    expect(session.sessionId).toBe('codemie-sess-uuid');
    expect(session.agentName).toBe('Kimi Code');
    expect(session.messages.length).toBeGreaterThan(0);
    expect(session.metrics?.tools?.Read).toBe(1);
    expect(session.metrics?.tools?.Write).toBe(1);
  });
});
```

Run:
```bash
npx vitest run src/agents/plugins/kimi/__tests__/kimi.session.test.ts
```

Expected: FAIL.

- [ ] **Step 6.3: Implement the metrics processor**

Create `src/agents/plugins/kimi/session/processors/kimi.metrics-processor.ts`:
```typescript
import type { ParsedSession } from '../../../core/session/BaseSessionAdapter.js';
import type { SessionProcessor, ProcessingResult, ProcessingContext } from '../../../core/session/BaseProcessor.js';

export class KimiMetricsProcessor implements SessionProcessor {
  readonly name = 'kimi-metrics';
  readonly priority = 1;

  shouldProcess(session: ParsedSession): boolean {
    return session.agentName === 'Kimi Code';
  }

  async process(session: ParsedSession, _context: ProcessingContext): Promise<ProcessingResult> {
    const metrics = session.metrics || {};
    return {
      success: true,
      metadata: {
        recordsProcessed: Object.keys(metrics.tools || {}).length,
      }
    };
  }
}
```

- [ ] **Step 6.4: Implement the session adapter**

Create `src/agents/plugins/kimi/kimi.session.ts`:
```typescript
import { readFile } from 'fs/promises';
import type { SessionAdapter, ParsedSession, AggregatedResult } from '../../core/session/BaseSessionAdapter.js';
import type { SessionProcessor, ProcessingContext } from '../../core/session/BaseProcessor.js';
import type { AgentMetadata } from '../../core/types.js';
import { logger } from '../../../utils/logger.js';
import { KimiMetricsProcessor } from './session/processors/kimi.metrics-processor.js';

interface KimiWireEvent {
  type: string;
  sessionId?: string;
  timestamp?: string;
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  status?: 'success' | 'error';
  model?: string;
  [key: string]: unknown;
}

export class KimiSessionAdapter implements SessionAdapter {
  readonly agentName = 'kimi';
  private processors: SessionProcessor[] = [];

  constructor(private readonly metadata: AgentMetadata) {
    this.initializeProcessors();
  }

  private initializeProcessors(): void {
    this.registerProcessor(new KimiMetricsProcessor());
  }

  registerProcessor(processor: SessionProcessor): void {
    this.processors.push(processor);
    this.processors.sort((a, b) => a.priority - b.priority);
  }

  async discoverSessions(_options?: any): Promise<any[]> {
    // TODO: implement discovery over ~/.kimi-code/sessions
    return [];
  }

  async parseSessionFile(filePath: string, sessionId: string): Promise<ParsedSession> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());
      const events: KimiWireEvent[] = lines.map(line => JSON.parse(line));

      const tools: Record<string, number> = {};
      const toolStatus: Record<string, { success: number; failure: number }> = {};
      const fileOperations: ParsedSession['metrics']['fileOperations'] = [];
      let model: string | undefined;

      for (const event of events) {
        if (event.model) {
          model = event.model;
        }

        if (event.type === 'tool.call' && event.toolName) {
          tools[event.toolName] = (tools[event.toolName] || 0) + 1;
        }

        if (event.type === 'tool.result' && event.toolName) {
          const status = event.status === 'error' ? 'failure' : 'success';
          toolStatus[event.toolName] = toolStatus[event.toolName] || { success: 0, failure: 0 };
          toolStatus[event.toolName][status]++;

          if (event.toolName === 'Write' && event.toolInput?.file_path) {
            fileOperations.push({
              type: 'write',
              path: String(event.toolInput.file_path),
            });
          }
          if (event.toolName === 'Read' && event.toolInput?.file_path) {
            fileOperations.push({
              type: 'read',
              path: String(event.toolInput.file_path),
            });
          }
        }
      }

      const session: ParsedSession = {
        sessionId,
        agentName: this.metadata.displayName,
        metadata: {
          createdAt: events[0]?.timestamp,
          updatedAt: events[events.length - 1]?.timestamp,
        },
        messages: events,
        metrics: {
          tools,
          toolStatus,
          fileOperations,
        },
      };

      return session;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[kimi-session] Failed to parse ${filePath}: ${msg}`);
      return {
        sessionId,
        agentName: this.metadata.displayName,
        metadata: {},
        messages: [],
      };
    }
  }

  async processSession(_session: ParsedSession, _context: ProcessingContext): Promise<AggregatedResult> {
    throw new Error('processSession not implemented');
  }
}
```

- [ ] **Step 6.5: Run the tests**

```bash
npx vitest run src/agents/plugins/kimi/__tests__/kimi.session.test.ts
```

Expected: PASS.

- [ ] **Step 6.6: Commit**

```bash
git add src/agents/plugins/kimi/kimi.session.ts src/agents/plugins/kimi/session/processors/kimi.metrics-processor.ts src/agents/plugins/kimi/__tests__/
rtk git commit -m "feat(kimi): add session adapter and metrics processor"
```

---

## Task 7: Kimi Extension Installer

Implement the installer for CodeMie Kimi skills.

**Files:**
- Create: `src/agents/plugins/kimi/kimi.extension-installer.ts`
- Create: `src/agents/plugins/kimi/extension/SKILL.md`
- Create: `src/agents/plugins/kimi/extension/manifest.json`
- Test: `src/agents/plugins/kimi/__tests__/kimi.extension-installer.test.ts`

- [ ] **Step 7.1: Create bundled extension files**

Create `src/agents/plugins/kimi/extension/SKILL.md`:
```markdown
# CodeMie Kimi Skill

Default CodeMie skill for Kimi Code CLI.
```

Create `src/agents/plugins/kimi/extension/manifest.json`:
```json
{
  "name": "codemie-kimi",
  "version": "0.1.0",
  "description": "CodeMie integration for Kimi Code CLI"
}
```

- [ ] **Step 7.2: Write the failing test**

Create `src/agents/plugins/kimi/__tests__/kimi.extension-installer.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { KimiExtensionInstaller } from '../kimi.extension-installer.js';
import { AgentMetadata } from '../../core/types.js';

const metadata: AgentMetadata = {
  name: 'kimi',
  displayName: 'Kimi Code',
  description: 'test',
  npmPackage: '@moonshot-ai/kimi-code',
  cliCommand: 'kimi',
  supportedProviders: ['moonshot-subscription'],
  envMapping: {},
};

describe('KimiExtensionInstaller', () => {
  it('has correct target path', () => {
    const installer = new KimiExtensionInstaller(metadata);
    expect(installer.getTargetPath()).toMatch(/\.kimi-code\/skills\/codemie-kimi$/);
  });
});
```

Run:
```bash
npx vitest run src/agents/plugins/kimi/__tests__/kimi.extension-installer.test.ts
```

Expected: FAIL.

- [ ] **Step 7.3: Implement the installer**

Create `src/agents/plugins/kimi/kimi.extension-installer.ts`:
```typescript
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { BaseExtensionInstaller } from '../../core/extension/BaseExtensionInstaller.js';
import type { AgentMetadata } from '../../core/types.js';

export class KimiExtensionInstaller extends BaseExtensionInstaller {
  constructor(metadata: AgentMetadata) {
    super(metadata.name);
  }

  protected getSourcePath(): string {
    const currentFile = fileURLToPath(import.meta.url);
    return join(dirname(currentFile), 'extension');
  }

  getTargetPath(): string {
    return join(homedir(), '.kimi-code', 'skills', 'codemie-kimi');
  }

  protected getManifestPath(): string {
    return 'manifest.json';
  }

  protected getCriticalFiles(): string[] {
    return ['manifest.json', 'SKILL.md'];
  }
}
```

- [ ] **Step 7.4: Run the tests**

```bash
npx vitest run src/agents/plugins/kimi/__tests__/kimi.extension-installer.test.ts
```

Expected: PASS.

- [ ] **Step 7.5: Commit**

```bash
git add src/agents/plugins/kimi/kimi.extension-installer.ts src/agents/plugins/kimi/extension/
rtk git commit -m "feat(kimi): add extension installer for Kimi skills"
```

---

## Task 8: Kimi Plugin Metadata and Adapter

Implement the main `KimiPlugin` and `KimiAcpPlugin`.

**Files:**
- Create: `src/agents/plugins/kimi/kimi.plugin.ts`
- Create: `src/agents/plugins/kimi/kimi-acp.plugin.ts`
- Test: `src/agents/plugins/kimi/__tests__/kimi.plugin.test.ts`

- [ ] **Step 8.1: Write the failing test**

Create `src/agents/plugins/kimi/__tests__/kimi.plugin.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { KimiPlugin, KimiPluginMetadata } from '../kimi.plugin.js';

describe('KimiPlugin', () => {
  it('has correct metadata', () => {
    expect(KimiPluginMetadata.name).toBe('kimi');
    expect(KimiPluginMetadata.cliCommand).toBe('kimi');
    expect(KimiPluginMetadata.supportedProviders).toContain('moonshot-subscription');
    expect(KimiPluginMetadata.hookConfig?.eventNameMapping).toBeDefined();
  });

  it('returns session adapter and hook transformer', () => {
    const plugin = new KimiPlugin();
    expect(plugin.getSessionAdapter()).toBeDefined();
    expect(plugin.getHookTransformer?.()).toBeDefined();
    expect(plugin.getExtensionInstaller?.()).toBeDefined();
  });
});
```

Run:
```bash
npx vitest run src/agents/plugins/kimi/__tests__/kimi.plugin.test.ts
```

Expected: FAIL.

- [ ] **Step 8.2: Implement KimiPlugin**

Create `src/agents/plugins/kimi/kimi.plugin.ts`:
```typescript
import { AgentMetadata } from '../../core/types.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import type { SessionAdapter } from '../../core/session/BaseSessionAdapter.js';
import type { BaseExtensionInstaller } from '../../core/extension/BaseExtensionInstaller.js';
import type { HookTransformer } from '../../core/types.js';
import { KimiSessionAdapter } from './kimi.session.js';
import { KimiExtensionInstaller } from './kimi.extension-installer.js';
import { KimiHookTransformer } from './kimi.hook-transformer.js';
import { installNativeAgent } from '../../../utils/native-installer.js';
import { AgentInstallationError, createErrorContext, getErrorMessage } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';
import { sanitizeLogArgs } from '../../../utils/security.js';
import chalk from 'chalk';

const KIMI_SUPPORTED_VERSION = '1.0.0';
const KIMI_MINIMUM_SUPPORTED_VERSION = '0.9.0';

const KIMI_INSTALLER_URLS = {
  macOS: 'https://code.kimi.com/kimi-code/install.sh',
  windows: 'https://code.kimi.com/kimi-code/install.ps1',
  linux: 'https://code.kimi.com/kimi-code/install.sh',
};

export const KimiPluginMetadata: AgentMetadata = {
  name: 'kimi',
  displayName: 'Kimi Code',
  description: 'Kimi Code CLI - Moonshot AI coding agent',

  npmPackage: '@moonshot-ai/kimi-code',
  cliCommand: 'kimi',

  supportedVersion: KIMI_SUPPORTED_VERSION,
  minimumSupportedVersion: KIMI_MINIMUM_SUPPORTED_VERSION,

  installerUrls: KIMI_INSTALLER_URLS,

  dataPaths: {
    home: '.kimi-code',
  },

  envMapping: {},

  supportedProviders: ['moonshot-subscription'],
  blockedModelPatterns: [],
  recommendedModels: ['kimi-for-coding', 'kimi-k2'],

  ssoConfig: {
    enabled: true,
    clientType: 'codemie-kimi',
  },

  flagMappings: {
    '--task': {
      type: 'flag',
      target: '-p',
    },
  },

  metricsConfig: {
    excludeErrorsFromTools: ['Bash'],
  },

  extensionsConfig: {
    project: '.kimi-code',
    global: '~/.kimi-code',
    skillsEntryFile: 'SKILL.md',
  },

  hookConfig: {
    eventNameMapping: {
      'SessionStart': 'SessionStart',
      'SessionEnd': 'SessionEnd',
      'UserPromptSubmit': 'UserPromptSubmit',
      'Stop': 'Stop',
      'SubagentStop': 'SubagentStop',
      'PreCompact': 'PreCompact',
      'PostCompact': 'PreCompact',
      'Notification': 'PermissionRequest',
      'PermissionRequest': 'PermissionRequest',
    },
  },
};

export class KimiPlugin extends BaseAgentAdapter {
  private sessionAdapter?: KimiSessionAdapter;
  private extensionInstaller?: KimiExtensionInstaller;
  private hookTransformer?: KimiHookTransformer;

  constructor() {
    super(KimiPluginMetadata);
  }

  override async install(): Promise<void> {
    try {
      await installNativeAgent(this.metadata.installerUrls!);
    } catch (error) {
      throw new AgentInstallationError(
        `Failed to install Kimi Code CLI via native installer: ${getErrorMessage(error)}`,
        createErrorContext({ agent: this.name, operation: 'install' })
      );
    }
  }

  override async installVersion(version?: string): Promise<void> {
    const target = version === 'supported' ? this.metadata.supportedVersion : version;
    if (target && target !== 'latest') {
      logger.info(chalk.yellow(`Kimi Code CLI versioned installs are not supported; installing latest native release.`));
    }
    await this.install();
  }

  override async isInstalled(): Promise<boolean> {
    const { commandExists } = await import('../../../utils/processes.js');
    if (await commandExists(this.metadata.cliCommand!)) {
      return true;
    }
    const { existsSync } = await import('fs');
    const { join } = await import('path');
    const { homedir } = await import('os');
    return existsSync(join(homedir(), '.local', 'bin', 'kimi'));
  }

  override getSessionAdapter(): SessionAdapter {
    if (!this.sessionAdapter) {
      this.sessionAdapter = new KimiSessionAdapter(this.metadata);
    }
    return this.sessionAdapter;
  }

  override getExtensionInstaller(): BaseExtensionInstaller {
    if (!this.extensionInstaller) {
      this.extensionInstaller = new KimiExtensionInstaller(this.metadata);
    }
    return this.extensionInstaller;
  }

  override getHookTransformer(): HookTransformer {
    if (!this.hookTransformer) {
      this.hookTransformer = new KimiHookTransformer();
    }
    return this.hookTransformer;
  }
}
```

- [ ] **Step 8.3: Implement KimiAcpPlugin**

Create `src/agents/plugins/kimi/kimi-acp.plugin.ts`:
```typescript
import { AgentMetadata } from '../../core/types.js';
import { KimiPlugin, KimiPluginMetadata } from './kimi.plugin.js';

export const KimiAcpPluginMetadata: AgentMetadata = {
  ...KimiPluginMetadata,
  name: 'kimi-acp',
  displayName: 'Kimi Code ACP',
  description: 'Kimi Code CLI ACP mode for IDE integration',
  silentMode: true,
  lifecycle: {
    enrichArgs: (args) => ['acp', ...args],
  },
};

export class KimiAcpPlugin extends KimiPlugin {
  constructor() {
    super();
    this.metadata = { ...KimiAcpPluginMetadata };
  }
}
```

- [ ] **Step 8.4: Run the tests**

```bash
npx vitest run src/agents/plugins/kimi/__tests__/kimi.plugin.test.ts
```

Expected: PASS.

- [ ] **Step 8.5: Commit**

```bash
git add src/agents/plugins/kimi/kimi.plugin.ts src/agents/plugins/kimi/kimi-acp.plugin.ts src/agents/plugins/kimi/__tests__/kimi.plugin.test.ts
rtk git commit -m "feat(kimi): add KimiPlugin and KimiAcpPlugin"
```

---

## Task 9: Registry, AgentCLI, and package.json Wiring

Register the new agents and update the CLI wiring.

**Files:**
- Modify: `src/agents/registry.ts`
- Modify: `src/agents/core/AgentCLI.ts:456`
- Modify: `src/providers/index.ts`
- Modify: `package.json`
- Modify: `src/agents/__tests__/registry.test.ts`
- Create: `bin/codemie-kimi.js`
- Create: `bin/codemie-kimi-acp.js`

- [ ] **Step 9.1: Update AgentRegistry**

Modify `src/agents/registry.ts` to import and register the new plugins. Locate the existing `initialize()` method and add:

```typescript
import { KimiPlugin } from './plugins/kimi/kimi.plugin.js';
import { KimiAcpPlugin } from './plugins/kimi/kimi-acp.plugin.js';

// Inside initialize():
AgentRegistry.registerPlugin(new KimiPlugin());
AgentRegistry.registerPlugin(new KimiAcpPlugin());
```

- [ ] **Step 9.2: Update AgentCLI metadata map**

Modify `src/agents/core/AgentCLI.ts:456` to include the new agents. Either:

Option A (minimal):
```typescript
private getAgentMetadata() {
  const metadataMap: Record<string, typeof ClaudePluginMetadata> = {
    'claude': ClaudePluginMetadata,
    [BUILTIN_AGENT_NAME]: CodeMieCodePluginMetadata,
    'gemini': GeminiPluginMetadata,
    'opencode': OpenCodePluginMetadata,
    'claude-acp': ClaudeAcpPluginMetadata,
    'codex': CodexPluginMetadata,
    'kimi': KimiPluginMetadata,
    'kimi-acp': KimiAcpPluginMetadata,
  };
  return metadataMap[this.adapter.name];
}
```

Option B (refactor):
```typescript
private getAgentMetadata() {
  return this.adapter.metadata;
}
```

Use Option A for minimal change; add the imports for `KimiPluginMetadata` and `KimiAcpMetadata`.

- [ ] **Step 9.3: Register moonshot-subscription provider**

Modify `src/providers/index.ts` to import the new provider:
```typescript
import './plugins/moonshot-subscription/index.js';
```

- [ ] **Step 9.4: Update package.json**

Add to `package.json` `bin`:
```json
{
  "bin": {
    "codemie-kimi": "./dist/bin/codemie-kimi.js",
    "codemie-kimi-acp": "./dist/bin/codemie-kimi-acp.js"
  }
}
```

- [ ] **Step 9.5: Create CLI entry points**

Create `bin/codemie-kimi.js`:
```javascript
#!/usr/bin/env node
import { AgentRegistry } from '../dist/agents/registry.js';
import { AgentCLI } from '../dist/agents/core/AgentCLI.js';

const agent = AgentRegistry.getAgent('kimi');
const cli = new AgentCLI(agent);
await cli.run(process.argv);
```

Create `bin/codemie-kimi-acp.js`:
```javascript
#!/usr/bin/env node
import { AgentRegistry } from '../dist/agents/registry.js';
import { AgentCLI } from '../dist/agents/core/AgentCLI.js';

const agent = AgentRegistry.getAgent('kimi-acp');
const cli = new AgentCLI(agent);
await cli.run(process.argv);
```

- [ ] **Step 9.6: Update registry tests**

Modify `src/agents/__tests__/registry.test.ts`:
- Change expected agent count from 6 to 8.
- Add assertions for `kimi` and `kimi-acp`.

```typescript
// Replace all occurrences of 6 with 8
expect(agentNames).toHaveLength(8);
expect(agents).toHaveLength(8);

// Add tests:
it('should register Kimi plugin', () => {
  const agent = AgentRegistry.getAgent('kimi');
  expect(agent).toBeDefined();
  expect(agent?.name).toBe('kimi');
});

it('should register Kimi ACP plugin', () => {
  const agent = AgentRegistry.getAgent('kimi-acp');
  expect(agent).toBeDefined();
  expect(agent?.name).toBe('kimi-acp');
});
```

- [ ] **Step 9.7: Build and run tests**

```bash
npm run build
npx vitest run src/agents/__tests__/registry.test.ts
```

Expected: PASS.

- [ ] **Step 9.8: Commit**

```bash
git add src/agents/registry.ts src/agents/core/AgentCLI.ts src/providers/index.ts package.json bin/ src/agents/__tests__/registry.test.ts
rtk git commit -m "feat(kimi): wire kimi and kimi-acp into registry, CLI, and package.json"
```

---

## Task 10: Automated Verification Pipeline

Run the full verification pipeline and iterate until green.

**Files:** all of the above

- [ ] **Step 10.1: Build the project**

```bash
npm run build
```

Expected: zero TypeScript errors.

- [ ] **Step 10.2: Run lint**

```bash
npm run lint
```

Expected: zero warnings.

- [ ] **Step 10.3: Run unit tests**

```bash
npm run test:unit
```

Expected: all new and existing tests pass.

- [ ] **Step 10.4: Mocked end-to-end run**

Create `scripts/verify-kimi-integration.mjs`:
```javascript
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

const tmpDir = mkdtempSync(join(tmpdir(), 'kimi-verify-'));
const kimiBin = join(tmpDir, 'kimi');

// Create a fake kimi binary that emits hooks
writeFileSync(kimiBin, `#!/usr/bin/env bash
set -e
export KIMI_CODE_HOME="${tmpDir}/.kimi-code"
mkdir -p "\$KIMI_CODE_HOME/sessions/wd_test_abc123/sess-xyz/agents/main"
echo '{"type":"session.start","session_id":"sess-xyz","cwd":"${tmpDir}","timestamp":"2026-06-13T10:00:00Z"}' > "\$KIMI_CODE_HOME/sessions/wd_test_abc123/sess-xyz/agents/main/wire.jsonl"
echo '{"type":"user.prompt","content":"hello"}' >> "\$KIMI_CODE_HOME/sessions/wd_test_abc123/sess-xyz/agents/main/wire.jsonl"
echo '{"type":"tool.call","toolName":"Read","toolInput":{"file_path":"README.md"}}' >> "\$KIMI_CODE_HOME/sessions/wd_test_abc123/sess-xyz/agents/main/wire.jsonl"
echo '{"type":"tool.result","toolName":"Read","status":"success"}' >> "\$KIMI_CODE_HOME/sessions/wd_test_abc123/sess-xyz/agents/main/wire.jsonl"
echo '{"type":"session.end","session_id":"sess-xyz"}' >> "\$KIMI_CODE_HOME/sessions/wd_test_abc123/sess-xyz/agents/main/wire.jsonl"
echo "kimi 1.0.0"
`, 'utf-8');
chmodSync(kimiBin, 0o755);

process.env.PATH = `${tmpDir}:${process.env.PATH}`;
process.env.KIMI_CODE_HOME = `${tmpDir}/.kimi-code`;

// Run codemie-kimi version check
const versionOutput = execSync('node ./dist/bin/codemie-kimi.js --version', { encoding: 'utf-8', cwd: process.cwd() });
console.log('Version output:', versionOutput);

// Verify config injection
const configPath = join(tmpDir, '.kimi-code', 'config.toml');
const config = readFileSync(configPath, 'utf-8');
if (!config.includes('command = "codemie hook"')) {
  throw new Error('Hook config was not injected');
}

console.log('Verification passed');
```

Run:
```bash
node scripts/verify-kimi-integration.mjs
```

Expected: prints "Verification passed".

- [ ] **Step 10.5: Run `codemie doctor`**

```bash
npm link
rtk codemie doctor
```

Expected: `kimi` appears as installed when the binary is present.

- [ ] **Step 10.6: Iterate on failures**

If any step fails, fix the underlying code and re-run from Step 10.1. Do not stop until all verifications pass.

- [ ] **Step 10.7: Final commit**

```bash
git add scripts/verify-kimi-integration.mjs
rtk git commit -m "feat(kimi): add automated verification script"
```

---

## Self-Review

### Spec coverage

| Spec requirement | Plan task |
|---|---|
| `moonshot-subscription` provider | Task 5 |
| Kimi hook config injection | Task 3, invoked from Task 5 |
| Kimi hook transformer | Task 4 |
| Session adapter / metrics processor | Task 6 |
| Extension installer | Task 7 |
| `KimiPlugin` / `KimiAcpPlugin` | Task 8 |
| Registry / AgentCLI / package.json | Task 9 |
| Automated verification | Task 10 |
| Node version check for npm fallback | Task 8 (`installVersion`) - currently warns and installs latest; refine to reject if Node < 22.19.0. |

**Gap found:** Task 8 `installVersion` does not actually check Node version. Add a helper and reject npm fallback when Node < 22.19.0.

### Placeholder scan

- The sample `wire.jsonl` fixture uses a placeholder schema that must be replaced after Step 0.3. This is intentional and documented.
- `KimiSessionAdapter.discoverSessions` returns empty array; a follow-up task should implement it. Add a task note.
- No other TBD/TODO placeholders remain in executable steps.

### Type consistency

- `KimiPluginMetadata` uses `hookConfig` after Task 1 adds it to `AgentMetadata`.
- `KimiAcpPlugin` metadata name is `kimi-acp`.
- `AgentCLI.getAgentMetadata` returns metadata for both `kimi` and `kimi-acp`.

---

## Follow-up improvements (post-MVP)

1. Implement `KimiSessionAdapter.discoverSessions()` to enable `codemie analytics` native discovery.
2. Implement `KimiConversationsProcessor` if conversation sync is required.
3. Add support for additional providers (`ai-run-sso`, `bearer-auth`, `litellm`) by writing credentials to `~/.kimi-code/config.toml`.
4. Relax `AgentCLI.validateCompatibility()` for `authType: 'none'` providers.
