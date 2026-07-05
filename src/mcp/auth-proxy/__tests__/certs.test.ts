/**
 * certs.ts tests — real certificate generation into a temp dir (no mocks:
 * @peculiar/x509 is pure JS and fast; assertions parse output with node:crypto).
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { ensureAuthProxyCerts, getAuthProxyTlsPaths } from '../certs.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codemie-tls-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ensureAuthProxyCerts', () => {
  it('generates a CA and a leaf with the required profile', async () => {
    const material = await ensureAuthProxyCerts(dir);

    const ca = new X509Certificate(material.caCertPem);
    const leaf = new X509Certificate(material.certPem);

    expect(ca.ca).toBe(true);
    expect(ca.subject).toContain('CN=CodeMie mcp-auth-proxy CA');
    expect(material.caCommonName).toContain('CodeMie mcp-auth-proxy CA');

    expect(leaf.ca).toBe(false);
    expect(leaf.subjectAltName).toContain('127.0.0.1');
    expect(leaf.subjectAltName).toContain('localhost');
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.keyUsage).toBeDefined();

    // Leaf validity <= 825 days (Apple/Chromium local-trust cap)
    const days =
      (new Date(leaf.validTo).getTime() - new Date(leaf.validFrom).getTime()) / 86_400_000;
    expect(days).toBeLessThanOrEqual(825);

    expect(material.keyPem).toContain('BEGIN PRIVATE KEY');
  });

  it('writes private keys with 0600 permissions', async () => {
    await ensureAuthProxyCerts(dir);
    const paths = getAuthProxyTlsPaths(dir);
    for (const keyFile of [paths.caKey, paths.serverKey]) {
      const mode = (await stat(keyFile)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('is idempotent — second call reuses both certificates', async () => {
    const first = await ensureAuthProxyCerts(dir);
    const second = await ensureAuthProxyCerts(dir);
    expect(second.caCertPem).toBe(first.caCertPem);
    expect(second.certPem).toBe(first.certPem);
  });

  it('reissues the leaf (same CA) when the leaf file is corrupt', async () => {
    const first = await ensureAuthProxyCerts(dir);
    const paths = getAuthProxyTlsPaths(dir);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(paths.serverCert, 'not a certificate', 'utf-8');

    const second = await ensureAuthProxyCerts(dir);
    expect(second.caCertPem).toBe(first.caCertPem);
    expect(second.certPem).not.toBe(first.certPem);
    const leaf = new X509Certificate(second.certPem);
    expect(leaf.checkIssued(new X509Certificate(second.caCertPem))).toBe(true);
  });

  it('regenerates everything when the CA is missing', async () => {
    const first = await ensureAuthProxyCerts(dir);
    const paths = getAuthProxyTlsPaths(dir);
    await rm(paths.caCert);

    const second = await ensureAuthProxyCerts(dir);
    expect(second.caCertPem).not.toBe(first.caCertPem);
    expect(second.certPem).not.toBe(first.certPem);
  });

  it('exposes the on-disk PEM contents matching the returned material', async () => {
    const material = await ensureAuthProxyCerts(dir);
    const paths = getAuthProxyTlsPaths(dir);
    expect(await readFile(paths.caCert, 'utf-8')).toBe(material.caCertPem);
    expect(await readFile(paths.serverCert, 'utf-8')).toBe(material.certPem);
  });
});
