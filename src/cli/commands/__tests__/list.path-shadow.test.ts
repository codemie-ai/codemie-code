import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShadowVerdict } from '../../../utils/path-shadow.js';

const getManageableAgentsMock = vi.fn();

vi.mock('../../../agents/registry.js', () => ({
  AgentRegistry: {
    getManageableAgents: getManageableAgentsMock,
    getInstalledAgents: vi.fn(async () => []),
  },
}));

vi.mock('../../../frameworks/index.js', () => ({
  FrameworkRegistry: { getAllFrameworks: vi.fn(() => []) },
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
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

function makeAgent(
  name: string,
  verdict: ShadowVerdict,
  installed: boolean,
  onCheck?: () => void
): Record<string, unknown> {
  return {
    name,
    displayName: name.toUpperCase(),
    description: `${name} agent`,
    isInstalled: vi.fn().mockResolvedValue(installed),
    getVersion: vi.fn().mockResolvedValue('1.0.0'),
    checkPathShadow: vi.fn(async () => {
      onCheck?.();
      await new Promise((r) => setTimeout(r, 5));
      return verdict;
    }),
  };
}

async function runList(): Promise<string> {
  const { createListCommand } = await import('../list.js');
  await createListCommand().parseAsync(['node', 'codemie']);
  return vi.mocked(console.log).mock.calls.map((c) => c.join(' ')).join('\n');
}

describe('list command PATH shadow surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  it('shows both locations for a shadowed installed agent', async () => {
    getManageableAgentsMock.mockReturnValue([makeAgent('pi', SHADOWED, true)]);
    const out = await runList();
    expect(out).toContain('shadowed');
    expect(out).toContain(SHADOWED.active);
    expect(out).toContain(SHADOWED.managedDir);
  });

  it('keeps shadow info when isInstalled disagrees with the verdict', async () => {
    getManageableAgentsMock.mockReturnValue([makeAgent('pi', SHADOWED, false)]);
    const out = await runList();
    expect(out).toContain('shadowed');
    expect(out).toContain(SHADOWED.active);
  });

  it('shows "not found on PATH" instead of bare "not installed" for missing-on-path', async () => {
    getManageableAgentsMock.mockReturnValue([makeAgent('pi', MISSING_ON_PATH, false)]);
    const out = await runList();
    expect(out).toContain('not found on PATH');
    expect(out).toContain(MISSING_ON_PATH.managedDir);
    expect(out).not.toContain('not installed');
  });

  it('keeps plain "not installed" with no hint for a missing agent', async () => {
    getManageableAgentsMock.mockReturnValue([makeAgent('pi', { status: 'missing' }, false)]);
    const out = await runList();
    expect(out).toContain('not installed');
    expect(out).not.toContain('not found on PATH');
  });

  it('starts every verdict lookup before the first row prints', async () => {
    let started = 0;
    const onCheck = (): void => {
      started++;
    };
    getManageableAgentsMock.mockReturnValue([
      makeAgent('a', { status: 'clear' }, true, onCheck),
      makeAgent('b', { status: 'clear' }, true, onCheck),
      makeAgent('c', { status: 'clear' }, true, onCheck),
    ]);
    let startedAtFirstRow = -1;
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      if (startedAtFirstRow < 0 && args.join(' ').includes('Command:')) startedAtFirstRow = started;
    });
    await runList();
    expect(startedAtFirstRow).toBe(3);
  });
});
