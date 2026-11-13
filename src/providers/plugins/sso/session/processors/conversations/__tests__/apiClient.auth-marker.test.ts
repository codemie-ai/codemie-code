/**
 * ConversationApiClient: when a credential rejection may write the analytics invalid-auth marker.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApiClient } from '../apiClient.js';
import { logger } from '@/utils/logger.js';

const SENT_COOKIES = 'session=old-cookie-value';

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

describe('ConversationApiClient analytics auth marker', () => {
  let home: string;
  let markerPath: string;
  let originalHome: string | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalHome = process.env.CODEMIE_HOME;
    home = mkdtempSync(join(tmpdir(), 'conversation-auth-marker-'));
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

  const rejection: Array<[string, () => Response]> = [
    ['a 401', unauthorized],
    ['an HTML login page answered with 200', loginPage]
  ];

  for (const [label, respond] of rejection) {
    describe(`on ${label}`, () => {
      beforeEach(() => {
        fetchMock.mockImplementation(async () => respond());
      });

      const upsert = (config: Parameters<typeof createApiClient>[0]) =>
        createApiClient({ retryAttempts: 1, ...config }).upsertConversation('conv-1', []);

      it('writes no marker when the check reports the sent cookies superseded, and still fails the upsert', async () => {
        const credentialsSuperseded = vi.fn(async () => true);

        const result = await upsert({ baseUrl: 'http://api.test', cookies: SENT_COOKIES, credentialsSuperseded });

        expect(result.success).toBe(false);
        expect(credentialsSuperseded).toHaveBeenCalledWith(SENT_COOKIES);
        expect(existsSync(markerPath)).toBe(false);
      });

      it('writes the marker when the check reports false', async () => {
        await upsert({ baseUrl: 'http://api.test', cookies: SENT_COOKIES, credentialsSuperseded: async () => false });

        expect(existsSync(markerPath)).toBe(true);
      });

      it('writes the marker when the check throws', async () => {
        await upsert({
          baseUrl: 'http://api.test',
          cookies: SENT_COOKIES,
          credentialsSuperseded: async () => { throw new Error('store unreadable'); }
        });

        expect(existsSync(markerPath)).toBe(true);
      });

      it('writes the marker when no check is supplied', async () => {
        await upsert({ baseUrl: 'http://api.test', cookies: SENT_COOKIES });

        expect(existsSync(markerPath)).toBe(true);
      });

      it('writes the marker in api-key mode without asking the check', async () => {
        const credentialsSuperseded = vi.fn(async () => true);

        await upsert({ baseUrl: 'http://api.test', apiKey: 'dev-user', credentialsSuperseded });

        expect(credentialsSuperseded).not.toHaveBeenCalled();
        expect(existsSync(markerPath)).toBe(true);
      });

      it('writes no marker when no credentials were sent at all', async () => {
        const credentialsSuperseded = vi.fn(async () => false);

        const result = await upsert({ baseUrl: 'http://api.test', cookies: '', credentialsSuperseded });

        expect(result.success).toBe(false);
        expect(credentialsSuperseded).not.toHaveBeenCalled();
        expect(existsSync(markerPath)).toBe(false);
      });
    });
  }
});
