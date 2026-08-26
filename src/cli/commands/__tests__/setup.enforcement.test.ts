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
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    getLogFilePath: vi.fn().mockReturnValue(null)
  }
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
    getActiveProfileName: vi.fn().mockResolvedValue('my-profile'),
    getProfile: vi.fn().mockResolvedValue(null)
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

/**
 * Minimal Error subclass matching how `inquirer` labels prompt aborts.
 */
class ExitPromptError extends Error {
  constructor(message = 'User force closed the prompt') {
    super(message);
    this.name = 'ExitPromptError';
  }
}

describe('detectLiteLLMEnforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns enforced:true (with codeMieUrl) when integration exists for selected project', async () => {
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
      // Portal URL (from promptForCodeMieUrl) must be the value carried through,
      // NOT authResult.apiUrl (the REST API base) — regression guard for CR-004.
      expect(result.codeMieUrl).toBe('https://codemie.example.com');
    }
  });

  it('threads the caller-provided existingCodeMieUrl into promptForCodeMieUrl', async () => {
    vi.mocked(authHelpers.promptForCodeMieUrl).mockResolvedValue('https://saved.example.com');
    vi.mocked(authHelpers.authenticateWithCodeMie).mockResolvedValue({
      success: true,
      apiUrl: 'https://saved.example.com/api',
      cookies: { session: 'abc' }
    });
    vi.mocked(authHelpers.selectCodeMieProject).mockResolvedValue({
      project: 'my-project',
      userEmail: 'user@example.com'
    });
    vi.mocked(ssoClient.fetchCodeMieIntegrations).mockResolvedValue([]);

    await setupModule.detectLiteLLMEnforcement('https://saved.example.com');

    expect(vi.mocked(authHelpers.promptForCodeMieUrl)).toHaveBeenCalledWith(
      'https://saved.example.com',
      'CodeMie organization URL (leave blank to skip):',
      false
    );
  });

  it('returns enforced:false immediately when user submits blank URL (skip path) — no SSO call', async () => {
    vi.mocked(authHelpers.promptForCodeMieUrl).mockResolvedValue('');

    const result = await setupModule.detectLiteLLMEnforcement();

    expect(result.enforced).toBe(false);
    expect(vi.mocked(authHelpers.authenticateWithCodeMie)).not.toHaveBeenCalled();
  });

  it('passes allowEmpty:true when no existingCodeMieUrl is provided', async () => {
    vi.mocked(authHelpers.promptForCodeMieUrl).mockResolvedValue('');

    await setupModule.detectLiteLLMEnforcement();

    expect(vi.mocked(authHelpers.promptForCodeMieUrl)).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      true
    );
  });

  it('passes allowEmpty:false when existingCodeMieUrl is provided', async () => {
    vi.mocked(authHelpers.promptForCodeMieUrl).mockResolvedValue('https://saved.example.com');
    vi.mocked(authHelpers.authenticateWithCodeMie).mockResolvedValue({
      success: true,
      apiUrl: 'https://saved.example.com/api',
      cookies: { session: 'abc' }
    });
    vi.mocked(authHelpers.selectCodeMieProject).mockResolvedValue({
      project: 'my-project',
      userEmail: 'user@example.com'
    });
    vi.mocked(ssoClient.fetchCodeMieIntegrations).mockResolvedValue([]);

    await setupModule.detectLiteLLMEnforcement('https://saved.example.com');

    expect(vi.mocked(authHelpers.promptForCodeMieUrl)).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      false
    );
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

  it('returns enforced:false when the only project integration is NOT credential_type=LiteLLM', async () => {
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
    // Same project, but the integration is GitHub — must NOT enforce LiteLLM.
    // Regression guard: removing the `credential_type === 'LiteLLM'` filter must fail this test.
    vi.mocked(ssoClient.fetchCodeMieIntegrations).mockResolvedValue([
      { id: 'gh-1', alias: 'my-github', project_name: 'my-project', credential_type: 'GitHub' }
    ]);

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

  it('re-throws ExitPromptError from promptForCodeMieUrl instead of swallowing it', async () => {
    vi.mocked(authHelpers.promptForCodeMieUrl).mockRejectedValue(new ExitPromptError());

    await expect(setupModule.detectLiteLLMEnforcement()).rejects.toMatchObject({
      name: 'ExitPromptError'
    });
    // Regression guard for CR-005: swallowing Ctrl+C as { enforced: false } would
    // let the user bypass the mandatory integration.
    expect(vi.mocked(authHelpers.authenticateWithCodeMie)).not.toHaveBeenCalled();
  });

  it('re-throws ExitPromptError from selectCodeMieProject as well', async () => {
    vi.mocked(authHelpers.promptForCodeMieUrl).mockResolvedValue('https://codemie.example.com');
    vi.mocked(authHelpers.authenticateWithCodeMie).mockResolvedValue({
      success: true,
      apiUrl: 'https://codemie.example.com/api',
      cookies: { session: 'abc' }
    });
    vi.mocked(authHelpers.selectCodeMieProject).mockRejectedValue(new ExitPromptError());

    await expect(setupModule.detectLiteLLMEnforcement()).rejects.toMatchObject({
      name: 'ExitPromptError'
    });
    expect(vi.mocked(ssoClient.fetchCodeMieIntegrations)).not.toHaveBeenCalled();
  });
});

describe('createSetupCommand — setup wizard wiring', () => {
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
    vi.mocked(ConfigLoader.getProfile).mockResolvedValue(null);

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

  it('auto-selects litellm and passes SetupContext (including codeMieUrl) to getCredentials when enforcement detected', async () => {
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

    // inquirer.prompt sequence: storage → provider → manualModel → profileName
    // (switch skipped: active===profile). The provider prompt now runs BEFORE the
    // gate; picking a CodeMie-backed provider is what admits the gate at all, and
    // enforcement then overrides the choice to litellm.
    vi.mocked(inquirerMod.default.prompt)
      .mockResolvedValueOnce({ storage: 'global' })
      .mockResolvedValueOnce({ provider: 'ai-run-sso' })
      .mockResolvedValueOnce({ manualModel: 'gpt-4-turbo' })
      .mockResolvedValueOnce({ newProfileName: 'my-profile' });

    // Act — drive through the module boundary (createSetupCommand), not a test-only export
    const command = setupModule.createSetupCommand();
    await command.parseAsync([], { from: 'user' });

    // Assert: litellm was selected (ProviderRegistry.getSetupSteps was called with 'litellm')
    expect(ProviderRegistry.getSetupSteps).toHaveBeenCalledWith('litellm');

    // Assert: getCredentials received SetupContext with enforcedIntegration.
    // Explicitly assert codeMieUrl so a regression to authResult.apiUrl (CR-004) is caught here.
    expect(mockGetCredentials).toHaveBeenCalledWith(
      false,
      expect.objectContaining({
        enforcedIntegration: expect.objectContaining({
          alias: 'forced-int',
          codeMieUrl: 'https://codemie.example.com'
        })
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
    const command = setupModule.createSetupCommand();
    await command.parseAsync([], { from: 'user' });

    // Assert: getCredentials called WITHOUT enforcedIntegration context
    expect(mockGetCredentials).toHaveBeenCalledWith(false, undefined);
  });

  it('handles ExitPromptError from the enforcement gate cleanly — no getCredentials call, no raw stack', async () => {
    // Arrange: user hits Ctrl+C during promptForCodeMieUrl inside the gate.
    vi.mocked(authHelpers.promptForCodeMieUrl).mockRejectedValue(new ExitPromptError());

    // Storage and provider prompts resolve normally before the gate runs; the
    // gate only engages because the chosen provider is CodeMie-backed.
    vi.mocked(inquirerMod.default.prompt)
      .mockResolvedValueOnce({ storage: 'global' })
      .mockResolvedValueOnce({ provider: 'ai-run-sso' });

    // Act — must not throw out of the wizard; ExitPromptError should be caught,
    // "Setup cancelled." printed, and the wizard should return.
    const command = setupModule.createSetupCommand();
    await expect(command.parseAsync([], { from: 'user' })).resolves.toBeDefined();

    // Assert: setup did NOT proceed past the enforcement gate.
    expect(mockGetCredentials).not.toHaveBeenCalled();
  });
});
