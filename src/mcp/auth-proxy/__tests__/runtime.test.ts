/**
 * runtime tests — real daemon runtime in-process with an isolated CODEMIE_HOME.
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'codemie-home-'));
  vi.stubEnv('CODEMIE_HOME', home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('runAuthProxyDaemon tls', () => {
  it('starts an https listener and records tls in the state file', async () => {
    const configPath = join(home, 'mcp-auth-proxy.json');
    const stateFile = join(home, 'mcp-auth-proxy.state.json');
    await writeFile(
      configPath,
      JSON.stringify({
        tls: true,
        servers: { radar: { upstreamUrl: 'https://mcp.example.com/radar' } },
      }),
      'utf-8'
    );

    // Dynamic imports AFTER the env stub so getCodemiePath sees the temp home.
    const { runAuthProxyDaemon } = await import('../runtime.js');
    const { ensureAuthProxyCerts } = await import('../certs.js');

    // port: 0 via options — the config validator (by design) rejects 0 in the file.
    const daemon = await runAuthProxyDaemon({ configPath, stateFile, port: 0 });
    try {
      expect(daemon.url.startsWith('https://127.0.0.1:')).toBe(true);

      const state = JSON.parse(await readFile(stateFile, 'utf-8')) as { tls?: boolean };
      expect(state.tls).toBe(true);

      const material = await ensureAuthProxyCerts(); // reuses the same CODEMIE_HOME certs
      const body = await new Promise<string>((resolve, reject) => {
        const req = https.get(
          { host: '127.0.0.1', port: daemon.port, path: '/healthz', ca: material.caCertPem },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
          }
        );
        req.on('error', reject);
      });
      expect(JSON.parse(body).status).toBe('ok');
    } finally {
      await daemon.stop();
    }
  });

  it('stays plain http when tls is off', async () => {
    const configPath = join(home, 'mcp-auth-proxy.json');
    const stateFile = join(home, 'mcp-auth-proxy.state.json');
    await writeFile(
      configPath,
      JSON.stringify({ servers: { radar: { upstreamUrl: 'https://mcp.example.com/radar' } } }),
      'utf-8'
    );
    const { runAuthProxyDaemon } = await import('../runtime.js');
    const daemon = await runAuthProxyDaemon({ configPath, stateFile, port: 0 });
    try {
      expect(daemon.url.startsWith('http://127.0.0.1:')).toBe(true);
      const state = JSON.parse(await readFile(stateFile, 'utf-8')) as { tls?: boolean };
      expect(state.tls).toBe(false);
    } finally {
      await daemon.stop();
    }
  });
});
