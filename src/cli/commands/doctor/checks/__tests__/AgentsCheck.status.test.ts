import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../../../agents/registry.js', () => ({
  AgentRegistry: {
    getInstalledAgents: vi.fn(),
  },
}));

vi.mock('../../../../../utils/version-warnings.js', () => ({
  VersionWarningStore: {
    hasWarned: vi.fn(),
  },
}));

vi.mock('../../../../../utils/cli-updater.js', () => ({
  getCurrentCliVersion: vi.fn(async () => '0.11.0'),
}));

interface StubAgent {
  name: string;
  displayName: string;
  getVersion: () => Promise<string | null>;
  getInstallationMethod?: () => Promise<string>;
}

function makeAgent(overrides: Partial<StubAgent>): StubAgent {
  return {
    name: 'claude',
    displayName: 'Claude Code',
    getVersion: vi.fn(async () => '2.1.219'),
    ...overrides,
  };
}

describe('AgentsCheck status field', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders Acknowledged when marker exists for installed version', async () => {
    const { AgentRegistry } = await import('../../../../../agents/registry.js');
    const { VersionWarningStore } = await import('../../../../../utils/version-warnings.js');
    vi.mocked(AgentRegistry.getInstalledAgents).mockResolvedValue([makeAgent({}) as any]);
    vi.mocked(VersionWarningStore.hasWarned).mockResolvedValue(true);
    const { AgentsCheck } = await import('../AgentsCheck.js');
    const result = await new AgentsCheck().run();
    expect(result.details).toHaveLength(1);
    expect(result.details[0].status).toBe('ok');
    expect(result.details[0].message).toContain('Claude Code');
    expect(result.details[0].message).toContain('2.1.219');
    expect(result.details[0].message).toContain('Acknowledged');
    expect(result.details[0].message).toContain('0.11.0');
  });

  it('renders Untested when no marker exists for installed version', async () => {
    const { AgentRegistry } = await import('../../../../../agents/registry.js');
    const { VersionWarningStore } = await import('../../../../../utils/version-warnings.js');
    vi.mocked(AgentRegistry.getInstalledAgents).mockResolvedValue([makeAgent({}) as any]);
    vi.mocked(VersionWarningStore.hasWarned).mockResolvedValue(false);
    const { AgentsCheck } = await import('../AgentsCheck.js');
    const result = await new AgentsCheck().run();
    expect(result.details[0].status).toBe('warn');
    expect(result.details[0].message).toContain('Untested');
    expect(result.details[0].message).toContain('0.11.0');
  });

  it('renders Not installed when getVersion returns null', async () => {
    const { AgentRegistry } = await import('../../../../../agents/registry.js');
    vi.mocked(AgentRegistry.getInstalledAgents).mockResolvedValue([
      makeAgent({ getVersion: vi.fn(async () => null) }) as any,
    ]);
    const { AgentsCheck } = await import('../AgentsCheck.js');
    const result = await new AgentsCheck().run();
    expect(result.details[0].status).toBe('info');
    expect(result.details[0].message).toContain('Not installed');
  });

  it('renders Untested when VersionWarningStore.hasWarned throws (does not crash doctor)', async () => {
    const { AgentRegistry } = await import('../../../../../agents/registry.js');
    const { VersionWarningStore } = await import('../../../../../utils/version-warnings.js');
    vi.mocked(AgentRegistry.getInstalledAgents).mockResolvedValue([makeAgent({}) as any]);
    vi.mocked(VersionWarningStore.hasWarned).mockRejectedValue(new Error('EACCES'));
    const { AgentsCheck } = await import('../AgentsCheck.js');
    const result = await new AgentsCheck().run();
    // Must degrade gracefully to Untested, not reject the whole run — CR-003.
    expect(result.details[0].status).toBe('warn');
    expect(result.details[0].message).toContain('Untested');
  });

  it('preserves deprecated npm install warning', async () => {
    const { AgentRegistry } = await import('../../../../../agents/registry.js');
    vi.mocked(AgentRegistry.getInstalledAgents).mockResolvedValue([
      makeAgent({
        getInstallationMethod: vi.fn(async () => 'npm'),
      }) as any,
    ]);
    const { AgentsCheck } = await import('../AgentsCheck.js');
    const result = await new AgentsCheck().run();
    // Deprecation warning takes precedence — existing behavior
    expect(result.details[0].status).toBe('warn');
    expect(result.details[0].message).toContain('deprecated');
  });
});
