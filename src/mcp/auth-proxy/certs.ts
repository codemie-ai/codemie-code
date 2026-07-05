/**
 * MCP Auth Proxy — local TLS certificate lifecycle.
 *
 * Generates and maintains a machine-local CA plus a loopback leaf certificate
 * so the proxy can serve https://127.0.0.1 (Claude Desktop refuses non-https
 * OAuth authorize URLs). Pure JS via @peculiar/x509 over node:crypto webcrypto
 * — node:crypto alone cannot create/sign X.509 certificates.
 *
 * Trust-store installation is NOT done here — see trust.ts and the explicit
 * `codemie mcp-auth-proxy trust` command (design decision: start never touches
 * the OS trust store).
 */
import * as x509 from '@peculiar/x509';
import { webcrypto, X509Certificate } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { getCodemiePath } from '../../utils/paths.js';
import { ConfigurationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

x509.cryptoProvider.set(webcrypto);

export const AUTH_PROXY_TLS_DIR = 'mcp-auth-proxy-tls';
export const AUTH_PROXY_CA_NAME_PREFIX = 'CodeMie mcp-auth-proxy CA';

const SIGNING_ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const CA_VALIDITY_DAYS = 3650;
// Apple/Chromium reject locally-trusted leaves valid longer than 825 days.
const LEAF_VALIDITY_DAYS = 825;
// Reissue the leaf when it has less than this many days left.
const LEAF_RENEWAL_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
// Backdate notBefore to tolerate small clock skew between generator and clients.
const CLOCK_SKEW_MS = 5 * 60_000;

export interface AuthProxyTlsPaths {
  dir: string;
  caCert: string;
  caKey: string;
  serverCert: string;
  serverKey: string;
}

export interface TlsMaterial {
  /** Leaf private key, PKCS#8 PEM. */
  keyPem: string;
  /** Leaf certificate, PEM. */
  certPem: string;
  /** CA certificate, PEM — the trust anchor `trust` installs and CLI clients pin. */
  caCertPem: string;
  /** CA subject CN — the exact name trust-store entries are created/removed under. */
  caCommonName: string;
  paths: AuthProxyTlsPaths;
}

export function getAuthProxyTlsPaths(
  dir: string = getCodemiePath(AUTH_PROXY_TLS_DIR)
): AuthProxyTlsPaths {
  return {
    dir,
    caCert: join(dir, 'ca.crt'),
    caKey: join(dir, 'ca.key'),
    serverCert: join(dir, 'server.crt'),
    serverKey: join(dir, 'server.key'),
  };
}

/** Atomic tmp+rename write (state.ts idiom); mode applies to the new file. */
async function writeFileAtomic(path: string, content: string, mode: number): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, { encoding: 'utf-8', mode });
  await rename(tmp, path);
}

function extractCommonName(subject: string): string {
  for (const line of subject.split('\n')) {
    if (line.startsWith('CN=')) {
      return line.slice(3);
    }
  }
  return subject;
}

function pemToDer(pem: string): ArrayBuffer {
  return x509.PemConverter.decode(pem)[0];
}

async function exportPrivateKeyPem(key: webcrypto.CryptoKey): Promise<string> {
  const der = await webcrypto.subtle.exportKey('pkcs8', key);
  return x509.PemConverter.encode(der, 'PRIVATE KEY');
}

async function importPrivateKey(pem: string): Promise<webcrypto.CryptoKey> {
  return webcrypto.subtle.importKey('pkcs8', pemToDer(pem), SIGNING_ALG, false, ['sign']);
}

/** DN-safe: strip characters that would change RDN parsing. */
function dnSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9._@-]/g, '-');
}

interface CaMaterial {
  certPem: string;
  keyPem: string;
}

async function generateCa(): Promise<CaMaterial> {
  const keys = await webcrypto.subtle.generateKey(SIGNING_ALG, true, ['sign', 'verify']);
  const now = Date.now();
  const identity = `${dnSafe(userInfo().username)}@${dnSafe(hostname())}`;
  const issuedOn = new Date(now).toISOString().slice(0, 10);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    name: `CN=${AUTH_PROXY_CA_NAME_PREFIX} ${identity} ${issuedOn}, O=CodeMie`,
    notBefore: new Date(now - CLOCK_SKEW_MS),
    notAfter: new Date(now + CA_VALIDITY_DAYS * DAY_MS),
    signingAlgorithm: SIGNING_ALG,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true
      ),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return { certPem: cert.toString('pem'), keyPem: await exportPrivateKeyPem(keys.privateKey) };
}

async function issueLeaf(ca: CaMaterial): Promise<{ certPem: string; keyPem: string }> {
  const caCert = new x509.X509Certificate(ca.certPem);
  const caKey = await importPrivateKey(ca.keyPem);
  const keys = await webcrypto.subtle.generateKey(SIGNING_ALG, true, ['sign', 'verify']);
  const now = Date.now();
  const notBefore = new Date(now - CLOCK_SKEW_MS);
  const cert = await x509.X509CertificateGenerator.create({
    subject: 'CN=127.0.0.1, O=CodeMie',
    issuer: caCert.subject,
    notBefore,
    // Anchor to notBefore so total validity stays within the 825-day cap
    // despite the clock-skew backdating; clamp to the CA expiry so the leaf
    // never outlives its issuer (chain validation would fail mid-leaf-life).
    notAfter: new Date(
      Math.min(notBefore.getTime() + LEAF_VALIDITY_DAYS * DAY_MS, caCert.notAfter.getTime())
    ),
    signingAlgorithm: SIGNING_ALG,
    publicKey: keys.publicKey,
    signingKey: caKey,
    extensions: [
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], true),
      new x509.SubjectAlternativeNameExtension([
        { type: 'ip', value: '127.0.0.1' },
        { type: 'dns', value: 'localhost' },
      ]),
    ],
  });
  return { certPem: cert.toString('pem'), keyPem: await exportPrivateKeyPem(keys.privateKey) };
}

