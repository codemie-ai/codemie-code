import { describe, it, expect } from 'vitest';
import { isHeadlessMode, requireFlag, parseScopeFlag, parseListFlag } from '../headless.js';
import { ConfigurationError } from '@/utils/errors.js';
import { StorageScope } from '@/env/types.js';

describe('isHeadlessMode', () => {
  it('is true when yes is set', () => {
    expect(isHeadlessMode({ yes: true }, true)).toBe(true);
  });

  it('is true when scope is set', () => {
    expect(isHeadlessMode({ scope: 'global' }, true)).toBe(true);
  });

  it('is true when agent is set', () => {
    expect(isHeadlessMode({ agent: 'claude' }, true)).toBe(true);
  });

  it('is true when assistant is set', () => {
    expect(isHeadlessMode({ assistant: 'my-assistant' }, true)).toBe(true);
  });

  it('is true when skill is set', () => {
    expect(isHeadlessMode({ skill: 'my-skill' }, true)).toBe(true);
  });

  it('is true when mode is set', () => {
    expect(isHeadlessMode({ mode: 'install' }, true)).toBe(true);
  });

  it('is true when isTty is false, even with no flags', () => {
    expect(isHeadlessMode({}, false)).toBe(true);
  });

  it('is false for an empty flags object at a TTY', () => {
    expect(isHeadlessMode({}, true)).toBe(false);
  });
});

describe('requireFlag', () => {
  it('returns the value when present', () => {
    expect(requireFlag('global', '--scope')).toBe('global');
  });

  it('throws ConfigurationError naming the flag when missing', () => {
    expect(() => requireFlag(undefined, '--scope')).toThrow(ConfigurationError);
    expect(() => requireFlag(undefined, '--scope')).toThrow(/--scope/);
  });
});

describe('parseScopeFlag', () => {
  it('parses a valid scope case-insensitively', () => {
    expect(parseScopeFlag('LOCAL')).toBe(StorageScope.LOCAL);
    expect(parseScopeFlag('global')).toBe(StorageScope.GLOBAL);
  });

  it('throws ConfigurationError for an invalid scope', () => {
    expect(() => parseScopeFlag('repo')).toThrow(ConfigurationError);
    expect(() => parseScopeFlag('repo')).toThrow(/repo/);
  });
});

describe('parseListFlag', () => {
  it('splits, trims, and de-dupes comma-separated values', () => {
    expect(parseListFlag('a, b ,a')).toEqual(['a', 'b']);
  });

  it('throws ConfigurationError when no non-empty values remain', () => {
    expect(() => parseListFlag(' ')).toThrow(ConfigurationError);
  });
});
