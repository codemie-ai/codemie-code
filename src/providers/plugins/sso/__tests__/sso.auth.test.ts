/**
 * Tests for deriveExpiresAt — JWT exp extraction from cookie dict.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import open from 'open';
import { spawn } from 'child_process';
import { deriveExpiresAt } from '../sso.auth.js';

vi.mock('open', () => ({
  default: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => ({ unref: vi.fn() })),
  };
});

function makeJwt(exp: number): string {
  const payload = { sub: 'uid', email: 'u@test.com', exp, iss: 'codemie-local' };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `eyJhbGciOiJSUzI1NiJ9.${b64}.fakesig`;
}

describe('deriveExpiresAt', () => {
  it('returns JWT exp * 1000 when codemie_access_token is a valid JWT with exp', () => {
    const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600; // 1 week
    const jwt = makeJwt(exp);

    const result = deriveExpiresAt({ codemie_access_token: jwt });

    expect(result).toBe(exp * 1000);
  });

  it('falls back to ~24h when codemie_access_token is malformed', () => {
    const before = Date.now();

    const result = deriveExpiresAt({ codemie_access_token: 'not.a.valid.jwt.at.all' });

    const after = Date.now();
    const expected24h = before + 24 * 60 * 60 * 1000;
    expect(result).toBeGreaterThanOrEqual(expected24h - 1000);
    expect(result).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000 + 1000);
  });

  it('falls back to ~24h when codemie_access_token cookie is absent', () => {
    const before = Date.now();

    const result = deriveExpiresAt({});

    const after = Date.now();
    const expected24h = before + 24 * 60 * 60 * 1000;
    expect(result).toBeGreaterThanOrEqual(expected24h - 1000);
    expect(result).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000 + 1000);
  });
});

describe('CodeMieSSO.authenticate() — browser launch', () => {
  let originalPlatform: NodeJS.Platform;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalPlatform = process.platform;
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(open).mockClear();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    consoleSpy.mockRestore();
  });

  it('prints the SSO URL to console before browser launch on any platform', async () => {
    const { CodeMieSSO } = await import('../sso.auth.js');
    const sso = new CodeMieSSO();

    // timeout: 50 causes authenticate() to time out quickly after launching the browser
    await sso.authenticate({ codeMieUrl: 'https://example.com', timeout: 50 });

    const output = consoleSpy.mock.calls.map(args => String(args[0])).join('\n');
    expect(output).toContain('/v1/auth/login/');
  });

  it('spawns explorer.exe on Windows and does not call open()', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const { CodeMieSSO } = await import('../sso.auth.js');
    const sso = new CodeMieSSO();

    await sso.authenticate({ codeMieUrl: 'https://example.com', timeout: 50 });

    expect(spawn).toHaveBeenCalledWith(
      'explorer.exe',
      [expect.stringContaining('/v1/auth/login/')],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    expect(open).not.toHaveBeenCalled();
  });

  it('calls open() on macOS and does not spawn explorer.exe', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const { CodeMieSSO } = await import('../sso.auth.js');
    const sso = new CodeMieSSO();

    await sso.authenticate({ codeMieUrl: 'https://example.com', timeout: 50 });

    expect(open).toHaveBeenCalledWith(expect.stringContaining('/v1/auth/login/'));
    expect(spawn).not.toHaveBeenCalled();
  });
});
