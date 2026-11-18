import { beforeEach, describe, expect, it, vi } from 'vitest';

const order: string[] = [];
const getAgentMock = vi.fn();
const checkMock = vi.fn();
const applyMock = vi.fn();
const getActiveProfileNameMock = vi.fn();
const getProfileMock = vi.fn();
const canPromptMock = vi.fn();
const promptMock = vi.fn();

vi.mock('../../../agents/registry.js', () => ({
  AgentRegistry: { getAgent: getAgentMock, getAllAgents: vi.fn(() => []), getManageableAgents: vi.fn(() => []) },
}));
vi.mock('../../../utils/cli-bin.js', () => ({ restoreCliBinLink: vi.fn() }));
vi.mock('../../../utils/logger.js', () => ({ logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../utils/config.js', () => ({
  ConfigLoader: { getActiveProfileName: getActiveProfileNameMock, getProfile: getProfileMock },
}));
vi.mock('../../../utils/interactive.js', () => ({ canPromptForProject: canPromptMock }));
vi.mock('inquirer', () => ({ default: { prompt: promptMock } }));
vi.mock('ora', () => ({
  default: vi.fn(() => ({ start: vi.fn(() => ({ succeed: vi.fn(), fail: vi.fn(), warn: vi.fn() })) })),
}));

interface FakeAgentOptions {
  name?: string;
  installed?: boolean;
  installedVersion?: string;
  withAdditional?: boolean;
  /** Whether the adapter implements `checkProviderSettings` (the Claude adapters do). */
  withCheck?: boolean;
}

function fakeAgent(opts: FakeAgentOptions = {}): Record<string, ReturnType<typeof vi.fn> | string | object> {
  const agent: Record<string, ReturnType<typeof vi.fn> | string | object> = {
    name: opts.name ?? 'claude',
    displayName: 'Claude Code',
    metadata: {},
    isInstalled: vi.fn().mockResolvedValue(opts.installed ?? false),
    install: vi.fn(async () => { order.push('install'); }),
    installVersion: vi.fn(async () => { order.push('install'); return '2.1.34'; }),
    checkVersionCompatibility: vi.fn().mockResolvedValue({ supportedVersion: '2.1.34' }),
    getVersion: vi.fn().mockResolvedValue(opts.installedVersion ?? '2.1.34'),
    warnOnceIfUntested: vi.fn().mockResolvedValue(undefined),
  };
  if (opts.withCheck ?? true) {
    agent.checkProviderSettings = checkMock;
  }
  if (opts.withAdditional) {
    agent.additionalInstallation = vi.fn(async () => { order.push('additional'); });
  }
  return agent;
}

async function runInstall(...args: string[]): Promise<void> {
  const { createInstallCommand } = await import('../install.js');
  await createInstallCommand().parseAsync(['node', 'codemie', ...args]);
}

