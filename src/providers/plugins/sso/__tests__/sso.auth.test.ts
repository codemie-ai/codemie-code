/**
 * Tests for deriveExpiresAt — JWT exp extraction from cookie dict.
 * @group unit
 */
import { describe, it, expect } from 'vitest';
import { deriveExpiresAt } from '../sso.auth.js';

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
