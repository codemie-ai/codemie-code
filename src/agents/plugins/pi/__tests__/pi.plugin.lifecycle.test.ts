import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const startPiIncrementalSync = vi.fn();
const stopPiIncrementalSync = vi.fn();
vi.mock('../pi.incremental-sync.js', () => ({
  startPiIncrementalSync,
  stopPiIncrementalSync,
}));

describe('PiPluginMetadata.lifecycle.onSessionStart — stale-session reconciliation', () => {
  beforeEach(() => {
    startPiIncrementalSync.mockReset();
    stopPiIncrementalSync.mockReset();
    vi.resetModules();
  });

  it('reconciles stale pi sessions on start, alongside the existing SessionStart call', async () => {
    const processEvent = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../../cli/commands/hook.js', () => ({ processEvent }));
    const reconcileStaleSessions = vi.fn().mockResolvedValue({ reconciled: 0, failed: 0 });
    vi.doMock('../../../core/session/stale-session-reconciliation.js', () => ({ reconcileStaleSessions }));

    const { PiPluginMetadata } = await import('../pi.plugin.js');
    const env: NodeJS.ProcessEnv = { CODEMIE_AGENT: 'pi', CODEMIE_PROVIDER: 'ai-run-sso' };

    await PiPluginMetadata.lifecycle!.onSessionStart!('sid-1', env);

    expect(processEvent).toHaveBeenCalledTimes(1);
    expect(reconcileStaleSessions).toHaveBeenCalledTimes(1);
    expect(reconcileStaleSessions.mock.calls[0][0]).toBe('pi');
    expect(reconcileStaleSessions.mock.calls[0][1]).toBe(env);
    expect(typeof reconcileStaleSessions.mock.calls[0][2]).toBe('function');
  });

  it('does not throw when reconciliation rejects', async () => {
    const processEvent = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../../cli/commands/hook.js', () => ({ processEvent }));
    const reconcileStaleSessions = vi.fn().mockRejectedValue(new Error('boom'));
    vi.doMock('../../../core/session/stale-session-reconciliation.js', () => ({ reconcileStaleSessions }));

    const { PiPluginMetadata } = await import('../pi.plugin.js');

    await expect(
      PiPluginMetadata.lifecycle!.onSessionStart!('sid-2', { CODEMIE_AGENT: 'pi' })
    ).resolves.toBeUndefined();
  });

  it('still starts the incremental-sync timer when reconciliation is in flight', async () => {
    const processEvent = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../../cli/commands/hook.js', () => ({ processEvent }));
    const reconcileStaleSessions = vi.fn().mockResolvedValue({ reconciled: 0, failed: 0 });
    vi.doMock('../../../core/session/stale-session-reconciliation.js', () => ({ reconcileStaleSessions }));

    const { PiPluginMetadata } = await import('../pi.plugin.js');
    await PiPluginMetadata.lifecycle!.onSessionStart!('sid-3', { CODEMIE_AGENT: 'pi' });

    expect(startPiIncrementalSync).toHaveBeenCalledTimes(1);
    expect(startPiIncrementalSync.mock.calls[0][0]).toMatchObject({ sessionId: 'sid-3' });
  });
});
