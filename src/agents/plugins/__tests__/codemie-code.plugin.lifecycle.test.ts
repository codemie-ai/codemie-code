import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../core/BaseAgentAdapter.js', () => ({
  BaseAgentAdapter: class { metadata: unknown; constructor(metadata: unknown) { this.metadata = metadata; } },
}));

// Stale-session reconciliation used to be wired here too; it is now centralized
// in BaseAgentAdapter.run() for every agent (see EPMCDME-15536), so this file
// only covers codemie-code's own onSessionStart wiring (the SessionStart event).
describe('CodeMieCodePluginMetadata.lifecycle.onSessionStart', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('emits a SessionStart lifecycle event', async () => {
    const processEvent = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../cli/commands/hook.js', () => ({ processEvent }));

    const { CodeMieCodePluginMetadata } = await import('../codemie-code.plugin.js');
    const env: NodeJS.ProcessEnv = { CODEMIE_AGENT: 'codemie-code' };

    await CodeMieCodePluginMetadata.lifecycle!.onSessionStart!('sid-1', env);

    expect(processEvent).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the SessionStart hook rejects', async () => {
    vi.doMock('../../../cli/commands/hook.js', () => ({
      processEvent: vi.fn().mockRejectedValue(new Error('boom')),
    }));

    const { CodeMieCodePluginMetadata } = await import('../codemie-code.plugin.js');

    await expect(
      CodeMieCodePluginMetadata.lifecycle!.onSessionStart!('sid-2', { CODEMIE_AGENT: 'codemie-code' })
    ).resolves.toBeUndefined();
  });
});
