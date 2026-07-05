# mcp-auth-proxy HTTPS Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `codemie mcp-auth-proxy` serve its loopback listener over HTTPS with a locally-generated CA so Claude Desktop's https-only OAuth guard passes.

**Architecture:** One new module (`certs.ts`) owns the CA + leaf certificate lifecycle; `server.ts` gets a thin `http`/`https` switch and a protocol-aware `origin`; a new `client.ts` centralizes CA-pinned loopback control-plane requests for the CLI; a new `trust.ts` builds per-OS trust-store commands for the explicit `trust [--uninstall]` subcommand. TLS is opt-in (`"tls": true` config or `--tls` flag); default stays plain HTTP.

**Tech Stack:** Node 22 `node:https`/`node:crypto` (webcrypto), `@peculiar/x509@^1.14.3` (pure JS, MIT — **pin v1: v2.0.0 fails at import with an undeclared `reflect-metadata` requirement; v1.14.3 declares it and works, verified live 2026-07-05**), Vitest.

**Design:** `docs/superpowers/specs/2026-07-05-mcp-auth-proxy-https-design.md`. Repo rules: ES modules with `.js` import suffixes, no `any`, `exec()` from `src/utils/processes.ts`, `getCodemiePath()` for home paths (honors `CODEMIE_HOME`), Conventional Commits with the AI footer:

```
Generated with AI

Co-Authored-By: codemie-ai <codemie.ai@gmail.com>
```

Run all test commands with `rtk proxy` prefix if plain npm output appears garbled by the shell hook: `rtk proxy npx vitest run <path>`.

---

### Task 1: Config + types — opt-in `tls` flag

**Test-first: yes — config.test.ts: `tls: true` round-trips and non-boolean `tls` is rejected; both fail because `AuthProxyConfig` has no `tls` member and the validator ignores the key.**

**Files:**
- Modify: `src/mcp/auth-proxy/types.ts:19-29`
- Modify: `src/mcp/auth-proxy/config.ts:53-98`
- Test: `src/mcp/auth-proxy/__tests__/config.test.ts`

- [ ] **Step 1: Write the failing tests** — append inside the existing top-level `describe` in `config.test.ts` (it already imports `validateAuthProxyConfig`; the existing valid fixture uses `servers: { radar: { upstreamUrl: 'https://mcp.example.com/radar' } }` — reuse that shape):

```typescript
describe('tls flag', () => {
  it('defaults tls to false when absent', () => {
    const config = validateAuthProxyConfig({
      servers: { radar: { upstreamUrl: 'https://mcp.example.com/radar' } },
    });
    expect(config.tls).toBe(false);
  });

  it('accepts tls: true', () => {
    const config = validateAuthProxyConfig({
      tls: true,
      servers: { radar: { upstreamUrl: 'https://mcp.example.com/radar' } },
    });
    expect(config.tls).toBe(true);
  });

  it('rejects non-boolean tls', () => {
    expect(() =>
      validateAuthProxyConfig({
        tls: 'yes',
        servers: { radar: { upstreamUrl: 'https://mcp.example.com/radar' } },
      })
    ).toThrow(/"tls" must be a boolean/);
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/config.test.ts`
Expected: 2 FAIL (`config.tls` is `undefined`, no throw for `'yes'`), rest pass.

- [ ] **Step 3: Implement** — in `types.ts`, extend both interfaces:

```typescript
export interface AuthProxyConfig {
  port: number;
  /** Serve the loopback listener over HTTPS with the locally-generated CA (default false). */
  tls: boolean;
  servers: Record<string, RouteConfig>;
}

export interface AuthProxyDaemonState {
  pid: number;
  port: number;
  routes: string[];
  startedAt: string;
  /** True when the daemon listener speaks HTTPS (absent in pre-TLS state files = false). */
  tls?: boolean;
}
```

In `config.ts` `validateAuthProxyConfig`, after the `port` block and before the `servers` block:

```typescript
  let tls = false;
  if (root.tls !== undefined) {
    if (typeof root.tls !== 'boolean') {
      throw new ConfigurationError('mcp-auth-proxy config: "tls" must be a boolean');
    }
    tls = root.tls;
  }
```

and change the return to `return { port, tls, servers };`.

- [ ] **Step 4: Run to verify GREEN**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/config.test.ts src/mcp/auth-proxy/__tests__/server.test.ts`
Expected: all PASS (server tests construct `AuthProxyConfig` literals — if any object literal now misses `tls`, TS is structural at runtime; vitest does not typecheck, but `npx tsc --noEmit` in Step 5 must pass, so add `tls: false` to any config literal the compiler flags).

- [ ] **Step 5: Typecheck** — Run: `npx tsc --noEmit`. Fix every `Property 'tls' is missing` error by adding `tls: false` to the literal (test fixtures in `server.test.ts`, and `runtime.ts` is dealt with in Task 4 — for now `loadAuthProxyConfig` already returns it).

- [ ] **Step 6: Commit**

```bash
git add src/mcp/auth-proxy/types.ts src/mcp/auth-proxy/config.ts src/mcp/auth-proxy/__tests__/config.test.ts src/mcp/auth-proxy/__tests__/server.test.ts
git commit -m "feat(proxy): add opt-in tls flag to mcp-auth-proxy config"
```

(Include the AI footer in every commit in this plan.)

---

### Task 2: `certs.ts` — local CA + leaf certificate lifecycle

**Test-first: yes — certs.test.ts fails with "Cannot find module '../certs.js'".**

**Files:**
- Create: `src/mcp/auth-proxy/certs.ts`
- Test: `src/mcp/auth-proxy/__tests__/certs.test.ts`
- Modify: `package.json` (add dependency)

- [ ] **Step 1: Install the dependency**

```bash
npm install @peculiar/x509@^1.14.3
```

Verify: `node -e "console.log(require('@peculiar/x509/package.json').version)"` prints `1.14.x`.

- [ ] **Step 2: Write the failing tests**

```typescript
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
```

- [ ] **Step 3: Run to verify RED**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/certs.test.ts`
Expected: FAIL — `Cannot find module '../certs.js'`.

