import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  forgetPersistedLogin,
  forgetPersistedLoginIf,
  loadPersistedLogin,
  peekPersistedLogin,
  persistLogin,
  type PersistedLogin,
} from '../auth/token-store.js';
import { encryptWithKey } from '../../utils/credential-crypto.js';
import { useTempCodemieHome } from './helpers/temp-home.js';

const home = useTempCodemieHome();

const RESOURCE = new URL('https://gateway.example/mcp/tokens-test');
const REFRESH = 'refresh-token-value';

function authDir(): string {
  return join(home.dir(), 'mcp-auth');
}

function fileFor(resource: URL): string {
  const name = createHash('sha256').update(resource.href).digest('hex').slice(0, 16);
  return join(authDir(), `${name}.enc`);
}

function login(overrides: Partial<PersistedLogin> = {}): PersistedLogin {
  return {
    tokens: { access_token: 'access-token-value', token_type: 'Bearer', scope: 'read' },
    expiresAt: Date.now() + 3_600_000,
    grant: { refreshToken: REFRESH, clientInfo: { client_id: 'client-1' } },
    ...overrides,
  };
}

describe('token store', () => {
  beforeEach(() => {
    // proxyLog may write to stderr; keep test output clean
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('persistLogin / loadPersistedLogin', () => {
    it('characterization: round trip keeps tokens, expiry and grant', () => {
      const original = login();
      persistLogin(RESOURCE, original);

      const loaded = loadPersistedLogin(RESOURCE);

      expect(loaded).toEqual(original);
    });

    it('characterization: an expired token with a grant is still returned', () => {
      persistLogin(RESOURCE, login({ expiresAt: Date.now() - 10_000 }));

      const loaded = loadPersistedLogin(RESOURCE);

      expect(loaded?.grant?.refreshToken).toBe(REFRESH);
      expect(existsSync(fileFor(RESOURCE))).toBe(true);
    });

    it('characterization: an expired token without a grant is deleted by load', () => {
      persistLogin(RESOURCE, login({ grant: undefined, expiresAt: Date.now() - 10_000 }));
      expect(existsSync(fileFor(RESOURCE))).toBe(true);

      expect(loadPersistedLogin(RESOURCE)).toBeUndefined();
      expect(existsSync(fileFor(RESOURCE))).toBe(false);
    });

    it('characterization: a token expiring within the skew counts as expired', () => {
      persistLogin(RESOURCE, login({ grant: undefined, expiresAt: Date.now() + 30_000 }));

      expect(loadPersistedLogin(RESOURCE)).toBeUndefined();
      expect(existsSync(fileFor(RESOURCE))).toBe(false);
    });

    it('characterization: a token well inside its lifetime is returned without a grant', () => {
      const original = login({ grant: undefined, expiresAt: Date.now() + 600_000 });
      persistLogin(RESOURCE, original);

      expect(loadPersistedLogin(RESOURCE)).toEqual(original);
    });

    it('characterization: nothing is written without expires_in and without a grant', () => {
      persistLogin(RESOURCE, login({ grant: undefined, expiresAt: undefined }));

      expect(existsSync(authDir())).toBe(false);
      expect(loadPersistedLogin(RESOURCE)).toBeUndefined();
    });

    it('characterization: a corrupt file gives undefined', () => {
      persistLogin(RESOURCE, login());
      writeFileSync(fileFor(RESOURCE), 'this is not an encrypted file');

      expect(loadPersistedLogin(RESOURCE)).toBeUndefined();
    });

    it('characterization: a file encrypted with another key gives undefined', () => {
      persistLogin(RESOURCE, login());
      writeFileSync(fileFor(RESOURCE), encryptWithKey(JSON.stringify({ version: 3 }), randomBytes(32)));

      expect(loadPersistedLogin(RESOURCE)).toBeUndefined();
    });

    it('characterization: MCP_PROXY_PERSIST_TOKENS=off neither reads nor writes', () => {
      persistLogin(RESOURCE, login());
      expect(existsSync(fileFor(RESOURCE))).toBe(true);

      process.env.MCP_PROXY_PERSIST_TOKENS = 'off';
      expect(loadPersistedLogin(RESOURCE)).toBeUndefined();

      const other = new URL('https://gateway.example/mcp/other');
      persistLogin(other, login());
      expect(existsSync(fileFor(other))).toBe(false);
    });

    it.skipIf(process.platform === 'win32')('characterization: directory is 0700 and file is 0600', () => {
      persistLogin(RESOURCE, login());

      expect(statSync(authDir()).mode & 0o777).toBe(0o700);
      expect(statSync(fileFor(RESOURCE)).mode & 0o777).toBe(0o600);
    });

    it('characterization: leaves no temp file behind', () => {
      persistLogin(RESOURCE, login());

      expect(readdirSync(authDir()).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });
  });

  describe('peekPersistedLogin', () => {
    it('returns the same login as load for a valid file', () => {
      const original = login();
      persistLogin(RESOURCE, original);

      expect(peekPersistedLogin(RESOURCE)).toEqual(original);
      expect(peekPersistedLogin(RESOURCE)).toEqual(loadPersistedLogin(RESOURCE));
    });

    it('returns an expired token that has a grant', () => {
      persistLogin(RESOURCE, login({ expiresAt: Date.now() - 10_000 }));

      expect(peekPersistedLogin(RESOURCE)?.grant?.refreshToken).toBe(REFRESH);
    });

    it('returns undefined but does not delete an expired token without a grant', () => {
      persistLogin(RESOURCE, login({ grant: undefined, expiresAt: Date.now() - 10_000 }));

      expect(peekPersistedLogin(RESOURCE)).toBeUndefined();
      expect(existsSync(fileFor(RESOURCE))).toBe(true);
    });

    it('treats a token expiring within the skew as expired, without deleting', () => {
      persistLogin(RESOURCE, login({ grant: undefined, expiresAt: Date.now() + 30_000 }));

      expect(peekPersistedLogin(RESOURCE)).toBeUndefined();
      expect(existsSync(fileFor(RESOURCE))).toBe(true);
    });

    it('returns undefined when there is no file', () => {
      expect(peekPersistedLogin(RESOURCE)).toBeUndefined();
    });

    it('returns undefined for a corrupt file without throwing or deleting it', () => {
      persistLogin(RESOURCE, login());
      writeFileSync(fileFor(RESOURCE), 'garbage');

      expect(() => peekPersistedLogin(RESOURCE)).not.toThrow();
      expect(peekPersistedLogin(RESOURCE)).toBeUndefined();
      expect(existsSync(fileFor(RESOURCE))).toBe(true);
    });

    it('returns undefined for a file the machine key cannot decrypt (e.g. hostname changed), no throw', () => {
      persistLogin(RESOURCE, login());
      // Machine key = hash(hostname + platform + arch); a different key models a changed hostname
      writeFileSync(fileFor(RESOURCE), encryptWithKey(JSON.stringify({ version: 3 }), randomBytes(32)));

      expect(() => peekPersistedLogin(RESOURCE)).not.toThrow();
      expect(peekPersistedLogin(RESOURCE)).toBeUndefined();
      expect(existsSync(fileFor(RESOURCE))).toBe(true);
    });

    it('returns undefined when the file belongs to another resource', () => {
      persistLogin(RESOURCE, login());
      const other = new URL('https://gateway.example/mcp/other');
      writeFileSync(fileFor(other), readFileSync(fileFor(RESOURCE), 'utf-8'));

      expect(peekPersistedLogin(other)).toBeUndefined();
    });

    it('honours MCP_PROXY_PERSIST_TOKENS=off', () => {
      persistLogin(RESOURCE, login());
      process.env.MCP_PROXY_PERSIST_TOKENS = 'off';

      expect(peekPersistedLogin(RESOURCE)).toBeUndefined();
      expect(existsSync(fileFor(RESOURCE))).toBe(true);
    });
  });

  describe('forgetPersistedLoginIf', () => {
    it('keeps a file whose refresh token differs', () => {
      persistLogin(RESOURCE, login());

      expect(forgetPersistedLoginIf(RESOURCE, 'some-other-refresh-token')).toBe(false);
      expect(existsSync(fileFor(RESOURCE))).toBe(true);
      expect(loadPersistedLogin(RESOURCE)?.grant?.refreshToken).toBe(REFRESH);
    });

    it('removes a file whose refresh token matches', () => {
      persistLogin(RESOURCE, login());

      expect(forgetPersistedLoginIf(RESOURCE, REFRESH)).toBe(true);
      expect(existsSync(fileFor(RESOURCE))).toBe(false);
    });

    it('returns false when there is no file', () => {
      expect(forgetPersistedLoginIf(RESOURCE, REFRESH)).toBe(false);
    });

    it('keeps a file without a grant', () => {
      persistLogin(RESOURCE, login({ grant: undefined }));

      expect(forgetPersistedLoginIf(RESOURCE, REFRESH)).toBe(false);
      expect(existsSync(fileFor(RESOURCE))).toBe(true);
    });

    it('does not throw and keeps an undecryptable file', () => {
      persistLogin(RESOURCE, login());
      writeFileSync(fileFor(RESOURCE), 'garbage');

      expect(() => forgetPersistedLoginIf(RESOURCE, REFRESH)).not.toThrow();
      expect(forgetPersistedLoginIf(RESOURCE, REFRESH)).toBe(false);
      expect(existsSync(fileFor(RESOURCE))).toBe(true);
    });
  });

  describe('forgetPersistedLogin', () => {
    it('characterization: removes the file unconditionally', () => {
      persistLogin(RESOURCE, login());

      forgetPersistedLogin(RESOURCE);

      expect(existsSync(fileFor(RESOURCE))).toBe(false);
    });
  });
});
