import { describe, it, expect } from 'vitest';
import { agentMatchesAnalyticsFilter, isCodexFamilyAgent } from '../codex-agent.js';

describe('isCodexFamilyAgent', () => {
  it('matches native codex and codemie-codex wrapper', () => {
    expect(isCodexFamilyAgent('codex')).toBe(true);
    expect(isCodexFamilyAgent('codemie-codex')).toBe(true);
    expect(isCodexFamilyAgent('claude')).toBe(false);
  });
});

describe('agentMatchesAnalyticsFilter', () => {
  it('treats --agent codex as the whole codex family', () => {
    expect(agentMatchesAnalyticsFilter('codex', 'codex')).toBe(true);
    expect(agentMatchesAnalyticsFilter('codemie-codex', 'codex')).toBe(true);
    expect(agentMatchesAnalyticsFilter('claude', 'codex')).toBe(false);
  });

  it('filters codemie-codex narrowly', () => {
    expect(agentMatchesAnalyticsFilter('codemie-codex', 'codemie-codex')).toBe(true);
    expect(agentMatchesAnalyticsFilter('codex', 'codemie-codex')).toBe(false);
  });
});
