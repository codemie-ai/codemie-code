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

const CODEMIE_HOME = '/home/test/.codemie';
const heldLocks = new Set<string>();

vi.mock('@/utils/paths.js', () => ({
  getCodemiePath: vi.fn((...parts: string[]) => [CODEMIE_HOME, ...parts].join('/')),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn((path: string) => path === `${CODEMIE_HOME}/sessions` || heldLocks.has(path) || path.startsWith(`${CODEMIE_HOME}/sessions/`)),
}));

vi.mock('fs/promises', () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(async (path: string, _content: string, options?: { flag?: string }) => {
    if (options?.flag === 'wx' && heldLocks.has(path)) {
      throw Object.assign(new Error(`EEXIST: ${path}`), { code: 'EEXIST' });
    }
    heldLocks.add(path);
  }),
  unlink: vi.fn(async (path: string) => {
    heldLocks.delete(path);
  }),
  stat: vi.fn(async (path: string) => {
    if (!heldLocks.has(path)) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    }
    return { mtimeMs: Date.now() };
  }),
}));

function strandedSessionFile(
  sessionId: string,
  agentName: string,
  lastSyncAt: number,
  startTime: number,
  agentSessionId?: string,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    sessionId,
    agentName,
    status: 'active',
    startTime,
    sync: { metrics: { lastSyncAt } },
    ...(agentSessionId && { correlation: { status: 'matched', agentSessionId, retryCount: 0 } }),
    ...extra,
  });
}

