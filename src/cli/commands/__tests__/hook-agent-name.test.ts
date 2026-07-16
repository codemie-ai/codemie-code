import { describe, it, expect } from 'vitest';
import { toWrapperAgentName } from '../hook.js';

describe('toWrapperAgentName', () => {
  it('prefixes short plugin names with codemie-', () => {
    expect(toWrapperAgentName('claude')).toBe('codemie-claude');
    expect(toWrapperAgentName('codex')).toBe('codemie-codex');
    expect(toWrapperAgentName('gemini')).toBe('codemie-gemini');
    expect(toWrapperAgentName('kimi')).toBe('codemie-kimi');
    expect(toWrapperAgentName('opencode')).toBe('codemie-opencode');
  });

  it('passes through names that already start with codemie-', () => {
    expect(toWrapperAgentName('codemie-code')).toBe('codemie-code');
    expect(toWrapperAgentName('codemie-claude')).toBe('codemie-claude');
    expect(toWrapperAgentName('codemie-cli')).toBe('codemie-cli');
  });

  it('normalises codemie_ (underscore) to codemie- (hyphen)', () => {
    expect(toWrapperAgentName('codemie_cli')).toBe('codemie-cli');
    expect(toWrapperAgentName('codemie_claude')).toBe('codemie-claude');
  });

  it('returns empty string unchanged', () => {
    expect(toWrapperAgentName('')).toBe('');
  });
});
