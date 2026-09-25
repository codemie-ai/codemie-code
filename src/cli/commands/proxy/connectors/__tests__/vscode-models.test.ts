import { describe, expect, it } from 'vitest';
import {
  VS_CODE_CAPABILITY_TABLE,
  buildDefaultVsCodeCapability,
  findVsCodeCapabilityEntry,
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

  it.each(['gpt-6-sol', 'openai.gpt-6-sol', 'GPT-7'])('uses stateless responses for %s', (id) => {
    const entry = buildDefaultVsCodeCapability({ id });
    expect(entry.apiType).toBe('responses');
    expect(entry.zeroDataRetentionEnabled).toBe(true);
    expect(entry.supportsReasoningEffort).toBeUndefined();
    expect(entry.requestHeaders).toBeUndefined();
  });

  it('keeps an older GPT id on chat-completions', () => {
    expect(buildDefaultVsCodeCapability({ id: 'gpt-5.9-new' }).apiType).toBe('chat-completions');
  });
});
