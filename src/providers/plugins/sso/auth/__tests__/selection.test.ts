/**
 * Tests for the keytar-free credential selection core.
 * @group unit
 */
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  recordExpiresAt,
  recordFingerprint,
  selectRecord,
  toSSOAuth,
  type RecordCandidate,
} from '../selection.js';

const apiUrl = 'https://codemie.example.com/code-assistant-api';
const url = 'https://codemie.example.com';

function makeJwt(exp: number): string {
  const payload = { sub: 'uid', email: 'u@test.com', exp, iss: 'codemie-local' };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `eyJhbGciOiJSUzI1NiJ9.${b64}.fakesig`;
}

function cookie(record: Partial<Extract<RecordCandidate, { type: 'cookie' }>['record']> = {}): RecordCandidate {
  return { type: 'cookie', record: { cookies: { _oauth2_proxy: 'x' }, apiUrl, ...record } };
}

function jwt(record: Partial<Extract<RecordCandidate, { type: 'jwt' }>['record']> = {}): RecordCandidate {
  return { type: 'jwt', record: { token: 't', apiUrl, ...record } };
}

describe('selectRecord', () => {
  it('legacy unmarked cookie wins over unmarked jwt', () => {
    const c = cookie();
    const j = jwt();

    expect(selectRecord([j, c])).toBe(c);
  });

  it('newest marked record wins', () => {
    const c = cookie({ authType: 'cookie', storedAt: 1 });
    const j = jwt({ authType: 'jwt', storedAt: 2 });

    expect(selectRecord([c, j])).toBe(j);
  });

  it('unmarked coexisting with marked other type wins', () => {
    const c = cookie({ authType: 'cookie', storedAt: Date.now() });
    const j = jwt();

    expect(selectRecord([c, j])).toBe(j);
  });

  it('expired and unusable records are skipped', () => {
    const now = Date.now();
    const expiredJwt = jwt({ expiresAt: now - 1000 });
    const unusableCookie = cookie({ cookies: { '': 'x' } });

    expect(selectRecord([unusableCookie, expiredJwt], now)).toBeNull();

    const liveJwt = jwt({ token: 'live' });
    expect(selectRecord([unusableCookie, liveJwt], now)).toBe(liveJwt);
    expect(selectRecord([expiredJwt, cookie()], now)?.type).toBe('cookie');
  });

  it('returns null when there are no candidates', () => {
    expect(selectRecord([])).toBeNull();
  });
});

describe('recordFingerprint', () => {
  it('cookie fingerprint matches the legacy credentialFingerprint formula', () => {
    const expected = createHash('sha256')
      .update(JSON.stringify([apiUrl, [['a', '1'], ['b', '2']]]))
      .digest('hex');

    expect(recordFingerprint(cookie({ cookies: { b: '2', a: '1' } }))).toBe(expected);
  });

  it('differs between a cookie and a jwt login', () => {
    expect(recordFingerprint(jwt())).not.toBe(recordFingerprint(cookie()));
  });
});

describe('toSSOAuth headers', () => {
  it('builds a "; "-joined cookie header for a cookie record', () => {
    const auth = toSSOAuth(cookie({ cookies: { a: '1', b: '2' } }), url);

    expect(auth.type).toBe('cookie');
    expect(auth.headers).toEqual({ cookie: 'a=1; b=2' });
    expect(auth.authValue).toBe('a=1; b=2');
    expect(auth.url).toBe(url);
    expect(auth.apiUrl).toBe(apiUrl);
    expect(auth.source).toBe('store');
  });

  it('builds a Bearer authorization header for a jwt record', () => {
    const auth = toSSOAuth(jwt({ token: 't' }), url);

    expect(auth.type).toBe('jwt');
    expect(auth.headers).toEqual({ authorization: 'Bearer t' });
    expect(auth.authValue).toBe('t');
    expect(auth.identityToken).toBe('t');
  });

  it('carries the explicit source when given', () => {
    expect(toSSOAuth(jwt(), url, 'explicit').source).toBe('explicit');
  });
});

// Moved from sso.auth.test.ts (effectiveExpiresAt -> recordExpiresAt).
describe('recordExpiresAt', () => {
  it('is undefined for cookie-only credentials, even with a legacy synthetic expiresAt', () => {
    expect(recordExpiresAt(cookie({ cookies: { _oauth2_proxy: 'x' } }))).toBeUndefined();
    expect(recordExpiresAt(cookie({ cookies: { _oauth2_proxy: 'x' }, expiresAt: Date.now() - 1000 }))).toBeUndefined();
  });

  it('has no local expiry for an exp-less codemie_access_token whose stored expiresAt is unset', () => {
    expect(recordExpiresAt(cookie({ cookies: { codemie_access_token: 'opaque-token' } }))).toBeUndefined();
  });

  it('returns the stored expiresAt when codemie_access_token is present', () => {
    const exp = Date.now() + 1000;
    expect(recordExpiresAt(cookie({ cookies: { codemie_access_token: makeJwt(1) }, expiresAt: exp }))).toBe(exp);
  });

  it('returns a JWT credential\'s own expiresAt, and none when it has no exp', () => {
    const exp = Date.now() + 1000;
    expect(recordExpiresAt(jwt({ expiresAt: exp }))).toBe(exp);
    expect(recordExpiresAt(jwt())).toBeUndefined();
  });
});
