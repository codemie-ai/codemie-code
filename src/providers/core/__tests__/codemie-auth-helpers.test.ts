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

// In-memory CredentialStore: records keyed by the URL they were stored under; every per-URL read is logged.
const { cookieRecords, jwtRecords, lookups } = vi.hoisted(() => ({
  cookieRecords: new Map<string, unknown>(),
  jwtRecords: new Map<string, unknown>(),
  lookups: [] as Array<{ slot: 'cookie' | 'jwt'; url: string }>,
}));
vi.mock('../../../utils/security.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/security.js')>()),
  CredentialStore: {
    getInstance: () => ({
      retrieveSSOCredentials: async (url?: string) => {
        if (url) lookups.push({ slot: 'cookie', url });
        return url ? (cookieRecords.get(url) ?? null) : null;
      },
      retrieveJWTCredentials: async (url?: string) => {
        if (url) lookups.push({ slot: 'jwt', url });
        return url ? (jwtRecords.get(url) ?? null) : null;
      },
      clearSSOCredentials: async (url?: string) => {
        if (url) cookieRecords.delete(url);
      },
      clearJWTCredentials: async (url?: string) => {
        if (url) jwtRecords.delete(url);
      },
    }),
  },
}));

const cookieLookups = (): string[] => lookups.filter((l) => l.slot === 'cookie').map((l) => l.url);
const jwtLookups = (): string[] => lookups.filter((l) => l.slot === 'jwt').map((l) => l.url);
function resetStore(): void {
  cookieRecords.clear();
  jwtRecords.clear();
  lookups.length = 0;
}

import {
  codeMieUrlFromApiBase,
  ensureApiBase,
  buildAuthHeaders,
  fetchCodeMieUserInfo,
  selectCodeMieProject,
  getPlatformUrl,
  getPlatformUrlCandidates,
  getPlatformUrlFromEnv,
  getPlatformUrlCandidatesFromEnv,
  resolveProjectListAuth,
} from '../codemie-auth-helpers.js';
import {
  resolveSSOAuth,
  resolveSSOAuthFromEnv,
  resolveAnalyticsSSOAuth,
  explicitJwtAuth,
} from '../../plugins/sso/auth/index.js';
import { toSSOAuth } from '../../plugins/sso/auth/selection.js';

/** A cookie login as the resolver would hand it out. */
const cookieAuth = (cookies: Record<string, string>, apiUrl: string) =>
  toSSOAuth({ type: 'cookie', record: { cookies, apiUrl } }, apiUrl);

describe('codeMieUrlFromApiBase', () => {
  it('is the inverse of ensureApiBase', () => {
    for (const url of ['https://codemie.example.com', 'https://h.example:8443/x']) {
      expect(codeMieUrlFromApiBase(ensureApiBase(url))).toBe(url);
    }
  });

  it('drops a trailing slash and any path after the API suffix', () => {
    expect(codeMieUrlFromApiBase('https://h.example/code-assistant-api/')).toBe('https://h.example');
    expect(codeMieUrlFromApiBase('https://h.example/code-assistant-api/v1')).toBe('https://h.example');
  });

  it('leaves a local dev URL without the suffix unchanged', () => {
    expect(codeMieUrlFromApiBase('http://localhost:8080')).toBe('http://localhost:8080');
  });
});

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
    expect(headers.cookie).toBe('session=abc; token=xyz');
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
      selectCodeMieProject(cookieAuth({ session: 'abc' }, ''))
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

    const result = await selectCodeMieProject(cookieAuth({ session: 'abc' }, 'https://api.example.com'));

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
      selectCodeMieProject(cookieAuth({ session: 'abc' }, 'https://api.example.com'))
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

    const result = await selectCodeMieProject(cookieAuth({ session: 'abc' }, 'https://api.example.com'));

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


