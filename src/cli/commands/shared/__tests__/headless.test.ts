import { describe, it, expect } from 'vitest';
import {
  isHeadlessMode,
  requireFlag,
  parseScopeFlag,
  parseListFlag,
  resolveHeadlessAgentTarget,
  partitionRegisteredByRequest,
} from '../headless.js';
import { ConfigurationError } from '@/utils/errors.js';
import { StorageScope } from '@/env/types.js';

describe('isHeadlessMode', () => {
  it('is true when yes is set', () => {
    expect(isHeadlessMode({ yes: true }, true)).toBe(true);
  });

  it('is true when assistant is set', () => {
    expect(isHeadlessMode({ assistant: 'my-assistant' }, true)).toBe(true);
  });

  it('is true when skill is set', () => {
    expect(isHeadlessMode({ skill: 'my-skill' }, true)).toBe(true);
  });

  it('is true when isTty is false, even with no flags', () => {
    expect(isHeadlessMode({}, false)).toBe(true);
  });

  it('is false for an empty flags object at a TTY', () => {
    expect(isHeadlessMode({}, true)).toBe(false);
  });

  it('is false at a TTY for the pre-existing wizard preselectors alone', () => {
    // `--agent`, `--scope` and `--mode` must never divert a TTY invocation into
    // headless mode: `codemie setup assistants --agent claude` shipped as a
    // wizard invocation and has to keep running the wizard.
    expect(isHeadlessMode({ agent: 'claude' }, true)).toBe(false);
    expect(isHeadlessMode({ scope: 'global' }, true)).toBe(false);
    expect(isHeadlessMode({ mode: 'agent' }, true)).toBe(false);
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

describe('resolveHeadlessAgentTarget', () => {
  it('parses an explicit --agent value', () => {
    expect(resolveHeadlessAgentTarget('codex,gemini')).toEqual(['codex', 'gemini']);
  });

  it('falls back to the host agent when --agent is absent', () => {
    expect(resolveHeadlessAgentTarget(undefined, 'claude')).toEqual(['claude']);
  });

  it('prefers an explicit --agent value over the host agent', () => {
    expect(resolveHeadlessAgentTarget('codex', 'claude')).toEqual(['codex']);
  });

  it('throws ConfigurationError naming --agent when neither is available', () => {
    expect(() => resolveHeadlessAgentTarget(undefined)).toThrow(ConfigurationError);
    expect(() => resolveHeadlessAgentTarget(undefined)).toThrow(/--agent/);
  });

  it('throws ConfigurationError for an unsupported agent name', () => {
    expect(() => resolveHeadlessAgentTarget('emacs')).toThrow(ConfigurationError);
  });
});

describe('partitionRegisteredByRequest', () => {
  const registered = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('splits the registered records into requested and untouched', () => {
    const { inScope, untouched } = partitionRegisteredByRequest(registered, ['b']);

    expect(inScope).toEqual([{ id: 'b' }]);
    expect(untouched).toEqual([{ id: 'a' }, { id: 'c' }]);
  });

  it('treats every record as untouched for an empty request', () => {
    const { inScope, untouched } = partitionRegisteredByRequest(registered, []);

    expect(inScope).toEqual([]);
    expect(untouched).toEqual(registered);
  });
});
