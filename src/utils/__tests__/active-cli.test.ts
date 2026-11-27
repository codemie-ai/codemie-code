/**
 * Install resolution of a `codemie` command path, for each platform's npm layout.
 * @group unit
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCommandPath } from '@/utils/processes.js';
import { findActiveCli, findFirstManifest, formatStaleWarning, resolvePackage } from '../active-cli.js';
import { NPM_WIN32_SHIMS } from '../../../tests/helpers/npm-shims.js';

// A disk of the platform under test, whatever platform runs the test: paths as that platform writes them.
const disk = vi.hoisted(() => ({
  files: new Map<string, string>(),
  links: new Map<string, string>(),
  unreadable: new Set<string>(),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const missing = (path: string): Error => Object.assign(new Error(`ENOENT: no such file '${path}'`), { code: 'ENOENT' });
  return {
    ...actual,
    readFile: async (path: string) => {
      if (disk.unreadable.has(path)) {
        throw Object.assign(new Error(`EACCES: permission denied '${path}'`), { code: 'EACCES' });
      }
      const text = disk.files.get(path);
      if (text === undefined) throw missing(path);
      return text;
    },
    realpath: async (path: string) => {
      if (!disk.files.has(path) && !disk.links.has(path)) throw missing(path);
      return disk.links.get(path) ?? path;
    },
  };
});

vi.mock('@/utils/processes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/processes.js')>()),
  getCommandPath: vi.fn(),
}));

const MANIFEST = { name: '@codemieai/code', version: '0.17.0' };

afterEach(() => {
  disk.files.clear();
  disk.links.clear();
  disk.unreadable.clear();
});

describe('resolvePackage', () => {
  it('resolves an npm codemie.cmd on win32 to the package beside it under node_modules', async () => {
    disk.files.set('C:\\npm\\codemie.cmd', NPM_WIN32_SHIMS['codemie.cmd']);
    disk.files.set('C:\\npm\\node_modules\\@codemieai\\code\\package.json', JSON.stringify(MANIFEST));

    expect(await resolvePackage('C:\\npm\\codemie.cmd', 'win32')).toEqual({
      dir: 'C:\\npm\\node_modules\\@codemieai\\code',
      manifest: MANIFEST,
    });
  });

  it('resolves npm\'s sh shim in a win32 prefix to the package beside it under node_modules', async () => {
    disk.files.set('C:\\npm\\codemie', NPM_WIN32_SHIMS.codemie);
    disk.files.set('C:\\npm\\node_modules\\@codemieai\\code\\package.json', JSON.stringify(MANIFEST));

    expect(await resolvePackage('C:\\npm\\codemie', 'win32')).toEqual({
      dir: 'C:\\npm\\node_modules\\@codemieai\\code',
      manifest: MANIFEST,
    });
  });

  it('answers why not for a win32 codemie.cmd whose package has no package.json', async () => {
    disk.files.set('C:\\npm\\codemie.cmd', NPM_WIN32_SHIMS['codemie.cmd']);

    expect(await resolvePackage('C:\\npm\\codemie.cmd', 'win32')).toBe(
      'package.json of the first codemie on PATH is unreadable'
    );
  });

  it('rejects for a win32 shim that cannot be read', async () => {
    disk.unreadable.add('C:\\npm\\codemie.cmd');

    await expect(resolvePackage('C:\\npm\\codemie.cmd', 'win32')).rejects.toThrow(
      "EACCES: permission denied 'C:\\npm\\codemie.cmd'"
    );
  });

  it('answers why not for a win32 codemie.cmd that names no @codemieai/code', async () => {
    disk.files.set('C:\\tools\\codemie.cmd', '"C:\\tools\\other\\codemie.exe" %*\r\n');

    expect(await resolvePackage('C:\\tools\\codemie.cmd', 'win32')).toBe(
      'first codemie on PATH is not an npm install of @codemieai/code'
    );
  });

  it('resolves a symlinked POSIX shim to the package its target is in', async () => {
    const pkg = '/usr/local/lib/node_modules/@codemieai/code';
    disk.files.set(`${pkg}/bin/codemie.js`, '');
    disk.files.set(`${pkg}/package.json`, JSON.stringify(MANIFEST));
    disk.links.set('/usr/local/bin/codemie', `${pkg}/bin/codemie.js`);

    expect(await resolvePackage('/usr/local/bin/codemie', 'linux')).toEqual({ dir: pkg, manifest: MANIFEST });
  });
});

describe('findFirstManifest', () => {
  it('finds the package above a bin/ directory', async () => {
    disk.files.set('/opt/codemie/package.json', JSON.stringify(MANIFEST));

    expect(await findFirstManifest('/opt/codemie/bin', 'linux')).toEqual({ dir: '/opt/codemie', manifest: MANIFEST });
  });

  it('answers null when no package.json is above', async () => {
    expect(await findFirstManifest('/opt/codemie/bin', 'linux')).toBeNull();
  });

  it('finds the package above a win32 bin\\ directory', async () => {
    disk.files.set('C:\\npm\\node_modules\\@codemieai\\code\\package.json', JSON.stringify(MANIFEST));

    expect(await findFirstManifest('C:\\npm\\node_modules\\@codemieai\\code\\bin', 'win32')).toEqual({
      dir: 'C:\\npm\\node_modules\\@codemieai\\code',
      manifest: MANIFEST,
    });
  });

  it('answers null when no package.json is above a win32 directory up to the drive root', async () => {
    expect(await findFirstManifest('C:\\npm\\node_modules\\@codemieai\\code\\bin', 'win32')).toBeNull();
  });
});

describe('findActiveCli', () => {
  it('answers unknown, not a throw, when the shim the PATH lookup names cannot be read', async () => {
    disk.unreadable.add('C:\\npm\\codemie.cmd');
    vi.mocked(getCommandPath).mockResolvedValue('C:\\npm\\codemie.cmd');

    expect(await findActiveCli('win32')).toEqual({
      status: 'unknown',
      reason: "could not inspect first codemie on PATH: EACCES: permission denied 'C:\\npm\\codemie.cmd'",
    });
  });
});

describe('formatStaleWarning', () => {
  const B = String.fromCharCode(92);
  const old = `D:${B}old`;
  const active = { path: `${old}${B}codemie.cmd`, version: '1.0.0', prefix: old };

  it('keeps the exact output with a known new prefix', () => {
    expect(
      formatStaleWarning({ status: 'stale', active, installedVersion: '2.0.0', newPrefix: `C:${B}new` }, 'win32')
    ).toEqual([
      '⚠ The codemie on your PATH is older than the version just installed.',
      `  Active:    ${old}${B}codemie.cmd (version 1.0.0)`,
      '  Installed: 2.0.0',
      '',
      '  To use the new version:',
      `  - Put "C:${B}new" ahead of "${old}" on your PATH`,
      '  - Or remove the old install:',
      `    npm uninstall -g @codemieai/code --prefix "${old}"`,
      '  Then open a new terminal.',
    ]);
  });

  it('keeps the exact output without a new prefix', () => {
    expect(
      formatStaleWarning(
        { status: 'stale', active: { ...active, prefix: null }, installedVersion: '2.0.0', newPrefix: null },
        'win32'
      )
    ).toEqual([
      '⚠ The codemie on your PATH is older than the version just installed.',
      `  Active:    ${old}${B}codemie.cmd (version 1.0.0)`,
      '  Installed: 2.0.0',
      '',
      '  To use the new version:',
      `  - Put the bin directory of the new install ahead of "${old}" on your PATH`,
      '  Then open a new terminal.',
    ]);
  });
});
