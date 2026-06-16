import { describe, expect, it } from 'vitest';
import { ClaudePluginMetadata } from '../claude.plugin.js';

describe('ClaudePluginMetadata', () => {
  it('supports anthropic-subscription provider', () => {
    expect(ClaudePluginMetadata.supportedProviders).toContain('anthropic-subscription');
  });

  it('supports azure-openai provider', () => {
    expect(ClaudePluginMetadata.supportedProviders).toContain('azure-openai');
  });
});
