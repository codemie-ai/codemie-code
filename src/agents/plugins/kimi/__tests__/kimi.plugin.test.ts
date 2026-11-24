import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

      await expect(plugin.installVersion('supported')).resolves.toBe('1.0.0');

      const { installNativeAgent } = await import('../../../../utils/native-installer.js');
      expect(installNativeAgent).toHaveBeenCalledTimes(1);
      expect(installNativeAgent).toHaveBeenCalledWith(
        'kimi',
        KimiPluginMetadata.installerUrls,
        KimiPluginMetadata.supportedVersion,
        expect.any(Object),
      );
    });

    it('installs npm version natively', async () => {
      const plugin = new KimiPlugin();

      await expect(plugin.installVersion('npm')).resolves.toBe('1.0.0');

      const { installNativeAgent } = await import('../../../../utils/native-installer.js');
      expect(installNativeAgent).toHaveBeenCalledTimes(1);
      expect(installNativeAgent).toHaveBeenCalledWith(
        'kimi',
        KimiPluginMetadata.installerUrls,
        undefined,
        expect.any(Object),
      );
    });

    it('installs latest version natively', async () => {
      const plugin = new KimiPlugin();

      await expect(plugin.installVersion('latest')).resolves.toBe('1.0.0');

      const { installNativeAgent } = await import('../../../../utils/native-installer.js');
      expect(installNativeAgent).toHaveBeenCalledTimes(1);
      expect(installNativeAgent).toHaveBeenCalledWith(
        'kimi',
        KimiPluginMetadata.installerUrls,
        undefined,
        expect.any(Object),
      );
    });

    it('installs stable version natively', async () => {
      const plugin = new KimiPlugin();

      await expect(plugin.installVersion('stable')).resolves.toBe('1.0.0');

      const { installNativeAgent } = await import('../../../../utils/native-installer.js');
      expect(installNativeAgent).toHaveBeenCalledTimes(1);
      expect(installNativeAgent).toHaveBeenCalledWith(
        'kimi',
        KimiPluginMetadata.installerUrls,
        undefined,
        expect.any(Object),
      );
    });

    it('throws for invalid version', async () => {
      const plugin = new KimiPlugin();

      const promise = plugin.installVersion('not-a-version');
      await expect(promise).rejects.toThrow(AgentInstallationError);
      await expect(promise).rejects.toThrow("Invalid version format: 'not-a-version'");

      const { installNativeAgent } = await import('../../../../utils/native-installer.js');
      expect(installNativeAgent).not.toHaveBeenCalled();
    });

    it('passes explicit semantic version through to native installer', async () => {
      const plugin = new KimiPlugin();

      await expect(plugin.installVersion('1.2.3')).resolves.toBe('1.0.0');

      const { installNativeAgent } = await import('../../../../utils/native-installer.js');
      expect(installNativeAgent).toHaveBeenCalledTimes(1);
      expect(installNativeAgent).toHaveBeenCalledWith(
        'kimi',
        KimiPluginMetadata.installerUrls,
        '1.2.3',
        expect.any(Object),
      );
    });

    describe('Windows install wiring', () => {
      const originalPlatform = process.platform;
      afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      });

      it('passes KIMI_VERSION and kimi.exe verifyPath on win32 (kimi and kimi-acp)', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        const { installNativeAgent } = await import('../../../../utils/native-installer.js');

        await new KimiPlugin().installVersion('0.42.0');
        await new KimiAcpPlugin().installVersion('0.42.0');

        expect(installNativeAgent).toHaveBeenCalledTimes(2);
        for (const call of vi.mocked(installNativeAgent).mock.calls) {
          expect(call[3]).toMatchObject({
            versionEnvVar: 'KIMI_VERSION',
            verifyPath: expect.stringMatching(/\.kimi-code[\\/]bin[\\/]kimi\.exe$/),
          });
        }
      });

      it('keeps the unix verifyPath on linux', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        const { installNativeAgent } = await import('../../../../utils/native-installer.js');

        await new KimiPlugin().installVersion('0.42.0');

        expect(vi.mocked(installNativeAgent).mock.calls[0][3]).toMatchObject({
          verifyPath: expect.stringMatching(/\.kimi-code[\\/]bin[\\/]kimi$/),
        });
      });

      it('does not uninstall when the install fails', async () => {
        const { installNativeAgent } = await import('../../../../utils/native-installer.js');
        vi.mocked(installNativeAgent).mockRejectedValueOnce(
          new AgentInstallationError('kimi', 'step failed'),
        );
        const plugin = new KimiPlugin();
        const uninstall = vi.spyOn(plugin, 'uninstall');

        await expect(plugin.installVersion('0.42.0')).rejects.toThrow('step failed');
        expect(uninstall).not.toHaveBeenCalled();
      });
    });
  });
});

describe('KimiAcpPlugin', () => {
  it('metadata uses ACP-specific SSO client type', () => {
    expect(KimiAcpPluginMetadata.ssoConfig).toEqual({
      enabled: true,
      clientType: 'codemie-kimi-acp',
    });
  });

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
