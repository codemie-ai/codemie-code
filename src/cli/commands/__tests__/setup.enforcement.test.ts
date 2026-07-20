import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../providers/core/codemie-auth-helpers.js', () => ({
  DEFAULT_CODEMIE_BASE_URL: 'https://codemie.lab.epam.com',
  promptForCodeMieUrl: vi.fn(),
  authenticateWithCodeMie: vi.fn(),
  selectCodeMieProject: vi.fn()
}));

vi.mock('../../../providers/plugins/sso/sso.http-client.js', () => ({
  fetchCodeMieIntegrations: vi.fn()
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), success: vi.fn() }
}));

vi.mock('chalk', () => ({
  default: {
    yellow: (s: string) => s,
    cyan: (s: string) => s,
    dim: (s: string) => s,
    green: (s: string) => s,
    red: (s: string) => s,
    white: (s: string) => s,
    blueBright: (s: string) => s
  }
}));

const authHelpers = await import('../../../providers/core/codemie-auth-helpers.js');
const ssoClient = await import('../../../providers/plugins/sso/sso.http-client.js');
const { detectLiteLLMEnforcement } = await import('../setup.js');

describe('detectLiteLLMEnforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns enforced:true when integration exists for selected project', async () => {
    vi.mocked(authHelpers.promptForCodeMieUrl).mockResolvedValue('https://codemie.example.com');
    vi.mocked(authHelpers.authenticateWithCodeMie).mockResolvedValue({
      success: true,
      apiUrl: 'https://codemie.example.com/api',
      cookies: { session: 'abc' }
    });
    vi.mocked(authHelpers.selectCodeMieProject).mockResolvedValue({
      project: 'my-project',
      userEmail: 'user@example.com'
    });
    vi.mocked(ssoClient.fetchCodeMieIntegrations).mockResolvedValue([
      { id: 'int-1', alias: 'my-integration', project_name: 'my-project', credential_type: 'LiteLLM' }
    ]);

    const result = await detectLiteLLMEnforcement();

    expect(result.enforced).toBe(true);
    if (result.enforced) {
      expect(result.integration.alias).toBe('my-integration');
      expect(result.project).toBe('my-project');
    }
  });

  it('returns enforced:false when no integration exists for the project', async () => {
    vi.mocked(authHelpers.promptForCodeMieUrl).mockResolvedValue('https://codemie.example.com');
    vi.mocked(authHelpers.authenticateWithCodeMie).mockResolvedValue({
      success: true,
      apiUrl: 'https://codemie.example.com/api',
      cookies: { session: 'abc' }
    });
    vi.mocked(authHelpers.selectCodeMieProject).mockResolvedValue({
      project: 'clean-project',
      userEmail: 'user@example.com'
    });
    vi.mocked(ssoClient.fetchCodeMieIntegrations).mockResolvedValue([]);

    const result = await detectLiteLLMEnforcement();

    expect(result.enforced).toBe(false);
  });

  it('returns enforced:false (graceful fallback) when SSO auth fails', async () => {
    vi.mocked(authHelpers.promptForCodeMieUrl).mockResolvedValue('https://codemie.example.com');
    vi.mocked(authHelpers.authenticateWithCodeMie).mockRejectedValue(new Error('Network timeout'));

    const result = await detectLiteLLMEnforcement();

    expect(result.enforced).toBe(false);
  });

  it('returns enforced:false (graceful fallback) when integration fetch throws', async () => {
    vi.mocked(authHelpers.promptForCodeMieUrl).mockResolvedValue('https://codemie.example.com');
    vi.mocked(authHelpers.authenticateWithCodeMie).mockResolvedValue({
      success: true,
      apiUrl: 'https://api.example.com',
      cookies: { session: 'xyz' }
    });
    vi.mocked(authHelpers.selectCodeMieProject).mockResolvedValue({
      project: 'proj',
      userEmail: 'u@example.com'
    });
    vi.mocked(ssoClient.fetchCodeMieIntegrations).mockRejectedValue(new Error('API unavailable'));

    const result = await detectLiteLLMEnforcement();

    expect(result.enforced).toBe(false);
  });

  it('filters integrations by selected project — ignores integrations for other projects', async () => {
    vi.mocked(authHelpers.promptForCodeMieUrl).mockResolvedValue('https://codemie.example.com');
    vi.mocked(authHelpers.authenticateWithCodeMie).mockResolvedValue({
      success: true,
      apiUrl: 'https://api.example.com',
      cookies: { session: 'xyz' }
    });
    vi.mocked(authHelpers.selectCodeMieProject).mockResolvedValue({
      project: 'project-A',
      userEmail: 'u@example.com'
    });
    vi.mocked(ssoClient.fetchCodeMieIntegrations).mockResolvedValue([
      { id: 'int-2', alias: 'other-int', project_name: 'project-B', credential_type: 'LiteLLM' }
    ]);

    const result = await detectLiteLLMEnforcement();

    expect(result.enforced).toBe(false);
  });
});
