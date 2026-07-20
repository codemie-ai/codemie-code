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

vi.mock('ora', () => ({
  default: vi.fn().mockReturnValue({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis()
  })
}));

vi.mock('inquirer', () => ({
  default: { prompt: vi.fn() }
}));

vi.mock('../../../providers/index.js', () => ({
  ProviderRegistry: {
    getAllProviders: vi.fn().mockReturnValue([]),
    getSetupSteps: vi.fn(),
    getProvider: vi.fn().mockReturnValue(null)
  }
}));

vi.mock('../../../utils/config.js', () => ({
  ConfigLoader: {
    hasGlobalConfig: vi.fn().mockResolvedValue(false),
    hasLocalConfig: vi.fn().mockResolvedValue(false),
    listProfiles: vi.fn().mockResolvedValue([]),
    saveProfile: vi.fn().mockResolvedValue(undefined),
    saveUserEmail: vi.fn().mockResolvedValue(undefined),
    getActiveProfileName: vi.fn().mockResolvedValue('my-profile')
  }
}));

vi.mock('../../../providers/integration/setup-ui.js', () => ({
  getAllProviderChoices: vi.fn().mockReturnValue([{ name: 'LiteLLM', value: 'litellm' }]),
  displaySetupSuccess: vi.fn(),
  displaySetupError: vi.fn(),
  getAllModelChoices: vi.fn().mockReturnValue([{ name: 'gpt-4-turbo', value: 'gpt-4-turbo' }]),
  displaySetupInstructions: vi.fn()
}));

vi.mock('../../../agents/registry.js', () => ({
  AgentRegistry: { getAgent: vi.fn().mockReturnValue(null) }
}));

vi.mock('../../first-time.js', () => ({
  FirstTimeExperience: { showEcosystemIntro: vi.fn() }
}));

const authHelpers = await import('../../../providers/core/codemie-auth-helpers.js');
const ssoClient = await import('../../../providers/plugins/sso/sso.http-client.js');
const inquirerMod = await import('inquirer');
const { ProviderRegistry } = await import('../../../providers/index.js');
const { ConfigLoader } = await import('../../../utils/config.js');
const setupModule = await import('../setup.js');

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

    const result = await setupModule.detectLiteLLMEnforcement();

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

    const result = await setupModule.detectLiteLLMEnforcement();

    expect(result.enforced).toBe(false);
  });

  it('returns enforced:false (graceful fallback) when SSO auth fails', async () => {
    vi.mocked(authHelpers.promptForCodeMieUrl).mockResolvedValue('https://codemie.example.com');
    vi.mocked(authHelpers.authenticateWithCodeMie).mockRejectedValue(new Error('Network timeout'));

    const result = await setupModule.detectLiteLLMEnforcement();

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

    const result = await setupModule.detectLiteLLMEnforcement();

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

    const result = await setupModule.detectLiteLLMEnforcement();

    expect(result.enforced).toBe(false);
  });
});

describe('runSetupWizardForTest wiring', () => {
  const mockGetCredentials = vi.fn();
  const mockFetchModels = vi.fn();
  const mockBuildConfig = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(ConfigLoader.hasGlobalConfig).mockResolvedValue(false);
    vi.mocked(ConfigLoader.hasLocalConfig).mockResolvedValue(false);
    vi.mocked(ConfigLoader.listProfiles).mockResolvedValue([]);
    vi.mocked(ConfigLoader.saveProfile).mockResolvedValue(undefined);
    vi.mocked(ConfigLoader.getActiveProfileName).mockResolvedValue('my-profile');

    mockFetchModels.mockResolvedValue([]);
    mockBuildConfig.mockReturnValue({ provider: 'litellm', baseUrl: 'http://litellm', apiKey: 'sk-test' });

    vi.mocked(ProviderRegistry.getSetupSteps).mockReturnValue({
      name: 'litellm',
      getCredentials: mockGetCredentials,
      fetchModels: mockFetchModels,
      buildConfig: mockBuildConfig
    } as any);
    vi.mocked(ProviderRegistry.getProvider).mockReturnValue(null);
    vi.mocked(ProviderRegistry.getAllProviders).mockReturnValue([]);
  });

  it('auto-selects litellm and passes SetupContext to getCredentials when enforcement detected', async () => {
    // Arrange: gate returns enforced
    vi.mocked(authHelpers.promptForCodeMieUrl).mockResolvedValue('https://codemie.example.com');
    vi.mocked(authHelpers.authenticateWithCodeMie).mockResolvedValue({
      success: true,
      apiUrl: 'https://api.example.com',
      cookies: { session: 'abc' }
    });
    vi.mocked(authHelpers.selectCodeMieProject).mockResolvedValue({
      project: 'my-proj',
      userEmail: 'u@x.com'
    });
    vi.mocked(ssoClient.fetchCodeMieIntegrations).mockResolvedValue([
      { id: 'i1', alias: 'forced-int', project_name: 'my-proj', credential_type: 'LiteLLM' }
    ]);
    mockGetCredentials.mockResolvedValue({ baseUrl: 'http://litellm', apiKey: 'sk-enforced' });

    // inquirer.prompt sequence: storage → manualModel → profileName (switch skipped: active===profile)
    vi.mocked(inquirerMod.default.prompt)
      .mockResolvedValueOnce({ storage: 'global' })
      .mockResolvedValueOnce({ manualModel: 'gpt-4-turbo' })
      .mockResolvedValueOnce({ newProfileName: 'my-profile' });

    // Act
    await setupModule.runSetupWizardForTest();

    // Assert: litellm was selected (ProviderRegistry.getSetupSteps was called with 'litellm')
    expect(ProviderRegistry.getSetupSteps).toHaveBeenCalledWith('litellm');

    // Assert: getCredentials received SetupContext with enforcedIntegration
    expect(mockGetCredentials).toHaveBeenCalledWith(
      false,
      expect.objectContaining({
        enforcedIntegration: expect.objectContaining({ alias: 'forced-int' })
      })
    );
  });

  it('uses normal provider prompt and calls getCredentials without enforcement when not enforced', async () => {
    // Arrange: gate returns not-enforced (auth throws → graceful fallback)
    vi.mocked(authHelpers.promptForCodeMieUrl).mockResolvedValue('https://codemie.example.com');
    vi.mocked(authHelpers.authenticateWithCodeMie).mockRejectedValue(new Error('SSO unavailable'));
    mockGetCredentials.mockResolvedValue({ baseUrl: 'http://litellm', apiKey: 'not-required' });

    // inquirer.prompt sequence: storage → provider → manualModel → profileName
    vi.mocked(inquirerMod.default.prompt)
      .mockResolvedValueOnce({ storage: 'global' })
      .mockResolvedValueOnce({ provider: 'litellm' })
      .mockResolvedValueOnce({ manualModel: 'gpt-4-turbo' })
      .mockResolvedValueOnce({ newProfileName: 'my-profile' });

    // Act
    await setupModule.runSetupWizardForTest();

    // Assert: getCredentials called WITHOUT enforcedIntegration context
    expect(mockGetCredentials).toHaveBeenCalledWith(false, undefined);
  });
});
