/**
 * codemie-code version pin consumed by `codemie install codemie-code --supported`.
 *
 * @group unit
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../providers/core/registry.js', () => ({
  ProviderRegistry: {
    registerProvider: vi.fn((template: unknown) => template),
    registerSetupSteps: vi.fn(),
    registerHealthCheck: vi.fn(),
    registerModelProxy: vi.fn(),
    getProvider: vi.fn(),
    getProviderNames: vi.fn(() => []),
  },
}));

vi.mock('../../../utils/processes.js', async () => {
  const actual = await vi.importActual<typeof import('../../../utils/processes.js')>(
    '../../../utils/processes.js'
  );

  return {
    ...actual,
    commandExists: vi.fn(),
    exec: vi.fn(),
    installGlobal: vi.fn(),
  };
});

vi.mock('../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const PACKAGE_NAME = '@codemieai/codemie-opencode';

function readDependencyVersion(): string {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8')) as {
    dependencies: Record<string, string>;
  };
  return pkg.dependencies[PACKAGE_NAME];
}

describe('CodeMieCodePlugin version support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should declare the package.json dependency version as the supported version', async () => {
    const { CodeMieCodePluginMetadata } = await import('../codemie-code.plugin.js');

    expect(CodeMieCodePluginMetadata.supportedVersion).toBe(readDependencyVersion());
  });

  it('should not declare a minimum supported version so no installed build is blocked', async () => {
    const { CodeMieCodePluginMetadata } = await import('../codemie-code.plugin.js');

    expect(CodeMieCodePluginMetadata.minimumSupportedVersion).toBeUndefined();
  });

  it('should install the supported version when requested', async () => {
    const processes = await import('../../../utils/processes.js');
    vi.mocked(processes.installGlobal).mockResolvedValue(undefined);

    const { CodeMieCodePlugin } = await import('../codemie-code.plugin.js');
    const plugin = new CodeMieCodePlugin();

    await plugin.installVersion('supported');

    expect(processes.installGlobal).toHaveBeenCalledWith(PACKAGE_NAME, {
      version: readDependencyVersion(),
    });
  });
});
