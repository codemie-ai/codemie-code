/**
 * Tests for CodemieOpenCodePlugin class
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock BaseAgentAdapter to avoid dependency tree
vi.mock('../../../core/BaseAgentAdapter.js', () => ({
  BaseAgentAdapter: class {
    metadata: any;
    constructor(metadata: any) {
      this.metadata = metadata;
    }
  },
}));

// Mock binary resolution
vi.mock('../codemie-opencode-binary.js', () => ({
  resolveCodemieOpenCodeBinary: vi.fn(() => '/mock/bin/codemie'),
}));

// Mock logger
vi.mock('../../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// Mock installGlobal
vi.mock('../../../../utils/processes.js', () => ({
  installGlobal: vi.fn(),
}));

// Mock OpenCodeSessionAdapter - must use function (not arrow) to support `new`
vi.mock('../../opencode/opencode.session.js', () => ({
  OpenCodeSessionAdapter: vi.fn(function () {
    return {
      discoverSessions: vi.fn(),
      processSession: vi.fn(),
    };
  }),
}));

// Mock getModelConfig
vi.mock('../../opencode/opencode-model-configs.js', () => ({
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
}));

// Mock fs for existsSync
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const { existsSync } = await import('fs');
const { resolveCodemieOpenCodeBinary } = await import('../codemie-opencode-binary.js');
const { installGlobal } = await import('../../../../utils/processes.js');
const { OpenCodeSessionAdapter } = await import('../../opencode/opencode.session.js');
const { CodemieOpenCodePlugin } = await import('../codemie-opencode.plugin.js');

const mockExistsSync = vi.mocked(existsSync);
const mockResolve = vi.mocked(resolveCodemieOpenCodeBinary);
const mockInstallGlobal = vi.mocked(installGlobal);

describe('CodemieOpenCodePlugin', () => {
  let plugin: InstanceType<typeof CodemieOpenCodePlugin>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolve.mockReturnValue('/mock/bin/codemie');
    mockExistsSync.mockReturnValue(true);
    plugin = new CodemieOpenCodePlugin();
  });

  describe('isInstalled', () => {
    it('returns true when binary resolved and exists', async () => {
      mockResolve.mockReturnValue('/mock/bin/codemie');
      mockExistsSync.mockReturnValue(true);

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
