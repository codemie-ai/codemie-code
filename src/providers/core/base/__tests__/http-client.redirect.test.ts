/**
 * EPMCDME-15411 review (PR #758, finding 1): credentials never follow a redirect to another origin.
 * Real: HTTPClient, fetchCodeMieUserInfo, fetchCodeMieIntegrations and local HTTP servers. Mocked: logger only.
 * @group unit
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';

vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), isDebugMode: () => false } }));

const { HTTPClient } = await import('../http-client.js');
const { fetchCodeMieUserInfo } = await import('../../codemie-auth-helpers.js');
const { fetchCodeMieIntegrations } = await import('../../../plugins/sso/sso.http-client.js');

interface Seen { path?: string; cookie?: string; authorization?: string }

const servers: http.Server[] = [];
function listen(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    });
  });
}

/** B (the redirect target) records what it receives and answers with an empty JSON body. */
async function target(seen: Seen[], body = '[]'): Promise<string> {
  return listen((req, res) => {
    seen.push({ path: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' }).end(body);
  });
}

/** A answers every request with a 302 to `to` (same path), setting a cookie on the way. */
async function redirector(to: () => string): Promise<string> {
  return listen((req, res) => {
    res.writeHead(302, { location: `${to()}${req.url}`, 'set-cookie': 'fresh=1; Path=/' }).end();
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe('HTTPClient redirect credential policy', () => {
  it('drops cookie and authorization on a cross-origin hop (port differs)', async () => {
    const seen: Seen[] = [];
    const b = await target(seen);
    const a = await redirector(() => b);
    const client = new HTTPClient({ maxRetries: 1 });

    await client.getRaw(`${a}/v1/user`, { cookie: 'session=secret', Authorization: 'Bearer secret-token' });

    expect(seen).toHaveLength(1);
    expect(seen[0].cookie).toBeUndefined();
    expect(seen[0].authorization).toBeUndefined();
  });

  it('keeps credentials, plus cookies set on the redirect, on a same-origin hop', async () => {
    const seen: Seen[] = [];
    const a = await listen((req, res) => {
      if (req.url === '/old') {
        res.writeHead(302, { location: '/new', 'set-cookie': 'fresh=1; Path=/' }).end();
        return;
      }
      seen.push({ path: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization });
      res.writeHead(200).end('ok');
    });
    const client = new HTTPClient({ maxRetries: 1 });

    await client.getRaw(`${a}/old`, { cookie: 'session=secret', authorization: 'Bearer t' });

    expect(seen).toEqual([{ path: '/new', cookie: 'session=secret; fresh=1', authorization: 'Bearer t' }]);
  });

  it('does not mutate the caller headers', async () => {
    const seen: Seen[] = [];
    const b = await target(seen);
    const a = await redirector(() => b);
    const headers = { cookie: 'session=secret' };

    await new HTTPClient({ maxRetries: 1 }).getRaw(`${a}/x`, headers);

    expect(headers).toEqual({ cookie: 'session=secret' });
  });
});

describe('CodeMie calls behind a cross-origin redirect', () => {
  const userBody = JSON.stringify({ userId: 'u', name: 'n', username: 'n', isAdmin: false, applications: ['p'], applications_admin: [] });

  it('fetchCodeMieUserInfo with cookies sends none to the redirect target', async () => {
    const seen: Seen[] = [];
    const b = await target(seen, userBody);
    const a = await redirector(() => b);

    await fetchCodeMieUserInfo(a, { session: 'secret' }, { maxRetries: 1 });

    expect(seen[0]).toMatchObject({ path: '/v1/user', cookie: undefined, authorization: undefined });
  });

  it('fetchCodeMieUserInfo with a JWT sends no bearer token to the redirect target', async () => {
    const seen: Seen[] = [];
    const b = await target(seen, userBody);
    const a = await redirector(() => b);

    await fetchCodeMieUserInfo(a, 'header.payload.sig', { maxRetries: 1 });

    expect(seen[0]).toMatchObject({ path: '/v1/user', authorization: undefined, cookie: undefined });
  });

  it('fetchCodeMieIntegrations sends no cookie to the redirect target', async () => {
    const seen: Seen[] = [];
    const b = await target(seen, '[]');
    const a = await redirector(() => b);

    await fetchCodeMieIntegrations(a, { session: 'secret' }).catch(() => undefined);

    expect(seen.length).toBeGreaterThan(0);
    for (const req of seen) expect(req.cookie).toBeUndefined();
  });
});
