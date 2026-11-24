/**
 * connect-orchestrator: Bedrock settings check wiring. The orchestrator asks the Claude adapter from the
 * registry (`checkProviderSettings`); only the adapter's gate is mocked, so these cases also cover how the
 * adapter maps the connect targets onto the gate's flows and files.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../utils/config.js', () => ({
  ConfigLoader: {
    load: vi.fn(),
    listProfiles: vi.fn(),
    getActiveProfileName: vi.fn(),
    loadLocalConfigProfile: vi.fn(),
    loadGlobalConfigProfile: vi.fn(),
  },
}));
vi.mock('../../../../providers/index.js', () => ({
  ProviderRegistry: { getProvider: vi.fn() },
}));
vi.mock('../daemon-manager.js', async (importOriginal) => ({
  isDaemonAlive: (await importOriginal<typeof import('../daemon-manager.js')>()).isDaemonAlive,
  checkStatus: vi.fn(),
  readState: vi.fn(),
  spawnDaemon: vi.fn(),
  stopDaemon: vi.fn(),
  readConnectionRecord: vi.fn(),
  writeConnectionRecord: vi.fn(),
  seedConnectionRecord: vi.fn(),
  hasLegacyClientIdentity: vi.fn(() => false),
}));
vi.mock('@/utils/processes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/processes.js')>()),
  spawnDetached: vi.fn(),
  resolveRepositoryName: vi.fn(async () => 'owner/repo'),
  isOwnerAlive: vi.fn(async () => true),
}));
vi.mock('../health-check.js', () => ({
  checkProxyHealth: vi.fn(),
  fetchProxyHealth: vi.fn(async () => { throw new TypeError('fetch failed'); }),
}));
vi.mock('../connectors/desktop.js', () => ({
  writeDesktopConfig: vi.fn(),
  getDesktopBaseDir: vi.fn().mockReturnValue('/mock/desktop/base'),
  getDesktopConfigPath: vi.fn(async () => '/mock/desktop/base/configLibrary/applied.json'),
  mapCanonicalToDesktop: vi.fn().mockReturnValue([]),
  summarizeManagedOauthShapes: vi.fn().mockReturnValue({ oauthConfigured: 0, oauthFlagged: 0, noAuth: 0 }),
  describeManagedSettingsOverride: vi.fn().mockReturnValue(null),
  readDesktopGateway: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/telemetry/clients/claude-desktop/claude-desktop.paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/telemetry/clients/claude-desktop/claude-desktop.paths.js')>()),
  getClaudeDesktopManagedSettingsPath: vi.fn(() => '/mock/desktop/managed-settings.json'),
}));
vi.mock('../connectors/vscode.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/vscode.js')>()),
  writeVsCodeLanguageModelsConfig: vi.fn(),
}));
vi.mock('../connectors/omp.js', () => ({ writeOmpExtension: vi.fn() }));
vi.mock('../connectors/vscode-claude-code.js', () => ({
  writeVsCodeClaudeCodeConfig: vi.fn(),
  getVsCodeClaudeCodeSettingsPath: vi.fn((insiders?: boolean) =>
    insiders ? '/mock/vscode-insiders/User/settings.json' : '/mock/vscode/User/settings.json'
  ),
}));
vi.mock('../connectors/claude-code-otlp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/claude-code-otlp.js')>()),
  writeClaudeCodeOtlpConfig: vi.fn().mockResolvedValue({
    written: true,
    path: '/mock/claude/settings.json',
    backupPath: null,
    hookEvents: 8,
    envVars: 9,
    allowlist: ['/repo/project'],
  }),
}));
vi.mock('../connectors/claude-code-otlp-endpoint.js', () => ({
  readConfiguredOtlpPort: vi.fn().mockResolvedValue(null),
  refreshClaudeCodeOtlpEndpoint: vi.fn().mockResolvedValue(false),
}));
vi.mock('../connectors/managed-mcp-remote.js', () => ({
  fetchManagedMcpServers: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../../providers/integration/setup-ui.js', () => ({ displaySetupInstructions: vi.fn() }));
vi.mock('../../../../providers/plugins/sso/sso.auth.js', () => ({ CodeMieSSO: vi.fn() }));
vi.mock('../../../../cli/commands/skills/setup/sync.js', () => ({
  syncRegisteredSkills: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../cli/commands/skills/setup/sync-plugin.js', () => ({
  syncPluginSkills: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js')>()),
  getClaudeSettingsPath: vi.fn(),
  readAllowlistState: vi.fn().mockResolvedValue({ kind: 'absent' }),
}));
vi.mock('@/utils/project-root.js', () => ({ resolveProjectRoot: vi.fn().mockReturnValue('/mock/project') }));
vi.mock('../prompts/analytics-confirmation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../prompts/analytics-confirmation.js')>()),
  promptAnalyticsConfirmation: vi.fn().mockResolvedValue('enable'),
}));
vi.mock('@/utils/interactive.js', () => ({
  isNonInteractiveEnvironment: vi.fn().mockReturnValue(false),
  canPromptForProject: vi.fn().mockReturnValue(true),
}));
vi.mock('@/agents/plugins/claude/cloud-provider-conflict/gate.js', () => ({
  detectAndAsk: vi.fn(),
  applyConsented: vi.fn(),
}));

const INERT_TOKEN = { plan: null, deps: {} };

function emptyResult(backupDir: string | null = null): { backupDir: string | null; files: never[]; changed: string[] } {
  return { backupDir, files: [], changed: [] };
}

async function setupHappyMocks(provider = 'ai-run-sso'): Promise<void> {
  const { ConfigLoader } = await import('../../../../utils/config.js');
  const { ProviderRegistry } = await import('../../../../providers/index.js');
  const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
  const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
  const { detectAndAsk, applyConsented } = await import('@/agents/plugins/claude/cloud-provider-conflict/gate.js');
  vi.mocked(ConfigLoader.load).mockResolvedValue({
    name: 'p',
    provider,
    baseUrl: 'https://x.example.com/api',
    codeMieUrl: 'https://x.example.com',
    codeMieProject: 'proj',
  } as Awaited<ReturnType<typeof ConfigLoader.load>>);
  vi.mocked(ProviderRegistry.getProvider).mockReturnValue({
    name: 'ai-run-sso',
    authType: 'sso',
  } as ReturnType<typeof ProviderRegistry.getProvider>);
  vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
    return { getStoredCredentials: vi.fn().mockResolvedValue({ token: 't' }) };
  } as unknown as typeof CodeMieSSO);
  vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
  vi.mocked(spawnDaemon).mockResolvedValue({
    pid: process.pid,
    port: 4001,
    url: 'http://127.0.0.1:4001',
    profile: 'p',
    gatewayKey: 'gk',
    startedAt: new Date().toISOString(),
    telemetryMode: 'claude-desktop',
    syncCodeMieUrl: 'https://x.example.com',
  } as unknown as Awaited<ReturnType<typeof spawnDaemon>>);
  vi.mocked(detectAndAsk).mockReset().mockResolvedValue({ kind: 'proceed', token: INERT_TOKEN });
  vi.mocked(applyConsented).mockReset().mockResolvedValue(emptyResult());
  // Implementations set by one test must not leak into the next
  const { writeDesktopConfig } = await import('../connectors/desktop.js');
  const { getVsCodeClaudeCodeSettingsPath } = await import('../connectors/vscode-claude-code.js');
  const { canPromptForProject } = await import('@/utils/interactive.js');
  vi.mocked(writeDesktopConfig).mockReset().mockResolvedValue({ configPath: '/desktop/config.json', activated: false });
  vi.mocked(getVsCodeClaudeCodeSettingsPath).mockReset().mockImplementation((insiders?: boolean) =>
    insiders ? '/mock/vscode-insiders/User/settings.json' : '/mock/vscode/User/settings.json'
  );
  vi.mocked(canPromptForProject).mockReset().mockReturnValue(true);
}

function spyConsole(): { restore: () => void; err: () => string } {
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
    err: () => errSpy.mock.calls.map((c) => c.join(' ')).join('\n'),
  };
}

describe('connectTargets: Bedrock settings conflict gate', () => {
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

  it('warns only for Claude Code analytics alone: no prompt, no paths, flow connect-otlp-only', async () => {
    await setupHappyMocks();
    const { detectAndAsk } = await import('@/agents/plugins/claude/cloud-provider-conflict/gate.js');
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeCodeOtlp: true }, yes: true });

    expect(detectAndAsk).toHaveBeenCalledTimes(1);
    expect(vi.mocked(detectAndAsk).mock.calls[0][0]).toMatchObject({ flow: 'connect-otlp-only' });
    expect(vi.mocked(detectAndAsk).mock.calls[0][0].paths).toBeUndefined();
  });

  it.each([
    ['copilotChatOtlp', { copilotChatOtlp: true }],
    ['copilotCliOtlp', { copilotCliOtlp: true }],
    ['omp', { omp: true }],
    ['vscode (BYOK)', { vscode: true }],
    ['codexDesktop', { codexDesktop: true }],
  ])('leaves the non-Claude target %s alone: the gate is not consulted', async (_name, targets) => {
    await setupHappyMocks();
    const { detectAndAsk, applyConsented } = await import('@/agents/plugins/claude/cloud-provider-conflict/gate.js');
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets, yes: true });

    expect(detectAndAsk).not.toHaveBeenCalled();
    expect(applyConsented).not.toHaveBeenCalled();
  });

  it('passes canPrompt false under --yes even when the terminal could prompt', async () => {
    await setupHappyMocks();
    const { detectAndAsk } = await import('@/agents/plugins/claude/cloud-provider-conflict/gate.js');
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true }, yes: true });

    expect(vi.mocked(detectAndAsk).mock.calls[0][0]).toMatchObject({ flow: 'connect-desktop', canPrompt: false });
  });

  it('passes canPrompt from the terminal check without --yes', async () => {
    await setupHappyMocks();
    const { detectAndAsk } = await import('@/agents/plugins/claude/cloud-provider-conflict/gate.js');
    const { canPromptForProject } = await import('@/utils/interactive.js');
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true } });
    expect(vi.mocked(detectAndAsk).mock.calls[0][0]).toMatchObject({ canPrompt: true });

    vi.mocked(detectAndAsk).mockClear();
    vi.mocked(canPromptForProject).mockReturnValue(false);
    await connectTargets({ targets: { claudeDesktop: true } });
    expect(vi.mocked(detectAndAsk).mock.calls[0][0]).toMatchObject({ canPrompt: false });
  });

  it('resolves the Desktop applied and managed files and hands the profile to the gate; project layers are never supplied', async () => {
    await setupHappyMocks();
    const { detectAndAsk } = await import('@/agents/plugins/claude/cloud-provider-conflict/gate.js');
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true } });

    const input = vi.mocked(detectAndAsk).mock.calls[0][0];
    expect(input.flow).toBe('connect-desktop');
    expect(input.profile).toMatchObject({ provider: 'ai-run-sso' });
    expect(input.paths).toEqual({
      desktopApplied: '/mock/desktop/base/configLibrary/applied.json',
      desktopManaged: '/mock/desktop/managed-settings.json',
    });
    expect(input.paths).not.toHaveProperty('projectSettings');
    expect(input.paths).not.toHaveProperty('projectLocalSettings');
    expect(input.cwd).toBeUndefined();
  });

  it('checks only the stable VS Code edition it configures for the Claude Code extension', async () => {
    await setupHappyMocks();
    const { detectAndAsk } = await import('@/agents/plugins/claude/cloud-provider-conflict/gate.js');
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { vscodeClaudeCode: true } });

    const input = vi.mocked(detectAndAsk).mock.calls[0][0];
    expect(input.flow).toBe('connect-vscode');
    expect(input.paths).toEqual({ vscodeSettings: ['/mock/vscode/User/settings.json'] });
  });

  it('checks only the Insiders edition with --insiders', async () => {
    await setupHappyMocks();
    const { detectAndAsk } = await import('@/agents/plugins/claude/cloud-provider-conflict/gate.js');
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { vscodeClaudeCode: true }, insiders: true });

    expect(vi.mocked(detectAndAsk).mock.calls[0][0].paths).toEqual({
      vscodeSettings: ['/mock/vscode-insiders/User/settings.json'],
    });
  });

  it('checks no VS Code file when the configured edition has no user-data directory', async () => {
    await setupHappyMocks();
    const { ConfigurationError } = await import('../../../../utils/errors.js');
    const { getVsCodeClaudeCodeSettingsPath } = await import('../connectors/vscode-claude-code.js');
    vi.mocked(getVsCodeClaudeCodeSettingsPath).mockImplementation((insiders?: boolean) => {
      if (insiders) throw new ConfigurationError('VS Code Insiders user data directory was not found');
      return '/mock/vscode/User/settings.json';
    });
    const { detectAndAsk } = await import('@/agents/plugins/claude/cloud-provider-conflict/gate.js');
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { vscodeClaudeCode: true }, insiders: true });

    expect(vi.mocked(detectAndAsk).mock.calls[0][0].paths).toEqual({ vscodeSettings: [] });
    expect(console_.err()).not.toContain('user data directory');
  });

  it('runs one gate check covering Desktop and the VS Code extension when both are selected, so the user is asked once', async () => {
    await setupHappyMocks();
    const { detectAndAsk, applyConsented } = await import('@/agents/plugins/claude/cloud-provider-conflict/gate.js');
    const token = { plan: null, deps: { tag: 'both' } };
    vi.mocked(detectAndAsk).mockResolvedValueOnce({ kind: 'proceed', token });
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true, vscodeClaudeCode: true } });

    expect(detectAndAsk).toHaveBeenCalledTimes(1);
    const input = vi.mocked(detectAndAsk).mock.calls[0][0];
    expect(input.flow).toBe('connect-desktop');
    expect(input.paths).toMatchObject({
      desktopApplied: expect.any(String),
      vscodeSettings: expect.arrayContaining([expect.any(String)]),
    });
    expect(input.paths).toHaveProperty('desktopManaged');
    expect(vi.mocked(applyConsented).mock.calls.map((c) => c[0])).toEqual([token]);
  });

  it('does not treat Claude Code analytics as alone when a Desktop target is selected', async () => {
    await setupHappyMocks();
    const { detectAndAsk } = await import('@/agents/plugins/claude/cloud-provider-conflict/gate.js');
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true, claudeCodeOtlp: true }, yes: true });

    expect(vi.mocked(detectAndAsk).mock.calls.map((c) => c[0].flow)).toEqual(['connect-desktop']);
  });

  it.each(['cancel', 'managed', 'unknown', 'non-interactive'] as const)(
    'a %s stop aborts the command with the guidance before the daemon starts',
    async (reason) => {
      await setupHappyMocks();
      const { detectAndAsk, applyConsented } = await import('@/agents/plugins/claude/cloud-provider-conflict/gate.js');
      vi.mocked(detectAndAsk).mockResolvedValue({ kind: 'stop', reason, guidance: `GUIDANCE for ${reason}` });
      const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
      const { writeDesktopConfig } = await import('../connectors/desktop.js');
      const { syncRegisteredSkills } = await import('../../../../cli/commands/skills/setup/sync.js');
      const { connectTargets } = await import('../connect-orchestrator.js');

      await expect(connectTargets({ targets: { claudeDesktop: true } })).rejects.toThrow('process.exit:1');

      expect(console_.err()).toContain(`GUIDANCE for ${reason}`);
      expect(checkStatus).not.toHaveBeenCalled();
      expect(spawnDaemon).not.toHaveBeenCalled();
      expect(writeDesktopConfig).not.toHaveBeenCalled();
      expect(syncRegisteredSkills).not.toHaveBeenCalled();
      expect(applyConsented).not.toHaveBeenCalled();
    }
  );

  it('throws a ConfigurationError carrying the guidance (the existing error path prints it)', async () => {
    await setupHappyMocks();
    const { detectAndAsk } = await import('@/agents/plugins/claude/cloud-provider-conflict/gate.js');
    vi.mocked(detectAndAsk).mockResolvedValue({ kind: 'stop', reason: 'managed', guidance: 'MANAGED GUIDANCE' });
    const { ConfigurationError } = await import('../../../../utils/errors.js');
    const { logger } = await import('../../../../utils/logger.js');
    const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const { connectTargets } = await import('../connect-orchestrator.js');

    await expect(connectTargets({ targets: { vscodeClaudeCode: true } })).rejects.toThrow('process.exit:1');

    const thrown = loggerError.mock.calls.map((c) => c[1]).find((e) => e instanceof ConfigurationError);
    expect((thrown as Error).message).toBe('MANAGED GUIDANCE');
    loggerError.mockRestore();
  });

  it('a stop from the combined Desktop and VS Code check aborts before anything starts', async () => {
    await setupHappyMocks();
    const { detectAndAsk, applyConsented } = await import('@/agents/plugins/claude/cloud-provider-conflict/gate.js');
    vi.mocked(detectAndAsk).mockResolvedValueOnce({ kind: 'stop', reason: 'cancel', guidance: 'BOTH CANCELLED' });
    const { spawnDaemon } = await import('../daemon-manager.js');
    const { connectTargets } = await import('../connect-orchestrator.js');

    await expect(
      connectTargets({ targets: { claudeDesktop: true, vscodeClaudeCode: true } })
    ).rejects.toThrow('process.exit:1');

    expect(detectAndAsk).toHaveBeenCalledTimes(1);
    expect(console_.err()).toContain('BOTH CANCELLED');
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(applyConsented).not.toHaveBeenCalled();
  });

  it('applies every consent before the skills sync and the daemon start', async () => {
    await setupHappyMocks();
    const { applyConsented } = await import('@/agents/plugins/claude/cloud-provider-conflict/gate.js');
    const { syncRegisteredSkills } = await import('../../../../cli/commands/skills/setup/sync.js');
    const { syncPluginSkills } = await import('../../../../cli/commands/skills/setup/sync-plugin.js');
    const { spawnDaemon } = await import('../daemon-manager.js');
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true } });

    const applied = vi.mocked(applyConsented).mock.invocationCallOrder[0];
    expect(applied).toBeLessThan(vi.mocked(syncRegisteredSkills).mock.invocationCallOrder[0]);
    expect(applied).toBeLessThan(vi.mocked(syncPluginSkills).mock.invocationCallOrder[0]);
    expect(applied).toBeLessThan(vi.mocked(spawnDaemon).mock.invocationCallOrder[0]);
  });

  it('does not change a no-conflict connect: inert apply, targets written, exit code 0', async () => {
    await setupHappyMocks();
    const { writeDesktopConfig } = await import('../connectors/desktop.js');
    vi.mocked(writeDesktopConfig).mockResolvedValue({ configPath: '/desktop/config.json', activated: false });
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true } });

    expect(writeDesktopConfig).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
    expect(console_.err()).not.toContain('Backup of your Claude Code settings');
  });

  it('prints the backup folder when a failure follows the apply (daemon start)', async () => {
    await setupHappyMocks();
    const { applyConsented } = await import('@/agents/plugins/claude/cloud-provider-conflict/gate.js');
    vi.mocked(applyConsented).mockResolvedValue(emptyResult('/backups/claude-1'));
    const { spawnDaemon } = await import('../daemon-manager.js');
    vi.mocked(spawnDaemon).mockRejectedValue(new Error('daemon did not start'));
    const { connectTargets } = await import('../connect-orchestrator.js');

    await expect(connectTargets({ targets: { claudeDesktop: true } })).rejects.toThrow('process.exit:1');

    expect(console_.err()).toContain('Backup of your Claude Code settings: /backups/claude-1');
  });

  it('prints the backup folder when a target fails after the apply', async () => {
    await setupHappyMocks();
    const { applyConsented } = await import('@/agents/plugins/claude/cloud-provider-conflict/gate.js');
    vi.mocked(applyConsented).mockResolvedValue(emptyResult('/backups/claude-2'));
    const { writeDesktopConfig } = await import('../connectors/desktop.js');
    vi.mocked(writeDesktopConfig).mockRejectedValue(new Error('disk full'));
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true } });

    expect(process.exitCode).toBe(1);
    expect(console_.err()).toContain('Backup of your Claude Code settings: /backups/claude-2');
  });

  it('skips the gate result entirely for a Bedrock profile (the gate decides; profile is passed through)', async () => {
    await setupHappyMocks('bedrock');
    const { detectAndAsk } = await import('@/agents/plugins/claude/cloud-provider-conflict/gate.js');
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true } });

    expect(vi.mocked(detectAndAsk).mock.calls[0][0].profile).toMatchObject({ provider: 'bedrock' });
  });
});
