import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../providers/core/registry.js', () => ({
  ProviderRegistry: {
    registerProvider: vi.fn((template: unknown) => template),
    registerSetupSteps: vi.fn(),
    registerHealthCheck: vi.fn(),
    registerModelProxy: vi.fn(),
    getProvider: vi.fn(),
    getProviderNames: vi.fn(() => []),
  },
}));

vi.mock('../../../../utils/processes.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../utils/processes.js')>(
    '../../../../utils/processes.js'
  );

  return {
    ...actual,
    commandExists: vi.fn(),
    exec: vi.fn(),
    installGlobal: vi.fn(),
  };
});

vi.mock('../../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe('CodexPlugin version support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('declares the supported and minimum supported Codex CLI versions', async () => {
    const { CodexPluginMetadata } = await import('../codex.plugin.js');

    expect(CodexPluginMetadata.supportedVersion).toBe('0.143.0');
    expect(CodexPluginMetadata.minimumSupportedVersion).toBe('0.133.0');
  });

  it('extracts semver from codex --version output before compatibility comparison', async () => {
    const processes = await import('../../../../utils/processes.js');
    vi.mocked(processes.exec).mockResolvedValue({
      code: 0,
      stdout: 'codex-cli 0.144.1\n',
      stderr: '',
    });

    const { CodexPlugin } = await import('../codex.plugin.js');
    const plugin = new CodexPlugin();

    await expect(plugin.getVersion()).resolves.toBe('0.144.1');

    const compat = await plugin.checkVersionCompatibility();
    expect(compat.installedVersion).toBe('0.144.1');
    expect(compat.supportedVersion).toBe('0.143.0');
    expect(compat.minimumSupportedVersion).toBe('0.133.0');
    expect(compat.isNewer).toBe(true);
    expect(compat.compatible).toBe(false);
  });

  it('marks Codex versions below the minimum supported version as below minimum', async () => {
    const processes = await import('../../../../utils/processes.js');
    vi.mocked(processes.exec).mockResolvedValue({
      code: 0,
      stdout: 'codex 0.118.9\n',
      stderr: '',
    });

    const { CodexPlugin } = await import('../codex.plugin.js');
    const plugin = new CodexPlugin();

    const compat = await plugin.checkVersionCompatibility();

    expect(compat.installedVersion).toBe('0.118.9');
    expect(compat.isBelowMinimum).toBe(true);
    expect(compat.minimumSupportedVersion).toBe('0.133.0');
  });

  it('installs the supported Codex CLI version when requested', async () => {
    const processes = await import('../../../../utils/processes.js');
    vi.mocked(processes.installGlobal).mockResolvedValue(undefined);

    const { CodexPlugin } = await import('../codex.plugin.js');
    const plugin = new CodexPlugin();

    await plugin.installVersion('supported');

    expect(processes.installGlobal).toHaveBeenCalledWith('@openai/codex', {
      version: '0.143.0',
    });
  });
  it('passes the direct CodeMie sync API URL to Codex lifecycle hook processing', async () => {
    vi.resetModules();
    const processEvent = vi.fn().mockResolvedValue(undefined);

    vi.doMock('../../../../cli/commands/hook.js', () => ({
      processEvent,
    }));

    const { CodexPluginMetadata } = await import('../codex.plugin.js');

    await CodexPluginMetadata.lifecycle!.onSessionStart!('codemie-session-1', {
      CODEMIE_AGENT: 'codex',
      CODEMIE_PROVIDER: 'ai-run-sso',
      CODEMIE_BASE_URL: 'http://127.0.0.1:49152',
      CODEMIE_SYNC_API_URL: 'https://codemie.example.com/code-assistant-api',
      CODEMIE_URL: 'https://codemie.example.com',
      CODEMIE_CLI_VERSION: '0.1.0',
      CODEMIE_PROFILE_NAME: 'work',
      CODEMIE_PROJECT: 'project-a',
      CODEMIE_MODEL: 'gpt-5.4',
    });

    expect(processEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        hook_event_name: 'SessionStart',
        session_id: 'codemie-session-1',
      }),
      expect.objectContaining({
        agentName: 'codex',
        sessionId: 'codemie-session-1',
        apiBaseUrl: 'http://127.0.0.1:49152',
        syncApiUrl: 'https://codemie.example.com/code-assistant-api',
        ssoUrl: 'https://codemie.example.com',
        clientType: 'codemie-codex',
      })
    );
  });

  it('sets an isolated CODEX_HOME for CodeMie-managed Codex runs', async () => {
    const { CodexPluginMetadata } = await import('../codex.plugin.js');

    const env = await CodexPluginMetadata.lifecycle!.beforeRun!(
      {},
      {
        provider: 'ai-run-sso',
        model: 'gpt-5.5-2026-04-24',
      }
    );

    expect(env.CODEX_HOME).toMatch(/[/\\]\.codex[/\\]codemie[/\\]home$/);
  });

  it('preserves an explicit CODEX_HOME override', async () => {
    const { CodexPluginMetadata } = await import('../codex.plugin.js');

    const env = await CodexPluginMetadata.lifecycle!.beforeRun!(
      { CODEX_HOME: '/tmp/custom-codex-home' },
      {
        provider: 'ai-run-sso',
        model: 'gpt-5.5-2026-04-24',
      }
    );

    expect(env.CODEX_HOME).toBe('/tmp/custom-codex-home');
  });
});
