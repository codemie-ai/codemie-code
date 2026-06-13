import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KimiPlugin, KimiPluginMetadata } from '../kimi.plugin.js';
import { KimiAcpPlugin, KimiAcpPluginMetadata } from '../kimi-acp.plugin.js';
import { KimiSessionAdapter } from '../kimi.session.js';
import { KimiExtensionInstaller } from '../kimi.extension-installer.js';
import { KimiHookTransformer } from '../kimi.hook-transformer.js';
import { AgentInstallationError } from '../../../../utils/errors.js';

vi.mock('../../../../utils/native-installer.js', () => ({
  installNativeAgent: vi.fn().mockResolvedValue({
    success: true,
    installedVersion: '1.0.0',
    output: '',
  }),
}));

describe('KimiPlugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('metadata has expected values', () => {
    expect(KimiPluginMetadata.name).toBe('kimi');
    expect(KimiPluginMetadata.cliCommand).toBe('kimi');
    expect(KimiPluginMetadata.supportedProviders).toContain('moonshot-subscription');
    expect(KimiPluginMetadata.hookConfig?.eventNameMapping).toBeDefined();
  });

  it('maps --model flag to --model', () => {
    expect(KimiPluginMetadata.flagMappings['--model']).toEqual({
      type: 'flag',
      target: '--model',
    });
  });

  it('returns session adapter, hook transformer, and extension installer', () => {
    const plugin = new KimiPlugin();

    expect(plugin.getSessionAdapter()).toBeInstanceOf(KimiSessionAdapter);
    expect(plugin.getHookTransformer()).toBeInstanceOf(KimiHookTransformer);
    expect(plugin.getExtensionInstaller()).toBeInstanceOf(KimiExtensionInstaller);
  });

  describe('installVersion', () => {
    it('installs supported version natively', async () => {
      const plugin = new KimiPlugin();

      await expect(plugin.installVersion('supported')).resolves.toBeUndefined();

      const { installNativeAgent } = await import('../../../../utils/native-installer.js');
      expect(installNativeAgent).toHaveBeenCalledTimes(1);
      expect(installNativeAgent).toHaveBeenCalledWith(
        'kimi',
        KimiPluginMetadata.installerUrls,
        '1.0.0',
        expect.any(Object),
      );
    });

    it('throws when installing npm version on Node.js < 22.19.0', async () => {
      const originalVersion = process.version;
      Object.defineProperty(process, 'version', {
        value: 'v22.18.0',
        configurable: true,
      });

      try {
        const plugin = new KimiPlugin();

        const promise = plugin.installVersion('npm');
        await expect(promise).rejects.toThrow(AgentInstallationError);
        await expect(promise).rejects.toThrow('Node.js >= 22.19.0');

        const { installNativeAgent } = await import('../../../../utils/native-installer.js');
        expect(installNativeAgent).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, 'version', {
          value: originalVersion,
          configurable: true,
        });
      }
    });

    it('does not throw when installing npm version on Node.js >= 22.19.0', async () => {
      const originalVersion = process.version;
      Object.defineProperty(process, 'version', {
        value: 'v22.19.0',
        configurable: true,
      });

      try {
        const plugin = new KimiPlugin();

        await expect(plugin.installVersion('npm')).resolves.toBeUndefined();

        const { installNativeAgent } = await import('../../../../utils/native-installer.js');
        expect(installNativeAgent).toHaveBeenCalledTimes(1);
        expect(installNativeAgent).toHaveBeenCalledWith(
          'kimi',
          KimiPluginMetadata.installerUrls,
          undefined,
          expect.any(Object),
        );
      } finally {
        Object.defineProperty(process, 'version', {
          value: originalVersion,
          configurable: true,
        });
      }
    });

    it('installs latest version natively', async () => {
      const plugin = new KimiPlugin();

      await expect(plugin.installVersion('latest')).resolves.toBeUndefined();

      const { installNativeAgent } = await import('../../../../utils/native-installer.js');
      expect(installNativeAgent).toHaveBeenCalledTimes(1);
      expect(installNativeAgent).toHaveBeenCalledWith(
        'kimi',
        KimiPluginMetadata.installerUrls,
        undefined,
        expect.any(Object),
      );
    });

    it('passes explicit semantic version through to native installer', async () => {
      const plugin = new KimiPlugin();

      await expect(plugin.installVersion('1.2.3')).resolves.toBeUndefined();

      const { installNativeAgent } = await import('../../../../utils/native-installer.js');
      expect(installNativeAgent).toHaveBeenCalledTimes(1);
      expect(installNativeAgent).toHaveBeenCalledWith(
        'kimi',
        KimiPluginMetadata.installerUrls,
        '1.2.3',
        expect.any(Object),
      );
    });
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
