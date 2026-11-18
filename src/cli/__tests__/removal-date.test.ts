import { describe, it, expect, vi } from 'vitest';
import { createProgram } from '../program.js';
import {
  listDeprecations,
  findPastDue,
  isReleaseGate,
  type DeprecationEntry,
} from '../deprecation.js';

describe('removal-date gate predicate', () => {
  it('is a release gate on main, tags and release events only', () => {
    expect(isReleaseGate({ GITHUB_REF: 'refs/heads/main' })).toBe(true);
    expect(isReleaseGate({ GITHUB_REF: 'refs/tags/v1.2.3' })).toBe(true);
    expect(isReleaseGate({ GITHUB_EVENT_NAME: 'release' })).toBe(true);
    expect(isReleaseGate({ GITHUB_REF: 'refs/heads/feat/x' })).toBe(false);
    expect(isReleaseGate({})).toBe(false);
  });
});

describe('findPastDue', () => {
  const entries: DeprecationEntry[] = [
    { kind: 'deprecated', old: 'a', replacement: 'b' },
    { kind: 'deprecated', old: 'c', replacement: 'd', removeOn: '2027-03-01' },
    { kind: 'removed', old: 'e', replacement: 'f', dropOn: '2026-12-31' },
  ];
  it('defaults removeOn and treats dropOn alike', () => {
    expect(findPastDue(entries, new Date('2026-12-30')).map((e) => e.old)).toEqual([]);
    expect(findPastDue(entries, new Date('2027-01-01')).map((e) => e.old)).toEqual(['a', 'e']);
    expect(findPastDue(entries, new Date('2027-04-01')).map((e) => e.old)).toEqual(['a', 'c', 'e']);
  });
});

describe('registered deprecations past their removal date', () => {
  it('none remain once the date has passed (fails on release gates, warns otherwise)', () => {
    createProgram();
    const pastDue = findPastDue(listDeprecations(), new Date());
    if (pastDue.length === 0) return;
    const message = `Past removal date, still registered: ${pastDue.map((e) => e.old).join(', ')}`;
    if (isReleaseGate(process.env)) {
      expect.fail(message);
    } else {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      console.warn(message);
    }
  });
});
