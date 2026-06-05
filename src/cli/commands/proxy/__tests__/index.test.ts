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

vi.mock('../connectors/desktop.js', () => ({
  writeDesktopConfig: vi.fn(),
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

  it('calls syncRegisteredSkills and syncPluginSkills after credentials are verified', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { syncRegisteredSkills } = await import('../../../../cli/commands/skills/setup/sync.js');
    const { syncPluginSkills } = await import('../../../../cli/commands/skills/setup/sync-plugin.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'test-profile',
      provider: 'ai-run-sso',
      baseUrl: 'https://example.com/api',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockResolvedValue({ token: 'tok' }) };
    } as unknown as typeof CodeMieSSO);
    vi.mocked(spawnDaemon).mockResolvedValue({
      url: 'http://localhost:4001',
      profile: 'test-profile',
      port: 4001,
      startedAt: new Date().toISOString(),
    } as Awaited<ReturnType<typeof spawnDaemon>>);

    const command = createProxyCommand();
    await command.parseAsync(['start'], { from: 'user' });

    expect(syncRegisteredSkills).toHaveBeenCalledWith('test-profile', process.cwd());
    expect(syncPluginSkills).toHaveBeenCalledOnce();
  });
});
