/**
 * Regression tests for EPMCDME-14132 — SSO credential storage-key normalization.
 *
 * keytar is mocked with an in-memory map. retrieveSSOCredentials consults the real
 * OS keychain before the file store, so an unmocked run can pass against unfixed
 * code purely on a stale keychain entry left by an earlier run.
 *
 * setupTestIsolation() is deliberately not used: it sets CODEMIE_HOME in beforeAll,
 * after security.ts has frozen CREDENTIALS_DIR at module scope. The vitest project
 * config already points CODEMIE_HOME at a temp dir before import. That directory is
 * shared with every other file in the `cli` project, so assertions here name exact
 * filenames rather than counting directory entries.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { access, copyFile, rm } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';

const keychain = new Map<string, string>();

vi.mock('keytar', () => ({
  setPassword: vi.fn(async (service: string, account: string, password: string) => {
    keychain.set(`${service}:${account}`, password);
  }),
  getPassword: vi.fn(async (service: string, account: string) =>
    keychain.get(`${service}:${account}`) ?? null),
  deletePassword: vi.fn(async (service: string, account: string) =>
    keychain.delete(`${service}:${account}`)),
}));

import { CredentialStore } from '../../src/utils/security.js';
import { CodeMieSSO } from '../../src/providers/plugins/sso/sso.auth.js';
import { getCodemiePath } from '../../src/utils/paths.js';
import type { SSOCredentials } from '../../src/providers/core/types.js';

const BASE_URL = 'https://codemie-14132.example.com';
const API_URL = `${BASE_URL}/code-assistant-api`;

function credentials(token = 'test-token'): SSOCredentials {
  return {
    cookies: { codemie_access_token: token },
    apiUrl: API_URL,
    expiresAt: Date.now() + 60 * 60 * 1000,
  };
}

/** The storage file the implementation must use for a given normalized key input. */
function credentialFile(normalized: string): string {
  const hash = createHash('sha256').update(normalized).digest('hex');
  return join(getCodemiePath('credentials'), `sso-${hash}.enc`);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

describe('EPMCDME-14132: credential storage key is path-independent', () => {
  beforeEach(async () => {
    keychain.clear();
    await rm(credentialFile(BASE_URL), { force: true });
    await rm(credentialFile(API_URL), { force: true });
  });

  it('stores under the host-only key regardless of the path in the URL', async () => {
    await CredentialStore.getInstance().storeSSOCredentials(credentials(), API_URL);

    expect(await exists(credentialFile(BASE_URL))).toBe(true);
    expect(await exists(credentialFile(API_URL))).toBe(false);
  });

  it('finds credentials stored under a path-bearing URL (the reported bug)', async () => {
    await CredentialStore.getInstance().storeSSOCredentials(credentials(), API_URL);

    const found = await new CodeMieSSO().getStoredCredentials(API_URL);

    expect(found).not.toBeNull();
    expect(found?.cookies.codemie_access_token).toBe('test-token');
  });

  it('clears credentials stored under the base URL when given the API URL', async () => {
    await CredentialStore.getInstance().storeSSOCredentials(credentials(), BASE_URL);
    expect(await new CodeMieSSO().getStoredCredentials(API_URL)).not.toBeNull();

    await new CodeMieSSO().clearStoredCredentials(API_URL);

    expect(await new CodeMieSSO().getStoredCredentials(API_URL)).toBeNull();
  });
});

describe('EPMCDME-14132: normalization must not collapse distinct endpoints', () => {
  const store = () => CredentialStore.getInstance();

  beforeEach(() => {
    keychain.clear();
  });

  // new URL() does not throw on `scheme:rest`; it yields an empty host. Without a
  // host guard, every scheme-less host:port collapses to one key and two instances
  // share a credential slot.
  it('keeps scheme-less host:port endpoints on separate keys', async () => {
    await store().storeSSOCredentials(credentials('token-8080'), 'localhost:8080');
    await store().storeSSOCredentials(credentials('token-9090'), 'localhost:9090');

    const first = await store().retrieveSSOCredentials('localhost:8080');
    const second = await store().retrieveSSOCredentials('localhost:9090');

    expect(first?.cookies.codemie_access_token).toBe('token-8080');
    expect(second?.cookies.codemie_access_token).toBe('token-9090');
  });

  it('keeps different hosts, ports and schemes on separate keys', async () => {
    await store().storeSSOCredentials(credentials('a'), 'https://a.example.com');
    await store().storeSSOCredentials(credentials('b'), 'https://b.example.com');
    await store().storeSSOCredentials(credentials('port'), 'https://a.example.com:8443');
    await store().storeSSOCredentials(credentials('plain'), 'http://a.example.com');

    expect((await store().retrieveSSOCredentials('https://a.example.com'))?.cookies
      .codemie_access_token).toBe('a');
    expect((await store().retrieveSSOCredentials('https://b.example.com'))?.cookies
      .codemie_access_token).toBe('b');
    expect((await store().retrieveSSOCredentials('https://a.example.com:8443'))?.cookies
      .codemie_access_token).toBe('port');
    expect((await store().retrieveSSOCredentials('http://a.example.com'))?.cookies
      .codemie_access_token).toBe('plain');
  });
});

describe('EPMCDME-14132: credentials written under the pre-fix key stay reachable', () => {
  const legacyFile = credentialFile(API_URL); // pre-fix key: raw URL, path included
  const currentFile = credentialFile(BASE_URL);

  /** Reproduce an entry written by a pre-fix CLI: same encryption, legacy filename. */
  async function seedLegacyCredential(): Promise<void> {
    keychain.clear();
    await CredentialStore.getInstance().storeSSOCredentials(credentials('legacy-token'), API_URL);
    await copyFile(currentFile, legacyFile);
    await rm(currentFile, { force: true });
    keychain.clear();
  }

  beforeEach(async () => {
    keychain.clear();
    await rm(legacyFile, { force: true });
    await rm(currentFile, { force: true });
  });

  // Exercised through CodeMieSSO, not CredentialStore directly: the production
  // caller is what decides whether the legacy key is ever probed.
  it('reads a credential stored under the legacy key', async () => {
    await seedLegacyCredential();

    const found = await new CodeMieSSO().getStoredCredentials(API_URL);

    expect(found?.cookies.codemie_access_token).toBe('legacy-token');
  });

  it('deletes the legacy entry on logout so it cannot linger', async () => {
    await seedLegacyCredential();

    await new CodeMieSSO().clearStoredCredentials(API_URL);

    expect(await exists(legacyFile)).toBe(false);
    expect(await exists(currentFile)).toBe(false);
  });
});
