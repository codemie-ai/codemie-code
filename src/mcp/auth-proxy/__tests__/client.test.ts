/**
 * client.ts tests — control-plane requests against a real McpAuthProxy,
 * plain HTTP and CA-pinned HTTPS.
 * @group unit
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpAuthProxy } from '../server.js';
import { ensureAuthProxyCerts } from '../certs.js';
import type { TlsMaterial } from '../certs.js';
import { fetchHealth, requestShutdown } from '../client.js';

const SERVERS = { radar: { upstreamUrl: 'https://mcp.example.com/radar' } };

describe('auth-proxy control-plane client', () => {
  describe('plain http daemon', () => {
    let proxy: McpAuthProxy;
    let port: number;

    beforeAll(async () => {
      proxy = new McpAuthProxy({ port: 0, tls: false, servers: SERVERS });
      ({ port } = await proxy.start());
    });

    afterAll(async () => {
      await proxy.stop();
    });

    it('fetchHealth reads /healthz', async () => {
      const health = await fetchHealth({ port, tls: false });
      expect(health.status).toBe('ok');
      expect(health.routes[0]?.id).toBe('radar');
    });

    it('requestShutdown acks 202 and reports true', async () => {
      let requested = false;
      const p = new McpAuthProxy({ port: 0, tls: false, servers: SERVERS }, () => {
        requested = true;
      });
      const started = await p.start();
      expect(await requestShutdown({ port: started.port, tls: false })).toBe(true);
      await p.stop();
      expect(requested).toBe(true);
    });

    it('requestShutdown resolves false when nothing listens', async () => {
      const dead = new McpAuthProxy({ port: 0, tls: false, servers: SERVERS });
      const started = await dead.start();
      await dead.stop(); // port now free
      expect(await requestShutdown({ port: started.port, tls: false })).toBe(false);
    });
  });

  describe('https daemon', () => {
    let tlsDir: string;
    let material: TlsMaterial;
    let proxy: McpAuthProxy;
    let port: number;

    beforeAll(async () => {
      tlsDir = await mkdtemp(join(tmpdir(), 'codemie-tls-client-'));
      material = await ensureAuthProxyCerts(tlsDir);
      proxy = new McpAuthProxy(
        { port: 0, tls: true, servers: SERVERS },
        undefined,
        { keyPem: material.keyPem, certPem: material.certPem }
      );
      ({ port } = await proxy.start());
    });

    afterAll(async () => {
      await proxy.stop();
      await rm(tlsDir, { recursive: true, force: true });
    });

    it('fetchHealth pins the local CA over https', async () => {
      const health = await fetchHealth({ port, tls: true, caPem: material.caCertPem });
      expect(health.status).toBe('ok');
    });

    it('fetchHealth without the CA rejects (no rejectUnauthorized bypass)', async () => {
      await expect(fetchHealth({ port, tls: true })).rejects.toThrow();
    });
  });
});
