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

describe('agentMatchesAnalyticsFilter — new agents', () => {
  it.each([
    // Short-name filter: broad — matches both short and codemie- prefixed sessions
    ['claude',          'claude'],
    ['codemie-claude',  'claude'],
    ['gemini',          'gemini'],
    ['codemie-gemini',  'gemini'],
    ['kimi',            'kimi'],
    ['codemie-kimi',    'kimi'],
    ['opencode',        'opencode'],
    ['codemie-opencode','opencode'],
  ] as [string, string][])('"%s" session + "%s" filter → match (short broad)', (session, filter) => {
    expect(agentMatchesAnalyticsFilter(session, filter)).toBe(true);
  });

  it.each([
    // Exact wrapper filter: narrow — only the exact codemie- name
    ['codemie-claude',   'codemie-claude'],
    ['codemie-gemini',   'codemie-gemini'],
    ['codemie-kimi',     'codemie-kimi'],
    ['codemie-opencode', 'codemie-opencode'],
    ['codemie-cli',      'codemie-cli'],
    // Legacy underscore normalised to hyphen form
    ['codemie-cli',      'codemie_cli'],
    ['codemie_cli',      'codemie-cli'],
    ['codemie_cli',      'codemie_cli'],
  ] as [string, string][])('"%s" session + "%s" filter → match (exact wrapper)', (session, filter) => {
    expect(agentMatchesAnalyticsFilter(session, filter)).toBe(true);
  });

  it('exact codemie-claude filter does NOT match short-name claude session', () => {
    expect(agentMatchesAnalyticsFilter('claude', 'codemie-claude')).toBe(false);
  });

  it('does not cross-match different agents', () => {
    expect(agentMatchesAnalyticsFilter('codemie-claude', 'codemie-gemini')).toBe(false);
    expect(agentMatchesAnalyticsFilter('claude', 'gemini')).toBe(false);
  });

  it('returns false for undefined session agent (marker/non-session files)', () => {
    expect(agentMatchesAnalyticsFilter(undefined, 'claude')).toBe(false);
    expect(agentMatchesAnalyticsFilter(undefined, 'codemie-claude')).toBe(false);
  });
});
