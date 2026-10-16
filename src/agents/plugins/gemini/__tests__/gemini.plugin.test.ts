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

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const execMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../utils/processes.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../utils/processes.js')>(
    '../../../../utils/processes.js'
  );
  return { ...actual, exec: execMock };
});

import { GeminiPlugin } from '../gemini.plugin.js';

describe('GeminiPlugin', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  describe('getVersion', () => {
    it('runs through a shell on Windows, where gemini is an npm .cmd shim', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      execMock.mockResolvedValue({ code: 0, stdout: '0.59.0\n', stderr: '' });

      await expect(new GeminiPlugin().getVersion()).resolves.toBe('0.59.0');
      expect(execMock).toHaveBeenCalledWith('gemini', ['--version'], expect.objectContaining({ shell: true }));
    });

    it('does not use a shell on other platforms', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      execMock.mockResolvedValue({ code: 0, stdout: '0.59.0', stderr: '' });

      await new GeminiPlugin().getVersion();
      expect(execMock).toHaveBeenCalledWith('gemini', ['--version'], expect.objectContaining({ shell: false }));
    });
  });
});
