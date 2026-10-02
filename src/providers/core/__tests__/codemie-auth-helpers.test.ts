import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ConfigurationError } from '../../../utils/errors.js';

// Mock HTTPClient before importing the module under test
const mockGetRaw = vi.fn();
vi.mock('../base/http-client.js', () => ({
  HTTPClient: class {
    getRaw = mockGetRaw;
  },
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: { success: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('inquirer', () => ({
  default: { prompt: vi.fn() },
}));

const mockGetStoredCredentials = vi.fn();
vi.mock('../../plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: class {
    getStoredCredentials = mockGetStoredCredentials;
  },
}));

import {
  ensureApiBase,
  buildAuthHeaders,
  fetchCodeMieUserInfo,
  selectCodeMieProject,
  getPlatformUrl,
  getPlatformUrlCandidates,
  getPlatformUrlFromEnv,
  getPlatformUrlCandidatesFromEnv,
  getStoredPlatformCredentials,
  getStoredPlatformCredentialsFromEnv,
} from '../codemie-auth-helpers.js';

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

describe('fetchCodeMieUserInfo', () => {
  beforeEach(() => {
    mockGetRaw.mockReset();
  });

  it('throws ConfigurationError on 401 response', async () => {
    mockGetRaw.mockResolvedValue({
      statusCode: 401,
      statusMessage: 'Unauthorized',
      data: '',
    });

    await expect(
      fetchCodeMieUserInfo('https://api.example.com', { session: 'abc' })
    ).rejects.toThrow(ConfigurationError);

    await expect(
      fetchCodeMieUserInfo('https://api.example.com', { session: 'abc' })
    ).rejects.toThrow('Authentication failed - invalid or expired credentials');
  });

  it('throws ConfigurationError on 403 response', async () => {
    mockGetRaw.mockResolvedValue({
      statusCode: 403,
      statusMessage: 'Forbidden',
      data: '',
    });

    await expect(
      fetchCodeMieUserInfo('https://api.example.com', 'jwt-token')
    ).rejects.toThrow(ConfigurationError);
  });

  it('throws ConfigurationError on 500 response', async () => {
    mockGetRaw.mockResolvedValue({
      statusCode: 500,
      statusMessage: 'Internal Server Error',
      data: '',
    });

    await expect(
      fetchCodeMieUserInfo('https://api.example.com', { session: 'abc' })
    ).rejects.toThrow(ConfigurationError);

    await expect(
      fetchCodeMieUserInfo('https://api.example.com', { session: 'abc' })
    ).rejects.toThrow('Failed to fetch user info: 500 Internal Server Error');
  });

  it('throws ConfigurationError when response is missing applications arrays', async () => {
    mockGetRaw.mockResolvedValue({
      statusCode: 200,
      statusMessage: 'OK',
      data: JSON.stringify({ userId: '1', name: 'Test', username: 'test' }),
    });

    await expect(
      fetchCodeMieUserInfo('https://api.example.com', { session: 'abc' })
    ).rejects.toThrow(ConfigurationError);

    await expect(
      fetchCodeMieUserInfo('https://api.example.com', { session: 'abc' })
    ).rejects.toThrow('Invalid user info response: missing applications arrays');
  });

  it('normalizes applicationsAdmin to applications_admin', async () => {
    mockGetRaw.mockResolvedValue({
      statusCode: 200,
      statusMessage: 'OK',
      data: JSON.stringify({
        userId: '1',
        name: 'Test',
        username: 'test',
        isAdmin: false,
        applications: ['proj-a'],
        applicationsAdmin: ['proj-b'],
        picture: '',
        knowledgeBases: [],
      }),
    });

    const result = await fetchCodeMieUserInfo('https://api.example.com', { session: 'abc' });
    expect(result.applications_admin).toEqual(['proj-b']);
  });

  it('returns user info on successful response', async () => {
    mockGetRaw.mockResolvedValue({
      statusCode: 200,
      statusMessage: 'OK',
      data: JSON.stringify({
        userId: '1',
        name: 'Test User',
        username: 'tuser',
        isAdmin: false,
        applications: ['project-a', 'project-b'],
        applications_admin: ['project-a'],
        picture: '',
        knowledgeBases: [],
      }),
    });

    const result = await fetchCodeMieUserInfo('https://api.example.com', { session: 'abc' });
    expect(result.userId).toBe('1');
    expect(result.applications).toEqual(['project-a', 'project-b']);
    expect(result.applications_admin).toEqual(['project-a']);
  });
});

describe('selectCodeMieProject', () => {
  beforeEach(() => {
    mockGetRaw.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('throws ConfigurationError when apiUrl is missing', async () => {
    await expect(
      selectCodeMieProject({ cookies: { session: 'abc' } } as any)
    ).rejects.toThrow(ConfigurationError);
  });

  it('throws ConfigurationError when cookies are missing', async () => {
    await expect(
      selectCodeMieProject({ apiUrl: 'https://api.example.com' } as any)
    ).rejects.toThrow(ConfigurationError);
  });

  it('auto-selects single project and prints to console', async () => {
    mockGetRaw.mockResolvedValue({
      statusCode: 200,
      statusMessage: 'OK',
      data: JSON.stringify({
        userId: '1',
        name: 'Test',
        username: 'test',
        isAdmin: false,
        applications: ['only-project'],
        applications_admin: [],
        picture: '',
        knowledgeBases: [],
      }),
    });

    const result = await selectCodeMieProject({
      apiUrl: 'https://api.example.com',
      cookies: { session: 'abc' },
    } as any);

    expect(result).toEqual({ project: 'only-project', userEmail: 'test' });
    // Verify console.log was called (interactive UX feedback)
    expect(console.log).toHaveBeenCalled();
    const logCall = (console.log as any).mock.calls[0][0];
    expect(logCall).toContain('Auto-selected project');
  });

  it('throws ConfigurationError when no projects are found', async () => {
    mockGetRaw.mockResolvedValue({
      statusCode: 200,
      statusMessage: 'OK',
      data: JSON.stringify({
        userId: '1',
        name: 'Test',
        username: 'test',
        isAdmin: false,
        applications: [],
        applications_admin: [],
        picture: '',
        knowledgeBases: [],
      }),
    });

    await expect(
      selectCodeMieProject({
        apiUrl: 'https://api.example.com',
        cookies: { session: 'abc' },
      } as any)
    ).rejects.toThrow('No projects found for your account');
  });

  it('deduplicates projects from applications and applications_admin', async () => {
    mockGetRaw.mockResolvedValue({
      statusCode: 200,
      statusMessage: 'OK',
      data: JSON.stringify({
        userId: '1',
        name: 'Test',
        username: 'test',
        isAdmin: false,
        applications: ['shared-project'],
        applications_admin: ['shared-project'],
        picture: '',
        knowledgeBases: [],
      }),
    });

    const result = await selectCodeMieProject({
      apiUrl: 'https://api.example.com',
      cookies: { session: 'abc' },
    } as any);

    // Only one project after dedup → auto-selected
    expect(result).toEqual({ project: 'shared-project', userEmail: 'test' });
  });
});

describe('platform URL resolution', () => {
  const P = 'https://profile.example.com';
  const W = 'https://workspace.example.com';

  it('returns the profile baseUrl first for ai-run-sso', () => {
    expect(getPlatformUrl({ provider: 'ai-run-sso', baseUrl: P })).toBe(P);
  });

  it('returns [P, W] when both are set on different origins', () => {
    expect(getPlatformUrlCandidates({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W })).toEqual([P, W]);
  });

  it('returns only W when baseUrl is missing', () => {
    expect(getPlatformUrlCandidates({ provider: 'ai-run-sso', codeMieUrl: W })).toEqual([W]);
  });

  it('returns no candidates when neither is set', () => {
    expect(getPlatformUrlCandidates({ provider: 'ai-run-sso' })).toEqual([]);
    expect(getPlatformUrl({ provider: 'ai-run-sso' })).toBeUndefined();
  });

  it('treats bearer-auth like ai-run-sso', () => {
    expect(getPlatformUrlCandidates({ provider: 'bearer-auth', baseUrl: P, codeMieUrl: W })).toEqual([P, W]);
  });

  it.each(['anthropic-subscription', 'moonshot-subscription', 'litellm', undefined])(
    'uses only W for provider %s and ignores baseUrl',
    (provider) => {
      expect(getPlatformUrlCandidates({ provider, baseUrl: 'https://vendor.example.com', codeMieUrl: W })).toEqual([W]);
      expect(getPlatformUrlCandidates({ provider, baseUrl: 'https://vendor.example.com' })).toEqual([]);
    }
  );

  it('dedupes P and W that share an origin', () => {
    expect(
      getPlatformUrlCandidates({
        provider: 'ai-run-sso',
        baseUrl: `${P}/code-assistant-api`,
        codeMieUrl: `${P}/`,
      })
    ).toEqual([`${P}/code-assistant-api`]);
  });
});

describe('platform URL resolution from env', () => {
  const P = 'https://profile.example.com';
  const W = 'https://workspace.example.com';

  it('reads baseUrl from CODEMIE_PROFILE_CONFIG', () => {
    const env = { CODEMIE_PROFILE_CONFIG: JSON.stringify({ provider: 'ai-run-sso', baseUrl: P }) } as NodeJS.ProcessEnv;
    expect(getPlatformUrlFromEnv(env)).toBe(P);
  });

  it('combines profile baseUrl with CODEMIE_URL as fallback', () => {
    const env = {
      CODEMIE_PROFILE_CONFIG: JSON.stringify({ provider: 'ai-run-sso', baseUrl: P }),
      CODEMIE_URL: W,
    } as NodeJS.ProcessEnv;
    expect(getPlatformUrlCandidatesFromEnv(env)).toEqual([P, W]);
  });

  it('falls back to CODEMIE_URL on malformed JSON', () => {
    const env = { CODEMIE_PROFILE_CONFIG: '{not json', CODEMIE_URL: W } as NodeJS.ProcessEnv;
    expect(getPlatformUrlCandidatesFromEnv(env)).toEqual([W]);
  });

  it('falls back to CODEMIE_URL when the profile config is absent', () => {
    expect(getPlatformUrlFromEnv({ CODEMIE_URL: W } as NodeJS.ProcessEnv)).toBe(W);
  });

  it('returns nothing when neither source is present', () => {
    expect(getPlatformUrlFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('ignores the proxy-rewritten CODEMIE_BASE_URL', () => {
    const env = { CODEMIE_BASE_URL: 'http://localhost:4321' } as NodeJS.ProcessEnv;
    expect(getPlatformUrlCandidatesFromEnv(env)).toEqual([]);
  });

  it('ignores baseUrl of a non-CodeMie provider in the profile config', () => {
    const env = {
      CODEMIE_PROFILE_CONFIG: JSON.stringify({ provider: 'anthropic-subscription', baseUrl: 'https://api.anthropic.com' }),
      CODEMIE_URL: W,
    } as NodeJS.ProcessEnv;
    expect(getPlatformUrlCandidatesFromEnv(env)).toEqual([W]);
  });
});

describe('getStoredPlatformCredentials', () => {
  const P = 'https://profile.example.com';
  const W = 'https://workspace.example.com';
  const creds = { cookies: { a: 'b' }, apiUrl: `${P}/code-assistant-api` };

  beforeEach(() => {
    mockGetStoredCredentials.mockReset();
  });

  it('returns credentials found under P with the URL used', async () => {
    mockGetStoredCredentials.mockResolvedValueOnce(creds);
    const result = await getStoredPlatformCredentials({ provider: 'ai-run-sso', baseUrl: P });
    expect(result).toEqual({ credentials: creds, url: P });
    expect(mockGetStoredCredentials).toHaveBeenCalledWith(P);
  });

  it('falls back to W when P misses (split host)', async () => {
    mockGetStoredCredentials.mockResolvedValueOnce(null).mockResolvedValueOnce(creds);
    const result = await getStoredPlatformCredentials({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W });
    expect(result).toEqual({ credentials: creds, url: W });
    expect(mockGetStoredCredentials.mock.calls.map(c => c[0])).toEqual([P, W]);
  });

  it('does not probe W when P hits', async () => {
    mockGetStoredCredentials.mockResolvedValueOnce(creds);
    await getStoredPlatformCredentials({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W });
    expect(mockGetStoredCredentials).toHaveBeenCalledTimes(1);
  });

  it('looks up a shared origin only once', async () => {
    mockGetStoredCredentials.mockResolvedValue(null);
    const result = await getStoredPlatformCredentials({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: `${P}/` });
    expect(result).toBeNull();
    expect(mockGetStoredCredentials).toHaveBeenCalledTimes(1);
  });

  it('returns null without lookup when there are no candidates', async () => {
    const result = await getStoredPlatformCredentials({ provider: 'ai-run-sso' });
    expect(result).toBeNull();
    expect(mockGetStoredCredentials).not.toHaveBeenCalled();
  });

  it('never probes the vendor baseUrl for subscription providers', async () => {
    mockGetStoredCredentials.mockResolvedValue(null);
    await getStoredPlatformCredentials({
      provider: 'anthropic-subscription',
      baseUrl: 'https://api.anthropic.com',
      codeMieUrl: W,
    });
    expect(mockGetStoredCredentials.mock.calls.map(c => c[0])).toEqual([W]);
  });

  it('resolves from env using the profile baseUrl', async () => {
    mockGetStoredCredentials.mockResolvedValueOnce(creds);
    const env = { CODEMIE_PROFILE_CONFIG: JSON.stringify({ provider: 'ai-run-sso', baseUrl: P }) } as NodeJS.ProcessEnv;
    const result = await getStoredPlatformCredentialsFromEnv(env);
    expect(result).toEqual({ credentials: creds, url: P });
  });
});
