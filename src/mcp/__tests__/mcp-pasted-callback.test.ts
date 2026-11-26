/**
 * Finishing an MCP login by pasting the callback URL (codemie mcp-auth).
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { startCallbackServer } from '../auth/callback-server.js';
import { clearPendingLogin, listPendingLogins, writePendingLogin } from '../auth/pending-login.js';
import { deliverCallback, LoginGoneError } from '../../cli/commands/mcp-auth.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'codemie-mcp-auth-'));
  process.env.CODEMIE_HOME = home;
});

afterEach(() => {
  delete process.env.CODEMIE_HOME;
  rmSync(home, { recursive: true, force: true });
});

const login = (redirectUrl: string) => ({
  serverUrl: 'https://mcp.example.com/mcp',
  authorizationUrl: 'https://auth.example.com/authorize?state=s',
  redirectUrl,
});

describe('pending MCP logins', () => {
  it('lists the login this process is waiting on until it is cleared', () => {
    writePendingLogin(login('http://localhost:1/callback'));
    expect(listPendingLogins()).toEqual([{ pid: process.pid, ...login('http://localhost:1/callback') }]);

    clearPendingLogin();
    expect(listPendingLogins()).toEqual([]);
  });

  it('drops logins left behind by proxies that are no longer running', () => {
    writePendingLogin(login('http://localhost:1/callback'));
    writeFileSync(join(home, 'mcp-auth-pending', '999999999.json'), JSON.stringify({ pid: 999_999_999, ...login('x') }));

    expect(listPendingLogins().map((l) => l.pid)).toEqual([process.pid]);
    expect(readdirSync(join(home, 'mcp-auth-pending'))).toEqual([`${process.pid}.json`]);
    clearPendingLogin();
  });
});

describe('deliverCallback', () => {
  it('delivers the pasted callback URL to the waiting callback server', async () => {
    const { redirectUrl, waitForCallback } = await startCallbackServer({ timeoutMs: 5000 });

    const serverUrl = await deliverCallback(`  ${redirectUrl}?code=abc&state=s  `, [{ pid: process.pid, ...login(redirectUrl) }]);

    expect(serverUrl).toBe('https://mcp.example.com/mcp');
    await expect(waitForCallback).resolves.toEqual({ code: 'abc', state: 's' });
  });

  it('refuses URLs that no proxy is waiting on, without sending them', async () => {
    const { redirectUrl, waitForCallback, close } = await startCallbackServer({ timeoutMs: 5000 });
    const pending = [{ pid: process.pid, ...login(redirectUrl) }];

    await expect(deliverCallback('not a url', pending)).rejects.toThrow('That is not a URL');
    await expect(deliverCallback('http://localhost:1/callback?code=abc', pending)).rejects.toThrow('No MCP server is waiting');
    close();
    await expect(waitForCallback).rejects.toThrow('Callback server closed');
  });
});

describe('deliverCallback — loopback address families', () => {
  // "localhost" resolves to ::1 first in most Linux containers, and the callback server listens there
  async function listenOn(address: string): Promise<{ server: Server; port: number; paths: string[] }> {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url ?? '');
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, address, resolve));
    return { server, port: (server.address() as AddressInfo).port, paths };
  }

  it.each(['::1', '127.0.0.1'])('reaches a callback server listening only on %s', async (address) => {
    const { server, port, paths } = await listenOn(address);
    try {
      const redirectUrl = `http://localhost:${port}/callback`;
      await deliverCallback(`'${redirectUrl}?code=abc'`, [{ pid: process.pid, ...login(redirectUrl) }]);
      expect(paths).toEqual(['/callback?code=abc']);
    } finally {
      server.close();
    }
  });

  it('says the login is gone when nothing listens on the callback port any more', async () => {
    const { server, port } = await listenOn('127.0.0.1');
    await new Promise((resolve) => server.close(resolve));
    const redirectUrl = `http://localhost:${port}/callback`;

    await expect(deliverCallback(`${redirectUrl}?code=abc`, [{ pid: process.pid, ...login(redirectUrl) }]))
      .rejects.toBeInstanceOf(LoginGoneError);
  });
});