- [ ] **Step 4: Implement `src/mcp/auth-proxy/certs.ts`**

```typescript
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

export function getAuthProxyTlsPaths(dir: string = getCodemiePath(AUTH_PROXY_TLS_DIR)): AuthProxyTlsPaths {
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

async function exportPrivateKeyPem(key: CryptoKey): Promise<string> {
  const der = await webcrypto.subtle.exportKey('pkcs8', key);
  return x509.PemConverter.encode(der, 'PRIVATE KEY');
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
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
    notAfter: new Date(now + LEAF_VALIDITY_DAYS * DAY_MS),
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
  return leaf.checkIssued(ca) && san.includes('127.0.0.1') && san.includes('localhost');
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

    const caCertPem = caCert.toString();
    const leaf = await readCertificate(paths.serverCert);
    let leafKeyPem: string | null = null;
    if (leaf !== null && isUsable(leaf, LEAF_RENEWAL_WINDOW_DAYS * DAY_MS) && leafMatchesProfile(leaf, caCert)) {
      try {
        leafKeyPem = await readFile(paths.serverKey, 'utf-8');
      } catch {
        leafKeyPem = null;
      }
    }

    let leafCertPem: string;
    if (leaf === null || leafKeyPem === null || !isUsable(leaf, LEAF_RENEWAL_WINDOW_DAYS * DAY_MS) || !leafMatchesProfile(leaf, caCert)) {
      const issued = await issueLeaf({ certPem: caCertPem, keyPem: caKeyPem });
      await writeFileAtomic(paths.serverKey, issued.keyPem, 0o600);
      await writeFileAtomic(paths.serverCert, issued.certPem, 0o644);
      leafCertPem = issued.certPem;
      leafKeyPem = issued.keyPem;
    } else {
      leafCertPem = leaf.toString();
    }

    return {
      keyPem: leafKeyPem,
      certPem: leafCertPem,
      caCertPem,
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
```

Note: `caCert.toString()` on `node:crypto`'s `X509Certificate` returns the PEM. When the CA was just generated we re-wrap it through `X509Certificate` so the returned `caCertPem` is byte-identical to what `readCertificate` will produce on the next call — that keeps the idempotency test's `toBe` comparison honest. If the PEM strings differ only by trailing newline between `@peculiar/x509` output and node's `toString()`, normalize by always returning the on-disk file content instead: `caCertPem = await readFile(paths.caCert, 'utf-8')` and `leafCertPem = await readFile(paths.serverCert, 'utf-8')` at the end. Prefer the read-back variant — it also makes the "on-disk matches returned" test trivially true.

- [ ] **Step 5: Run to verify GREEN**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/certs.test.ts`
Expected: all PASS. If the idempotency test fails on PEM formatting differences, apply the read-back variant from the note above.

- [ ] **Step 6: Typecheck + lint** — Run: `npx tsc --noEmit && npx eslint 'src/mcp/auth-proxy/certs.ts' 'src/mcp/auth-proxy/__tests__/certs.test.ts' --max-warnings=0`

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/mcp/auth-proxy/certs.ts src/mcp/auth-proxy/__tests__/certs.test.ts
git commit -m "feat(proxy): add local CA and leaf certificate lifecycle for mcp-auth-proxy tls"
```

---

### Task 3: `server.ts` — HTTPS listener + protocol-aware origin

**Test-first: yes — server.test.ts: constructing `McpAuthProxy` with TLS material must yield an `https://` origin and serve `/healthz` over TLS; fails because the constructor ignores the third argument and always builds `http.createServer`.**

**Files:**
- Modify: `src/mcp/auth-proxy/server.ts:12,109-163`
- Test: `src/mcp/auth-proxy/__tests__/server.test.ts`

- [ ] **Step 1: Write the failing tests** — add a new `describe` block at the end of `server.test.ts` (top-level, alongside the existing ones):

