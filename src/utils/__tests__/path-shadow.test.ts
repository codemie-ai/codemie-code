import { describe, it, expect } from 'vitest';
import {
  classifyShadow,
  formatShadowWarning,
  formatNotOnPathHint,
  formatNotOnPathShort,
} from '../path-shadow.js';
import { isSamePath } from '../paths.js';

const samePath = (a: string, b: string): boolean => isSamePath(a, b, 'win32');
const managedDir = 'C:\\Users\\me\\.codemie\\npm-global';
const shim = `${managedDir}\\claude.cmd`;

describe('classifyShadow', () => {
  it('returns shadowed when another dir comes first and a later match is managed', () => {
    const v = classifyShadow({
      matches: ['C:\\Other\\claude.cmd', `${managedDir}\\claude.cmd`],
      managedDir, managedShimPath: shim, samePath,
    });
    expect(v).toEqual({ status: 'shadowed', active: 'C:\\Other\\claude.cmd', managedDir });
  });

  it('returns shadowed when only a foreign match exists but the managed shim is on disk', () => {
    const v = classifyShadow({ matches: ['C:\\Other\\claude.cmd'], managedDir, managedShimPath: shim, samePath });
    expect(v.status).toBe('shadowed');
  });

  it('returns clear when only a foreign match exists and no managed install', () => {
    const v = classifyShadow({ matches: ['C:\\Other\\claude.cmd'], managedDir, managedShimPath: null, samePath });
    expect(v).toEqual({ status: 'clear' });
  });

  it('treats case, trailing separator and extension variants of the managed dir as clear', () => {
    for (const first of [
      'c:\\users\\ME\\.codemie\\npm-global\\claude.cmd',
      `${managedDir}\\claude`,
      'C:/Users/me/.codemie/npm-global/claude.cmd',
    ]) {
      const v = classifyShadow({
        matches: [first, 'C:\\Other\\claude.cmd'], managedDir: `${managedDir}\\`, managedShimPath: shim, samePath,
      });
      expect(v).toEqual({ status: 'clear' });
    }
  });

  it('returns missing-on-path for zero matches with a managed shim', () => {
    expect(classifyShadow({ matches: [], managedDir, managedShimPath: shim, samePath }))
      .toEqual({ status: 'missing-on-path', managedDir, shimPath: shim });
  });

  it('returns missing for zero matches without a managed shim', () => {
    expect(classifyShadow({ matches: [], managedDir, managedShimPath: null, samePath })).toEqual({ status: 'missing' });
  });

  it('returns unknown for null matches or null managedDir', () => {
    expect(classifyShadow({ matches: null, managedDir, managedShimPath: shim, samePath })).toEqual({ status: 'unknown' });
    expect(classifyShadow({ matches: ['C:\\a\\x.cmd'], managedDir: null, managedShimPath: null, samePath }))
      .toEqual({ status: 'unknown' });
  });
});

describe('shadow formatters', () => {
  const B = String.fromCharCode(92);
  const mDir = `C:${B}Users${B}me${B}.codemie${B}npm-global`;
  const active = `C:${B}Other${B}claude.cmd`;
  const shadowed = { status: 'shadowed' as const, active, managedDir: mDir };
  const missing = { status: 'missing-on-path' as const, managedDir: mDir, shimPath: `${mDir}${B}claude.cmd` };

  it('shadow warning names both locations, command, new terminal and remedies', () => {
    const text = formatShadowWarning(shadowed, 'win32').join('\n');
    expect(text).toContain(active);
    expect(text).toContain(mDir);
    expect(text).toContain(`Put "${mDir}" ahead of "C:${B}Other" on your PATH`);
    expect(text).toContain("'" + mDir + ";'+$k.GetValue('Path','','DoNotExpandEnvironmentNames')");
    expect(text).toContain("'ExpandString'");
    expect(text).not.toContain('SetEnvironmentVariable');
    expect(text).toContain('open a new terminal');
    expect(text).toMatch(/remove or rename/i);
    expect(text).toMatch(/machine-wide PATH as administrator/);
  });

  it('shadow warning omits the copy-paste command for unsafe directories', () => {
    for (const bad of [`C:${B}a;b`, `C:${B}100%${B}x`, `C:${B}it's`, `C:${B}q"x`, `C:${B}t\tab`, `C:${B}O’Brien`, `C:${B}q“x`]) {
      const text = formatShadowWarning({ ...shadowed, managedDir: bad }, 'win32').join('\n');
      expect(text).not.toContain('OpenSubKey');
      expect(text).toContain('open a new terminal');
    }
  });

  it('not-on-path hint names the shim location and the add command', () => {
    const text = formatNotOnPathHint(missing, 'win32').join('\n');
    expect(text).toContain('not found on PATH');
    expect(text).toContain(mDir);
    expect(text).toContain("OpenSubKey('Environment',$true)");
    expect(text).toContain("DoNotExpandEnvironmentNames')+';" + mDir + "'");
    expect(text).toContain("'ExpandString'");
    expect(text).not.toContain('SetEnvironmentVariable');
    expect(text).toContain('open a new terminal');
  });

  it('not-on-path hint has no command for unsafe directories', () => {
    const text = formatNotOnPathHint({ ...missing, managedDir: `C:${B}a;b` }, 'win32').join('\n');
    expect(text).not.toContain('OpenSubKey');
    expect(text).toContain('not found on PATH');
  });

  it('short form is one line', () => {
    expect(formatNotOnPathShort(missing)).toBe(`not found on PATH — shim at ${mDir}`);
  });
});
