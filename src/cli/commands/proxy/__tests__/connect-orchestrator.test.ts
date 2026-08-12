/**
 * connect-orchestrator unit tests
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveDaemonIdentity, type ConnectTargets } from '../connect-orchestrator.js';

vi.mock('../../../../utils/config.js', () => ({
  ConfigLoader: {
    load: vi.fn(),
    listProfiles: vi.fn(),
    getActiveProfileName: vi.fn(),
  },
}));
vi.mock('../../../../providers/index.js', () => ({
  ProviderRegistry: { getProvider: vi.fn() },
}));
vi.mock('../daemon-manager.js', () => ({
  checkStatus: vi.fn(),
  readState: vi.fn(),
  spawnDaemon: vi.fn(),
  stopDaemon: vi.fn(),
}));
vi.mock('../health-check.js', () => ({
  checkProxyHealth: vi.fn(),
}));
vi.mock('../connectors/desktop.js', () => ({
  writeDesktopConfig: vi.fn(),
  getDesktopBaseDir: vi.fn().mockReturnValue('/mock/desktop/base'),
  mapCanonicalToDesktop: vi.fn().mockReturnValue([]),
}));
vi.mock('../connectors/vscode.js', () => ({
  writeVsCodeLanguageModelsConfig: vi.fn(),
}));
vi.mock('../connectors/vscode-claude-code.js', () => ({
  writeVsCodeClaudeCodeConfig: vi.fn(),
}));
vi.mock('../connectors/managed-mcp-remote.js', () => ({
  fetchManagedMcpServers: vi.fn().mockResolvedValue([]),
}));
vi.mock('../connectors/vscode-models.js', () => ({
  VS_CODE_SUPPORTED_MODELS: ['model-a', 'model-b', 'model-c'],
}));
vi.mock('../../../../providers/integration/setup-ui.js', () => ({
  displaySetupInstructions: vi.fn(),
}));
vi.mock('../../../../providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: vi.fn(),
}));
vi.mock('../../../../cli/commands/skills/setup/sync.js', () => ({
  syncRegisteredSkills: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../cli/commands/skills/setup/sync-plugin.js', () => ({
  syncPluginSkills: vi.fn().mockResolvedValue(undefined),
}));

// ── shared test helpers ──────────────────────────────────────────────────────

async function setupHappyMocks(configOverrides: Record<string, unknown> = {}): Promise<void> {
  const { ConfigLoader } = await import('../../../../utils/config.js');
  const { ProviderRegistry } = await import('../../../../providers/index.js');
  const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
  vi.mocked(ConfigLoader.load).mockResolvedValue({
    name: 'p',
    provider: 'ai-run-sso',
    baseUrl: 'https://x.example.com/api',
    codeMieUrl: 'https://x.example.com',
    codeMieProject: 'proj',
    ...configOverrides,
  } as Awaited<ReturnType<typeof ConfigLoader.load>>);
  vi.mocked(ProviderRegistry.getProvider).mockReturnValue({
    name: 'ai-run-sso',
    authType: 'sso',
  } as ReturnType<typeof ProviderRegistry.getProvider>);
  vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
    return { getStoredCredentials: vi.fn().mockResolvedValue({ token: 't' }) };
  } as unknown as typeof CodeMieSSO);
}

function daemonState(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: process.pid,
    port: 4001,
    url: 'http://127.0.0.1:4001',
    profile: 'p',
    gatewayKey: 'gk',
    startedAt: new Date().toISOString(),
    ...extra,
  };
}

// A running daemon whose fields match the happy-path config for a claude-desktop request.
function matchingDesktopState(): Record<string, unknown> {
  return daemonState({
    provider: 'ai-run-sso',
    targetUrl: 'https://x.example.com/api',
    project: 'proj',
    telemetryMode: 'claude-desktop',
    syncCodeMieUrl: 'https://x.example.com',
  });
}

function spyConsole(): {
  restore: () => void;
  log: () => ReturnType<typeof vi.spyOn>;
} {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
    throw new Error(`process.exit:${code}`);
  });
  return {
    restore: () => {
      logSpy.mockRestore();
      errSpy.mockRestore();
      exitSpy.mockRestore();
    },
    log: () => logSpy,
  };
}

describe('deriveDaemonIdentity', () => {
  const cases: Array<{
    name: string;
    targets: ConnectTargets;
    clientType: 'claude-desktop' | 'vscode-byok';
    spawn: Record<string, string>;
  }> = [
    { name: 'claude-desktop only', targets: { claudeDesktop: true }, clientType: 'claude-desktop', spawn: { telemetryMode: 'claude-desktop' } },
    { name: 'vscode only', targets: { vscode: true }, clientType: 'vscode-byok', spawn: { clientType: 'vscode-byok' } },
    { name: 'vscode-claude-code only', targets: { vscodeClaudeCode: true }, clientType: 'claude-desktop', spawn: { telemetryMode: 'claude-desktop' } },
    { name: 'claude-desktop + vscode', targets: { claudeDesktop: true, vscode: true }, clientType: 'claude-desktop', spawn: { telemetryMode: 'claude-desktop' } },
    { name: 'claude-desktop + vscode-claude-code', targets: { claudeDesktop: true, vscodeClaudeCode: true }, clientType: 'claude-desktop', spawn: { telemetryMode: 'claude-desktop' } },
    { name: 'vscode + vscode-claude-code', targets: { vscode: true, vscodeClaudeCode: true }, clientType: 'claude-desktop', spawn: { telemetryMode: 'claude-desktop' } },
    { name: 'all three', targets: { claudeDesktop: true, vscode: true, vscodeClaudeCode: true }, clientType: 'claude-desktop', spawn: { telemetryMode: 'claude-desktop' } },
  ];

  for (const c of cases) {
    it(`maps ${c.name} onto ${c.clientType}`, () => {
      const identity = deriveDaemonIdentity(c.targets);
      expect(identity.clientType).toBe(c.clientType);
      expect(identity.spawnOptions).toEqual(c.spawn);
    });
  }

  it('only ever produces the two existing identities (no new telemetry value)', () => {
    for (const c of cases) {
      const { clientType, spawnOptions } = deriveDaemonIdentity(c.targets);
      expect(['claude-desktop', 'vscode-byok']).toContain(clientType);
      if ('telemetryMode' in spawnOptions) {
        expect(spawnOptions.telemetryMode).toBe('claude-desktop');
        expect(spawnOptions).not.toHaveProperty('clientType');
      } else {
        expect(spawnOptions.clientType).toBe('vscode-byok');
        expect(spawnOptions).not.toHaveProperty('telemetryMode');
      }
    }
  });
});

describe('connectTargets — no-write paths and daemon lifecycle', () => {
  let console_: ReturnType<typeof spyConsole>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.exitCode = 0;
    console_ = spyConsole();
  });

  afterEach(() => {
    console_.restore();
    process.exitCode = 0;
  });

  it('bare connect: prints the target list, writes nothing, exit code stays 0', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: {} });

    expect(ConfigLoader.load).not.toHaveBeenCalled();
    expect(checkStatus).not.toHaveBeenCalled();
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(console_.log()).toHaveBeenCalledWith(expect.stringContaining('--claude-desktop'));
    expect(console_.log()).toHaveBeenCalledWith(expect.stringContaining('--vscode-claude-code'));
    expect(process.exitCode).toBe(0);
  });

  it('--insiders with only --claude-desktop warns and continues', async () => {
    await setupHappyMocks();
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(spawnDaemon).mockResolvedValue(
      daemonState({ telemetryMode: 'claude-desktop', syncCodeMieUrl: 'https://x.example.com' }) as Awaited<ReturnType<typeof spawnDaemon>>
    );
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true }, insiders: true });

    expect(console_.log()).toHaveBeenCalledWith(expect.stringContaining('--insiders has no effect'));
    expect(spawnDaemon).toHaveBeenCalled();
  });

  it('reuses a healthy matching daemon (no stop, no spawn)', async () => {
    await setupHappyMocks();
    const { checkStatus, spawnDaemon, stopDaemon } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    vi.mocked(checkStatus).mockResolvedValue({ running: true, state: matchingDesktopState() as Awaited<ReturnType<typeof checkStatus>>['state'] });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'deep', code: 'ok' });
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true } });

    expect(stopDaemon).not.toHaveBeenCalled();
    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  it('restarts when the running daemon does not match the request', async () => {
    await setupHappyMocks();
    const { checkStatus, spawnDaemon, stopDaemon } = await import('../daemon-manager.js');
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: daemonState({ profile: 'other', provider: 'ai-run-sso', targetUrl: 'https://x.example.com/api', project: 'proj', telemetryMode: 'claude-desktop' }) as Awaited<ReturnType<typeof checkStatus>>['state'],
    });
    vi.mocked(spawnDaemon).mockResolvedValue(
      daemonState({ telemetryMode: 'claude-desktop', syncCodeMieUrl: 'https://x.example.com' }) as Awaited<ReturnType<typeof spawnDaemon>>
    );
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true } });

    expect(stopDaemon).toHaveBeenCalled();
    expect(spawnDaemon).toHaveBeenCalled();
  });

  it('restarts on --force even when a matching daemon is running (skips health check)', async () => {
    await setupHappyMocks();
    const { checkStatus, spawnDaemon, stopDaemon } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    vi.mocked(checkStatus).mockResolvedValue({ running: true, state: matchingDesktopState() as Awaited<ReturnType<typeof checkStatus>>['state'] });
    vi.mocked(spawnDaemon).mockResolvedValue(
      daemonState({ telemetryMode: 'claude-desktop', syncCodeMieUrl: 'https://x.example.com' }) as Awaited<ReturnType<typeof spawnDaemon>>
    );
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true }, force: true });

    expect(stopDaemon).toHaveBeenCalled();
    expect(spawnDaemon).toHaveBeenCalled();
    expect(checkProxyHealth).not.toHaveBeenCalled();
  });

  it('restarts when a matching daemon is unhealthy', async () => {
    await setupHappyMocks();
    const { checkStatus, spawnDaemon, stopDaemon } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    vi.mocked(checkStatus).mockResolvedValue({ running: true, state: matchingDesktopState() as Awaited<ReturnType<typeof checkStatus>>['state'] });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: false, level: 'deep', code: 'unauthorized', reason: 'expired' });
    vi.mocked(spawnDaemon).mockResolvedValue(
      daemonState({ telemetryMode: 'claude-desktop', syncCodeMieUrl: 'https://x.example.com' }) as Awaited<ReturnType<typeof spawnDaemon>>
    );
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true } });

    expect(stopDaemon).toHaveBeenCalled();
    expect(spawnDaemon).toHaveBeenCalled();
  });
});

describe('connectTargets — per-target dispatch, summary, partial-failure semantics', () => {
  let console_: ReturnType<typeof spyConsole>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.exitCode = 0;
    console_ = spyConsole();
  });

  afterEach(() => {
    console_.restore();
    process.exitCode = 0;
  });

  async function withFreshDaemon(): Promise<void> {
    await setupHappyMocks();
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(spawnDaemon).mockResolvedValue(
      daemonState({ telemetryMode: 'claude-desktop', syncCodeMieUrl: 'https://x.example.com' }) as Awaited<ReturnType<typeof spawnDaemon>>
    );
  }

  it('all targets succeed: exit code 0, daemon kept', async () => {
    await withFreshDaemon();
    const { stopDaemon } = await import('../daemon-manager.js');
    const { writeDesktopConfig } = await import('../connectors/desktop.js');
    const { writeVsCodeLanguageModelsConfig } = await import('../connectors/vscode.js');
    vi.mocked(writeDesktopConfig).mockResolvedValue('/desktop/config.json');
    vi.mocked(writeVsCodeLanguageModelsConfig).mockResolvedValue({ configPath: '/vscode/models.json', requiresSecretConfiguration: false });
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true, vscode: true } });

    expect(process.exitCode).toBe(0);
    expect(stopDaemon).not.toHaveBeenCalled();
    // A per-target summary is printed for a multi-target run.
    expect(console_.log()).toHaveBeenCalledWith(expect.stringContaining('Targets configured'));
  });

  it('partial failure: one target fails, another succeeds → exit 1, daemon kept', async () => {
    await withFreshDaemon();
    const { stopDaemon } = await import('../daemon-manager.js');
    const { writeDesktopConfig } = await import('../connectors/desktop.js');
    const { writeVsCodeLanguageModelsConfig } = await import('../connectors/vscode.js');
    vi.mocked(writeDesktopConfig).mockRejectedValue(new Error('disk full'));
    vi.mocked(writeVsCodeLanguageModelsConfig).mockResolvedValue({ configPath: '/vscode/models.json', requiresSecretConfiguration: false });
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true, vscode: true } });

    expect(process.exitCode).toBe(1);
    expect(stopDaemon).not.toHaveBeenCalled();
    expect(writeVsCodeLanguageModelsConfig).toHaveBeenCalled();
    expect(console_.log()).toHaveBeenCalledWith(expect.stringContaining('✗ Claude Desktop'));
    expect(console_.log()).toHaveBeenCalledWith(expect.stringContaining('✓ VS Code'));
  });

  it('all targets fail and daemon was started this run → rollback (stopDaemon) and exit 1', async () => {
    await withFreshDaemon();
    const { stopDaemon } = await import('../daemon-manager.js');
    const { writeDesktopConfig } = await import('../connectors/desktop.js');
    const { writeVsCodeLanguageModelsConfig } = await import('../connectors/vscode.js');
    vi.mocked(writeDesktopConfig).mockRejectedValue(new Error('boom'));
    vi.mocked(writeVsCodeLanguageModelsConfig).mockRejectedValue(new Error('boom'));
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true, vscode: true } });

    expect(process.exitCode).toBe(1);
    expect(stopDaemon).toHaveBeenCalled();
  });

  it('all targets fail but daemon was NOT started this run → no rollback, exit 1', async () => {
    await setupHappyMocks();
    const { checkStatus, stopDaemon } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    const { writeDesktopConfig } = await import('../connectors/desktop.js');
    vi.mocked(checkStatus).mockResolvedValue({ running: true, state: matchingDesktopState() as Awaited<ReturnType<typeof checkStatus>>['state'] });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'deep', code: 'ok' });
    vi.mocked(writeDesktopConfig).mockRejectedValue(new Error('boom'));
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true } });

    expect(process.exitCode).toBe(1);
    expect(stopDaemon).not.toHaveBeenCalled();
  });

  it('standalone --vscode-claude-code writes only the extension (no desktop/vscode writers)', async () => {
    await withFreshDaemon();
    const { writeDesktopConfig } = await import('../connectors/desktop.js');
    const { writeVsCodeLanguageModelsConfig } = await import('../connectors/vscode.js');
    const { writeVsCodeClaudeCodeConfig } = await import('../connectors/vscode-claude-code.js');
    vi.mocked(writeVsCodeClaudeCodeConfig).mockResolvedValue({ written: true, path: '/vscode/settings.json' });
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { vscodeClaudeCode: true } });

    expect(writeVsCodeClaudeCodeConfig).toHaveBeenCalledWith('http://127.0.0.1:4001', 'gk', false);
    expect(writeDesktopConfig).not.toHaveBeenCalled();
    expect(writeVsCodeLanguageModelsConfig).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('single successful target still prints the per-target summary (spec §3.4)', async () => {
    await withFreshDaemon();
    const { writeVsCodeLanguageModelsConfig } = await import('../connectors/vscode.js');
    vi.mocked(writeVsCodeLanguageModelsConfig).mockResolvedValue({ configPath: '/vscode/models.json', requiresSecretConfiguration: false });
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { vscode: true } });

    expect(process.exitCode).toBe(0);
    expect(console_.log()).toHaveBeenCalledWith(expect.stringContaining('Targets configured'));
  });
});
