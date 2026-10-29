import { describe, it, expect } from 'vitest';
import {
  sanitizeValue,
  sanitizeObject,
  sanitizeCookies,
  sanitizeAuthToken,
  sanitizeLogArgs,
  sanitizeHeaders,
  maskSecretsInText,
  maskSecretsDeep
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
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'; // gitleaks:allow
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
        apiKey: 'sk-1234567890abcdefghij', // gitleaks:allow
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
          apiKey: 'sk-1234567890abcdefghij', // gitleaks:allow
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
        tokens: ['sk-1234567890abcdefghijklmnop', 'sk-9876543210zyxwvutsrqponmlkjihgfedcba'], // gitleaks:allow
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
      const token = 'sk-1234567890abcdefghij1234567890'; // gitleaks:allow
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
        { apiKey: 'sk-1234567890abcdefghijklmnop', name: 'test' }, // gitleaks:allow
        'sk-9876543210zyxwvutsrq9876543210' // gitleaks:allow
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
        { apiKey: 'sk-1234567890abcdefghijklmnop' } // gitleaks:allow
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

describe('maskSecretsInText', () => {
  const R = '[REDACTED]';

  // [class, text with the secret embedded in prose, fragments that must be gone, fragments that must survive]
  const cases: Array<[string, string, string[], string[]]> = [
    ['sk- key', 'use key sk-a1B2c3D4e5F6g7H8i9J0k1L2 for the call', ['a1B2c3D4e5F6'], ['use key ', ' for the call']], // gitleaks:allow
    ['sk-ant key', 'key sk-ant-api03-AbCdEf0123456789_-AbCdEf0123456789 end', ['AbCdEf0123456789'], ['key ', ' end']], // gitleaks:allow
    ['AWS access key', 'creds AKIAIOSFODNN7EXAMPLE here', ['AKIAIOSFODNN7EXAMPLE'], ['creds ', ' here']], // gitleaks:allow
    ['ghp_ token', 'push with ghp_abcdefghijklmnopqrstuvwxyz0123456789 now', ['abcdefghijklmnopqrstuvwxyz0123456789'], ['push with ', ' now']], // gitleaks:allow
    ['gho_ token', 'oauth gho_abcdefghijklmnopqrstuvwxyz0123456789 ok', ['abcdefghijklmnopqrstuvwxyz0123456789'], ['oauth ', ' ok']], // gitleaks:allow
    ['github_pat_ token', 'pat github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz0123456789 done', ['11ABCDEFG0abcdefghijklmnop'], ['pat ', ' done']], // gitleaks:allow
    ['GitLab PAT', 'gl glpat-abcdefghij0123456789 used', ['abcdefghij0123456789'], ['gl ', ' used']], // gitleaks:allow
    ['Slack token', `slack ${['xoxb', '123456789012', 'abcdefABCDEF1234'].join('-')} sent`, ['123456789012-abcdefABCDEF1234'], ['slack ', ' sent']], // gitleaks:allow
    ['JWT', 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk is it', ['eyJhbGciOiJIUzI1NiJ9', 'dBjftJeZ4CVPmB92K27uhbUJU1p1r'], ['jwt ', ' is it']], // gitleaks:allow
    ['Bearer token', 'send Bearer abc123def456ghi789 to api', ['abc123def456ghi789'], ['send ', ' to api']], // gitleaks:allow
    ['PEM block', 'key -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7abc\nzzzz\n-----END RSA PRIVATE KEY----- tail', ['MIIEowIBAAKCAQEA7abc', 'zzzz'], ['key ', ' tail']], // gitleaks:allow
    ['PEM block cut before END', 'key -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC', ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'], ['key ']], // gitleaks:allow
    ['URL credentials', 'clone postgres://admin:s3cr3tPass@db.example.com:5432/app please', ['admin', 's3cr3tPass'], ['clone postgres://', '@db.example.com:5432/app please']], // gitleaks:allow
    ['Authorization line', 'curl\nAuthorization: Basic dXNlcjpwYXNzd29yZA==\nnext', ['dXNlcjpwYXNzd29yZA'], ['curl\nAuthorization: ', '\nnext']], // gitleaks:allow
    ['PASSWORD= assignment', 'run PASSWORD=hunter2xyz ./deploy.sh', ['hunter2xyz'], ['run ', ' ./deploy.sh']], // gitleaks:allow
    ['token: assignment', 'config token: zk39dkq0we ready', ['zk39dkq0we'], ['config ', ' ready']], // gitleaks:allow
    ['dotenv lines', 'A=1\nOPENAI_API_KEY=zxcvbnm98765\nB=2', ['zxcvbnm98765'], ['A=1\n', '\nB=2']], // gitleaks:allow
    ['JSON-style password', 'body {"password": "p@ss w0rd!"} end', ['p@ss w0rd!'], ['body {', ' end']], // gitleaks:allow
    ['Authorization with another scheme', 'req\nAuthorization: Negotiate YIIabcdef123456\nnext', ['YIIabcdef123456'], ['req\nAuthorization: ', '\nnext']], // gitleaks:allow
    ['Authorization AWS4 signature', 'Authorization: AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/iam, Signature=abcdef0123456789\nnext', ['AKIDEXAMPLE', 'abcdef0123456789'], ['\nnext']], // gitleaks:allow
    ['escaped-quote JSON password', 'log {\\"password\\": \\"hunter2xyz\\"} end', ['hunter2xyz'], ['log {', ' end']], // gitleaks:allow
    ['SECRET_KEY assignment', 'export SECRET_KEY=abc123xyzq now', ['abc123xyzq'], ['export ', ' now']], // gitleaks:allow
    ['DB_PASS assignment', 'set DB_PASS=s3cretvalue ok', ['s3cretvalue'], ['set ', ' ok']], // gitleaks:allow
    ['long-named secret', 'MY_SERVICE_INTERNAL_ADMIN_CLIENT_SECRET=abc123xyzq end', ['abc123xyzq'], [' end']], // gitleaks:allow
    ['unquoted value with a separator', 'url?password=ab&cd7efg done', ['cd7efg'], ['url?', ' done']], // gitleaks:allow
    ['space-separated --password flag', 'mysql --password hunter2xyz -h db', ['hunter2xyz'], ['mysql --password ', ' -h db']], // gitleaks:allow
    ['space-separated --api-key flag', 'cli --api-key abcd1234 --verbose', ['abcd1234'], ['cli --api-key ', ' --verbose']], // gitleaks:allow
    ['quoted --token flag', 'cli --token "ab cd 12" --verbose', ['ab cd 12'], ['cli --token ', ' --verbose']], // gitleaks:allow
    ['curl -u login', 'curl -u admin:pass1234 https://x.example', ['admin', 'pass1234'], ['curl -u ', ' https://x.example']], // gitleaks:allow
    ['curl --user login in quotes', 'curl -L --user "admin:pass1234" https://x.example', ['admin', 'pass1234'], ['curl -L --user ', ' https://x.example']], // gitleaks:allow
    ['mysql attached -p password', 'mysql -h db -pSecretPw1 app', ['SecretPw1'], ['mysql -h db -p', ' app']], // gitleaks:allow
    ['Stripe live key', `key ${['sk', 'live', '51H8abcDEFghiJKLmnopQRST'].join('_')} now`, ['51H8abcDEFghiJKLmnopQRST'], ['key ', ' now']], // gitleaks:allow
    ['Stripe restricted key', `key ${['rk', 'test', '51H8abcDEFghiJKLmnopQRST'].join('_')} now`, ['51H8abcDEFghiJKLmnopQRST'], ['key ', ' now']], // gitleaks:allow
    ['Google API key', 'key AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q now', ['A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'], ['key ', ' now']], // gitleaks:allow
    ['Google OAuth token', 'tok ya29.a0AfH6SMBabcdefghijklmnop now', ['a0AfH6SMBabcdefghijklmnop'], ['tok ', ' now']], // gitleaks:allow
    ['npm token', 'npm_abcdefghijklmnopqrstuvwxyz0123456789 end', ['abcdefghijklmnopqrstuvwxyz0123456789'], [' end']], // gitleaks:allow
    ['Hugging Face token', `use ${['hf', 'abcdefghijklmnopqrstuvwxyzABCDEFGH'].join('_')} now`,['abcdefghijklmnopqrstuvwxyzABCDEFGH'], ['use ', ' now']], // gitleaks:allow
    ['letters-only Bearer token', 'send Bearer abcdefghijklmnopqrstuv now', ['abcdefghijklmnopqrstuv'], ['send Bearer ', ' now']], // gitleaks:allow
    ['numeric password', 'password=123456', ['123456'], ['password=']], // gitleaks:allow
    ['pass= value that only starts with digits', 'pass=12ab34 ok', ['12ab34'], ['pass=', ' ok']], // gitleaks:allow
    ['pwd= word value', 'pwd=hunter2 ok', ['hunter2'], [' ok']], // gitleaks:allow
  ];

  // Text that names a secret-like word but holds none: it must come through untouched (AC4).
  const benign = [
    'pass: 12 tests',
    'PWD=/home/x',
    'OLDPWD=C:\\Users\\x',
    'pwd=./build',
    'token: expired',
    'password: required',
    'secret: none',
    'api_key: missing',
    'tokens: 5',
    'Bearer authentication is used',
    'mkdir -p /tmp/x && cp -p a b',
    'mysql -p dbname',
    'mysql -P3306 -h db',
    'docker run -u 1000:1000 img',
    'git push -u origin main',
    'login --token $GH_TOKEN --token-file token.txt',
  ];

  it.each(benign)('leaves benign text unchanged: %s', (text) => {
    expect(maskSecretsInText(text)).toBe(text);
  });

  it.each(cases)('masks %s embedded in prose', (_label, input, gone, kept) => {
    const result = maskSecretsInText(input);
    expect(result).toContain(R);
    for (const fragment of gone) {
      expect(result).not.toContain(fragment);
    }
    for (const fragment of kept) {
      expect(result).toContain(fragment);
    }
  });

  it('masks every secret when several share one string', () => {
    const result = maskSecretsInText('a sk-a1B2c3D4e5F6g7H8i9J0k1L2 b AKIAIOSFODNN7EXAMPLE c'); // gitleaks:allow
    expect(result).toBe(`a ${R} b ${R} c`);
  });

  it('returns a secret-free string unchanged', () => {
    const text = 'Refactor the max_tokens handling in src/index.ts, bearer of news: 42 tasks done';
    expect(maskSecretsInText(text)).toBe(text);
  });

  it('leaves "agentId" JSON untouched', () => {
    const text = '{"agentId":"a1b2c3","status":"completed"}';
    expect(maskSecretsInText(text)).toBe(text);
  });

  it('is idempotent', () => {
    const once = maskSecretsInText('x ghp_abcdefghijklmnopqrstuvwxyz0123456789 y PASSWORD=abc123 z'); // gitleaks:allow
    expect(maskSecretsInText(once)).toBe(once);
  });

  it('handles an empty string', () => {
    expect(maskSecretsInText('')).toBe('');
  });

  it('returns quickly for inputs over 64 KB, including pathological ones', () => {
    const inputs = [
      'x'.repeat(200_000),
      'a-'.repeat(100_000),
      'postgres://a:'.repeat(20_000),
      '-----BEGIN PRIVATE KEY-----'.repeat(5_000),
      'Bearer '.repeat(30_000),
      'password='.repeat(30_000),
      '--token '.repeat(10_000),
      'curl -u '.repeat(10_000),
      'mysql -h '.repeat(10_000),
    ];
    const start = Date.now();
    for (const input of inputs) {
      maskSecretsInText(input);
    }
    expect(Date.now() - start).toBeLessThan(3000);
  });
});

describe('maskSecretsDeep', () => {
  const R = '[REDACTED]';

  it('masks strings nested in arrays and objects', () => {
    const result = maskSecretsDeep({
      list: ['safe', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 end'], // gitleaks:allow
      nested: { cmd: 'export PASSWORD=hunter2xyz' }, // gitleaks:allow
    });
    expect(result).toEqual({
      list: ['safe', `token ${R} end`],
      nested: { cmd: `export PASSWORD=${R}` },
    });
  });

  it('redacts the string, array or object value of a sensitive key', () => {
    const result = maskSecretsDeep({
      password: 'plain', apiKey: 'plain', user: 'bob', secrets: ['a', 'b'], credentials: { user: 'u', pass: 'p' },
    }) as Record<string, unknown>;
    expect(result['password']).toBe(R);
    expect(result['apiKey']).toBe(R);
    expect(result['user']).toBe('bob');
    expect(result['secrets']).toBe(R);
    expect(result['credentials']).toBe(R);
  });

  it('leaves numbers, booleans and null untouched', () => {
    expect(maskSecretsDeep({ n: 42, b: true, z: null, password: 7 })).toEqual({ n: 42, b: true, z: null, password: 7 });
  });

  it('leaves skipKeys entries untouched at the top level only', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'; // gitleaks:allow
    const result = maskSecretsDeep(
      { file_path: `/a/${secret}`, inner: { file_path: `/a/${secret}` } },
      new Set(['file_path']),
    ) as { file_path: string; inner: { file_path: string } };
    expect(result.file_path).toBe(`/a/${secret}`);
    expect(result.inner.file_path).toBe(`/a/${R}`);
  });

  it('does not mutate its input', () => {
    const input = { a: { b: 'PASSWORD=abc123' } }; // gitleaks:allow
    maskSecretsDeep(input);
    expect(input.a.b).toBe('PASSWORD=abc123'); // gitleaks:allow
  });

  it('masks a bare string and passes through non-containers', () => {
    expect(maskSecretsDeep('use Bearer abc123def456ghi789')).toBe(`use Bearer ${R}`); // gitleaks:allow
    expect(maskSecretsDeep(5)).toBe(5);
    expect(maskSecretsDeep(undefined)).toBeUndefined();
  });
});
