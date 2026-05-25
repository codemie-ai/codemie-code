/**
 * Unit tests for sanitize helpers.
 *
 * Spec §8.4 fields require credentials/home/control-char stripping plus length
 * caps before the wrapper sends them to /v1/skills/events.
 */

import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { capList, sanitizeSource } from '../sanitize.js';

describe('sanitizeSource', () => {
  it('returns undefined for empty/whitespace input', () => {
    expect(sanitizeSource(undefined)).toBeUndefined();
    expect(sanitizeSource('')).toBeUndefined();
    expect(sanitizeSource('   ')).toBeUndefined();
  });

  it('passes plain shorthand through unchanged', () => {
    expect(sanitizeSource('owner/repo')).toBe('owner/repo');
  });

  it('strips user:pass credentials from URLs', () => {
    expect(sanitizeSource('https://user:secret@github.com/owner/repo.git')).toBe(
      'https://github.com/owner/repo.git'
    );
  });

  it('strips bare user-only credentials from URLs', () => {
    expect(sanitizeSource('https://token@gitlab.com/group/project.git')).toBe(
      'https://gitlab.com/group/project.git'
    );
  });

  it('strips control characters', () => {
    expect(sanitizeSource('owner/repo\u0001\u001b')).toBe('owner/repo');
  });

  it('normalizes home directory to ~', () => {
    const home = os.homedir();
    expect(sanitizeSource(`${home}/my-skills`)).toBe('~/my-skills');
    expect(sanitizeSource(home)).toBe('~');
  });

  it('caps length at 256 chars and ends with ellipsis', () => {
    const longSource = `https://example.com/${'a'.repeat(400)}`;
    const sanitized = sanitizeSource(longSource);
    expect(sanitized).toBeDefined();
    expect(sanitized!.length).toBe(256);
    expect(sanitized!.endsWith('…')).toBe(true);
  });

  it('does not classify the source by domain', () => {
    // The sanitizer is intentionally domain-agnostic (spec §1).
    expect(sanitizeSource('https://github.com/x/y')).toBe('https://github.com/x/y');
    expect(sanitizeSource('https://gitlab.com/x/y')).toBe('https://gitlab.com/x/y');
    expect(sanitizeSource('https://bitbucket.org/x/y')).toBe('https://bitbucket.org/x/y');
    // Same shape for every host — no origin label baked in.
  });
});

describe('capList', () => {
  it('returns undefined for empty/missing lists', () => {
    expect(capList(undefined)).toBeUndefined();
    expect(capList([])).toBeUndefined();
    expect(capList(['', '   '])).toBeUndefined();
  });

  it('trims, drops empties, and caps at 20 items by default', () => {
    const input = Array.from({ length: 30 }, (_, i) => `skill-${i}`);
    const result = capList(input);
    expect(result).toHaveLength(20);
    expect(result![0]).toBe('skill-0');
    expect(result![19]).toBe('skill-19');
  });

  it('honors an explicit max', () => {
    expect(capList(['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
  });

  it('strips control characters from each element', () => {
    expect(capList(['valid', 'broken\u0001'])).toEqual(['valid', 'broken']);
  });

  it('caps individual element length at 128 chars', () => {
    const long = 'x'.repeat(200);
    const [result] = capList([long])!;
    expect(result.length).toBe(128);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('sanitizeSource: home edge cases', () => {
  it('handles empty home gracefully', () => {
    const spy = vi.spyOn(os, 'homedir').mockReturnValue('');
    try {
      expect(sanitizeSource('/some/path')).toBe('/some/path');
    } finally {
      spy.mockRestore();
    }
  });
});
