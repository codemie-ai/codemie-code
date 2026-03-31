import { describe, expect, it } from 'vitest';
import { ensureApiBase, buildAuthHeaders } from '../codemie-auth-helpers.js';

describe('ensureApiBase', () => {
  it('appends /code-assistant-api when missing', () => {
    expect(ensureApiBase('https://codemie.example.com')).toBe(
      'https://codemie.example.com/code-assistant-api'
    );
  });

  it('removes trailing slash before appending suffix', () => {
    expect(ensureApiBase('https://codemie.example.com/')).toBe(
      'https://codemie.example.com/code-assistant-api'
    );
  });

  it('does not double-append when suffix already present', () => {
    expect(ensureApiBase('https://codemie.example.com/code-assistant-api')).toBe(
      'https://codemie.example.com/code-assistant-api'
    );
  });

  it('does not double-append when suffix present with trailing slash', () => {
    expect(ensureApiBase('https://codemie.example.com/code-assistant-api/')).toBe(
      'https://codemie.example.com/code-assistant-api'
    );
  });

  it('handles path prefix before /code-assistant-api', () => {
    const url = 'https://codemie.example.com/prefix/code-assistant-api';
    expect(ensureApiBase(url)).toBe(url);
  });
});

describe('buildAuthHeaders', () => {
  it('builds cookie headers from SSO cookies object', () => {
    const headers = buildAuthHeaders({ session: 'abc', token: 'xyz' });

    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-CodeMie-Client']).toBe('codemie-cli');
    expect(headers.cookie).toBe('session=abc;token=xyz');
    expect(headers.authorization).toBeUndefined();
  });

  it('builds Bearer authorization header from JWT string', () => {
    const headers = buildAuthHeaders('my-jwt-token');

    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-CodeMie-Client']).toBe('codemie-cli');
    expect(headers.authorization).toBe('Bearer my-jwt-token');
    expect(headers.cookie).toBeUndefined();
  });

  it('includes CLI version in User-Agent and X-CodeMie-CLI headers', () => {
    process.env.CODEMIE_CLI_VERSION = '1.2.3';
    const headers = buildAuthHeaders('token');

    expect(headers['User-Agent']).toBe('codemie-cli/1.2.3');
    expect(headers['X-CodeMie-CLI']).toBe('codemie-cli/1.2.3');
    delete process.env.CODEMIE_CLI_VERSION;
  });

  it('falls back to unknown when CODEMIE_CLI_VERSION is not set', () => {
    delete process.env.CODEMIE_CLI_VERSION;
    const headers = buildAuthHeaders('token');

    expect(headers['User-Agent']).toBe('codemie-cli/unknown');
  });
});
