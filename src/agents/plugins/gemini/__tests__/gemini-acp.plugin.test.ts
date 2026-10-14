import { describe, it, expect } from 'vitest';
import { GeminiAcpPlugin, GeminiAcpPluginMetadata } from '../gemini-acp.plugin.js';
import { GeminiPluginMetadata } from '../gemini.plugin.js';
import type { AgentConfig } from '../../../core/types.js';

describe('GeminiAcpPluginMetadata', () => {
  it('has ACP-specific identity, reusing the same gemini binary', () => {
    expect(GeminiAcpPluginMetadata.name).toBe('gemini-acp');
    expect(GeminiAcpPluginMetadata.cliCommand).toBe('gemini');
    expect(GeminiAcpPluginMetadata.npmPackage).toBe('@google/gemini-cli');
  });

  it('uses the ACP-specific SSO client type', () => {
    expect(GeminiAcpPluginMetadata.ssoConfig).toEqual({
      enabled: true,
      clientType: 'codemie-gemini-acp',
    });
  });

  it('has no flag mappings and is silent', () => {
    expect(GeminiAcpPluginMetadata.flagMappings).toEqual({});
    expect(GeminiAcpPluginMetadata.silentMode).toBe(true);
  });

  it('inherits beforeRun from GeminiPluginMetadata', () => {
    expect(GeminiAcpPluginMetadata.lifecycle?.beforeRun).toBe(GeminiPluginMetadata.lifecycle?.beforeRun);
  });

  describe('enrichArgs', () => {
    it('prepends --acp and still applies model injection', () => {
      const result = GeminiAcpPluginMetadata.lifecycle!.enrichArgs!(['prompt'], { model: 'gemini-3-pro' } as AgentConfig);
      expect(result).toEqual(['--acp', '-m', 'gemini-3-pro', 'prompt']);
    });

    it('prepends --acp but skips model injection for no-model subcommands', () => {
      const result = GeminiAcpPluginMetadata.lifecycle!.enrichArgs!(
        ['extensions', 'list'],
        { model: 'gemini-3-pro' } as AgentConfig,
      );
      expect(result).toEqual(['--acp', 'extensions', 'list']);
    });

    it('prepends --acp but skips model injection when an explicit -m is already present', () => {
      const result = GeminiAcpPluginMetadata.lifecycle!.enrichArgs!(
        ['-m', 'gemini-flash', 'prompt'],
        { model: 'gemini-3-pro' } as AgentConfig,
      );
      expect(result).toEqual(['--acp', '-m', 'gemini-flash', 'prompt']);
    });
  });
});

describe('GeminiAcpPlugin', () => {
  it('uses ACP metadata', () => {
    const plugin = new GeminiAcpPlugin();
    expect(plugin.name).toBe('gemini-acp');
  });
});
