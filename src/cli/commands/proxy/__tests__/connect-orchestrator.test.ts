/**
 * connect-orchestrator unit tests
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import stripAnsi from 'strip-ansi';
import { mkdtemp, mkdir, readFile, unlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  daemonMatchesRequest,
  deriveDaemonIdentity,
  type ConnectOptions,
  type ConnectTargets,
  type RequestedDaemonConfig,
} from '../connect-orchestrator.js';

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
}));
vi.mock('@/utils/processes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/processes.js')>()),
  spawnDetached: vi.fn(),
  // The start comparison runs `ps`; the test that exercises it switches this to the real one with `ps` mocked
  isOwnerAlive: vi.fn(async () => true),
}));
vi.mock('../health-check.js', () => ({
  checkProxyHealth: vi.fn(),
  // No proxy answers: a daemon that fails its start check reads gone
  fetchProxyHealth: vi.fn(async () => { throw new TypeError('fetch failed'); }),
}));
vi.mock('../connectors/desktop.js', () => ({
  writeDesktopConfig: vi.fn(),
  getDesktopBaseDir: vi.fn().mockReturnValue('/mock/desktop/base'),
  mapCanonicalToDesktop: vi.fn().mockReturnValue([]),
  summarizeManagedOauthShapes: vi.fn().mockReturnValue({ oauthConfigured: 0, oauthFlagged: 0, noAuth: 0 }),
  describeManagedSettingsOverride: vi.fn().mockReturnValue(null),
}));
vi.mock('../connectors/vscode.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/vscode.js')>()),
  writeVsCodeLanguageModelsConfig: vi.fn(),
}));
vi.mock('../connectors/vscode-claude-code.js', () => ({
  writeVsCodeClaudeCodeConfig: vi.fn(),
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
vi.mock('@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js')>()),
  getClaudeSettingsPath: vi.fn(),
  canonicalizePath: vi.fn(async (path: string) => path),
  readAllowlistState: vi.fn().mockResolvedValue({ kind: 'absent' }),
}));
vi.mock('@/utils/project-root.js', () => ({
  resolveProjectRoot: vi.fn().mockReturnValue('/mock/project'),
}));
vi.mock('../prompts/analytics-confirmation.js', () => ({
  promptAnalyticsConfirmation: vi.fn().mockResolvedValue('enable'),
}));
vi.mock('@/utils/interactive.js', () => ({
  isNonInteractiveEnvironment: vi.fn().mockReturnValue(false),
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
function matchingDesktopState(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return daemonState({
    provider: 'ai-run-sso',
    targetUrl: 'https://x.example.com/api',
    project: 'proj',
    telemetryMode: 'claude-desktop',
    syncCodeMieUrl: 'https://x.example.com',
    ...extra,
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

describe('daemonMatchesRequest — model comparison', () => {
  function baseRequest(extra: Partial<RequestedDaemonConfig> = {}): RequestedDaemonConfig {
    return {
      profile: 'p',
      port: 4001,
      project: 'proj',
      clientType: 'codex-desktop',
      provider: 'ai-run-sso',
      targetUrl: 'https://x.example.com/api',
      ...extra,
    };
  }

  function codexState(extra: Record<string, unknown> = {}): Parameters<typeof daemonMatchesRequest>[0] {
    return daemonState({
      provider: 'ai-run-sso',
      targetUrl: 'https://x.example.com/api',
      project: 'proj',
      clientType: 'codex-desktop',
      ...extra,
    }) as Parameters<typeof daemonMatchesRequest>[0];
  }

  it('matches when the requested model equals the recorded model', () => {
    expect(
      daemonMatchesRequest(codexState({ model: 'gpt-5-codex' }), baseRequest({ model: 'gpt-5-codex' }))
    ).toBe(true);
  });

  it('fails to match when the profile model changed against the running daemon', () => {
    expect(
      daemonMatchesRequest(codexState({ model: 'gpt-5-codex' }), baseRequest({ model: 'gpt-5' }))
    ).toBe(false);
  });

  it('compares the trimmed form on both sides', () => {
    expect(
      daemonMatchesRequest(codexState({ model: 'gpt-5-codex' }), baseRequest({ model: '  gpt-5-codex  ' }))
    ).toBe(true);
  });

  it('reuses the daemon when no model is requested (backward compatible)', () => {
    expect(
      daemonMatchesRequest(codexState({ model: 'gpt-5-codex' }), baseRequest({ model: undefined }))
    ).toBe(true);
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

  it('does not start the proxy when Claude Code analytics confirmation is declined', async () => {
    await setupHappyMocks();
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { promptAnalyticsConfirmation } = await import('../prompts/analytics-confirmation.js');
    vi.mocked(promptAnalyticsConfirmation).mockResolvedValueOnce('cancel');
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeCodeOtlp: true }, scope: 'project' });

    expect(promptAnalyticsConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'project',
        currentProjectPath: '/mock/project',
      })
    );
    const promptArgs = vi.mocked(promptAnalyticsConfirmation).mock.calls[0][0];
    expect(promptArgs).not.toHaveProperty('name');
    expect(promptArgs).not.toHaveProperty('url');
    expect(checkStatus).not.toHaveBeenCalled();
    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  it('shows the Global prompt when scope is omitted and a declined default writes nothing', async () => {
    await setupHappyMocks();
    const { checkStatus, spawnDaemon, stopDaemon } = await import('../daemon-manager.js');
    const { writeClaudeCodeOtlpConfig } = await import('../connectors/claude-code-otlp.js');
    const { promptAnalyticsConfirmation } = await import('../prompts/analytics-confirmation.js');
    vi.mocked(promptAnalyticsConfirmation).mockResolvedValueOnce('cancel');
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeCodeOtlp: true } });

    expect(promptAnalyticsConfirmation).toHaveBeenCalledTimes(1);
    expect(promptAnalyticsConfirmation).toHaveBeenCalledWith(expect.objectContaining({ scope: 'user' }));
    expect(checkStatus).not.toHaveBeenCalled();
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(stopDaemon).not.toHaveBeenCalled();
    expect(writeClaudeCodeOtlpConfig).not.toHaveBeenCalled();
    expect(console_.log()).toHaveBeenCalledWith(expect.stringContaining('Claude Code analytics was not enabled.'));
  });

  it('leaves an already running daemon running when the confirmation is declined', async () => {
    await setupHappyMocks();
    const { checkStatus, spawnDaemon, stopDaemon } = await import('../daemon-manager.js');
    const { writeClaudeCodeOtlpConfig } = await import('../connectors/claude-code-otlp.js');
    const { promptAnalyticsConfirmation } = await import('../prompts/analytics-confirmation.js');
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: daemonState({ clientType: 'claude-code-otlp' }) as Awaited<ReturnType<typeof checkStatus>>['state'],
    });
    vi.mocked(promptAnalyticsConfirmation).mockResolvedValueOnce('cancel');
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeCodeOtlp: true }, scope: 'user' });

    expect(stopDaemon).not.toHaveBeenCalled();
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(writeClaudeCodeOtlpConfig).not.toHaveBeenCalled();
  });

  it('--silent without a scope skips the prompt and writes the Global scope', async () => {
    await setupHappyMocks();
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { writeClaudeCodeOtlpConfig } = await import('../connectors/claude-code-otlp.js');
    const { promptAnalyticsConfirmation } = await import('../prompts/analytics-confirmation.js');
    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(spawnDaemon).mockResolvedValue(
      daemonState({ clientType: 'claude-code-otlp' }) as Awaited<ReturnType<typeof spawnDaemon>>
    );
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeCodeOtlp: true }, silent: true });

    expect(promptAnalyticsConfirmation).not.toHaveBeenCalled();
    expect(spawnDaemon).toHaveBeenCalled();
    expect(writeClaudeCodeOtlpConfig).toHaveBeenCalledWith(expect.objectContaining({ scope: 'user' }));
  });

  it('--scope project --silent skips the prompt and writes the Project scope', async () => {
    await setupHappyMocks();
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { writeClaudeCodeOtlpConfig } = await import('../connectors/claude-code-otlp.js');
    const { promptAnalyticsConfirmation } = await import('../prompts/analytics-confirmation.js');
    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(spawnDaemon).mockResolvedValue(
      daemonState({ clientType: 'claude-code-otlp' }) as Awaited<ReturnType<typeof spawnDaemon>>
    );
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeCodeOtlp: true }, scope: 'project', silent: true });

    expect(promptAnalyticsConfirmation).not.toHaveBeenCalled();
    expect(writeClaudeCodeOtlpConfig).toHaveBeenCalledWith(expect.objectContaining({ scope: 'project' }));
  });

  for (const scope of [undefined, 'project'] as const) {
    it(`errors before anything starts or is written when non-interactive without --silent (scope: ${scope ?? 'omitted'})`, async () => {
      await setupHappyMocks();
      const { ConfigLoader } = await import('../../../../utils/config.js');
      const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
      const { writeClaudeCodeOtlpConfig } = await import('../connectors/claude-code-otlp.js');
      const { promptAnalyticsConfirmation } = await import('../prompts/analytics-confirmation.js');
      const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
      const { isNonInteractiveEnvironment } = await import('@/utils/interactive.js');
      vi.mocked(isNonInteractiveEnvironment).mockReturnValueOnce(true);
      const { connectTargets } = await import('../connect-orchestrator.js');

      await expect(
        connectTargets({ targets: { claudeCodeOtlp: true }, scope })
      ).rejects.toThrow('process.exit:1');

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--silent'));
      expect(ConfigLoader.load).not.toHaveBeenCalled();
      expect(CodeMieSSO).not.toHaveBeenCalled();
      expect(promptAnalyticsConfirmation).not.toHaveBeenCalled();
      expect(checkStatus).not.toHaveBeenCalled();
      expect(spawnDaemon).not.toHaveBeenCalled();
      expect(writeClaudeCodeOtlpConfig).not.toHaveBeenCalled();
    });
  }

  it('--silent still stops on an invalid allowlist unless --force is passed', async () => {
    await setupHappyMocks();
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { writeClaudeCodeOtlpConfig } = await import('../connectors/claude-code-otlp.js');
    const { readAllowlistState } = await import('@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js');
    // Two calls (one per connect attempt); Once-values never leak into later tests.
    vi.mocked(readAllowlistState)
      .mockResolvedValueOnce({ kind: 'invalid' })
      .mockResolvedValueOnce({ kind: 'invalid' });
    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(spawnDaemon).mockResolvedValue(
      daemonState({ clientType: 'claude-code-otlp' }) as Awaited<ReturnType<typeof spawnDaemon>>
    );
    const { connectTargets } = await import('../connect-orchestrator.js');

    await expect(
      connectTargets({ targets: { claudeCodeOtlp: true }, silent: true })
    ).rejects.toThrow('process.exit:1');
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(writeClaudeCodeOtlpConfig).not.toHaveBeenCalled();

    await connectTargets({ targets: { claudeCodeOtlp: true }, silent: true, force: true });
    expect(writeClaudeCodeOtlpConfig).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
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

  it.each([4001, 62380])('reuses a healthy matching daemon on port %i (no stop, no spawn)', async (port) => {
    await setupHappyMocks();
    const { checkStatus, spawnDaemon, stopDaemon } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    vi.mocked(checkStatus).mockResolvedValue({ running: true, state: matchingDesktopState({ port, url: `http://127.0.0.1:${port}` }) as Awaited<ReturnType<typeof checkStatus>>['state'] });
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
    const { logger } = await import('../../../../utils/logger.js');
    const status = vi.spyOn(logger, 'status').mockImplementation(() => {});
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true } });

    expect(stopDaemon).toHaveBeenCalled();
    expect(spawnDaemon).toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith('Restarting proxy to match the requested client...');
    expect(status).toHaveBeenCalledWith('Starting proxy (profile: p)...');
    expect(console_.log()).not.toHaveBeenCalledWith(expect.stringContaining('proxy'));
    status.mockRestore();
  });

  it('keeps the fallback port when connecting to a hook-respawned OTLP daemon', async () => {
    await setupHappyMocks();
    const { checkStatus, spawnDaemon, stopDaemon } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    vi.mocked(checkStatus).mockResolvedValue({ running: true, state: daemonState({
      port: 62380,
      url: 'http://127.0.0.1:62380',
      clientType: 'claude-code-otlp',
      provider: 'ai-run-sso',
      targetUrl: 'https://x.example.com/api',
      project: 'proj',
      syncCodeMieUrl: 'https://x.example.com',
    }) as Awaited<ReturnType<typeof checkStatus>>['state'] });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'deep', code: 'ok' });
    const { connectTargets } = await import('../connect-orchestrator.js');
    await connectTargets({ targets: { claudeCodeOtlp: true }, silent: true });
    expect(stopDaemon).not.toHaveBeenCalled();
    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  it('restarts when the profile model changed against an otherwise-matching daemon', async () => {
    await setupHappyMocks({ model: 'gpt-5' });
    const { checkStatus, spawnDaemon, stopDaemon } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    // A healthy daemon that matches on every field EXCEPT the (now-changed) model.
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: matchingDesktopState({ model: 'gpt-4' }) as Awaited<ReturnType<typeof checkStatus>>['state'],
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'deep', code: 'ok' });
    vi.mocked(spawnDaemon).mockResolvedValue(
      daemonState({ telemetryMode: 'claude-desktop', syncCodeMieUrl: 'https://x.example.com', model: 'gpt-5' }) as Awaited<ReturnType<typeof spawnDaemon>>
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
    const { logger } = await import('../../../../utils/logger.js');
    const status = vi.spyOn(logger, 'status').mockImplementation(() => {});
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true }, force: true });

    expect(stopDaemon).toHaveBeenCalled();
    expect(spawnDaemon).toHaveBeenCalled();
    expect(checkProxyHealth).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith('Forcing a fresh proxy restart...');
    expect(console_.log()).not.toHaveBeenCalledWith(expect.stringContaining('proxy'));
    status.mockRestore();
  });

  it('verbose cold start reports the spawned proxy url through the logger', async () => {
    await setupHappyMocks();
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(spawnDaemon).mockResolvedValue(
      daemonState({ url: 'http://127.0.0.1:4777', telemetryMode: 'claude-desktop', syncCodeMieUrl: 'https://x.example.com' }) as Awaited<ReturnType<typeof spawnDaemon>>
    );
    const { logger } = await import('../../../../utils/logger.js');
    const success = vi.spyOn(logger, 'success').mockImplementation(() => {});
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true }, verbose: true });

    expect(success).toHaveBeenCalledWith('Proxy started at http://127.0.0.1:4777');
    expect(console_.log()).not.toHaveBeenCalledWith(expect.stringContaining('Proxy started'));
    success.mockRestore();
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
    const { logger } = await import('../../../../utils/logger.js');
    const status = vi.spyOn(logger, 'status').mockImplementation(() => {});
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true } });

    expect(stopDaemon).toHaveBeenCalled();
    expect(spawnDaemon).toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(
      expect.stringContaining('Existing proxy is unhealthy (expired). Restarting...')
    );
    expect(status).toHaveBeenCalledWith('Starting proxy (profile: p)...');
    expect(console_.log()).not.toHaveBeenCalledWith(expect.stringContaining('proxy'));
    status.mockRestore();
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

  it('declined Claude Code analytics alongside another target: skips only that target and drops it from the daemon identity', async () => {
    await withFreshDaemon();
    const { spawnDaemon } = await import('../daemon-manager.js');
    const { writeClaudeCodeOtlpConfig } = await import('../connectors/claude-code-otlp.js');
    const { writeVsCodeLanguageModelsConfig } = await import('../connectors/vscode.js');
    const { promptAnalyticsConfirmation } = await import('../prompts/analytics-confirmation.js');
    vi.mocked(promptAnalyticsConfirmation).mockResolvedValueOnce('cancel');
    vi.mocked(writeVsCodeLanguageModelsConfig).mockResolvedValue({ configPath: '/vscode/models.json', requiresSecretConfiguration: false, modelCount: 5 });
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeCodeOtlp: true, vscode: true } });

    expect(promptAnalyticsConfirmation).toHaveBeenCalledTimes(1);
    expect(writeClaudeCodeOtlpConfig).not.toHaveBeenCalled();
    expect(writeVsCodeLanguageModelsConfig).toHaveBeenCalledTimes(1);
    // Declined target must not own the shared daemon: identity falls back to the remaining target.
    expect(spawnDaemon).toHaveBeenCalledTimes(1);
    expect(spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({ clientType: 'vscode-byok' }));
    expect(spawnDaemon).not.toHaveBeenCalledWith(expect.objectContaining({ clientType: 'claude-code-otlp' }));
    expect(console_.log()).toHaveBeenCalledWith(expect.stringContaining('Claude Code analytics was not enabled.'));
    expect(process.exitCode).toBe(0);
  });

  it('all targets succeed: exit code 0, daemon kept', async () => {
    await withFreshDaemon();
    const { stopDaemon } = await import('../daemon-manager.js');
    const { writeDesktopConfig } = await import('../connectors/desktop.js');
    const { writeVsCodeLanguageModelsConfig } = await import('../connectors/vscode.js');
    vi.mocked(writeDesktopConfig).mockResolvedValue('/desktop/config.json');
    vi.mocked(writeVsCodeLanguageModelsConfig).mockResolvedValue({ configPath: '/vscode/models.json', requiresSecretConfiguration: false, modelCount: 5 });
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
    vi.mocked(writeVsCodeLanguageModelsConfig).mockResolvedValue({ configPath: '/vscode/models.json', requiresSecretConfiguration: false, modelCount: 5 });
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

  describe('proxy-connection record', () => {
    it('connect against a running matching daemon records the connection (profile + client type)', async () => {
      await setupHappyMocks();
      const { checkStatus, spawnDaemon, writeConnectionRecord } = await import('../daemon-manager.js');
      const { checkProxyHealth } = await import('../health-check.js');
      const { writeDesktopConfig } = await import('../connectors/desktop.js');
      const matching = matchingDesktopState();
      vi.mocked(checkStatus).mockResolvedValue({ running: true, state: matching as Awaited<ReturnType<typeof checkStatus>>['state'] });
      vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'deep', code: 'ok' });
      vi.mocked(writeDesktopConfig).mockResolvedValue('/desktop/config.json');
      const { connectTargets } = await import('../connect-orchestrator.js');

      await connectTargets({ targets: { claudeDesktop: true } });

      expect(spawnDaemon).not.toHaveBeenCalled();
      expect(writeConnectionRecord).toHaveBeenCalledTimes(1);
      expect(writeConnectionRecord).toHaveBeenCalledWith(matching, 'p', 'claude-desktop');
    });

    it('a fresh spawn defers the write to after wiring (spawnDaemon told not to write)', async () => {
      await withFreshDaemon();
      const { spawnDaemon, writeConnectionRecord } = await import('../daemon-manager.js');
      const { writeDesktopConfig } = await import('../connectors/desktop.js');
      vi.mocked(writeDesktopConfig).mockResolvedValue('/desktop/config.json');
      const { connectTargets } = await import('../connect-orchestrator.js');

      await connectTargets({ targets: { claudeDesktop: true } });

      expect(spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({ writeRecord: false }));
      expect(writeConnectionRecord).toHaveBeenCalledTimes(1);
      expect(writeConnectionRecord).toHaveBeenCalledWith(
        expect.objectContaining({ gatewayKey: 'gk' }),
        'p',
        'claude-desktop'
      );
    });

    it('partial failure (one target fails, one succeeds) still records the connection', async () => {
      await withFreshDaemon();
      const { writeConnectionRecord } = await import('../daemon-manager.js');
      const { writeDesktopConfig } = await import('../connectors/desktop.js');
      const { writeVsCodeLanguageModelsConfig } = await import('../connectors/vscode.js');
      vi.mocked(writeDesktopConfig).mockRejectedValue(new Error('disk full'));
      vi.mocked(writeVsCodeLanguageModelsConfig).mockResolvedValue({ configPath: '/vscode/models.json', requiresSecretConfiguration: false, modelCount: 5 });
      const { connectTargets } = await import('../connect-orchestrator.js');

      await connectTargets({ targets: { claudeDesktop: true, vscode: true } });

      expect(process.exitCode).toBe(1);
      expect(writeConnectionRecord).toHaveBeenCalledTimes(1);
      expect(writeConnectionRecord).toHaveBeenCalledWith(expect.anything(), 'p', 'claude-desktop');
    });

    it('all targets fail (daemon started this run, rolled back) writes no record', async () => {
      await withFreshDaemon();
      const { stopDaemon, writeConnectionRecord } = await import('../daemon-manager.js');
      const { writeDesktopConfig } = await import('../connectors/desktop.js');
      const { writeVsCodeLanguageModelsConfig } = await import('../connectors/vscode.js');
      vi.mocked(writeDesktopConfig).mockRejectedValue(new Error('boom'));
      vi.mocked(writeVsCodeLanguageModelsConfig).mockRejectedValue(new Error('boom'));
      const { connectTargets } = await import('../connect-orchestrator.js');

      await connectTargets({ targets: { claudeDesktop: true, vscode: true } });

      expect(stopDaemon).toHaveBeenCalled();
      expect(writeConnectionRecord).not.toHaveBeenCalled();
    });

    it('all targets fail against a reused daemon leaves an existing record untouched', async () => {
      await setupHappyMocks();
      const { checkStatus, writeConnectionRecord } = await import('../daemon-manager.js');
      const { checkProxyHealth } = await import('../health-check.js');
      const { writeDesktopConfig } = await import('../connectors/desktop.js');
      vi.mocked(checkStatus).mockResolvedValue({ running: true, state: matchingDesktopState() as Awaited<ReturnType<typeof checkStatus>>['state'] });
      vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'deep', code: 'ok' });
      vi.mocked(writeDesktopConfig).mockRejectedValue(new Error('boom'));
      const { connectTargets } = await import('../connect-orchestrator.js');

      await connectTargets({ targets: { claudeDesktop: true } });

      expect(process.exitCode).toBe(1);
      expect(writeConnectionRecord).not.toHaveBeenCalled();
    });

    it('a state the writer refuses (returns false) does not fail the connect', async () => {
      await withFreshDaemon();
      const { stopDaemon, writeConnectionRecord } = await import('../daemon-manager.js');
      const { writeDesktopConfig } = await import('../connectors/desktop.js');
      vi.mocked(writeDesktopConfig).mockResolvedValue('/desktop/config.json');
      vi.mocked(writeConnectionRecord).mockResolvedValue(false);
      const { connectTargets } = await import('../connect-orchestrator.js');

      await connectTargets({ targets: { claudeDesktop: true } });

      expect(writeConnectionRecord).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(0);
      expect(stopDaemon).not.toHaveBeenCalled();
    });
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
    vi.mocked(writeVsCodeLanguageModelsConfig).mockResolvedValue({ configPath: '/vscode/models.json', requiresSecretConfiguration: false, modelCount: 5 });
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { vscode: true } });

    expect(process.exitCode).toBe(0);
    expect(console_.log()).toHaveBeenCalledWith(expect.stringContaining('Targets configured'));
    expect(writeVsCodeLanguageModelsConfig).toHaveBeenCalledWith('http://127.0.0.1:4001', 'gk', false);
  });

  it('prints the resolved Claude Code analytics configuration', async () => {
    await setupHappyMocks({
      name: 'preview',
      baseUrl: 'https://codemie-preview.lab.epam.com/code-assistant-api',
      codeMieUrl: 'https://codemie.lab.epam.com',
      ssoConfig: { apiUrl: 'https://codemie-preview.lab.epam.com/code-assistant-api' },
    });
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(spawnDaemon).mockResolvedValue(
      daemonState({
        clientType: 'claude-code-otlp',
        syncApiUrl: 'https://codemie-preview.lab.epam.com/code-assistant-api',
      }) as Awaited<ReturnType<typeof spawnDaemon>>
    );
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeCodeOtlp: true }, scope: 'project' });

    const output = console_.log().mock.calls
      .map(([message]) => stripAnsi(String(message)))
      .join('\n');
    expect(output).toMatch(/Using profile\s+│\s+preview/);
    expect(output).not.toMatch(/^Profile\s+│/m);
    expect(output).toMatch(/CodeMie URL\s+│\s+https:\/\/codemie-preview\.lab\.epam\.com/);
    expect(output).not.toContain('Analytics destination:');
    expect(output).toMatch(/Scope\s+│\s+project/);
    expect(output).not.toContain('Tracked projects');
    expect(output).not.toContain('/repo/project');
    expect(output).toContain('First-time setup needs a Claude Code restart');
    expect(console_.log()).toHaveBeenCalledWith(
      expect.stringContaining('Claude Code Analytics configured successfully')
    );
  });

  it('prints default scope and all projects without a CodeMie URL when allowlist is empty', async () => {
    await setupHappyMocks({
      name: 'preview',
      codeMieUrl: undefined,
    });
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { writeClaudeCodeOtlpConfig } = await import('../connectors/claude-code-otlp.js');
    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(spawnDaemon).mockResolvedValue(
      daemonState({ clientType: 'claude-code-otlp' }) as Awaited<ReturnType<typeof spawnDaemon>>
    );
    vi.mocked(writeClaudeCodeOtlpConfig).mockResolvedValue({
      written: true,
      path: '/mock/claude/settings.json',
      backupPath: null,
      hookEvents: 8,
      envVars: 9,
      allowlist: [],
    });
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeCodeOtlp: true } });

    const output = console_.log().mock.calls
      .map(([message]) => stripAnsi(String(message)))
      .join('\n');
    expect(output).toMatch(/Using profile\s+│\s+preview/);
    expect(output).not.toMatch(/^Profile\s+│/m);
    expect(output).not.toContain('CodeMie URL');
    expect(output).toMatch(/Scope\s+│\s+user/);
    expect(output).not.toContain('Tracked projects');
    expect(output).not.toContain('all projects');
  });

  it('omits tracked projects and wiring details after the proxy starts', async () => {
    await setupHappyMocks({ name: 'preview' });
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { writeClaudeCodeOtlpConfig } = await import('../connectors/claude-code-otlp.js');
    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(spawnDaemon).mockResolvedValue(
      daemonState({ clientType: 'claude-code-otlp' }) as Awaited<ReturnType<typeof spawnDaemon>>
    );
    vi.mocked(writeClaudeCodeOtlpConfig).mockResolvedValue({
      written: true,
      path: '/mock/claude/settings.json',
      backupPath: '/mock/claude/settings.json.bak',
      hookEvents: 8,
      envVars: 9,
      allowlist: ['/repo/project-a', '/repo/project-b', '/repo/project-c'],
    });
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeCodeOtlp: true }, scope: 'project' });

    const lines = console_.log().mock.calls
      .flatMap(([message]) => stripAnsi(String(message)).split('\n'));
    const output = lines.join('\n');
    for (const hidden of [
      'Tracked projects',
      '/repo/project-',
      'wired to codemie hook',
      'OTel env var',
      'Backup written',
      'OTel env is user-level',
      'OTel-only sessions',
      'OTel records may be sent',
    ]) {
      expect(output).not.toContain(hidden);
    }
    // The table keeps its rows, all sharing one bar column.
    const tableRows = lines.filter((line) => line.includes('│'));
    expect(tableRows.length).toBeGreaterThanOrEqual(2);
    const barColumn = tableRows[0].indexOf('│');
    for (const row of tableRows) {
      expect(row.indexOf('│')).toBe(barColumn);
    }
    expect(output).toMatch(/Using profile\s+│\s+preview/);
    expect(output).toMatch(/Scope\s+│\s+project/);
  });

  describe('Claude Code analytics display wiring', () => {
    async function connectAndCapture(configOverrides: Record<string, unknown>): Promise<{
      promptArgs: Record<string, unknown>;
      confirmedUrl: string | undefined;
      output: string;
    }> {
      await setupHappyMocks(configOverrides);
      const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
      const { promptAnalyticsConfirmation } = await import('../prompts/analytics-confirmation.js');
      vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
      vi.mocked(spawnDaemon).mockResolvedValue(
        daemonState({ clientType: 'claude-code-otlp' }) as Awaited<ReturnType<typeof spawnDaemon>>
      );
      const { connectTargets } = await import('../connect-orchestrator.js');

      await connectTargets({ targets: { claudeCodeOtlp: true } });

      const promptArgs = vi.mocked(promptAnalyticsConfirmation).mock.calls[0][0] as unknown as Record<string, unknown>;
      const output = console_.log().mock.calls
        .map(([message]) => stripAnsi(String(message)))
        .join('\n');
      const tableUrl = output.match(/CodeMie URL\s+│\s+(\S+)/)?.[1];
      return { promptArgs, confirmedUrl: tableUrl, output };
    }

    it('passes the profile name and the matching-origin CodeMie URL to the prompt and the table', async () => {
      const { promptArgs, confirmedUrl } = await connectAndCapture({
        name: 'work',
        baseUrl: 'https://x.example.com/api',
        codeMieUrl: 'https://x.example.com/ui',
      });

      expect(promptArgs).toEqual(expect.objectContaining({
        profile: 'work',
        codeMieUrl: 'https://x.example.com/ui',
      }));
      expect(confirmedUrl).toBe('https://x.example.com/ui');
    });

    it('passes the baseUrl origin to both when the workspace CodeMie URL has a different origin', async () => {
      const { promptArgs, confirmedUrl } = await connectAndCapture({
        name: 'work',
        baseUrl: 'https://api.example.com/code-assistant-api',
        codeMieUrl: 'https://other.example.com',
      });

      expect(promptArgs).toEqual(expect.objectContaining({
        profile: 'work',
        codeMieUrl: 'https://api.example.com',
      }));
      expect(confirmedUrl).toBe('https://api.example.com');
    });

    it('passes an undefined CodeMie URL to both when none is configured, still naming the profile', async () => {
      const { promptArgs, confirmedUrl, output } = await connectAndCapture({
        name: 'work',
        codeMieUrl: undefined,
      });

      expect(promptArgs.profile).toBe('work');
      expect(promptArgs.codeMieUrl).toBeUndefined();
      expect(confirmedUrl).toBeUndefined();
      expect(output).not.toContain('CodeMie URL');
    });

    it('falls back to the default profile name when the profile is unnamed', async () => {
      const { promptArgs } = await connectAndCapture({ name: undefined });

      expect(promptArgs.profile).toBe('default');
    });
  });

  describe('pre-prompt "Using profile:" line', () => {
    async function profileLinesFor(
      opts: ConnectOptions,
    ): Promise<string[]> {
      await withFreshDaemon();
      const { writeVsCodeLanguageModelsConfig } = await import('../connectors/vscode.js');
      vi.mocked(writeVsCodeLanguageModelsConfig).mockResolvedValue({ configPath: '/vscode/models.json', requiresSecretConfiguration: false, modelCount: 5 });
      const { connectTargets } = await import('../connect-orchestrator.js');

      await connectTargets(opts);

      return console_.log().mock.calls
        .map(([message]) => stripAnsi(String(message)))
        .filter((message) => message.startsWith('Using profile:'));
    }

    it.each([false, true])(
      'is not printed before the confirmation prompt (verbose=%s) while the prompt still receives the profile',
      async (verbose) => {
        const lines = await profileLinesFor({ targets: { claudeCodeOtlp: true }, verbose });
        const { promptAnalyticsConfirmation } = await import('../prompts/analytics-confirmation.js');

        expect(lines).toEqual([]);
        expect(promptAnalyticsConfirmation).toHaveBeenCalledTimes(1);
        expect(vi.mocked(promptAnalyticsConfirmation).mock.calls[0][0]).toEqual(
          expect.objectContaining({ profile: 'p' }),
        );
      },
    );

    it('is printed exactly once for Claude Code analytics with --silent', async () => {
      const lines = await profileLinesFor({ targets: { claudeCodeOtlp: true }, silent: true });
      const { promptAnalyticsConfirmation } = await import('../prompts/analytics-confirmation.js');

      expect(promptAnalyticsConfirmation).not.toHaveBeenCalled();
      expect(lines).toEqual(['Using profile: p']);
    });

    it('keeps the (source: ...) suffix with --silent in verbose mode', async () => {
      const lines = await profileLinesFor({ targets: { claudeCodeOtlp: true }, silent: true, verbose: true });

      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^Using profile: p \(source: (--profile|active profile)\)$/);
    });

    it.each([
      ['vscode', { vscode: true }],
      ['claudeDesktop', { claudeDesktop: true }],
    ] as const)('is printed exactly once for the %s target', async (_name, targets) => {
      const lines = await profileLinesFor({ targets });

      expect(lines).toEqual(['Using profile: p']);
    });

    it('is omitted for a combined run that shows the confirmation prompt', async () => {
      const lines = await profileLinesFor({ targets: { vscode: true, claudeCodeOtlp: true } });

      expect(lines).toEqual([]);
    });
  });

  it('does not run the analytics confirmation or print its CodeMie URL for a non-analytics target', async () => {
    await withFreshDaemon();
    const { promptAnalyticsConfirmation } = await import('../prompts/analytics-confirmation.js');
    const { writeVsCodeLanguageModelsConfig } = await import('../connectors/vscode.js');
    vi.mocked(writeVsCodeLanguageModelsConfig).mockResolvedValue({ configPath: '/vscode/models.json', requiresSecretConfiguration: false, modelCount: 5 });
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { vscode: true } });

    const output = console_.log().mock.calls
      .map(([message]) => stripAnsi(String(message)))
      .join('\n');
    expect(promptAnalyticsConfirmation).not.toHaveBeenCalled();
    expect(output).toContain('Using profile: p');
    expect(output).not.toContain('CodeMie URL:');
  });
});

describe('deriveDaemonIdentity — codex-desktop', () => {
  it('gives the Codex desktop target its own client type and no telemetry mode', async () => {
    const { deriveDaemonIdentity } = await import('../connect-orchestrator.js');

    expect(deriveDaemonIdentity({ codexDesktop: true })).toEqual({
      clientType: 'codex-desktop',
      spawnOptions: { clientType: 'codex-desktop' },
    });
  });

  it('keeps claude-desktop as the primary identity when combined', async () => {
    const { deriveDaemonIdentity } = await import('../connect-orchestrator.js');

    expect(deriveDaemonIdentity({ claudeDesktop: true, codexDesktop: true }).clientType)
      .toBe('claude-desktop');
  });

  it('prefers codex-desktop over vscode-byok', async () => {
    const { deriveDaemonIdentity } = await import('../connect-orchestrator.js');

    expect(deriveDaemonIdentity({ codexDesktop: true, vscode: true }).clientType)
      .toBe('codex-desktop');
  });
});

describe('ensureOtlpProxy', () => {
  const AGENT = 'claude-code-otlp';
  const lookup = vi.fn();
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let loggerSpies: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    loggerSpies = [];
    lookup.mockReset();
    lookup.mockResolvedValue({ token: 't' });
    vi.doMock('../../../../providers/core/codemie-auth-helpers.js', () => ({
      getStoredPlatformCredentials: lookup,
    }));
    consoleSpies = (['log', 'info', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {})
    );
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit:${code}`);
    });
  });

  afterEach(() => {
    for (const spy of [...consoleSpies, ...loggerSpies]) spy.mockRestore();
    exitSpy.mockRestore();
    vi.doUnmock('../../../../providers/core/codemie-auth-helpers.js');
    vi.resetModules();
  });

  // Loads the module graph fresh and arranges a cold start: no live daemon, the given
  // connection record, the given local/global profile lookups, a spawnable daemon.
  async function arrange(
    record: Record<string, unknown> | null = { version: 1, profile: 'p', clientType: AGENT, updatedAt: '' },
    local: Record<string, unknown> = { name: 'p' },
    global: Record<string, unknown> = {},
    configOverrides: Record<string, unknown> = {}
  ) {
    const { ensureOtlpProxy } = await import('../otlp-cold-start.js');
    const daemon = await import('../daemon-manager.js');
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { logger } = await import('../../../../utils/logger.js');

    await setupHappyMocks(configOverrides);
    vi.mocked(daemon.readState).mockResolvedValue(null);
    vi.mocked(daemon.readConnectionRecord).mockResolvedValue(
      record as Awaited<ReturnType<typeof daemon.readConnectionRecord>>
    );
    vi.mocked(daemon.checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(daemon.spawnDaemon).mockResolvedValue(
      daemonState() as Awaited<ReturnType<typeof daemon.spawnDaemon>>
    );
    vi.mocked(ConfigLoader.loadLocalConfigProfile).mockResolvedValue(local);
    vi.mocked(ConfigLoader.loadGlobalConfigProfile).mockResolvedValue(global);

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const status = vi.spyOn(logger, 'status').mockImplementation(() => {});
    const success = vi.spyOn(logger, 'success').mockImplementation(() => {});
    loggerSpies.push(warn, status, success);

    return { ensureOtlpProxy, daemon, ConfigLoader, warn, status, success };
  }

  const warnings = (warn: ReturnType<typeof vi.spyOn>): string[] =>
    warn.mock.calls.map(([message]) => String(message));

  function expectNoConsoleNoExit(): void {
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  }

  describe('with no recorded connection and no live daemon', () => {
    it('falls back to the working directory profile with the old identity, creating the record', async () => {
      const s = await arrange(null, undefined, undefined, { name: 'work' });
      vi.mocked(s.ConfigLoader.getActiveProfileName).mockResolvedValue('work');

      await expect(s.ensureOtlpProxy(AGENT)).resolves.toBeUndefined();

      expect(s.ConfigLoader.load).toHaveBeenCalledWith(process.cwd(), { name: 'work' });
      expect(s.daemon.spawnDaemon).toHaveBeenCalledTimes(1);
      const [spawned] = vi.mocked(s.daemon.spawnDaemon).mock.calls[0];
      expect(spawned).toMatchObject({ profile: 'work', clientType: AGENT, project: 'proj' });
      expect(spawned.writeRecord).not.toBe(false);
      expect(warnings(s.warn)).toEqual([
        expect.stringContaining('no recorded proxy connection; starting on the working directory\'s profile (profile: work)'),
      ]);
      expectNoConsoleNoExit();
    });

    it('loads the default config when the working directory has no active profile', async () => {
      const s = await arrange(null);
      vi.mocked(s.ConfigLoader.getActiveProfileName).mockResolvedValue(undefined);

      await s.ensureOtlpProxy(AGENT);

      expect(s.ConfigLoader.load).toHaveBeenCalledWith(process.cwd(), undefined);
      expect(s.daemon.spawnDaemon).toHaveBeenCalledTimes(1);
    });

    it('still starts, with a warning naming the profile, when SSO credentials are missing', async () => {
      const s = await arrange(null, undefined, undefined, { name: 'work' });
      lookup.mockResolvedValue(null);

      await expect(s.ensureOtlpProxy(AGENT)).resolves.toBeUndefined();

      expect(s.daemon.spawnDaemon).toHaveBeenCalledTimes(1);
      expect(s.daemon.spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({ profile: 'work', clientType: AGENT }));
      expect(warnings(s.warn)).toEqual([
        expect.stringContaining("No active CodeMie session for profile 'work'"),
        expect.stringContaining('no recorded proxy connection'),
      ]);
      expect(warnings(s.warn)[0]).toContain('no SSO credentials (profile: work)');
      expect(warnings(s.warn)[0]).toContain('holds the port until you sign in');
      expectNoConsoleNoExit();
    });

    it('returns silently without spawning when baseUrl is blank', async () => {
      const s = await arrange(null, undefined, undefined, { baseUrl: '   ' });

      await expect(s.ensureOtlpProxy(AGENT)).resolves.toBeUndefined();

      expect(s.daemon.spawnDaemon).not.toHaveBeenCalled();
      expect(s.warn).not.toHaveBeenCalled();
      expectNoConsoleNoExit();
    });

    it('treats a malformed record as a missing one', async () => {
      const { readConnectionRecord } = await vi.importActual<typeof import('../daemon-manager.js')>('../daemon-manager.js');
      const file = join(tmpdir(), `codemie-malformed-record-${process.pid}.json`);
      await writeFile(file, '{"version":1,"profile":""}', 'utf-8');
      const s = await arrange(null);
      const parsed = await readConnectionRecord(file);
      await unlink(file);
      expect(parsed).toBeNull();
      vi.mocked(s.daemon.readConnectionRecord).mockResolvedValue(parsed);
      s.warn.mockClear();

      await s.ensureOtlpProxy(AGENT);

      expect(s.daemon.spawnDaemon).toHaveBeenCalledTimes(1);
      expect(warnings(s.warn)[0]).toContain('no recorded proxy connection');
    });
  });

  it('skips with a warning naming the profile when it exists in neither scope', async () => {
    const s = await arrange(undefined, {}, {});

    await expect(s.ensureOtlpProxy(AGENT)).resolves.toBeUndefined();

    expect(s.daemon.spawnDaemon).not.toHaveBeenCalled();
    expect(warnings(s.warn)).toEqual([expect.stringContaining('(profile: p): profile not found')]);
    expect(s.ConfigLoader.load).not.toHaveBeenCalled();
  });

  it('skips when a legacy global config answers "default" for a differently named profile', async () => {
    const s = await arrange(undefined, {}, { name: 'default' });

    await expect(s.ensureOtlpProxy(AGENT)).resolves.toBeUndefined();

    expect(s.daemon.spawnDaemon).not.toHaveBeenCalled();
    expect(warnings(s.warn)).toEqual([expect.stringContaining('(profile: p): profile not found')]);
  });

  it('skips when the loaded config resolves to another profile', async () => {
    const s = await arrange(undefined, { name: 'p' }, {}, { name: 'other' });

    await expect(s.ensureOtlpProxy(AGENT)).resolves.toBeUndefined();

    expect(s.daemon.spawnDaemon).not.toHaveBeenCalled();
    expect(warnings(s.warn)).toEqual([expect.stringContaining('profile: p, local')]);
    expect(warnings(s.warn)[0]).toContain('other');
  });

  for (const [label, baseUrl] of [['undefined', undefined], ['an empty string', ''], ['whitespace-only', '   ']] as const) {
    it(`skips with a warning naming the profile when baseUrl is ${label}`, async () => {
      const s = await arrange(undefined, undefined, undefined, { baseUrl });

      await expect(s.ensureOtlpProxy(AGENT)).resolves.toBeUndefined();

      expect(s.daemon.spawnDaemon).not.toHaveBeenCalled();
      expect(warnings(s.warn)).toEqual([expect.stringContaining('(profile: p, local): no baseUrl configured')]);
      expectNoConsoleNoExit();
    });
  }

  it('restarts the recorded profile with a warning, and without console output or exit, when SSO credentials are missing', async () => {
    const s = await arrange();
    lookup.mockResolvedValue(null);

    await expect(s.ensureOtlpProxy(AGENT)).resolves.toBeUndefined();

    expect(s.daemon.spawnDaemon).toHaveBeenCalledTimes(1);
    expect(s.daemon.spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({ profile: 'p', clientType: AGENT }));
    expect(warnings(s.warn)).toEqual([expect.stringContaining("No active CodeMie session for profile 'p'")]);
    expect(warnings(s.warn)[0]).toContain('no SSO credentials (profile: p, local scope)');
    expect(warnings(s.warn)[0]).toContain('holds the port until you sign in');
    expectNoConsoleNoExit();
  });

  it('restarts the recorded profile with a warning when the credential lookup throws', async () => {
    const s = await arrange();
    lookup.mockRejectedValue(new Error('keychain locked'));

    await expect(s.ensureOtlpProxy(AGENT)).resolves.toBeUndefined();

    expect(s.daemon.spawnDaemon).toHaveBeenCalledTimes(1);
    expect(warnings(s.warn)).toEqual([expect.stringContaining('Failed to verify credentials: keychain locked')]);
    expectNoConsoleNoExit();
  });

  it('cold-starts the recorded profile from the hook cwd, never touching the active profile', async () => {
    const s = await arrange();

    await s.ensureOtlpProxy(AGENT);

    expect(s.ConfigLoader.load).toHaveBeenCalledWith(process.cwd(), { name: 'p' });
    expect(s.ConfigLoader.getActiveProfileName).not.toHaveBeenCalled();
    expect(s.daemon.spawnDaemon).toHaveBeenCalledTimes(1);
    expect(s.daemon.spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'p',
      targetUrl: 'https://x.example.com/api',
      clientType: AGENT,
    }));
    // A hook's stdout is the agent's protocol channel: status lines go through the logger.
    expect(s.status).toHaveBeenCalledWith('Starting proxy (profile: p)...');
    expect(s.success).toHaveBeenCalledWith('Proxy started');
    expect(s.warn).not.toHaveBeenCalled();
    expectNoConsoleNoExit();
  });

  it('spawns with the project of the loaded config, never one from the record', async () => {
    const s = await arrange({ version: 1, profile: 'p', project: 'recorded', clientType: AGENT, updatedAt: '' });

    await s.ensureOtlpProxy(AGENT);

    expect(s.daemon.spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({ project: 'proj' }));
  });

  it('logs the scope the profile was loaded from on a successful cold start', async () => {
    const s = await arrange(undefined, {}, { name: 'p' });
    const info = vi.spyOn((await import('../../../../utils/logger.js')).logger, 'info').mockImplementation(() => {});
    loggerSpies.push(info);

    await s.ensureOtlpProxy(AGENT);

    expect(info).toHaveBeenCalledWith('[ensureOtlpProxy] cold start (profile: p, global scope)');
    expect(s.daemon.spawnDaemon).toHaveBeenCalledTimes(1);
  });

  it('spawns with the recorded client type rather than the calling agent', async () => {
    const s = await arrange({ version: 1, profile: 'p', clientType: 'copilot-cli-otlp', updatedAt: '' });

    await s.ensureOtlpProxy(AGENT);

    expect(s.daemon.spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({ clientType: 'copilot-cli-otlp' }));
  });

  it('spawns with the recorded telemetry mode and no client type for a claude-desktop record', async () => {
    const s = await arrange({ version: 1, profile: 'p', telemetryMode: 'claude-desktop', updatedAt: '' });

    await s.ensureOtlpProxy(AGENT);

    const [spawned] = vi.mocked(s.daemon.spawnDaemon).mock.calls[0];
    expect(spawned.telemetryMode).toBe('claude-desktop');
    expect(spawned.clientType).toBeUndefined();
  });

  it('falls back to the calling agent when the record has neither client type nor telemetry mode', async () => {
    const s = await arrange({ version: 1, profile: 'p', updatedAt: '' });

    await s.ensureOtlpProxy(AGENT);

    expect(s.daemon.spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({ clientType: AGENT }));
  });

  it('reports a local profile found at the cwd as scope local', async () => {
    const s = await arrange(undefined, { name: 'p' }, { name: 'p' }, { baseUrl: '' });

    await s.ensureOtlpProxy(AGENT);

    expect(warnings(s.warn)).toEqual([expect.stringContaining('(profile: p, local)')]);
    expect(s.ConfigLoader.loadLocalConfigProfile).toHaveBeenCalledWith(process.cwd(), 'p');
  });

  it('reports a legacy local config answering default as scope local', async () => {
    const s = await arrange(
      { version: 1, profile: 'default', clientType: AGENT, updatedAt: '' },
      { name: 'default' },
      {},
      { name: 'default', baseUrl: '' }
    );

    await s.ensureOtlpProxy(AGENT);

    expect(warnings(s.warn)).toEqual([expect.stringContaining('(profile: default, local)')]);
  });

  it('reports scope global when the cwd (a repo subfolder) has no local config', async () => {
    const s = await arrange(undefined, {}, { name: 'p' }, { baseUrl: '' });

    await s.ensureOtlpProxy(AGENT);

    expect(warnings(s.warn)).toEqual([expect.stringContaining('(profile: p, global)')]);
    expect(s.ConfigLoader.loadGlobalConfigProfile).toHaveBeenCalledWith('p');
  });

  it('warns with the profile and rethrows when loading the config fails', async () => {
    const s = await arrange();
    vi.mocked(s.ConfigLoader.load).mockRejectedValue(new Error('broken config'));

    await expect(s.ensureOtlpProxy(AGENT)).rejects.toThrow('broken config');

    expect(warnings(s.warn)).toEqual([expect.stringContaining('(profile: p)')]);
    expect(s.daemon.spawnDaemon).not.toHaveBeenCalled();
  });

  it('warns with the profile and rethrows when the spawn fails', async () => {
    const s = await arrange();
    vi.mocked(s.daemon.spawnDaemon).mockRejectedValue(new Error('daemon did not start'));

    await expect(s.ensureOtlpProxy(AGENT)).rejects.toThrow('daemon did not start');

    expect(warnings(s.warn)).toEqual([expect.stringContaining('(profile: p)')]);
  });

  it('only seeds the connection record when a daemon is already alive', async () => {
    const s = await arrange(null);
    const alive = daemonState() as Awaited<ReturnType<typeof s.daemon.readState>>;
    vi.mocked(s.daemon.readState).mockResolvedValue(alive);

    await s.ensureOtlpProxy(AGENT);

    expect(s.daemon.seedConnectionRecord).toHaveBeenCalledWith(alive);
    expect(s.daemon.readConnectionRecord).not.toHaveBeenCalled();
    expect(s.daemon.spawnDaemon).not.toHaveBeenCalled();
    expect(s.warn).not.toHaveBeenCalled();
  });

  it('stops the cold start when a daemon came up between the two liveness checks', async () => {
    const s = await arrange();
    const cameUp = daemonState({ profile: 'other' }) as Awaited<ReturnType<typeof s.daemon.readState>>;
    vi.mocked(s.daemon.readState).mockResolvedValueOnce(null).mockResolvedValueOnce(cameUp);

    await s.ensureOtlpProxy(AGENT);

    expect(s.daemon.seedConnectionRecord).toHaveBeenCalledWith(cameUp);
    expect(s.daemon.spawnDaemon).not.toHaveBeenCalled();
    expect(s.daemon.stopDaemon).not.toHaveBeenCalled();
  });

  it('does not stop a running daemon that matches the record', async () => {
    const s = await arrange();
    const matching = daemonState({
      clientType: AGENT,
      provider: 'ai-run-sso',
      targetUrl: 'https://x.example.com/api',
      project: 'proj',
    }) as Awaited<ReturnType<typeof s.daemon.readState>>;
    vi.mocked(s.daemon.readState).mockResolvedValueOnce(null).mockResolvedValueOnce(matching);
    vi.mocked(s.daemon.checkStatus).mockResolvedValue({ running: true, state: matching });

    await s.ensureOtlpProxy(AGENT);

    expect(s.daemon.stopDaemon).not.toHaveBeenCalled();
    expect(s.daemon.spawnDaemon).not.toHaveBeenCalled();
  });

  it('respawns on the port the Claude settings point at and re-points them at the new daemon', async () => {
    const s = await arrange();
    const { readConfiguredOtlpPort, refreshClaudeCodeOtlpEndpoint } = await import('../connectors/claude-code-otlp-endpoint.js');
    // Stale state on P1, settings on P1, 4001 busy: the daemon falls back to P2.
    vi.mocked(s.daemon.readState).mockResolvedValue(daemonState({ pid: 999999, port: 62380 }) as Awaited<ReturnType<typeof s.daemon.readState>>);
    const actual = await vi.importActual<typeof import('../connectors/claude-code-otlp-endpoint.js')>('../connectors/claude-code-otlp-endpoint.js');
    const { getClaudeSettingsPath } = await import('@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js');
    const home = await mkdtemp(join(tmpdir(), 'otlp-respawn-'));
    const settingsPath = join(home, '.claude', 'settings.json');
    await mkdir(join(home, '.claude'));
    await writeFile(settingsPath, JSON.stringify({ theme: 'dark', env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:62380/v1/analytics/otlp',
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer old-key',
    } }));
    vi.mocked(getClaudeSettingsPath).mockReturnValue(settingsPath);
    vi.mocked(readConfiguredOtlpPort).mockImplementationOnce(actual.readConfiguredOtlpPort);
    vi.mocked(refreshClaudeCodeOtlpEndpoint).mockImplementationOnce(actual.refreshClaudeCodeOtlpEndpoint);
    const respawned = daemonState({ port: 60005, url: 'http://127.0.0.1:60005' });
    vi.mocked(s.daemon.spawnDaemon).mockResolvedValue(respawned as Awaited<ReturnType<typeof s.daemon.spawnDaemon>>);

    try {
      await s.ensureOtlpProxy(AGENT);
      expect(s.daemon.spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({ port: 62380 }));
      const saved = JSON.parse(await readFile(settingsPath, 'utf-8'));
      expect(saved.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(`${respawned.url}/v1/analytics/otlp`);
      expect(saved.env.OTEL_EXPORTER_OTLP_HEADERS).toBe(`Authorization=Bearer ${respawned.gatewayKey}`);
      expect(saved.theme).toBe('dark');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('falls back to the last daemon port, then the default, when the settings name none', async () => {
    const s = await arrange();

    vi.mocked(s.daemon.readState).mockResolvedValue(daemonState({ pid: 999999, port: 62380 }) as Awaited<ReturnType<typeof s.daemon.readState>>);
    await s.ensureOtlpProxy(AGENT);
    expect(s.daemon.spawnDaemon).toHaveBeenLastCalledWith(expect.objectContaining({ port: 62380 }));

    vi.mocked(s.daemon.readState).mockResolvedValue(null);
    await s.ensureOtlpProxy(AGENT);
    expect(s.daemon.spawnDaemon).toHaveBeenLastCalledWith(expect.objectContaining({ port: 4001 }));
  });

  it('applies the same port rules when there is no recorded connection', async () => {
    const s = await arrange(null);
    vi.mocked(s.daemon.readState).mockResolvedValue(daemonState({ pid: 999999, port: 62380 }) as Awaited<ReturnType<typeof s.daemon.readState>>);

    await s.ensureOtlpProxy(AGENT);

    expect(s.daemon.spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({ port: 62380 }));
  });

  it('re-points the settings at an already-running daemon without spawning', async () => {
    const s = await arrange();
    const { refreshClaudeCodeOtlpEndpoint } = await import('../connectors/claude-code-otlp-endpoint.js');
    const running = daemonState({ port: 60005, url: 'http://127.0.0.1:60005' });
    vi.mocked(s.daemon.readState).mockResolvedValue(running as Awaited<ReturnType<typeof s.daemon.readState>>);

    await s.ensureOtlpProxy(AGENT);

    expect(s.daemon.spawnDaemon).not.toHaveBeenCalled();
    expect(refreshClaudeCodeOtlpEndpoint).toHaveBeenCalledWith(running);
    expect(s.daemon.seedConnectionRecord).toHaveBeenCalledWith(running);
  });

  // The start-time check is POSIX (`ps etime`); on Windows the daemon is judged by its pid alone, covered in daemon-manager.test.ts
  it.skipIf(process.platform === 'win32')('starts the proxy when the state names a pid that now belongs to another process', async () => {
    const { ensureOtlpProxy } = await import('../otlp-cold-start.js');
    const { readState, spawnDaemon, checkStatus } = await import('../daemon-manager.js');
    const { isOwnerAlive } = await import('@/utils/processes.js');
    vi.mocked(readState).mockResolvedValue(daemonState() as Awaited<ReturnType<typeof readState>>);
    // Persistent, not Once: the cold start re-checks for a daemon after resolving the profile
    vi.mocked(isOwnerAlive).mockResolvedValue(false);
    // The mock outlives resetModules, so the next test would inherit the "foreign process" answer
    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(spawnDaemon).mockResolvedValue(
      daemonState({ telemetryMode: 'claude-code-otlp' }) as Awaited<ReturnType<typeof spawnDaemon>>
    );
    await setupHappyMocks();
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await ensureOtlpProxy('claude-code-otlp');
    } finally {
      consoleLog.mockRestore();
      vi.mocked(isOwnerAlive).mockImplementation(async () => true);
    }

    expect(spawnDaemon).toHaveBeenCalled();
  });

  it('starts nothing while the state\'s daemon runs', async () => {
    const { ensureOtlpProxy } = await import('../otlp-cold-start.js');
    const { readState, spawnDaemon } = await import('../daemon-manager.js');
    const { processStartedAt } = await import('@/utils/processes.js');
    vi.mocked(readState).mockResolvedValue(
      daemonState({ startedAt: new Date(processStartedAt()).toISOString() }) as Awaited<ReturnType<typeof readState>>
    );
    await setupHappyMocks();

    await ensureOtlpProxy('claude-code-otlp');

    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  // The start-time check is POSIX (`ps etime`); on Windows the daemon is judged by its pid alone, covered in daemon-manager.test.ts
  it.skipIf(process.platform === 'win32')('starts nothing for an old-format state written 10 minutes after its daemon started', async () => {
    const { ensureOtlpProxy } = await import('../otlp-cold-start.js');
    const { readState, spawnDaemon } = await import('../daemon-manager.js');
    const processes = await import('@/utils/processes.js');
    const exec = await import('@/utils/exec.js');
    const actual = await vi.importActual<typeof import('@/utils/processes.js')>('@/utils/processes.js');
    const now = Date.parse('2026-10-31T12:00:00Z');
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.spyOn(Date, 'now').mockReturnValue(now);
    // `ps` reports the daemon running for 20 minutes; its state names a start 10 minutes in
    vi.spyOn(exec, 'exec').mockResolvedValue({ code: 0, stdout: '20:00\n', stderr: '' });
    vi.mocked(processes.isOwnerAlive).mockImplementation(actual.isOwnerAlive);
    vi.mocked(readState).mockResolvedValue(
      daemonState({ startedAt: new Date(now - 600_000).toISOString() }) as Awaited<ReturnType<typeof readState>>
    );
    await setupHappyMocks();

    try {
      await ensureOtlpProxy('claude-code-otlp');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      vi.mocked(processes.isOwnerAlive).mockImplementation(async () => true);
      vi.restoreAllMocks();
    }

    expect(spawnDaemon).not.toHaveBeenCalled();
  });
});

describe('runCodexDesktop', () => {
  // resetModules BEFORE each case: connect-orchestrator.js is cached by earlier
  // describes, and vi.doMock only affects modules imported after the registry is
  // clear. Without this the first case silently runs the real connector.
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.doUnmock('../connectors/codex-desktop.js'); vi.resetModules(); });

  const codexDesktopMock = (overrides: Record<string, unknown> = {}) => ({
    findCodexDesktopApp: vi.fn().mockReturnValue('/Applications/ChatGPT.app'),
    getCodexDesktopConfigPath: vi.fn().mockReturnValue('/tmp/config.toml'),
    getCodexDesktopStatePath: vi.fn().mockReturnValue('/tmp/state.json'),
    getCodexDesktopAppCandidates: vi.fn().mockReturnValue(['/Applications/ChatGPT.app']),
    discoverCodexModels: vi.fn().mockResolvedValue(['gpt-5-codex']),
    selectCodexModel: vi.fn().mockReturnValue('gpt-5-codex'),
    writeCodexDesktopConfig: vi.fn().mockResolvedValue({}),
    ...overrides,
  });

  it('surfaces a connector failure as a failed target rather than throwing', async () => {
    vi.doMock('../connectors/codex-desktop.js', () => codexDesktopMock({
      discoverCodexModels: vi.fn().mockRejectedValue(new Error('proxy down')),
    }));

    const { runCodexDesktopForTest } = await import('../connect-orchestrator.js');
    const result = await runCodexDesktopForTest(
      { url: 'http://127.0.0.1:4001', gatewayKey: 'k' } as never,
      {}
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('proxy down');
  });

  it('fails with an app-not-found message when detection finds nothing', async () => {
    vi.doMock('../connectors/codex-desktop.js', () => codexDesktopMock({
      findCodexDesktopApp: vi.fn().mockReturnValue(null),
    }));

    const { runCodexDesktopForTest } = await import('../connect-orchestrator.js');
    const result = await runCodexDesktopForTest(
      { url: 'http://127.0.0.1:4001', gatewayKey: 'k' } as never,
      {}
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('ChatGPT.app');
    // The story guarantees nothing is written when the app is absent, so the
    // message alone is not enough — the writer must never have been reached.
    const { writeCodexDesktopConfig } = await import('../connectors/codex-desktop.js');
    expect(writeCodexDesktopConfig).not.toHaveBeenCalled();
  });

  it('writes the config and succeeds when the app is present', async () => {
    const write = vi.fn().mockResolvedValue({});
    vi.doMock('../connectors/codex-desktop.js', () => codexDesktopMock({
      writeCodexDesktopConfig: write,
    }));

    const { runCodexDesktopForTest } = await import('../connect-orchestrator.js');
    const result = await runCodexDesktopForTest(
      { url: 'http://127.0.0.1:4001', gatewayKey: 'k' } as never,
      {}
    );

    expect(result.ok).toBe(true);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'http://127.0.0.1:4001/v1',
      gatewayKey: 'k',
      model: 'gpt-5-codex',
    }));
  });

  it('proceeds past a missing app when --force is set', async () => {
    vi.doMock('../connectors/codex-desktop.js', () => codexDesktopMock({
      findCodexDesktopApp: vi.fn().mockReturnValue(null),
    }));

    const { runCodexDesktopForTest } = await import('../connect-orchestrator.js');
    const result = await runCodexDesktopForTest(
      { url: 'http://127.0.0.1:4001', gatewayKey: 'k' } as never,
      { force: true }
    );

    expect(result.ok).toBe(true);
  });
});

describe('assertSsoCredentials', () => {
  const BASE_URL = 'https://x.example.com/api';
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const lookup = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    lookup.mockReset();
    vi.doMock('../../../../providers/core/codemie-auth-helpers.js', () => ({
      getStoredPlatformCredentials: lookup,
    }));
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit:${code}`);
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
    vi.doUnmock('../../../../providers/core/codemie-auth-helpers.js');
    vi.resetModules();
  });

  it('throws the missing-login message with the login URL line when no credentials are stored', async () => {
    lookup.mockResolvedValue(null);
    const { assertSsoCredentials } = await import('../connect-orchestrator.js');
    const { ConfigurationError } = await import('../../../../utils/errors.js');

    const thrown = await assertSsoCredentials(BASE_URL, 'p', 'https://x.example.com').catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect((thrown as Error).message).toBe(
      "No active CodeMie session for profile 'p'.\n  Run: codemie profile login --url https://x.example.com"
    );
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith({
      provider: 'ai-run-sso',
      baseUrl: BASE_URL,
      codeMieUrl: 'https://x.example.com',
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('throws Failed to verify credentials when the lookup throws, without double-wrapping', async () => {
    lookup.mockRejectedValue(new Error('keychain locked'));
    const { assertSsoCredentials } = await import('../connect-orchestrator.js');
    const { ConfigurationError } = await import('../../../../utils/errors.js');

    const thrown = await assertSsoCredentials(BASE_URL, 'p').catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect((thrown as Error).message).toBe('Failed to verify credentials: keychain locked');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('resolves silently when credentials are stored', async () => {
    lookup.mockResolvedValue({ cookies: {} });
    const { assertSsoCredentials } = await import('../connect-orchestrator.js');

    await expect(assertSsoCredentials(BASE_URL, 'p')).resolves.toBeUndefined();

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
