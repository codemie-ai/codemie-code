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

    expect(CodexPluginMetadata.supportedVersion).toBe('0.129.0');
    expect(CodexPluginMetadata.minimumSupportedVersion).toBe('0.119.0');
  });

  it('extracts semver from codex --version output before compatibility comparison', async () => {
    const processes = await import('../../../../utils/processes.js');
    vi.mocked(processes.exec).mockResolvedValue({
      code: 0,
      stdout: 'codex-cli 0.130.1\n',
      stderr: '',
    });

    const { CodexPlugin } = await import('../codex.plugin.js');
    const plugin = new CodexPlugin();

    await expect(plugin.getVersion()).resolves.toBe('0.130.1');

    const compat = await plugin.checkVersionCompatibility();
    expect(compat.installedVersion).toBe('0.130.1');
    expect(compat.supportedVersion).toBe('0.129.0');
    expect(compat.minimumSupportedVersion).toBe('0.119.0');
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
    expect(compat.minimumSupportedVersion).toBe('0.119.0');
  });

  it('installs the supported Codex CLI version when requested', async () => {
    const processes = await import('../../../../utils/processes.js');
    vi.mocked(processes.installGlobal).mockResolvedValue(undefined);

    const { CodexPlugin } = await import('../codex.plugin.js');
    const plugin = new CodexPlugin();

    await plugin.installVersion('supported');

    expect(processes.installGlobal).toHaveBeenCalledWith('@openai/codex', {
      version: '0.129.0',
    });
  });
});