describe('resolveSSOAuth', () => {
  const P = 'https://profile.example.com';
  const W = 'https://workspace.example.com';
  const creds = { cookies: { a: 'b' }, apiUrl: `${P}/code-assistant-api` };
  const jwtCreds = { token: 'jwt-tok', apiUrl: `${W}/code-assistant-api` };

  beforeEach(resetStore);

  it('returns credentials found under P with the URL used', async () => {
    cookieRecords.set(P, creds);
    const result = await resolveSSOAuth({ provider: 'ai-run-sso', baseUrl: P });
    expect(result).toMatchObject({ type: 'cookie', cookies: creds.cookies, apiUrl: creds.apiUrl, url: P });
    expect(cookieLookups()).toEqual([P]);
  });

  it('falls back to W when P misses (split host)', async () => {
    cookieRecords.set(W, { ...creds, apiUrl: `${P}/code-assistant-api` });
    const result = await resolveSSOAuth({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W });
    expect(result).toMatchObject({ type: 'cookie', cookies: creds.cookies, url: W });
    expect(cookieLookups()).toEqual([P, W]);
  });

  it('does not probe W when P hits', async () => {
    cookieRecords.set(P, creds);
    await resolveSSOAuth({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W });
    expect(cookieLookups()).toEqual([P]);
  });

  it('looks up a shared origin only once', async () => {
    const result = await resolveSSOAuth({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: `${P}/` });
    expect(result).toBeNull();
    expect(cookieLookups()).toHaveLength(1);
  });

  it('returns null without lookup when there are no candidates', async () => {
    const result = await resolveSSOAuth({ provider: 'ai-run-sso' });
    expect(result).toBeNull();
    expect(cookieLookups()).toEqual([]);
  });

  it('never probes the vendor baseUrl for subscription providers', async () => {
    await resolveSSOAuth({
      provider: 'anthropic-subscription',
      baseUrl: 'https://api.anthropic.com',
      codeMieUrl: W,
    });
    expect(cookieLookups()).toEqual([W]);
  });

  it('resolves from env using the profile baseUrl', async () => {
    cookieRecords.set(P, creds);
    const env = { CODEMIE_PROFILE_CONFIG: JSON.stringify({ provider: 'ai-run-sso', baseUrl: P }) } as NodeJS.ProcessEnv;
    const result = await resolveSSOAuthFromEnv(env);
    expect(result).toMatchObject({ type: 'cookie', cookies: creds.cookies, url: P });
  });

  describe('JWT fallback (cookie-stripping reverse proxy)', () => {
    it('returns usable SSO cookies without probing the JWT slot', async () => {
      cookieRecords.set(P, creds);
      const result = await resolveSSOAuth({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W });
      expect(result).toMatchObject({ type: 'cookie', url: P });
      expect(jwtLookups()).toEqual([P]);
    });

    it('falls back to a JWT across the URL candidates when no SSO session exists', async () => {
      // Stored under the workspace URL but issued for the profile host (split host).
      jwtRecords.set(W, { token: 'jwt-tok', apiUrl: `${P}/code-assistant-api` });
      const result = await resolveSSOAuth({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W });
      expect(result).toMatchObject({ type: 'jwt', token: 'jwt-tok', url: W, apiUrl: `${P}/code-assistant-api` });
      expect(jwtLookups()).toEqual([P, W]);
    });

    // Deliberate behaviour change (plan, "Behaviour changes" 1): a JWT now gets the profile-origin filter.
    it('ignores a JWT issued for another host than the profile', async () => {
      jwtRecords.set(W, jwtCreds);
      expect(await resolveSSOAuth({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W })).toBeNull();
    });

    it('treats a stored SSO record with empty or unusable cookies as absent and uses the JWT', async () => {
      cookieRecords.set(P, { cookies: { 'bad\nname': 'x' }, apiUrl: P });
      jwtRecords.set(P, { token: 'jwt-tok', apiUrl: P });
      const result = await resolveSSOAuth({ provider: 'ai-run-sso', baseUrl: P });
      expect(result).toMatchObject({ type: 'jwt', token: 'jwt-tok', url: P });
    });

    it('treats a stored SSO record without a cookies field as absent instead of throwing', async () => {
      cookieRecords.set(P, { apiUrl: P });
      jwtRecords.set(P, { token: 'jwt-tok', apiUrl: P });
      const result = await resolveSSOAuth({ provider: 'ai-run-sso', baseUrl: P });
      expect(result).toMatchObject({ type: 'jwt', token: 'jwt-tok', url: P });
    });

    it('returns null when neither cookies nor a JWT are stored', async () => {
      expect(await resolveSSOAuth({ provider: 'ai-run-sso', baseUrl: P, codeMieUrl: W })).toBeNull();
    });

    it('resolves a JWT from env using the profile baseUrl', async () => {
      jwtRecords.set(P, { token: 'jwt-tok', apiUrl: `${P}/code-assistant-api` });
      const env = { CODEMIE_PROFILE_CONFIG: JSON.stringify({ provider: 'ai-run-sso', baseUrl: P }) } as NodeJS.ProcessEnv;
      expect(await resolveSSOAuthFromEnv(env)).toMatchObject({ type: 'jwt', token: 'jwt-tok', url: P });
    });
  });
});

