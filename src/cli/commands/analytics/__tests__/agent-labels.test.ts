import { describe, it, expect } from 'vitest';
import { agentLabel } from '../agent-labels.js';

describe('agentLabel', () => {
  it('returns "Gemini CLI" for the gemini agent key', () => {
    expect(agentLabel('gemini')).toBe('Gemini CLI');
  });

  it('returns "GitHub Copilot CLI" for the copilot-cli agent key', () => {
    expect(agentLabel('copilot-cli')).toBe('GitHub Copilot CLI');
  });

  it('returns the key unchanged for unmapped agents', () => {
    expect(agentLabel('unknown-agent')).toBe('unknown-agent');
    expect(agentLabel('claude')).toBe('claude');
  });
});