describe('install command provider settings check', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    canPromptMock.mockReturnValue(true);
    getActiveProfileNameMock.mockResolvedValue('work');
    getProfileMock.mockResolvedValue({ provider: 'ai-run-sso' });
    checkMock.mockResolvedValue({ kind: 'proceed', apply: applyMock });
    applyMock.mockImplementation(async () => {
      order.push('apply');
      return { backupDir: null };
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
  });

  it('leaves an agent without the check untouched', async () => {
    getAgentMock.mockReturnValue(fakeAgent({ name: 'codex', withCheck: false }));

    await runInstall('codex');

    expect(checkMock).not.toHaveBeenCalled();
    expect(applyMock).not.toHaveBeenCalled();
    expect(getActiveProfileNameMock).not.toHaveBeenCalled();
  });

  it('passes no profile to the check when none is active', async () => {
    getActiveProfileNameMock.mockResolvedValue(null);
    getAgentMock.mockReturnValue(fakeAgent());

    await runInstall('claude');

    expect(checkMock).toHaveBeenCalledWith(
      expect.objectContaining({ flow: 'install', profile: undefined })
    );
    expect(getProfileMock).not.toHaveBeenCalled();
  });

  it('passes no profile to the check when loading it fails', async () => {
    getActiveProfileNameMock.mockRejectedValue(new Error('broken config'));
    getAgentMock.mockReturnValue(fakeAgent());

    await runInstall('claude');

    expect(checkMock).toHaveBeenCalledWith(expect.objectContaining({ profile: undefined }));
  });

  it('hands the active profile and the prompt capability to the check', async () => {
    canPromptMock.mockReturnValue(false);
    getAgentMock.mockReturnValue(fakeAgent());

    await runInstall('claude');

    expect(checkMock).toHaveBeenCalledWith({
      flow: 'install',
      canPrompt: false,
      profile: { provider: 'ai-run-sso' },
    });
  });

  it('prints the guidance and exits 1 on stop, changing nothing', async () => {
    checkMock.mockResolvedValue({ kind: 'stop', guidance: 'GUIDANCE TEXT' });
    const agent = fakeAgent();
    getAgentMock.mockReturnValue(agent);

    await expect(runInstall('claude')).rejects.toThrow('exit:1');

    expect(errorSpy).toHaveBeenCalledWith('GUIDANCE TEXT');
    expect(applyMock).not.toHaveBeenCalled();
    expect(agent.install).not.toHaveBeenCalled();
    expect(agent.installVersion).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });

  it('applies nothing when the reinstall is declined', async () => {
    const agent = fakeAgent({ installed: true, installedVersion: '2.0.0' });
    getAgentMock.mockReturnValue(agent);
    promptMock.mockResolvedValue({ confirm: false });

    await runInstall('claude');

    expect(checkMock).toHaveBeenCalledOnce();
    expect(applyMock).not.toHaveBeenCalled();
    expect(agent.installVersion).not.toHaveBeenCalled();
  });

  it('applies after the reinstall confirmation and before the install', async () => {
    getAgentMock.mockReturnValue(fakeAgent({ installed: true, installedVersion: '2.0.0' }));
    promptMock.mockImplementation(async () => {
      order.push('confirm');
      return { confirm: true };
    });

    await runInstall('claude');

    expect(order).toEqual(['confirm', 'apply', 'install']);
  });

  it('applies before a fresh install', async () => {
    getAgentMock.mockReturnValue(fakeAgent());

    await runInstall('claude');

    expect(order).toEqual(['apply', 'install']);
  });

  it('applies before additionalInstallation when already installed', async () => {
    getAgentMock.mockReturnValue(fakeAgent({ installed: true, installedVersion: '2.1.34', withAdditional: true }));

    await runInstall('claude');

    expect(order).toEqual(['apply', 'additional']);
  });

  it('applies nothing when already installed and no step runs', async () => {
    getAgentMock.mockReturnValue(fakeAgent({ installed: true, installedVersion: '2.1.34' }));

    await runInstall('claude');

    expect(applyMock).not.toHaveBeenCalled();
  });

  it('prints the backup folder when the install fails after a switch was applied', async () => {
    applyMock.mockResolvedValue({ backupDir: '/tmp/backup-dir' });
    const agent = fakeAgent();
    (agent.installVersion as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('npm failed'));
    getAgentMock.mockReturnValue(agent);

    await expect(runInstall('claude')).rejects.toThrow('exit:1');

    expect(errorSpy.mock.calls.flat().join('\n')).toContain('Backup of your Claude Code settings: /tmp/backup-dir');
  });

  it('prints the backup folder when additionalInstallation fails after a switch on an installed agent', async () => {
    applyMock.mockResolvedValue({ backupDir: '/tmp/backup-dir' });
    const agent = fakeAgent({ installed: true, installedVersion: '2.1.34', withAdditional: true });
    (agent.additionalInstallation as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('extra failed'));
    getAgentMock.mockReturnValue(agent);

    await expect(runInstall('claude')).rejects.toThrow('exit:1');

    expect(errorSpy.mock.calls.flat().join('\n')).toContain('Backup of your Claude Code settings: /tmp/backup-dir');
  });

  it('prints no backup line when the install fails and nothing was switched', async () => {
    const agent = fakeAgent();
    (agent.installVersion as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('npm failed'));
    getAgentMock.mockReturnValue(agent);

    await expect(runInstall('claude')).rejects.toThrow('exit:1');

    expect(errorSpy.mock.calls.flat().join('\n')).not.toContain('Backup of your Claude Code settings');
  });
});
