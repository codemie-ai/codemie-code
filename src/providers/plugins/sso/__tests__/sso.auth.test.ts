/**
 * Tests for deriveExpiresAt — JWT exp extraction from cookie dict — and
 * hasUsableSsoCredential — the cookies-or-authorization usability check.
 * @group unit
 */
import { describe, it, expect } from 'vitest';
import { deriveExpiresAt, hasUsableSsoCredential } from '../sso.auth.js';

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

describe('hasUsableSsoCredential', () => {
  it('is usable with non-empty cookies and no authorization', () => {
    expect(hasUsableSsoCredential({ session: 'abc' }, undefined)).toBe(true);
  });

  it('is usable with a non-empty authorization fallback and no cookies at all', () => {
    expect(hasUsableSsoCredential(undefined, 'backend-issued-value')).toBe(true);
  });

  it('is usable with a non-empty authorization fallback and empty cookies (reverse proxy strips cookies)', () => {
    expect(hasUsableSsoCredential({}, 'backend-issued-value')).toBe(true);
  });

  it('is usable when both cookies and authorization are present', () => {
    expect(hasUsableSsoCredential({ session: 'abc' }, 'backend-issued-value')).toBe(true);
  });

  it('is not usable with empty cookies and no authorization', () => {
    expect(hasUsableSsoCredential({}, undefined)).toBe(false);
  });

  it('is not usable with no cookies at all and no authorization', () => {
    expect(hasUsableSsoCredential(undefined, undefined)).toBe(false);
  });

  it('is not usable when authorization is an empty or whitespace-only string', () => {
    expect(hasUsableSsoCredential({}, '')).toBe(false);
    expect(hasUsableSsoCredential({}, '   ')).toBe(false);
  });
});
