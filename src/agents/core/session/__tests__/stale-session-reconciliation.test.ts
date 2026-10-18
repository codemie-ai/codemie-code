/**
 * Stale-session reconciliation endTime threading.
 *
 * The synthetic SessionEnd event built for a stranded session must carry the
 * session's real last-activity timestamp as `endTime`, not whenever
 * reconciliation happens to run — otherwise a session killed mid-turn hours or
 * days ago gets billed for the entire dead-process gap once it is finally
 * noticed (see `handleSessionEnd` / `SessionStore.accumulateActiveDuration`).
 * @group unit
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/utils/paths.js', () => ({
  getCodemiePath: vi.fn().mockReturnValue('/home/test/.codemie/sessions'),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

vi.mock('fs/promises', () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
}));

function strandedSessionFile(sessionId: string, agentName: string, lastSyncAt: number, startTime: number): string {
  return JSON.stringify({
    sessionId,
    agentName,
    status: 'active',
    startTime,
    sync: { metrics: { lastSyncAt } },
  });
}

describe('reconcileStaleSessions endTime threading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('synthesizes a SessionEnd carrying endTime = the session\'s real last activity, not "now"', async () => {
    const now = Date.now();
    const lastActivity = now - 2 * 60 * 60 * 1000; // 2h ago, well past the 30-min inactivity threshold
    const startTime = lastActivity - 10 * 60 * 1000;

    const { readdir, readFile } = await import('fs/promises');
    vi.mocked(readdir).mockResolvedValue(['stranded-1.json'] as never);
    vi.mocked(readFile).mockResolvedValue(
      strandedSessionFile('stranded-1', 'claude', lastActivity, startTime) as never
    );

    const { reconcileStaleSessions } = await import('../stale-session-reconciliation.js');
    const processEvent = vi.fn().mockResolvedValue(undefined);

    const result = await reconcileStaleSessions(
      'claude',
      {} as NodeJS.ProcessEnv,
      (_env, sessionId) => ({ agentName: 'claude', sessionId }),
      { processEvent, now }
    );

    expect(result).toEqual({ reconciled: 1, failed: 0 });
    expect(processEvent).toHaveBeenCalledTimes(1);

    const [event] = processEvent.mock.calls[0] as [{ endTime?: number; session_id: string }];
    expect(event.session_id).toBe('stranded-1');
    expect(event.endTime).toBe(lastActivity);
    expect(event.endTime).not.toBe(now);
  });

  it('never calls processEvent when nothing is stale, so no synthetic event is built', async () => {
    const { readdir } = await import('fs/promises');
    vi.mocked(readdir).mockResolvedValue([] as never);

    const { reconcileStaleSessions } = await import('../stale-session-reconciliation.js');
    const processEvent = vi.fn();

    const result = await reconcileStaleSessions(
      'claude',
      {} as NodeJS.ProcessEnv,
      (_env, sessionId) => ({ agentName: 'claude', sessionId }),
      { processEvent }
    );

    expect(result).toEqual({ reconciled: 0, failed: 0 });
    expect(processEvent).not.toHaveBeenCalled();
  });
});
