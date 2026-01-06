import { describe, it, expect } from 'vitest';
import {
  sanitizeValue,
  sanitizeObject,
  sanitizeCookies,
  sanitizeAuthToken,
  sanitizeLogArgs,
  sanitizeHeaders
} from '../security.js';

describe('sanitize utilities', () => {
  describe('sanitizeValue', () => {
    it('should mask sensitive keys', () => {
      const result = sanitizeValue('sk-1234567890abcdef', 'apiKey');
      expect(result).toContain('[REDACTED]');
      expect(result).not.toBe('sk-1234567890abcdef');
    });

    it('should mask auth tokens', () => {
      const result = sanitizeValue('Bearer abc123xyz789', 'authToken');
      expect(result).toContain('[REDACTED]');
    });

    it('should mask password values', () => {
      const result = sanitizeValue('mySecretPassword123', 'password');
      expect(result).toContain('[REDACTED]');
    });

    it('should not mask non-sensitive keys', () => {
      const result = sanitizeValue('test-value', 'userName');
      expect(result).toBe('test-value');
    });

    it('should detect OpenAI API keys', () => {
      const result = sanitizeValue('sk-1234567890abcdefghij1234567890abcdefghij');
      expect(result).toContain('[REDACTED]');
    });

    it('should detect Anthropic API keys', () => {
      const apiKey = 'sk-ant-' + 'a'.repeat(95);
      const result = sanitizeValue(apiKey);
      expect(result).toContain('[REDACTED]');
    });

    it('should detect JWT tokens', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const result = sanitizeValue(jwt);
      expect(result).toContain('[REDACTED]');
    });

    it('should not mask short strings', () => {
      const result = sanitizeValue('short');
      expect(result).toBe('short');
    });
  });

  describe('sanitizeObject', () => {
    it('should sanitize all sensitive keys in object', () => {
      const obj = {
        apiKey: 'sk-1234567890abcdefghij',
        username: 'john',
        password: 'secret123',
        sessionId: 'abc-def-ghi-jkl'
      };

      const result = sanitizeObject(obj);

      expect(result.apiKey).toContain('[REDACTED]');
      expect(result.username).toBe('john');
      expect(result.password).toContain('[REDACTED]');
      expect(result.sessionId).toBe('abc-def-ghi-jkl'); // Session IDs are not sensitive
    });

    it('should handle nested objects', () => {
      const obj = {
        config: {
          apiKey: 'sk-1234567890abcdefghij',
          timeout: 5000
        },
        name: 'test'
      };

      const result = sanitizeObject(obj);

      expect(result.name).toBe('test');
      expect((result.config as any).timeout).toBe(5000);
      expect((result.config as any).apiKey).toContain('[REDACTED]');
    });

    it('should handle arrays', () => {
      const obj = {
        tokens: ['sk-1234567890abcdefghijklmnop', 'sk-9876543210zyxwvutsrqponmlkjihgfedcba'],
        names: ['alice', 'bob']
      };

      const result = sanitizeObject(obj);

      expect(Array.isArray(result.tokens)).toBe(true);
      expect((result.tokens as any[])[0]).toContain('[REDACTED]');
      expect((result.tokens as any[])[1]).toContain('[REDACTED]');
      expect(result.names).toEqual(['alice', 'bob']);
    });
  });

  describe('sanitizeCookies', () => {
    it('should show cookie count and names but not values', () => {
      const cookies = {
        'session': 'abc123xyz',
        '_oauth_token': 'def456uvw',
        'user_id': '789'
      };

      const result = sanitizeCookies(cookies);

      expect(result).toContain('3 cookie(s)');
      expect(result).toContain('session');
      expect(result).toContain('_oauth_token');
      expect(result).toContain('user_id');
      expect(result).toContain('[values redacted]');
      expect(result).not.toContain('abc123xyz');
      expect(result).not.toContain('def456uvw');
    });

    it('should handle empty cookies', () => {
      const result = sanitizeCookies({});
      expect(result).toBe('none');
    });

    it('should handle undefined cookies', () => {
      const result = sanitizeCookies(undefined);
      expect(result).toBe('none');
    });
  });

  describe('sanitizeAuthToken', () => {
    it('should mask real tokens', () => {
      const token = 'sk-1234567890abcdefghij1234567890';
      const result = sanitizeAuthToken(token);

      expect(result).toContain('sk-12345');
      expect(result).toContain('[');
      expect(result).toContain('chars, redacted]');
      expect(result).not.toContain('1234567890abcdefghij');
    });

    it('should handle sso-authenticated placeholder', () => {
      const result = sanitizeAuthToken('sso-authenticated');
      expect(result).toBe('sso-authenticated (placeholder)');
    });

    it('should handle undefined token', () => {
      const result = sanitizeAuthToken(undefined);
      expect(result).toBe('none');
    });

    it('should handle short tokens', () => {
      const result = sanitizeAuthToken('short');
      expect(result).toBe('[REDACTED]');
    });
  });

  describe('sanitizeLogArgs', () => {
    it('should sanitize multiple arguments', () => {
      const args = [
        'normal string',
        { apiKey: 'sk-1234567890abcdefghijklmnop', name: 'test' },
        'sk-9876543210zyxwvutsrq9876543210'
      ];

      const result = sanitizeLogArgs(...args);

      expect(result[0]).toBe('normal string');
      expect((result[1] as any).name).toBe('test');
      expect((result[1] as any).apiKey).toContain('[REDACTED]');
      expect(result[2]).toContain('[REDACTED]');
    });

    it('should handle mixed types', () => {
      const args = [
        'string',
        123,
        true,
        null,
        { apiKey: 'sk-1234567890abcdefghijklmnop' }
      ];

      const result = sanitizeLogArgs(...args);

      expect(result[0]).toBe('string');
      expect(result[1]).toBe(123);
      expect(result[2]).toBe(true);
      expect(result[3]).toBe(null);
      expect((result[4] as any).apiKey).toContain('[REDACTED]');
    });
  });

  describe('edge cases', () => {
    it('should handle null values', () => {
      const result = sanitizeValue(null);
      expect(result).toBe(null);
    });

    it('should handle undefined values', () => {
      const result = sanitizeValue(undefined);
      expect(result).toBe(undefined);
    });

    it('should handle numbers', () => {
      const result = sanitizeValue(12345);
      expect(result).toBe(12345);
    });

    it('should handle booleans', () => {
      const result = sanitizeValue(true);
      expect(result).toBe(true);
    });

    it('should handle empty strings', () => {
      const result = sanitizeValue('');
      expect(result).toBe('');
    });

    it('should handle empty arrays', () => {
      const result = sanitizeValue([]);
      expect(Array.isArray(result)).toBe(true);
      expect((result as any[]).length).toBe(0);
    });

    it('should handle empty objects', () => {
      const result = sanitizeValue({});
      expect(typeof result).toBe('object');
      expect(Object.keys(result as object).length).toBe(0);
    });
  });

  describe('case-insensitive key matching', () => {
    it('should match API_KEY', () => {
      const result = sanitizeValue('sk-1234567890abcdefghijklmnop', 'API_KEY');
      expect(result).toContain('[REDACTED]');
    });

    it('should match api-key', () => {
      const result = sanitizeValue('sk-1234567890abcdefghijklmnop', 'api-key');
      expect(result).toContain('[REDACTED]');
    });

    it('should match AuthToken', () => {
      const result = sanitizeValue('some-long-secret-token-value-here', 'AuthToken');
      expect(result).toContain('[REDACTED]');
    });

    it('should match PASSWORD', () => {
      const result = sanitizeValue('my-super-secret-password', 'PASSWORD');
      expect(result).toContain('[REDACTED]');
    });
  });

  describe('sanitizeHeaders', () => {
    it('should sanitize cookie header', () => {
      const headers = {
        'cookie': '_oauth_token=abc123; session_id=xyz789; user_pref=dark'
      };

      const result = sanitizeHeaders(headers);

      expect(result.cookie).toContain('3 cookie(s)');
      expect(result.cookie).toContain('_oauth_token');
      expect(result.cookie).toContain('session_id');
      expect(result.cookie).toContain('user_pref');
      expect(result.cookie).toContain('[values redacted]');
      expect(result.cookie).not.toContain('abc123');
      expect(result.cookie).not.toContain('xyz789');
    });

    it('should sanitize set-cookie header (array)', () => {
      const headers = {
        'set-cookie': [
          '__cf_bm=9_jpb...; Path=/; Expires=...',
          '_oauth2_proxy=MTY5...; Path=/; Domain=...',
          'session=abc123; HttpOnly'
        ]
      };

      const result = sanitizeHeaders(headers);

      expect(result['set-cookie']).toContain('Setting 3 cookie(s)');
      expect(result['set-cookie']).toContain('__cf_bm');
      expect(result['set-cookie']).toContain('_oauth2_proxy');
      expect(result['set-cookie']).toContain('session');
      expect(result['set-cookie']).toContain('[values redacted]');
      expect(result['set-cookie']).not.toContain('9_jpb');
      expect(result['set-cookie']).not.toContain('MTY5');
      expect(result['set-cookie']).not.toContain('abc123');
    });

    it('should sanitize set-cookie header (string)', () => {
      const headers = {
        'set-cookie': '__cf_bm=9_jpb...; Path=/'
      };

      const result = sanitizeHeaders(headers);

      expect(result['set-cookie']).toContain('Setting cookie');
      expect(result['set-cookie']).toContain('__cf_bm');
      expect(result['set-cookie']).toContain('[value redacted]');
      expect(result['set-cookie']).not.toContain('9_jpb');
    });

    it('should sanitize authorization header', () => {
      const headers = {
        'authorization': 'Bearer sk-1234567890abcdefghijklmnop'
      };

      const result = sanitizeHeaders(headers);

      expect(result.authorization).toBe('Bearer [token redacted]');
    });

    it('should handle case-insensitive header names', () => {
      const headers = {
        'Cookie': '_oauth_token=abc123',
        'Authorization': 'Bearer token123',
        'Set-Cookie': 'session=xyz'
      };

      const result = sanitizeHeaders(headers);

      expect(result.Cookie).toContain('[values redacted]');
      expect(result.Authorization).toContain('[token redacted]');
      expect(result['Set-Cookie']).toContain('[value redacted]');
    });

    it('should pass through non-sensitive headers', () => {
      const headers = {
        'content-type': 'application/json',
        'user-agent': 'CodeMie/1.0',
        'x-custom-header': 'value'
      };

      const result = sanitizeHeaders(headers);

      expect(result['content-type']).toBe('application/json');
      expect(result['user-agent']).toBe('CodeMie/1.0');
      expect(result['x-custom-header']).toBe('value');
    });

    it('should handle empty headers', () => {
      const result = sanitizeHeaders({});
      expect(Object.keys(result).length).toBe(0);
    });

    it('should handle undefined headers', () => {
      const result = sanitizeHeaders(undefined);
      expect(Object.keys(result).length).toBe(0);
    });

    it('should sanitize mixed headers', () => {
      const headers = {
        'cookie': '_oauth_token=secret',
        'content-type': 'application/json',
        'authorization': 'Bearer token123',
        'x-request-id': 'req-123'
      };

      const result = sanitizeHeaders(headers);

      expect(result.cookie).toContain('[values redacted]');
      expect(result['content-type']).toBe('application/json');
      expect(result.authorization).toContain('[token redacted]');
      expect(result['x-request-id']).toBe('req-123');
    });
  });
});
