/**
 * executeBeforeRun applies the provider's declared agent env (agentHooks.<agent>.env) before any
 * beforeRun hook, only where a variable is unset, and without replacing the agent's default hook.
 *
 * @group unit
 */

import { describe, it, expect, vi } from 'vitest';
import { executeBeforeRun } from '../lifecycle-helpers.js';
import { ProviderRegistry } from '@/providers/core/registry.js';
import type { AgentLifecycle } from '../types.js';

ProviderRegistry.registerProvider({
  name: 'fake-declares-env',
  agentHooks: { 'fake-agent': { env: { X_FLAG: 'provider', X_OTHER: 'provider' } } },
} as never);

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
