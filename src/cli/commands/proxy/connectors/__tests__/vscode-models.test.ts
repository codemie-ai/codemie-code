import { describe, expect, it } from 'vitest';
import {
  VS_CODE_CAPABILITY_TABLE,
  buildDefaultVsCodeCapability,
  findVsCodeCapabilityEntry,
  resolveVsCodeTokenLimits,
} from '../vscode-models.js';

describe('VS_CODE_CAPABILITY_TABLE', () => {
  it('has a unique, date-free family key per entry', () => {
    const families = VS_CODE_CAPABILITY_TABLE.map((e) => e.family);
    expect(new Set(families).size).toBe(families.length);
    for (const family of families) {
      expect(family).not.toMatch(/[-._]20\d{2}[-._]\d{2}[-._]\d{2}/);
    }
  });
});

describe('findVsCodeCapabilityEntry', () => {
  it('returns the exact family entry', () => {
    expect(findVsCodeCapabilityEntry('claude-4-5-sonnet')?.family).toBe('claude-4-5-sonnet');
  });

  it('resolves a vendor-prefixed tenant id to its family entry', () => {
    expect(findVsCodeCapabilityEntry('openai.gpt-5.6-luna')?.family).toBe('gpt-5.6-luna');
  });

  it('returns undefined for a model with no capability-table family', () => {
    expect(findVsCodeCapabilityEntry('gpt-6-sol')).toBeUndefined();
  });
});

describe('buildDefaultVsCodeCapability', () => {
  it('maps multimodal to vision and features.tools=false to toolCalling=false', () => {
    const entry = buildDefaultVsCodeCapability({ id: 'claude-future-9', multimodal: true, toolCalling: false });
    expect(entry.vision).toBe(true);
    expect(entry.toolCalling).toBe(false);
  });

  it('defaults to no vision and tool calling on when the descriptor is silent', () => {
    const entry = buildDefaultVsCodeCapability({ id: 'claude-future-9' });
    expect(entry.vision).toBe(false);
    expect(entry.toolCalling).toBe(true);
  });

  it('uses conservative chat-completions defaults for a non-GPT-6 id', () => {
    expect(buildDefaultVsCodeCapability({ id: 'claude-future-9' })).toEqual({
      family: 'claude-future-9',
      apiType: 'chat-completions',
      vision: false,
      thinking: false,
      toolCalling: true,
      maxInputTokens: 128000,
      maxOutputTokens: 8192,
    });
  });

  it.each([
    'gpt-6-sol',
    'openai.gpt-6-sol',
    'GPT-7',
    'gpt-6-luna',
    'azure.gpt-6-sol',
    'azure_openai/gpt-6-sol',
    'gpt-5.7-nova',
    'gpt-5-7-nova',
    'gpt-5.5-preview',
    'gpt-5-1-codex-2025-11-13',
    'gpt-5.1-codex-mini',
    'openai.gpt-5-codex',
  ])('uses stateless responses for %s (CR-002)', (id) => {
    const entry = buildDefaultVsCodeCapability({ id });
    expect(entry.apiType).toBe('responses');
    expect(entry.zeroDataRetentionEnabled).toBe(true);
    expect(entry.supportsReasoningEffort).toBeUndefined();
    expect(entry.requestHeaders).toBeUndefined();
  });

  it.each([
    'gpt-5-turbo-2025-08-07',
    'gpt-5-2025-08-07',
    'gpt-5.4-mini',
    'gpt-5-4-mini',
    'gpt-4.1-nano',
    'claude-future-9',
    'grok-4.6',
  ])('keeps %s on chat-completions (CR-002)', (id) => {
    const entry = buildDefaultVsCodeCapability({ id });
    expect(entry.apiType).toBe('chat-completions');
    expect(entry.zeroDataRetentionEnabled).toBeUndefined();
  });
});

describe('resolveVsCodeTokenLimits', () => {
  const claude45 = findVsCodeCapabilityEntry('claude-4-5-sonnet')!;
  const untabled = buildDefaultVsCodeCapability({ id: 'gpt-6-sol' });

  it('subtracts the table output limit from catalog input', () => {
    expect(resolveVsCodeTokenLimits(claude45, { id: 'claude-4-5-sonnet', maxInputTokens: 200000 }))
      .toEqual({ maxInputTokens: 136000, maxOutputTokens: 64000 });
  });

  it('subtracts the default output limit when the model is untabled', () => {
    expect(resolveVsCodeTokenLimits(untabled, { id: 'gpt-6-sol', maxInputTokens: 922000 }))
      .toEqual({ maxInputTokens: 913808, maxOutputTokens: 8192 });
  });

  it('subtracts the catalog output limit when both are reported', () => {
    expect(resolveVsCodeTokenLimits(untabled, { id: 'gpt-6-sol', maxInputTokens: 200000, maxOutputTokens: 16000 }))
      .toEqual({ maxInputTokens: 184000, maxOutputTokens: 16000 });
  });

  it('lets a catalog output limit override the table value', () => {
    expect(resolveVsCodeTokenLimits(claude45, { id: 'claude-4-5-sonnet', maxInputTokens: 200000, maxOutputTokens: 32000 }))
      .toEqual({ maxInputTokens: 168000, maxOutputTokens: 32000 });
  });

  it('falls back to the entry input when the subtraction is not positive', () => {
    expect(resolveVsCodeTokenLimits(claude45, { id: 'claude-4-5-sonnet', maxInputTokens: 64000 }))
      .toEqual({ maxInputTokens: claude45.maxInputTokens, maxOutputTokens: 64000 });
  });

  it('returns the entry unchanged when the catalog reports no limits', () => {
    expect(resolveVsCodeTokenLimits(claude45, { id: 'claude-4-5-sonnet' }))
      .toEqual({ maxInputTokens: claude45.maxInputTokens, maxOutputTokens: claude45.maxOutputTokens });
  });

  it('keeps the entry input when only the catalog output is reported', () => {
    expect(resolveVsCodeTokenLimits(claude45, { id: 'claude-4-5-sonnet', maxOutputTokens: 32000 }))
      .toEqual({ maxInputTokens: claude45.maxInputTokens, maxOutputTokens: 32000 });
  });
});
