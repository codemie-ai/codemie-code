/**
 * executeBeforeRun applies the provider's declared agent env (agentHooks.<agent>.env) before any
 * beforeRun hook, only where a variable is unset, and without replacing the agent's default hook.
 *
 * @group unit
 */

import { describe, it, expect, vi } from 'vitest';
import { agentDefaultHookRuns, executeBeforeRun } from '../lifecycle-helpers.js';
import { ProviderRegistry } from '@/providers/core/registry.js';
import type { AgentLifecycle } from '../types.js';

ProviderRegistry.registerProvider({
  name: 'fake-declares-env',
  agentHooks: { 'fake-agent': { env: { X_FLAG: 'provider', X_OTHER: 'provider' } } },
} as never);

ProviderRegistry.registerProvider({
  name: 'fake-replaces-agent',
  agentHooks: { 'fake-agent': { beforeRun: async (env: NodeJS.ProcessEnv) => env } },
} as never);
ProviderRegistry.registerProvider({
  name: 'fake-wildcard-only',
  agentHooks: { '*': { beforeRun: async (env: NodeJS.ProcessEnv) => env } },
} as never);

describe('agentDefaultHookRuns — the rule resolveHook applies', () => {
  it('is false only when the provider registers that hook under the agent name', () => {
    expect(agentDefaultHookRuns('beforeRun', 'fake-replaces-agent', 'fake-agent')).toBe(false);
    expect(agentDefaultHookRuns('beforeRun', 'fake-replaces-agent', 'other-agent')).toBe(true);
    expect(agentDefaultHookRuns('beforeRun', 'fake-wildcard-only', 'fake-agent')).toBe(true);
    expect(agentDefaultHookRuns('beforeRun', 'fake-declares-env', 'fake-agent')).toBe(true);
    expect(agentDefaultHookRuns('beforeRun', undefined, 'fake-agent')).toBe(true);
    expect(agentDefaultHookRuns('beforeRun', 'no-such-provider', 'fake-agent')).toBe(true);
  });

  it('matches what executeBeforeRun actually runs', async () => {
    const agentDefault = vi.fn(async (env: NodeJS.ProcessEnv) => env);
    const lifecycle: AgentLifecycle = { beforeRun: agentDefault };

    await executeBeforeRun({}, lifecycle, 'fake-agent', { CODEMIE_PROVIDER: 'fake-replaces-agent' }, {});
    expect(agentDefault).not.toHaveBeenCalled();

    await executeBeforeRun({}, lifecycle, 'fake-agent', { CODEMIE_PROVIDER: 'fake-wildcard-only' }, {});
    expect(agentDefault).toHaveBeenCalledTimes(1);
  });
});

describe('executeBeforeRun — provider agent env', () => {
  it('applies the declared values before the agent default hook, which still runs', async () => {
    const seen = vi.fn();
    const lifecycle: AgentLifecycle = {
      beforeRun: async (env) => {
        seen({ ...env });
        if (!env.X_FLAG) env.X_FLAG = 'agent-default';
        return env;
      },
    };

    const env = await executeBeforeRun({}, lifecycle, 'fake-agent', { CODEMIE_PROVIDER: 'fake-declares-env' }, {});

    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ X_FLAG: 'provider', X_OTHER: 'provider' }));
    expect(env.X_FLAG).toBe('provider');
  });

  it('keeps a value the shell already set', async () => {
    const env = await executeBeforeRun(
      {},
      undefined,
      'fake-agent',
      { CODEMIE_PROVIDER: 'fake-declares-env', X_FLAG: 'shell' },
      {}
    );
    expect(env.X_FLAG).toBe('shell');
    expect(env.X_OTHER).toBe('provider');
  });

  it('applies nothing for another agent', async () => {
    const env = await executeBeforeRun({}, undefined, 'other-agent', { CODEMIE_PROVIDER: 'fake-declares-env' }, {});
    expect(env).not.toHaveProperty('X_FLAG');
  });
});