```typescript
import https from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAuthProxyCerts } from '../certs.js';

describe('tls listener', () => {
  let tlsDir: string;

  beforeAll(async () => {
    tlsDir = await mkdtemp(join(tmpdir(), 'codemie-tls-server-'));
  });

  afterAll(async () => {
    await rm(tlsDir, { recursive: true, force: true });
  });

  it('serves https with an https:// origin when TLS material is provided', async () => {
    const material = await ensureAuthProxyCerts(tlsDir);
    const proxy = new McpAuthProxy(
      { port: 0, tls: true, servers: { radar: { upstreamUrl: 'https://mcp.example.com/radar' } } },
      undefined,
      { keyPem: material.keyPem, certPem: material.certPem }
    );
    const { port, url } = await proxy.start();
    try {
      expect(url).toBe(`https://127.0.0.1:${port}`);
      expect(proxy.origin.startsWith('https://')).toBe(true);

      const body = await new Promise<string>((resolve, reject) => {
        const req = https.get(
          { host: '127.0.0.1', port, path: '/healthz', ca: material.caCertPem },
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
      await proxy.stop();
    }
  });

  it('keeps a plain http origin without TLS material', async () => {
    const proxy = new McpAuthProxy({
      port: 0,
      tls: false,
      servers: { radar: { upstreamUrl: 'https://mcp.example.com/radar' } },
    });
    const { url } = await proxy.start();
    try {
      expect(url.startsWith('http://127.0.0.1:')).toBe(true);
    } finally {
      await proxy.stop();
    }
  });
});
```

(Adjust config literals to include `tls` per Task 1. If the existing file already imports `beforeAll`/`afterAll` from vitest, reuse; otherwise extend the import.)

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/server.test.ts`
Expected: FAIL — `url` is `http://…` (extra constructor arg ignored) and the `https.get` rejects (`EPROTO`/socket hang up: plain HTTP server receiving a TLS hello).

- [ ] **Step 3: Implement** — in `server.ts`:

Add the import and material type:

```typescript
import https from 'node:https';
```

```typescript
/** PEM key + cert for the loopback listener; presence switches the server to HTTPS. */
export interface ServerTlsMaterial {
  keyPem: string;
  certPem: string;
}
```

Change the class fields/constructor/origin/start:

```typescript
export class McpAuthProxy {
  private server?: http.Server | https.Server;
  private port: number;
  private readonly sockets = new Set<Socket>();
  private readonly client: UpstreamClient;
  private readonly metadata: MetadataCache;

  constructor(
    private readonly config: AuthProxyConfig,
    private readonly onShutdownRequested?: () => void,
    private readonly tls?: ServerTlsMaterial
  ) {
    this.port = config.port;
    this.client = new UpstreamClient();
    this.metadata = new MetadataCache((url) => this.client.fetchJson(url));
  }

  get origin(): string {
    return `${this.tls ? 'https' : 'http'}://${BIND_HOST}:${this.port}`;
  }
```

and inside `start()` replace the `http.createServer` call:

```typescript
    const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
      void this.handleRequest(req, res);
    };
    const server = this.tls
      ? https.createServer({ key: this.tls.keyPem, cert: this.tls.certPem }, handler)
      : http.createServer(handler);
```

Everything else (`server.on('connection')`, listen, `stop()`) is untouched — `https.Server` shares the socket/close API.

- [ ] **Step 4: Run to verify GREEN**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/server.test.ts`
Expected: all PASS (old plain-HTTP suites prove no regression).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/auth-proxy/server.ts src/mcp/auth-proxy/__tests__/server.test.ts
git commit -m "feat(proxy): serve mcp-auth-proxy over https when tls material is provided"
```

---

### Task 4: Runtime + daemon entry + state — TLS end to end in the daemon

**Test-first: yes — new runtime.test.ts: `runAuthProxyDaemon` with a `tls: true` config must answer `/healthz` over HTTPS and persist `tls: true` in the state file; fails because runtime neither generates certs nor passes material.**

**Files:**
- Modify: `src/mcp/auth-proxy/runtime.ts`
- Modify: `src/bin/mcp-auth-proxy-daemon.ts:10-31`
- Create: `src/mcp/auth-proxy/__tests__/runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
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
        port: 0,
        tls: true,
        servers: { radar: { upstreamUrl: 'https://mcp.example.com/radar' } },
      }),
      'utf-8'
    );

    // Dynamic imports AFTER the env stub so getCodemiePath sees the temp home.
    const { runAuthProxyDaemon } = await import('../runtime.js');
    const { ensureAuthProxyCerts } = await import('../certs.js');

    const daemon = await runAuthProxyDaemon({ configPath, stateFile });
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
      JSON.stringify({ port: 0, servers: { radar: { upstreamUrl: 'https://mcp.example.com/radar' } } }),
      'utf-8'
    );
    const { runAuthProxyDaemon } = await import('../runtime.js');
    const daemon = await runAuthProxyDaemon({ configPath, stateFile });
    try {
      expect(daemon.url.startsWith('http://127.0.0.1:')).toBe(true);
      const state = JSON.parse(await readFile(stateFile, 'utf-8')) as { tls?: boolean };
      expect(state.tls).toBe(false);
    } finally {
      await daemon.stop();
    }
  });
});
```

Caveat: `runAuthProxyDaemon` registers `process.on('SIGTERM'/'SIGINT')` handlers per call. In tests this only accumulates listeners (harmless warnings at worst); if Node prints a MaxListeners warning, raise the limit once in the test file with `process.setMaxListeners(20)`.

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/runtime.test.ts`
Expected: first test FAILS — `daemon.url` starts with `http://` and `state.tls` is `undefined`.

- [ ] **Step 3: Implement** — in `runtime.ts`:

```typescript
import { ensureAuthProxyCerts } from './certs.js';
import type { ServerTlsMaterial } from './server.js';
```

