import { describe, expect, it } from 'vitest';
import { resolveTenantModelId } from '../model-name-resolver.js';

describe('resolveTenantModelId', () => {
  it.each([
    // [description, family, available, expected]
    ['exact match', 'claude-sonnet-4-6', ['claude-sonnet-4-6'], 'claude-sonnet-4-6'],
    ['GPT vendor-prefixed, undated (Philips)', 'gpt-5.6-luna', ['openai.gpt-5.6-luna'], 'openai.gpt-5.6-luna'],
    ['GPT dated, dashed minor (EPAM)', 'gpt-5.6-luna', ['gpt-5.6-luna-2026-07-09'], 'gpt-5.6-luna-2026-07-09'],
    ['GPT picks most recent dated duplicate', 'gpt-5.6-luna',
      ['gpt-5.6-luna-2025-01-01', 'gpt-5.6-luna-2026-07-09'], 'gpt-5.6-luna-2026-07-09'],
    ['Claude family-first request, version-first tenant (Philips)', 'claude-opus-5', ['claude-5-opus'], 'claude-5-opus'],
    ['Claude version-first request, family-first tenant', 'claude-haiku-4-5', ['claude-4-5-haiku'], 'claude-4-5-haiku'],
    ['Claude dated family-first tenant (EPAM)', 'claude-opus-4-5', ['claude-opus-4-5-20251101'], 'claude-opus-4-5-20251101'],
    ['no match at all', 'glm-5', ['claude-sonnet-4-6'], undefined],
    ['Gemini exact-match only — no fuzzy normalization invented', 'gemini-3.1-pro', ['gemini-3-1-pro'], undefined],
    ['github-copilot-claude-* never matches a Claude family (AC4/AC8 defense-in-depth)',
      'claude-sonnet-4-6', ['github-copilot-claude-sonnet-4-5'], undefined],
    ['github-copilot-gpt-* never matches a GPT family (AC4 defense-in-depth)',
      'gpt-5-mini', ['github-copilot-gpt-5-mini'], undefined],
  ])('%s', (_desc, family, available, expected) => {
    expect(resolveTenantModelId(family, available)).toBe(expected);
  });
});
