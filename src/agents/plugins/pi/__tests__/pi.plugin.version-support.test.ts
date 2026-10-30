/**
 * Pi version pin consumed by `codemie install pi --supported`.
 *
 * @group unit
 */

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

describe('PiPlugin version support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should declare 1.4.0 as the supported Pi version', async () => {
    const { PiPluginMetadata } = await import('../pi.plugin.js');

    expect(PiPluginMetadata.supportedVersion).toBe('1.4.0');
  });

  it('should not declare a minimum supported version so no installed Pi is blocked', async () => {
    const { PiPluginMetadata } = await import('../pi.plugin.js');

    expect(PiPluginMetadata.minimumSupportedVersion).toBeUndefined();
  });

  it('should install the supported Pi version when requested', async () => {
    const processes = await import('../../../../utils/processes.js');
    vi.mocked(processes.installGlobal).mockResolvedValue(undefined);

    const { PiPlugin } = await import('../pi.plugin.js');
    const plugin = new PiPlugin();

    await plugin.installVersion('supported');

    expect(processes.installGlobal).toHaveBeenCalledWith('@earendil-works/pi-coding-agent', {
      version: '1.4.0',
    });
  });
});
