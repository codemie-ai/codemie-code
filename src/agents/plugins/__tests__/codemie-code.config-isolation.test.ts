/**
 * EPMCDME-16963: codemie-code isolates the embedded engine's config location
 * (XDG_CONFIG_HOME) from the user's global OpenCode config, while the wrapper
 * process keeps the user's own value.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';

vi.mock('../../core/BaseAgentAdapter.js', () => ({
  BaseAgentAdapter: class {
    metadata: unknown;
    constructor(metadata: unknown) {
      this.metadata = metadata;
    }
  },
}));
vi.mock('../codemie-code-binary.js', () => ({
  resolveCodemieOpenCodeBinary: vi.fn(() => '/mock/bin/codemie'),
  getPlatformPackage: vi.fn(() => '@codemieai/codemie-opencode-linux-x64'),
}));
vi.mock('../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn(),
    setAgentName: vi.fn(), setSessionId: vi.fn(), setProfileName: vi.fn(),
  },
}));
vi.mock('../../../utils/processes.js', async (importOriginal) => ({
  installGlobal: vi.fn(),
  uninstallGlobal: vi.fn(),
  wrapperOwnerFromEnv: (await importOriginal<typeof import('../../../utils/processes.js')>()).wrapperOwnerFromEnv,
}));
vi.mock('../../../cli/commands/hook.js', () => ({ processEvent: vi.fn() }));
vi.mock('../../../utils/paths.js', () => ({
  getCodemieHome: vi.fn(() => '/mock/.codemie'),
  getCodemiePath: vi.fn((...args: string[]) => `/mock/.codemie/${args.join('/')}`),
}));
vi.mock('../codemie-code-hooks/index.js', () => ({
  getHooksPluginFileUrl: vi.fn(() => 'file:///mock/hooks-plugin.js'),
  cleanupHooksPlugin: vi.fn(),
}));
vi.mock('../reasoning-sanitizer/index.js', () => ({
  getReasoningSanitizerPluginUrl: vi.fn(() => 'file:///mock/reasoning-sanitizer.ts'),
  cleanupReasoningSanitizerPlugin: vi.fn(),
}));
vi.mock('../opencode/opencode.session.js', () => ({
  OpenCodeSessionAdapter: vi.fn(function () {
    return { locateSessionTranscript: vi.fn(), processSession: vi.fn() };
  }),
}));
vi.mock('../opencode/opencode-dynamic-models.js', () => ({
  fetchDynamicModelConfigs: vi.fn(() => Promise.resolve({})),
}));
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const { CodeMieCodePluginMetadata } = await import('../codemie-code.plugin.js');
const { getOpenCodeConfigBase, getOpenCodeStorageBase } = await import('../opencode/opencode.paths.js');

const lifecycle = CodeMieCodePluginMetadata.lifecycle!;
const expectedConfigBase = join('/mock/.codemie', 'opencode-config');

// beforeRun can fail in later steps of this reduced environment; the redirect is set before them.
async function runBeforeRun(env: NodeJS.ProcessEnv): Promise<void> {
  await lifecycle.beforeRun!(env, {} as never).catch(() => undefined);
}

describe('codemie-code XDG_CONFIG_HOME isolation', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    lifecycle.enrichArgs!([], {} as never);
    vi.unstubAllEnvs();
  });

  it('uses a CodeMie-owned config base that differs from the data base', () => {
    expect(getOpenCodeConfigBase()).toBe(expectedConfigBase);
    expect(getOpenCodeConfigBase()).not.toBe(getOpenCodeStorageBase());
  });

  it('redirects the engine config location for http(s) base URLs', async () => {
    const env: NodeJS.ProcessEnv = { CODEMIE_BASE_URL: 'http://localhost:3000' };
    await runBeforeRun(env);
    expect(env.XDG_CONFIG_HOME).toBe(expectedConfigBase);
  });

  it('redirects the engine config location for a non-http(s) base URL', async () => {
    const env: NodeJS.ProcessEnv = { CODEMIE_BASE_URL: 'ftp://not-http' };
    await runBeforeRun(env);
    expect(env.XDG_CONFIG_HOME).toBe(expectedConfigBase);
  });

  it('keeps the user value for the wrapper once enrichArgs runs', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', '/home/user/.cfg');
    const env: NodeJS.ProcessEnv = { CODEMIE_BASE_URL: 'http://localhost:3000' };
    await runBeforeRun(env);
    Object.assign(process.env, env); // what BaseAgentAdapter does after beforeRun
    expect(process.env.XDG_CONFIG_HOME).toBe(expectedConfigBase);

    lifecycle.enrichArgs!([], {} as never);

    expect(process.env.XDG_CONFIG_HOME).toBe('/home/user/.cfg');
    expect(env.XDG_CONFIG_HOME).toBe(expectedConfigBase);
  });

  it('leaves XDG_CONFIG_HOME unset for the wrapper when the user had none', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', undefined);
    delete process.env.XDG_CONFIG_HOME;
    const env: NodeJS.ProcessEnv = { CODEMIE_BASE_URL: 'http://localhost:3000' };
    await runBeforeRun(env);
    Object.assign(process.env, env);

    lifecycle.enrichArgs!([], {} as never);

    expect(process.env.XDG_CONFIG_HOME).toBeUndefined();
  });

  it('keeps an empty-string user value distinct from unset', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', '');
    const env: NodeJS.ProcessEnv = { CODEMIE_BASE_URL: 'http://localhost:3000' };
    await runBeforeRun(env);
    Object.assign(process.env, env);

    lifecycle.enrichArgs!([], {} as never);

    expect(process.env.XDG_CONFIG_HOME).toBe('');
  });
});
