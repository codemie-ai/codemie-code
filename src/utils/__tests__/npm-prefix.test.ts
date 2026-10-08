import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

const isWin = process.platform === 'win32';
const nativePath = isWin ? path.win32 : path.posix;

vi.mock('@/utils/exec.js', () => ({
  exec: vi.fn()
}));

vi.mock('@/utils/paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/paths.js')>()),
  getDirname: vi.fn()
}));

vi.mock('fs');
vi.mock('fs/promises');

describe('npm-prefix', () => {
  describe('getCodemieNpmPrefix', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('derives the prefix from the win32 node_modules layout when codemie.cmd exists at the prefix', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      const { getCodemieNpmPrefix } = await import('../npm-prefix.js');
      const dir = path.win32.join('C:\\Users\\codemie', 'node_modules', '@codemieai', 'code');
      expect(getCodemieNpmPrefix(dir, 'win32')).toBe('C:\\Users\\codemie');
      expect(existsSync).toHaveBeenCalledWith(path.win32.join('C:\\Users\\codemie', 'codemie.cmd'));
    });

    it('returns null on win32 when codemie.cmd is missing at the derived prefix (local dependency or npx cache)', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);
      const { getCodemieNpmPrefix } = await import('../npm-prefix.js');
      const dir = path.win32.join('C:\\project', 'node_modules', '@codemieai', 'code');
      expect(getCodemieNpmPrefix(dir, 'win32')).toBeNull();
    });

    it('derives the prefix from the POSIX lib/node_modules layout', async () => {
      const { getCodemieNpmPrefix } = await import('../npm-prefix.js');
      const dir = path.posix.join('/usr/local', 'lib', 'node_modules', '@codemieai', 'code');
      expect(getCodemieNpmPrefix(dir, 'linux')).toBe('/usr/local');
    });

    it('returns null for a dev checkout that does not match the install layout', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      const { getCodemieNpmPrefix } = await import('../npm-prefix.js');
      expect(getCodemieNpmPrefix('/Users/dev/codemie-code', 'linux')).toBeNull();
      expect(getCodemieNpmPrefix('C:\\Users\\dev\\codemie-code', 'win32')).toBeNull();
    });
  });

  describe('getLegacyNpmPrefixPath', () => {
    it('uses LOCALAPPDATA\\CodeMie\\npm-prefix on win32', async () => {
      const original = process.env.LOCALAPPDATA;
      process.env.LOCALAPPDATA = 'C:\\Users\\codemie\\AppData\\Local';
      const { getLegacyNpmPrefixPath } = await import('../npm-prefix.js');
      expect(getLegacyNpmPrefixPath('win32')).toBe(
        path.join('C:\\Users\\codemie\\AppData\\Local', 'CodeMie', 'npm-prefix')
      );
      process.env.LOCALAPPDATA = original;
    });

    it('uses ~/.codemie/npm-prefix on non-win32 platforms', async () => {
      const { getLegacyNpmPrefixPath } = await import('../npm-prefix.js');
      const { homedir } = await import('os');
      expect(getLegacyNpmPrefixPath('linux')).toBe(path.join(homedir(), '.codemie', 'npm-prefix'));
    });
  });

  describe('parseNpmrcPrefix', () => {
    it('returns the last prefix value without quotes', async () => {
      const { parseNpmrcPrefix } = await import('../npm-prefix.js');
      const content = 'registry=https://r/\r\nprefix=/first\nprefix = "/Users/a/.codemie/npm-prefix"  \n';
      expect(parseNpmrcPrefix(content)).toBe('/Users/a/.codemie/npm-prefix');
    });

    it('returns null when no prefix is set', async () => {
      const { parseNpmrcPrefix } = await import('../npm-prefix.js');
      expect(parseNpmrcPrefix('registry=https://r/\n@codemieai:prefix=/x\n')).toBeNull();
    });
  });

  describe('getUserNpmrcPrefix', () => {
    beforeEach(() => {
      vi.resetModules();
      vi.clearAllMocks();
    });

    it('reads prefix from the file npm reports as userconfig', async () => {
      const { exec } = await import('@/utils/exec.js');
      vi.mocked(exec).mockResolvedValue({ code: 0, stdout: '/home/u/.npmrc\n', stderr: '' });
      const { readFile } = await import('fs/promises');
      vi.mocked(readFile).mockResolvedValue('prefix=/home/u/.codemie/npm-prefix\n');
      const { getUserNpmrcPrefix } = await import('../npm-prefix.js');

      await expect(getUserNpmrcPrefix()).resolves.toBe('/home/u/.codemie/npm-prefix');
      expect(exec).toHaveBeenCalledWith(
        'npm',
        ['config', 'get', 'userconfig'],
        expect.objectContaining({ shell: isWin })
      );
      expect(readFile).toHaveBeenCalledWith('/home/u/.npmrc', 'utf8');
    });

    it('returns null when npm cannot report the userconfig path', async () => {
      const { exec } = await import('@/utils/exec.js');
      vi.mocked(exec).mockResolvedValue({ code: 1, stdout: '', stderr: 'boom' });
      const { getUserNpmrcPrefix } = await import('../npm-prefix.js');
      await expect(getUserNpmrcPrefix()).resolves.toBeNull();
    });

    it('returns null when exec throws', async () => {
      const { exec } = await import('@/utils/exec.js');
      vi.mocked(exec).mockRejectedValue(new Error('spawn failed'));
      const { getUserNpmrcPrefix } = await import('../npm-prefix.js');
      await expect(getUserNpmrcPrefix()).resolves.toBeNull();
    });

    it('returns null when the userconfig file does not exist', async () => {
      const { exec } = await import('@/utils/exec.js');
      vi.mocked(exec).mockResolvedValue({ code: 0, stdout: '/home/u/.npmrc\n', stderr: '' });
      const { readFile } = await import('fs/promises');
      vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      const { getUserNpmrcPrefix } = await import('../npm-prefix.js');
      await expect(getUserNpmrcPrefix()).resolves.toBeNull();
    });
  });

  describe('getNpmPrefixArgs', () => {
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
      const { getNpmPrefixArgs } = await import('../npm-prefix.js');
      await expect(getNpmPrefixArgs()).resolves.toEqual(['--prefix', fakePrefix]);
    });

    it('returns [] when the derived prefix matches the global prefix', async () => {
      const { exec } = await import('@/utils/exec.js');
      vi.mocked(exec).mockResolvedValue({ code: 0, stdout: `${fakePrefix}\n`, stderr: '' });
      const { getNpmPrefixArgs } = await import('../npm-prefix.js');
      await expect(getNpmPrefixArgs()).resolves.toEqual([]);
    });

    it('returns [] without calling npm when running from a dev checkout', async () => {
      const { getDirname } = await import('@/utils/paths.js');
      vi.mocked(getDirname).mockReturnValue(nativePath.join(fakePrefix, 'codemie-code'));
      const { exec } = await import('@/utils/exec.js');
      const { getNpmPrefixArgs } = await import('../npm-prefix.js');
      await expect(getNpmPrefixArgs()).resolves.toEqual([]);
      expect(exec).not.toHaveBeenCalled();
    });

    it('returns [] when npm prefix -g fails', async () => {
      const { exec } = await import('@/utils/exec.js');
      vi.mocked(exec).mockResolvedValue({ code: 1, stdout: '', stderr: 'boom' });
      const { getNpmPrefixArgs } = await import('../npm-prefix.js');
      await expect(getNpmPrefixArgs()).resolves.toEqual([]);
    });

    it('returns [] when exec throws', async () => {
      const { exec } = await import('@/utils/exec.js');
      vi.mocked(exec).mockRejectedValue(new Error('spawn failed'));
      const { getNpmPrefixArgs } = await import('../npm-prefix.js');
      await expect(getNpmPrefixArgs()).resolves.toEqual([]);
    });

    it('memoizes the npm prefix -g lookup across calls', async () => {
      const { exec } = await import('@/utils/exec.js');
      vi.mocked(exec).mockResolvedValue({ code: 0, stdout: `${fakePrefix}\n`, stderr: '' });
      const { getNpmPrefixArgs } = await import('../npm-prefix.js');
      await getNpmPrefixArgs();
      await getNpmPrefixArgs();
      const prefixCalls = vi
        .mocked(exec)
        .mock.calls.filter(([, args]) => Array.isArray(args) && args.includes('-g'));
      expect(prefixCalls.length).toBe(1);
    });
  });
});
