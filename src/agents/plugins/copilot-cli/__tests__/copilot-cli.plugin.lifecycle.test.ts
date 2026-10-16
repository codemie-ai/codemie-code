import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('CopilotCliPluginMetadata.lifecycle.onSessionStart — stale-session reconciliation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('reconciles stale copilot-cli sessions on start, alongside the existing SessionStart call', async () => {
    const reconcileStaleSessions = vi.fn().mockResolvedValue({ reconciled: 0, failed: 0 });
    vi.doMock('../../../core/session/stale-session-reconciliation.js', () => ({ reconcileStaleSessions }));
    const processEvent = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../../cli/commands/hook.js', () => ({ processEvent }));

    const { CopilotCliPluginMetadata } = await import('../copilot-cli.plugin.js');
    const env: NodeJS.ProcessEnv = { CODEMIE_AGENT: 'copilot-cli' };

    await CopilotCliPluginMetadata.lifecycle!.onSessionStart!('sid-1', env);

    expect(processEvent).toHaveBeenCalledTimes(1);
    expect(reconcileStaleSessions).toHaveBeenCalledTimes(1);
    expect(reconcileStaleSessions.mock.calls[0][0]).toBe('copilot-cli');
    expect(reconcileStaleSessions.mock.calls[0][1]).toBe(env);
  });

  it('does not throw when reconciliation rejects', async () => {
    const reconcileStaleSessions = vi.fn().mockRejectedValue(new Error('boom'));
    vi.doMock('../../../core/session/stale-session-reconciliation.js', () => ({ reconcileStaleSessions }));
    vi.doMock('../../../../cli/commands/hook.js', () => ({ processEvent: vi.fn().mockResolvedValue(undefined) }));

    const { CopilotCliPluginMetadata } = await import('../copilot-cli.plugin.js');

    await expect(
      CopilotCliPluginMetadata.lifecycle!.onSessionStart!('sid-2', { CODEMIE_AGENT: 'copilot-cli' })
    ).resolves.toBeUndefined();
  });
});
