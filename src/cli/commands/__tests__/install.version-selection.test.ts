import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getAgentMock = vi.fn();
const restoreCliBinLinkMock = vi.fn();
const spinnerSucceedMock = vi.fn();
const spinnerFailMock = vi.fn();
const spinnerWarnMock = vi.fn();

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

const promptMock = vi.hoisted(() => vi.fn());
vi.mock('inquirer', () => ({ default: { prompt: promptMock } }));

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn(() => ({
      succeed: spinnerSucceedMock,
      fail: spinnerFailMock,
      warn: spinnerWarnMock,
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
      warnOnceIfUntested: vi.fn().mockResolvedValue(undefined),
    });

    const { createInstallCommand } = await import('../install.js');
    const command = createInstallCommand();

    await command.parseAsync(['node', 'codemie', 'codex']);

    expect(checkVersionCompatibility).toHaveBeenCalled();
    // The exact tracked version that was shown, not 'supported' re-resolved.
    expect(installVersion).toHaveBeenCalledWith('0.129.0');
    expect(restoreCliBinLinkMock).toHaveBeenCalledOnce();
    expect(spinnerSucceedMock).toHaveBeenCalledWith(
      'OpenAI Codex CLI v0.129.0 installed successfully'
    );
  });

  function codexWithUnknownTrackedVersion(installed: boolean, installVersion = vi.fn().mockResolvedValue('0.170.0')) {
    return {
      name: 'codex',
      displayName: 'OpenAI Codex CLI',
      description: 'OpenAI Codex CLI - AI coding agent by OpenAI',
      metadata: {},
      isInstalled: vi.fn().mockResolvedValue(installed),
      install: vi.fn().mockResolvedValue(undefined),
      installVersion,
      checkVersionCompatibility: vi.fn().mockResolvedValue({
        supportedVersion: 'latest',
        installedVersion: installed ? '0.150.0' : null,
        compatible: true,
        isNewer: false,
        hasUpdate: false,
        isBelowMinimum: false,
        versionKnown: false,
      }),
      getVersion: vi.fn().mockResolvedValue(installed ? '0.150.0' : '0.170.0'),
      warnOnceIfUntested: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('--supported asks before reinstalling the latest release when the tracked version is unknown', async () => {
    const agent = codexWithUnknownTrackedVersion(true);
    getAgentMock.mockReturnValue(agent);
    promptMock.mockResolvedValue({ confirm: true });

    const { createInstallCommand } = await import('../install.js');
    await createInstallCommand().parseAsync(['node', 'codemie', 'codex', '--supported']);

    expect(promptMock).toHaveBeenCalledWith([
      expect.objectContaining({ message: 'Reinstall with the latest release?', default: false }),
    ]);
    expect(agent.installVersion).toHaveBeenCalledWith('supported');
  });

  it('--supported leaves the installed agent alone when the reinstall is declined', async () => {
    const agent = codexWithUnknownTrackedVersion(true);
    getAgentMock.mockReturnValue(agent);
    promptMock.mockResolvedValue({ confirm: false });

    const { createInstallCommand } = await import('../install.js');
    await createInstallCommand().parseAsync(['node', 'codemie', 'codex', '--supported']);

    expect(agent.installVersion).not.toHaveBeenCalled();
    const printed = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(printed).toContain('Installation cancelled');
  });

  it('--supported installs the latest release without asking when the agent is not installed', async () => {
    const agent = codexWithUnknownTrackedVersion(false);
    getAgentMock.mockReturnValue(agent);

    const { createInstallCommand } = await import('../install.js');
    await createInstallCommand().parseAsync(['node', 'codemie', 'codex', '--supported']);

    expect(promptMock).not.toHaveBeenCalled();
    expect(agent.installVersion).toHaveBeenCalledWith('supported');
    const printed = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(printed).toContain('Tracked version unavailable');
  });

  it('a plain install of an installed agent stays a no-op when the tracked version is unknown', async () => {
    const installVersion = vi.fn();
    const install = vi.fn();

    getAgentMock.mockReturnValue({
      name: 'codex',
      displayName: 'OpenAI Codex CLI',
      description: 'OpenAI Codex CLI - AI coding agent by OpenAI',
      metadata: {},
      isInstalled: vi.fn().mockResolvedValue(true),
      install,
      installVersion,
      checkVersionCompatibility: vi.fn().mockResolvedValue({
        supportedVersion: 'latest',
        installedVersion: '0.150.0',
        compatible: true,
        isNewer: false,
        hasUpdate: false,
        isBelowMinimum: false,
        versionKnown: false,
      }),
      getVersion: vi.fn().mockResolvedValue('0.150.0'),
      warnOnceIfUntested: vi.fn().mockResolvedValue(undefined),
    });

    const { createInstallCommand } = await import('../install.js');
    const command = createInstallCommand();

    await command.parseAsync(['node', 'codemie', 'codex']);

    expect(installVersion).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    const printed = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(printed).toContain('is already installed');
  });

  function codexWithLaggingRegistry(installed: boolean) {
    return {
      ...codexWithUnknownTrackedVersion(installed),
      checkVersionCompatibility: vi.fn().mockResolvedValue({
        supportedVersion: 'latest',
        installedVersion: installed ? '0.150.0' : null,
        compatible: installed,
        isNewer: false,
        hasUpdate: false,
        isBelowMinimum: false,
        minimumSupportedVersion: '0.143.0',
        versionKnown: false,
        liveBelowMinimum: true,
        registryLatestVersion: '0.140.0',
      }),
    };
  }

  describe('when the registry latest is below the minimum', () => {
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    function expectStoppedWithBelowMinimumError(agent: ReturnType<typeof codexWithLaggingRegistry>): void {
      expect(agent.install).not.toHaveBeenCalled();
      expect(agent.installVersion).not.toHaveBeenCalled();
      expect(promptMock).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
      const errors = errorSpy.mock.calls.flat().join('\n');
      expect(errors).toContain(
        "OpenAI Codex CLI: the registry's latest release v0.140.0 is below the minimum supported v0.143.0"
      );
      expect(errors).toContain('codemie install codex <version>');
      const printed = vi.mocked(console.log).mock.calls.flat().join('\n');
      expect(printed).not.toContain('Tracked version unavailable');
    }

    it('a plain install stops instead of installing the lagging latest release', async () => {
      const agent = codexWithLaggingRegistry(false);
      getAgentMock.mockReturnValue(agent);

      const { createInstallCommand } = await import('../install.js');
      await createInstallCommand().parseAsync(['node', 'codemie', 'codex']);

      expectStoppedWithBelowMinimumError(agent);
    });

    it('a plain install of an already installed agent stays a no-op instead of erroring', async () => {
      const agent = codexWithLaggingRegistry(true);
      getAgentMock.mockReturnValue(agent);

      const { createInstallCommand } = await import('../install.js');
      await createInstallCommand().parseAsync(['node', 'codemie', 'codex']);

      expect(exitSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(agent.install).not.toHaveBeenCalled();
      expect(agent.installVersion).not.toHaveBeenCalled();
      expect(promptMock).not.toHaveBeenCalled();
      const printed = vi.mocked(console.log).mock.calls.flat().join('\n');
      expect(printed).toContain('is already installed');
    });

    it('--supported stops without offering a reinstall of the latest release', async () => {
      const agent = codexWithLaggingRegistry(true);
      getAgentMock.mockReturnValue(agent);
      promptMock.mockResolvedValue({ confirm: true });

      const { createInstallCommand } = await import('../install.js');
      await createInstallCommand().parseAsync(['node', 'codemie', 'codex', '--supported']);

      expectStoppedWithBelowMinimumError(agent);
    });
  });

  it('--supported on an agent with no tracked version says so and installs the latest release', async () => {
    const installVersion = vi.fn().mockResolvedValue('1.2.0');
    getAgentMock.mockReturnValue({
      name: 'opencode',
      displayName: 'OpenCode',
      description: 'OpenCode',
      metadata: { name: 'opencode', npmPackage: 'opencode-ai' },
      isInstalled: vi.fn().mockResolvedValue(false),
      install: vi.fn().mockResolvedValue(undefined),
      installVersion,
      checkVersionCompatibility: vi.fn().mockResolvedValue({
        supportedVersion: 'latest',
        installedVersion: null,
        compatible: false,
        isNewer: false,
        hasUpdate: false,
        isBelowMinimum: false,
        versionKnown: false,
      }),
      getVersion: vi.fn().mockResolvedValue('1.2.0'),
      warnOnceIfUntested: vi.fn().mockResolvedValue(undefined),
    });

    const { createInstallCommand } = await import('../install.js');
    await createInstallCommand().parseAsync(['node', 'codemie', 'opencode', '--supported']);

    expect(installVersion).toHaveBeenCalledWith('supported');
    const printed = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(printed).toContain('OpenCode has no tracked version');
    expect(printed).toContain('installing the latest release');
    expect(printed).not.toContain('version checks disabled');
    expect(printed).not.toContain('npm unreachable');
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
      warnOnceIfUntested: vi.fn().mockResolvedValue(undefined),
    });

    const { createInstallCommand } = await import('../install.js');
    const command = createInstallCommand();

    await command.parseAsync(['node', 'codemie', 'claude']);

    expect(installVersion).toHaveBeenCalledWith('2.1.34');
    // must show the version from installVersion(), not the stale '2.1.33' from getVersion()
    expect(spinnerSucceedMock).toHaveBeenCalledWith('Claude Code v2.1.34 installed successfully');
  });

  it('warns when detected version does not match requested version (stale PATH)', async () => {
    // Simulates Windows: installVersion() returns the old PATH version, not the one just installed
    const installVersion = vi.fn().mockResolvedValue('2.1.33');
    const getVersion = vi.fn().mockResolvedValue('2.1.33');

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
      warnOnceIfUntested: vi.fn().mockResolvedValue(undefined),
    });

    const { createInstallCommand } = await import('../install.js');
    const command = createInstallCommand();

    await command.parseAsync(['node', 'codemie', 'claude', '2.1.34']);

    expect(spinnerSucceedMock).not.toHaveBeenCalled();
    expect(spinnerWarnMock).toHaveBeenCalledTimes(1);
    const [actualArg] = spinnerWarnMock.mock.calls[0];
    expect(actualArg).toContain('v2.1.33');
    expect(actualArg).toContain('v2.1.34');
    expect(actualArg).toContain('terminal restart');
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
      warnOnceIfUntested: vi.fn().mockResolvedValue(undefined),
    });

    const { createInstallCommand } = await import('../install.js');
    const command = createInstallCommand();

    await command.parseAsync(['node', 'codemie', 'claude']);

    expect(getVersion).toHaveBeenCalled(); // fallback path exercised
    expect(spinnerSucceedMock).toHaveBeenCalledWith('Claude Code v2.1.34 installed successfully');
  });
});
