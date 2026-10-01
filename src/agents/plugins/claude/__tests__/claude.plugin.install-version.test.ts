import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

vi.mock('../../../../utils/native-installer.js', () => ({
  installNativeAgent: vi.fn(async () => ({ success: true, installedVersion: '2.1.300', output: '' })),
}));

// A live tracked version that differs from CLAUDE_SUPPORTED_VERSION, so a test
// passing by installing the pinned fallback is impossible.
const LIVE_VERSION = '2.1.300';
vi.mock('../../../core/version-resolution.js', () => ({
  resolveSupportedInstallVersion: vi.fn(async () => LIVE_VERSION),
  resolveSupportedVersionDetailed: vi.fn(async () => ({ version: LIVE_VERSION, isCurrent: true })),
  isVersionChecksEnabled: vi.fn(async () => true),
}));

const execMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../utils/processes.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../utils/processes.js')>(
    '../../../../utils/processes.js'
  );
  return { ...actual, exec: execMock };
});

import { ClaudePlugin, ClaudePluginMetadata } from '../claude.plugin.js';
import { installNativeAgent } from '../../../../utils/native-installer.js';
import { resolveSupportedInstallVersion } from '../../../core/version-resolution.js';

describe('ClaudePlugin.installVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("installs the live tracked version for 'supported', not the pinned fallback", async () => {
    expect(ClaudePluginMetadata.supportedVersion).not.toBe(LIVE_VERSION);

    await expect(new ClaudePlugin().installVersion('supported')).resolves.toBe('2.1.300');

    expect(resolveSupportedInstallVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'claude',
        fallbackSupportedVersion: ClaudePluginMetadata.supportedVersion,
      })
    );
    expect(installNativeAgent).toHaveBeenCalledWith(
      'claude',
      ClaudePluginMetadata.installerUrls,
      LIVE_VERSION,
      expect.any(Object)
    );
  });

  it("installs the latest channel for 'supported' when the tracked version is unknown", async () => {
    vi.mocked(resolveSupportedInstallVersion).mockResolvedValueOnce('latest');

    await new ClaudePlugin().installVersion('supported');

    expect(installNativeAgent).toHaveBeenCalledWith(
      'claude',
      ClaudePluginMetadata.installerUrls,
      'latest',
      expect.any(Object)
    );
  });

  it('installs an explicit version as given, without resolving the tracked one', async () => {
    await new ClaudePlugin().installVersion('2.1.250');

    expect(resolveSupportedInstallVersion).not.toHaveBeenCalled();
    expect(installNativeAgent).toHaveBeenCalledWith(
      'claude',
      ClaudePluginMetadata.installerUrls,
      '2.1.250',
      expect.any(Object)
    );
  });
});

describe('ClaudePlugin.getVersion', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('runs the PATH fallback through a shell on Windows, where an npm install is a .cmd shim', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    execMock.mockResolvedValue({ code: 0, stdout: '2.1.284 (Claude Code)', stderr: '' });

    await expect(new ClaudePlugin().getVersion()).resolves.toBe('2.1.284');
    expect(execMock).toHaveBeenCalledWith('claude', ['--version'], expect.objectContaining({ shell: true }));
  });
});
