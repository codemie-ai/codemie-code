/**
 * resolveOutputTargets — pure path computation for the analytics `-o` flag.
 * See docs/superpowers/tasks/2026-09-26-unify-analytics-cost-command/spec.md, section A.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOutputTargets } from '../output-target.js';
import { getDefaultReportPath, getDefaultReportJsonPath } from '../report-generator.js';

describe('resolveOutputTargets', () => {
  const dirs: string[] = [];
  const makeTmpDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'output-target-'));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the default report paths in cwd when no -o is given', () => {
    const cwd = makeTmpDir();
    const result = resolveOutputTargets('both', undefined, cwd, 'user@example.com');
    expect(result).toEqual({
      html: getDefaultReportPath(cwd, 'user@example.com'),
      json: getDefaultReportJsonPath(cwd, 'user@example.com'),
      isDefault: true,
    });
  });

  it('treats a missing path ending with a separator as a directory target', () => {
    const cwd = makeTmpDir();
    const result = resolveOutputTargets('html', 'tmp/new/', cwd, undefined);
    const expectedDir = join(cwd, 'tmp/new/');
    expect(result).toEqual({
      html: getDefaultReportPath(expectedDir, undefined),
      isDefault: false,
    });
  });

  it('treats an existing directory without a trailing slash as a directory target', () => {
    const cwd = makeTmpDir();
    const existingDir = join(cwd, 'reports');
    mkdirSync(existingDir);
    const result = resolveOutputTargets('both', 'reports', cwd, 'user@example.com');
    expect(result).toEqual({
      html: getDefaultReportPath(existingDir, 'user@example.com'),
      json: getDefaultReportJsonPath(existingDir, 'user@example.com'),
      isDefault: false,
    });
  });

  it('splits a file target ending in .json into <base>.html and <base>.report.json for "both"', () => {
    const cwd = makeTmpDir();
    const result = resolveOutputTargets('both', 'x.json', cwd, undefined);
    expect(result).toEqual({
      html: join(cwd, 'x.html'),
      json: join(cwd, 'x.report.json'),
      isDefault: false,
    });
  });

  it('uses a file target ending in .json as-is for format "json"', () => {
    const cwd = makeTmpDir();
    const result = resolveOutputTargets('json', 'x.json', cwd, undefined);
    expect(result).toEqual({
      json: join(cwd, 'x.json'),
      isDefault: false,
    });
  });

  it('does not throw for a missing path with no trailing separator', () => {
    const cwd = makeTmpDir();
    expect(() => resolveOutputTargets('html', 'does/not/exist.html', cwd, undefined)).not.toThrow();
  });
});
