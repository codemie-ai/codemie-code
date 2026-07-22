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
    expect(spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({
      model: undefined,
      enforceProfileModel: false,
      clientType: undefined,
    }));
  });

  it('pins the active profile model and VS Code client type when requested', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'work',
      provider: 'ai-run-sso',
      baseUrl: 'https://example.com/api',
      model: 'gpt-profile',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockResolvedValue({ token: 'tok' }) };
    } as unknown as typeof CodeMieSSO);
    vi.mocked(spawnDaemon).mockResolvedValue({
      url: 'http://127.0.0.1:4001',
      profile: 'work',
      port: 4001,
      gatewayKey: 'local-key',
      model: 'gpt-profile',
      enforceProfileModel: true,
      clientType: 'vscode-byok',
      startedAt: new Date().toISOString(),
    });

    const command = createProxyCommand();
    await command.parseAsync(['start', '--use-profile-model'], { from: 'user' });

    expect(spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'work',
      model: 'gpt-profile',
      enforceProfileModel: true,
      clientType: 'vscode-byok',
    }));
    expect(consoleLogSpy).toHaveBeenCalledWith('  Mode:    profile-model');
  });

  it('loads and pins an explicitly selected profile', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'explicit-work',
      provider: 'ai-run-sso',
      baseUrl: 'https://example.com/api',
      model: 'explicit-model',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockResolvedValue({ token: 'tok' }) };
    } as unknown as typeof CodeMieSSO);
    vi.mocked(spawnDaemon).mockResolvedValue({
      url: 'http://127.0.0.1:4001',
      profile: 'explicit-work',
      port: 4001,
      gatewayKey: 'local-key',
      startedAt: new Date().toISOString(),
    });

    const command = createProxyCommand();
    await command.parseAsync(
      ['start', '--profile', 'explicit-work', '--use-profile-model'],
      { from: 'user' }
    );

    expect(ConfigLoader.load).toHaveBeenCalledWith(process.cwd(), { name: 'explicit-work' });
    expect(spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'explicit-work',
      model: 'explicit-model',
    }));
  });

  it('rejects a missing profile model before checking credentials or spawning', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'no-model',
      provider: 'ai-run-sso',
      baseUrl: 'https://example.com/api',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);

    const command = createProxyCommand();
    await expect(command.parseAsync(['start', '--use-profile-model'], { from: 'user' }))
      .rejects.toThrow('process.exit:1');

    expect(CodeMieSSO).not.toHaveBeenCalled();
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('has no model configured'));
  });

  it('reuses a running daemon only when all effective settings match', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'work',
      provider: 'ai-run-sso',
      baseUrl: 'https://example.com/api',
      model: 'gpt-profile',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: {
        pid: process.pid,
        port: 4001,
        url: 'http://127.0.0.1:4001',
        profile: 'work',
        gatewayKey: 'local-key',
        model: 'gpt-profile',
        enforceProfileModel: true,
        clientType: 'vscode-byok',
        startedAt: new Date().toISOString(),
      },
    });

    const command = createProxyCommand();
    await command.parseAsync(['start', '--use-profile-model'], { from: 'user' });

    expect(CodeMieSSO).not.toHaveBeenCalled();
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
  });

  it.each([
    ['transparent mode', { enforceProfileModel: false, clientType: 'codemie-daemon' }, ['start', '--use-profile-model']],
    ['another profile', { enforceProfileModel: true, clientType: 'vscode-byok', model: 'gpt-profile' }, ['start', '--profile', 'other', '--use-profile-model']],
    ['another port', { enforceProfileModel: true, clientType: 'vscode-byok', model: 'gpt-profile' }, ['start', '--port', '4010', '--use-profile-model']],
  ])('rejects a running daemon configured for %s', async (_label, stateOverrides, args) => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: args.includes('other') ? 'other' : 'work',
      provider: 'ai-run-sso',
      baseUrl: 'https://example.com/api',
      model: 'gpt-profile',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: {
        pid: process.pid,
        port: 4001,
        url: 'http://127.0.0.1:4001',
        profile: 'work',
        gatewayKey: 'local-key',
        startedAt: new Date().toISOString(),
        ...stateOverrides,
      },
    });

    const command = createProxyCommand();
    await expect(command.parseAsync(args, { from: 'user' })).rejects.toThrow('process.exit:1');

    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('codemie proxy stop'));
  });

  it('checks credentials before spawning the daemon', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'work',
      provider: 'ai-run-sso',
      baseUrl: 'https://example.com/api',
      model: 'gpt-profile',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockResolvedValue(null) };
    } as unknown as typeof CodeMieSSO);

    const command = createProxyCommand();
    await expect(command.parseAsync(['start', '--use-profile-model'], { from: 'user' }))
      .rejects.toThrow('process.exit:1');

    expect(spawnDaemon).not.toHaveBeenCalled();
  });
});

describe('proxy status', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('shows profile-model mode, client, and pinned model', async () => {
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
        model: 'gpt-profile',
        enforceProfileModel: true,
        clientType: 'vscode-byok',
        startedAt: new Date().toISOString(),
      },
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({
      healthy: true,
      level: 'shallow',
      code: 'ok',
    });

    await createProxyCommand().parseAsync(['status'], { from: 'user' });

    expect(consoleLogSpy).toHaveBeenCalledWith('  Client:  vscode-byok');
    expect(consoleLogSpy).toHaveBeenCalledWith('  Mode:    profile-model');
    expect(consoleLogSpy).toHaveBeenCalledWith('  Model:   gpt-profile');
  });

  it('shows transparent mode for new transparent daemon state', async () => {
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
        enforceProfileModel: false,
        clientType: 'codemie-daemon',
        startedAt: new Date().toISOString(),
      },
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({
      healthy: true,
      level: 'shallow',
      code: 'ok',
    });

    await createProxyCommand().parseAsync(['status'], { from: 'user' });

    expect(consoleLogSpy).toHaveBeenCalledWith('  Mode:    transparent');
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('Model:'));
  });

  it('omits new fields for an old daemon state file', async () => {
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
        startedAt: new Date().toISOString(),
      },
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({
      healthy: true,
      level: 'shallow',
      code: 'ok',
    });

    await createProxyCommand().parseAsync(['status'], { from: 'user' });

    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('Client:'));
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('Mode:'));
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('Model:'));
  });
});
