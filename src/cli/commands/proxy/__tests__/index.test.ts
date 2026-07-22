/**
 * Proxy command tests
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../utils/config.js', () => ({
  ConfigLoader: {
    load: vi.fn(),
    listProfiles: vi.fn(),
    getActiveProfileName: vi.fn(),
  },
}));

vi.mock('../../../../providers/index.js', () => ({
  ProviderRegistry: {
    getProvider: vi.fn(),
  },
}));

vi.mock('../daemon-manager.js', () => ({
  checkStatus: vi.fn(),
  readState: vi.fn(),
  spawnDaemon: vi.fn(),
  stopDaemon: vi.fn(),
}));

vi.mock('../health-check.js', () => ({
  checkProxyHealth: vi.fn(),
}));

vi.mock('../connectors/desktop.js', () => ({
  writeDesktopConfig: vi.fn(),
  getDesktopBaseDir: vi.fn().mockReturnValue('/mock/desktop/base'),
  mapCanonicalToDesktop: vi.fn().mockReturnValue([]),
}));

vi.mock('../connectors/vscode.js', () => ({
  writeVsCodeLanguageModelsConfig: vi.fn(),
}));

vi.mock('../connectors/managed-mcp-remote.js', () => ({
  fetchManagedMcpServers: vi.fn().mockResolvedValue([]),
}));

vi.mock('../inspect-desktop.js', () => ({
  printDesktopInspection: vi.fn(),
}));

vi.mock('../../../../providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: vi.fn(),
}));

vi.mock('../../../../cli/commands/skills/setup/sync.js', () => ({
  syncRegisteredSkills: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../cli/commands/skills/setup/sync-plugin.js', () => ({
  syncPluginSkills: vi.fn().mockResolvedValue(undefined),
}));

describe('proxy connect desktop', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit:${code}`);
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('does not spawn the daemon when selected SSO profile has no stored credentials', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { ProviderRegistry } = await import('../../../../providers/index.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'codemie-new',
      provider: 'ai-run-sso',
      baseUrl: 'https://codemie.lab.epam.com/code-assistant-api',
      codeMieUrl: 'https://codemie.lab.epam.com',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(ProviderRegistry.getProvider).mockReturnValue({
      name: 'ai-run-sso',
      authType: 'sso',
    } as ReturnType<typeof ProviderRegistry.getProvider>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return {
      getStoredCredentials: vi.fn().mockResolvedValue(null),
      };
    } as unknown as typeof CodeMieSSO);

    const command = createProxyCommand();
    await expect(
      command.parseAsync(['connect', 'desktop', '--profile', 'codemie-new'], { from: 'user' })
    ).rejects.toThrow('process.exit:1');

    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("No SSO credentials found for profile 'codemie-new'.")
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '  Run: codemie profile login --url https://codemie.lab.epam.com/code-assistant-api'
    );
  });

  it('calls syncRegisteredSkills and syncPluginSkills when starting the daemon', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { ProviderRegistry } = await import('../../../../providers/index.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { syncRegisteredSkills } = await import('../../../../cli/commands/skills/setup/sync.js');
    const { syncPluginSkills } = await import('../../../../cli/commands/skills/setup/sync-plugin.js');
    const { writeDesktopConfig } = await import('../connectors/desktop.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'test-profile',
      provider: 'ai-run-sso',
      baseUrl: 'https://example.com/api',
      codeMieUrl: 'https://example.com',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(ProviderRegistry.getProvider).mockReturnValue({
      name: 'ai-run-sso',
      authType: 'sso',
    } as ReturnType<typeof ProviderRegistry.getProvider>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockResolvedValue({ token: 'tok' }) };
    } as unknown as typeof CodeMieSSO);
    vi.mocked(spawnDaemon).mockResolvedValue({
      url: 'http://localhost:4001',
      profile: 'test-profile',
      port: 4001,
      gatewayKey: 'gk',
      startedAt: new Date().toISOString(),
      telemetryMode: 'claude-desktop',
    } as Awaited<ReturnType<typeof spawnDaemon>>);
    vi.mocked(writeDesktopConfig).mockResolvedValue('/path/to/config');

    const command = createProxyCommand();
    await command.parseAsync(['connect', 'desktop', '--profile', 'test-profile'], { from: 'user' });

    expect(syncRegisteredSkills).toHaveBeenCalledWith('test-profile', process.cwd());
    expect(syncPluginSkills).toHaveBeenCalledOnce();
  });

  it('uses the effective active profile when --profile is omitted', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { ProviderRegistry } = await import('../../../../providers/index.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { writeDesktopConfig } = await import('../connectors/desktop.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'selected-profile',
      provider: 'ai-run-sso',
      baseUrl: 'https://example.com/api',
      codeMieUrl: 'https://example.com',
      model: 'selected-model',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(ProviderRegistry.getProvider).mockReturnValue({
      name: 'ai-run-sso',
      authType: 'sso',
    } as ReturnType<typeof ProviderRegistry.getProvider>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockResolvedValue({ token: 'tok' }) };
    } as unknown as typeof CodeMieSSO);
    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(spawnDaemon).mockResolvedValue({
      url: 'http://localhost:4001',
      profile: 'selected-profile',
      port: 4001,
      gatewayKey: 'gk',
      startedAt: new Date().toISOString(),
      telemetryMode: 'claude-desktop',
    } as Awaited<ReturnType<typeof spawnDaemon>>);
    vi.mocked(writeDesktopConfig).mockResolvedValue('/path/to/config');

    await createProxyCommand().parseAsync(['connect', 'desktop'], { from: 'user' });

    expect(ConfigLoader.load).toHaveBeenCalledWith(process.cwd());
    expect(spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'selected-profile',
    }));
  });
});

describe('proxy start', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit:${code}`);
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('starts a transparent daemon without model configuration', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'default',
      provider: 'ai-run-sso',
      baseUrl: 'https://example.com/api',
      codeMieProject: 'team-project',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockResolvedValue({ token: 'tok' }) };
    } as unknown as typeof CodeMieSSO);
    vi.mocked(spawnDaemon).mockResolvedValue({
      url: 'http://127.0.0.1:4001',
      profile: 'default',
      port: 4001,
      gatewayKey: 'local-key',
      startedAt: new Date().toISOString(),
    });

    await createProxyCommand().parseAsync(['start'], { from: 'user' });

    const options = vi.mocked(spawnDaemon).mock.calls[0][0];
    expect(options).toMatchObject({
      targetUrl: 'https://example.com/api',
      profile: 'default',
      project: 'team-project',
    });
    expect(options).not.toHaveProperty('model');
  });

  it('keeps explicit profile selection', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'custom',
      provider: 'ai-run-sso',
      baseUrl: 'https://custom.example.com/api',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockResolvedValue({ token: 'tok' }) };
    } as unknown as typeof CodeMieSSO);
    vi.mocked(spawnDaemon).mockResolvedValue({
      url: 'http://127.0.0.1:4001',
      profile: 'custom',
      port: 4001,
      gatewayKey: 'local-key',
      startedAt: new Date().toISOString(),
    });

    await createProxyCommand().parseAsync(['start', '--profile', 'custom'], { from: 'user' });

    expect(ConfigLoader.load).toHaveBeenCalledWith(process.cwd(), { name: 'custom' });
  });
});

describe('proxy connect vscode', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit:${code}`);
    });

    const { ProviderRegistry } = await import('../../../../providers/index.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { writeVsCodeLanguageModelsConfig } = await import('../connectors/vscode.js');
    vi.mocked(ProviderRegistry.getProvider).mockReturnValue({
      name: 'ai-run-sso',
      authType: 'sso',
    } as ReturnType<typeof ProviderRegistry.getProvider>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockResolvedValue({ token: 'tok' }) };
    } as unknown as typeof CodeMieSSO);
    vi.mocked(writeVsCodeLanguageModelsConfig).mockResolvedValue({
      configPath: '/mock/chatLanguageModels.json',
      requiresSecretConfiguration: false,
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('uses an explicit profile for daemon context and writes its model into VS Code', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { writeVsCodeLanguageModelsConfig } = await import('../connectors/vscode.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'custom',
      provider: 'ai-run-sso',
      baseUrl: 'https://custom.example.com/api',
      model: 'custom-profile-model',
      codeMieProject: 'team-project',
      codeMieUrl: 'https://custom.example.com',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(spawnDaemon).mockResolvedValue({
      pid: process.pid,
      port: 4001,
      url: 'http://127.0.0.1:4001',
      profile: 'custom',
      gatewayKey: 'local-key',
      provider: 'ai-run-sso',
      targetUrl: 'https://custom.example.com/api',
      project: 'team-project',
      clientType: 'vscode-byok',
      startedAt: new Date().toISOString(),
    });

    await createProxyCommand().parseAsync(
      ['connect', 'vscode', '--profile', 'custom'],
      { from: 'user' }
    );

    expect(ConfigLoader.load).toHaveBeenCalledWith(process.cwd(), { name: 'custom' });
    const daemonOptions = vi.mocked(spawnDaemon).mock.calls[0][0];
    expect(daemonOptions).toMatchObject({
      profile: 'custom',
      project: 'team-project',
      clientType: 'vscode-byok',
    });
    expect(daemonOptions).not.toHaveProperty('model');
    expect(writeVsCodeLanguageModelsConfig).toHaveBeenCalledWith(
      'http://127.0.0.1:4001',
      'custom-profile-model',
      false
    );
  });

  it('reuses a matching daemon when only the profile model changes', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { checkStatus, spawnDaemon, stopDaemon } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    const { writeVsCodeLanguageModelsConfig } = await import('../connectors/vscode.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'custom',
      provider: 'ai-run-sso',
      baseUrl: 'https://custom.example.com/api',
      model: 'new-profile-model',
      codeMieProject: 'team-project',
      codeMieUrl: 'https://custom.example.com',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: {
        pid: process.pid,
        port: 4001,
        url: 'http://127.0.0.1:4001',
        profile: 'custom',
        gatewayKey: 'local-key',
        provider: 'ai-run-sso',
        targetUrl: 'https://custom.example.com/api',
        project: 'team-project',
        clientType: 'vscode-byok',
        startedAt: new Date().toISOString(),
      },
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'deep', code: 'ok' });

    await createProxyCommand().parseAsync(['connect', 'vscode', '--profile', 'custom'], { from: 'user' });

    expect(stopDaemon).not.toHaveBeenCalled();
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(writeVsCodeLanguageModelsConfig).toHaveBeenCalledWith(
      'http://127.0.0.1:4001',
      'new-profile-model',
      false
    );
  });

});

describe('proxy status', () => {
  it('shows client and project context', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { checkStatus } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: {
        pid: process.pid,
        port: 4001,
        url: 'http://127.0.0.1:4001',
        profile: 'work',
        gatewayKey: 'local-key',
        clientType: 'vscode-byok',
        project: 'team-project',
        startedAt: new Date().toISOString(),
      },
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'shallow', code: 'ok' });

    await createProxyCommand().parseAsync(['status'], { from: 'user' });

    expect(consoleLogSpy).toHaveBeenCalledWith('  Client:  vscode-byok');
    expect(consoleLogSpy).toHaveBeenCalledWith('  Project: team-project');
    consoleLogSpy.mockRestore();
  });
});
