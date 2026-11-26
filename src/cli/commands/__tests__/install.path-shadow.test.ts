import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShadowVerdict } from '../../../utils/path-shadow.js';

const getAgentMock = vi.fn();
const restoreCliBinLinkMock = vi.fn();
const spinnerSucceedMock = vi.fn();
const spinnerFailMock = vi.fn();
const spinnerWarnMock = vi.fn();

vi.mock('../../../agents/registry.js', () => ({
  AgentRegistry: {
    getAgent: getAgentMock,
    getAllAgents: vi.fn(() => []),
    getManageableAgents: vi.fn(() => []),
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
      warn: spinnerWarnMock,
    })),
  })),
}));

const SHADOWED: ShadowVerdict = {
  status: 'shadowed',
  active: 'C:\\Tools\\bin\\pi.cmd',
  managedDir: 'C:\\Users\\u\\AppData\\Roaming\\npm',
};
const MISSING_ON_PATH: ShadowVerdict = {
  status: 'missing-on-path',
  managedDir: 'C:\\Users\\u\\AppData\\Roaming\\npm',
  shimPath: 'C:\\Users\\u\\AppData\\Roaming\\npm\\pi.cmd',
};

function makeAgent(verdict: ShadowVerdict, installed: boolean): Record<string, unknown> {
  return {
    name: 'pi',
    displayName: 'Pi',
    description: 'Pi agent',
    metadata: {},
    isInstalled: vi.fn().mockResolvedValue(installed),
    install: vi.fn().mockResolvedValue(undefined),
    getVersion: vi.fn().mockResolvedValue('1.0.0'),
    warnOnceIfUntested: vi.fn().mockResolvedValue(undefined),
    checkPathShadow: vi.fn().mockResolvedValue(verdict),
  };
}

async function runInstall(): Promise<string> {
  const logSpy = vi.mocked(console.log);
  const { createInstallCommand } = await import('../install.js');
  await createInstallCommand().parseAsync(['node', 'codemie', 'pi']);
  return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

describe('install command PATH shadow surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  it('prints the shadow warning after a successful install and keeps exit code', async () => {
    const agent = makeAgent(SHADOWED, false);
    getAgentMock.mockReturnValue(agent);
    const out = await runInstall();
    expect(agent.checkPathShadow).toHaveBeenCalledWith({ resolvePrefix: true });
    expect(spinnerSucceedMock).toHaveBeenCalled();
    expect(out).toContain('shadows the CodeMie-managed');
    expect(out).toContain(SHADOWED.status === 'shadowed' ? SHADOWED.active : '');
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('prints the not-on-PATH hint after a successful install and keeps exit code', async () => {
    getAgentMock.mockReturnValue(makeAgent(MISSING_ON_PATH, false));
    const out = await runInstall();
    expect(out).toContain('Agent not found on PATH');
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('prints the warning after "already installed" on repeat install', async () => {
    getAgentMock.mockReturnValue(makeAgent(SHADOWED, true));
    const out = await runInstall();
    expect(out.indexOf('is already installed')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('shadows the CodeMie-managed')).toBeGreaterThan(out.indexOf('is already installed'));
  });

  it('prints the hint after "already installed" on repeat install', async () => {
    getAgentMock.mockReturnValue(makeAgent(MISSING_ON_PATH, true));
    const out = await runInstall();
    expect(out.indexOf('Agent not found on PATH')).toBeGreaterThan(out.indexOf('is already installed'));
  });

  it.each([['clear'], ['missing'], ['unknown']] as const)('prints nothing extra for %s', async (status) => {
    getAgentMock.mockReturnValue(makeAgent({ status } as ShadowVerdict, false));
    const out = await runInstall();
    expect(out).not.toContain('shadows the CodeMie-managed');
    expect(out).not.toContain('not found on PATH');
  });

  it('prints nothing extra when the check throws', async () => {
    const agent = makeAgent(SHADOWED, false);
    agent.checkPathShadow = vi.fn().mockRejectedValue(new Error('boom'));
    getAgentMock.mockReturnValue(agent);
    const out = await runInstall();
    expect(out).not.toContain('shadows the CodeMie-managed');
    expect(spinnerSucceedMock).toHaveBeenCalled();
  });
});