describe('resolveAnalyticsSSOAuth', () => {
  const P = 'https://prod.example.com';
  const W = 'https://preview.example.com';
  const prodCreds = { cookies: { a: 'prod' }, apiUrl: `${P}/code-assistant-api` };
  const previewCreds = { cookies: { a: 'preview' }, apiUrl: `${W}/code-assistant-api` };
  const profileEnv = (provider = 'ai-run-sso') =>
    ({ CODEMIE_PROFILE_CONFIG: JSON.stringify({ provider, baseUrl: P }) }) as NodeJS.ProcessEnv;

  beforeEach(resetStore);

  it('uses the profile login without touching the workspace login', async () => {
    cookieRecords.set(P, prodCreds);
    const result = await resolveAnalyticsSSOAuth(W, profileEnv());
    expect(result).toMatchObject({ type: 'cookie', cookies: prodCreds.cookies, url: P });
    expect(cookieLookups()).toEqual([P]);
  });

  it('does not borrow another environment\'s workspace login for the profile', async () => {
    cookieRecords.set(W, previewCreds);
    const result = await resolveAnalyticsSSOAuth(W, profileEnv());
    expect(result).toBeNull();
  });

  it('accepts a workspace-stored login issued for the profile host (split host)', async () => {
    cookieRecords.set(W, prodCreds);
    const result = await resolveAnalyticsSSOAuth(W, profileEnv());
    expect(result).toMatchObject({ type: 'cookie', cookies: prodCreds.cookies, url: W });
  });

  it('prefers explicit provider/baseUrl over the env', async () => {
    cookieRecords.set(P, prodCreds);
    const result = await resolveAnalyticsSSOAuth(W, {} as NodeJS.ProcessEnv, {
      provider: 'ai-run-sso',
      baseUrl: P,
    });
    expect(result?.url).toBe(P);
  });

  it('stays workspace-only for non-CodeMie providers', async () => {
    cookieRecords.set(W, previewCreds);
    const result = await resolveAnalyticsSSOAuth(W, profileEnv('anthropic-subscription'));
    expect(result).toMatchObject({ type: 'cookie', cookies: previewCreds.cookies, url: W });
    expect(cookieLookups()).toEqual([W]);
  });

  it('falls back to a JWT stored for the profile host', async () => {
    jwtRecords.set(P, { token: 'jwt-tok', apiUrl: `${P}/code-assistant-api` });
    const result = await resolveAnalyticsSSOAuth(W, profileEnv());
    expect(result).toMatchObject({ type: 'jwt', token: 'jwt-tok', url: P });
  });
});

