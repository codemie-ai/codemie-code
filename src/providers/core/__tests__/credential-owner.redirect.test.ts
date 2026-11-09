/**
 * EPMCDME-16776 review: the unattended owner lookup must never forward the stored session cookies to another origin.
 * An expired oauth2-proxy session answers 302 to the IdP; that is a failed lookup, not a hop to follow.
 * Real: withVerifiedOwner, fetchCodeMieUserInfo, HTTPClient and two local HTTP servers. Mocked: logger only.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), isDebugMode: () => false } }));

const { withVerifiedOwner } = await import('../credential-owner.js');

function listen(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
    });
  });
}

describe('owner lookup does not follow redirects', () => {
  let home = '';
  const prior = process.env.CODEMIE_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'owner-redirect-'));
    process.env.CODEMIE_HOME = home;
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = prior;
    rmSync(home, { recursive: true, force: true });
  });

  it('a 302 from /v1/user fails the lookup and the cookies never reach the redirect target', async () => {
    const seen: Array<string | undefined> = [];
    const idp = await listen((req, res) => {
      seen.push(req.headers.cookie);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ email: 'idp@example.com', applications: [], applications_admin: [] }));
    });
    const api = await listen((_req, res) => {
      res.writeHead(302, { location: `${idp.url}/oauth2/start?rd=secret` });
      res.end();
    });
    try {
      const creds = { cookies: { _oauth2_proxy: 'SYNTHETIC-redirect' }, apiUrl: api.url };
      const result = await withVerifiedOwner(creds);
      expect(result.email).toBeUndefined();
      expect(seen).toEqual([]); // the second origin was never contacted
    } finally {
      api.server.close();
      idp.server.close();
    }
  });

  it('a 200 answer without applications arrays still yields the email (only email is required)', async () => {
    const api = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ email: 'Slim@Example.com' }));
    });
    try {
      const result = await withVerifiedOwner({ cookies: { _oauth2_proxy: 'SYNTHETIC-slim' }, apiUrl: api.url });
      expect(result.email).toBe('Slim@Example.com');
    } finally {
      api.server.close();
    }
  });
});