Extend the options interface:

```typescript
export interface RunDaemonOptions {
  configPath?: string;
  port?: number;
  stateFile?: string;
  /** Force TLS on regardless of the config file (CLI --tls / daemon --tls). */
  tls?: boolean;
}
```

In `runAuthProxyDaemon`, after the `config.port` override:

```typescript
  const tlsEnabled = options.tls === true || config.tls;
  let tlsMaterial: ServerTlsMaterial | undefined;
  if (tlsEnabled) {
    const material = await ensureAuthProxyCerts();
    tlsMaterial = { keyPem: material.keyPem, certPem: material.certPem };
  }
```

change the constructor call to `new McpAuthProxy(config, gracefulShutdown, tlsMaterial);` and the state write to:

```typescript
  await writeAuthProxyState(
    { pid: process.pid, port, routes, startedAt: new Date().toISOString(), tls: tlsEnabled },
    stateFile
  );
```

In `src/bin/mcp-auth-proxy-daemon.ts`, add the flag to `parseArgs` options and the runtime call:

```typescript
    tls: { type: 'boolean' },
```

```typescript
  await runAuthProxyDaemon({
    configPath: values.config as string | undefined,
    port,
    stateFile: values['state-file'] as string | undefined,
    tls: values.tls === true,
  });
```

(`tls: false` and `tls` absent are equivalent — `config.tls` still applies; the flag only forces on, matching the design.)

- [ ] **Step 4: Run to verify GREEN**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/runtime.test.ts`
Expected: both PASS.

- [ ] **Step 5: Full module regression + typecheck**

Run: `npx vitest run src/mcp/auth-proxy && npx tsc --noEmit`
Expected: all PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/auth-proxy/runtime.ts src/bin/mcp-auth-proxy-daemon.ts src/mcp/auth-proxy/__tests__/runtime.test.ts
git commit -m "feat(proxy): wire tls through mcp-auth-proxy runtime, daemon flag, and state"
```

---

### Task 5: `client.ts` — CA-pinned loopback control-plane client

**Test-first: yes — client.test.ts fails with "Cannot find module '../client.js'"; the tls case additionally proves CA pinning against a real https proxy.**

**Files:**
- Create: `src/mcp/auth-proxy/client.ts` (move `fetchHealth` + `requestShutdown` out of the CLI command, add protocol/CA awareness)
- Test: `src/mcp/auth-proxy/__tests__/client.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
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
import { fetchHealth, requestShutdown } from '../client.js';
import type { TlsMaterial } from '../certs.js';

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
      expect(await requestShutdown({ port, tls: false, portOverride: 1 })).toBe(false);
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
```

Drop the `portOverride` oddity — replace that third plain-http test with a direct unused-port call:

```typescript
    it('requestShutdown resolves false when nothing listens', async () => {
      const dead = new McpAuthProxy({ port: 0, tls: false, servers: SERVERS });
      const started = await dead.start();
      await dead.stop(); // port now free
      expect(await requestShutdown({ port: started.port, tls: false })).toBe(false);
    });
```

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/client.test.ts`
Expected: FAIL — `Cannot find module '../client.js'`.

- [ ] **Step 3: Implement `src/mcp/auth-proxy/client.ts`** — move the two helpers from `src/cli/commands/mcp-auth-proxy.ts:68-114` and parameterize the transport:

```typescript
/**
 * MCP Auth Proxy — loopback control-plane client (CLI side).
 *
 * Talks to the daemon's /healthz and /shutdown endpoints over whichever
 * protocol the daemon listener speaks. For TLS daemons the locally-generated
 * CA is pinned explicitly (`ca:`) — never rejectUnauthorized: false.
 */
import http from 'node:http';
import https from 'node:https';
import type { RouteStatus } from './types.js';

export interface DaemonEndpoint {
  port: number;
  /** True when the daemon listener speaks HTTPS (from the daemon state file). */
  tls?: boolean;
  /** CA certificate PEM to pin for TLS daemons. */
  caPem?: string;
}

export interface HealthzRoute {
  id: string;
  upstreamUrl: string;
  status: RouteStatus;
}

export interface HealthzResponse {
  status: string;
  routes: HealthzRoute[];
}

interface LoopbackRequestOptions {
  host: string;
  port: number;
  path: string;
  method?: string;
  timeout: number;
  ca?: string;
}

function transportFor(endpoint: DaemonEndpoint): typeof http | typeof https {
  return endpoint.tls === true ? https : http;
}

function baseOptions(endpoint: DaemonEndpoint, path: string): LoopbackRequestOptions {
  return {
    host: '127.0.0.1',
    port: endpoint.port,
    path,
    timeout: 2000,
    ...(endpoint.tls === true && endpoint.caPem !== undefined ? { ca: endpoint.caPem } : {}),
  };
}

export function fetchHealth(endpoint: DaemonEndpoint): Promise<HealthzResponse> {
  return new Promise((resolveHealth, rejectHealth) => {
    const request = transportFor(endpoint).get(baseOptions(endpoint, '/healthz'), (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolveHealth(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as HealthzResponse);
        } catch (error) {
          rejectHealth(error as Error);
        }
      });
    });
    request.on('error', rejectHealth);
    request.on('timeout', () => request.destroy(new Error('healthz timed out')));
  });
}

