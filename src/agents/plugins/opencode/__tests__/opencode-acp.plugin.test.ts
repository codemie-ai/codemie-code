import { describe, it, expect } from 'vitest';
import { OpenCodeAcpPlugin, OpenCodeAcpPluginMetadata } from '../opencode-acp.plugin.js';
import { OpenCodePluginMetadata } from '../opencode.plugin.js';
import type { AgentConfig } from '../../../core/types.js';

describe('OpenCodeAcpPluginMetadata', () => {
  it('has ACP-specific identity, reusing the same opencode binary', () => {
    expect(OpenCodeAcpPluginMetadata.name).toBe('opencode-acp');
    expect(OpenCodeAcpPluginMetadata.cliCommand).toBe(OpenCodePluginMetadata.cliCommand);
    expect(OpenCodeAcpPluginMetadata.npmPackage).toBe('opencode-ai');
  });

  it('uses the ACP-specific SSO client type', () => {
    expect(OpenCodeAcpPluginMetadata.ssoConfig).toEqual({
      enabled: true,
      clientType: 'codemie-opencode-acp',
    });
  });

  it('has no flag mappings and is silent', () => {
    expect(OpenCodeAcpPluginMetadata.flagMappings).toEqual({});
    expect(OpenCodeAcpPluginMetadata.silentMode).toBe(true);
  });

  it('inherits beforeRun and onSessionEnd from OpenCodePluginMetadata', () => {
    expect(OpenCodeAcpPluginMetadata.lifecycle?.beforeRun).toBe(OpenCodePluginMetadata.lifecycle?.beforeRun);
    expect(OpenCodeAcpPluginMetadata.lifecycle?.onSessionEnd).toBe(OpenCodePluginMetadata.lifecycle?.onSessionEnd);
  });

  describe('enrichArgs', () => {
    it('prepends the acp subcommand as a pass-through — no --task translation', () => {
      const result = OpenCodeAcpPluginMetadata.lifecycle!.enrichArgs!(['--task', 'x'], {} as AgentConfig);
      expect(result).toEqual(['acp', '--task', 'x']);
    });

    it('prepends acp even for an empty argv', () => {
      const result = OpenCodeAcpPluginMetadata.lifecycle!.enrichArgs!([], {} as AgentConfig);
      expect(result).toEqual(['acp']);
    });
  });
});

describe('OpenCodeAcpPlugin', () => {
  it('uses ACP metadata', () => {
    const plugin = new OpenCodeAcpPlugin();
    expect(plugin.name).toBe('opencode-acp');
  });
});