describe('resolveProjectListAuth — credential host rule (EPMCDME-15411)', () => {
  beforeEach(resetStore);

  it('ai-run-sso: uses only the profile baseUrl credential, never the shared URL', async () => {
    cookieRecords.set('https://b.example.com', { cookies: { s: 'b' }, apiUrl: 'https://b.example.com' });
    const auth = await resolveProjectListAuth({
      provider: 'ai-run-sso',
      baseUrl: 'https://a.example.com/code-assistant-api',
      codeMieUrl: 'https://b.example.com',
    });
    expect(auth).toBeUndefined();
    expect(cookieLookups().every((url) => url.startsWith('https://a.example.com'))).toBe(true);
  });

  it('ai-run-sso: sends the profile cookies to the profile API host', async () => {
    cookieRecords.set('https://a.example.com/code-assistant-api', {
      cookies: { s: 'a' },
      apiUrl: 'https://a.example.com/code-assistant-api',
    });
    const auth = await resolveProjectListAuth({ provider: 'ai-run-sso', baseUrl: 'https://a.example.com/code-assistant-api' });
    expect(auth).toMatchObject({ type: 'cookie', apiUrl: 'https://a.example.com/code-assistant-api', cookies: { s: 'a' } });
  });

  it('ai-run-sso: lists with the stored JWT when no SSO cookies exist', async () => {
    jwtRecords.set('https://a.example.com/code-assistant-api', {
      token: 'jwt-tok',
      apiUrl: 'https://a.example.com/code-assistant-api',
    });
    const auth = await resolveProjectListAuth({ provider: 'ai-run-sso', baseUrl: 'https://a.example.com/code-assistant-api' });
    expect(auth).toMatchObject({ type: 'jwt', apiUrl: 'https://a.example.com/code-assistant-api', token: 'jwt-tok' });
  });

  it('AC11: a JWT profile on host A with a shared URL on host B targets A only', async () => {
    const auth = await resolveProjectListAuth({
      provider: 'bearer-auth',
      baseUrl: 'https://a.example.com',
      codeMieUrl: 'https://b.example.com',
      jwtToken: 'tok',
    });
    expect(auth).toMatchObject({
      type: 'jwt',
      apiUrl: 'https://a.example.com/code-assistant-api',
      token: 'tok',
      source: 'explicit',
    });
    expect(cookieLookups()).toEqual([]);
    expect(jwtLookups()).toEqual([]);
  });

  it('JWT without a token has no list auth', async () => {
    expect(await resolveProjectListAuth({ provider: 'bearer-auth', baseUrl: 'https://a.example.com' })).toBeUndefined();
  });

  it('subscription: uses stored credentials for the resolved CodeMie URL, never the vendor baseUrl', async () => {
    cookieRecords.set('https://codemie.example.com', {
      cookies: { s: 'c' },
      apiUrl: 'https://codemie.example.com/code-assistant-api',
    });
    const auth = await resolveProjectListAuth({
      provider: 'anthropic-subscription',
      baseUrl: 'https://api.anthropic.com',
      codeMieUrl: 'https://codemie.example.com',
    });
    expect(cookieLookups()).toEqual(['https://codemie.example.com']);
    expect(auth).toMatchObject({ type: 'cookie', apiUrl: 'https://codemie.example.com/code-assistant-api', cookies: { s: 'c' } });
  });

  it('subscription: lists with the JWT stored for the CodeMie URL', async () => {
    jwtRecords.set('https://codemie.example.com', { token: 'jwt-tok', apiUrl: '' });
    const auth = await resolveProjectListAuth({
      provider: 'anthropic-subscription',
      baseUrl: 'https://api.anthropic.com',
      codeMieUrl: 'https://codemie.example.com',
    });
    expect(jwtLookups()).toEqual(['https://codemie.example.com']);
    expect(auth).toMatchObject({ type: 'jwt', apiUrl: 'https://codemie.example.com/code-assistant-api', token: 'jwt-tok' });
  });

  it('subscription without a CodeMie URL or stored login has no list auth', async () => {
    expect(await resolveProjectListAuth({ provider: 'anthropic-subscription', baseUrl: 'https://api.anthropic.com' })).toBeUndefined();
    expect(await resolveProjectListAuth({ provider: 'moonshot-subscription', codeMieUrl: 'https://c.example.com' })).toBeUndefined();
  });
});

describe('selectCodeMieProject — bearer token (JWT setup, AC11)', () => {
  beforeEach(() => {
    mockGetRaw.mockReset();
  });

  it('lists projects with the bearer token and sends no cookie', async () => {
    mockGetRaw.mockResolvedValue({
      statusCode: 200,
      data: JSON.stringify({ username: 'u@example.com', applications: ['only'], applications_admin: [] }),
    });
    const result = await selectCodeMieProject(explicitJwtAuth('tok', 'https://a.example.com/code-assistant-api'));
    expect(result).toEqual({ project: 'only', userEmail: 'u@example.com' });
    const [url, headers] = mockGetRaw.mock.calls[0] as [string, Record<string, string>];
    expect(url).toBe('https://a.example.com/code-assistant-api/v1/user');
    expect(headers.Authorization ?? headers.authorization).toBe('Bearer tok');
    expect(headers.cookie ?? headers.Cookie).toBeUndefined();
  });

  it('lists projects with the bearer token of an SSO login that yielded a JWT', async () => {
    mockGetRaw.mockResolvedValue({
      statusCode: 200,
      data: JSON.stringify({ username: 'u@example.com', applications: ['only'], applications_admin: [] }),
    });
    const auth = toSSOAuth(
      { type: 'jwt', record: { token: 'sso-jwt', apiUrl: 'https://a.example.com/code-assistant-api' } },
      'https://a.example.com',
    );
    const result = await selectCodeMieProject(auth);
    expect(result).toEqual({ project: 'only', userEmail: 'u@example.com' });
    const [, headers] = mockGetRaw.mock.calls[0] as [string, Record<string, string>];
    expect(headers.Authorization ?? headers.authorization).toBe('Bearer sso-jwt');
    expect(headers.cookie ?? headers.Cookie).toBeUndefined();
  });
});
