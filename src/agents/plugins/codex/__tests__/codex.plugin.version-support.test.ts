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
    '../../../../utils/processes.js',
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

vi.mock('../../../../utils/version-warnings.js', () => ({
  VersionWarningStore: {
    hasWarned: vi.fn(),
    recordWarning: vi.fn(),
  },
}));

vi.mock('../../../../utils/cli-updater.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../utils/cli-updater.js')>(
    '../../../../utils/cli-updater.js',
  );
  return {
    ...actual,
    getCurrentCliVersion: vi.fn(async () => '0.11.0'),
  };
});

vi.mock('../../../../utils/tty.js', () => ({
  isInteractive: vi.fn(() => false),
}));

/**
 * Contract tests for the new one-time-warning behavior. Replaces the previous
 * constant-value assertions — see EPMCDME-13734.
 */
describe('CodexPlugin — one-time untested-version warning contract', () => {
  beforeEach(() => vi.clearAllMocks());

  it('carries supportedVersion and minimumSupportedVersion on its metadata (bumped manually per CodeMie release)', async () => {
    const { CodexPluginMetadata } = await import('../codex.plugin.js');
    expect(CodexPluginMetadata.supportedVersion).toBe('0.143.0');
    expect(CodexPluginMetadata.minimumSupportedVersion).toBe('0.133.0');
  });

  it('warnOnceIfUntested is silent when installed matches supportedVersion (no mismatch)', async () => {
    const { VersionWarningStore } = await import('../../../../utils/version-warnings.js');
    vi.mocked(VersionWarningStore.hasWarned).mockResolvedValue(false);

    const { CodexPlugin } = await import('../codex.plugin.js');
    const adapter = new CodexPlugin();
    vi.spyOn(adapter, 'getVersion').mockResolvedValue('0.143.0'); // matches metadata

    await adapter.warnOnceIfUntested();

    expect(VersionWarningStore.hasWarned).not.toHaveBeenCalled();
    expect(VersionWarningStore.recordWarning).not.toHaveBeenCalled();
  });

  it('warnOnceIfUntested emits + records marker when installed differs from supportedVersion', async () => {
    const { VersionWarningStore } = await import('../../../../utils/version-warnings.js');
    vi.mocked(VersionWarningStore.hasWarned).mockResolvedValue(false);

    const { CodexPlugin } = await import('../codex.plugin.js');
    const adapter = new CodexPlugin();
    vi.spyOn(adapter, 'getVersion').mockResolvedValue('0.150.0'); // newer than supported 0.143.0

    await adapter.warnOnceIfUntested();

    expect(VersionWarningStore.recordWarning).toHaveBeenCalledWith('codex', '0.150.0');
  });

  it('warnOnceIfUntested is silent and does not record when marker is present', async () => {
    const { VersionWarningStore } = await import('../../../../utils/version-warnings.js');
    vi.mocked(VersionWarningStore.hasWarned).mockResolvedValue(true);

    const { CodexPlugin } = await import('../codex.plugin.js');
    const adapter = new CodexPlugin();
    vi.spyOn(adapter, 'getVersion').mockResolvedValue('0.150.0');

    await adapter.warnOnceIfUntested();

    expect(VersionWarningStore.recordWarning).not.toHaveBeenCalled();
  });
});
