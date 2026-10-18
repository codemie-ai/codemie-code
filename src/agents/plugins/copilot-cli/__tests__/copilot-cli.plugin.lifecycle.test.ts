import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stale-session reconciliation used to be wired here too; it is now centralized
// in BaseAgentAdapter.run() for every agent (see EPMCDME-15536), so this file
// only covers copilot-cli's own onSessionStart wiring (the SessionStart event).
describe('CopilotCliPluginMetadata.lifecycle.onSessionStart', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('emits a SessionStart lifecycle event', async () => {
    const processEvent = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../../cli/commands/hook.js', () => ({ processEvent }));

    const { CopilotCliPluginMetadata } = await import('../copilot-cli.plugin.js');
    const env: NodeJS.ProcessEnv = { CODEMIE_AGENT: 'copilot-cli' };

    await CopilotCliPluginMetadata.lifecycle!.onSessionStart!('sid-1', env);

    expect(processEvent).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the SessionStart hook rejects', async () => {
    vi.doMock('../../../../cli/commands/hook.js', () => ({
      processEvent: vi.fn().mockRejectedValue(new Error('boom')),
    }));

    const { CopilotCliPluginMetadata } = await import('../copilot-cli.plugin.js');

    await expect(
      CopilotCliPluginMetadata.lifecycle!.onSessionStart!('sid-2', { CODEMIE_AGENT: 'copilot-cli' })
    ).resolves.toBeUndefined();
  });
});
