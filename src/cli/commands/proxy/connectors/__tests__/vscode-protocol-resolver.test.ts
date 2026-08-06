import { describe, expect, it } from 'vitest';
import type { VsCodeModelDescriptor } from '../vscode-model-catalog.js';
import { resolveVsCodeModelCatalog, resolveVsCodeProtocol } from '../vscode-protocol-resolver.js';

function descriptor(id: string): VsCodeModelDescriptor {
  return {
    requestId: id,
    deploymentName: id,
    baseName: id,
    label: id,
    features: {},
    default: false,
    multimodal: false,
    protocolMetadataPresent: false,
  };
}

describe('resolveVsCodeProtocol', () => {
  it.each([
    ['gpt-4.1', 'chat-completions', '/v1/chat/completions'],
    ['gpt-5.4-2026-03-05', 'chat-completions', '/v1/chat/completions'],
    ['gpt-5-1-codex-2025-11-13', 'responses', '/v1/responses'],
    ['gpt-5.6-sol-2026-07-09', 'responses', '/v1/responses'],
    ['claude-sonnet-4-5-20250929', 'chat-completions', '/v1/chat/completions'],
    ['claude-sonnet-4-6', 'messages', '/v1/messages'],
    ['claude-opus-4-8', 'messages', '/v1/messages'],
    ['gemini-3.5-flash', 'chat-completions', '/v1/chat/completions'],
    ['qwen.qwen3-coder-30b-a3b-v1', 'chat-completions', '/v1/chat/completions'],
    ['moonshotai.kimi-k2.5', 'chat-completions', '/v1/chat/completions'],
    ['o1', 'chat-completions', '/v1/chat/completions'],
    ['o3-2025-04-16', 'chat-completions', '/v1/chat/completions'],
    ['o4-mini-2025-04-16', 'chat-completions', '/v1/chat/completions'],
  ] as const)('classifies %s as %s', (id, type, apiPath) => {
    expect(resolveVsCodeProtocol(descriptor(id))).toMatchObject({
      type,
      source: 'compatibility-rule',
      defaults: { apiPath },
    });
  });

  it('uses valid backend protocol metadata before compatibility rules', () => {
    const model = descriptor('gpt-4.1');
    model.protocolMetadataPresent = true;
    model.protocol = {
      type: 'messages',
      adaptive_thinking: true,
      reasoning_efforts: ['low', 'high'],
    };

    expect(resolveVsCodeProtocol(model)).toMatchObject({
      type: 'messages',
      source: 'backend',
      defaults: {
        apiPath: '/v1/messages',
        adaptiveThinking: true,
        supportsReasoningEffort: ['low', 'high'],
        requestHeaders: { Authorization: 'Bearer ${apiKey}' },
      },
    });
  });

  it.each([
    'claude-sonnet-4-5-20250929',
    'claude-4-5-sonnet',
    'claude-sonnet-4-6',
    'claude-sonnet-5',
    'claude-opus-4-5-20251101',
    'claude-opus-4-6-20260205',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-haiku-4-5-20251001',
  ])('disables top_p for former static Anthropic model %s', id => {
    expect(resolveVsCodeProtocol(descriptor(id))).toMatchObject({
      defaults: { modelOptions: { top_p: null } },
    });
  });

  it('keeps the Anthropic sampling override with backend protocol metadata', () => {
    const model = descriptor('claude-sonnet-5');
    model.protocolMetadataPresent = true;
    model.protocol = { type: 'messages' };

    expect(resolveVsCodeProtocol(model)).toMatchObject({
      source: 'backend',
      defaults: { modelOptions: { top_p: null } },
    });
  });

  it.each([
    ['gpt-5-2025-08-07', ['minimal', 'low', 'medium', 'high'], 'chat-completions', false],
    ['gpt-5-mini-2025-08-07', ['minimal', 'low', 'medium', 'high'], 'chat-completions', false],
    ['gpt-5-nano-2025-08-07', ['minimal', 'low', 'medium', 'high'], 'chat-completions', false],
    ['gpt-5-2-2025-12-11', ['none', 'low', 'medium', 'high'], 'chat-completions', false],
    ['gpt-5.4-2026-03-05', ['none', 'low', 'medium', 'high', 'xhigh'], 'chat-completions', false],
    ['gpt-5.5-2026-04-24', ['none', 'low', 'medium', 'high', 'xhigh'], 'responses', false],
    ['gpt-5.6-luna-2026-07-09', ['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'responses', false],
    ['gpt-5.6-sol-2026-07-09', ['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'responses', false],
    ['gpt-5.6-terra-2026-07-09', ['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'responses', false],
    ['gemini-3-flash', ['minimal', 'low', 'medium', 'high'], 'chat-completions', false],
    ['gemini-3.1-pro', ['low', 'medium', 'high'], 'chat-completions', false],
    ['gemini-3.5-flash', ['minimal', 'low', 'medium', 'high'], 'chat-completions', false],
    ['claude-sonnet-4-6', ['low', 'medium', 'high', 'max'], undefined, true],
    ['claude-sonnet-5', ['low', 'medium', 'high', 'xhigh', 'max'], undefined, true],
    ['claude-opus-4-5-20251101', ['low', 'medium', 'high'], undefined, false],
    ['claude-opus-4-6-20260205', ['low', 'medium', 'high', 'max'], undefined, true],
    ['claude-opus-4-7', ['low', 'medium', 'high', 'xhigh', 'max'], undefined, true],
    ['claude-opus-4-8', ['low', 'medium', 'high', 'xhigh', 'max'], undefined, true],
    ['claude-opus-5', ['low', 'medium', 'high', 'xhigh', 'max'], undefined, true],
  ] as const)(
    'restores former reasoning capabilities for %s',
    (id, efforts, format, adaptiveThinking) => {
      const result = resolveVsCodeProtocol(descriptor(id));
      expect(result).toMatchObject({
        defaults: {
          supportsReasoningEffort: efforts,
          thinking: id === 'claude-opus-4-5-20251101' ? false : true,
          ...(format && { reasoningEffortFormat: format }),
          ...(adaptiveThinking && { adaptiveThinking: true }),
        },
      });
      if (!adaptiveThinking && result.type !== 'unclassified') {
        expect(result.defaults.adaptiveThinking).toBeUndefined();
      }
    }
  );

  it.each([
    'gpt-4.1',
    'gpt-4.1-mini',
    'claude-sonnet-4-5-20250929',
    'claude-4-5-sonnet',
    'claude-haiku-4-5-20251001',
    'qwen.qwen3-coder-30b-a3b-v1',
    'qwen.qwen3-coder-480b-a35b-v1',
    'moonshotai.kimi-k2.5',
  ])('does not invent reasoning efforts for former non-reasoning model %s', id => {
    const result = resolveVsCodeProtocol(descriptor(id));
    expect(result).toMatchObject({ defaults: { thinking: false } });
    if (result.type !== 'unclassified') {
      expect(result.defaults.supportsReasoningEffort).toBeUndefined();
      expect(result.defaults.reasoningEffortFormat).toBeUndefined();
    }
  });

  it.each([
    ['gpt-4.1', 1014808, 32768],
    ['gpt-4.1-mini', 1014808, 32768],
    ['gpt-5-2025-08-07', 272000, 128000],
    ['gpt-5-mini-2025-08-07', 272000, 128000],
    ['gpt-5-nano-2025-08-07', 272000, 128000],
    ['gpt-5-2-2025-12-11', 272000, 128000],
    ['gpt-5.4-2026-03-05', 922000, 128000],
    ['gpt-5.5-2026-04-24', 922000, 128000],
    ['gpt-5.6-luna-2026-07-09', 922000, 128000],
    ['gpt-5.6-sol-2026-07-09', 922000, 128000],
    ['gpt-5.6-terra-2026-07-09', 922000, 128000],
    ['gemini-3-flash', 983040, 65536],
    ['gemini-3.1-pro', 983040, 65536],
    ['gemini-3.5-flash', 983040, 65536],
    ['claude-sonnet-4-5-20250929', 136000, 64000],
    ['claude-4-5-sonnet', 136000, 64000],
    ['claude-sonnet-4-6', 936000, 64000],
    ['claude-sonnet-5', 872000, 128000],
    ['claude-opus-4-5-20251101', 136000, 64000],
    ['claude-opus-4-6-20260205', 872000, 128000],
    ['claude-opus-4-7', 872000, 128000],
    ['claude-opus-4-8', 872000, 128000],
    ['claude-opus-5', 872000, 128000],
    ['claude-haiku-4-5-20251001', 136000, 64000],
    ['qwen.qwen3-coder-30b-a3b-v1', 245760, 16384],
    ['qwen.qwen3-coder-480b-a35b-v1', 114688, 16384],
    ['moonshotai.kimi-k2.5', 245760, 16384],
  ] as const)(
    'restores former static token limits for %s',
    (id, maxInputTokens, maxOutputTokens) => {
      expect(resolveVsCodeProtocol(descriptor(id))).toMatchObject({
        defaults: { maxInputTokens, maxOutputTokens },
      });
    }
  );

  it('lets backend reasoning metadata override compatibility effort lists', () => {
    const model = descriptor('claude-sonnet-5');
    model.protocolMetadataPresent = true;
    model.protocol = {
      type: 'messages',
      adaptive_thinking: false,
      reasoning_efforts: ['low'],
    };

    const result = resolveVsCodeProtocol(model);
    expect(result).toMatchObject({
      source: 'backend',
      defaults: {
        thinking: true,
        supportsReasoningEffort: ['low'],
      },
    });
    if (result.type !== 'unclassified') {
      expect(result.defaults.adaptiveThinking).toBeUndefined();
    }
  });

  it('fails closed for unknown models and invalid backend protocol metadata', () => {
    const unknown = descriptor('new-provider-model');
    const invalid = descriptor('gpt-4.1');
    invalid.protocolMetadataPresent = true;

    const catalog = resolveVsCodeModelCatalog([unknown, invalid]);
    expect(catalog.models).toEqual([]);
    expect(catalog.unclassified).toHaveLength(2);
    expect(catalog.unclassified.map(entry => entry.protocol.reason)).toEqual([
      'no backend protocol metadata or compatible model-family rule',
      'backend protocol metadata is invalid or unsupported',
    ]);
  });
});
