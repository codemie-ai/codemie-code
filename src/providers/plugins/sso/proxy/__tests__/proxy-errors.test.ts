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
    expect(result.code).toBe('INVALID_HEADER_VALUE');
    expect(result.details?.header).toBe('X-CodeMie-Repository');
    expect(result.message).not.toContain('secret');
  });

  it('matches CodeMie header names case-insensitively', () => {
    const result = normalizeError(
      codedError('Invalid value "undefined" for header "x-codemie-branch"', 'ERR_HTTP_INVALID_HEADER_VALUE')
    );
    expect(result).not.toBeInstanceOf(AuthenticationError);
    expect(result.statusCode).toBe(500);
  });

  it('keeps errorCode and header authoritative over caller context and omits the raw value', () => {
    const err = codedError('Invalid value "secret-v" for header "X-CodeMie-Branch"', 'ERR_HTTP_INVALID_HEADER_VALUE');
    const result = normalizeError(err, { errorCode: 'OVERRIDE', header: 'OVERRIDE', url: '/x' });
    expect(result.details?.errorCode).toBe('ERR_HTTP_INVALID_HEADER_VALUE');
    expect(result.details?.header).toBe('X-CodeMie-Branch');
    expect(result.details?.url).toBe('/x');
    expect(JSON.stringify(result.details)).not.toContain('secret-v');
    expect(result.message).not.toContain('secret-v');
  });

  it('maps a Cookie error to AuthenticationError even when X-CodeMie is mentioned unquoted', () => {
    const result = normalizeError(
      codedError('Invalid character in header content ["Cookie"] while sending x-codemie-branch', 'ERR_INVALID_CHAR')
    );
    expect(result).toBeInstanceOf(AuthenticationError);
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
