import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

const isWin = process.platform === 'win32';
const nativePath = isWin ? path.win32 : path.posix;

vi.mock('@/utils/exec.js', () => ({
  exec: vi.fn()
}));

vi.mock('@/utils/paths.js', () => ({
  getDirname: vi.fn()
}));

vi.mock('fs');

describe('npm-prefix', () => {
  describe('deriveSelfPrefix', () => {
    it('derives the prefix from the win32 node_modules layout', async () => {
      const { deriveSelfPrefix } = await import('../npm-prefix.js');
      const dir = path.win32.join('C:\\Users\\codemie', 'node_modules', '@codemieai', 'code');
      expect(deriveSelfPrefix(dir, 'win32')).toBe('C:\\Users\\codemie');
    });

    it('derives the prefix from the POSIX lib/node_modules layout', async () => {
      const { deriveSelfPrefix } = await import('../npm-prefix.js');
      const dir = path.posix.join('/usr/local', 'lib', 'node_modules', '@codemieai', 'code');
      expect(deriveSelfPrefix(dir, 'linux')).toBe('/usr/local');
    });

    it('returns null for a dev checkout that does not match the install layout', async () => {
      const { deriveSelfPrefix } = await import('../npm-prefix.js');
      expect(deriveSelfPrefix('/Users/dev/codemie-code', 'linux')).toBeNull();
      expect(deriveSelfPrefix('C:\\Users\\dev\\codemie-code', 'win32')).toBeNull();
    });
  });

  describe('getLegacyPrefixPath', () => {
    it('uses LOCALAPPDATA\\CodeMie\\npm-prefix on win32', async () => {
      const original = process.env.LOCALAPPDATA;
      process.env.LOCALAPPDATA = 'C:\\Users\\codemie\\AppData\\Local';
      const { getLegacyPrefixPath } = await import('../npm-prefix.js');
      expect(getLegacyPrefixPath('win32')).toBe(
        path.join('C:\\Users\\codemie\\AppData\\Local', 'CodeMie', 'npm-prefix')
      );
      process.env.LOCALAPPDATA = original;
    });

    it('uses ~/.codemie/npm-prefix on non-win32 platforms', async () => {
      const { getLegacyPrefixPath } = await import('../npm-prefix.js');
      const { homedir } = await import('os');
      expect(getLegacyPrefixPath('linux')).toBe(path.join(homedir(), '.codemie', 'npm-prefix'));
    });
  });

  describe('isSamePath', () => {
    it('is case-insensitive and ignores a trailing separator on win32', async () => {
      const { isSamePath } = await import('../npm-prefix.js');
      expect(isSamePath('C:\\Users\\Foo\\', 'c:\\users\\foo', 'win32')).toBe(true);
    });

    it('is case-sensitive on POSIX', async () => {
      const { isSamePath } = await import('../npm-prefix.js');
      expect(isSamePath('/usr/local', '/usr/Local', 'linux')).toBe(false);
    });

    it('ignores a trailing separator on POSIX', async () => {
      const { isSamePath } = await import('../npm-prefix.js');
      expect(isSamePath('/usr/local/', '/usr/local', 'linux')).toBe(true);
    });

    it('returns false for genuinely different paths', async () => {
      const { isSamePath } = await import('../npm-prefix.js');
      expect(isSamePath('/usr/local', '/opt/codemie', 'linux')).toBe(false);
    });
  });

  describe('getUserNpmPrefix', () => {
    beforeEach(() => {
      vi.resetModules();
      vi.clearAllMocks();
    });

    it('returns the trimmed prefix on success', async () => {
      const { exec } = await import('@/utils/exec.js');
      vi.mocked(exec).mockResolvedValue({ code: 0, stdout: '/usr/local\n', stderr: '' });
      const { getUserNpmPrefix } = await import('../npm-prefix.js');
      await expect(getUserNpmPrefix()).resolves.toBe('/usr/local');
      expect(exec).toHaveBeenCalledWith(
        'npm',
        ['config', 'get', 'prefix', '--location', 'user'],
        expect.objectContaining({ shell: isWin })
      );
    });

    it('returns null on a nonzero exit code', async () => {
      const { exec } = await import('@/utils/exec.js');
      vi.mocked(exec).mockResolvedValue({ code: 1, stdout: '', stderr: 'boom' });
      const { getUserNpmPrefix } = await import('../npm-prefix.js');
      await expect(getUserNpmPrefix()).resolves.toBeNull();
    });

    it('returns null on empty output', async () => {
      const { exec } = await import('@/utils/exec.js');
      vi.mocked(exec).mockResolvedValue({ code: 0, stdout: '   ', stderr: '' });
      const { getUserNpmPrefix } = await import('../npm-prefix.js');
      await expect(getUserNpmPrefix()).resolves.toBeNull();
    });

    it('returns null when exec throws', async () => {
      const { exec } = await import('@/utils/exec.js');
      vi.mocked(exec).mockRejectedValue(new Error('spawn failed'));
      const { getUserNpmPrefix } = await import('../npm-prefix.js');
      await expect(getUserNpmPrefix()).resolves.toBeNull();
    });
  });

  describe('getSelfPrefixArgs', () => {
    const fakePrefix = isWin ? 'C:\\FakePrefix' : '/fake/prefix';
    const fakePackageDir = isWin
      ? nativePath.join(fakePrefix, 'node_modules', '@codemieai', 'code')
      : nativePath.join(fakePrefix, 'lib', 'node_modules', '@codemieai', 'code');

    beforeEach(async () => {
      vi.resetModules();
      vi.clearAllMocks();
      const { getDirname } = await import('@/utils/paths.js');
      vi.mocked(getDirname).mockReturnValue(fakePackageDir);
      const fs = await import('fs');
      vi.mocked(fs.existsSync).mockReturnValue(true);
    });

    it('returns the --prefix args when the derived prefix differs from the global prefix', async () => {
      const { exec } = await import('@/utils/exec.js');
      vi.mocked(exec).mockResolvedValue({ code: 0, stdout: `${nativePath.join(fakePrefix, '..', 'other')}\n`, stderr: '' });
      const { getSelfPrefixArgs, CODEMIE_PACKAGE } = await import('../npm-prefix.js');
      await expect(getSelfPrefixArgs(CODEMIE_PACKAGE)).resolves.toEqual(['--prefix', fakePrefix]);
    });

    it('returns [] when the derived prefix matches the global prefix', async () => {
      const { exec } = await import('@/utils/exec.js');
      vi.mocked(exec).mockResolvedValue({ code: 0, stdout: `${fakePrefix}\n`, stderr: '' });
      const { getSelfPrefixArgs, CODEMIE_PACKAGE } = await import('../npm-prefix.js');
      await expect(getSelfPrefixArgs(CODEMIE_PACKAGE)).resolves.toEqual([]);
    });

    it('returns [] for any package other than @codemieai/code', async () => {
      const { exec } = await import('@/utils/exec.js');
      const { getSelfPrefixArgs } = await import('../npm-prefix.js');
      await expect(getSelfPrefixArgs('@anthropic-ai/claude-code')).resolves.toEqual([]);
      expect(exec).not.toHaveBeenCalled();
    });

    it('returns [] when npm prefix -g fails', async () => {
      const { exec } = await import('@/utils/exec.js');
      vi.mocked(exec).mockResolvedValue({ code: 1, stdout: '', stderr: 'boom' });
      const { getSelfPrefixArgs, CODEMIE_PACKAGE } = await import('../npm-prefix.js');
      await expect(getSelfPrefixArgs(CODEMIE_PACKAGE)).resolves.toEqual([]);
    });

    it('returns [] when exec throws', async () => {
      const { exec } = await import('@/utils/exec.js');
      vi.mocked(exec).mockRejectedValue(new Error('spawn failed'));
      const { getSelfPrefixArgs, CODEMIE_PACKAGE } = await import('../npm-prefix.js');
      await expect(getSelfPrefixArgs(CODEMIE_PACKAGE)).resolves.toEqual([]);
    });

    it('memoizes the npm prefix -g lookup across calls', async () => {
      const { exec } = await import('@/utils/exec.js');
      vi.mocked(exec).mockResolvedValue({ code: 0, stdout: `${fakePrefix}\n`, stderr: '' });
      const { getSelfPrefixArgs, CODEMIE_PACKAGE } = await import('../npm-prefix.js');
      await getSelfPrefixArgs(CODEMIE_PACKAGE);
      await getSelfPrefixArgs(CODEMIE_PACKAGE);
      const prefixCalls = vi
        .mocked(exec)
        .mock.calls.filter(([, args]) => Array.isArray(args) && args.includes('-g'));
      expect(prefixCalls.length).toBe(1);
    });
  });
});
