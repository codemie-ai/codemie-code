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

import { ensureApiBase, buildAuthHeaders, fetchCodeMieUserInfo, selectCodeMieProject } from '../codemie-auth-helpers.js';

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

    expect(result).toBe('only-project');
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
    expect(result).toBe('shared-project');
  });
});