/**
 * Ask the daemon to shut itself down gracefully via the loopback control
 * endpoint. Cross-platform graceful stop (Windows has no POSIX signals, so a
 * signal there is a hard kill that skips the daemon's cleanup). Resolves true
 * if the daemon acknowledged (2xx), false on any error/timeout — the caller
 * then falls back to OS signals.
 */
export function requestShutdown(endpoint: DaemonEndpoint): Promise<boolean> {
  return new Promise((resolveShutdown) => {
    const request = transportFor(endpoint).request(
      { ...baseOptions(endpoint, '/shutdown'), method: 'POST' },
      (res) => {
        res.resume(); // drain the 202 body so the socket can close
        resolveShutdown(
          res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300
        );
      }
    );
    request.on('error', () => resolveShutdown(false));
    request.on('timeout', () => {
      request.destroy();
      resolveShutdown(false);
    });
    request.end();
  });
}
```

- [ ] **Step 4: Run to verify GREEN**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/client.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/auth-proxy/client.ts src/mcp/auth-proxy/__tests__/client.test.ts
git commit -m "feat(proxy): add ca-pinned loopback control-plane client for mcp-auth-proxy"
```

---

### Task 6: `trust.ts` — per-OS trust-store command builders + action runner

**Test-first: yes — trust.test.ts fails with "Cannot find module '../trust.js'".**

**Files:**
- Create: `src/mcp/auth-proxy/trust.ts`
- Test: `src/mcp/auth-proxy/__tests__/trust.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
/**
 * trust.ts tests — pure command builders + injected-exec action runner.
 * No real trust store is ever touched.
 * @group unit
 */
import { describe, it, expect, vi } from 'vitest';
import { applyTrust, buildTrustCommands, getManualTrustInstructions } from '../trust.js';

const CA_PATH = '/home/u/.codemie/mcp-auth-proxy-tls/ca.crt';
const CN = 'CodeMie mcp-auth-proxy CA u@host 2026-07-05';

describe('buildTrustCommands', () => {
  it('win32 install/uninstall target the user Root store', () => {
    expect(buildTrustCommands('win32', CA_PATH, CN, 'install')).toEqual([
      { command: 'certutil', args: ['-addstore', '-user', 'Root', CA_PATH] },
    ]);
    expect(buildTrustCommands('win32', CA_PATH, CN, 'uninstall')).toEqual([
      { command: 'certutil', args: ['-delstore', '-user', 'Root', CN] },
    ]);
  });

  it('darwin install/uninstall use the login keychain', () => {
    const install = buildTrustCommands('darwin', CA_PATH, CN, 'install');
    expect(install?.[0]?.command).toBe('security');
    expect(install?.[0]?.args).toContain('add-trusted-cert');
    expect(install?.[0]?.args).toContain(CA_PATH);

    const uninstall = buildTrustCommands('darwin', CA_PATH, CN, 'uninstall');
    expect(uninstall?.[0]?.args).toContain('delete-certificate');
    expect(uninstall?.[0]?.args).toContain(CN);
  });

  it('linux targets the NSS user DB (what Chromium/Electron read)', () => {
    const install = buildTrustCommands('linux', CA_PATH, CN, 'install');
    expect(install?.[0]?.command).toBe('certutil');
    expect(install?.[0]?.args.join(' ')).toContain('.pki/nssdb');
    expect(install?.[0]?.args).toContain(CN);

    const uninstall = buildTrustCommands('linux', CA_PATH, CN, 'uninstall');
    expect(uninstall?.[0]?.args).toContain('-D');
    expect(uninstall?.[0]?.args).toContain(CN);
  });

  it('returns null for unsupported platforms', () => {
    expect(buildTrustCommands('freebsd', CA_PATH, CN, 'install')).toBeNull();
  });
});

describe('applyTrust', () => {
  it('runs the built commands and reports success', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const result = await applyTrust('install', {
      platform: 'win32',
      exec,
      caPath: CA_PATH,
      caCommonName: CN,
    });
    expect(result.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith('certutil', ['-addstore', '-user', 'Root', CA_PATH]);
  });

  it('fails with manual instructions when the tool exits non-zero', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'denied' });
    const result = await applyTrust('install', {
      platform: 'linux',
      exec,
      caPath: CA_PATH,
      caCommonName: CN,
    });
    expect(result.ok).toBe(false);
    expect(result.manual).toContain(CA_PATH);
  });

  it('fails with manual instructions when the tool is missing (exec throws)', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('spawn certutil ENOENT'));
    const result = await applyTrust('install', {
      platform: 'linux',
      exec,
      caPath: CA_PATH,
      caCommonName: CN,
    });
    expect(result.ok).toBe(false);
    expect(result.manual).toContain(CA_PATH);
  });

  it('returns manual instructions directly on unsupported platforms', async () => {
    const exec = vi.fn();
    const result = await applyTrust('install', {
      platform: 'freebsd',
      exec,
      caPath: CA_PATH,
      caCommonName: CN,
    });
    expect(result.ok).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('getManualTrustInstructions', () => {
  it('mentions the CA path and all three platforms', () => {
    const text = getManualTrustInstructions(CA_PATH);
    expect(text).toContain(CA_PATH);
    expect(text).toMatch(/certutil/);
    expect(text).toMatch(/security add-trusted-cert/);
    expect(text).toMatch(/nssdb/);
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/trust.test.ts`
Expected: FAIL — `Cannot find module '../trust.js'`.

