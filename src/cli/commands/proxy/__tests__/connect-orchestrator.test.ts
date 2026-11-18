/**
 * connect-orchestrator unit tests
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import stripAnsi from 'strip-ansi';
import { chmod, mkdtemp, mkdir, readFile, symlink, unlink, utimes, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NPM_WIN32_SHIMS } from '../../../../../tests/helpers/npm-shims.js';
import {
  daemonMatchesRequest,
  type ConnectOptions,
  type RequestedDaemonConfig,
} from '../connect-orchestrator.js';

vi.mock('../../../../utils/config.js', () => ({
  ConfigLoader: {
    load: vi.fn(),
    listProfiles: vi.fn(),
    getActiveProfileName: vi.fn(),
    loadLocalConfigProfile: vi.fn(),
    loadGlobalConfigProfile: vi.fn(),
    resolveProfileIdentity: vi.fn(),
  },
}));
vi.mock('../../../../providers/index.js', () => ({
  ProviderRegistry: { getProvider: vi.fn() },
}));
vi.mock('../daemon-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../daemon-manager.js')>();
  return {
    isDaemonAlive: actual.isDaemonAlive,
    isOlderDaemon: actual.isOlderDaemon,
    checkStatus: vi.fn(),
    readState: vi.fn(),
    writeState: vi.fn(),
    spawnDaemon: vi.fn(),
    stopDaemon: vi.fn(),
    readConnectionRecord: vi.fn(),
    writeConnectionRecord: vi.fn(),
    clearLegacyClientIdentity: vi.fn(),
    hasLegacyClientIdentity: vi.fn(),
    seedConnectionRecord: vi.fn(),
  };
});
// The CLI's own version is read from its package.json: every test pins it.
vi.mock('@/utils/cli-updater.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/cli-updater.js')>()),
  getCurrentCliVersion: vi.fn(async () => '0.17.0'),
}));
vi.mock('@/utils/processes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/processes.js')>()),
  spawnDetached: vi.fn(),
  resolveRepositoryName: vi.fn(async () => 'owner/repo'),
  // The start comparison runs `ps`; the test that exercises it switches this to the real one with `ps` mocked
  isOwnerAlive: vi.fn(async () => true),
  // The PATH lookup of the first `codemie` finds none unless a test points it at an install of its own.
  getCommandPath: vi.fn(async () => null),
}));
vi.mock('../health-check.js', () => ({
  checkProxyHealth: vi.fn(),
  // No proxy answers: a daemon that fails its start check reads gone
  fetchProxyHealth: vi.fn(async () => { throw new TypeError('fetch failed'); }),
}));
vi.mock('../connectors/desktop.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/desktop.js')>()),
  writeDesktopConfig: vi.fn(),
  getDesktopBaseDir: vi.fn().mockReturnValue('/mock/desktop/base'),
  mapCanonicalToDesktop: vi.fn().mockReturnValue([]),
  summarizeManagedOauthShapes: vi.fn().mockReturnValue({ oauthConfigured: 0, oauthFlagged: 0, noAuth: 0 }),
  describeManagedSettingsOverride: vi.fn().mockReturnValue(null),
  readDesktopGateway: vi.fn().mockResolvedValue(null),
}));
vi.mock('../connectors/vscode.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/vscode.js')>()),
  writeVsCodeLanguageModelsConfig: vi.fn(),
}));
vi.mock('../connectors/omp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/omp.js')>()),
  writeOmpExtension: vi.fn(),
}));
vi.mock('../connectors/vscode-claude-code.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/vscode-claude-code.js')>()),
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
  readAllowlistState: vi.fn().mockResolvedValue({ kind: 'absent' }),
}));
vi.mock('@/utils/project-root.js', () => ({
  resolveProjectRoot: vi.fn().mockReturnValue('/mock/project'),
}));
vi.mock('../prompts/analytics-confirmation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../prompts/analytics-confirmation.js')>()),
  promptAnalyticsConfirmation: vi.fn().mockResolvedValue('enable'),
}));
vi.mock('@/utils/interactive.js', () => ({
  isNonInteractiveEnvironment: vi.fn().mockReturnValue(false),
}));

// A test that connects Claude Desktop leaves the shared mock as it found it: not connected.
afterEach(async () => {
  const { readDesktopGateway } = await import('../connectors/desktop.js');
  vi.mocked(readDesktopGateway).mockResolvedValue(null);
});

/**
 * Every logger instance this file's module graphs wrote with: each vi.resetModules gives a graph its own, and code
 * of an earlier graph still writes with that graph's instance. Each is closed before a temporary CODEMIE_HOME is
 * removed — Windows does not remove a directory that holds an open log file.
 */
const loggers = new Set<(typeof import('../../../../utils/logger.js'))['logger']>();
async function closeLoggers(): Promise<void> {
  loggers.add((await import('../../../../utils/logger.js')).logger);
  await Promise.all([...loggers].map((instance) => instance.close()));
}

