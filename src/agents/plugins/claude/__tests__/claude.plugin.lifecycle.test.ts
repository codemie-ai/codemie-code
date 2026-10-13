import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

describe('ClaudePluginMetadata.lifecycle.onSessionStart — stale-session reconciliation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reconciles stale claude sessions on start', async () => {
    const reconcileStaleSessions = vi.fn().mockResolvedValue({ reconciled: 0, failed: 0 });
    vi.doMock('../../../core/session/stale-session-reconciliation.js', () => ({ reconcileStaleSessions }));

    const { ClaudePluginMetadata } = await import('../claude.plugin.js');
    const env: NodeJS.ProcessEnv = { CODEMIE_AGENT: 'claude', CODEMIE_PROVIDER: 'ai-run-sso' };

    await ClaudePluginMetadata.lifecycle!.onSessionStart!('sid-1', env);

    expect(reconcileStaleSessions).toHaveBeenCalledTimes(1);
    expect(reconcileStaleSessions.mock.calls[0][0]).toBe('claude');
    expect(reconcileStaleSessions.mock.calls[0][1]).toBe(env);
    expect(typeof reconcileStaleSessions.mock.calls[0][2]).toBe('function');
  });

  it('does not duplicate processEvent(SessionStart)', async () => {
    const reconcileStaleSessions = vi.fn().mockResolvedValue({ reconciled: 0, failed: 0 });
    vi.doMock('../../../core/session/stale-session-reconciliation.js', () => ({ reconcileStaleSessions }));
    const processEvent = vi.fn();
    vi.doMock('../../../../cli/commands/hook.js', () => ({ processEvent }));

    const { ClaudePluginMetadata } = await import('../claude.plugin.js');
    await ClaudePluginMetadata.lifecycle!.onSessionStart!('sid-2', { CODEMIE_AGENT: 'claude' });

    expect(processEvent).not.toHaveBeenCalled();
  });

  it('does not throw when reconciliation rejects', async () => {
    const reconcileStaleSessions = vi.fn().mockRejectedValue(new Error('boom'));
    vi.doMock('../../../core/session/stale-session-reconciliation.js', () => ({ reconcileStaleSessions }));

    const { ClaudePluginMetadata } = await import('../claude.plugin.js');

    await expect(
      ClaudePluginMetadata.lifecycle!.onSessionStart!('sid-3', { CODEMIE_AGENT: 'claude' })
    ).resolves.toBeUndefined();
  });
});
