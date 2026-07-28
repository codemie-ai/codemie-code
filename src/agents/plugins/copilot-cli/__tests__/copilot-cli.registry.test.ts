/**
 * Registry wiring tests.
 *
 * `native-loader.ts` resolves session adapters via
 * `AgentRegistry.getAgent(name)?.getSessionAdapter?.()`. If that call does not resolve,
 * Copilot sessions are never discovered and the whole integration is a no-op.
 */

import { describe, it, expect } from 'vitest';
import { AgentRegistry } from '../../../registry.js';

describe('copilot-cli registration', () => {
  it('resolves through the exact call native-loader makes', () => {
    const adapter = AgentRegistry.getAgent('copilot-cli')?.getSessionAdapter?.();

    expect(adapter).toBeDefined();
    expect(typeof adapter!.discoverSessions).toBe('function');
    expect(adapter!.agentName).toBe('copilot-cli');
  });

  it('advertises the user-facing display label', () => {
    expect(AgentRegistry.getAgent('copilot-cli')!.metadata.displayName).toBe('GitHub Copilot CLI');
  });

  it('is marked analytics-only so the ownership gate exempts it', () => {
    expect(AgentRegistry.getAgent('copilot-cli')!.metadata.analyticsOnly).toBe(true);
  });

  it('refuses to be installed or launched by CodeMie', async () => {
    const plugin = AgentRegistry.getAgent('copilot-cli')!;

    await expect(plugin.install()).rejects.toThrow(/not managed by CodeMie/i);
    await expect(plugin.run([])).rejects.toThrow(/not managed by CodeMie/i);
  });

  it('does not disturb existing agents', () => {
    for (const name of ['claude', 'codex', 'gemini', 'kimi', 'opencode']) {
      expect(AgentRegistry.getAgent(name), `${name} should still resolve`).toBeDefined();
    }
  });
});