// Every client config a connect reads lives under a home of the test's own.
let clientHome: string;
beforeEach(async () => {
  clientHome = await mkdtemp(join(tmpdir(), 'connect-client-home-'));
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']) {
    vi.stubEnv(name, clientHome);
  }
  vi.stubEnv('CODEX_HOME', join(clientHome, '.codex'));
  vi.stubEnv('PI_CODING_AGENT_DIR', join(clientHome, '.omp', 'agent'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await closeLoggers();
  await rm(clientHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

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

/** A daemon state written by this CLI's version (`0.17.0`, see the cli-updater mock). */
function daemonState(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: process.pid,
    port: 4001,
    url: 'http://127.0.0.1:4001',
    profile: 'p',
    gatewayKey: 'gk',
    version: '0.17.0',
    startedAt: new Date().toISOString(),
    ...extra,
  };
}

// A running daemon whose fields match the happy-path config of a connect.
function matchingDesktopState(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return daemonState({
    provider: 'ai-run-sso',
    targetUrl: 'https://x.example.com/api',
    project: 'proj',
    syncCodeMieUrl: 'https://x.example.com',
    ...extra,
  });
}

/** Another process holding the daemon lock: this process's pid with another start time, read as alive. */
const OTHER_LOCK_HOLDER = JSON.stringify({ pid: process.pid, startedAt: 1 });

/**
 * Runs `fn` with a CODEMIE_HOME of its own, so a test that holds the daemon lock itself never meets the lock of
 * another test file of the run.
 */
async function withOwnLockHome<T>(fn: (lockPath: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'daemon-lock-'));
  const previous = process.env.CODEMIE_HOME;
  process.env.CODEMIE_HOME = home;
  try {
    return await fn(join(home, 'proxy-daemon.lock'));
  } finally {
    process.env.CODEMIE_HOME = previous;
    await closeLoggers();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** A clock a second ahead at every read: a lock wait reaches its budget in a few polls instead of seconds. */
function advancingClock(): { mockRestore: () => void } {
  const realNow = Date.now.bind(Date);
  let reads = 0;
  return vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 1000 * reads++);
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

describe('daemonMatchesRequest — model comparison', () => {
  function baseRequest(extra: Partial<RequestedDaemonConfig> = {}): RequestedDaemonConfig {
    return {
      profile: 'p',
      port: 4001,
      project: 'proj',
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

  it('compares no client type: a state of another client type matches', () => {
    expect(daemonMatchesRequest(codexState({ clientType: 'claude-desktop', telemetryMode: 'claude-desktop' }), baseRequest())).toBe(true);
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
    const { resolveRepositoryName } = await import('@/utils/processes.js');
    vi.mocked(promptAnalyticsConfirmation).mockResolvedValueOnce('cancel');
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeCodeOtlp: true }, scope: 'project' });

    expect(resolveRepositoryName).toHaveBeenCalledWith('/mock/project');
    expect(promptAnalyticsConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryName: 'owner/repo' })
    );
    const promptArgs = vi.mocked(promptAnalyticsConfirmation).mock.calls[0][0];
    expect(promptArgs).not.toHaveProperty('name');
    expect(promptArgs).not.toHaveProperty('url');
    expect(checkStatus).not.toHaveBeenCalled();
    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  it('shows the prompt without a project name when scope is omitted and a declined default writes nothing', async () => {
    await setupHappyMocks();
    const { checkStatus, spawnDaemon, stopDaemon } = await import('../daemon-manager.js');
    const { writeClaudeCodeOtlpConfig } = await import('../connectors/claude-code-otlp.js');
    const { promptAnalyticsConfirmation } = await import('../prompts/analytics-confirmation.js');
    const { resolveRepositoryName } = await import('@/utils/processes.js');
    vi.mocked(promptAnalyticsConfirmation).mockResolvedValueOnce('cancel');
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeCodeOtlp: true } });

    expect(promptAnalyticsConfirmation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(promptAnalyticsConfirmation).mock.calls[0][0].repositoryName).toBeUndefined();
    expect(resolveRepositoryName).not.toHaveBeenCalled();
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
    const printed = console_.log().mock.calls.map(([message]) => stripAnsi(String(message)));
    expect(printed).toContain('CodeMie URL: https://x.example.com');
    expect(printed.some((message) => message.startsWith('Repository:'))).toBe(false);
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
    const printed = console_.log().mock.calls.map(([message]) => stripAnsi(String(message)));
    expect(printed).toContain('CodeMie URL: https://x.example.com');
    expect(printed).toContain('Repository: owner/repo');
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
    expect(status).toHaveBeenCalledWith('Restarting proxy to match the requested profile, port, project, provider, target URL and model...');
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

  it('reuses a live daemon whose state holds another client type and the same version', async () => {
    await setupHappyMocks();
    const { checkStatus, spawnDaemon, stopDaemon } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: matchingDesktopState({ clientType: 'codex-desktop', telemetryMode: 'claude-desktop' }) as Awaited<ReturnType<typeof checkStatus>>['state'],
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'deep', code: 'ok' });
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true } });

    expect(stopDaemon).not.toHaveBeenCalled();
    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  it('reuses a daemon that wrote the same model into its state', async () => {
    await setupHappyMocks({ model: 'gpt-5' });
    const { checkStatus, spawnDaemon, stopDaemon } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: matchingDesktopState({ model: 'gpt-5' }) as Awaited<ReturnType<typeof checkStatus>>['state'],
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'deep', code: 'ok' });
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true } });

    expect(stopDaemon).not.toHaveBeenCalled();
    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  it.each([
    ['an older version', { version: '0.16.9' }, '0.17.0', true],
    ['no version', { version: undefined }, '0.17.0', true],
    ['version 0.0.0', { version: '0.0.0' }, '0.17.0', true],
    ['a newer version', { version: '0.18.0' }, '0.17.0', false],
    ['a pre-release of the own version', { version: '0.17.0-rc.1' }, '0.17.0', true],
    ['an older version, beside an own pre-release version', { version: '0.16.0' }, '0.17.0-rc.1', true],
    ['a version that is not a version', { version: 'abc' }, '0.17.0', false],
    ['a version, beside an own version that is not a version', { version: '0.16.0' }, 'abc', false],
    ['a version, beside an unreadable own version', { version: '0.16.0' }, null, false],
  ] as const)('a matching healthy daemon with %s is replaced only when older', async (_label, versionField, ownVersion, replaced) => {
    await setupHappyMocks();
    const { checkStatus, spawnDaemon, stopDaemon } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    const { getCurrentCliVersion } = await import('@/utils/cli-updater.js');
    vi.mocked(getCurrentCliVersion).mockResolvedValue(ownVersion);
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: matchingDesktopState(versionField) as Awaited<ReturnType<typeof checkStatus>>['state'],
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'deep', code: 'ok' });
    vi.mocked(spawnDaemon).mockResolvedValue(matchingDesktopState() as Awaited<ReturnType<typeof spawnDaemon>>);
    const { logger } = await import('../../../../utils/logger.js');
    const status = vi.spyOn(logger, 'status').mockImplementation(() => {});
    const { connectTargets } = await import('../connect-orchestrator.js');

    try {
      await connectTargets({ targets: { claudeDesktop: true } });
    } finally {
      vi.mocked(getCurrentCliVersion).mockResolvedValue('0.17.0');
    }

    expect(vi.mocked(stopDaemon).mock.calls.length > 0).toBe(replaced);
    expect(vi.mocked(spawnDaemon).mock.calls.length > 0).toBe(replaced);
    if (replaced) {
      expect(status).toHaveBeenCalledWith('Restarting proxy: it was started by an older CodeMie CLI...');
    }
    status.mockRestore();
  });

  it('asks for the port recorded with the clients when no daemon runs', async () => {
    await setupHappyMocks();
    const { checkStatus, readConnectionRecord, spawnDaemon } = await import('../daemon-manager.js');
    vi.mocked(readConnectionRecord).mockResolvedValue({ version: 1, profile: 'p', updatedAt: '', port: 52311 });
    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(spawnDaemon).mockResolvedValue(matchingDesktopState({ port: 52311, url: 'http://127.0.0.1:52311' }) as Awaited<ReturnType<typeof spawnDaemon>>);
    const { connectTargets } = await import('../connect-orchestrator.js');

    try {
      await connectTargets({ targets: { claudeDesktop: true } });
    } finally {
      vi.mocked(readConnectionRecord).mockReset();
    }

    expect(spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({ port: 52311 }));
  });

  it('writes the targets for the port of a matching daemon on a fallback port and records that port', async () => {
    await setupHappyMocks();
    const { checkStatus, readConnectionRecord, spawnDaemon, writeConnectionRecord } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    const { writeDesktopConfig } = await import('../connectors/desktop.js');
    const onFallback = matchingDesktopState({ port: 60122, url: 'http://127.0.0.1:60122' });
    vi.mocked(readConnectionRecord).mockResolvedValue({ version: 1, profile: 'p', updatedAt: '', port: 52311 });
    vi.mocked(checkStatus).mockResolvedValue({ running: true, state: onFallback as Awaited<ReturnType<typeof checkStatus>>['state'] });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'deep', code: 'ok' });
    vi.mocked(writeDesktopConfig).mockResolvedValue('/desktop/config.json');
    const { connectTargets } = await import('../connect-orchestrator.js');

    try {
      await connectTargets({ targets: { claudeDesktop: true } });
    } finally {
      vi.mocked(readConnectionRecord).mockReset();
    }

    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(vi.mocked(writeDesktopConfig).mock.calls[0][0]).toBe('http://127.0.0.1:60122');
    expect(writeConnectionRecord).toHaveBeenCalledWith(onFallback, 'p', { port: 60122 });
  });

  it('spawns from its own config, never from the state of the older daemon it replaces', async () => {
    await setupHappyMocks({
      name: 'p', codeMieProject: 'A', model: 'm1', baseUrl: 'https://t', provider: 'ai-run-sso',
      ssoConfig: { apiUrl: 'https://s' }, codeMieUrl: 'https://c',
    });
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { checkStatus, readState, spawnDaemon, stopDaemon } = await import('../daemon-manager.js');
    vi.mocked(readState).mockResolvedValue(null);
    vi.mocked(ConfigLoader.resolveProfileIdentity).mockResolvedValue(
      { state: 'own', profileName: 'p', shared: {}, identity: {} } as unknown as Awaited<ReturnType<typeof ConfigLoader.resolveProfileIdentity>>
    );
    const expected = {
      targetUrl: 'https://t', provider: 'ai-run-sso', profile: 'p', model: 'm1', port: 4001, project: 'A',
      projectBinding: 'own', syncApiUrl: 'https://s', syncCodeMieUrl: 'https://c', writeRecord: false, recordPort: false,
    };
    const { connectTargets } = await import('../connect-orchestrator.js');

    for (const running of [
      null,
      daemonState({
        version: undefined, project: 'B', projectBinding: 'local', gatewayKey: 'k', model: 'm2', targetUrl: 'https://t2',
        provider: 'x', syncApiUrl: 'https://s2', syncCodeMieUrl: 'https://c2',
      }),
    ]) {
      vi.mocked(spawnDaemon).mockClear();
      vi.mocked(checkStatus).mockResolvedValue(
        running ? { running: true, state: running as Awaited<ReturnType<typeof checkStatus>>['state'] } : { running: false, state: null }
      );
      vi.mocked(spawnDaemon).mockResolvedValue(daemonState() as Awaited<ReturnType<typeof spawnDaemon>>);

      try {
        await connectTargets({ targets: { vscodeClaudeCode: true } });
      } finally {
        if (running) vi.mocked(ConfigLoader.resolveProfileIdentity).mockReset();
      }

      expect(vi.mocked(spawnDaemon).mock.calls[0][0]).toEqual(expected);
    }
    expect(stopDaemon).toHaveBeenCalled();
  });

  describe('the daemon lock', () => {
    it('fails with the lock message and exit 1, stopping and spawning nothing, when the lock stays held past its budget', async () => {
      await setupHappyMocks();
      const { checkStatus, spawnDaemon, stopDaemon } = await import('../daemon-manager.js');
      vi.mocked(checkStatus).mockResolvedValue({ running: true, state: daemonState({ profile: 'other' }) as Awaited<ReturnType<typeof checkStatus>>['state'] });
      const { connectTargets } = await import('../connect-orchestrator.js');

      await withOwnLockHome(async (lockPath) => {
        await writeFile(lockPath, OTHER_LOCK_HOLDER);
        const clock = advancingClock();
        try {
          await expect(connectTargets({ targets: { claudeDesktop: true } })).rejects.toThrow('process.exit:1');
        } finally {
          clock.mockRestore();
        }
      });

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Another codemie process is starting or stopping the proxy; try again.'));
      expect(stopDaemon).not.toHaveBeenCalled();
      expect(spawnDaemon).not.toHaveBeenCalled();
    });

    it('a waiter that gets the lock reads the daemon the holder started and spawns none', async () => {
      await setupHappyMocks();
      const { checkStatus, spawnDaemon, stopDaemon } = await import('../daemon-manager.js');
      const { checkProxyHealth } = await import('../health-check.js');
      const { isOwnerAlive } = await import('@/utils/processes.js');
      vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'deep', code: 'ok' });
      const { connectTargets } = await import('../connect-orchestrator.js');

      const lockAtRead: string[] = [];
      await withOwnLockHome(async (lockPath) => {
        await writeFile(lockPath, OTHER_LOCK_HOLDER);
        // The holder is judged alive once, then finishes: its daemon is up and its lock released.
        vi.mocked(isOwnerAlive).mockImplementation(async (holder) => {
          if (holder.startedAt === 1) await unlink(lockPath);
          return true;
        });
        vi.mocked(checkStatus).mockImplementation(async () => {
          lockAtRead.push(await readFile(lockPath, 'utf-8'));
          return { running: true, state: matchingDesktopState() as Awaited<ReturnType<typeof checkStatus>>['state'] };
        });
        try {
          await connectTargets({ targets: { claudeDesktop: true } });
        } finally {
          vi.mocked(isOwnerAlive).mockImplementation(async () => true);
        }
      });

      expect(lockAtRead.map((raw) => JSON.parse(raw).startedAt)).not.toContain(1);
      expect(lockAtRead.length > 0).toBe(true);
      expect(stopDaemon).not.toHaveBeenCalled();
      expect(spawnDaemon).not.toHaveBeenCalled();
    });

    it('takes at once a lock left by a dead process', async () => {
      const { withDaemonLock } = await import('../daemon-lock.js');
      const { isOwnerAlive } = await import('@/utils/processes.js');
      const actual = await vi.importActual<typeof import('@/utils/processes.js')>('@/utils/processes.js');
      vi.mocked(isOwnerAlive).mockImplementation(actual.isOwnerAlive);

      try {
        await withOwnLockHome(async (lockPath) => {
          await writeFile(lockPath, JSON.stringify({ pid: 9999999, startedAt: 1 }));
          await expect(withDaemonLock(1, async () => 'ran')).resolves.toBe('ran');
        });
      } finally {
        vi.mocked(isOwnerAlive).mockImplementation(async () => true);
      }
    });

    it('waits out an empty lock file younger than 5 s, then takes it', async () => {
      const { withDaemonLock } = await import('../daemon-lock.js');

      await withOwnLockHome(async (lockPath) => {
        await writeFile(lockPath, '');
        await expect(withDaemonLock(1, async () => 'ran')).rejects.toThrow('Another codemie process');
        const clock = advancingClock();
        try {
          await expect(withDaemonLock(25_000, async () => 'ran')).resolves.toBe('ran');
        } finally {
          clock.mockRestore();
        }
      });
    });

    it('takes at once an unparsable lock file older than 5 s', async () => {
      const { withDaemonLock } = await import('../daemon-lock.js');

      await withOwnLockHome(async (lockPath) => {
        await writeFile(lockPath, '{ not json');
        const old = new Date(Date.now() - 10_000);
        await utimes(lockPath, old, old);
        await expect(withDaemonLock(1, async () => 'ran')).resolves.toBe('ran');
      });
    });

    it('releases the lock when the locked function throws, and rethrows its error unchanged', async () => {
      const { withDaemonLock } = await import('../daemon-lock.js');
      const boom = new Error('boom');

      await withOwnLockHome(async (lockPath) => {
        await expect(withDaemonLock(1, async () => { throw boom; })).rejects.toBe(boom);
        expect(existsSync(lockPath)).toBe(false);
      });
    });
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

  /** No daemon runs; the one this run spawns is the one the state file names afterwards. */
  async function withFreshDaemon(): Promise<void> {
    await setupHappyMocks();
    const { checkStatus, readState, spawnDaemon } = await import('../daemon-manager.js');
    const spawned = daemonState({ syncCodeMieUrl: 'https://x.example.com' }) as Awaited<ReturnType<typeof spawnDaemon>>;
    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(spawnDaemon).mockResolvedValue(spawned);
    vi.mocked(readState).mockResolvedValue(spawned);
  }

  it('declined Claude Code analytics alongside another target: skips only that target, the daemon spawned with no identity', async () => {
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
    expect(vi.mocked(spawnDaemon).mock.calls[0][0]).not.toHaveProperty('clientType');
    expect(vi.mocked(spawnDaemon).mock.calls[0][0]).not.toHaveProperty('telemetryMode');
    expect(console_.log()).toHaveBeenCalledWith(expect.stringContaining('Claude Code analytics was not enabled.'));
    expect(process.exitCode).toBe(0);
  });

  it('prints the VS Code BYOK named key in setup step 4', async () => {
    await withFreshDaemon();
    const { writeVsCodeLanguageModelsConfig } = await import('../connectors/vscode.js');
    const { displaySetupInstructions } = await import('../../../../providers/integration/setup-ui.js');
    vi.mocked(writeVsCodeLanguageModelsConfig).mockResolvedValue({ configPath: '/vscode/models.json', requiresSecretConfiguration: true, modelCount: 5 });
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { vscode: true } });

    const instructions = vi.mocked(displaySetupInstructions).mock.calls[0][0].setupInstructions;
    expect(instructions).toContain('4. Enter API key: gk.vscode-byok\n');
  });

  it('asks to update the key VS Code already holds to the BYOK named key, unconditionally', async () => {
    await withFreshDaemon();
    const { writeVsCodeLanguageModelsConfig } = await import('../connectors/vscode.js');
    vi.mocked(writeVsCodeLanguageModelsConfig).mockResolvedValue({ configPath: '/vscode/models.json', requiresSecretConfiguration: false, modelCount: 5 });
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { vscode: true } });

    const printed = vi.mocked(console_.log()).mock.calls.map((call) => stripAnsi(String(call[0])));
    expect(printed).toContain(
      '  Update the key VS Code holds: open Chat: Manage Language Models, ' +
      'then right-click any CodeMie model → Update API Key and enter gk.vscode-byok.'
    );
  });

  describe('an older install first on PATH', () => {
    let installRoot: string;

    beforeEach(async () => {
      installRoot = await mkdtemp(join(tmpdir(), 'other-install-'));
    });

    afterEach(async () => {
      await rm(installRoot, { recursive: true, force: true });
    });

    /**
     * A CodeMie install of `version` laid out the way this platform's npm does it, and its shim: `bin/codemie`, a
     * symlink into its package; on win32 `codemie.cmd` in the prefix.
     */
    async function install(version: string): Promise<string> {
      const { symlink } = await import('node:fs/promises');
      const win32 = process.platform === 'win32';
      const pkg = win32
        ? join(installRoot, 'node_modules', '@codemieai', 'code')
        : join(installRoot, 'lib', 'node_modules', '@codemieai', 'code');
      await mkdir(join(pkg, 'bin'), { recursive: true });
      await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@codemieai/code', version }));
      await writeFile(join(pkg, 'bin', 'codemie.js'), '');
      if (win32) {
        const cmd = join(installRoot, 'codemie.cmd');
        await writeFile(cmd, NPM_WIN32_SHIMS['codemie.cmd']);
        return cmd;
      }
      await mkdir(join(installRoot, 'bin'), { recursive: true });
      const shim = join(installRoot, 'bin', 'codemie');
      await symlink(join(pkg, 'bin', 'codemie.js'), shim);
      return shim;
    }

    async function connectVscode(): Promise<string[]> {
      await withFreshDaemon();
      const { writeVsCodeLanguageModelsConfig } = await import('../connectors/vscode.js');
      vi.mocked(writeVsCodeLanguageModelsConfig).mockResolvedValue({ configPath: '/vscode/models.json', requiresSecretConfiguration: false, modelCount: 5 });
      const { connectTargets } = await import('../connect-orchestrator.js');
      await connectTargets({ targets: { vscode: true } });
      return vi.mocked(console_.log()).mock.calls.map((call) => stripAnsi(String(call[0])));
    }

    it('warns with its path and version after the targets, and the connect succeeds', async () => {
      const shim = await install('0.16.6');
      const { getCommandPath } = await import('@/utils/processes.js');
      vi.mocked(getCommandPath).mockResolvedValue(shim);

      const printed = await connectVscode();

      expect(printed).toContain(
        `Warning: an older CodeMie CLI is first on PATH: ${shim} (0.16.6). ` +
        'Its hooks start an older proxy, which can refuse the keys of the connected clients.'
      );
      expect(printed.findIndex((line) => line.startsWith('Warning: an older'))).toBeGreaterThan(
        printed.findIndex((line) => line.startsWith('✓ VS Code'))
      );
      expect(process.exitCode).toBe(0);
    });

    it('says nothing when the first codemie on PATH is this version', async () => {
      const shim = await install('0.17.0');
      const { getCommandPath } = await import('@/utils/processes.js');
      vi.mocked(getCommandPath).mockResolvedValue(shim);

      const printed = await connectVscode();

      expect(printed.some((line) => line.includes('older CodeMie CLI'))).toBe(false);
    });

    it('says nothing and connects when the PATH lookup fails', async () => {
      const { getCommandPath } = await import('@/utils/processes.js');
      vi.mocked(getCommandPath).mockRejectedValue(new Error('which failed'));

      const printed = await connectVscode();

      expect(printed.some((line) => line.includes('older CodeMie CLI'))).toBe(false);
      expect(process.exitCode).toBe(0);
    });
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
    expect(console_.log()).not.toHaveBeenCalledWith(expect.stringContaining('Targets configured'));
  });

  it('logs the named key it wrote into the Desktop config, not the shared one', async () => {
    await withFreshDaemon();
    const { readState, spawnDaemon } = await import('../daemon-manager.js');
    const spawned = daemonState({ syncCodeMieUrl: 'https://x.example.com', gatewayKey: 'codemie-proxy' }) as Awaited<ReturnType<typeof spawnDaemon>>;
    vi.mocked(spawnDaemon).mockResolvedValue(spawned);
    vi.mocked(readState).mockResolvedValue(spawned);
    const { writeDesktopConfig } = await import('../connectors/desktop.js');
    vi.mocked(writeDesktopConfig).mockResolvedValue('/desktop/config.json');
    const { logger } = await import('../../../../utils/logger.js');
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true } });

    // The logger receives the key masked: 'codemie-proxy.claude-desktop' → 'code...ktop [REDACTED]'.
    expect(info).toHaveBeenCalledWith(
      '[proxy] Claude Desktop proxy configuration written',
      expect.objectContaining({ inferenceGatewayApiKey: 'code...ktop [REDACTED]' })
    );
    info.mockRestore();
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

  it('all targets fail after another run replaced the daemon this run started → the rollback stops nothing, exit 1', async () => {
    await withFreshDaemon();
    const { readState, stopDaemon } = await import('../daemon-manager.js');
    const { writeDesktopConfig } = await import('../connectors/desktop.js');
    vi.mocked(writeDesktopConfig).mockRejectedValue(new Error('boom'));
    vi.mocked(readState).mockResolvedValue(daemonState({ pid: 4242 }) as Awaited<ReturnType<typeof readState>>);
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { claudeDesktop: true } });

    expect(process.exitCode).toBe(1);
    expect(stopDaemon).not.toHaveBeenCalled();
  });

  it('all targets fail while another process holds the daemon lock → warns, leaves the daemon running, exit 1', async () => {
    await withFreshDaemon();
    const { stopDaemon } = await import('../daemon-manager.js');
    const { writeDesktopConfig } = await import('../connectors/desktop.js');
    const { connectTargets } = await import('../connect-orchestrator.js');
    let clock: { mockRestore: () => void } | undefined;

    await withOwnLockHome(async (lockPath) => {
      vi.mocked(writeDesktopConfig).mockImplementation(async () => {
        await writeFile(lockPath, OTHER_LOCK_HOLDER);
        clock = advancingClock();
        throw new Error('boom');
      });
      try {
        await connectTargets({ targets: { claudeDesktop: true } });
      } finally {
        clock?.mockRestore();
        vi.mocked(writeDesktopConfig).mockReset();
      }
    });

    expect(process.exitCode).toBe(1);
    expect(stopDaemon).not.toHaveBeenCalled();
    expect(console_.log()).toHaveBeenCalledWith(expect.stringContaining('The proxy started by this run was left running.'));
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
    it('connect against a running matching daemon records the connection (profile + port)', async () => {
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
      expect(writeConnectionRecord).toHaveBeenCalledWith(matching, 'p', { port: 4001 });
    });

    it('a fresh spawn defers the write to after wiring (spawnDaemon told not to write)', async () => {
      await withFreshDaemon();
      const { spawnDaemon, writeConnectionRecord } = await import('../daemon-manager.js');
      const { writeDesktopConfig } = await import('../connectors/desktop.js');
      vi.mocked(writeDesktopConfig).mockResolvedValue('/desktop/config.json');
      const { connectTargets } = await import('../connect-orchestrator.js');

      await connectTargets({ targets: { claudeDesktop: true } });

      expect(spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({ writeRecord: false, recordPort: false }));
      expect(writeConnectionRecord).toHaveBeenCalledTimes(1);
      expect(writeConnectionRecord).toHaveBeenCalledWith(
        expect.objectContaining({ gatewayKey: 'gk' }),
        'p',
        { port: 4001 }
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
      expect(writeConnectionRecord).toHaveBeenCalledWith(expect.anything(), 'p', { port: 4001 });
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

  it('single successful target prints no per-target summary', async () => {
    await withFreshDaemon();
    const { writeVsCodeLanguageModelsConfig } = await import('../connectors/vscode.js');
    vi.mocked(writeVsCodeLanguageModelsConfig).mockResolvedValue({ configPath: '/vscode/models.json', requiresSecretConfiguration: false, modelCount: 5 });
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { vscode: true } });

    expect(process.exitCode).toBe(0);
    expect(console_.log()).not.toHaveBeenCalledWith(expect.stringContaining('Targets configured'));
    expect(writeVsCodeLanguageModelsConfig).toHaveBeenCalledWith('http://127.0.0.1:4001', 'gk', false, undefined);
  });

  it('prints only the success line after the proxy starts', async () => {
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

    const output = console_.log().mock.calls
      .flatMap(([message]) => stripAnsi(String(message)).split('\n'))
      .join('\n');
    expect(output).toContain('Claude Code Analytics configured successfully');
    for (const hidden of [
      'First-time setup',
      'restart',
      'Analytics Configuration',
      'Targets configured',
      '│',
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
  });

  describe('Claude Code analytics display wiring', () => {
    async function connectAndCapture(configOverrides: Record<string, unknown>): Promise<{
      promptArgs: Record<string, unknown>;
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
      return { promptArgs };
    }

    it('passes the profile name and the matching-origin CodeMie URL to the prompt', async () => {
      const { promptArgs } = await connectAndCapture({
        name: 'work',
        baseUrl: 'https://x.example.com/api',
        codeMieUrl: 'https://x.example.com/ui',
      });

      expect(promptArgs).toEqual(expect.objectContaining({
        profile: 'work',
        codeMieUrl: 'https://x.example.com/ui',
      }));
    });

    it('passes the baseUrl origin to the prompt when the workspace CodeMie URL has a different origin', async () => {
      const { promptArgs } = await connectAndCapture({
        name: 'work',
        baseUrl: 'https://api.example.com/code-assistant-api',
        codeMieUrl: 'https://other.example.com',
      });

      expect(promptArgs).toEqual(expect.objectContaining({
        profile: 'work',
        codeMieUrl: 'https://api.example.com',
      }));
    });

    it('passes an undefined CodeMie URL to the prompt when none is configured, still naming the profile', async () => {
      const { promptArgs } = await connectAndCapture({
        name: 'work',
        codeMieUrl: undefined,
      });

      expect(promptArgs.profile).toBe('work');
      expect(promptArgs.codeMieUrl).toBeUndefined();
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

describe('connectTargets — the other clients moved off the shared key', () => {
  let console_: ReturnType<typeof spyConsole>;
  const recordPath = (): string => join(clientHome, 'proxy-connection.json');
  const vscodeSettingsPath = async (): Promise<string> => {
    const { getVsCodeProductDir } = await import('../connectors/vscode.js');
    return join(getVsCodeProductDir(false), 'User', 'settings.json');
  };
  const codexConfigPath = (): string => join(clientHome, '.codex', 'config.toml');

  async function writeAt(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }

  const vscodeSettings = (token: string, port = 4001): string => JSON.stringify({ 'claudeCode.environmentVariables': [
    { name: 'ANTHROPIC_BASE_URL', value: `http://127.0.0.1:${port}` },
    { name: 'ANTHROPIC_AUTH_TOKEN', value: token },
  ] }, null, '\t');

  const codexConfig = (authorization: string, port = 4001): string => [
    '# >>> codemie proxy connect (codex-desktop) header - managed block, do not edit',
    'model_provider = "codemie"',
    'model = "gpt-5.4"',
    '# <<< codemie proxy connect (codex-desktop) header',
    '',
    '# >>> codemie proxy connect (codex-desktop) provider - managed block, do not edit',
    '[model_providers.codemie]',
    'name = "CodeMie"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'wire_api = "responses"',
    '[model_providers.codemie.http_headers]',
    `Authorization = "${authorization}"`,
    '# <<< codemie proxy connect (codex-desktop) provider',
    '',
  ].join('\n');

  const desktopEntryPath = async (): Promise<string> => {
    const { getClaudeDesktopBaseDir } = await import('@/telemetry/clients/claude-desktop/claude-desktop.paths.js');
    return join(getClaudeDesktopBaseDir(), 'configLibrary', 'cfg.json');
  };

  const desktopEntry = (apiKey: string, port = 4001): string => JSON.stringify({
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: `http://127.0.0.1:${port}`,
    inferenceGatewayApiKey: apiKey,
  });

  async function writeDesktopGatewayConfig(apiKey: string, port = 4001): Promise<void> {
    const entryPath = await desktopEntryPath();
    await writeAt(join(dirname(entryPath), '_meta.json'), JSON.stringify({ appliedId: 'cfg' }));
    await writeAt(entryPath, desktopEntry(apiKey, port));
  }

  async function readDesktopKey(): Promise<unknown> {
    return (JSON.parse(await readFile(await desktopEntryPath(), 'utf-8')) as Record<string, unknown>).inferenceGatewayApiKey;
  }

  /** Desktop's config library the user cannot write, so its applied entry cannot be replaced; given back writable for the cleanup. */
  async function readOnlyDesktopLibrary(fn: () => Promise<void>): Promise<void> {
    await chmod(dirname(await desktopEntryPath()), 0o555);
    try {
      await fn();
    } finally {
      await chmod(dirname(await desktopEntryPath()), 0o755);
    }
  }

  const DESKTOP_MOVED = '✓ Claude Desktop moved to its own key — Restart Claude Desktop to apply changes.';

  async function writeByokConfig(): Promise<void> {
    const { getVsCodeProductDir } = await import('../connectors/vscode.js');
    await writeAt(join(getVsCodeProductDir(false), 'User', 'chatLanguageModels.json'), JSON.stringify([{
      name: 'CodeMie',
      vendor: 'customendpoint',
      models: [{ id: 'claude-sonnet-4-6', url: 'http://127.0.0.1:4001/v1/chat/completions' }],
    }]));
  }

  async function installOmpExtension(): Promise<void> {
    await writeAt(join(clientHome, '.omp', 'agent', 'extensions', 'codemie-models.js'), '// codemie-managed: 0.16.0\n');
  }

  const record = (identity: Record<string, string>): Record<string, unknown> => ({
    version: 1,
    profile: 'p',
    port: 4001,
    ...identity,
    updatedAt: '2026-11-17T00:00:00.000Z',
  });

  async function readRecord(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(recordPath(), 'utf-8')) as Record<string, unknown>;
  }

  const printed = (): string[] => vi.mocked(console_.log()).mock.calls.map((call) => stripAnsi(String(call[0])));

  /** A Codex config directory the user cannot write into; given back writable for the cleanup. */
  async function readOnlyCodexDir(fn: () => Promise<void>): Promise<void> {
    await chmod(dirname(codexConfigPath()), 0o555);
    try {
      await fn();
    } finally {
      await chmod(dirname(codexConfigPath()), 0o755);
    }
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('CODEMIE_HOME', clientHome);
    process.exitCode = 0;
    console_ = spyConsole();
    await setupHappyMocks();
    const daemon = await import('../daemon-manager.js');
    const actual = await vi.importActual<typeof import('../daemon-manager.js')>('../daemon-manager.js');
    const spawned = daemonState({ syncCodeMieUrl: 'https://x.example.com' }) as Awaited<ReturnType<typeof daemon.spawnDaemon>>;
    vi.mocked(daemon.checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(daemon.spawnDaemon).mockResolvedValue(spawned);
    vi.mocked(daemon.readState).mockResolvedValue(spawned);
    vi.mocked(daemon.writeConnectionRecord).mockResolvedValue(true);
    vi.mocked(daemon.readConnectionRecord).mockImplementation(() => actual.readConnectionRecord(recordPath()));
    vi.mocked(daemon.clearLegacyClientIdentity).mockImplementation(() => actual.clearLegacyClientIdentity(recordPath()));
    vi.mocked(daemon.hasLegacyClientIdentity).mockImplementation(() => actual.hasLegacyClientIdentity(recordPath()));
    const { writeDesktopConfig } = await import('../connectors/desktop.js');
    vi.mocked(writeDesktopConfig).mockResolvedValue('/desktop/config.json');
    const { writeOmpExtension } = await import('../connectors/omp.js');
    vi.mocked(writeOmpExtension).mockResolvedValue({ path: '/omp/codemie-models.js', changed: true });
    // The Codex connect lists its models through the proxy.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      { deployment_name: 'gpt-5.4', base_name: 'gpt-5.4', label: 'GPT 5.4', enabled: true },
    ]))));
  });

  afterEach(async () => {
    console_.restore();
    process.exitCode = 0;
    vi.unstubAllGlobals();
    const daemon = await import('../daemon-manager.js');
    vi.mocked(daemon.readConnectionRecord).mockReset();
    vi.mocked(daemon.clearLegacyClientIdentity).mockReset();
    vi.mocked(daemon.hasLegacyClientIdentity).mockReset();
  });

  async function connect(targets: ConnectOptions['targets'], force = false): Promise<void> {
    const { connectTargets } = await import('../connect-orchestrator.js');
    await connectTargets({ targets, force });
  }

  it('--claude-desktop moves Codex and the VS Code Claude Code extension to their named keys, each named with its hint', async () => {
    await writeAt(codexConfigPath(), codexConfig('Bearer gk'));
    await writeAt(await vscodeSettingsPath(), vscodeSettings('gk'));

    await connect({ claudeDesktop: true });

    expect(await readFile(codexConfigPath(), 'utf-8')).toBe(codexConfig('Bearer gk.codex-desktop'));
    expect(await readFile(await vscodeSettingsPath(), 'utf-8')).toBe(vscodeSettings('gk.vscode-claude-code'));
    expect(printed()).toEqual(expect.arrayContaining([
      '✓ VS Code Claude Code extension moved to its own key — Reload VS Code to apply changes.',
      '✓ Codex desktop moved to its own key — Quit and reopen the ChatGPT desktop app to apply the change.',
    ]));
    expect(process.exitCode).toBe(0);
  });

  it('--claude-desktop leaves and does not name a Codex config and VS Code settings with the shared key on another loopback port', async () => {
    await writeAt(codexConfigPath(), codexConfig('Bearer gk', 4002));
    await writeAt(await vscodeSettingsPath(), vscodeSettings('gk', 4002));

    await connect({ claudeDesktop: true });

    expect(await readFile(codexConfigPath(), 'utf-8')).toBe(codexConfig('Bearer gk', 4002));
    expect(await readFile(await vscodeSettingsPath(), 'utf-8')).toBe(vscodeSettings('gk', 4002));
    expect(printed().some((line) => line.includes('moved to its own key'))).toBe(false);
  });

  it('--codex-desktop writes the Codex config by its own connect, and the pass does not name it', async () => {
    await writeAt(codexConfigPath(), codexConfig('Bearer gk'));

    await connect({ codexDesktop: true }, true);

    expect(await readFile(codexConfigPath(), 'utf-8')).toContain('Authorization = "Bearer gk.codex-desktop"');
    expect(printed()).toContain('✓ Codex Desktop configured (model: gpt-5.4)');
    expect(printed().some((line) => line.includes('Codex desktop moved'))).toBe(false);
  });

  it('writes no config of another client when every target failed', async () => {
    const { writeDesktopConfig } = await import('../connectors/desktop.js');
    vi.mocked(writeDesktopConfig).mockRejectedValue(new Error('boom'));
    await writeAt(codexConfigPath(), codexConfig('Bearer gk'));
    await writeAt(await vscodeSettingsPath(), vscodeSettings('gk'));

    await connect({ claudeDesktop: true });

    expect(await readFile(codexConfigPath(), 'utf-8')).toBe(codexConfig('Bearer gk'));
    expect(await readFile(await vscodeSettingsPath(), 'utf-8')).toBe(vscodeSettings('gk'));
    expect(process.exitCode).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('warns once for a Codex config it cannot write, still moves the other client, the exit code unchanged', async () => {
    if (process.getuid?.() === 0) return; // root bypasses file-mode permission checks; nothing to assert here.
    await writeAt(codexConfigPath(), codexConfig('Bearer gk'));
    await writeAt(await vscodeSettingsPath(), vscodeSettings('gk'));

    await readOnlyCodexDir(() => connect({ claudeDesktop: true }));

    expect(await readFile(codexConfigPath(), 'utf-8')).toBe(codexConfig('Bearer gk'));
    expect(await readFile(await vscodeSettingsPath(), 'utf-8')).toBe(vscodeSettings('gk.vscode-claude-code'));
    expect(printed().filter((line) => line.includes('Codex desktop'))).toEqual([
      expect.stringMatching(/^Warning: could not move Codex desktop to its own key: .*EACCES/),
    ]);
    expect(process.exitCode).toBe(0);
  });

  it('leaves and does not name a config holding a key the proxy refuses', async () => {
    await writeAt(codexConfigPath(), codexConfig('Bearer other-key'));

    await connect({ claudeDesktop: true });

    expect(await readFile(codexConfigPath(), 'utf-8')).toBe(codexConfig('Bearer other-key'));
    expect(printed().some((line) => line.includes('Codex desktop'))).toBe(false);
  });

  it('leaves a Codex config that is a symbolic link, naming the command that connects it', async () => {
    const target = join(clientHome, 'dotfiles-config.toml');
    await writeAt(target, codexConfig('Bearer gk'));
    await mkdir(dirname(codexConfigPath()), { recursive: true });
    await symlink(target, codexConfigPath());

    await connect({ claudeDesktop: true });

    expect(await readFile(target, 'utf-8')).toBe(codexConfig('Bearer gk'));
    expect(printed()).toContain(
      '  Codex desktop left on the shared key: its config is a symbolic link — run: codemie proxy connect --codex-desktop'
    );
  });

  it('--vscode-claude-code --insiders moves the stable VS Code settings to the named key', async () => {
    const { writeVsCodeClaudeCodeConfig } = await import('../connectors/vscode-claude-code.js');
    vi.mocked(writeVsCodeClaudeCodeConfig).mockResolvedValue({ written: true, path: '/vscode-insiders/settings.json' });
    await writeAt(await vscodeSettingsPath(), vscodeSettings('gk'));

    const { connectTargets } = await import('../connect-orchestrator.js');
    await connectTargets({ targets: { vscodeClaudeCode: true }, insiders: true });

    expect(await readFile(await vscodeSettingsPath(), 'utf-8')).toBe(vscodeSettings('gk.vscode-claude-code'));
    expect(printed()).toContain('✓ VS Code Claude Code extension moved to its own key — Reload VS Code to apply changes.');
    expect(printed().some((line) => line.includes('VS Code Insiders Claude Code extension moved'))).toBe(false);
  });

  it('--claude-desktop moves the VS Code Insiders settings to the named key', async () => {
    const { getVsCodeProductDir } = await import('../connectors/vscode.js');
    const insidersSettingsPath = join(getVsCodeProductDir(true), 'User', 'settings.json');
    await writeAt(insidersSettingsPath, vscodeSettings('gk'));

    await connect({ claudeDesktop: true });

    expect(await readFile(insidersSettingsPath, 'utf-8')).toBe(vscodeSettings('gk.vscode-claude-code'));
    expect(printed()).toContain(
      '✓ VS Code Insiders Claude Code extension moved to its own key — Reload VS Code to apply changes.'
    );
  });

  describe('Claude Desktop while the record holds the older CLI\'s identity', () => {
    const LEGACY = { clientType: 'claude-desktop' };

    it.each([
      ['a sealed key', '__sealed__:v1:QUJD'],
      ['the plain shared key', 'gk'],
    ])('--codex-desktop moves Desktop\'s entry on the daemon\'s port with %s to its named key', async (_case, key) => {
      await writeAt(recordPath(), JSON.stringify(record(LEGACY)));
      await writeDesktopGatewayConfig(key);

      await connect({ codexDesktop: true }, true);

      expect(await readDesktopKey()).toBe('gk.claude-desktop');
      expect(printed()).toContain(DESKTOP_MOVED);
      expect(process.exitCode).toBe(0);
    });

    it.each([
      ['a sealed key', '__sealed__:v1:QUJD'],
      ['the plain shared key', 'gk'],
    ])('leaves Desktop\'s entry with %s and a record that holds neither field', async (_case, key) => {
      await writeAt(recordPath(), JSON.stringify(record({})));
      await writeDesktopGatewayConfig(key);

      await connect({ codexDesktop: true }, true);

      expect(await readFile(await desktopEntryPath(), 'utf-8')).toBe(desktopEntry(key));
      expect(printed().some((line) => line.includes('Claude Desktop moved'))).toBe(false);
    });

    it('--claude-desktop leaves Desktop\'s entry to its own connect', async () => {
      await writeAt(recordPath(), JSON.stringify(record(LEGACY)));
      await writeDesktopGatewayConfig('__sealed__:v1:QUJD');

      await connect({ claudeDesktop: true });

      expect(await readFile(await desktopEntryPath(), 'utf-8')).toBe(desktopEntry('__sealed__:v1:QUJD'));
      expect(printed().some((line) => line.includes('Claude Desktop moved'))).toBe(false);
    });

    it('leaves Desktop\'s entry when every target failed', async () => {
      const { writeVsCodeClaudeCodeConfig } = await import('../connectors/vscode-claude-code.js');
      vi.mocked(writeVsCodeClaudeCodeConfig).mockRejectedValue(new Error('boom'));
      await writeAt(recordPath(), JSON.stringify(record(LEGACY)));
      await writeDesktopGatewayConfig('__sealed__:v1:QUJD');

      await connect({ vscodeClaudeCode: true });

      expect(await readFile(await desktopEntryPath(), 'utf-8')).toBe(desktopEntry('__sealed__:v1:QUJD'));
      expect(process.exitCode).toBe(1);
    });

    it.each([
      ['Desktop\'s own named key in plain', 'gk.claude-desktop', 4001],
      ['a sealed key on another loopback port', '__sealed__:v1:QUJD', 4002],
    ])('leaves and does not name an entry with %s', async (_case, key, port) => {
      await writeAt(recordPath(), JSON.stringify(record(LEGACY)));
      await writeDesktopGatewayConfig(key, port);

      await connect({ codexDesktop: true }, true);

      expect(await readFile(await desktopEntryPath(), 'utf-8')).toBe(desktopEntry(key, port));
      expect(printed().some((line) => line.includes('Claude Desktop'))).toBe(false);
    });

    it.skipIf(process.platform === 'win32')('warns once for a Desktop entry it cannot write, still moves the other client, the exit code unchanged', async () => {
      if (process.getuid?.() === 0) return; // root bypasses file-mode permission checks; nothing to assert here.
      await writeAt(recordPath(), JSON.stringify(record(LEGACY)));
      await writeDesktopGatewayConfig('__sealed__:v1:QUJD');
      await writeAt(await vscodeSettingsPath(), vscodeSettings('gk'));

      await readOnlyDesktopLibrary(() => connect({ codexDesktop: true }, true));

      expect(await readFile(await desktopEntryPath(), 'utf-8')).toBe(desktopEntry('__sealed__:v1:QUJD'));
      expect(await readFile(await vscodeSettingsPath(), 'utf-8')).toBe(vscodeSettings('gk.vscode-claude-code'));
      expect(printed().filter((line) => line.includes('Claude Desktop'))).toEqual([
        expect.stringMatching(/^Warning: could not move Claude Desktop to its own key: .*EACCES/),
      ]);
      expect(process.exitCode).toBe(0);
    });
  });

  describe('the older CLI\'s identity in the record', () => {
    const DESKTOP_IDENTITY = { clientType: 'claude-desktop', telemetryMode: 'claude-desktop' };

    it('is removed after --claude-desktop moved the Codex config off the shared key', async () => {
      await writeAt(recordPath(), JSON.stringify(record(DESKTOP_IDENTITY)));
      await writeAt(codexConfigPath(), codexConfig('Bearer gk'));

      await connect({ claudeDesktop: true });

      expect(await readFile(codexConfigPath(), 'utf-8')).toBe(codexConfig('Bearer gk.codex-desktop'));
      expect(await readRecord()).toEqual(record({}));
    });

    it('is removed for a record with the Desktop telemetryMode and no clientType after --claude-desktop', async () => {
      await writeAt(recordPath(), JSON.stringify(record({ telemetryMode: 'claude-desktop' })));

      await connect({ claudeDesktop: true });

      expect(await readRecord()).toEqual(record({}));
    });

    it('is removed after --claude-desktop with Desktop\'s config on a local gateway', async () => {
      await writeAt(recordPath(), JSON.stringify(record(DESKTOP_IDENTITY)));
      await writeDesktopGatewayConfig('gk');

      await connect({ claudeDesktop: true });

      expect(await readRecord()).toEqual(record({}));
    });

    it('is removed for a vscode-byok record after --vscode, the BYOK named key printed', async () => {
      const { writeVsCodeLanguageModelsConfig } = await import('../connectors/vscode.js');
      vi.mocked(writeVsCodeLanguageModelsConfig).mockResolvedValue({ configPath: '/vscode/models.json', requiresSecretConfiguration: false, modelCount: 5 });
      await writeAt(recordPath(), JSON.stringify(record({ clientType: 'vscode-byok' })));

      await connect({ vscode: true });

      expect(await readRecord()).toEqual(record({}));
      expect(printed()).toContain(
        '  Update the key VS Code holds: open Chat: Manage Language Models, ' +
        'then right-click any CodeMie model → Update API Key and enter gk.vscode-byok.'
      );
      expect(process.exitCode).toBe(0);
    });

    it('is removed for a codex-desktop record after --codex-desktop with no Desktop config', async () => {
      await writeAt(recordPath(), JSON.stringify(record({ clientType: 'codex-desktop' })));

      await connect({ codexDesktop: true }, true);

      expect(await readRecord()).toEqual(record({}));
    });

    it('is removed for a codex-desktop record after --codex-desktop --omp with an oh-my-pi extension installed', async () => {
      await writeAt(recordPath(), JSON.stringify(record({ clientType: 'codex-desktop' })));
      await installOmpExtension();

      await connect({ codexDesktop: true, omp: true }, true);

      expect(await readRecord()).toEqual(record({}));
    });

    it.each([
      ['a claude-desktop record, --codex-desktop, Desktop\'s entry sealed on the daemon\'s port: Desktop moved',
        DESKTOP_IDENTITY, { codexDesktop: true }, () => writeDesktopGatewayConfig('__sealed__:v1:QUJD')],
      ['a codex-desktop record, --codex-desktop, Desktop\'s entry with the plain shared key: Desktop moved',
        { clientType: 'codex-desktop' }, { codexDesktop: true }, () => writeDesktopGatewayConfig('gk')],
      ['a codex-desktop record, --codex-desktop, Desktop\'s entry on the daemon\'s port with its own named key in plain',
        { clientType: 'codex-desktop' }, { codexDesktop: true }, () => writeDesktopGatewayConfig('gk.claude-desktop')],
      ['a codex-desktop record, --codex-desktop, Desktop\'s entry holding a key the proxy refuses',
        { clientType: 'codex-desktop' }, { codexDesktop: true }, () => writeDesktopGatewayConfig('other-key')],
      ['a codex-desktop record, --codex-desktop, Desktop\'s entry holding another client\'s named key in plain',
        { clientType: 'codex-desktop' }, { codexDesktop: true }, () => writeDesktopGatewayConfig('gk.codex-desktop')],
      ['a claude-desktop record, --codex-desktop, no other client config',
        DESKTOP_IDENTITY, { codexDesktop: true }, async () => undefined],
      ['a record whose clientType names no client (claude-code-otlp), --omp',
        { clientType: 'claude-code-otlp' }, { omp: true }, async () => undefined],
      ['a record with telemetryMode none alone, --codex-desktop',
        { telemetryMode: 'none' }, { codexDesktop: true }, async () => undefined],
    ] as const)('is removed for %s', async (_case, identity, targets, arrange) => {
      await writeAt(recordPath(), JSON.stringify(record(identity)));
      await arrange();

      await connect({ ...targets }, true);

      expect(await readRecord()).toEqual(record({}));
    });

    it.skipIf(process.platform === 'win32')('is kept, with its warning line, when the pass failed to write Desktop\'s sealed entry', async () => {
      if (process.getuid?.() === 0) return; // root bypasses file-mode permission checks; nothing to assert here.
      await writeAt(recordPath(), JSON.stringify(record(DESKTOP_IDENTITY)));
      await writeDesktopGatewayConfig('__sealed__:v1:QUJD');

      await readOnlyDesktopLibrary(() => connect({ codexDesktop: true }, true));

      expect(await readRecord()).toEqual(record(DESKTOP_IDENTITY));
      expect(printed()).toEqual(expect.arrayContaining([
        expect.stringMatching(/^Warning: could not move Claude Desktop to its own key: .*EACCES/),
      ]));
    });

    it.skipIf(process.platform === 'win32')('is kept for a claude-desktop record, --claude-desktop, a Codex config the pass failed to write', async () => {
      if (process.getuid?.() === 0) return; // root bypasses file-mode permission checks; nothing to assert here.
      await writeAt(recordPath(), JSON.stringify(record(DESKTOP_IDENTITY)));
      await writeAt(codexConfigPath(), codexConfig('Bearer gk'));

      await readOnlyCodexDir(() => connect({ claudeDesktop: true }, true));

      expect(await readRecord()).toEqual(record(DESKTOP_IDENTITY));
    });

    it.each([
      ['a codex-desktop record, --codex-desktop, Desktop\'s entry sealed on another loopback port',
        { clientType: 'codex-desktop' }, { codexDesktop: true }, () => writeDesktopGatewayConfig('__sealed__:v1:QUJD', 4002)],
      ['a codex-desktop record, --codex-desktop, Desktop\'s entry with the plain shared key on another loopback port',
        { clientType: 'codex-desktop' }, { codexDesktop: true }, () => writeDesktopGatewayConfig('gk', 4002), 'gk'],
      ['a codex-desktop record, --codex-desktop, a VS Code BYOK config pointing at the proxy',
        { clientType: 'codex-desktop' }, { codexDesktop: true }, writeByokConfig],
      ['a codex-desktop record, --codex-desktop, an oh-my-pi extension installed',
        { clientType: 'codex-desktop' }, { codexDesktop: true }, installOmpExtension],
      ['a claude-desktop record, --claude-desktop, Desktop\'s own write failed',
        DESKTOP_IDENTITY, { claudeDesktop: true }, async () => {
          const { writeDesktopConfig } = await import('../connectors/desktop.js');
          vi.mocked(writeDesktopConfig).mockRejectedValue(new Error('disk full'));
        }],
    ] as const)('is kept for %s', async (_case, identity, targets, arrange, desktopKey?: string) => {
      await writeAt(recordPath(), JSON.stringify(record(identity)));
      await arrange();

      await connect({ ...targets }, true);

      expect(await readRecord()).toEqual(record(identity));
      if (desktopKey !== undefined) expect(await readDesktopKey()).toBe(desktopKey);
    });
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

  it('a cold start leaves a Codex config and a Desktop entry holding the shared key and the record\'s older identity as they are', async () => {
    const legacy = { version: 1, profile: 'p', clientType: 'claude-desktop', telemetryMode: 'claude-desktop', updatedAt: '' };
    const recordPath = join(clientHome, 'proxy-connection.json');
    const codexPath = join(clientHome, '.codex', 'config.toml');
    const codex = [
      '# >>> codemie proxy connect (codex-desktop) provider - managed block, do not edit',
      '[model_providers.codemie]',
      'base_url = "http://127.0.0.1:4001/v1"',
      '[model_providers.codemie.http_headers]',
      'Authorization = "Bearer gk"',
      '# <<< codemie proxy connect (codex-desktop) provider',
      '',
    ].join('\n');
    await mkdir(dirname(codexPath), { recursive: true });
    await writeFile(codexPath, codex);
    await writeFile(recordPath, JSON.stringify(legacy));
    const { getClaudeDesktopBaseDir } = await import('@/telemetry/clients/claude-desktop/claude-desktop.paths.js');
    const desktopLib = join(getClaudeDesktopBaseDir(), 'configLibrary');
    const desktopEntry = JSON.stringify({
      inferenceProvider: 'gateway', inferenceGatewayBaseUrl: 'http://127.0.0.1:4001', inferenceGatewayApiKey: 'gk',
    });
    await mkdir(desktopLib, { recursive: true });
    await writeFile(join(desktopLib, '_meta.json'), JSON.stringify({ appliedId: 'cfg' }));
    await writeFile(join(desktopLib, 'cfg.json'), desktopEntry);
    const s = await arrange(legacy);
    const actual = await vi.importActual<typeof import('../daemon-manager.js')>('../daemon-manager.js');
    vi.mocked(s.daemon.clearLegacyClientIdentity).mockImplementation(() => actual.clearLegacyClientIdentity(recordPath));
    vi.mocked(s.daemon.hasLegacyClientIdentity).mockImplementation(() => actual.hasLegacyClientIdentity(recordPath));

    await s.ensureOtlpProxy(AGENT);

    expect(s.daemon.spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({ profile: 'p' }));
    expect(await readFile(codexPath, 'utf-8')).toBe(codex);
    expect(await readFile(join(desktopLib, 'cfg.json'), 'utf-8')).toBe(desktopEntry);
    expect(await readFile(recordPath, 'utf-8')).toBe(JSON.stringify(legacy));
    vi.mocked(s.daemon.clearLegacyClientIdentity).mockReset();
    vi.mocked(s.daemon.hasLegacyClientIdentity).mockReset();
  });

  describe('with no recorded connection and no live daemon', () => {
    it('falls back to the working directory profile with no identity, creating the record', async () => {
      const s = await arrange(null, undefined, undefined, { name: 'work' });
      vi.mocked(s.ConfigLoader.getActiveProfileName).mockResolvedValue('work');

      await expect(s.ensureOtlpProxy(AGENT)).resolves.toBeUndefined();

      expect(s.ConfigLoader.load).toHaveBeenCalledWith(process.cwd(), { name: 'work' });
      expect(s.daemon.spawnDaemon).toHaveBeenCalledTimes(1);
      const [spawned] = vi.mocked(s.daemon.spawnDaemon).mock.calls[0];
      expect(spawned).toMatchObject({ profile: 'work', project: 'proj' });
      expect(spawned).not.toHaveProperty('clientType');
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
      expect(s.daemon.spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({ profile: 'work' }));
      expect(warnings(s.warn)).toEqual([
        expect.stringContaining("No SSO credentials found for profile 'work'"),
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
    expect(s.daemon.spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({ profile: 'p' }));
    expect(warnings(s.warn)).toEqual([expect.stringContaining("No SSO credentials found for profile 'p'")]);
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
    }));
    expect(vi.mocked(s.daemon.spawnDaemon).mock.calls[0][0]).not.toHaveProperty('clientType');
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

  it.each([
    ['a client type', { clientType: 'copilot-cli-otlp' }],
    ['a telemetry mode', { telemetryMode: 'claude-desktop' }],
    ['no identity', {}],
  ])('spawns the recorded profile with no identity when the record holds %s', async (_label, identity) => {
    const s = await arrange({ version: 1, profile: 'p', updatedAt: '', ...identity });

    await s.ensureOtlpProxy(AGENT);

    const [spawned] = vi.mocked(s.daemon.spawnDaemon).mock.calls[0];
    expect(spawned.profile).toBe('p');
    expect(spawned).not.toHaveProperty('clientType');
    expect(spawned).not.toHaveProperty('telemetryMode');
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

  it('waits for the lock and adopts the daemon the holder started meanwhile (a restart), stopping nothing', async () => {
    const s = await arrange();
    const cameUp = daemonState({ profile: 'other' }) as Awaited<ReturnType<typeof s.daemon.readState>>;
    const lockAtRead: unknown[] = [];

    await withOwnLockHome(async (lockPath) => {
      vi.mocked(s.daemon.readState).mockImplementation(async () => {
        lockAtRead.push(await readFile(lockPath, 'utf-8').then((raw) => JSON.parse(raw), () => null));
        return lockAtRead.length === 1 ? null : cameUp;
      });
      await s.ensureOtlpProxy(AGENT);
    });

    // The first read is lock-free; the second runs while this process holds the daemon lock.
    expect(lockAtRead).toEqual([null, expect.objectContaining({ pid: process.pid })]);
    expect(s.daemon.seedConnectionRecord).toHaveBeenCalledWith(cameUp);
    expect(s.daemon.spawnDaemon).not.toHaveBeenCalled();
    expect(s.daemon.stopDaemon).not.toHaveBeenCalled();
  });

  it('reuses the daemon a start that timed out left behind, once a later start finds it alive and matching', async () => {
    const s = await arrange();
    vi.mocked(s.daemon.spawnDaemon).mockRejectedValueOnce(new Error('Daemon failed to start within 5 seconds'));
    await expect(s.ensureOtlpProxy(AGENT)).rejects.toThrow('Daemon failed to start within 5 seconds');

    // The child wrote its state after the ready wait: the next start's status read under the lock finds it.
    const late = matchingDesktopState() as Awaited<ReturnType<typeof s.daemon.checkStatus>>['state'];
    vi.mocked(s.daemon.checkStatus).mockResolvedValue({ running: true, state: late });
    await s.ensureOtlpProxy(AGENT);

    expect(s.daemon.spawnDaemon).toHaveBeenCalledTimes(1);
    expect(s.daemon.stopDaemon).not.toHaveBeenCalled();
    expect(s.daemon.seedConnectionRecord).toHaveBeenCalledWith(late);
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

  it('adopts a daemon an older install\'s hook started after the lock was taken, through ensureDaemon', async () => {
    const s = await arrange();
    const cameUp = daemonState({ version: undefined, profile: 'other' }) as Awaited<ReturnType<typeof s.daemon.checkStatus>>['state'];
    vi.mocked(s.daemon.checkStatus).mockResolvedValue({ running: true, state: cameUp });

    await s.ensureOtlpProxy(AGENT);

    expect(s.daemon.seedConnectionRecord).toHaveBeenCalledWith(cameUp);
    expect(s.daemon.spawnDaemon).not.toHaveBeenCalled();
    expect(s.daemon.stopDaemon).not.toHaveBeenCalled();
  });

  it('adopts a live daemon of the same version and another project without taking the lock', async () => {
    const s = await arrange();
    const live = daemonState({ project: 'other' }) as Awaited<ReturnType<typeof s.daemon.readState>>;
    vi.mocked(s.daemon.readState).mockResolvedValue(live);

    await withOwnLockHome(async (lockPath) => {
      // A start that took the lock would wait for this holder and fail at its budget.
      await writeFile(lockPath, OTHER_LOCK_HOLDER);
      const clock = advancingClock();
      try {
        await expect(s.ensureOtlpProxy(AGENT)).resolves.toBeUndefined();
      } finally {
        clock.mockRestore();
      }
    });

    expect(s.daemon.seedConnectionRecord).toHaveBeenCalledWith(live);
    expect(s.daemon.stopDaemon).not.toHaveBeenCalled();
    expect(s.daemon.spawnDaemon).not.toHaveBeenCalled();
  });

  describe('a start from the daemon\'s own state', () => {
    /** The state a daemon of an older CLI left: every value a start must keep. */
    const OLDER = {
      version: '0.16.0',
      port: 52311,
      url: 'http://127.0.0.1:52311',
      project: 'B',
      projectBinding: 'local',
      gatewayKey: 'k',
      model: 'm2',
      targetUrl: 'https://t2',
      provider: 'x',
      syncApiUrl: 'https://s2',
      syncCodeMieUrl: 'https://c2',
    };
    const FROM_STATE = {
      targetUrl: 'https://t2',
      provider: 'x',
      profile: 'p',
      gatewayKey: 'k',
      model: 'm2',
      project: 'B',
      projectBinding: 'local',
      syncApiUrl: 'https://s2',
      syncCodeMieUrl: 'https://c2',
      writeRecord: false,
    };

    /** A hook run in a directory whose config names project C and model m-dir. */
    async function arrangeState(state: Record<string, unknown>, record: Record<string, unknown> | null = { version: 1, profile: 'p', updatedAt: '' }) {
      const s = await arrange(record, { name: 'p' }, {}, { codeMieProject: 'C', model: 'm-dir' });
      vi.mocked(s.daemon.readState).mockResolvedValue(daemonState(state) as Awaited<ReturnType<typeof s.daemon.readState>>);
      vi.mocked(s.daemon.spawnDaemon).mockResolvedValue(daemonState({ port: 52400, url: 'http://127.0.0.1:52400' }) as Awaited<ReturnType<typeof s.daemon.spawnDaemon>>);
      return s;
    }

    it.each([
      ['a live daemon of an older CLI', {}],
      ['a daemon that is no longer alive', { pid: 9999999, version: '0.17.0' }],
    ])('brings back %s with every value of its state on the recorded port, never the directory\'s project', async (_label, extra) => {
      const s = await arrangeState({ ...OLDER, ...extra }, { version: 1, profile: 'p', updatedAt: '', port: 52400 });
      const { refreshClaudeCodeOtlpEndpoint } = await import('../connectors/claude-code-otlp-endpoint.js');

      await s.ensureOtlpProxy(AGENT);

      expect(vi.mocked(s.daemon.spawnDaemon).mock.calls[0][0]).toEqual({ ...FROM_STATE, port: 52400 });
      expect(s.ConfigLoader.load).not.toHaveBeenCalled();
      expect(s.daemon.writeConnectionRecord).not.toHaveBeenCalled();
      expect(refreshClaudeCodeOtlpEndpoint).toHaveBeenCalledWith(expect.objectContaining({ port: 52400 }));
    });

    it('starts from the state of a daemon that died between the lock-free read and the lock', async () => {
      const s = await arrangeState(OLDER);
      // The lock-free read sees it alive; every read under the lock finds the same state with its process gone.
      vi.mocked(s.daemon.readState)
        .mockResolvedValueOnce(daemonState(OLDER) as Awaited<ReturnType<typeof s.daemon.readState>>)
        .mockResolvedValue(daemonState({ ...OLDER, pid: 9999999 }) as Awaited<ReturnType<typeof s.daemon.readState>>);

      await s.ensureOtlpProxy(AGENT);

      expect(vi.mocked(s.daemon.spawnDaemon).mock.calls[0][0]).toEqual({ ...FROM_STATE, port: 52311 });
      expect(s.ConfigLoader.load).not.toHaveBeenCalled();
    });

    it('stops the older daemon, writes its state back, then spawns', async () => {
      const s = await arrangeState(OLDER);

      await s.ensureOtlpProxy(AGENT);

      const order = (fn: unknown) => vi.mocked(fn as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      expect(s.daemon.writeState).toHaveBeenCalledWith(expect.objectContaining(OLDER));
      expect(order(s.daemon.stopDaemon)).toBeLessThan(order(s.daemon.writeState));
      expect(order(s.daemon.writeState)).toBeLessThan(order(s.daemon.spawnDaemon));
    });

    it('a replacement whose spawn fails throws, its written-back state left for the next hook', async () => {
      const s = await arrangeState(OLDER);
      vi.mocked(s.daemon.spawnDaemon).mockRejectedValue(new Error('Daemon failed to start within 5 seconds'));

      await expect(s.ensureOtlpProxy(AGENT)).rejects.toThrow('Daemon failed to start within 5 seconds');

      expect(s.daemon.writeState).toHaveBeenCalledWith(expect.objectContaining(OLDER));
      expect(s.daemon.stopDaemon).toHaveBeenCalled();
    });

    it('asks for the older daemon\'s port when the record has none, leaving the port rule to the spawn', async () => {
      const s = await arrangeState(OLDER);

      await s.ensureOtlpProxy(AGENT);

      const [spawned] = vi.mocked(s.daemon.spawnDaemon).mock.calls[0];
      expect(spawned).toMatchObject({ port: 52311, writeRecord: false });
      expect(spawned).not.toHaveProperty('recordPort');
    });

    it('passes no project when the daemon ran without one', async () => {
      const s = await arrangeState({ ...OLDER, project: undefined, projectBinding: undefined });

      await s.ensureOtlpProxy(AGENT);

      expect(vi.mocked(s.daemon.spawnDaemon).mock.calls[0][0]).not.toHaveProperty('project');
    });

    it.each([
      ['a global profile of the state\'s name', { name: 'p', model: 'm1' }, 'm1'],
      ['a legacy global config answering default for another name', { name: 'default', model: 'm1' }, undefined],
    ])('a state with neither version nor model takes the model of %s', async (_label, globalProfile, model) => {
      const s = await arrangeState({ ...OLDER, version: undefined, model: undefined });
      vi.mocked(s.ConfigLoader.loadGlobalConfigProfile).mockResolvedValue(globalProfile);

      await s.ensureOtlpProxy(AGENT);

      expect(s.ConfigLoader.loadGlobalConfigProfile).toHaveBeenCalledWith('p');
      expect(vi.mocked(s.daemon.spawnDaemon).mock.calls[0][0].model).toBe(model);
    });

    it('a state with a version and no model passes no model', async () => {
      const s = await arrangeState({ ...OLDER, model: undefined });
      vi.mocked(s.ConfigLoader.loadGlobalConfigProfile).mockResolvedValue({ name: 'p', model: 'm1' });

      await s.ensureOtlpProxy(AGENT);

      expect(vi.mocked(s.daemon.spawnDaemon).mock.calls[0][0]).not.toHaveProperty('model');
    });

    /** The state of a live older daemon that names no upstream. */
    const NO_UPSTREAM = { ...OLDER, targetUrl: undefined };

    /** `arrangeState` over {@link NO_UPSTREAM}, whose daemon runs until `stopDaemon` is called. */
    async function arrangeLiveNoUpstream(record: Record<string, unknown> | null = { version: 1, profile: 'p', updatedAt: '' }) {
      const s = await arrangeState(NO_UPSTREAM, record);
      const live = daemonState(NO_UPSTREAM) as Awaited<ReturnType<typeof s.daemon.readState>>;
      let stopped = false;
      vi.mocked(s.daemon.stopDaemon).mockImplementation(async () => { stopped = true; });
      vi.mocked(s.daemon.readState).mockImplementation(async () => (stopped ? null : live));
      vi.mocked(s.daemon.checkStatus).mockImplementation(async () =>
        (stopped ? { running: false, state: null } : { running: true, state: live }));
      return s;
    }

    it.each([
      ['on the recorded profile', { version: 1, profile: 'p', updatedAt: '' }],
      ['on the working directory\'s profile with no record', null],
    ])('a live older daemon whose state names no upstream is stopped, then replaced by today\'s cold start %s', async (_label, record) => {
      const s = await arrangeLiveNoUpstream(record);

      await s.ensureOtlpProxy(AGENT);

      const order = (fn: unknown) => vi.mocked(fn as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      expect(s.daemon.stopDaemon).toHaveBeenCalledTimes(1);
      expect(order(s.daemon.stopDaemon)).toBeLessThan(order(s.daemon.spawnDaemon));
      expect(s.ConfigLoader.load).toHaveBeenCalledWith(process.cwd(), record ? { name: 'p' } : undefined);
      expect(vi.mocked(s.daemon.spawnDaemon).mock.calls[0][0]).toMatchObject({
        profile: 'p', targetUrl: 'https://x.example.com/api', project: 'C', model: 'm-dir', port: 52311,
      });
      expect(s.daemon.seedConnectionRecord).not.toHaveBeenCalledWith(expect.objectContaining({ version: '0.16.0' }));
    });

    it('keeps: a live older daemon whose state names no upstream, the recorded profile not found — nothing stopped or spawned', async () => {
      const s = await arrangeLiveNoUpstream();
      vi.mocked(s.ConfigLoader.loadLocalConfigProfile).mockResolvedValue({});

      await s.ensureOtlpProxy(AGENT);

      expect(s.daemon.stopDaemon).not.toHaveBeenCalled();
      expect(s.daemon.spawnDaemon).not.toHaveBeenCalled();
    });

    it('keeps: a live older daemon whose state names no upstream, no record and a blank baseUrl — nothing stopped or spawned', async () => {
      const s = await arrangeLiveNoUpstream(null);
      vi.mocked(s.ConfigLoader.load).mockResolvedValue({ name: 'p', baseUrl: '' } as Awaited<ReturnType<typeof s.ConfigLoader.load>>);

      await s.ensureOtlpProxy(AGENT);

      expect(s.daemon.stopDaemon).not.toHaveBeenCalled();
      expect(s.daemon.spawnDaemon).not.toHaveBeenCalled();
    });

    it.each(['UserPromptSubmit', 'PostCompact'])(
      'keeps: claude-code-otlp on %s adopts a live older daemon whose state names no upstream as it is',
      async (event) => {
        const s = await arrangeLiveNoUpstream();

        await s.ensureOtlpProxy('claude-code-otlp', event);

        expect(s.daemon.seedConnectionRecord).toHaveBeenCalledWith(expect.objectContaining(NO_UPSTREAM));
        expect(s.daemon.stopDaemon).not.toHaveBeenCalled();
        expect(s.daemon.spawnDaemon).not.toHaveBeenCalled();
      }
    );

    it('keeps: a state that names no upstream of a daemon no longer alive — nothing stopped, the recorded profile started', async () => {
      const s = await arrangeState({ ...NO_UPSTREAM, pid: 9999999 });

      await s.ensureOtlpProxy(AGENT);

      expect(s.daemon.stopDaemon).not.toHaveBeenCalled();
      expect(s.ConfigLoader.load).toHaveBeenCalledWith(process.cwd(), { name: 'p' });
      expect(vi.mocked(s.daemon.spawnDaemon).mock.calls[0][0]).toMatchObject({
        profile: 'p', targetUrl: 'https://x.example.com/api', project: 'C', model: 'm-dir',
      });
    });

    /** A live daemon of an older CLI that wrote no version. */
    const UNVERSIONED = { ...OLDER, version: undefined };

    it.each([
      ['claude-code-otlp', 'UserPromptSubmit'],
      ['claude-code-otlp', 'PostCompact'],
    ])('%s on %s adopts a live older daemon as it is, stopping nothing', async (agent, event) => {
      const s = await arrangeState(UNVERSIONED);

      await s.ensureOtlpProxy(agent, event);

      expect(s.daemon.stopDaemon).not.toHaveBeenCalled();
      expect(s.daemon.spawnDaemon).not.toHaveBeenCalled();
      expect(s.daemon.seedConnectionRecord).toHaveBeenCalledWith(expect.objectContaining(UNVERSIONED));
    });

    it.each([
      ['copilot-chat-otlp', 'UserPromptSubmit'],
      ['copilot-cli-otlp', 'UserPromptSubmit'],
      ['claude-code-otlp', 'PostToolUse'],
      ['claude', undefined],
    ])('%s on %s replaces a live older daemon from its state', async (agent, event) => {
      const s = await arrangeState(UNVERSIONED);

      await s.ensureOtlpProxy(agent, event);

      expect(s.daemon.stopDaemon).toHaveBeenCalledTimes(1);
      expect(vi.mocked(s.daemon.spawnDaemon).mock.calls[0][0]).toMatchObject({ project: 'B', gatewayKey: 'k' });
    });

    it('claude-code-otlp on UserPromptSubmit with no live daemon starts one', async () => {
      const s = await arrangeState({ ...UNVERSIONED, pid: 9999999 });

      await s.ensureOtlpProxy(AGENT, 'UserPromptSubmit');

      expect(vi.mocked(s.daemon.spawnDaemon).mock.calls[0][0]).toMatchObject({ project: 'B', gatewayKey: 'k' });
    });

    it('throws the lock error and stops or spawns nothing when the lock stays held past its budget', async () => {
      const s = await arrangeState(OLDER);

      await withOwnLockHome(async (lockPath) => {
        await writeFile(lockPath, OTHER_LOCK_HOLDER);
        const clock = advancingClock();
        try {
          await expect(s.ensureOtlpProxy(AGENT)).rejects.toThrow('Another codemie process is starting or stopping the proxy');
        } finally {
          clock.mockRestore();
        }
      });

      expect(s.daemon.stopDaemon).not.toHaveBeenCalled();
      expect(s.daemon.spawnDaemon).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['with a record', { version: 1, profile: 'p', updatedAt: '' }],
    ['with none', null],
  ])('a cold start %s spawns the loaded config\'s values', async (_label, record) => {
    const s = await arrange(record, { name: 'p' }, {}, {
      name: 'p', codeMieProject: 'A', model: 'm1', baseUrl: 'https://t', provider: 'ai-run-sso',
      ssoConfig: { apiUrl: 'https://s' }, codeMieUrl: 'https://c',
    });
    vi.mocked(s.ConfigLoader.getActiveProfileName).mockResolvedValue('p');
    vi.mocked(s.ConfigLoader.resolveProfileIdentity).mockResolvedValue(
      { state: 'own', profileName: 'p', shared: {}, identity: {} } as unknown as Awaited<ReturnType<typeof s.ConfigLoader.resolveProfileIdentity>>
    );

    try {
      await s.ensureOtlpProxy(AGENT);
    } finally {
      vi.mocked(s.ConfigLoader.resolveProfileIdentity).mockReset();
    }

    expect(vi.mocked(s.daemon.spawnDaemon).mock.calls[0][0]).toEqual({
      targetUrl: 'https://t', provider: 'ai-run-sso', profile: 'p', model: 'm1', port: 4001, project: 'A',
      projectBinding: 'own', syncApiUrl: 'https://s', syncCodeMieUrl: 'https://c', writeRecord: true, recordPort: true,
    });
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

describe('targets that once needed another identity, over one daemon', () => {
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

  async function arrangeFresh(): Promise<void> {
    await setupHappyMocks();
    const { checkStatus, readState, spawnDaemon } = await import('../daemon-manager.js');
    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(readState).mockResolvedValue(null);
    vi.mocked(spawnDaemon).mockResolvedValue(daemonState() as Awaited<ReturnType<typeof spawnDaemon>>);
  }

  it('--omp --vscode writes both targets over one daemon', async () => {
    await arrangeFresh();
    const { spawnDaemon } = await import('../daemon-manager.js');
    const { writeVsCodeLanguageModelsConfig } = await import('../connectors/vscode.js');
    const { writeOmpExtension } = await import('../connectors/omp.js');
    vi.mocked(writeVsCodeLanguageModelsConfig).mockResolvedValue({ configPath: '/vscode/models.json', requiresSecretConfiguration: false, modelCount: 5 });
    vi.mocked(writeOmpExtension).mockResolvedValue({ path: '/x', changed: true });
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { omp: true, vscode: true } });

    expect(spawnDaemon).toHaveBeenCalledTimes(1);
    expect(writeVsCodeLanguageModelsConfig).toHaveBeenCalled();
    expect(writeOmpExtension).toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('--codex-desktop --claude-desktop prints no warning', async () => {
    await arrangeFresh();
    vi.doMock('../connectors/codex-desktop.js', () => ({
      discoverCodexModels: vi.fn().mockResolvedValue([]),
      findCodexDesktopApp: vi.fn().mockResolvedValue('/Applications/ChatGPT.app'),
      getCodexDesktopAppCandidates: vi.fn().mockReturnValue(['/Applications/ChatGPT.app']),
      getCodexDesktopConfigPath: vi.fn().mockReturnValue('/mock/codex/config.toml'),
      getCodexDesktopStatePath: vi.fn().mockReturnValue('/mock/codex/state.json'),
      selectCodexModel: vi.fn().mockReturnValue('gpt-5'),
      writeCodexDesktopConfig: vi.fn().mockResolvedValue(undefined),
    }));
    const { writeDesktopConfig } = await import('../connectors/desktop.js');
    vi.mocked(writeDesktopConfig).mockResolvedValue('/desktop/config.json');
    const { connectTargets } = await import('../connect-orchestrator.js');

    try {
      await connectTargets({ targets: { codexDesktop: true, claudeDesktop: true } });
    } finally {
      vi.doUnmock('../connectors/codex-desktop.js');
    }

    const printed = console_.log().mock.calls.map(([message]) => stripAnsi(String(message))).join('\n');
    expect(printed).toContain('Codex Desktop configured');
    expect(printed).not.toContain('Warning');
    expect(process.exitCode).toBe(0);
  });

  it('keeps omp when combined with the Claude Code VS Code extension', async () => {
    await arrangeFresh();
    const { writeVsCodeClaudeCodeConfig } = await import('../connectors/vscode-claude-code.js');
    const { writeOmpExtension } = await import('../connectors/omp.js');
    vi.mocked(writeVsCodeClaudeCodeConfig).mockResolvedValue({ path: '/x' } as Awaited<ReturnType<typeof writeVsCodeClaudeCodeConfig>>);
    vi.mocked(writeOmpExtension).mockResolvedValue({ path: '/x', changed: true });
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { omp: true, vscodeClaudeCode: true } });

    expect(writeVsCodeClaudeCodeConfig).toHaveBeenCalled();
    expect(writeOmpExtension).toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('spawns with no identity for omp when Claude Code analytics is declined', async () => {
    await arrangeFresh();
    const { spawnDaemon } = await import('../daemon-manager.js');
    const { writeClaudeCodeOtlpConfig } = await import('../connectors/claude-code-otlp.js');
    const { writeOmpExtension } = await import('../connectors/omp.js');
    const { promptAnalyticsConfirmation } = await import('../prompts/analytics-confirmation.js');
    vi.mocked(promptAnalyticsConfirmation).mockResolvedValueOnce('cancel');
    vi.mocked(writeOmpExtension).mockResolvedValue({ path: '/x', changed: true });
    const { connectTargets } = await import('../connect-orchestrator.js');

    await connectTargets({ targets: { omp: true, claudeCodeOtlp: true } });

    expect(writeClaudeCodeOtlpConfig).not.toHaveBeenCalled();
    expect(writeOmpExtension).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnDaemon).mock.calls[0][0]).not.toHaveProperty('clientType');
    expect(process.exitCode).toBe(0);
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
      "No SSO credentials found for profile 'p'.\n  Sign in first — run: codemie profile login --url https://x.example.com"
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

describe('connect while Claude Desktop is connected: no identity is passed', () => {
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

  type State = Awaited<ReturnType<typeof import('../daemon-manager.js').checkStatus>>['state'];

  /** Happy profile, Claude Desktop connected to `gatewayPort`, no record or earlier state, and the given running daemon. */
  async function arrange(gatewayPort: number, running: Record<string, unknown> | null) {
    await setupHappyMocks();
    const daemon = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    const { readDesktopGateway } = await import('../connectors/desktop.js');
    vi.mocked(readDesktopGateway).mockResolvedValue({ port: gatewayPort });
    vi.mocked(daemon.readState).mockResolvedValue(running as State);
    vi.mocked(daemon.checkStatus).mockResolvedValue(
      running ? { running: true, state: running as State } : { running: false, state: null }
    );
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'deep', code: 'ok' });
    vi.mocked(daemon.writeConnectionRecord).mockResolvedValue(true);
    const { connectTargets } = await import('../connect-orchestrator.js');
    return { daemon, connectTargets };
  }

  it.each(['claude-desktop', 'claude-code-otlp', 'codex-desktop'])(
    'reuses a running daemon whose state names %s and records its port',
    async (clientType) => {
      const running = matchingDesktopState({ clientType });
      const s = await arrange(4001, running);

      await s.connectTargets({ targets: { claudeCodeOtlp: true }, silent: true });

      expect(s.daemon.spawnDaemon).not.toHaveBeenCalled();
      expect(s.daemon.stopDaemon).not.toHaveBeenCalled();
      expect(s.daemon.writeConnectionRecord).toHaveBeenCalledWith(running, 'p', { port: 4001 });
    }
  );

  it('a connect naming Claude Desktop spawns with no identity on the port Desktop is configured with', async () => {
    const s = await arrange(4005, null);
    const { writeDesktopConfig } = await import('../connectors/desktop.js');
    vi.mocked(writeDesktopConfig).mockResolvedValue('/desktop/config.json');
    vi.mocked(s.daemon.spawnDaemon).mockResolvedValue(
      matchingDesktopState({ port: 4005, url: 'http://127.0.0.1:4005' }) as Awaited<ReturnType<typeof s.daemon.spawnDaemon>>
    );

    await s.connectTargets({ targets: { claudeDesktop: true } });

    const [spawned] = vi.mocked(s.daemon.spawnDaemon).mock.calls[0];
    expect(spawned.port).toBe(4005);
    expect(spawned).not.toHaveProperty('clientType');
    expect(spawned).not.toHaveProperty('telemetryMode');
  });

  it('keeps a spawn that came up off the asked port and records the port it runs on', async () => {
    const s = await arrange(4005, null);
    const spawnedState = matchingDesktopState({ port: 62000, url: 'http://127.0.0.1:62000' });
    vi.mocked(s.daemon.spawnDaemon).mockResolvedValue(spawnedState as Awaited<ReturnType<typeof s.daemon.spawnDaemon>>);

    await expect(s.connectTargets({ targets: { claudeCodeOtlp: true }, silent: true })).resolves.toBeUndefined();

    expect(s.daemon.spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({ port: 4005 }));
    expect(s.daemon.stopDaemon).not.toHaveBeenCalled();
    expect(s.daemon.writeConnectionRecord).toHaveBeenCalledWith(spawnedState, 'p', { port: 62000 });
  });
});

describe('ensureOtlpProxy while Claude Desktop is connected: no identity is passed', () => {
  let outputSpies: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock('../../../../providers/core/codemie-auth-helpers.js', () => ({
      getStoredPlatformCredentials: vi.fn().mockResolvedValue({ token: 't' }),
    }));
    outputSpies = [
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
      ...(['log', 'info', 'warn', 'error'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {})),
    ];
  });

  afterEach(() => {
    for (const spy of outputSpies) spy.mockRestore();
    vi.doUnmock('../../../../providers/core/codemie-auth-helpers.js');
    vi.resetModules();
  });

  async function arrange(record: Record<string, unknown> | null, gatewayPort: number | null, spawnedPort: number) {
    const { ensureOtlpProxy } = await import('../otlp-cold-start.js');
    const daemon = await import('../daemon-manager.js');
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { readDesktopGateway } = await import('../connectors/desktop.js');
    const { logger } = await import('../../../../utils/logger.js');
    await setupHappyMocks();
    vi.mocked(readDesktopGateway).mockResolvedValue(gatewayPort === null ? null : { port: gatewayPort });
    vi.mocked(daemon.readState).mockResolvedValue(null);
    vi.mocked(daemon.readConnectionRecord).mockResolvedValue(record as Awaited<ReturnType<typeof daemon.readConnectionRecord>>);
    vi.mocked(daemon.checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(daemon.spawnDaemon).mockResolvedValue(
      daemonState({ port: spawnedPort, url: `http://127.0.0.1:${spawnedPort}` }) as Awaited<ReturnType<typeof daemon.spawnDaemon>>
    );
    vi.mocked(ConfigLoader.loadLocalConfigProfile).mockResolvedValue({ name: 'p' });
    vi.mocked(ConfigLoader.getActiveProfileName).mockResolvedValue('p');
    for (const method of ['warn', 'info', 'status', 'success'] as const) {
      outputSpies.push(vi.spyOn(logger, method).mockImplementation(() => {}));
    }
    return { ensureOtlpProxy, daemon };
  }

  function expectNoIdentity(spawned: Record<string, unknown>): void {
    expect(spawned).not.toHaveProperty('clientType');
    expect(spawned).not.toHaveProperty('telemetryMode');
  }

  it.each([
    ['a claude-code-otlp record', { version: 1, profile: 'p', clientType: 'claude-code-otlp', updatedAt: '' }],
    ['no record', null],
  ])('spawns with %s on Desktop\'s gateway port, writing nothing to the console', async (_label, record) => {
    const s = await arrange(record, 4005, 4005);

    await s.ensureOtlpProxy('claude');

    const [spawned] = vi.mocked(s.daemon.spawnDaemon).mock.calls[0];
    expect(spawned.port).toBe(4005);
    expectNoIdentity(spawned as unknown as Record<string, unknown>);
    for (const spy of outputSpies.slice(0, 6)) expect(spy).not.toHaveBeenCalled();
  });

  it('keeps a spawn that came up off the asked port and points Claude Code at it, writing nothing to the console', async () => {
    const s = await arrange({ version: 1, profile: 'p', clientType: 'claude-code-otlp', updatedAt: '' }, 4005, 62000);
    const { refreshClaudeCodeOtlpEndpoint } = await import('../connectors/claude-code-otlp-endpoint.js');

    await expect(s.ensureOtlpProxy('claude-code-otlp')).resolves.toBeUndefined();

    expect(s.daemon.spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({ port: 4005 }));
    expect(s.daemon.stopDaemon).not.toHaveBeenCalled();
    expect(refreshClaudeCodeOtlpEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ port: 62000, url: 'http://127.0.0.1:62000' })
    );
    for (const spy of outputSpies.slice(0, 6)) expect(spy).not.toHaveBeenCalled();
  });

  it('asks for 4001 with a legacy codex-desktop record and no port, state, OTLP endpoint or Desktop gateway', async () => {
    const s = await arrange({ version: 1, profile: 'p', clientType: 'codex-desktop', updatedAt: '' }, null, 4001);

    await s.ensureOtlpProxy('claude-code-otlp');

    const [spawned] = vi.mocked(s.daemon.spawnDaemon).mock.calls[0];
    expect(spawned.port).toBe(4001);
    expectNoIdentity(spawned as unknown as Record<string, unknown>);
  });
});
