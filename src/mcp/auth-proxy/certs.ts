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
  const cert = await x509.X509CertificateGenerator.create({
    subject: 'CN=127.0.0.1, O=CodeMie',
    issuer: caCert.subject,
    notBefore: new Date(now - CLOCK_SKEW_MS),
    // Anchor to notBefore so total validity stays within the 825-day cap
    // despite the clock-skew backdating.
    notAfter: new Date(now - CLOCK_SKEW_MS + LEAF_VALIDITY_DAYS * DAY_MS),
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

/**
 * Idempotently ensures a usable CA + leaf under `dir` and returns the material.
 * Regenerates the CA (and leaf) when the CA is missing/corrupt/expired — and
 * warns that `trust` must be re-run. Reissues only the leaf when it is
 * missing/corrupt/expiring/mismatched.
 */
export async function ensureAuthProxyCerts(
  dir: string = getCodemiePath(AUTH_PROXY_TLS_DIR)
): Promise<TlsMaterial> {
  const paths = getAuthProxyTlsPaths(dir);
  try {
    await mkdir(dir, { recursive: true });

    let caCert = await readCertificate(paths.caCert);
    let caKeyPem: string | null = null;
    if (caCert !== null && isUsable(caCert, 0)) {
      try {
        caKeyPem = await readFile(paths.caKey, 'utf-8');
      } catch {
        caKeyPem = null;
      }
    }

    if (caCert === null || caKeyPem === null) {
      const generated = await generateCa();
      await writeFileAtomic(paths.caKey, generated.keyPem, 0o600);
      await writeFileAtomic(paths.caCert, generated.certPem, 0o644);
      caCert = new X509Certificate(generated.certPem);
      caKeyPem = generated.keyPem;
      logger.warn(
        '[mcp-auth-proxy] Generated a new local CA — run `codemie mcp-auth-proxy trust` to (re)install it in the OS trust store'
      );
    }

    const leaf = await readCertificate(paths.serverCert);
    let leafKeyPem: string | null = null;
    const leafOk =
      leaf !== null &&
      isUsable(leaf, LEAF_RENEWAL_WINDOW_DAYS * DAY_MS) &&
      leafMatchesProfile(leaf, caCert);
    if (leafOk) {
      try {
        leafKeyPem = await readFile(paths.serverKey, 'utf-8');
      } catch {
        leafKeyPem = null;
      }
    }

    if (!leafOk || leafKeyPem === null) {
      const issued = await issueLeaf({ certPem: caCert.toString(), keyPem: caKeyPem });
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
      caCommonName: extractCommonName(caCert.subject),
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
