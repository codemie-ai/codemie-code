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

function strandedSessionFile(
  sessionId: string,
  agentName: string,
  lastSyncAt: number,
  startTime: number,
  agentSessionId?: string
): string {
  return JSON.stringify({
    sessionId,
    agentName,
    status: 'active',
    startTime,
    sync: { metrics: { lastSyncAt } },
    ...(agentSessionId && { correlation: { status: 'matched', agentSessionId, retryCount: 0 } }),
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

  it('synthesizes a SessionEnd under the native agentSessionId, not the CodeMie session id, when one was recorded', async () => {
    const now = Date.now();
    const lastActivity = now - 2 * 60 * 60 * 1000;
    const startTime = lastActivity - 10 * 60 * 1000;

    const { readdir, readFile } = await import('fs/promises');
    vi.mocked(readdir).mockResolvedValue(['stranded-2.json'] as never);
    vi.mocked(readFile).mockResolvedValue(
      strandedSessionFile('stranded-2', 'claude', lastActivity, startTime, 'native-claude-id-xyz') as never
    );

    const { reconcileStaleSessions } = await import('../stale-session-reconciliation.js');
    const processEvent = vi.fn().mockResolvedValue(undefined);

    await reconcileStaleSessions(
      'claude',
      {} as NodeJS.ProcessEnv,
      (_env, sessionId) => ({ agentName: 'claude', sessionId }),
      { processEvent, now }
    );

    const [event] = processEvent.mock.calls[0] as [{ session_id: string }];
    // The live SessionStart metric for this agent went out under the native id — the
    // SessionEnd must match it, or the two never pair up on the analytics backend.
    expect(event.session_id).toBe('native-claude-id-xyz');
    expect(event.session_id).not.toBe('stranded-2');
  });

  it('falls back to the CodeMie session id when no native agentSessionId was recorded', async () => {
    const now = Date.now();
    const lastActivity = now - 2 * 60 * 60 * 1000;
    const startTime = lastActivity - 10 * 60 * 1000;

    const { readdir, readFile } = await import('fs/promises');
    vi.mocked(readdir).mockResolvedValue(['stranded-3.json'] as never);
    vi.mocked(readFile).mockResolvedValue(
      strandedSessionFile('stranded-3', 'codex', lastActivity, startTime) as never
    );

    const { reconcileStaleSessions } = await import('../stale-session-reconciliation.js');
    const processEvent = vi.fn().mockResolvedValue(undefined);

    await reconcileStaleSessions(
      'codex',
      {} as NodeJS.ProcessEnv,
      (_env, sessionId) => ({ agentName: 'codex', sessionId }),
      { processEvent, now }
    );

    const [event] = processEvent.mock.calls[0] as [{ session_id: string }];
    expect(event.session_id).toBe('stranded-3');
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

describe('buildReconciliationHookConfig', () => {
  it('reads agentName and clientType from env, with no literal fallback', async () => {
    const { buildReconciliationHookConfig } = await import('../stale-session-reconciliation.js');

    const env: NodeJS.ProcessEnv = {
      CODEMIE_AGENT: 'claude-acp',
      CODEMIE_CLIENT_TYPE: 'codemie-claude-acp',
      CODEMIE_PROVIDER: 'ai-run-sso',
      CODEMIE_BASE_URL: 'https://proxy.example.com',
      CODEMIE_URL: 'https://sso.example.com',
      CODEMIE_SYNC_API_URL: 'https://sync.example.com',
      CODEMIE_CLI_VERSION: '1.2.3',
      CODEMIE_PROFILE_NAME: 'work',
      CODEMIE_PROJECT: 'codemie-code',
      CODEMIE_MODEL: 'claude-sonnet-5',
    };

    expect(buildReconciliationHookConfig(env, 'sid-1')).toEqual({
      agentName: 'claude-acp',
      sessionId: 'sid-1',
      provider: 'ai-run-sso',
      apiBaseUrl: 'https://proxy.example.com',
      ssoUrl: 'https://sso.example.com',
      syncApiUrl: 'https://sync.example.com',
      version: '1.2.3',
      profileName: 'work',
      project: 'codemie-code',
      model: 'claude-sonnet-5',
      clientType: 'codemie-claude-acp',
    });
  });
});
