import { describe, it, expect } from 'vitest';
import { classifyShadow } from '../path-shadow.js';
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
