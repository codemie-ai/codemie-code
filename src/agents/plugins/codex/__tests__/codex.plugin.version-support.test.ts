import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// Codex is a live-tracked agent (LIVE_TRACKED_AGENT_NAMES), so
// checkVersionCompatibility()/installVersion() resolve `supportedVersion`
// through version-resolution, which hits the npm registry for @openai/codex's
// current `latest` tag. Without this mock, the tests below made a real
// network call and asserted against whatever version npm actually returns,
// so they failed nondeterministically in CI once a newer Codex version
// shipped. The mock echoes back fallbackSupportedVersion (reported as a
// confirmed live value) to pin the tests to CODEX_SUPPORTED_VERSION again,
// matching kimi.plugin.test.ts's pattern.
vi.mock('../../../core/version-resolution.js', () => ({
  resolveSupportedInstallVersion: vi
    .fn()
    .mockImplementation(async ({ fallbackSupportedVersion }) => fallbackSupportedVersion),
  resolveSupportedVersionDetailed: vi
    .fn()
    .mockImplementation(async ({ fallbackSupportedVersion }) => ({
      version: fallbackSupportedVersion,
      isCurrent: true,
    })),
}));

// Keep beforeRun's default CODEX_HOME out of the real user home.
const homeState = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../../../utils/paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../utils/paths.js')>(
    '../../../../utils/paths.js'
  );
  const { join } = await import('path');
  return { ...actual, resolveHomeDir: (p: string) => join(homeState.dir, p) };
});

