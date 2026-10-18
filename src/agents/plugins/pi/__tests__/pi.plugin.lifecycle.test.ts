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

// Stale-session reconciliation used to be wired here too; it is now centralized
// in BaseAgentAdapter.run() for every agent (see EPMCDME-15536), so this file
// only covers pi's own onSessionStart wiring (the SessionStart event and the
// incremental-sync timer).
describe('PiPluginMetadata.lifecycle.onSessionStart', () => {
  beforeEach(() => {
    startPiIncrementalSync.mockReset();
    stopPiIncrementalSync.mockReset();
    vi.resetModules();
  });

  it('starts the incremental-sync timer', async () => {
    const processEvent = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../../../cli/commands/hook.js', () => ({ processEvent }));

    const { PiPluginMetadata } = await import('../pi.plugin.js');
    await PiPluginMetadata.lifecycle!.onSessionStart!('sid-3', { CODEMIE_AGENT: 'pi' });

    expect(startPiIncrementalSync).toHaveBeenCalledTimes(1);
    expect(startPiIncrementalSync.mock.calls[0][0]).toMatchObject({ sessionId: 'sid-3' });
  });
});
