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

function makeSession(sessionId: string, provider: string, startTime = 0): RawSessionData {
  return {
    sessionId,
    startEvent: {
      recordId: sessionId,
      type: 'session_start',
      timestamp: startTime,
      codeMieSessionId: sessionId,
      agentName: 'claude',
      syncStatus: 'synced',
      data: { provider, workingDirectory: '/tmp', startTime }
    },
    deltas: []
  };
}

/** A native loader that returns `sessions` less the ones the caller's `keep` rejects, as the real one does. */
function nativesFrom(sessions: RawSessionData[]) {
  return async (_filter: unknown, _deps: unknown, opts?: { keep?: (s: RawSessionData) => boolean }) =>
    sessions.filter((s) => !opts?.keep || opts.keep(s));
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
    mockLoadNativeSessions.mockImplementation(nativesFrom([owned, external]));

    const { SessionsSource } = await import('../sessions-source.js');
    const source = new SessionsSource();
    const result = await source.load({ filter: {} });

    expect(result.rawSessions.map((s) => s.sessionId)).toEqual(['owned-1']);
  });

  it('includes native-external sessions when includeExternal is true', async () => {
    const owned = makeSession('owned-1', 'native');
    const external = makeSession('external-1', 'native-external');
    mockLoadNativeSessions.mockImplementation(nativesFrom([owned, external]));

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
      [filter, undefined, { includeExternal: true, keep: expect.any(Function) }],
      [filter, undefined, { includeExternal: false, keep: expect.any(Function) }],
      [filter, undefined, { includeExternal: false, keep: expect.any(Function) }],
    ]);
  });

  it('has the native loader drop out-of-range sessions with includeExternal, and native-external ones without it', async () => {
    const { MetricsDataLoader: RealLoader } = await vi.importActual<typeof import('../../data-loader.js')>('../../data-loader.js');
    const realLoader = new RealLoader('/nonexistent-sessions-dir');
    mockSessionMatchesFilter.mockImplementation((s, f) => realLoader.sessionMatchesFilter(s, f));
    const filter = { fromDate: new Date('2026-11-14T00:00:00Z'), toDate: new Date('2026-11-16T23:59:59.999Z') };
    const inside = Date.parse('2026-11-15T12:00:00Z');
    const after = Date.parse('2026-11-17T00:01:00Z');
    const sessions = [
      makeSession('owned-in', 'native', inside),
      makeSession('external-in', 'native-external', inside),
      makeSession('owned-after', 'native', after),
      makeSession('external-after', 'native-external', after),
    ];
    mockLoadNativeSessions.mockImplementation(nativesFrom(sessions));
    mockLoadSessions.mockImplementation(() => []); // a fresh array per load: the source appends to it

    const { SessionsSource } = await import('../sessions-source.js');
    const ids = async (includeExternal?: boolean) =>
      (await new SessionsSource().load({ filter, includeExternal })).rawSessions.map((s) => s.sessionId);

    expect(await ids(true)).toEqual(['owned-in', 'external-in']);
    expect(await ids()).toEqual(['owned-in']);
    const keeps = mockLoadNativeSessions.mock.calls.map(([, , opts]) => opts.keep);
    expect(sessions.map((s) => keeps[0](s))).toEqual([true, true, false, false]);
    expect(sessions.map((s) => keeps[1](s))).toEqual([true, false, false, false]);
  });

  it('always includes owned native sessions regardless of includeExternal', async () => {
    const owned = makeSession('owned-1', 'native');
    mockLoadNativeSessions.mockImplementation(nativesFrom([owned]));

    const { SessionsSource } = await import('../sessions-source.js');
    const source = new SessionsSource();
    const result = await source.load({ filter: {} });

    expect(result.rawSessions.map((s) => s.sessionId)).toEqual(['owned-1']);
  });

  it('applies sessionMatchesFilter before the external-session filter', async () => {
    const external = makeSession('external-1', 'native-external');
    mockLoadNativeSessions.mockImplementation(nativesFrom([external]));
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
