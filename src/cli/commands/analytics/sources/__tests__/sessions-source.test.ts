import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RawSessionData } from '../../data-loader.js';

const mockLoadSessions = vi.fn();
const mockSessionMatchesFilter = vi.fn();

vi.mock('../../data-loader.js', () => ({
  MetricsDataLoader: vi.fn().mockImplementation(function MockMetricsDataLoader() {
    this.loadSessions = mockLoadSessions;
    this.sessionMatchesFilter = mockSessionMatchesFilter;
  })
}));

const mockLoadNativeSessions = vi.fn();

vi.mock('../../native-loader.js', () => ({
  loadNativeSessions: mockLoadNativeSessions
}));

function makeSession(sessionId: string, provider: string): RawSessionData {
  return {
    sessionId,
    startEvent: {
      recordId: sessionId,
      type: 'session_start',
      timestamp: 0,
      codeMieSessionId: sessionId,
      agentName: 'claude',
      syncStatus: 'synced',
      data: { provider, workingDirectory: '/tmp', startTime: 0 }
    },
    deltas: []
  };
}

describe('SessionsSource', () => {
  beforeEach(() => {
    mockLoadSessions.mockReturnValue([]);
    mockSessionMatchesFilter.mockReturnValue(true);
    mockLoadNativeSessions.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('excludes native-external sessions by default', async () => {
    const owned = makeSession('owned-1', 'native');
    const external = makeSession('external-1', 'native-external');
    mockLoadNativeSessions.mockResolvedValue([owned, external]);

    const { SessionsSource } = await import('../sessions-source.js');
    const source = new SessionsSource();
    const result = await source.load({ filter: {} });

    expect(result.rawSessions.map((s) => s.sessionId)).toEqual(['owned-1']);
  });

  it('includes native-external sessions when includeExternal is true', async () => {
    const owned = makeSession('owned-1', 'native');
    const external = makeSession('external-1', 'native-external');
    mockLoadNativeSessions.mockResolvedValue([owned, external]);

    const { SessionsSource } = await import('../sessions-source.js');
    const source = new SessionsSource();
    const result = await source.load({ filter: {}, includeExternal: true });

    expect(result.rawSessions.map((s) => s.sessionId).sort()).toEqual(['external-1', 'owned-1']);
  });

  it('tells the native loader whether external sessions are wanted, so it can skip parsing them', async () => {
    const { SessionsSource } = await import('../sessions-source.js');
    const filter = { agentName: 'claude' };

    await new SessionsSource().load({ filter, includeExternal: true });
    await new SessionsSource().load({ filter });
    await new SessionsSource().load({ filter, includeExternal: false });

    expect(mockLoadNativeSessions.mock.calls).toEqual([
      [filter, undefined, { includeExternal: true }],
      [filter, undefined, { includeExternal: false }],
      [filter, undefined, { includeExternal: false }],
    ]);
  });

  it('always includes owned native sessions regardless of includeExternal', async () => {
    const owned = makeSession('owned-1', 'native');
    mockLoadNativeSessions.mockResolvedValue([owned]);

    const { SessionsSource } = await import('../sessions-source.js');
    const source = new SessionsSource();
    const result = await source.load({ filter: {} });

    expect(result.rawSessions.map((s) => s.sessionId)).toEqual(['owned-1']);
  });

  it('applies sessionMatchesFilter before the external-session filter', async () => {
    const external = makeSession('external-1', 'native-external');
    mockLoadNativeSessions.mockResolvedValue([external]);
    mockSessionMatchesFilter.mockReturnValue(false);

    const { SessionsSource } = await import('../sessions-source.js');
    const source = new SessionsSource();
    const result = await source.load({ filter: {}, includeExternal: true });

    expect(result.rawSessions).toEqual([]);
    expect(mockSessionMatchesFilter).toHaveBeenCalledWith(external, {});
  });

  it('includes tracked sessions from the loader unconditionally', async () => {
    const tracked = makeSession('tracked-1', 'native');
    mockLoadSessions.mockReturnValue([tracked]);
    mockLoadNativeSessions.mockResolvedValue([]);

    const { SessionsSource } = await import('../sessions-source.js');
    const source = new SessionsSource();
    const result = await source.load({ filter: {} });

    expect(result.rawSessions.map((s) => s.sessionId)).toEqual(['tracked-1']);
  });
});
