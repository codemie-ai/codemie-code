/**
 * certs.ts tests — real certificate generation into a temp dir (no mocks:
 * @peculiar/x509 is pure JS and fast; assertions parse output with node:crypto).
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto, X509Certificate } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { ensureAuthProxyCerts, getAuthProxyTlsPaths, readExistingCaInfo } from '../certs.js';

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const DAY_MS = 86_400_000;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codemie-tls-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function exportPkcs8Pem(key: webcrypto.CryptoKey): Promise<string> {
  const der = await webcrypto.subtle.exportKey('pkcs8', key);
  return x509.PemConverter.encode(der, 'PRIVATE KEY');
}

async function importCaSigningKey(pem: string): Promise<webcrypto.CryptoKey> {
  return webcrypto.subtle.importKey('pkcs8', x509.PemConverter.decode(pem)[0], ALG, false, [
    'sign',
  ]);
}

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

    // EKU must include serverAuth — Chromium rejects locally-trusted leaves without it.
    const eku = new x509.X509Certificate(material.certPem).getExtension(
      x509.ExtendedKeyUsageExtension
    );
    expect(eku?.usages).toContain(x509.ExtendedKeyUsage.serverAuth);

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
    await writeFile(paths.serverCert, 'not a certificate', 'utf-8');

    const second = await ensureAuthProxyCerts(dir);
    expect(second.caCertPem).toBe(first.caCertPem);
    expect(second.certPem).not.toBe(first.certPem);
    const leaf = new X509Certificate(second.certPem);
    expect(leaf.checkIssued(new X509Certificate(second.caCertPem))).toBe(true);
  });

  it('reissues the leaf when it is inside the 30-day renewal window', async () => {
    const first = await ensureAuthProxyCerts(dir);
    const paths = getAuthProxyTlsPaths(dir);

    // Replace the leaf with a near-expiry one issued by the same on-disk CA.
    const caCert = new x509.X509Certificate(await readFile(paths.caCert, 'utf-8'));
    const caKey = await importCaSigningKey(await readFile(paths.caKey, 'utf-8'));
    const keys = await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
    const now = Date.now();
    const nearExpiry = await x509.X509CertificateGenerator.create({
      subject: 'CN=127.0.0.1, O=CodeMie',
      issuer: caCert.subject,
      notBefore: new Date(now - 60_000),
      notAfter: new Date(now + 10 * DAY_MS), // < LEAF_RENEWAL_WINDOW_DAYS
      signingAlgorithm: ALG,
      publicKey: keys.publicKey,
      signingKey: caKey,
      extensions: [
        new x509.SubjectAlternativeNameExtension([
          { type: 'ip', value: '127.0.0.1' },
          { type: 'dns', value: 'localhost' },
        ]),
      ],
    });
    await writeFile(paths.serverCert, nearExpiry.toString('pem'), 'utf-8');
    await writeFile(paths.serverKey, await exportPkcs8Pem(keys.privateKey), 'utf-8');

    const second = await ensureAuthProxyCerts(dir);
    expect(second.caCertPem).toBe(first.caCertPem);
    expect(second.certPem).not.toBe(nearExpiry.toString('pem'));
    const leaf = new X509Certificate(second.certPem);
    const daysLeft = (new Date(leaf.validTo).getTime() - Date.now()) / DAY_MS;
    expect(daysLeft).toBeGreaterThan(30);
    expect(daysLeft).toBeLessThanOrEqual(825);
  });

  it('clamps the leaf validity to the CA expiry (leaf never outlives its issuer)', async () => {
    // Plant a CA expiring sooner than the 825-day leaf default.
    const keys = await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
    const now = Date.now();
    const caNotAfter = new Date(now + 100 * DAY_MS);
    const shortCa = await x509.X509CertificateGenerator.createSelfSigned({
      name: 'CN=CodeMie mcp-auth-proxy CA short-lived, O=CodeMie',
      notBefore: new Date(now - 60_000),
      notAfter: caNotAfter,
      signingAlgorithm: ALG,
      keys,
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
          true
        ),
      ],
    });
    const paths = getAuthProxyTlsPaths(dir);
    await writeFile(paths.caCert, shortCa.toString('pem'), 'utf-8');
    await writeFile(paths.caKey, await exportPkcs8Pem(keys.privateKey), 'utf-8');

    const material = await ensureAuthProxyCerts(dir);
    const leaf = new X509Certificate(material.certPem);
    expect(new Date(leaf.validTo).getTime()).toBeLessThanOrEqual(caNotAfter.getTime());
  });

  it('regenerates everything when the CA is missing', async () => {
    const first = await ensureAuthProxyCerts(dir);
    const paths = getAuthProxyTlsPaths(dir);
    await rm(paths.caCert);

    const second = await ensureAuthProxyCerts(dir);
    expect(second.caCertPem).not.toBe(first.caCertPem);
    expect(second.certPem).not.toBe(first.certPem);
  });

  it('regenerates the CA when ca.key is corrupt (self-healing contract)', async () => {
    const first = await ensureAuthProxyCerts(dir);
    const paths = getAuthProxyTlsPaths(dir);
    await writeFile(paths.caKey, 'not a private key', 'utf-8');

    const second = await ensureAuthProxyCerts(dir);
    expect(second.caCertPem).not.toBe(first.caCertPem);
    const leaf = new X509Certificate(second.certPem);
    expect(leaf.verify(new X509Certificate(second.caCertPem).publicKey)).toBe(true);
  });

  it('reissues the leaf (same CA) when server.key is corrupt', async () => {
    const first = await ensureAuthProxyCerts(dir);
    const paths = getAuthProxyTlsPaths(dir);
    await writeFile(paths.serverKey, 'not a private key', 'utf-8');

    const second = await ensureAuthProxyCerts(dir);
    expect(second.caCertPem).toBe(first.caCertPem);
    expect(second.certPem).not.toBe(first.certPem);
    expect(second.keyPem).toContain('BEGIN PRIVATE KEY');
  });

  it('self-heals a mismatched ca.crt/ca.key pair when issuing a leaf', async () => {
    const first = await ensureAuthProxyCerts(dir);
    const paths = getAuthProxyTlsPaths(dir);
    // Simulate a crash between the ca.key and ca.crt writes: the key parses
    // fine but does not match the certificate.
    const strangerKeys = await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
    await writeFile(paths.caKey, await exportPkcs8Pem(strangerKeys.privateKey), 'utf-8');
    await rm(paths.serverCert); // force a leaf issuance

    const second = await ensureAuthProxyCerts(dir);
    expect(second.caCertPem).not.toBe(first.caCertPem);
    const leaf = new X509Certificate(second.certPem);
    expect(leaf.verify(new X509Certificate(second.caCertPem).publicKey)).toBe(true);
  });

  it('exposes the on-disk PEM contents matching the returned material', async () => {
    const material = await ensureAuthProxyCerts(dir);
    const paths = getAuthProxyTlsPaths(dir);
    expect(await readFile(paths.caCert, 'utf-8')).toBe(material.caCertPem);
    expect(await readFile(paths.serverCert, 'utf-8')).toBe(material.certPem);
  });
});

describe('readExistingCaInfo', () => {
  it('returns null when no CA exists on disk and creates nothing', async () => {
    expect(await readExistingCaInfo(dir)).toBeNull();
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it('describes the on-disk CA without touching the material', async () => {
    const material = await ensureAuthProxyCerts(dir);
    const ca = new X509Certificate(material.caCertPem);
    expect(await readExistingCaInfo(dir)).toEqual({
      caPath: material.paths.caCert,
      caCommonName: material.caCommonName,
      fingerprint256: ca.fingerprint256,
      validTo: ca.validTo,
    });
  });
});
