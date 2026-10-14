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

  it('returns the table entry for a GPT-6 model', () => {
    expect(findVsCodeCapabilityEntry('gpt-6-sol')).toMatchObject({
      family: 'gpt-6-sol',
      apiType: 'responses',
      maxInputTokens: 922000,
      maxOutputTokens: 128000,
    });
  });

  it('resolves a vendor-prefixed GPT-6 tenant id to its family entry', () => {
    expect(findVsCodeCapabilityEntry('openai.gpt-6-luna')?.family).toBe('gpt-6-luna');
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