describe('reconcileStaleSessions endTime threading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    heldLocks.clear();
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

  it('uses the stranded session\'s 10:00 last activity even when the next launch that notices it is at 17:00', async () => {
    const tenAm = new Date('2026-10-19T10:00:00.000Z').getTime();
    const fivePm = new Date('2026-10-19T17:00:00.000Z').getTime();
    const startTime = tenAm - 30 * 60 * 1000;

    const { readdir, readFile } = await import('fs/promises');
    vi.mocked(readdir).mockResolvedValue(['stranded-10am.json'] as never);
    vi.mocked(readFile).mockResolvedValue(
      strandedSessionFile('stranded-10am', 'claude', tenAm, startTime) as never
    );

    const { reconcileStaleSessions } = await import('../stale-session-reconciliation.js');
    const processEvent = vi.fn().mockResolvedValue(undefined);

    await reconcileStaleSessions(
      'claude',
      {} as NodeJS.ProcessEnv,
      (_env, sessionId) => ({ agentName: 'claude', sessionId }),
      { processEvent, now: fivePm }
    );

    const [event] = processEvent.mock.calls[0] as [{ endTime?: number }];
    expect(event.endTime).toBe(tenAm);
    expect(event.endTime).not.toBe(fivePm);
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

  it('still reconciles a long-lived session whose startTime is old but whose last activity is within lookback', async () => {
    const now = Date.now();
    const lastActivity = now - 2 * 60 * 60 * 1000;
    const ancientStartTime = now - 13 * 24 * 60 * 60 * 1000;

    const { readdir, readFile } = await import('fs/promises');
    vi.mocked(readdir).mockResolvedValue(['stranded-4.json'] as never);
    vi.mocked(readFile).mockResolvedValue(
      strandedSessionFile('stranded-4', 'claude', lastActivity, ancientStartTime) as never
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
  });

  it('reconciles a session abandoned Monday at 09:00, closed at 09:40, and not reopened until Wednesday — more than 24h inactive is not exempt', async () => {
    const monday0900 = new Date('2026-10-12T09:00:00Z').getTime();
    const monday0940 = monday0900 + 40 * 60 * 1000;
    const wednesday = new Date('2026-10-14T09:00:00Z').getTime(); // ~47h after the session's last activity

    const { readdir, readFile } = await import('fs/promises');
    vi.mocked(readdir).mockResolvedValue(['stranded-monday.json'] as never);
    vi.mocked(readFile).mockResolvedValue(
      strandedSessionFile('stranded-monday', 'claude', monday0940, monday0900) as never
    );

    const { reconcileStaleSessions } = await import('../stale-session-reconciliation.js');
    const processEvent = vi.fn().mockResolvedValue(undefined);

    const result = await reconcileStaleSessions(
      'claude',
      {} as NodeJS.ProcessEnv,
      (_env, sessionId) => ({ agentName: 'claude', sessionId }),
      { processEvent, now: wednesday }
    );

    expect(result).toEqual({ reconciled: 1, failed: 0 });
    const [event] = processEvent.mock.calls[0] as [{ endTime?: number }];
    expect(event.endTime).toBe(monday0940);
  });

  it('keeps finding the same stranded session on every subsequent launch as inactivity keeps growing past 24h, not just the first', async () => {
    const start = Date.now();
    const lastActivity = start + 40 * 60 * 1000; // the terminal closed 40 minutes after the session started

    const { readdir, readFile } = await import('fs/promises');
    vi.mocked(readdir).mockResolvedValue(['stranded-repeat.json'] as never);
    vi.mocked(readFile).mockResolvedValue(
      strandedSessionFile('stranded-repeat', 'claude', lastActivity, start) as never
    );

    const { findStaleSessions } = await import('../stale-session-reconciliation.js');

    // Three successive launches, each further past the 24h mark. Nothing here ever marks the
    // file completed, so each call mirrors a launch that still finds the backlog it left — a
    // cap on inactivity age would make exactly the second and third checks start skipping it.
    const oneDayLater = lastActivity + 25 * 60 * 60 * 1000;
    const oneWeekLater = lastActivity + 7 * 24 * 60 * 60 * 1000;
    const oneMonthLater = lastActivity + 30 * 24 * 60 * 60 * 1000;

    for (const now of [oneDayLater, oneWeekLater, oneMonthLater]) {
      const stale = await findStaleSessions('claude', { now });
      expect(stale).toHaveLength(1);
      expect(stale[0].sessionId).toBe('stranded-repeat');
    }
  });

  it('reconciles a session that legitimately ran for about 23.5h once it finally goes idle — session age is not a cap on reconciliation', async () => {
    const now = Date.now();
    const twentyThreeAndHalfHours = 23.5 * 60 * 60 * 1000;
    const startTime = now - twentyThreeAndHalfHours;
    const lastActivity = now - 35 * 60 * 1000; // just past the 30-min inactivity threshold

    const { readdir, readFile } = await import('fs/promises');
    vi.mocked(readdir).mockResolvedValue(['stranded-long-lived.json'] as never);
    vi.mocked(readFile).mockResolvedValue(
      strandedSessionFile('stranded-long-lived', 'claude', lastActivity, startTime) as never
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
  });

  it('uses activityStartedAt as last activity when a process was killed mid-turn before sync caught up', async () => {
    const now = Date.now();
    const staleSyncTime = now - 4 * 60 * 60 * 1000;
    const activityStartedAt = now - 45 * 60 * 1000;
    const startTime = now - 5 * 60 * 60 * 1000;

    const { readdir, readFile } = await import('fs/promises');
    vi.mocked(readdir).mockResolvedValue(['stranded-5.json'] as never);
    vi.mocked(readFile).mockResolvedValue(
      strandedSessionFile('stranded-5', 'claude', staleSyncTime, startTime, undefined, { activityStartedAt }) as never
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
    const [event] = processEvent.mock.calls[0] as [{ endTime?: number }];
    expect(event.endTime).toBe(activityStartedAt);
    expect(event.endTime).not.toBe(staleSyncTime);
  });

  it('replays every persisted transcript path for a stranded multi-transcript session, not just the primary file', async () => {
    const now = Date.now();
    const lastActivity = now - 2 * 60 * 60 * 1000;
    const startTime = lastActivity - 10 * 60 * 1000;
    const transcriptA = '/tmp/pi-a.jsonl';
    const transcriptB = '/tmp/pi-b.jsonl';

    const { readdir, readFile } = await import('fs/promises');
    vi.mocked(readdir).mockResolvedValue(['stranded-6.json'] as never);
    vi.mocked(readFile).mockResolvedValue(
      strandedSessionFile('stranded-6', 'pi', lastActivity, startTime, undefined, {
        correlation: {
          status: 'matched',
          agentSessionFile: transcriptB,
          agentSessionFiles: [transcriptA, transcriptB],
          retryCount: 0,
        },
      }) as never
    );

    const { reconcileStaleSessions } = await import('../stale-session-reconciliation.js');
    const processEvent = vi.fn().mockResolvedValue(undefined);

    await reconcileStaleSessions(
      'pi',
      {} as NodeJS.ProcessEnv,
      (_env, sessionId) => ({ agentName: 'pi', sessionId }),
      { processEvent, now }
    );

    const [event] = processEvent.mock.calls[0] as [{ transcript_path: string; transcript_paths?: string[] }];
    expect(event.transcript_path).toBe(transcriptB);
    expect(event.transcript_paths).toEqual([transcriptA, transcriptB]);
  });

  it('skips reconciliation when another launch already holds the per-session reconciliation lock', async () => {
    const now = Date.now();
    const lastActivity = now - 2 * 60 * 60 * 1000;
    const startTime = lastActivity - 10 * 60 * 1000;
    const lockPath = `${CODEMIE_HOME}/sessions/stranded-locked.reconcile.lock`;

    const { readdir, readFile, writeFile } = await import('fs/promises');
    vi.mocked(readdir).mockResolvedValue(['stranded-locked.json'] as never);
    vi.mocked(readFile).mockResolvedValue(
      strandedSessionFile('stranded-locked', 'claude', lastActivity, startTime) as never
    );
    await writeFile(lockPath, String(process.pid), { flag: 'wx' });

    const { reconcileStaleSessions } = await import('../stale-session-reconciliation.js');
    const processEvent = vi.fn().mockResolvedValue(undefined);

    const result = await reconcileStaleSessions(
      'claude',
      {} as NodeJS.ProcessEnv,
      (_env, sessionId) => ({ agentName: 'claude', sessionId }),
      { processEvent, now }
    );

    expect(result).toEqual({ reconciled: 0, failed: 0 });
    expect(processEvent).not.toHaveBeenCalled();
  });

  it('re-checks current session state under the lock and skips a session another launch already finalized', async () => {
    const now = Date.now();
    const lastActivity = now - 2 * 60 * 60 * 1000;
    const startTime = lastActivity - 10 * 60 * 1000;
    const activePath = `${CODEMIE_HOME}/sessions/stranded-race.json`;
    const completedPath = `${CODEMIE_HOME}/sessions/completed_stranded-race.json`;
    let activeReads = 0;

    const { readdir, readFile } = await import('fs/promises');
    vi.mocked(readdir).mockResolvedValue(['stranded-race.json'] as never);
    vi.mocked(readFile).mockImplementation((async (path: string) => {
      if (path === activePath) {
        activeReads++;
        if (activeReads === 1) {
          return strandedSessionFile('stranded-race', 'claude', lastActivity, startTime);
        }
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      }
      if (path === completedPath) {
        return JSON.stringify({
          sessionId: 'stranded-race',
          agentName: 'claude',
          status: 'completed',
          startTime,
          endTime: lastActivity,
          correlation: { status: 'matched', retryCount: 0 },
        });
      }
      throw new Error(`Unexpected path: ${path}`);
    }) as never);

    const { reconcileStaleSessions } = await import('../stale-session-reconciliation.js');
    const processEvent = vi.fn().mockResolvedValue(undefined);

    const result = await reconcileStaleSessions(
      'claude',
      {} as NodeJS.ProcessEnv,
      (_env, sessionId) => ({ agentName: 'claude', sessionId }),
      { processEvent, now }
    );

    expect(result).toEqual({ reconciled: 0, failed: 0 });
    expect(processEvent).not.toHaveBeenCalled();
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

  it('prefers the stranded session provider/project/model over the current launch env', async () => {
    const { buildReconciliationHookConfig } = await import('../stale-session-reconciliation.js');

    const env: NodeJS.ProcessEnv = {
      CODEMIE_AGENT: 'gemini',
      CODEMIE_CLIENT_TYPE: 'codemie-gemini',
      CODEMIE_PROVIDER: 'ai-run-sso',
      CODEMIE_BASE_URL: 'https://proxy.example.com',
      CODEMIE_URL: 'https://sso.example.com',
      CODEMIE_SYNC_API_URL: 'https://sync.example.com',
      CODEMIE_CLI_VERSION: '1.2.3',
      CODEMIE_PROFILE_NAME: 'work',
      CODEMIE_PROJECT: 'new-project',
      CODEMIE_MODEL: 'gemini-2.5-pro',
    };

    expect(
      buildReconciliationHookConfig(env, 'sid-2', {
        provider: 'litellm',
        project: 'old-project',
        model: 'claude-sonnet-5',
      })
    ).toEqual({
      agentName: 'gemini',
      sessionId: 'sid-2',
      provider: 'litellm',
      apiBaseUrl: 'https://proxy.example.com',
      ssoUrl: 'https://sso.example.com',
      syncApiUrl: 'https://sync.example.com',
      version: '1.2.3',
      profileName: 'work',
      project: 'old-project',
      model: 'claude-sonnet-5',
      clientType: 'codemie-gemini',
    });
  });

  it('prefers the stranded session\'s own agentName/clientType over the launching agent (cross-agent sweep)', async () => {
    const { buildReconciliationHookConfig } = await import('../stale-session-reconciliation.js');

    const env: NodeJS.ProcessEnv = { CODEMIE_AGENT: 'claude', CODEMIE_CLIENT_TYPE: 'codemie-claude' };

    expect(
      buildReconciliationHookConfig(env, 'sid-3', { agentName: 'gemini', clientType: 'codemie-gemini-acp' })
    ).toMatchObject({
      agentName: 'gemini',
      clientType: 'codemie-gemini-acp',
      sessionId: 'sid-3',
    });
  });
});

describe('reconcileStaleSessions — all-agents sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    heldLocks.clear();
  });

  it('agentName: null reconciles stranded sessions of every agent, each filed under its own agentName/clientType', async () => {
    const now = Date.now();
    const lastActivity = now - 2 * 60 * 60 * 1000;
    const startTime = lastActivity - 10 * 60 * 1000;

    const { readdir, readFile } = await import('fs/promises');
    vi.mocked(readdir).mockResolvedValue(['stranded-claude.json', 'stranded-gemini.json'] as never);
    vi.mocked(readFile).mockImplementation(async (path: unknown) => {
      if (String(path).endsWith('stranded-claude.json')) {
        return strandedSessionFile('stranded-claude', 'claude', lastActivity, startTime, undefined, {
          clientType: 'codemie-claude',
        }) as never;
      }
      return strandedSessionFile('stranded-gemini', 'gemini', lastActivity, startTime, undefined, {
        clientType: 'codemie-gemini-acp',
      }) as never;
    });

    const { reconcileStaleSessions, buildReconciliationHookConfig } = await import('../stale-session-reconciliation.js');
    const processEvent = vi.fn().mockResolvedValue(undefined);

    const result = await reconcileStaleSessions(
      null,
      { CODEMIE_AGENT: 'claude', CODEMIE_CLIENT_TYPE: 'codemie-claude' } as NodeJS.ProcessEnv,
      buildReconciliationHookConfig,
      { processEvent, now }
    );

    expect(result).toEqual({ reconciled: 2, failed: 0 });
    expect(processEvent).toHaveBeenCalledTimes(2);

    const configs = processEvent.mock.calls.map(([, config]) => config as { agentName: string; clientType?: string });
    expect(configs.find(c => c.agentName === 'gemini')?.clientType).toBe('codemie-gemini-acp');
    expect(configs.find(c => c.agentName === 'claude')?.clientType).toBe('codemie-claude');
  });

  it('skips runtime-managed sessions (e.g. desktop telemetry) even when stale by inactivity', async () => {
    const now = Date.now();
    const lastActivity = now - 2 * 60 * 60 * 1000;
    const startTime = lastActivity - 10 * 60 * 1000;

    const { readdir, readFile } = await import('fs/promises');
    vi.mocked(readdir).mockResolvedValue(['stranded-claude.json', 'desktop-session.json'] as never);
    vi.mocked(readFile).mockImplementation(async (path: unknown) => {
      if (String(path).endsWith('desktop-session.json')) {
        return strandedSessionFile('desktop-session', 'claude-desktop', lastActivity, startTime, undefined, {
          runtimeCheckpoint: { externalSessionId: 'ext-1', lastSeenActivityAt: lastActivity },
        }) as never;
      }
      return strandedSessionFile('stranded-claude', 'claude', lastActivity, startTime) as never;
    });

    const { findStaleSessions } = await import('../stale-session-reconciliation.js');
    const stale = await findStaleSessions(null, { now });

    expect(stale.map(s => s.sessionId)).toEqual(['stranded-claude']);
  });
});
