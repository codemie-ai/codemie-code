import { describe, it, expect } from 'vitest';
import { resolveLaunchModelDisplay } from '../launch-model-display.js';

describe('resolveLaunchModelDisplay', () => {
  it('shows the explicit CLI model on the subscription profile', () => {
    expect(resolveLaunchModelDisplay('anthropic-subscription', '', 'claude-opus-4-5')).toBe('claude-opus-4-5');
  });

  it('shows a per-session phrase (not "unknown") when no CLI model on subscription', () => {
    const s = resolveLaunchModelDisplay('anthropic-subscription', '', undefined);
    expect(s).not.toBe('unknown');
    expect(s).toMatch(/Claude Code/i);
  });

  it('is unchanged for non-subscription providers', () => {
    expect(resolveLaunchModelDisplay('litellm', 'gpt-5.5', undefined)).toBe('gpt-5.5');
    expect(resolveLaunchModelDisplay('litellm', '', undefined)).toBe('unknown');
  });
});