describe('CodexPlugin version support', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { mkdtemp } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    homeState.dir = await mkdtemp(join(tmpdir(), 'codemie-codex-home-'));
  });

  afterEach(async () => {
    const { rm } = await import('fs/promises');
    await rm(homeState.dir, { recursive: true, force: true });
  });

  it('declares the supported and minimum supported Codex CLI versions', async () => {
    const { CodexPluginMetadata } = await import('../codex.plugin.js');

    expect(CodexPluginMetadata.supportedVersion).toBe('0.154.0');
    expect(CodexPluginMetadata.minimumSupportedVersion).toBe('0.143.0');
  });

  it('extracts semver from codex --version output before compatibility comparison', async () => {
    const processes = await import('../../../../utils/processes.js');
    vi.mocked(processes.exec).mockResolvedValue({
      code: 0,
      stdout: 'codex-cli 0.155.1\n',
      stderr: '',
    });

    const { CodexPlugin } = await import('../codex.plugin.js');
    const plugin = new CodexPlugin();

    await expect(plugin.getVersion()).resolves.toBe('0.155.1');

    const compat = await plugin.checkVersionCompatibility();
    expect(compat.installedVersion).toBe('0.155.1');
    expect(compat.supportedVersion).toBe('0.154.0');
    expect(compat.minimumSupportedVersion).toBe('0.143.0');
    expect(compat.isNewer).toBe(true);
    expect(compat.compatible).toBe(false);
  });

  it('compares against the live tracked version when it differs from the pinned fallback', async () => {
    const resolution = await import('../../../core/version-resolution.js');
    vi.mocked(resolution.resolveSupportedVersionDetailed).mockResolvedValueOnce({
      version: '0.160.0',
      isCurrent: true,
    });
    const processes = await import('../../../../utils/processes.js');
    vi.mocked(processes.exec).mockResolvedValue({ code: 0, stdout: 'codex-cli 0.155.1\n', stderr: '' });

    const { CodexPlugin } = await import('../codex.plugin.js');
    const compat = await new CodexPlugin().checkVersionCompatibility();

    // Against the 0.154.0 fallback this install would read as "newer"; against live it is behind.
    expect(compat.supportedVersion).toBe('0.160.0');
    expect(compat.versionKnown).toBe(true);
    expect(compat.hasUpdate).toBe(true);
    expect(compat.isNewer).toBe(false);
  });

  it('reports the tracked version as unknown, not the fallback, when resolution is not live', async () => {
    const resolution = await import('../../../core/version-resolution.js');
    vi.mocked(resolution.resolveSupportedVersionDetailed).mockResolvedValueOnce({
      version: '0.154.0',
      isCurrent: false,
    });
    const processes = await import('../../../../utils/processes.js');
    vi.mocked(processes.exec).mockResolvedValue({ code: 0, stdout: 'codex-cli 0.150.0\n', stderr: '' });

    const { CodexPlugin } = await import('../codex.plugin.js');
    const compat = await new CodexPlugin().checkVersionCompatibility();

    expect(compat.versionKnown).toBe(false);
    expect(compat.supportedVersion).toBe('latest');
    expect(compat.hasUpdate).toBe(false);
    expect(compat.isBelowMinimum).toBe(false);
  });

  it.each([
    ['installed', { code: 0, stdout: 'codex-cli 0.150.0\n', stderr: '' }],
    ['not installed', { code: 1, stdout: '', stderr: 'not found' }],
  ])('surfaces a registry latest below the minimum when %s', async (_label, execResult) => {
    const resolution = await import('../../../core/version-resolution.js');
    vi.mocked(resolution.resolveSupportedVersionDetailed).mockResolvedValueOnce({
      version: '0.154.0',
      isCurrent: false,
      liveBelowMinimum: true,
      registryLatestVersion: '0.140.0',
    });
    const processes = await import('../../../../utils/processes.js');
    vi.mocked(processes.exec).mockResolvedValue(execResult);

    const { CodexPlugin } = await import('../codex.plugin.js');
    const compat = await new CodexPlugin().checkVersionCompatibility();

    expect(compat.versionKnown).toBe(false);
    expect(compat.supportedVersion).toBe('latest');
    expect(compat.liveBelowMinimum).toBe(true);
    expect(compat.registryLatestVersion).toBe('0.140.0');
  });

  it('marks Codex versions below the minimum supported version as below minimum', async () => {
    const processes = await import('../../../../utils/processes.js');
    vi.mocked(processes.exec).mockResolvedValue({
      code: 0,
      stdout: 'codex 0.132.9\n',
      stderr: '',
    });

    const { CodexPlugin } = await import('../codex.plugin.js');
    const plugin = new CodexPlugin();

    const compat = await plugin.checkVersionCompatibility();

    expect(compat.installedVersion).toBe('0.132.9');
    expect(compat.isBelowMinimum).toBe(true);
    expect(compat.minimumSupportedVersion).toBe('0.143.0');
  });

  it('installs the supported Codex CLI version when requested', async () => {
    const processes = await import('../../../../utils/processes.js');
    vi.mocked(processes.installGlobal).mockResolvedValue(undefined);

    const { CodexPlugin } = await import('../codex.plugin.js');
    const plugin = new CodexPlugin();

    await plugin.installVersion('supported');

    expect(processes.installGlobal).toHaveBeenCalledWith('@openai/codex', {
      version: '0.154.0',
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

  it("installs the live tracked version for 'supported', not the pinned fallback", async () => {
    const resolution = await import('../../../core/version-resolution.js');
    vi.mocked(resolution.resolveSupportedInstallVersion).mockResolvedValueOnce('0.160.0');
    const processes = await import('../../../../utils/processes.js');
    vi.mocked(processes.installGlobal).mockResolvedValue(undefined);

    const { CodexPlugin } = await import('../codex.plugin.js');
    await new CodexPlugin().installVersion('supported');

    expect(processes.installGlobal).toHaveBeenCalledWith('@openai/codex', { version: '0.160.0' });
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

  it('runs getVersion through a shell only on Windows, where codex is an npm .cmd shim', async () => {
    const processes = await import('../../../../utils/processes.js');
    vi.mocked(processes.exec).mockResolvedValue({ code: 0, stdout: 'codex-cli 0.155.1', stderr: '' });
    const { CodexPlugin } = await import('../codex.plugin.js');
    const originalPlatform = process.platform;

    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      await new CodexPlugin().getVersion();
      expect(processes.exec).toHaveBeenLastCalledWith('codex', ['--version'], expect.objectContaining({ shell: true }));

      Object.defineProperty(process, 'platform', { value: 'linux' });
      await new CodexPlugin().getVersion();
      expect(processes.exec).toHaveBeenLastCalledWith('codex', ['--version'], expect.objectContaining({ shell: false }));
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('preserves an explicit CODEX_HOME override', async () => {
    const { join } = await import('path');
    const { CodexPluginMetadata } = await import('../codex.plugin.js');
    const customHome = join(homeState.dir, 'custom-codex-home');

    const env = await CodexPluginMetadata.lifecycle!.beforeRun!(
      { CODEX_HOME: customHome },
      {
        provider: 'ai-run-sso',
        model: 'gpt-5.5-2026-04-24',
      }
    );

    expect(env.CODEX_HOME).toBe(customHome);
  });
});
