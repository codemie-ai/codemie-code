import { describe, it, expect } from 'vitest';
import { newerVersionPromptDefault, olderSupportedModelNote } from '../version-prompt-policy.js';

describe('version-prompt-policy', () => {
  it('defaults the newer-than-pinned prompt to continue for anthropic-subscription', () => {
    expect(newerVersionPromptDefault('anthropic-subscription')).toBe('continue');
  });

  it('keeps install as the default for proxied providers and when unknown', () => {
    expect(newerVersionPromptDefault('ai-run-sso')).toBe('install');
    expect(newerVersionPromptDefault('litellm')).toBe('install');
    expect(newerVersionPromptDefault(undefined)).toBe('install');
  });

  it('returns the older-but-supported note only for anthropic-subscription', () => {
    expect(olderSupportedModelNote('anthropic-subscription')).toMatch(/newer models/i);
    expect(olderSupportedModelNote('litellm')).toBeNull();
    expect(olderSupportedModelNote(undefined)).toBeNull();
  });
});
