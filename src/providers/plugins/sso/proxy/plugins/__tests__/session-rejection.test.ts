import { describe, it, expect } from 'vitest';
import { isSessionRejection401 } from '../session-rejection.js';

/**
 * Assumed response shapes. No real gateway captures were available when the predicate was written,
 * so these fixtures encode the assumption that only the status code tells a session 401 apart.
 */
const FIXTURES = {
  sessionExpired401: {
    statusCode: 401,
    headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
  },
  bare401: { statusCode: 401, headers: {} },
  ok200: { statusCode: 200, headers: { 'content-type': 'application/json' } },
  forbidden403: { statusCode: 403, headers: { 'content-type': 'application/json' } },
  oauthRedirect302: { statusCode: 302, headers: { location: 'https://x/oauth2/start?rd=%2F' } },
};

describe('isSessionRejection401', () => {
  it.each([
    ['a JSON 401 with a WWW-Authenticate header', FIXTURES.sessionExpired401],
    ['a bare 401', FIXTURES.bare401],
  ])('is true for %s', (_label, response) => {
    expect(isSessionRejection401(response)).toBe(true);
  });

  it.each([
    ['200', FIXTURES.ok200],
    ['403', FIXTURES.forbidden403],
    ['302 to /oauth2/start', FIXTURES.oauthRedirect302],
  ])('is false for %s', (_label, response) => {
    expect(isSessionRejection401(response)).toBe(false);
  });

  it('is false when the status code is missing', () => {
    expect(isSessionRejection401({ headers: {} })).toBe(false);
  });

  // Known limitation (accepted, EPMCDME-17014): the predicate is status-only, so a 401 that is not
  // caused by a dead SSO session (denied model, relayed upstream failure) is also matched. The
  // caller's loop guard, lock and cooldown bound the resulting sign-ins.
  it('KNOWN LIMITATION: matches a non-session 401 because the predicate is status-only', () => {
    const nonSession401 = {
      statusCode: 401,
      headers: { 'content-type': 'application/json', 'x-upstream-error': 'model access denied' },
    };
    expect(isSessionRejection401(nonSession401)).toBe(true);
  });
});
