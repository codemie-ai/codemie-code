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
