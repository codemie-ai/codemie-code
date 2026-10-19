import { describe, it, expect } from 'vitest';
import { classifyModelForAgent, getClassifierAgents } from '../../core/model-compat.js';
import { isClaudeCompatibleModelName } from '../claude/claude.models.js';

describe('per-agent classifyModel hooks (via AgentRegistry)', () => {
  it.each([
    ['codex', 'claude-sonnet-4-5', 'incompatible'],
    ['claude', 'gpt-5.5', 'incompatible'],
    ['claude', 'claude-sonnet-4-5', 'compatible'],
    ['codex', 'gpt-5.4', 'compatible'],
    ['gemini', 'gemini-2.5-pro', 'compatible'],
    ['gemini', 'claude-sonnet-4-5', 'incompatible'],
    ['kimi', 'kimi-k2', 'compatible'],
    ['kimi', 'gpt-5.4', 'incompatible'],
    ['claude-acp', 'gpt-5.5', 'incompatible'],
    ['codex', 'sy-router', 'unverified'],
    ['codex', 'claude-smart-router', 'incompatible'],
    ['opencode', 'anything', 'compatible'],
    ['pi', 'anything', 'compatible'],
    ['codemie-code', 'anything', 'compatible'],
    ['openwiki', 'anything', 'compatible'],
    ['copilot-cli', 'anything', 'compatible'],
  ] as const)('%s + %s is %s', (agent, id, expected) => {
    expect(classifyModelForAgent(agent, id)).toBe(expected);
  });

  it('exposes classifiers only for claude, codex, gemini and kimi', () => {
    expect(getClassifierAgents().sort()).toEqual(['claude', 'codex', 'gemini', 'kimi']);
  });

  it('isClaudeCompatibleModelName rejects non-chat and non-Claude names', () => {
    expect(isClaudeCompatibleModelName('claude-opus-4')).toBe(true);
    expect(isClaudeCompatibleModelName('sonnet')).toBe(true);
    expect(isClaudeCompatibleModelName('claude-embedding')).toBe(false);
    expect(isClaudeCompatibleModelName('gpt-5')).toBe(false);
    expect(isClaudeCompatibleModelName(undefined)).toBe(false);
  });
});