- [ ] **Step 3: Implement `src/mcp/auth-proxy/trust.ts`**

```typescript
/**
 * MCP Auth Proxy — OS trust-store integration for the locally-generated CA.
 *
 * Only the explicit `codemie mcp-auth-proxy trust` command calls this —
 * `start` never modifies the trust store (requirements decision, confirmed at
 * a security escalation gate). Uninstall matches the CA's exact subject CN so
 * only the CodeMie CA is ever removed.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export type TrustAction = 'install' | 'uninstall';

export interface TrustCommand {
  command: string;
  args: string[];
}

export interface TrustDeps {
  platform: NodeJS.Platform;
  /** exec() from src/utils/processes.ts (injected for testability). */
  exec: (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  caPath: string;
  caCommonName: string;
}

export interface TrustResult {
  ok: boolean;
  /** Manual per-OS instructions when the automated path is unavailable/failed. */
  manual?: string;
}

export function buildTrustCommands(
  platform: NodeJS.Platform,
  caPath: string,
  caCommonName: string,
  action: TrustAction
): TrustCommand[] | null {
  switch (platform) {
    case 'win32':
      return action === 'install'
        ? [{ command: 'certutil', args: ['-addstore', '-user', 'Root', caPath] }]
        : [{ command: 'certutil', args: ['-delstore', '-user', 'Root', caCommonName] }];
    case 'darwin': {
      const loginKeychain = join(homedir(), 'Library', 'Keychains', 'login.keychain-db');
      return action === 'install'
        ? [{ command: 'security', args: ['add-trusted-cert', '-k', loginKeychain, caPath] }]
        : [{ command: 'security', args: ['delete-certificate', '-c', caCommonName, loginKeychain] }];
    }
    case 'linux': {
      const nssDb = `sql:${join(homedir(), '.pki', 'nssdb')}`;
      return action === 'install'
        ? [{ command: 'certutil', args: ['-d', nssDb, '-A', '-t', 'C,,', '-n', caCommonName, '-i', caPath] }]
        : [{ command: 'certutil', args: ['-d', nssDb, '-D', '-n', caCommonName] }];
    }
    default:
      return null;
  }
}

export function getManualTrustInstructions(caPath: string): string {
  return [
    `Install the CA manually — certificate file: ${caPath}`,
    `  Windows : certutil -addstore -user Root "${caPath}"`,
    `  macOS   : security add-trusted-cert -k ~/Library/Keychains/login.keychain-db "${caPath}"`,
    `  Linux   : certutil -d sql:$HOME/.pki/nssdb -A -t C,, -n "CodeMie mcp-auth-proxy CA" -i "${caPath}"`,
    '            (requires libnss3-tools; Chromium/Electron read the NSS user DB)',
  ].join('\n');
}

/**
 * Runs the trust-store commands for the platform. Never throws: an unusable
 * tool or unsupported platform yields { ok: false, manual } so the CLI can
 * print instructions and exit non-zero.
 */
export async function applyTrust(action: TrustAction, deps: TrustDeps): Promise<TrustResult> {
  const commands = buildTrustCommands(deps.platform, deps.caPath, deps.caCommonName, action);
  if (commands === null) {
    return { ok: false, manual: getManualTrustInstructions(deps.caPath) };
  }
  for (const { command, args } of commands) {
    try {
      const result = await deps.exec(command, args);
      if (result.code !== 0) {
        return { ok: false, manual: getManualTrustInstructions(deps.caPath) };
      }
    } catch {
      return { ok: false, manual: getManualTrustInstructions(deps.caPath) };
    }
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run to verify GREEN**

Run: `npx vitest run src/mcp/auth-proxy/__tests__/trust.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/auth-proxy/trust.ts src/mcp/auth-proxy/__tests__/trust.test.ts
git commit -m "feat(proxy): add os trust-store command builders and runner for the local ca"
```

---

### Task 7: CLI wiring — `start --tls`, https-aware `status`/`stop`, `trust` subcommand

**Test-first: no — thin command glue over the tested modules (client.ts, certs.ts, trust.ts); behavior is covered by Tasks 2–6 tests plus the Task 8 smoke. No new branching logic beyond option passing and output formatting.**

**Files:**
- Modify: `src/cli/commands/mcp-auth-proxy.ts`

- [ ] **Step 1: Rewire imports** — remove the local `fetchHealth`, `requestShutdown`, and `HealthzRoute` (lines 62–114 in the current file, plus the now-unused `http` import) and import instead:

```typescript
import { readFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { exec } from '../../utils/processes.js';
import { fetchHealth, requestShutdown } from '../../mcp/auth-proxy/client.js';
import type { DaemonEndpoint } from '../../mcp/auth-proxy/client.js';
import { ensureAuthProxyCerts, getAuthProxyTlsPaths } from '../../mcp/auth-proxy/certs.js';
import { applyTrust } from '../../mcp/auth-proxy/trust.js';
import type { AuthProxyDaemonState } from '../../mcp/auth-proxy/types.js';
```

Add one endpoint helper next to `printAddCommands`:

```typescript
/** Builds the control-plane endpoint from daemon state, loading the CA for TLS daemons. */
async function daemonEndpoint(state: AuthProxyDaemonState): Promise<DaemonEndpoint> {
  if (state.tls !== true) {
    return { port: state.port, tls: false };
  }
  try {
    return { port: state.port, tls: true, caPem: await readFile(getAuthProxyTlsPaths().caCert, 'utf-8') };
  } catch {
    // CA file missing — request will fail TLS verification and callers fall back.
    return { port: state.port, tls: true };
  }
}
```

- [ ] **Step 2: Protocol-aware output** — change `printAddCommands` to take the protocol:

```typescript
function printAddCommands(port: number, routes: string[], tls: boolean): void {
  const protocol = tls ? 'https' : 'http';
  console.log(chalk.bold('\nAdd to Claude Code:'));
  for (const id of routes) {
    console.log(
      `  claude mcp add --scope local --transport http ${id} ${protocol}://127.0.0.1:${port}/${id}`
    );
  }
}

function printTlsHints(): void {
  console.log(
    chalk.yellow(
      '\n⚠ TLS is enabled: routes previously registered with http:// URLs must be re-registered with the https:// URLs above.'
    )
  );
  console.log(
    chalk.gray(
      'If the browser or Claude Desktop rejects the certificate, run: codemie mcp-auth-proxy trust\n' +
        'Node-based clients (e.g. Claude Code CLI) do not read the OS trust store — set NODE_EXTRA_CA_CERTS=' +
        getAuthProxyTlsPaths().caCert
    )
  );
}
```

- [ ] **Step 3: `start` action** — add the option and thread TLS through:

```typescript
    .option('--tls', 'Serve HTTPS with the locally-generated CodeMie CA (see the trust subcommand)')
```

Inside the action (`opts` type gains `tls?: boolean`):

- After `const config = await loadAuthProxyConfig(configPath);` add
  `const tls = opts.tls === true || config.tls;` and
  `if (tls) { await ensureAuthProxyCerts(); }` (fail-fast + material ready before the daemon spawns).
- The already-running branch: `printAddCommands(existing.port, existing.routes, existing.tls === true);`
- Foreground branch: `await runAuthProxyDaemon({ configPath, port, tls: opts.tls === true });` and
  `console.log(chalk.green(\`✓ mcp-auth-proxy running (foreground) on ${tls ? 'https' : 'http'}://127.0.0.1:${port}\`)); printAddCommands(port, routes, tls); if (tls) { printTlsHints(); }`
- Detached spawn args: `...(opts.tls === true ? ['--tls'] : [])` appended after `'--state-file', getDefaultStatePath(),`.
- Success poll branch:
  `console.log(chalk.green(\`✓ mcp-auth-proxy started on ${state.tls === true ? 'https' : 'http'}://127.0.0.1:${state.port} (pid ${state.pid})\`)); printAddCommands(state.port, state.routes, state.tls === true); if (state.tls === true) { printTlsHints(); }`

- [ ] **Step 4: `status` action** — protocol-aware URL line and endpoint-based health call:

```typescript
      const protocol = state.tls === true ? 'https' : 'http';
      console.log(
        chalk.green(
          `✓ mcp-auth-proxy running on ${protocol}://127.0.0.1:${state.port} (pid ${state.pid}, started ${state.startedAt})`
        )
      );
      try {
        const health = await fetchHealth(await daemonEndpoint(state));
        for (const route of health.routes) {
          const marker =
            route.status === 'degraded' ? chalk.red('✗ degraded') : chalk.green(`✓ ${route.status}`);
          console.log(`  ${route.id}: ${marker} → ${route.upstreamUrl}`);
          console.log(
            `    claude mcp add --scope local --transport http ${route.id} ${protocol}://127.0.0.1:${state.port}/${route.id}`
          );
        }
      } catch {
        console.log(chalk.red('  ✗ Daemon process is alive but /healthz did not answer'));
      }
```

- [ ] **Step 5: `stop` action** — single-line change: `const acked = await requestShutdown(await daemonEndpoint(state));` (the poll/SIGTERM/SIGKILL fallback stays untouched).

- [ ] **Step 6: `trust` subcommand** — add after the `stop` command:

```typescript
  command
    .command('trust')
    .description('Install (or remove) the locally-generated CA in the OS user trust store')
    .option('--uninstall', 'Remove the CodeMie CA from the trust store instead of installing it')
    .action(async (opts: { uninstall?: boolean }) => {
      try {
        const material = await ensureAuthProxyCerts(); // side-effect-free beyond ~/.codemie file generation
        const action = opts.uninstall === true ? 'uninstall' : 'install';
        const result = await applyTrust(action, {
          platform: platform(),
          exec: (cmd, args) => exec(cmd, args),
          caPath: material.paths.caCert,
          caCommonName: material.caCommonName,
        });

        const { X509Certificate } = await import('node:crypto');
        const ca = new X509Certificate(material.caCertPem);
        console.log(`CA certificate : ${material.paths.caCert}`);
        console.log(`Subject CN     : ${material.caCommonName}`);
        console.log(`SHA-256        : ${ca.fingerprint256}`);
        console.log(`Valid until    : ${ca.validTo}`);

        if (result.ok) {
          console.log(
            chalk.green(action === 'install' ? '✓ CA installed in the user trust store' : '✓ CA removed from the user trust store')
          );
        } else {
          console.log(chalk.yellow(`Automated ${action} was not possible on this system.`));
          if (result.manual !== undefined) {
            console.log(result.manual);
          }
          process.exitCode = 1;
        }
      } catch (error) {
        printError(error, '[mcp-auth-proxy] trust failed');
      }
    });
```

- [ ] **Step 7: Verify** — Run: `npx tsc --noEmit && npx eslint 'src/cli/commands/mcp-auth-proxy.ts' --max-warnings=0 && npx vitest run src/mcp/auth-proxy src/utils/__tests__/spawn-detached.test.ts`
Expected: clean typecheck/lint, all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/cli/commands/mcp-auth-proxy.ts
git commit -m "feat(cli): add --tls start flag, trust subcommand, and https-aware status/stop"
```

---

### Task 8: End-to-end smoke (isolated CODEMIE_HOME, real daemon)

**Test-first: no — this is a functional verification step, not new code. Every behavior it exercises already has unit coverage above.**

**Files:** none (build + shell only)

- [ ] **Step 1: Build** — Run: `npm run build`. Expected: success.

- [ ] **Step 2: TLS daemon smoke**

```bash
export SMOKE_HOME=$(mktemp -d)
CODEMIE_HOME=$SMOKE_HOME node bin/codemie.js --version   # run one-time migrations quietly
cat > $SMOKE_HOME/mcp-auth-proxy.json <<'EOF'
{ "port": 42899, "tls": true,
  "servers": { "radar": { "upstreamUrl": "https://mcp.example.com/radar" } } }
EOF
CODEMIE_HOME=$SMOKE_HOME node bin/codemie.js mcp-auth-proxy start
# wait for readiness, then:
curl --cacert $SMOKE_HOME/mcp-auth-proxy-tls/ca.crt https://127.0.0.1:42899/healthz
```

Expected: start prints `✓ mcp-auth-proxy started on https://127.0.0.1:42899 …`, https URLs in the add hints, the re-registration warning, and the trust hint; curl returns `{"status":"ok",...}` **with certificate verification on** (no `-k`).

- [ ] **Step 3: Graceful stop over TLS**

```bash
CODEMIE_HOME=$SMOKE_HOME node bin/codemie.js mcp-auth-proxy stop
```

Expected: `✓ mcp-auth-proxy stopped` quickly (graceful path over https, no SIGTERM warning in debug logs); state file removed.

- [ ] **Step 4: Plain HTTP regression smoke** — same config without `"tls": true`; start, `curl http://127.0.0.1:42899/healthz`, stop. Expected: identical behavior to the pre-change proxy.

- [ ] **Step 5: Cleanup** — `rm -rf $SMOKE_HOME`. No commit (no file changes).

---

### Task 9: Documentation

**Test-first: no — documentation only.**

**Files:**
- Modify: `docs/COMMANDS.md` (the `codemie mcp-auth-proxy` section)

- [ ] **Step 1: Update `docs/COMMANDS.md`** — in the existing `mcp-auth-proxy` section:
  - Add `--tls` to the `start` options table/list: "Serve HTTPS with the locally-generated CodeMie CA (config equivalent: `"tls": true`). Default: plain HTTP."
  - Add a `trust` subcommand entry: install/uninstall the local CA in the user trust store (Windows `certutil -addstore -user Root`, macOS login keychain via `security add-trusted-cert`, Linux NSS user DB via `certutil` from libnss3-tools); `--uninstall` removes only the CodeMie CA (matched by its subject CN).
  - Add a short "HTTPS / Claude Desktop" note: why TLS exists (Desktop refuses non-https authorize URLs), that enabling TLS changes the origin so `http://` registrations must be re-registered, and that Node-based clients need `NODE_EXTRA_CA_CERTS=~/.codemie/mcp-auth-proxy-tls/ca.crt` since they do not read the OS trust store.

- [ ] **Step 2: Commit**

```bash
git add docs/COMMANDS.md
git commit -m "docs: document mcp-auth-proxy --tls and trust subcommand"
```

---

## Self-review notes (performed at plan time)

- **Spec coverage:** design §certs.ts → Task 2; §server.ts → Task 3; §config/types → Task 1; §runtime/daemon → Task 4; §CLI (start/status/stop) → Tasks 5+7; §trust → Tasks 6+7; §data flow/smoke → Task 8; re-registration warning + NODE_EXTRA_CA_CERTS note (spec follow-up) → Tasks 7+9; dependency pin note → header + Task 2.
- **Type consistency:** `TlsMaterial{keyPem,certPem,caCertPem,caCommonName,paths}` (T2) consumed in T3 tests, T4 runtime, T5 tests, T7 CLI; `ServerTlsMaterial{keyPem,certPem}` (T3) built in T4; `DaemonEndpoint{port,tls,caPem}` (T5) built by T7 `daemonEndpoint`; `applyTrust(action, {platform,exec,caPath,caCommonName})` (T6) called identically in T7.
- **Deviation risk called out:** PEM string identity in T2 idempotency test — mitigation (read-back variant) included inline.
