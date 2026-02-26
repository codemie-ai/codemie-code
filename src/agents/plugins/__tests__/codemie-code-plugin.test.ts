/**
 * Tests for CodeMieCodePlugin and CodeMieCodePluginMetadata
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock BaseAgentAdapter to avoid dependency tree
vi.mock('../../core/BaseAgentAdapter.js', () => ({
  BaseAgentAdapter: class {
    metadata: any;
    constructor(metadata: any) {
      this.metadata = metadata;
    }
  },
}));

// Mock binary resolution
vi.mock('../codemie-code-binary.js', () => ({
  resolveCodemieOpenCodeBinary: vi.fn(() => '/mock/bin/codemie'),
  getPlatformPackage: vi.fn(() => '@codemieai/codemie-opencode-darwin-arm64'),
}));

// Mock logger
vi.mock('../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// Mock installGlobal / uninstallGlobal
vi.mock('../../../utils/processes.js', () => ({
  installGlobal: vi.fn(),
  uninstallGlobal: vi.fn(),
}));

// Use vi.hoisted for mock functions referenced in vi.mock factories
const { mockDiscoverSessionsCC, mockProcessSessionCC } = vi.hoisted(() => ({
  mockDiscoverSessionsCC: vi.fn(),
  mockProcessSessionCC: vi.fn(),
}));

// Mock OpenCodeSessionAdapter - must use function (not arrow) to support `new`
vi.mock('../opencode/opencode.session.js', () => ({
  OpenCodeSessionAdapter: vi.fn(function () {
    return {
      discoverSessions: mockDiscoverSessionsCC,
      processSession: mockProcessSessionCC,
    };
  }),
}));

// Mock getModelConfig and getAllOpenCodeModelConfigs
vi.mock('../opencode/opencode-model-configs.js', () => ({
  getModelConfig: vi.fn(() => ({
    id: 'gpt-5-2-2025-12-11',
    name: 'gpt-5-2-2025-12-11',
    family: 'gpt-5',
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    modalities: { input: ['text'], output: ['text'] },
    knowledge: '2025-06-01',
    release_date: '2025-12-11',
    last_updated: '2025-12-11',
    open_weights: false,
    cost: { input: 2.5, output: 10 },
    limit: { context: 1048576, output: 65536 },
  })),
  getAllOpenCodeModelConfigs: vi.fn(() => ({})),
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const { existsSync } = await import('fs');
const { resolveCodemieOpenCodeBinary, getPlatformPackage } = await import('../codemie-code-binary.js');
const { installGlobal, uninstallGlobal } = await import('../../../utils/processes.js');
const { logger } = await import('../../../utils/logger.js');
const { OpenCodeSessionAdapter } = await import('../opencode/opencode.session.js');
const { CodeMieCodePlugin, CodeMieCodePluginMetadata, BUILTIN_AGENT_NAME } = await import('../codemie-code.plugin.js');

const mockExistsSync = vi.mocked(existsSync);
const mockResolve = vi.mocked(resolveCodemieOpenCodeBinary);
const mockGetPlatformPackage = vi.mocked(getPlatformPackage);
const mockInstallGlobal = vi.mocked(installGlobal);
const mockUninstallGlobal = vi.mocked(uninstallGlobal);

describe('CodeMieCodePluginMetadata', () => {
  it('has name codemie-code', () => {
    expect(CodeMieCodePluginMetadata.name).toBe('codemie-code');
    expect(BUILTIN_AGENT_NAME).toBe('codemie-code');
  });

  it('has beforeRun defined', () => {
    expect(CodeMieCodePluginMetadata.lifecycle!.beforeRun).toBeDefined();
    expect(typeof CodeMieCodePluginMetadata.lifecycle!.beforeRun).toBe('function');
  });

  it('has enrichArgs defined', () => {
    expect(CodeMieCodePluginMetadata.lifecycle!.enrichArgs).toBeDefined();
    expect(typeof CodeMieCodePluginMetadata.lifecycle!.enrichArgs).toBe('function');
  });

  it('has onSessionEnd defined', () => {
    expect(CodeMieCodePluginMetadata.lifecycle!.onSessionEnd).toBeDefined();
    expect(typeof CodeMieCodePluginMetadata.lifecycle!.onSessionEnd).toBe('function');
  });
});

describe('CodeMieCodePlugin', () => {
  let plugin: InstanceType<typeof CodeMieCodePlugin>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolve.mockReturnValue('/mock/bin/codemie');
    mockExistsSync.mockReturnValue(true);
    plugin = new CodeMieCodePlugin();
  });

  describe('isInstalled', () => {
    it('returns true when binary resolved and exists', async () => {
      const result = await plugin.isInstalled();
      expect(result).toBe(true);
    });

    it('returns false when resolveCodemieOpenCodeBinary returns null', async () => {
      mockResolve.mockReturnValue(null);

      const result = await plugin.isInstalled();
      expect(result).toBe(false);
    });

    it('returns false when path resolved but file missing', async () => {
      mockResolve.mockReturnValue('/mock/bin/codemie');
      mockExistsSync.mockReturnValue(false);

      const result = await plugin.isInstalled();
      expect(result).toBe(false);
    });
  });

  describe('install', () => {
    it('calls installGlobal with the correct package name', async () => {
      await plugin.install();
      expect(mockInstallGlobal).toHaveBeenCalledWith('@codemieai/codemie-opencode');
    });
  });

  describe('uninstall', () => {
    it('removes both wrapper and platform-specific packages', async () => {
      mockResolve.mockReturnValue(null); // binary gone after uninstall

      await plugin.uninstall();

      expect(mockUninstallGlobal).toHaveBeenCalledWith('@codemieai/codemie-opencode');
      expect(mockUninstallGlobal).toHaveBeenCalledWith('@codemieai/codemie-opencode-darwin-arm64');
    });

    it('warns when binary persists after uninstall', async () => {
      mockResolve.mockReturnValue('/still/here/bin/codemie');

      await plugin.uninstall();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Binary still found after uninstall')
      );
    });

    it('does not warn when binary is gone after uninstall', async () => {
      mockResolve.mockReturnValue(null);

      await plugin.uninstall();

      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('Binary still found')
      );
    });

    it('succeeds even if platform package uninstall fails', async () => {
      mockUninstallGlobal
        .mockResolvedValueOnce(undefined) // wrapper succeeds
        .mockRejectedValueOnce(new Error('not installed')); // platform fails
      mockResolve.mockReturnValue(null);

      await expect(plugin.uninstall()).resolves.toBeUndefined();

      expect(mockUninstallGlobal).toHaveBeenCalledTimes(2);
    });

    it('skips platform package when getPlatformPackage returns null', async () => {
      mockGetPlatformPackage.mockReturnValue(null);
      mockResolve.mockReturnValue(null);

      await plugin.uninstall();

      expect(mockUninstallGlobal).toHaveBeenCalledTimes(1);
      expect(mockUninstallGlobal).toHaveBeenCalledWith('@codemieai/codemie-opencode');
    });
  });

  describe('getSessionAdapter', () => {
    it('returns an OpenCodeSessionAdapter instance', () => {
      const adapter = plugin.getSessionAdapter();
      expect(adapter).toBeDefined();
      expect(OpenCodeSessionAdapter).toHaveBeenCalled();
    });
  });

  describe('getExtensionInstaller', () => {
    it('returns undefined', () => {
      const installer = plugin.getExtensionInstaller();
      expect(installer).toBeUndefined();
    });
  });
});

describe('CodeMieCodePlugin onSessionEnd', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses clientType codemie-code in context', async () => {
    mockDiscoverSessionsCC.mockResolvedValue([
      { sessionId: 'test-session', filePath: '/path/to/session' },
    ]);
    mockProcessSessionCC.mockResolvedValue({ success: true, totalRecords: 5 });

    const env = {
      CODEMIE_SESSION_ID: 'test-123',
      CODEMIE_BASE_URL: 'http://localhost:3000',
    } as unknown as NodeJS.ProcessEnv;

    await CodeMieCodePluginMetadata.lifecycle!.onSessionEnd!(0, env);

    expect(mockProcessSessionCC).toHaveBeenCalledWith(
      '/path/to/session',
      'test-123',
      expect.objectContaining({ clientType: 'codemie-code' })
    );
  });

  it('skips when no CODEMIE_SESSION_ID', async () => {
    const env = {} as NodeJS.ProcessEnv;

    await CodeMieCodePluginMetadata.lifecycle!.onSessionEnd!(0, env);

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('skipping')
    );
  });

  it('handles errors gracefully', async () => {
    mockDiscoverSessionsCC.mockRejectedValue(new Error('adapter error'));

    const env = {
      CODEMIE_SESSION_ID: 'test-123',
    } as unknown as NodeJS.ProcessEnv;

    // Should not throw
    await CodeMieCodePluginMetadata.lifecycle!.onSessionEnd!(0, env);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed')
    );
  });
});
