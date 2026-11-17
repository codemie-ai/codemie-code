import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real SDK, real credential store and real SSO lookup; only the config and the terminal output are replaced.
const mockConfigLoad = vi.fn();
vi.mock('ora', () => ({ default: () => ({ start: () => ({ text: '', succeed: vi.fn(), fail: vi.fn() }) }) }));
vi.mock('../config.js', () => ({ ConfigLoader: { load: () => mockConfigLoad() } }));
vi.mock('../logger.js', () => ({ logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import { getCodemieClient } from '../sdk-client.js';
import { CredentialStore } from '../security.js';

const COOKIE = '_oauth2_proxy=cookie-value';

describe('getCodemieClient against an API that accepts the session cookie', () => {
  let server: Server;
  let baseUrl: string;
  let seenCookies: Array<string | undefined>;
  let home: string;
  let previousHome: string | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      seenCookies.push(req.headers.cookie);
      const accepted = req.headers.cookie === COOKIE;
      res.writeHead(accepted ? 200 : 401, { 'content-type': 'application/json' });
      res.end(accepted ? '[]' : JSON.stringify({ error: { message: 'Authentication failed' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    seenCookies = [];
    previousHome = process.env.CODEMIE_HOME;
    home = mkdtempSync(join(tmpdir(), 'codemie-sdk-client-api-'));
    process.env.CODEMIE_HOME = home;
    mockConfigLoad.mockResolvedValue({ provider: 'ai-run-sso', baseUrl });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('reaches the API with a cookie-only credential saved 24h + 1min ago, and keeps it stored', async () => {
    const store = CredentialStore.getInstance();
    await store.storeSSOCredentials(
      { cookies: { _oauth2_proxy: 'cookie-value' }, apiUrl: baseUrl, expiresAt: Date.now() - 60_000 },
      baseUrl
    );

    const client = await getCodemieClient(true);
    await expect(client.llms.list()).resolves.toEqual([]);

    expect(seenCookies).toEqual([COOKIE]);
    expect(await store.retrieveSSOCredentials(baseUrl)).toMatchObject({ cookies: { _oauth2_proxy: 'cookie-value' } });
  });

  it('does not decide locally: a cookie the API refuses is sent and the API\'s 401 reaches the caller', async () => {
    await CredentialStore.getInstance().storeSSOCredentials(
      { cookies: { _oauth2_proxy: 'revoked' }, apiUrl: baseUrl },
      baseUrl
    );

    const client = await getCodemieClient(true);
    await expect(client.llms.list()).rejects.toThrow('Authentication failed');
    expect(seenCookies).toEqual(['_oauth2_proxy=revoked']);
  });
});