/** Parse a PEM cert defensively; null means "treat as absent and regenerate". */
async function readCertificate(path: string): Promise<X509Certificate | null> {
  try {
    return new X509Certificate(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

function isUsable(cert: X509Certificate, renewalWindowMs: number): boolean {
  const now = Date.now();
  return (
    new Date(cert.validFrom).getTime() <= now &&
    new Date(cert.validTo).getTime() - renewalWindowMs > now
  );
}

function leafMatchesProfile(leaf: X509Certificate, ca: X509Certificate): boolean {
  const san = leaf.subjectAltName ?? '';
  // checkIssued() only matches issuer/subject names; verify() proves the
  // signature so a leaf from a previous (regenerated) same-name CA is rejected.
  return (
    leaf.checkIssued(ca) &&
    leaf.verify(ca.publicKey) &&
    san.includes('127.0.0.1') &&
    san.includes('localhost')
  );
}

/** Reads a PKCS#8 key and proves it parses; null = treat as absent and reissue. */
async function loadPrivateKeyPem(path: string): Promise<string | null> {
  try {
    const pem = await readFile(path, 'utf-8');
    await importPrivateKey(pem);
    return pem;
  } catch {
    return null;
  }
}

interface LoadedCa {
  cert: X509Certificate;
  keyPem: string;
}

/** Null when the CA cert is missing/corrupt/expired or its key does not parse. */
async function loadCa(paths: AuthProxyTlsPaths): Promise<LoadedCa | null> {
  const cert = await readCertificate(paths.caCert);
  if (cert === null || !isUsable(cert, 0)) {
    return null;
  }
  const keyPem = await loadPrivateKeyPem(paths.caKey);
  return keyPem === null ? null : { cert, keyPem };
}

async function generateAndStoreCa(paths: AuthProxyTlsPaths): Promise<LoadedCa> {
  const generated = await generateCa();
  await writeFileAtomic(paths.caKey, generated.keyPem, 0o600);
  await writeFileAtomic(paths.caCert, generated.certPem, 0o644);
  logger.warn(
    '[mcp-auth-proxy] Generated a new local CA — run `codemie mcp-auth-proxy trust` to (re)install it in the OS trust store'
  );
  return { cert: new X509Certificate(generated.certPem), keyPem: generated.keyPem };
}

export interface ExistingCaInfo {
  caPath: string;
  caCommonName: string;
  fingerprint256: string;
  validTo: string;
}

/**
 * Describes the on-disk CA without generating anything — `trust --uninstall`
 * must never mint new material (a fresh CA has a new dated CN, so uninstall
 * would remove the wrong trust-store entry). Null when missing/unparseable.
 */
export async function readExistingCaInfo(
  dir: string = getCodemiePath(AUTH_PROXY_TLS_DIR)
): Promise<ExistingCaInfo | null> {
  const paths = getAuthProxyTlsPaths(dir);
  const cert = await readCertificate(paths.caCert);
  if (cert === null) {
    return null;
  }
  return {
    caPath: paths.caCert,
    caCommonName: extractCommonName(cert.subject),
    fingerprint256: cert.fingerprint256,
    validTo: cert.validTo,
  };
}

/**
 * Idempotently ensures a usable CA + leaf under `dir` and returns the material.
 * Regenerates the CA (and leaf) when the CA is missing/corrupt/expired, its key
 * does not parse, or the cert/key pair mismatches — and warns that `trust` must
 * be re-run. Reissues only the leaf when it is missing/corrupt/expiring/
 * mismatched or its key does not parse.
 */
export async function ensureAuthProxyCerts(
  dir: string = getCodemiePath(AUTH_PROXY_TLS_DIR)
): Promise<TlsMaterial> {
  const paths = getAuthProxyTlsPaths(dir);
  try {
    await mkdir(dir, { recursive: true });

    let ca = (await loadCa(paths)) ?? (await generateAndStoreCa(paths));

    const leaf = await readCertificate(paths.serverCert);
    const leafOk =
      leaf !== null &&
      isUsable(leaf, LEAF_RENEWAL_WINDOW_DAYS * DAY_MS) &&
      leafMatchesProfile(leaf, ca.cert);
    let leafKeyPem = leafOk ? await loadPrivateKeyPem(paths.serverKey) : null;

    if (leafKeyPem === null) {
      let issued = await issueLeaf({ certPem: ca.cert.toString(), keyPem: ca.keyPem });
      // Signing succeeds even when ca.key does not match ca.crt (e.g. a crash
      // between the two writes), so prove the chain and self-heal once.
      if (!new X509Certificate(issued.certPem).verify(ca.cert.publicKey)) {
        ca = await generateAndStoreCa(paths);
        issued = await issueLeaf({ certPem: ca.cert.toString(), keyPem: ca.keyPem });
      }
      await writeFileAtomic(paths.serverKey, issued.keyPem, 0o600);
      await writeFileAtomic(paths.serverCert, issued.certPem, 0o644);
      leafKeyPem = issued.keyPem;
    }

    // Return the on-disk bytes so repeated calls compare byte-identical
    // (PEM formatting can differ between @peculiar/x509 output and node's
    // X509Certificate.toString()).
    return {
      keyPem: leafKeyPem,
      certPem: await readFile(paths.serverCert, 'utf-8'),
      caCertPem: await readFile(paths.caCert, 'utf-8'),
      caCommonName: extractCommonName(ca.cert.subject),
      paths,
    };
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError(
      `mcp-auth-proxy TLS setup failed in ${dir}: ${(error as Error).message}`
    );
  }
}
