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
});
