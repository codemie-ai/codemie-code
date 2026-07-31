import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../config-redaction.js';

describe('redactSecrets', () => {
  it('masks top-level keys matching apiKey/token/secret/authorization (case-insensitive)', () => {
    const input = {
      apiKey: 'proxy-handled',
      ApiKey: 'another-value',
      token: 'abc123',
      secret: 'shh',
      Authorization: 'Bearer xyz',
      model: 'gpt-5',
    };

    expect(redactSecrets(input)).toEqual({
      apiKey: '***REDACTED***',
      ApiKey: '***REDACTED***',
      token: '***REDACTED***',
      secret: '***REDACTED***',
      Authorization: '***REDACTED***',
      model: 'gpt-5',
    });
  });

  it('masks matching keys nested inside a headers object without touching sibling keys', () => {
    const input = {
      provider: {
        'codemie-proxy': {
          options: {
            baseURL: 'https://example.invalid/',
            apiKey: 'proxy-handled',
            headers: { Authorization: 'Bearer real-token', 'X-Trace-Id': 'trace-1' },
          },
        },
      },
    };

    expect(redactSecrets(input)).toEqual({
      provider: {
        'codemie-proxy': {
          options: {
            baseURL: 'https://example.invalid/',
            apiKey: '***REDACTED***',
            headers: { Authorization: '***REDACTED***', 'X-Trace-Id': 'trace-1' },
          },
        },
      },
    });
  });

  it('recurses into arrays without mutating the input', () => {
    const input = [{ apiKey: 'a' }, { apiKey: 'b' }];
    const result = redactSecrets(input);
    expect(result).toEqual([{ apiKey: '***REDACTED***' }, { apiKey: '***REDACTED***' }]);
    expect(input).toEqual([{ apiKey: 'a' }, { apiKey: 'b' }]); // original untouched
  });

  it('masks hyphenated header-style keys and other common secret-key spellings', () => {
    const input = {
      'x-api-key': 'sk-real-value',
      password: 'p@ss',
      privateKey: 'priv',
      credentials: 'creds',
      'X-Trace-Id': 'trace-1',
    };

    expect(redactSecrets(input)).toEqual({
      'x-api-key': '***REDACTED***',
      password: '***REDACTED***',
      privateKey: '***REDACTED***',
      credentials: '***REDACTED***',
      'X-Trace-Id': 'trace-1',
    });
  });

  it('passes through primitives unchanged', () => {
    expect(redactSecrets('hello')).toBe('hello');
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets(undefined)).toBe(undefined);
  });
});
