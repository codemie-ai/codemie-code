import { describe, it, expect } from 'vitest';
import { normalizeError, AuthenticationError, ProxyError } from '../proxy-errors.js';

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('normalizeError header errors', () => {
  it('does not map invalid X-CodeMie header characters to AuthenticationError', () => {
    const msg = 'Invalid character in header content ["X-CodeMie-Repository"]';
    const result = normalizeError(codedError(msg, 'ERR_INVALID_CHAR'));
    expect(result).toBeInstanceOf(ProxyError);
    expect(result).not.toBeInstanceOf(AuthenticationError);
    expect(result.statusCode).toBe(500);
    expect(result.details?.originalError).toBe(msg);
  });

  it('matches CodeMie header names case-insensitively', () => {
    const result = normalizeError(
      codedError('Invalid value for header "x-codemie-branch"', 'ERR_HTTP_INVALID_HEADER_VALUE')
    );
    expect(result).not.toBeInstanceOf(AuthenticationError);
    expect(result.statusCode).toBe(500);
  });

  it('still maps invalid Cookie header content to AuthenticationError', () => {
    const result = normalizeError(
      codedError('Invalid character in header content ["Cookie"]', 'ERR_INVALID_CHAR')
    );
    expect(result).toBeInstanceOf(AuthenticationError);
  });

  it('still maps cookie-related messages to AuthenticationError', () => {
    expect(normalizeError(new Error('bad cookie value'))).toBeInstanceOf(AuthenticationError);
  });

  it('passes an existing ProxyError through unchanged', () => {
    const original = new ProxyError('boom', 418, 'TEAPOT');
    expect(normalizeError(original)).toBe(original);
  });

  it('keeps the TLS mapping for certificate errors', () => {
    const result = normalizeError(codedError('x', 'CERT_HAS_EXPIRED'));
    expect(result.statusCode).toBe(502);
    expect(result.code).toBe('UPSTREAM_ERROR');
  });
});
