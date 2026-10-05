import { describe, it, expect } from 'vitest';
import {
  addProjectPath,
  isPathInside,
  isProjectTracked,
  parseAllowlist,
  removeProjectPath,
} from '../claude-code-otlp.allowlist.js';

describe('parseAllowlist', () => {
  it('maps values to states', () => {
    expect(parseAllowlist(undefined)).toEqual({ kind: 'absent' });
    expect(parseAllowlist('[]')).toEqual({ kind: 'valid', paths: [] });
    expect(parseAllowlist('["/a/b"]')).toEqual({ kind: 'valid', paths: ['/a/b'] });
    for (const bad of ['nope', '{}', '["rel/path"]', '[""]', '[1]', 5]) {
      expect(parseAllowlist(bad)).toEqual({ kind: 'invalid' });
    }
  });
});

describe('isPathInside', () => {
  it('uses path semantics, not string prefixes', () => {
    expect(isPathInside('/a/b', '/a/b')).toBe(true);
    expect(isPathInside('/a/b/c', '/a/b')).toBe(true);
    expect(isPathInside('/a/bc', '/a/b')).toBe(false);
    expect(isPathInside('/a', '/a/b')).toBe(false);
  });

  it('treats a child directory literally named "..foo" as inside', () => {
    expect(isPathInside('/a/b/..foo', '/a/b')).toBe(true);
    expect(isPathInside('/a/b/..foo/c', '/a/b')).toBe(true);
  });

  it('treats a parent-relative sibling as outside', () => {
    expect(isPathInside('/a/x', '/a/b')).toBe(false);
    expect(isPathInside('/a/b/../x', '/a/b')).toBe(false);
  });
});

describe('isProjectTracked', () => {
  it('handles each state', async () => {
    expect(await isProjectTracked('/x', { kind: 'absent' })).toBe(true);
    expect(await isProjectTracked('/x', { kind: 'valid', paths: [] })).toBe(true);
    expect(await isProjectTracked('/x', { kind: 'invalid' })).toBe(false);
    expect(await isProjectTracked(undefined, { kind: 'valid', paths: ['/a/b'] })).toBe(false);
    expect(await isProjectTracked('/a/b/c', { kind: 'valid', paths: ['/a/b/'] })).toBe(true);
    expect(await isProjectTracked('/a/bc', { kind: 'valid', paths: ['/a/b'] })).toBe(false);
  });
});

describe('add/removeProjectPath', () => {
  it('dedupes on add and removes by raw string', async () => {
    const once = await addProjectPath([], '/nonexistent/proj');
    expect(await addProjectPath(once, '/nonexistent/proj/')).toEqual(once);
    expect(await removeProjectPath(once, '/nonexistent/proj')).toEqual([]);
    expect(await removeProjectPath(['/gone/raw'], '/gone/raw')).toEqual([]);
  });
});
