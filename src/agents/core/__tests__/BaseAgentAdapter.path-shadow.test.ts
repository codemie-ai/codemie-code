/**
 * Agent PATH shadow check (EPMCDME-16969): verdicts from mocked PATH lookups,
 * prefix resolution and shim presence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AgentMetadata } from '../types.js';

vi.mock('../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), setSessionId: vi.fn() },
}));

vi.mock('../../../providers/core/registry.js', () => ({
  ProviderRegistry: {
    registerProvider: vi.fn((template: unknown) => template),
    registerSetupSteps: vi.fn(),
    registerHealthCheck: vi.fn(),
    registerModelProxy: vi.fn(),
    getProvider: vi.fn(() => ({ authType: 'none' })),
    getProviderNames: vi.fn(() => []),
  },
}));

vi.mock('../../../utils/processes.js', () => ({
  detectGitBranch: vi.fn(() => Promise.resolve(null)),
  detectGitRemoteRepo: vi.fn(() => Promise.resolve(null)),
  exec: vi.fn(),
  installGlobal: vi.fn(),
  uninstallGlobal: vi.fn(),
  getCommandPath: vi.fn(() => Promise.resolve(null)),
  getCommandMatches: vi.fn(),
}));

vi.mock('../../../utils/npm-prefix.js', () => ({
  getCodemieNpmPrefix: vi.fn(),
  getCodemieOrGlobalNpmPrefix: vi.fn(),
  getGlobalNpmPrefix: vi.fn(),
  getNpmBinDir: vi.fn((prefix: string) => prefix),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, access: vi.fn() };
});

import { BaseAgentAdapter, resetNpmConfigPrefixCache } from '../BaseAgentAdapter.js';
import { getCommandMatches } from '../../../utils/processes.js';
import { getCodemieNpmPrefix, getCodemieOrGlobalNpmPrefix, getGlobalNpmPrefix } from '../../../utils/npm-prefix.js';
import { access } from 'fs/promises';

const metadata = (overrides: Partial<AgentMetadata> = {}): AgentMetadata => ({
  name: 'pi',
  displayName: 'Pi',
  description: 'test',
  npmPackage: '@scope/pi',
  cliCommand: 'pi',
  ...overrides,
} as AgentMetadata);

class TestAdapter extends BaseAgentAdapter {
  constructor(overrides: Partial<AgentMetadata> = {}) {
    super(metadata(overrides));
  }
}

const MANAGED = 'C:\\Users\\u\\AppData\\Roaming\\npm';
const OTHER = 'C:\\Tools\\bin';
const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

describe('BaseAgentAdapter.checkPathShadow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetNpmConfigPrefixCache();
    setPlatform('win32');
    vi.mocked(getCodemieNpmPrefix).mockReturnValue(MANAGED);
    vi.mocked(getCodemieOrGlobalNpmPrefix).mockResolvedValue(MANAGED);
    vi.mocked(getGlobalNpmPrefix).mockResolvedValue(null);
    vi.mocked(access).mockResolvedValue(undefined);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('reports shadowed when another install comes first and the managed shim exists', async () => {
    vi.mocked(getCommandMatches).mockResolvedValue({ status: 'answered', matches: [`${OTHER}\\pi.cmd`, `${MANAGED}\\pi.cmd`] });
    const verdict = await new TestAdapter().checkPathShadow();
    expect(verdict).toEqual({ status: 'shadowed', active: `${OTHER}\\pi.cmd`, managedDir: MANAGED });
  });

  it('reports clear when the first match is in the managed dir', async () => {
    vi.mocked(getCommandMatches).mockResolvedValue({ status: 'answered', matches: [`${MANAGED}\\pi.cmd`] });
    expect(await new TestAdapter().checkPathShadow()).toEqual({ status: 'clear' });
  });

  it('reports missing-on-path when nothing is on PATH but the shim exists', async () => {
    vi.mocked(getCommandMatches).mockResolvedValue({ status: 'answered', matches: [] });
    const verdict = await new TestAdapter().checkPathShadow();
    expect(verdict).toEqual({ status: 'missing-on-path', managedDir: MANAGED, shimPath: `${MANAGED}\\pi.cmd` });
  });

  it('ignores an extensionless leftover without a .cmd shim', async () => {
    vi.mocked(access).mockImplementation(async (p) => {
      if (String(p).endsWith('.cmd')) throw new Error('ENOENT');
    });
    expect(await new TestAdapter().checkPathShadow()).toEqual({ status: 'missing' });
  });

  it('skips the PATH lookup when no managed shim exists and resolvePrefix is set', async () => {
    vi.mocked(access).mockRejectedValue(new Error('ENOENT'));
    expect(await new TestAdapter().checkPathShadow({ resolvePrefix: true })).toEqual({ status: 'missing' });
    expect(getCommandMatches).not.toHaveBeenCalled();
  });

  it('reports missing when nothing is on PATH and no shim exists', async () => {
    vi.mocked(getCommandMatches).mockResolvedValue({ status: 'answered', matches: [] });
    vi.mocked(access).mockRejectedValue(new Error('ENOENT'));
    expect(await new TestAdapter().checkPathShadow()).toEqual({ status: 'missing' });
  });

  it('reports unknown when where.exe output was not decoded as UTF-8 (U+FFFD in a match)', async () => {
    vi.mocked(getCommandMatches).mockResolvedValue({ status: 'answered', matches: ['C:\\Users\\J\uFFFDrgen\\bin\\pi.cmd', `${MANAGED}\\pi.cmd`] });
    expect(await new TestAdapter().checkPathShadow()).toEqual({ status: 'unknown' });
  });

  it('reports unknown when the lookup is unanswered', async () => {
    vi.mocked(getCommandMatches).mockResolvedValue({ status: 'unanswered' });
    expect(await new TestAdapter().checkPathShadow()).toEqual({ status: 'unknown' });
  });

  it('reports unknown when the lookup exceeds the deadline', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(getCommandMatches).mockReturnValue(new Promise(() => undefined));
      const pending = new TestAdapter().checkPathShadow();
      await vi.advanceTimersByTimeAsync(5001);
      expect(await pending).toEqual({ status: 'unknown' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports unknown off win32 without any lookup', async () => {
    setPlatform('linux');
    expect(await new TestAdapter().checkPathShadow()).toEqual({ status: 'unknown' });
    expect(getCommandMatches).not.toHaveBeenCalled();
  });

  it('reports unknown for an agent that opted out', async () => {
    const adapter = new TestAdapter({ pathShadowCheck: false });
    expect(await adapter.checkPathShadow()).toEqual({ status: 'unknown' });
    expect(getCommandMatches).not.toHaveBeenCalled();
  });

  it('reports unknown without cliCommand or npmPackage', async () => {
    expect(await new TestAdapter({ cliCommand: null }).checkPathShadow()).toEqual({ status: 'unknown' });
    expect(await new TestAdapter({ npmPackage: null }).checkPathShadow()).toEqual({ status: 'unknown' });
    expect(getCommandMatches).not.toHaveBeenCalled();
  });

  it('does not resolve the npm prefix without resolvePrefix', async () => {
    vi.mocked(getCodemieNpmPrefix).mockReturnValue(null);
    expect(await new TestAdapter().checkPathShadow()).toEqual({ status: 'unknown' });
    expect(getCodemieOrGlobalNpmPrefix).not.toHaveBeenCalled();
  });

  it('resolves the prefix through npm with resolvePrefix', async () => {
    vi.mocked(getCodemieNpmPrefix).mockReturnValue(null);
    vi.mocked(getCommandMatches).mockResolvedValue({ status: 'answered', matches: [`${MANAGED}\\pi.cmd`] });
    expect(await new TestAdapter().checkPathShadow({ resolvePrefix: true })).toEqual({ status: 'clear' });
    expect(getCodemieOrGlobalNpmPrefix).toHaveBeenCalledTimes(1);
  });

  describe('npm-config prefix fallback (running codemie outside the managed prefix)', () => {
    const NPM_PREFIX = 'C:\\Users\\u\\npm-global';

    beforeEach(() => {
      resetNpmConfigPrefixCache();
      vi.mocked(getCodemieNpmPrefix).mockReturnValue(MANAGED);
      vi.mocked(getGlobalNpmPrefix).mockResolvedValue(NPM_PREFIX);
      // Derived prefix has no shim; only the npm-config prefix does.
      vi.mocked(access).mockImplementation(async (p) => {
        if (!String(p).startsWith(NPM_PREFIX)) throw new Error('ENOENT');
      });
    });

    it('reports missing-on-path when only the npm-config prefix has the shim and PATH has no match', async () => {
      vi.mocked(getCommandMatches).mockResolvedValue({ status: 'answered', matches: [] });
      expect(await new TestAdapter().checkPathShadow()).toEqual({
        status: 'missing-on-path',
        managedDir: NPM_PREFIX,
        shimPath: `${NPM_PREFIX}\\pi.cmd`,
      });
    });

    it('reports missing without spawning npm when PATH already has a match', async () => {
      vi.mocked(getCommandMatches).mockResolvedValue({ status: 'answered', matches: [`${OTHER}\\pi.cmd`] });
      expect(await new TestAdapter().checkPathShadow()).toEqual({ status: 'missing' });
      expect(getGlobalNpmPrefix).not.toHaveBeenCalled();
    });

    it('reports unknown when the PATH lookup is unanswered', async () => {
      vi.mocked(getCommandMatches).mockResolvedValue({ status: 'unanswered' });
      expect(await new TestAdapter().checkPathShadow()).toEqual({ status: 'unknown' });
    });

    it('reports missing when the npm lookup returns null', async () => {
      vi.mocked(getCommandMatches).mockResolvedValue({ status: 'answered', matches: [] });
      vi.mocked(getGlobalNpmPrefix).mockResolvedValue(null);
      expect(await new TestAdapter().checkPathShadow()).toEqual({ status: 'missing' });
    });

    it('reports missing when the npm lookup throws', async () => {
      vi.mocked(getCommandMatches).mockResolvedValue({ status: 'answered', matches: [] });
      vi.mocked(getGlobalNpmPrefix).mockRejectedValue(new Error('npm failed'));
      expect(await new TestAdapter().checkPathShadow()).toEqual({ status: 'missing' });
    });

    it('reports missing when the npm-config prefix equals the derived one', async () => {
      vi.mocked(getCommandMatches).mockResolvedValue({ status: 'answered', matches: [] });
      vi.mocked(getGlobalNpmPrefix).mockResolvedValue(MANAGED);
      expect(await new TestAdapter().checkPathShadow()).toEqual({ status: 'missing' });
    });

    it('memoizes the npm lookup across agents', async () => {
      vi.mocked(getCommandMatches).mockResolvedValue({ status: 'answered', matches: [] });
      await new TestAdapter().checkPathShadow();
      await new TestAdapter({ name: 'other', cliCommand: 'other' }).checkPathShadow();
      expect(getGlobalNpmPrefix).toHaveBeenCalledTimes(1);
    });
  });

  it('memoizes the PATH matches for reuse', async () => {
    vi.mocked(getCommandMatches).mockResolvedValue({ status: 'answered', matches: [`${OTHER}\\pi.cmd`] });
    const adapter = new TestAdapter();
    await adapter.checkPathShadow();
    await adapter.checkPathShadow();
    expect(await adapter.getPathMatches()).toEqual([`${OTHER}\\pi.cmd`]);
    expect(getCommandMatches).toHaveBeenCalledTimes(1);
  });
});
