import { describe, it, expect } from 'vitest';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { isSessionRejection401 } from '../session-rejection.js';

/**
 * Bodies as the backend and the LLM proxy send them. The session rejection is the backend's
 * `ExtendedHTTPException` ("Authentication failed", codemie/enterprise/idp/dependencies.py); the
 * LiteLLM body is relayed unchanged by the LLM proxy with a valid SSO session.
 */
const SESSION_BODY = JSON.stringify({
  error: {
    message: 'Authentication failed',
    details: 'No valid authentication credentials were provided with this request.',
    help: "Please ensure you're logged in and your session hasn't expired.",
  },
});
const LITELLM_BODY = JSON.stringify({
  error: { message: 'Authentication Error, Invalid proxy server token passed', type: 'auth_error', code: '401' },
});

const r = (statusCode?: number) => ({ statusCode, headers: { 'content-type': 'application/json' } });

describe('isSessionRejection401', () => {
  it('is true for a 401 with the backend session-rejection body, as text or as a Buffer', () => {
    expect(isSessionRejection401(r(401), SESSION_BODY)).toBe(true);
    expect(isSessionRejection401(r(401), Buffer.from(SESSION_BODY, 'utf-8'))).toBe(true);
  });

  it('ignores case and surrounding whitespace in the message', () => {
    expect(isSessionRejection401(r(401), JSON.stringify({ error: { message: ' authentication FAILED ' } }))).toBe(true);
  });

  it.each([
    ['a relayed LiteLLM 401', LITELLM_BODY],
    ['an empty body', ''],
    ['a body that is not JSON', 'Unauthorized'],
    ['JSON without an error message', JSON.stringify({ detail: 'Authentication failed' })],
    ['a non-string message', JSON.stringify({ error: { message: 401 } })],
    ['JSON null', 'null'],
  ])('is false for a 401 with %s', (_label, body) => {
    expect(isSessionRejection401(r(401), body)).toBe(false);
  });

  it.each([
    ['200', 200],
    ['403', 403],
    ['302', 302],
    ['a missing status', undefined],
  ])('is false for %s even with the session-rejection body', (_label, status) => {
    expect(isSessionRejection401(r(status), SESSION_BODY)).toBe(false);
  });

  describe('encoded bodies', () => {
    const encoded = (encoding: string | string[], body: Buffer) => ({
      statusCode: 401,
      headers: { 'content-encoding': encoding },
      body,
    });
    const raw = Buffer.from(SESSION_BODY, 'utf-8');
    const litellm = Buffer.from(LITELLM_BODY, 'utf-8');

    it.each([
      ['gzip', 'gzip', gzipSync(raw)],
      ['x-gzip', 'x-gzip', gzipSync(raw)],
      ['deflate', 'deflate', deflateSync(raw)],
      ['brotli', 'br', brotliCompressSync(raw)],
      ['an uppercase header value', 'GZIP', gzipSync(raw)],
      ['identity', 'identity', raw],
      ['stacked encodings, undone in reverse', ['gzip', 'br'], brotliCompressSync(gzipSync(raw))],
    ])('is true for a session rejection encoded with %s', (_label, encoding, body) => {
      const { body: payload, ...response } = encoded(encoding, body);
      expect(isSessionRejection401(response, payload)).toBe(true);
    });

    it('is false for a gzip-encoded body that is not the session rejection', () => {
      const { body, ...response } = encoded('gzip', gzipSync(litellm));
      expect(isSessionRejection401(response, body)).toBe(false);
    });

    it.each([
      ['corrupt gzip data', 'gzip', Buffer.from('not gzip data')],
      ['an unsupported encoding', 'zstd-unknown', raw],
      ['a header that does not match the bytes', 'gzip', raw],
      ['a body that expands past the cap', 'gzip', gzipSync(Buffer.alloc(2 * 1024 * 1024, 0x20))],
    ])('is false, without throwing, for %s', (_label, encoding, body) => {
      const { body: payload, ...response } = encoded(encoding, body);
      expect(isSessionRejection401(response, payload)).toBe(false);
    });
  });
});
