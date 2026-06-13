import { describe, expect, it } from 'vitest';
import { KimiPlugin, KimiPluginMetadata } from '../kimi.plugin.js';
import { KimiAcpPlugin, KimiAcpPluginMetadata } from '../kimi-acp.plugin.js';
import { KimiSessionAdapter } from '../kimi.session.js';
import { KimiExtensionInstaller } from '../kimi.extension-installer.js';
import { KimiHookTransformer } from '../kimi.hook-transformer.js';

describe('KimiPlugin', () => {
  it('metadata has expected values', () => {
    expect(KimiPluginMetadata.name).toBe('kimi');
    expect(KimiPluginMetadata.cliCommand).toBe('kimi');
    expect(KimiPluginMetadata.supportedProviders).toContain('moonshot-subscription');
    expect(KimiPluginMetadata.hookConfig?.eventNameMapping).toBeDefined();
  });

  it('returns session adapter, hook transformer, and extension installer', () => {
    const plugin = new KimiPlugin();

    expect(plugin.getSessionAdapter()).toBeInstanceOf(KimiSessionAdapter);
    expect(plugin.getHookTransformer()).toBeInstanceOf(KimiHookTransformer);
    expect(plugin.getExtensionInstaller()).toBeInstanceOf(KimiExtensionInstaller);
  });
});

describe('KimiAcpPlugin', () => {
  it('metadata name is kimi-acp and lifecycle enriches args', () => {
    expect(KimiAcpPluginMetadata.name).toBe('kimi-acp');
    expect(KimiAcpPluginMetadata.lifecycle?.enrichArgs?.(['--task', 'x'], {} as never)).toEqual([
      'acp',
      '--task',
      'x',
    ]);
  });

  it('plugin uses acp metadata', () => {
    const plugin = new KimiAcpPlugin();

    expect(plugin.name).toBe('kimi-acp');
  });
});
