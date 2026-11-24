/**
 * markAuthInvalidUnlessSuperseded: the one place the sync clients decide whether a credential
 * rejection may write the analytics invalid-auth marker.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockMark = vi.hoisted(() => vi.fn(async () => undefined));
const mockLoggerDebug = vi.hoisted(() => vi.fn());

vi.mock('@/utils/analytics-auth-status.js', () => ({ markAnalyticsAuthInvalid: mockMark }));
vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: mockLoggerDebug },
}));

const { markAuthInvalidUnlessSuperseded, SUPERSEDED_CHECK_TTL_MS } = await import('../analytics-auth-marker.js');

const BASE_URL = 'http://api.test';
const SENT = 'session=old-cookie-value';

const mark = (
  overrides: Partial<Parameters<typeof markAuthInvalidUnlessSuperseded>[0]> = {}
): ReturnType<typeof markAuthInvalidUnlessSuperseded> =>
  markAuthInvalidUnlessSuperseded({ reason: 'HTTP 401', baseUrl: BASE_URL, cookies: SENT, ...overrides });

describe('markAuthInvalidUnlessSuperseded', () => {
  beforeEach(() => {
    mockMark.mockClear();
    mockLoggerDebug.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('what was sent', () => {
    it('writes the marker when cookies were sent and no check is supplied', async () => {
      await mark();

      expect(mockMark).toHaveBeenCalledExactlyOnceWith('HTTP 401', BASE_URL);
    });

    it('writes the marker in api-key mode without asking the check', async () => {
      const credentialsSuperseded = vi.fn(async () => true);

      await mark({ cookies: '', apiKey: 'dev-user', credentialsSuperseded });

      expect(credentialsSuperseded).not.toHaveBeenCalled();
      expect(mockMark).toHaveBeenCalledTimes(1);
    });

    it('writes no marker when no credentials were sent at all, and says so at debug level', async () => {
      const credentialsSuperseded = vi.fn(async () => false);

      await mark({ cookies: '', credentialsSuperseded });
      await mark({ cookies: undefined, apiKey: undefined });

      expect(credentialsSuperseded).not.toHaveBeenCalled();
      expect(mockMark).not.toHaveBeenCalled();
      expect(mockLoggerDebug).toHaveBeenCalledWith(expect.stringMatching(/no credentials/i));
    });
  });

  describe('the superseded check', () => {
    it('skips the marker when the check reports the sent cookies superseded, and logs it without the cookies', async () => {
      const credentialsSuperseded = vi.fn(async () => true);

      await mark({ credentialsSuperseded });

      expect(credentialsSuperseded).toHaveBeenCalledWith(SENT);
      expect(mockMark).not.toHaveBeenCalled();
      expect(mockLoggerDebug).toHaveBeenCalledWith(expect.stringMatching(/newer sign-in/i));
      expect(JSON.stringify(mockLoggerDebug.mock.calls)).not.toContain('old-cookie-value');
    });

    it('writes the marker when the check reports false', async () => {
      await mark({ credentialsSuperseded: async () => false });

      expect(mockMark).toHaveBeenCalledTimes(1);
    });

    it('writes the marker when the check throws', async () => {
      await mark({ credentialsSuperseded: async () => { throw new Error('store unreadable'); } });

      expect(mockMark).toHaveBeenCalledTimes(1);
    });

    it('logs a failing check without the secret its error carries, and still writes the marker', async () => {
      // Built from parts so the source holds no JWT-shaped literal for the secret scanner.
      const jwt = ['eyJhbGciOiJIUzI1NiIsInR5cCI6', 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFt', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV'].join('.');

      await mark({ credentialsSuperseded: async () => { throw new Error(jwt); } });

      const logged = mockLoggerDebug.mock.calls
        .flat()
        .map((arg) => (arg instanceof Error ? arg.message : JSON.stringify(arg)))
        .join(' | ');
      expect(logged).toMatch(/superseded-credentials check failed/i);
      expect(logged).not.toContain(jwt);
      expect(mockMark).toHaveBeenCalledTimes(1);
    });

    it('does not let a synchronously throwing check escape', async () => {
      await mark({ credentialsSuperseded: () => { throw new Error('boom'); } });

      expect(mockMark).toHaveBeenCalledTimes(1);
    });
  });

  describe('answer reuse', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
    });

    it('asks once for many failures while the answer is true, and asks again after the TTL', async () => {
      const credentialsSuperseded = vi.fn(async () => true);

      for (let i = 0; i < 5; i++) await mark({ credentialsSuperseded });
      expect(credentialsSuperseded).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(SUPERSEDED_CHECK_TTL_MS - 1);
      await mark({ credentialsSuperseded });
      expect(credentialsSuperseded).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2);
      await mark({ credentialsSuperseded });
      expect(credentialsSuperseded).toHaveBeenCalledTimes(2);
      expect(mockMark).not.toHaveBeenCalled();
    });

    it('counts the TTL from when the check answered, not from when it was asked', async () => {
      let release!: (value: boolean) => void;
      const credentialsSuperseded = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));

      const first = mark({ credentialsSuperseded });
      await vi.waitFor(() => expect(credentialsSuperseded).toHaveBeenCalledTimes(1));
      vi.advanceTimersByTime(SUPERSEDED_CHECK_TTL_MS * 2);
      release(true);
      await first;
      await mark({ credentialsSuperseded });

      expect(credentialsSuperseded).toHaveBeenCalledTimes(1);
    });

    it('does not reuse a false answer once it settled: a later failure asks again and sees a sign-in that finished meanwhile', async () => {
      const credentialsSuperseded = vi.fn<(sent: string) => Promise<boolean>>()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      await mark({ credentialsSuperseded });
      expect(mockMark).toHaveBeenCalledTimes(1);

      await mark({ credentialsSuperseded });

      expect(credentialsSuperseded).toHaveBeenCalledTimes(2);
      expect(mockMark).toHaveBeenCalledTimes(1);
    });

    it('does not reuse a thrown check either', async () => {
      const credentialsSuperseded = vi.fn(async (): Promise<boolean> => { throw new Error('store unreadable'); });

      await mark({ credentialsSuperseded });
      await mark({ credentialsSuperseded });

      expect(credentialsSuperseded).toHaveBeenCalledTimes(2);
      expect(mockMark).toHaveBeenCalledTimes(2);
    });

    it('lets concurrent failures share one in-flight check, true or false', async () => {
      for (const answer of [true, false]) {
        mockMark.mockClear();
        let release!: (value: boolean) => void;
        const credentialsSuperseded = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));

        const all = Promise.all([mark({ credentialsSuperseded }), mark({ credentialsSuperseded }), mark({ credentialsSuperseded })]);
        await vi.waitFor(() => expect(credentialsSuperseded).toHaveBeenCalledTimes(1));
        release(answer);
        await all;

        expect(credentialsSuperseded).toHaveBeenCalledTimes(1);
        expect(mockMark).toHaveBeenCalledTimes(answer ? 0 : 3);
      }
    });

    it('asks again for a different cookie header', async () => {
      const credentialsSuperseded = vi.fn(async () => true);

      await mark({ credentialsSuperseded, cookies: 'session=first' });
      await mark({ credentialsSuperseded, cookies: 'session=second' });
      await mark({ credentialsSuperseded, cookies: 'session=first' });

      expect(credentialsSuperseded.mock.calls.map(([sent]) => sent)).toEqual(['session=first', 'session=second']);
    });

    it('keeps answers apart per check callback', async () => {
      const a = vi.fn(async () => true);
      const b = vi.fn(async () => true);

      await mark({ credentialsSuperseded: a });
      await mark({ credentialsSuperseded: b });

      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });
  });
});
