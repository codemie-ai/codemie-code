/**
 * MetricsSender: the invalid-auth marker is skipped when the credentials that
 * were rejected have since been replaced by a newer sign-in.
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MetricsSender } from '../metrics-api-client.js';
import { logger } from '../../../../../../../utils/logger.js';

const SENT_COOKIES = 'session=old-cookie-value';

function makeSession(workingDirectory: string): Parameters<MetricsSender['sendSessionStart']>[0] {
  return {
    sessionId: 'sess-superseded',
    agentName: 'claude',
    provider: 'ai-run-sso',
    project: 'demo-project',
    startTime: Date.now(),
    workingDirectory,
    repository: 'owner/repo',
    model: 'gpt-test'
  };
}

const unauthorized = (): Response =>
  new Response(JSON.stringify({ message: 'unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json' }
  });

const loginPage = (): Response =>
  new Response('<html><body>Sign in</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html' }
  });

const jsonOk = (): Response =>
  new Response(JSON.stringify({ success: true, message: 'ok' }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });

describe('MetricsSender with a superseded-credentials check', () => {
  let home: string;
  let markerPath: string;
  let originalHome: string | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalHome = process.env.CODEMIE_HOME;
    home = mkdtempSync(join(tmpdir(), 'metrics-superseded-'));
    process.env.CODEMIE_HOME = home;
    markerPath = join(home, 'analytics-auth-status.json');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (originalHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = originalHome;
    await logger.close();
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best-effort */ }
  });

  const send = (sender: MetricsSender): Promise<unknown> =>
    sender.sendSessionStart(makeSession(home), home, { status: 'started' });

  const rejection: Array<[string, () => Response, RegExp]> = [
    ['a 401', unauthorized, /401/],
    ['an HTML login page answered with 200', loginPage, /non-JSON/]
  ];

  for (const [label, respond, pattern] of rejection) {
    describe(`on ${label}`, () => {
      beforeEach(() => {
        fetchMock.mockImplementation(async () => respond());
      });

      it('writes no marker when the check reports the credentials superseded, and still throws', async () => {
        const credentialsSuperseded = vi.fn(async () => true);
        const sender = new MetricsSender({
          baseUrl: 'http://api.test', cookies: SENT_COOKIES, retryAttempts: 0, credentialsSuperseded
        });

        await expect(send(sender)).rejects.toThrow(pattern);

        expect(credentialsSuperseded).toHaveBeenCalledWith(SENT_COOKIES);
        expect(existsSync(markerPath)).toBe(false);
      });

      it('writes the marker when the check reports false', async () => {
        const sender = new MetricsSender({
          baseUrl: 'http://api.test', cookies: SENT_COOKIES, retryAttempts: 0,
          credentialsSuperseded: async () => false
        });

        await expect(send(sender)).rejects.toThrow(pattern);

        expect(existsSync(markerPath)).toBe(true);
      });

      it('writes the marker when the check throws', async () => {
        const sender = new MetricsSender({
          baseUrl: 'http://api.test', cookies: SENT_COOKIES, retryAttempts: 0,
          credentialsSuperseded: async () => { throw new Error('store unreadable'); }
        });

        await expect(send(sender)).rejects.toThrow(pattern);

        expect(existsSync(markerPath)).toBe(true);
      });

      it('writes the marker when no check is supplied', async () => {
        const sender = new MetricsSender({ baseUrl: 'http://api.test', cookies: SENT_COOKIES, retryAttempts: 0 });

        await expect(send(sender)).rejects.toThrow(pattern);

        expect(existsSync(markerPath)).toBe(true);
      });
    });
  }

  it('does not re-create a marker that a newer sign-in already cleared', async () => {
    fetchMock.mockImplementation(async () => unauthorized());
    const sender = new MetricsSender({
      baseUrl: 'http://api.test', cookies: SENT_COOKIES, retryAttempts: 0,
      credentialsSuperseded: async () => true
    });

    await expect(send(sender)).rejects.toThrow(/401/);
    await expect(send(sender)).rejects.toThrow(/401/);

    expect(existsSync(markerPath)).toBe(false);
  });

  it('does not ask the check for a failure that is not an auth failure', async () => {
    fetchMock.mockImplementation(async () => new Response(
      JSON.stringify({ message: 'boom' }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    ));
    const credentialsSuperseded = vi.fn(async () => true);
    const sender = new MetricsSender({
      baseUrl: 'http://api.test', cookies: SENT_COOKIES, retryAttempts: 0, credentialsSuperseded
    });

    await expect(send(sender)).rejects.toThrow(/400/);

    expect(credentialsSuperseded).not.toHaveBeenCalled();
    expect(existsSync(markerPath)).toBe(false);
  });

  it('never asks the check in API-key mode', async () => {
    fetchMock.mockImplementation(async () => unauthorized());
    const credentialsSuperseded = vi.fn(async () => true);
    const sender = new MetricsSender({
      baseUrl: 'http://api.test', apiKey: 'dev-user', retryAttempts: 0, credentialsSuperseded
    });

    await expect(send(sender)).rejects.toThrow(/401/);

    expect(credentialsSuperseded).not.toHaveBeenCalled();
  });

  it('a successful send is unaffected by the check', async () => {
    fetchMock.mockImplementation(async () => jsonOk());
    const credentialsSuperseded = vi.fn(async () => true);
    const sender = new MetricsSender({
      baseUrl: 'http://api.test', cookies: SENT_COOKIES, retryAttempts: 0, credentialsSuperseded
    });

    await expect(send(sender)).resolves.toEqual({ success: true, message: 'ok' });
    expect(credentialsSuperseded).not.toHaveBeenCalled();
  });

  describe('memoised check', () => {
    const TTL_MS = 5_000;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      fetchMock.mockImplementation(async () => unauthorized());
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const senderWith = (
      credentialsSuperseded: (sent: string) => Promise<boolean>,
      cookies: string = SENT_COOKIES
    ): MetricsSender =>
      new MetricsSender({ baseUrl: 'http://api.test', cookies, retryAttempts: 0, credentialsSuperseded });

    it('asks the check once for many failing sends of one pass', async () => {
      const credentialsSuperseded = vi.fn(async () => true);
      const sender = senderWith(credentialsSuperseded);

      for (let i = 0; i < 5; i++) {
        await expect(send(sender)).rejects.toThrow(/401/);
      }

      expect(credentialsSuperseded).toHaveBeenCalledTimes(1);
      expect(existsSync(markerPath)).toBe(false);
    });

    it('lets concurrent failures share one in-flight check', async () => {
      let release!: (value: boolean) => void;
      const credentialsSuperseded = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
      const sender = senderWith(credentialsSuperseded);

      const sends = [send(sender), send(sender), send(sender)].map((p) => expect(p).rejects.toThrow(/401/));
      await vi.waitFor(() => expect(credentialsSuperseded).toHaveBeenCalledTimes(1));
      release(true);
      await Promise.all(sends);

      expect(credentialsSuperseded).toHaveBeenCalledTimes(1);
      expect(existsSync(markerPath)).toBe(false);
    });

    it('asks again once the answer is older than the TTL', async () => {
      const credentialsSuperseded = vi.fn(async () => true);
      const sender = senderWith(credentialsSuperseded);

      await expect(send(sender)).rejects.toThrow(/401/);
      vi.advanceTimersByTime(TTL_MS - 1);
      await expect(send(sender)).rejects.toThrow(/401/);
      expect(credentialsSuperseded).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2);
      await expect(send(sender)).rejects.toThrow(/401/);

      expect(credentialsSuperseded).toHaveBeenCalledTimes(2);
    });

    it('counts the TTL from the moment the check answered, not from when it was asked', async () => {
      let release!: (value: boolean) => void;
      const credentialsSuperseded = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
      const sender = senderWith(credentialsSuperseded);

      const first = expect(send(sender)).rejects.toThrow(/401/);
      await vi.waitFor(() => expect(credentialsSuperseded).toHaveBeenCalledTimes(1));
      vi.advanceTimersByTime(TTL_MS * 2);
      release(true);
      await first;
      await expect(send(sender)).rejects.toThrow(/401/);

      expect(credentialsSuperseded).toHaveBeenCalledTimes(1);
    });

    it('asks again for a different cookie header', async () => {
      const credentialsSuperseded = vi.fn(async () => true);

      await expect(send(senderWith(credentialsSuperseded, 'session=first'))).rejects.toThrow(/401/);
      await expect(send(senderWith(credentialsSuperseded, 'session=second'))).rejects.toThrow(/401/);
      await expect(send(senderWith(credentialsSuperseded, 'session=first'))).rejects.toThrow(/401/);

      expect(credentialsSuperseded.mock.calls.map(([sent]) => sent)).toEqual(['session=first', 'session=second']);
    });

    it('keeps writing the marker, once per failure, when the cached answer is "not superseded"', async () => {
      const credentialsSuperseded = vi.fn(async () => false);
      const sender = senderWith(credentialsSuperseded);

      await expect(send(sender)).rejects.toThrow(/401/);
      expect(existsSync(markerPath)).toBe(true);
      rmSync(markerPath);
      await expect(send(sender)).rejects.toThrow(/401/);

      expect(credentialsSuperseded).toHaveBeenCalledTimes(1);
      expect(existsSync(markerPath)).toBe(true);
    });

    it('caches a throwing check as "not superseded"', async () => {
      const credentialsSuperseded = vi.fn(async (): Promise<boolean> => { throw new Error('store unreadable'); });
      const sender = senderWith(credentialsSuperseded);

      await expect(send(sender)).rejects.toThrow(/401/);
      await expect(send(sender)).rejects.toThrow(/401/);

      expect(credentialsSuperseded).toHaveBeenCalledTimes(1);
      expect(existsSync(markerPath)).toBe(true);
    });
  });
});
