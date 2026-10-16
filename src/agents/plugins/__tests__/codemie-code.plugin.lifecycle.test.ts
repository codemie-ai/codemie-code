import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../core/BaseAgentAdapter.js', () => ({
  BaseAgentAdapter: class { metadata: unknown; constructor(metadata: unknown) { this.metadata = metadata; } },
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
