import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAgentMock = vi.fn();
const restoreCliBinLinkMock = vi.fn();
const spinnerSucceedMock = vi.fn();
const spinnerFailMock = vi.fn();

vi.mock('../../../agents/registry.js', () => ({
  AgentRegistry: {
    getAgent: getAgentMock,
    getAllAgents: vi.fn(() => []),
  },
}));

vi.mock('../../../utils/cli-bin.js', () => ({
  restoreCliBinLink: restoreCliBinLinkMock,
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn(() => ({
      succeed: spinnerSucceedMock,
      fail: spinnerFailMock,
    })),
  })),
}));

describe('install command version selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('defaults codex installation to the supported version like claude', async () => {
    const installVersion = vi.fn().mockResolvedValue('0.129.0');
    const checkVersionCompatibility = vi.fn().mockResolvedValue({
      supportedVersion: '0.129.0',
      installedVersion: null,
      compatible: false,
      isNewer: false,
      hasUpdate: false,
      isBelowMinimum: false,
      minimumSupportedVersion: '0.119.0',
    });

    getAgentMock.mockReturnValue({
      name: 'codex',
      displayName: 'OpenAI Codex CLI',
      description: 'OpenAI Codex CLI - AI coding agent by OpenAI',
      metadata: {},
      isInstalled: vi.fn().mockResolvedValue(false),
      install: vi.fn().mockResolvedValue(undefined),
      installVersion,
      checkVersionCompatibility,
      getVersion: vi.fn().mockResolvedValue('0.129.0'),
    });

    const { createInstallCommand } = await import('../install.js');
    const command = createInstallCommand();

    await command.parseAsync(['node', 'codemie', 'codex']);

    expect(checkVersionCompatibility).toHaveBeenCalled();
    expect(installVersion).toHaveBeenCalledWith('supported');
    expect(restoreCliBinLinkMock).toHaveBeenCalledOnce();
    expect(spinnerSucceedMock).toHaveBeenCalledWith(
      'OpenAI Codex CLI v0.129.0 installed successfully'
    );
  });

  it('uses the version returned by installVersion() for the success message', async () => {
    const installVersion = vi.fn().mockResolvedValue('2.1.34');
    const getVersion = vi.fn().mockResolvedValue('2.1.33'); // stale — must NOT appear in spinner

    getAgentMock.mockReturnValue({
      name: 'claude',
      displayName: 'Claude Code',
      description: 'Claude Code - AI coding agent by Anthropic',
      metadata: {},
      isInstalled: vi.fn().mockResolvedValue(false),
      install: vi.fn().mockResolvedValue(undefined),
      installVersion,
      checkVersionCompatibility: vi.fn().mockResolvedValue({
        supportedVersion: '2.1.34',
        installedVersion: null,
        compatible: false,
        isNewer: false,
        hasUpdate: false,
        isBelowMinimum: false,
        minimumSupportedVersion: '2.1.199',
      }),
      getVersion,
    });

    const { createInstallCommand } = await import('../install.js');
    const command = createInstallCommand();

    await command.parseAsync(['node', 'codemie', 'claude']);

    expect(installVersion).toHaveBeenCalledWith('supported');
    // must show the version from installVersion(), not the stale '2.1.33' from getVersion()
    expect(spinnerSucceedMock).toHaveBeenCalledWith('Claude Code v2.1.34 installed successfully');
  });

  it('falls back to getVersion() when installVersion() returns null', async () => {
    const installVersion = vi.fn().mockResolvedValue(null);
    const getVersion = vi.fn().mockResolvedValue('2.1.34');

    getAgentMock.mockReturnValue({
      name: 'claude',
      displayName: 'Claude Code',
      description: 'Claude Code - AI coding agent by Anthropic',
      metadata: {},
      isInstalled: vi.fn().mockResolvedValue(false),
      install: vi.fn().mockResolvedValue(undefined),
      installVersion,
      checkVersionCompatibility: vi.fn().mockResolvedValue({
        supportedVersion: '2.1.34',
        installedVersion: null,
        compatible: false,
        isNewer: false,
        hasUpdate: false,
        isBelowMinimum: false,
        minimumSupportedVersion: '2.1.199',
      }),
      getVersion,
    });

    const { createInstallCommand } = await import('../install.js');
    const command = createInstallCommand();

    await command.parseAsync(['node', 'codemie', 'claude']);

    expect(getVersion).toHaveBeenCalled(); // fallback path exercised
    expect(spinnerSucceedMock).toHaveBeenCalledWith('Claude Code v2.1.34 installed successfully');
  });
});
