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
