/**
 * Proxy command tests
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NPM_WIN32_SHIMS } from '../../../../../tests/helpers/npm-shims.js';

vi.mock('../../../../utils/config.js', () => ({
  ConfigLoader: {
    load: vi.fn(),
    listProfiles: vi.fn(),
    getActiveProfileName: vi.fn(),
    resolveProfileIdentity: vi.fn(),
    loadGlobalConfigProfile: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../../../../providers/index.js', () => ({
  ProviderRegistry: {
    getProvider: vi.fn(),
  },
}));

vi.mock('../daemon-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../daemon-manager.js')>();
  const checkStatus = vi.fn();
  return {
    isOlderDaemon: actual.isOlderDaemon,
    checkStatus,
    // The read without the lock finds the daemon `checkStatus` finds, unless a test says otherwise.
    readDaemonStatus: vi.fn((...args: Parameters<typeof actual.readDaemonStatus>) => checkStatus(...args)),
    readState: vi.fn(),
    writeState: vi.fn(),
    spawnDaemon: vi.fn(),
    stopDaemon: vi.fn(),
    readConnectionRecord: vi.fn(),
    writeConnectionRecord: vi.fn(),
    writeConnectionPort: vi.fn(),
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

vi.mock('../health-check.js', () => ({
  checkProxyHealth: vi.fn(),
}));

vi.mock('../connectors/claude-code-otlp-endpoint.js', () => ({
  checkClaudeCodeOtlpEndpoint: vi.fn().mockResolvedValue(null),
  readConfiguredOtlpPort: vi.fn().mockResolvedValue(null),
  refreshClaudeCodeOtlpEndpoint: vi.fn().mockResolvedValue(false),
}));

vi.mock('../analytics-connectors.js', () => ({
  hasActiveAnalyticsConnector: vi.fn().mockResolvedValue(false),
}));

vi.mock('../delivery-health.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../delivery-health.js')>()),
  collectDeliveryHealth: vi.fn().mockResolvedValue({ status: 'unknown', pendingBytes: 0 }),
}));

vi.mock('../connectors/desktop.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/desktop.js')>()),
  writeDesktopConfig: vi.fn(),
  describeManagedSettingsOverride: vi.fn().mockReturnValue(null),
  getDesktopBaseDir: vi.fn().mockReturnValue('/mock/desktop/base'),
  mapCanonicalToDesktop: vi.fn().mockReturnValue([]),
  summarizeManagedOauthShapes: vi.fn().mockReturnValue({ oauthConfigured: 0, oauthFlagged: 0, noAuth: 0 }),
  readDesktopGateway: vi.fn().mockResolvedValue(null),
}));

vi.mock('../connectors/vscode.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/vscode.js')>()),
  writeVsCodeLanguageModelsConfig: vi.fn(),
}));

// The PATH lookup of the first `codemie` finds none unless a test points it at an install of its own.
vi.mock('@/utils/processes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/processes.js')>()),
  getCommandPath: vi.fn(async () => null),
}));

// The lookup of this install's own package runs as it is unless a test makes it fail.
vi.mock('@/utils/active-cli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/active-cli.js')>();
  return { ...actual, findFirstManifest: vi.fn(actual.findFirstManifest) };
});

vi.mock('../connectors/managed-mcp-remote.js', () => ({
  fetchManagedMcpServers: vi.fn().mockResolvedValue([]),
}));

vi.mock('../inspect-desktop.js', () => ({
  printDesktopInspection: vi.fn(),
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

// These tests exercise the credential checks that run after the non-interactive
// guard for --claude-code-otlp; vitest has no TTY, so pretend there is one.
vi.mock('@/utils/interactive.js', () => ({
  isNonInteractiveEnvironment: vi.fn().mockReturnValue(false),
}));

/**
 * Runs `fn` with a CODEMIE_HOME of its own whose daemon lock another live process holds (this process's pid, no
 * start time), on a clock a second ahead at every read. `releaseAtRead` frees the lock at that clock read, as
 * the holder finishing; without it a lock wait reaches its budget in a few polls.
 */
async function withHeldLock<T>(fn: (lockPath: string) => Promise<T>, releaseAtRead?: number): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'daemon-lock-'));
  const lockPath = join(home, 'proxy-daemon.lock');
  const previous = process.env.CODEMIE_HOME;
  process.env.CODEMIE_HOME = home;
  await writeFile(lockPath, JSON.stringify({ pid: process.pid }));
  const realNow = Date.now.bind(Date);
  let reads = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
    reads++;
    if (reads === releaseAtRead) unlinkSync(lockPath);
    return releaseAtRead === undefined ? realNow() + 1000 * reads : realNow();
  });
  try {
    return await fn(lockPath);
  } finally {
    clock.mockRestore();
    process.env.CODEMIE_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * A home of its own, fresh for each test, for every client config, hook file and Desktop config a connect, a start,
 * a restart or a status reads, and a connect, a start or a restart moves to its named key; the record's identity
 * removal is pointed back at the module's mock once the test ends.
 */
let clientHome: string;
beforeEach(async () => {
  clientHome = await mkdtemp(join(tmpdir(), 'proxy-client-home-'));
  for (const name of ['HOME', 'USERPROFILE', 'CODEMIE_HOME', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']) {
    vi.stubEnv(name, clientHome);
  }
  vi.stubEnv('CODEX_HOME', join(clientHome, '.codex'));
  vi.stubEnv('COPILOT_HOME', join(clientHome, '.copilot'));
  vi.stubEnv('PI_CODING_AGENT_DIR', join(clientHome, '.omp', 'agent'));
});
afterEach(async () => {
  const daemon = await import('../daemon-manager.js');
  vi.mocked(daemon.clearLegacyClientIdentity).mockReset();
  vi.mocked(daemon.hasLegacyClientIdentity).mockReset();
  vi.unstubAllEnvs();
  await rm(clientHome, { recursive: true, force: true });
});

interface ClientFiles {
  record: string;
  codex: string;
  vscode: string;
  desktop: string;
}

const olderCodexConfig = (key: string): string => [
  '# >>> codemie proxy connect (codex-desktop) header - managed block, do not edit',
  'model_provider = "codemie"',
  'model = "gpt-5"',
  '# <<< codemie proxy connect (codex-desktop) header',
  '',
  '# >>> codemie proxy connect (codex-desktop) provider - managed block, do not edit',
  '[model_providers.codemie]',
  'name = "CodeMie"',
  'base_url = "http://127.0.0.1:4001/v1"',
  'wire_api = "responses"',
  '[model_providers.codemie.http_headers]',
  `Authorization = "Bearer ${key}"`,
  '# <<< codemie proxy connect (codex-desktop) provider',
  '',
].join('\n');

/**
 * Under `home`: the connection record `record`, which the record's identity removal reads and rewrites; with `key`,
 * a Codex config, a VS Code Claude Code settings file and Claude Desktop's applied entry, each on port 4001 holding
 * `key`. Gives the four paths.
 */
async function arrangeClientFiles(home: string, record: Record<string, unknown>, key?: string): Promise<ClientFiles> {
  const { getClaudeDesktopBaseDir } = await import('@/telemetry/clients/claude-desktop/claude-desktop.paths.js');
  const { getVsCodeProductDir } = await import('../connectors/vscode.js');
  const files: ClientFiles = {
    record: join(home, 'proxy-connection.json'),
    codex: join(home, '.codex', 'config.toml'),
    vscode: join(getVsCodeProductDir(false), 'User', 'settings.json'),
    desktop: join(getClaudeDesktopBaseDir(), 'configLibrary', 'cfg.json'),
  };
  const writeAt = async (path: string, text: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  await writeAt(files.record, JSON.stringify(record));
  if (key !== undefined) {
    await writeAt(files.codex, olderCodexConfig(key));
    await writeAt(files.vscode, JSON.stringify({
      'claudeCode.environmentVariables': [
        { name: 'ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:4001' },
        { name: 'ANTHROPIC_AUTH_TOKEN', value: key },
      ],
    }));
    await writeAt(join(dirname(files.desktop), '_meta.json'), JSON.stringify({ appliedId: 'cfg' }));
    await writeAt(files.desktop, JSON.stringify({
      inferenceProvider: 'gateway', inferenceGatewayBaseUrl: 'http://127.0.0.1:4001', inferenceGatewayApiKey: key,
    }));
  }
  const daemon = await import('../daemon-manager.js');
  const actual = await vi.importActual<typeof import('../daemon-manager.js')>('../daemon-manager.js');
  vi.mocked(daemon.clearLegacyClientIdentity).mockImplementation(() => actual.clearLegacyClientIdentity(files.record));
  vi.mocked(daemon.hasLegacyClientIdentity).mockImplementation(() => actual.hasLegacyClientIdentity(files.record));
  return files;
}

/** A record an older CLI left: its client identity names Claude Desktop. */
const OLDER_RECORD = { version: 1, profile: 'work', clientType: 'claude-desktop', telemetryMode: 'claude-desktop', updatedAt: '' };

const MOVED_LINES = [
  chalk.green('✓ Claude Desktop moved to its own key — Restart Claude Desktop to apply changes.'),
  chalk.green('✓ VS Code Claude Code extension moved to its own key — Reload VS Code to apply changes.'),
  chalk.green('✓ Codex desktop moved to its own key — Quit and reopen the ChatGPT desktop app to apply the change.'),
];

/**
 * Each config of `files` holds its named key of `key`, `lines` print the three moved lines after the `✓ Proxy …` line,
 * and the record holds neither field of the older CLI's identity.
 */
async function expectMovedToNamedKeys(files: ClientFiles, key: string, lines: string[]): Promise<void> {
  expect(await readFile(files.codex, 'utf-8')).toContain(`Authorization = "Bearer ${key}.codex-desktop"`);
  expect(JSON.parse(await readFile(files.vscode, 'utf-8'))['claudeCode.environmentVariables']).toContainEqual(
    { name: 'ANTHROPIC_AUTH_TOKEN', value: `${key}.vscode-claude-code` }
  );
  expect(JSON.parse(await readFile(files.desktop, 'utf-8')).inferenceGatewayApiKey).toBe(`${key}.claude-desktop`);
  const proxyLine = lines.findIndex((line) => line.includes('✓ Proxy '));
  const moved = (line: string): boolean => line.includes('moved to its own key');
  expect(proxyLine).toBeGreaterThanOrEqual(0);
  expect(lines.filter(moved)).toEqual(MOVED_LINES);
  expect(lines.slice(proxyLine + 1).filter(moved)).toEqual(MOVED_LINES);
  const record = JSON.parse(await readFile(files.record, 'utf-8')) as Record<string, unknown>;
  expect(record).not.toHaveProperty('clientType');
  expect(record).not.toHaveProperty('telemetryMode');
}

// A test that connects Claude Desktop leaves the shared mock as it found it: not connected.
afterEach(async () => {
  const { readDesktopGateway } = await import('../connectors/desktop.js');
  vi.mocked(readDesktopGateway).mockResolvedValue(null);
});

describe('proxy connect desktop', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit:${code}`);
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('does not spawn the daemon when selected SSO profile has no stored credentials', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { ProviderRegistry } = await import('../../../../providers/index.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'codemie-new',
      provider: 'ai-run-sso',
      baseUrl: 'https://codemie.lab.epam.com/code-assistant-api',
      codeMieUrl: 'https://codemie.lab.epam.com',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(ProviderRegistry.getProvider).mockReturnValue({
      name: 'ai-run-sso',
      authType: 'sso',
    } as ReturnType<typeof ProviderRegistry.getProvider>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return {
        getStoredCredentials: vi.fn().mockResolvedValue(null),
      };
    } as unknown as typeof CodeMieSSO);

    const command = createProxyCommand();
    await expect(
      command.parseAsync(['connect', 'desktop', '--profile', 'codemie-new'], { from: 'user' })
    ).rejects.toThrow('process.exit:1');

    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("No SSO credentials found for profile 'codemie-new'.")
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '  Run: codemie profile login --url https://codemie.lab.epam.com'
    );
  });

  it('checks both credential URLs and suggests the selected profile URL when workspace URL differs', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { ProviderRegistry } = await import('../../../../providers/index.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'codemie-new',
      provider: 'ai-run-sso',
      baseUrl: 'https://codemie-preview.lab.epam.com/code-assistant-api',
      codeMieUrl: 'https://codemie.lab.epam.com',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(ProviderRegistry.getProvider).mockReturnValue({
      name: 'ai-run-sso',
      authType: 'sso',
    } as ReturnType<typeof ProviderRegistry.getProvider>);
    const getStoredCredentials = vi.fn().mockResolvedValue(null);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials };
    } as unknown as typeof CodeMieSSO);

    const command = createProxyCommand();
    await expect(
      command.parseAsync(['connect', '--claude-code-otlp', '--profile', 'codemie-new'], { from: 'user' })
    ).rejects.toThrow('process.exit:1');

    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '  Run: codemie profile login --url https://codemie-preview.lab.epam.com'
    );
    expect(getStoredCredentials).toHaveBeenNthCalledWith(
      1,
      'https://codemie-preview.lab.epam.com/code-assistant-api'
    );
    expect(getStoredCredentials).toHaveBeenNthCalledWith(2, 'https://codemie.lab.epam.com');
  });

  it('suggests an explicit profile URL when CodeMie URL is unavailable', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { ProviderRegistry } = await import('../../../../providers/index.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'codemie-new',
      provider: 'ai-run-sso',
      baseUrl: 'https://codemie.lab.epam.com/code-assistant-api',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(ProviderRegistry.getProvider).mockReturnValue({
      name: 'ai-run-sso',
      authType: 'sso',
    } as ReturnType<typeof ProviderRegistry.getProvider>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockResolvedValue(null) };
    } as unknown as typeof CodeMieSSO);

    const command = createProxyCommand();
    await expect(
      command.parseAsync(['connect', '--claude-code-otlp', '--profile', 'codemie-new'], { from: 'user' })
    ).rejects.toThrow('process.exit:1');

    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '  Run: codemie profile login --url https://codemie.lab.epam.com'
    );
  });

  it('prints Failed to verify credentials and exits 1 when the credential lookup throws', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { ProviderRegistry } = await import('../../../../providers/index.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'codemie-new',
      provider: 'ai-run-sso',
      baseUrl: 'https://codemie.lab.epam.com/code-assistant-api',
      codeMieUrl: 'https://codemie.lab.epam.com',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(ProviderRegistry.getProvider).mockReturnValue({
      name: 'ai-run-sso',
      authType: 'sso',
    } as ReturnType<typeof ProviderRegistry.getProvider>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockRejectedValue(new Error('keychain locked')) };
    } as unknown as typeof CodeMieSSO);

    const command = createProxyCommand();
    await expect(
      command.parseAsync(['connect', 'desktop', '--profile', 'codemie-new'], { from: 'user' })
    ).rejects.toThrow('process.exit:1');

    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to verify credentials: keychain locked')
    );
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('No SSO credentials found')
    );
  });

  it('calls syncRegisteredSkills and syncPluginSkills when starting the daemon', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { ProviderRegistry } = await import('../../../../providers/index.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { syncRegisteredSkills } = await import('../../../../cli/commands/skills/setup/sync.js');
    const { syncPluginSkills } = await import('../../../../cli/commands/skills/setup/sync-plugin.js');
    const { writeDesktopConfig } = await import('../connectors/desktop.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'test-profile',
      provider: 'ai-run-sso',
      baseUrl: 'https://example.com/api',
      codeMieUrl: 'https://example.com',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(ProviderRegistry.getProvider).mockReturnValue({
      name: 'ai-run-sso',
      authType: 'sso',
    } as ReturnType<typeof ProviderRegistry.getProvider>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockResolvedValue({ token: 'tok' }) };
    } as unknown as typeof CodeMieSSO);
    vi.mocked(spawnDaemon).mockResolvedValue({
      url: 'http://localhost:4001',
      profile: 'test-profile',
      port: 4001,
      gatewayKey: 'gk',
      startedAt: new Date().toISOString(),
      telemetryMode: 'claude-desktop',
    } as Awaited<ReturnType<typeof spawnDaemon>>);
    vi.mocked(writeDesktopConfig).mockResolvedValue('/path/to/config');

    const command = createProxyCommand();
    await command.parseAsync(['connect', 'desktop', '--profile', 'test-profile'], { from: 'user' });

    expect(syncRegisteredSkills).toHaveBeenCalledWith('test-profile', process.cwd());
    expect(syncPluginSkills).toHaveBeenCalledOnce();
  });

  it('warns that a managed settings source overrides the config it just wrote', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { ProviderRegistry } = await import('../../../../providers/index.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { writeDesktopConfig, describeManagedSettingsOverride } = await import('../connectors/desktop.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'test-profile',
      provider: 'ai-run-sso',
      baseUrl: 'https://example.com/api',
      codeMieUrl: 'https://example.com',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(ProviderRegistry.getProvider).mockReturnValue({
      name: 'ai-run-sso',
      authType: 'sso',
    } as ReturnType<typeof ProviderRegistry.getProvider>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockResolvedValue({ token: 'tok' }) };
    } as unknown as typeof CodeMieSSO);
    vi.mocked(spawnDaemon).mockResolvedValue({
      url: 'http://localhost:4001',
      profile: 'test-profile',
      port: 4001,
      gatewayKey: 'gk',
      startedAt: new Date().toISOString(),
      telemetryMode: 'claude-desktop',
    } as Awaited<ReturnType<typeof spawnDaemon>>);
    vi.mocked(writeDesktopConfig).mockResolvedValue('/path/to/config');
    vi.mocked(describeManagedSettingsOverride).mockReturnValue(
      '/etc/claude-desktop/managed-settings.json exists. Claude Desktop applies managed settings instead of local configuration, so this write may have no effect.'
    );

    await createProxyCommand().parseAsync(['connect', 'desktop', '--profile', 'test-profile'], {
      from: 'user',
    });

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('/etc/claude-desktop/managed-settings.json')
    );
  });

  it('stays silent about managed settings when no managed source is present', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { ProviderRegistry } = await import('../../../../providers/index.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { writeDesktopConfig, describeManagedSettingsOverride } = await import('../connectors/desktop.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'test-profile',
      provider: 'ai-run-sso',
      baseUrl: 'https://example.com/api',
      codeMieUrl: 'https://example.com',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(ProviderRegistry.getProvider).mockReturnValue({
      name: 'ai-run-sso',
      authType: 'sso',
    } as ReturnType<typeof ProviderRegistry.getProvider>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockResolvedValue({ token: 'tok' }) };
    } as unknown as typeof CodeMieSSO);
    vi.mocked(spawnDaemon).mockResolvedValue({
      url: 'http://localhost:4001',
      profile: 'test-profile',
      port: 4001,
      gatewayKey: 'gk',
      startedAt: new Date().toISOString(),
      telemetryMode: 'claude-desktop',
    } as Awaited<ReturnType<typeof spawnDaemon>>);
    vi.mocked(writeDesktopConfig).mockResolvedValue('/path/to/config');
    vi.mocked(describeManagedSettingsOverride).mockReturnValue(null);

    await createProxyCommand().parseAsync(['connect', 'desktop', '--profile', 'test-profile'], {
      from: 'user',
    });

    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('managed settings'));
  });

  it('uses the effective active profile when --profile is omitted', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { ProviderRegistry } = await import('../../../../providers/index.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { writeDesktopConfig } = await import('../connectors/desktop.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'selected-profile',
      provider: 'ai-run-sso',
      baseUrl: 'https://example.com/api',
      codeMieUrl: 'https://example.com',
      model: 'selected-model',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(ProviderRegistry.getProvider).mockReturnValue({
      name: 'ai-run-sso',
      authType: 'sso',
    } as ReturnType<typeof ProviderRegistry.getProvider>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockResolvedValue({ token: 'tok' }) };
    } as unknown as typeof CodeMieSSO);
    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(spawnDaemon).mockResolvedValue({
      url: 'http://localhost:4001',
      profile: 'selected-profile',
      port: 4001,
      gatewayKey: 'gk',
      startedAt: new Date().toISOString(),
      telemetryMode: 'claude-desktop',
    } as Awaited<ReturnType<typeof spawnDaemon>>);
    vi.mocked(writeDesktopConfig).mockResolvedValue('/path/to/config');

    await createProxyCommand().parseAsync(['connect', 'desktop'], { from: 'user' });

    expect(ConfigLoader.load).toHaveBeenCalledWith(process.cwd(), undefined);
    expect(spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'selected-profile',
    }));
  });
});

describe('proxy command registration', () => {
  it('registers the analytics subcommand group (CR-004)', async () => {
    const { createProxyCommand } = await import('../index.js');
    const proxy = createProxyCommand();
    const analytics = proxy.commands.find((c) => c.name() === 'analytics');
    expect(analytics).toBeDefined();
    const subcommandNames = analytics!.commands.map((c) => c.name()).sort();
    expect(subcommandNames).toEqual(['connect-folder', 'disable', 'disconnect-folder', 'enable', 'exclude', 'include', 'status']);
  });
});

describe('proxy start', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit:${code}`);
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('starts a transparent daemon without model configuration', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'default',
      provider: 'ai-run-sso',
      baseUrl: 'https://example.com/api',
      codeMieProject: 'team-project',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockResolvedValue({ token: 'tok' }) };
    } as unknown as typeof CodeMieSSO);
    vi.mocked(spawnDaemon).mockResolvedValue({
      url: 'http://127.0.0.1:4001',
      profile: 'default',
      port: 4001,
      gatewayKey: 'local-key',
      startedAt: new Date().toISOString(),
    });

    await createProxyCommand().parseAsync(['start'], { from: 'user' });

    const options = vi.mocked(spawnDaemon).mock.calls[0][0];
    expect(options).toMatchObject({
      targetUrl: 'https://example.com/api',
      profile: 'default',
      project: 'team-project',
    });
    expect(options).not.toHaveProperty('model');
  });

  it('keeps explicit profile selection', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'custom',
      provider: 'ai-run-sso',
      baseUrl: 'https://custom.example.com/api',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockResolvedValue({ token: 'tok' }) };
    } as unknown as typeof CodeMieSSO);
    vi.mocked(spawnDaemon).mockResolvedValue({
      url: 'http://127.0.0.1:4001',
      profile: 'custom',
      port: 4001,
      gatewayKey: 'local-key',
      startedAt: new Date().toISOString(),
    });

    await createProxyCommand().parseAsync(['start', '--profile', 'custom'], { from: 'user' });

    expect(ConfigLoader.load).toHaveBeenCalledWith(process.cwd(), { name: 'custom' });
  });

  it('starts with no identity on Desktop\'s gateway port while Claude Desktop is connected and nothing else names a port', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { readDesktopGateway } = await import('../connectors/desktop.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(readDesktopGateway).mockResolvedValue({ port: 4005 });
    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'default',
      provider: 'ai-run-sso',
      baseUrl: 'https://example.com/api',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockResolvedValue({ token: 'tok' }) };
    } as unknown as typeof CodeMieSSO);
    vi.mocked(spawnDaemon).mockResolvedValue({
      url: 'http://127.0.0.1:4005',
      profile: 'default',
      port: 4005,
      gatewayKey: 'local-key',
      telemetryMode: 'claude-desktop',
      startedAt: new Date().toISOString(),
    });

    await createProxyCommand().parseAsync(['start'], { from: 'user' });

    const options = vi.mocked(spawnDaemon).mock.calls[0][0];
    expect(options.port).toBe(4005);
    expect(options).not.toHaveProperty('clientType');
    expect(options).not.toHaveProperty('telemetryMode');
  });

  it('names a running daemon of another profile as a conflict without its client, and stops or spawns nothing', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon, stopDaemon } = await import('../daemon-manager.js');
    const { readDesktopGateway } = await import('../connectors/desktop.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(readDesktopGateway).mockResolvedValue({ port: 4005 });
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: {
        pid: 4242,
        url: 'http://127.0.0.1:4005',
        profile: 'other',
        port: 4005,
        gatewayKey: 'local-key',
        clientType: 'codemie-daemon',
        provider: 'ai-run-sso',
        targetUrl: 'https://example.com/api',
        version: '0.17.0',
        startedAt: new Date().toISOString(),
      },
    });
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'default',
      provider: 'ai-run-sso',
      baseUrl: 'https://example.com/api',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockResolvedValue({ token: 'tok' }) };
    } as unknown as typeof CodeMieSSO);

    await expect(createProxyCommand().parseAsync(['start'], { from: 'user' })).rejects.toThrow('process.exit:1');

    expect(consoleErrorSpy).toHaveBeenCalledWith(chalk.red([
      '✗ A proxy is already running with different settings:',
      '  profile: other',
      '  port: 4005',
      '',
      'Stop it first:',
      '  codemie proxy stop',
    ].join('\n')));
    expect(stopDaemon).not.toHaveBeenCalled();
    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  it('names a running daemon of the same settings on another port than the record\'s as a conflict, and stops or spawns nothing', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, readConnectionRecord, spawnDaemon, stopDaemon } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');

    vi.mocked(readConnectionRecord).mockResolvedValue({ version: 1, profile: 'default', port: 4001, updatedAt: '' });
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: {
        pid: 4242,
        url: 'http://127.0.0.1:4005',
        profile: 'default',
        port: 4005,
        gatewayKey: 'local-key',
        project: 'proj',
        provider: 'ai-run-sso',
        targetUrl: 'https://example.com/api',
        version: '0.17.0',
        startedAt: new Date().toISOString(),
      },
    });
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'default',
      provider: 'ai-run-sso',
      baseUrl: 'https://example.com/api',
      codeMieProject: 'proj',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockResolvedValue({ token: 'tok' }) };
    } as unknown as typeof CodeMieSSO);

    await expect(createProxyCommand().parseAsync(['start'], { from: 'user' })).rejects.toThrow('process.exit:1');

    expect(consoleErrorSpy).toHaveBeenCalledWith(chalk.red([
      '✗ A proxy is already running with different settings:',
      '  profile: default',
      '  port: 4005',
      '  project: proj',
      '',
      'Stop it first:',
      '  codemie proxy stop',
    ].join('\n')));
    expect(stopDaemon).not.toHaveBeenCalled();
    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  it.each([
    ['a matching CodeMie URL', 'https://custom.example.com'],
    ['a workspace URL for another environment', 'https://prod.example.com'],
    ['no CodeMie URL', undefined],
  ])('suggests explicit login for proxy start with %s', async (_description, codeMieUrl) => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');
    const getStoredCredentials = vi.fn().mockResolvedValue(null);

    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'custom',
      provider: 'ai-run-sso',
      baseUrl: 'https://custom.example.com/code-assistant-api',
      codeMieUrl,
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials };
    } as unknown as typeof CodeMieSSO);

    await expect(
      createProxyCommand().parseAsync(['start', '--profile', 'custom'], { from: 'user' })
    ).rejects.toThrow('process.exit:1');

    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '  Run: codemie profile login --url https://custom.example.com'
    );
  });

  /** The SSO-backed profile `p` of the start-path table: project A, model m1, its URLs. */
  async function arrangeProfileP(overrides: Record<string, unknown> = {}) {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'p', provider: 'ai-run-sso', baseUrl: 'https://t', codeMieProject: 'A', model: 'm1',
      ssoConfig: { apiUrl: 'https://s' }, codeMieUrl: 'https://c', ...overrides,
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(ConfigLoader.resolveProfileIdentity).mockResolvedValue(
      { state: 'own', profileName: 'p', shared: {}, identity: {} } as unknown as Awaited<ReturnType<typeof ConfigLoader.resolveProfileIdentity>>
    );
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockResolvedValue({ token: 'tok' }) };
    } as unknown as typeof CodeMieSSO);
    return ConfigLoader;
  }

  it('spawns the loaded config\'s values without a model when no daemon runs', async () => {
    const ConfigLoader = await arrangeProfileP();
    const { checkStatus, readConnectionRecord, spawnDaemon } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(readConnectionRecord).mockResolvedValue(null);
    vi.mocked(spawnDaemon).mockResolvedValue({ pid: 5151, port: 4001, url: 'http://127.0.0.1:4001', profile: 'p', gatewayKey: 'codemie-proxy', startedAt: '' });

    try {
      await createProxyCommand().parseAsync(['start'], { from: 'user' });
    } finally {
      vi.mocked(ConfigLoader.resolveProfileIdentity).mockReset();
    }

    expect(vi.mocked(spawnDaemon).mock.calls[0][0]).toEqual({
      targetUrl: 'https://t', provider: 'ai-run-sso', profile: 'p', project: 'A', projectBinding: 'own',
      syncApiUrl: 'https://s', syncCodeMieUrl: 'https://c', port: 4001, writeRecord: true,
    });
  });

  it.each([
    ['model m1 and key k', { model: 'm1', gatewayKey: 'k' }, []],
    ['every value of the start-path table', {
      model: 'm2', gatewayKey: 'k', project: 'B', projectBinding: 'local', syncApiUrl: 'https://s2', syncCodeMieUrl: 'https://c2',
    }, []],
    ['model m1, key k and --profile p', { model: 'm1', gatewayKey: 'k' }, ['--profile', 'p']],
  ])('replaces a matching daemon of an older CLI from its own state on its port, with %s', async (_label, extra, args) => {
    // The command's config matches the daemon (a conflict otherwise) and names its own model and project.
    const ConfigLoader = await arrangeProfileP({ baseUrl: 'https://t2', provider: 'x', codeMieProject: extra.project, model: 'm-dir' });
    const { checkStatus, seedConnectionRecord, spawnDaemon, stopDaemon, writeConnectionRecord, writeState } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');
    const older = {
      pid: 4242, port: 52311, url: 'http://127.0.0.1:52311', profile: 'p', targetUrl: 'https://t2', provider: 'x',
      startedAt: new Date().toISOString(), ...extra,
    };
    const { readState } = await import('../daemon-manager.js');
    vi.mocked(checkStatus).mockResolvedValue({ running: true, state: older });
    vi.mocked(readState).mockResolvedValue(older);
    const replaced = { ...older, pid: 5151, version: '0.17.0' };
    vi.mocked(spawnDaemon).mockResolvedValue(replaced);

    try {
      await createProxyCommand().parseAsync(['start', ...args], { from: 'user' });
    } finally {
      vi.mocked(ConfigLoader.resolveProfileIdentity).mockReset();
      vi.mocked(readState).mockReset();
    }

    expect(stopDaemon).toHaveBeenCalled();
    expect(writeState).toHaveBeenCalledWith(older);
    const { pid: _pid, url: _url, startedAt: _startedAt, ...values } = older;
    expect(vi.mocked(spawnDaemon).mock.calls[0][0]).toEqual({ ...values, writeRecord: false });
    if (args.length > 0) {
      expect(writeConnectionRecord).toHaveBeenCalledWith(replaced, 'p');
    } else {
      expect(seedConnectionRecord).toHaveBeenCalledWith(replaced);
      expect(writeConnectionRecord).not.toHaveBeenCalled();
    }
  });

  it('--profile p --port 4100 over a matching older daemon on 4100 records the profile, then the port', async () => {
    const ConfigLoader = await arrangeProfileP({ baseUrl: 'https://t2', provider: 'x', codeMieProject: undefined, model: 'm-dir' });
    const { checkStatus, readState, spawnDaemon, writeConnectionPort, writeConnectionRecord } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');
    const older = {
      pid: 4242, port: 4100, url: 'http://127.0.0.1:4100', profile: 'p', targetUrl: 'https://t2', provider: 'x',
      startedAt: new Date().toISOString(), model: 'm1', gatewayKey: 'k',
    };
    vi.mocked(checkStatus).mockResolvedValue({ running: true, state: older });
    vi.mocked(readState).mockResolvedValue(older);
    const replaced = { ...older, pid: 5151, version: '0.17.0' };
    vi.mocked(spawnDaemon).mockResolvedValue(replaced);

    try {
      await createProxyCommand().parseAsync(['start', '--profile', 'p', '--port', '4100'], { from: 'user' });
    } finally {
      vi.mocked(ConfigLoader.resolveProfileIdentity).mockReset();
      vi.mocked(readState).mockReset();
    }

    expect(writeConnectionRecord).toHaveBeenCalledWith(replaced, 'p');
    expect(writeConnectionPort).toHaveBeenCalledWith(4100);
    expect(vi.mocked(writeConnectionRecord).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(writeConnectionPort).mock.invocationCallOrder[0]);
  });

  it('writes no record when the replacement of an older daemon fails to spawn', async () => {
    const ConfigLoader = await arrangeProfileP({ baseUrl: 'https://t2', provider: 'x', codeMieProject: undefined, model: 'm-dir' });
    const { checkStatus, readState, seedConnectionRecord, spawnDaemon, writeConnectionPort, writeConnectionRecord } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');
    const older = {
      pid: 4242, port: 52311, url: 'http://127.0.0.1:52311', profile: 'p', targetUrl: 'https://t2', provider: 'x',
      startedAt: new Date().toISOString(), model: 'm1', gatewayKey: 'k',
    };
    vi.mocked(checkStatus).mockResolvedValue({ running: true, state: older });
    vi.mocked(readState).mockResolvedValue(older);
    vi.mocked(spawnDaemon).mockRejectedValue(new Error('spawn failed'));

    try {
      await expect(
        createProxyCommand().parseAsync(['start', '--profile', 'p'], { from: 'user' })
      ).rejects.toThrow('process.exit:1');
      expect(spawnDaemon).toHaveBeenCalled();
    } finally {
      vi.mocked(ConfigLoader.resolveProfileIdentity).mockReset();
      vi.mocked(readState).mockReset();
      vi.mocked(spawnDaemon).mockReset();
    }

    expect(writeConnectionRecord).not.toHaveBeenCalled();
    expect(seedConnectionRecord).not.toHaveBeenCalled();
    expect(writeConnectionPort).not.toHaveBeenCalled();
  });

  it.each([
    ['records it once the daemon runs on it', 4100, true],
    ['records nothing when the daemon fell back to another port', 60122, false],
  ])('--port 4100 over a record of 52311 asks for 4100 and %s', async (_label, upOn, recorded) => {
    await arrangeProfileP();
    const { checkStatus, readConnectionRecord, spawnDaemon, writeConnectionPort } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(readConnectionRecord).mockResolvedValue({ version: 1, profile: 'p', updatedAt: '', port: 52311 });
    vi.mocked(spawnDaemon).mockResolvedValue({ pid: 5151, port: upOn, url: `http://127.0.0.1:${upOn}`, profile: 'p', gatewayKey: 'codemie-proxy', startedAt: '' });

    try {
      await createProxyCommand().parseAsync(['start', '--port', '4100'], { from: 'user' });
    } finally {
      vi.mocked(readConnectionRecord).mockReset();
    }

    expect(spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({ port: 4100 }));
    expect(vi.mocked(writeConnectionPort).mock.calls.length > 0).toBe(recorded);
    if (recorded) expect(writeConnectionPort).toHaveBeenCalledWith(4100);
  });

  it('asks for the port recorded with the clients', async () => {
    await arrangeProfileP();
    const { checkStatus, readConnectionRecord, spawnDaemon } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(readConnectionRecord).mockResolvedValue({ version: 1, profile: 'p', updatedAt: '', port: 52311 });
    vi.mocked(spawnDaemon).mockResolvedValue({ pid: 5151, port: 52311, url: 'http://127.0.0.1:52311', profile: 'p', gatewayKey: 'codemie-proxy', startedAt: '' });

    try {
      await createProxyCommand().parseAsync(['start'], { from: 'user' });
    } finally {
      vi.mocked(readConnectionRecord).mockReset();
    }

    expect(spawnDaemon).toHaveBeenCalledWith(expect.objectContaining({ port: 52311 }));
  });

  describe('start writes the connection record', () => {
    const validRecord = { version: 1 as const, profile: 'recorded', updatedAt: new Date().toISOString() };

    const setupStart = async (record: typeof validRecord | null) => {
      const { ConfigLoader } = await import('../../../../utils/config.js');
      const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
      const daemon = await import('../daemon-manager.js');
      const { createProxyCommand } = await import('../index.js');

      vi.mocked(daemon.checkStatus).mockResolvedValue({ running: false, state: null });
      vi.mocked(daemon.readConnectionRecord).mockResolvedValue(record);
      vi.mocked(ConfigLoader.load).mockImplementation(async (_cwd, options) => ({
        name: (options as { name?: string } | undefined)?.name ?? 'default',
        provider: 'ai-run-sso',
        baseUrl: 'https://example.com/api',
      }) as Awaited<ReturnType<typeof ConfigLoader.load>>);
      vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
        return { getStoredCredentials: vi.fn().mockResolvedValue({ token: 'tok' }) };
      } as unknown as typeof CodeMieSSO);
      vi.mocked(daemon.spawnDaemon).mockImplementation(async opts => ({
        url: 'http://127.0.0.1:4001',
        profile: opts.profile,
        port: 4001,
        gatewayKey: 'local-key',
        startedAt: new Date().toISOString(),
      }));

      return { daemon, command: createProxyCommand() };
    };

    it('writes the record when --profile is given, even if a valid record exists', async () => {
      const { daemon, command } = await setupStart(validRecord);

      await command.parseAsync(['start', '--profile', 'custom'], { from: 'user' });

      expect(vi.mocked(daemon.spawnDaemon).mock.calls[0][0]).toMatchObject({ writeRecord: true });
    });

    it('writes the record when there is no --profile and no valid record', async () => {
      const { daemon, command } = await setupStart(null);

      await command.parseAsync(['start'], { from: 'user' });

      expect(vi.mocked(daemon.spawnDaemon).mock.calls[0][0]).toMatchObject({ writeRecord: true });
    });

    it('leaves the record alone when there is no --profile and a valid record exists', async () => {
      const { daemon, command } = await setupStart(validRecord);

      await command.parseAsync(['start'], { from: 'user' });

      expect(vi.mocked(daemon.spawnDaemon).mock.calls[0][0]).toMatchObject({ writeRecord: false });
    });

    const printedLines = (): string[] => consoleLogSpy.mock.calls.map((call: unknown[]) => String(call[0]));

    /** A daemon of a current CLI already running for `profile` with the key `local-key` on port 4001. */
    const runningDefault = (profile = 'default') => ({
      pid: process.pid,
      port: 4001,
      url: 'http://127.0.0.1:4001',
      profile,
      gatewayKey: 'local-key',
      provider: 'ai-run-sso',
      targetUrl: 'https://example.com/api',
      version: '0.17.0',
      startedAt: new Date().toISOString(),
    });

    it('start --profile moves Codex, the VS Code Claude Code extension and Desktop off the shared key and drops the record\'s older identity', async () => {
      const { daemon, command } = await setupStart(validRecord);
      const files = await arrangeClientFiles(clientHome, OLDER_RECORD, 'local-key');

      await command.parseAsync(['start', '--profile', 'custom'], { from: 'user' });

      expect(vi.mocked(daemon.spawnDaemon).mock.calls[0][0]).toMatchObject({ profile: 'custom', writeRecord: true });
      await expectMovedToNamedKeys(files, 'local-key', printedLines());
    });

    it('start over a matching daemon already running moves the clients off the shared key', async () => {
      const { daemon, command } = await setupStart(validRecord);
      vi.mocked(daemon.checkStatus).mockResolvedValue({ running: true, state: runningDefault() });
      const files = await arrangeClientFiles(clientHome, OLDER_RECORD, 'local-key');

      await command.parseAsync(['start'], { from: 'user' });

      expect(daemon.spawnDaemon).not.toHaveBeenCalled();
      await expectMovedToNamedKeys(files, 'local-key', printedLines());
    });

    it.each([
      ['a current version', '0.17.0'],
      ['an older version', '0.16.0'],
      ['no version', undefined],
    ])('start over a daemon of another profile with %s ends in the conflict, stops or spawns nothing and leaves every client config and the record byte for byte', async (_case, version) => {
      const { daemon, command } = await setupStart(validRecord);
      const { version: _version, ...state } = runningDefault('other');
      vi.mocked(daemon.checkStatus).mockResolvedValue({
        running: true,
        state: version === undefined ? state : { ...state, version },
      });
      const files = await arrangeClientFiles(clientHome, OLDER_RECORD, 'local-key');
      const before = await Promise.all(Object.values(files).map((path) => readFile(path, 'utf-8')));

      await expect(command.parseAsync(['start'], { from: 'user' })).rejects.toThrow('process.exit:1');

      expect(consoleErrorSpy).toHaveBeenCalledWith(chalk.red([
        '✗ A proxy is already running with different settings:',
        '  profile: other',
        '  port: 4001',
        '',
        'Stop it first:',
        '  codemie proxy stop',
      ].join('\n')));
      expect(daemon.stopDaemon).not.toHaveBeenCalled();
      expect(daemon.spawnDaemon).not.toHaveBeenCalled();
      expect(await Promise.all(Object.values(files).map((path) => readFile(path, 'utf-8')))).toEqual(before);
    });

    it('start over a daemon whose state holds no version replaces it and moves the clients with the replacement\'s key and port', async () => {
      const { daemon, command } = await setupStart(validRecord);
      // The replaced daemon holds a key of its own: only a move made with the replacement's state finds the configs.
      const { version: _version, ...older } = { ...runningDefault(), gatewayKey: 'old-key' };
      vi.mocked(daemon.checkStatus).mockResolvedValue({ running: true, state: older });
      const files = await arrangeClientFiles(clientHome, OLDER_RECORD, 'local-key');

      await command.parseAsync(['start'], { from: 'user' });

      expect(daemon.stopDaemon).toHaveBeenCalled();
      expect(vi.mocked(daemon.spawnDaemon).mock.calls[0][0]).toMatchObject({ port: 4001, gatewayKey: 'old-key' });
      await expectMovedToNamedKeys(files, 'local-key', printedLines());
    });

    it('start that finds no daemon at the first read and the matching one under the lock moves the clients', async () => {
      const { daemon, command } = await setupStart(validRecord);
      vi.mocked(daemon.readDaemonStatus).mockResolvedValueOnce({ running: false, state: null });
      vi.mocked(daemon.checkStatus).mockResolvedValue({ running: true, state: runningDefault() });
      const files = await arrangeClientFiles(clientHome, OLDER_RECORD, 'local-key');

      await command.parseAsync(['start'], { from: 'user' });

      expect(daemon.stopDaemon).not.toHaveBeenCalled();
      expect(daemon.spawnDaemon).not.toHaveBeenCalled();
      expect(printedLines()).toContain(chalk.green('✓ Proxy already running at http://127.0.0.1:4001  (profile: default)'));
      await expectMovedToNamedKeys(files, 'local-key', printedLines());
    });

    it.skipIf(process.platform === 'win32')('start beside a Codex config it cannot write warns once, moves the other clients, the exit code unchanged', async () => {
      if (process.getuid?.() === 0) return; // root bypasses file-mode permission checks; nothing to assert here.
      const { command } = await setupStart(validRecord);
      const files = await arrangeClientFiles(clientHome, OLDER_RECORD, 'local-key');
      const codex = await readFile(files.codex, 'utf-8');
      const exitCode = process.exitCode;

      await chmod(dirname(files.codex), 0o555);
      try {
        await command.parseAsync(['start', '--profile', 'custom'], { from: 'user' });
      } finally {
        await chmod(dirname(files.codex), 0o755);
      }

      expect(printedLines()).toContain(chalk.green('✓ Proxy running at http://127.0.0.1:4001  (profile: custom)'));
      expect(printedLines().filter((line) => line.includes('Codex desktop'))).toEqual([
        expect.stringMatching(/Warning: could not move Codex desktop to its own key: .*EACCES/),
      ]);
      expect(await readFile(files.codex, 'utf-8')).toBe(codex);
      expect(JSON.parse(await readFile(files.vscode, 'utf-8'))['claudeCode.environmentVariables']).toContainEqual(
        { name: 'ANTHROPIC_AUTH_TOKEN', value: 'local-key.vscode-claude-code' }
      );
      expect(JSON.parse(await readFile(files.desktop, 'utf-8')).inferenceGatewayApiKey).toBe('local-key.claude-desktop');
      expect(process.exitCode).toBe(exitCode);
    });

    it('start with no client config and a record without the older identity prints its own lines alone', async () => {
      const { command } = await setupStart(validRecord);
      const files = await arrangeClientFiles(clientHome, { version: 1, profile: 'work', updatedAt: '' });
      const record = await readFile(files.record, 'utf-8');

      await command.parseAsync(['start', '--profile', 'custom'], { from: 'user' });

      expect(printedLines()).toEqual([
        'Starting proxy daemon...',
        chalk.green('✓ Proxy running at http://127.0.0.1:4001  (profile: custom)'),
      ]);
      expect(await readFile(files.record, 'utf-8')).toBe(record);
    });

    it('seeds the record from the daemon already running and spawns nothing', async () => {
      const { daemon, command } = await setupStart(validRecord);
      const running = {
        pid: process.pid,
        port: 4001,
        url: 'http://127.0.0.1:4001',
        profile: 'default',
        gatewayKey: 'local-key',
        provider: 'ai-run-sso',
        targetUrl: 'https://example.com/api',
        clientType: 'codemie-daemon',
        version: '0.17.0',
        startedAt: new Date().toISOString(),
      };
      vi.mocked(daemon.checkStatus).mockResolvedValue({ running: true, state: running });
      const { syncRegisteredSkills } = await import('../../../../cli/commands/skills/setup/sync.js');

      await withHeldLock(() => command.parseAsync(['start'], { from: 'user' }));

      expect(daemon.seedConnectionRecord).toHaveBeenCalledWith(running);
      expect(daemon.spawnDaemon).not.toHaveBeenCalled();
      // A matching current daemon ends the command before the preparation and the lock.
      expect(syncRegisteredSkills).not.toHaveBeenCalled();
    });

    it('rewrites the record for the running daemon when --profile is given, even if a valid record exists', async () => {
      const { daemon, command } = await setupStart(validRecord);
      const running = {
        pid: process.pid,
        port: 4001,
        url: 'http://127.0.0.1:4001',
        profile: 'custom',
        gatewayKey: 'local-key',
        provider: 'ai-run-sso',
        targetUrl: 'https://example.com/api',
        clientType: 'codemie-daemon',
        version: '0.17.0',
        startedAt: new Date().toISOString(),
      };
      vi.mocked(daemon.checkStatus).mockResolvedValue({ running: true, state: running });

      await command.parseAsync(['start', '--profile', 'custom'], { from: 'user' });

      expect(daemon.writeConnectionRecord).toHaveBeenCalledWith(running, 'custom');
      expect(daemon.seedConnectionRecord).not.toHaveBeenCalled();
      expect(daemon.spawnDaemon).not.toHaveBeenCalled();
    });
  });
});

describe('proxy stop', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('waits for the lock another start holds, then stops the daemon that start left running', async () => {
    const { checkStatus, stopDaemon } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');
    const started = { pid: 5151, port: 4001, url: 'http://127.0.0.1:4001', profile: 'p', gatewayKey: 'k', startedAt: '' };
    const lockAtRead: boolean[] = [];

    await withHeldLock(async (lockPath) => {
      vi.mocked(checkStatus).mockImplementation(async () => {
        // The lock this stop holds names its own start time; the other holder's names none.
        lockAtRead.push(JSON.parse(await readFile(lockPath, 'utf-8')).startedAt !== undefined);
        return { running: true, state: started };
      });
      await createProxyCommand().parseAsync(['stop'], { from: 'user' });
      expect(existsSync(lockPath)).toBe(false);
    }, 3);

    expect(lockAtRead).toEqual([true]);
    expect(stopDaemon).toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(chalk.green('✓ Proxy stopped'));
  });
});

describe('proxy inspect desktop', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  /** No daemon alive; the state file is read from `clientHome`, written there when `kept` is given. */
  async function inspectWithoutDaemon(kept?: Record<string, unknown>) {
    const statePath = join(clientHome, 'proxy-daemon.json');
    if (kept) await writeFile(statePath, JSON.stringify(kept));
    const daemon = await import('../daemon-manager.js');
    const actual = await vi.importActual<typeof import('../daemon-manager.js')>('../daemon-manager.js');
    vi.mocked(daemon.checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(daemon.readState).mockImplementation(() => actual.readState(statePath));
    const { printDesktopInspection } = await import('../inspect-desktop.js');
    const { createProxyCommand } = await import('../index.js');

    await createProxyCommand().parseAsync(['inspect', 'desktop'], { from: 'user' });

    return vi.mocked(printDesktopInspection).mock.calls;
  }

  it('reads the kept state of a daemon that is not running', async () => {
    const kept = { pid: 4242, port: 4001, url: 'http://127.0.0.1:4001', profile: 'p', gatewayKey: 'k', startedAt: '2026-11-17T00:00:00.000Z' };

    expect(await inspectWithoutDaemon(kept)).toEqual([[false, kept, { limit: 5 }]]);
  });

  it('reads no state when there is no state file', async () => {
    expect(await inspectWithoutDaemon()).toEqual([[false, null, { limit: 5 }]]);
  });
});

describe('proxy connect vscode', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit:${code}`);
    });

    const { ProviderRegistry } = await import('../../../../providers/index.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const { writeVsCodeLanguageModelsConfig } = await import('../connectors/vscode.js');
    vi.mocked(ProviderRegistry.getProvider).mockReturnValue({
      name: 'ai-run-sso',
      authType: 'sso',
    } as ReturnType<typeof ProviderRegistry.getProvider>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockResolvedValue({ token: 'tok' }) };
    } as unknown as typeof CodeMieSSO);
    vi.mocked(writeVsCodeLanguageModelsConfig).mockResolvedValue({
      configPath: '/mock/chatLanguageModels.json',
      requiresSecretConfiguration: false,
      modelCount: 5,
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('uses an explicit profile without requiring its model for VS Code', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
    const { writeVsCodeLanguageModelsConfig } = await import('../connectors/vscode.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'custom',
      provider: 'ai-run-sso',
      baseUrl: 'https://custom.example.com/api',
      codeMieProject: 'team-project',
      codeMieUrl: 'https://custom.example.com',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });
    vi.mocked(spawnDaemon).mockResolvedValue({
      pid: process.pid,
      port: 4001,
      url: 'http://127.0.0.1:4001',
      profile: 'custom',
      gatewayKey: 'local-key',
      provider: 'ai-run-sso',
      targetUrl: 'https://custom.example.com/api',
      project: 'team-project',
      clientType: 'vscode-byok',
      startedAt: new Date().toISOString(),
    });

    await createProxyCommand().parseAsync(
      ['connect', 'vscode', '--profile', 'custom'],
      { from: 'user' }
    );

    expect(ConfigLoader.load).toHaveBeenCalledWith(process.cwd(), { name: 'custom' });
    const daemonOptions = vi.mocked(spawnDaemon).mock.calls[0][0];
    expect(daemonOptions).toMatchObject({
      profile: 'custom',
      project: 'team-project',
    });
    expect(daemonOptions).not.toHaveProperty('clientType');
    expect(daemonOptions).not.toHaveProperty('model');
    expect(writeVsCodeLanguageModelsConfig).toHaveBeenCalledWith(
      'http://127.0.0.1:4001',
      'local-key',
      false,
      'team-project'
    );
  });

  it('reuses a matching daemon when the profile model is unchanged', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { checkStatus, spawnDaemon, stopDaemon } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    const { writeVsCodeLanguageModelsConfig } = await import('../connectors/vscode.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'custom',
      provider: 'ai-run-sso',
      baseUrl: 'https://custom.example.com/api',
      model: 'shared-profile-model',
      codeMieProject: 'team-project',
      codeMieUrl: 'https://custom.example.com',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: {
        pid: process.pid,
        port: 4001,
        url: 'http://127.0.0.1:4001',
        profile: 'custom',
        gatewayKey: 'local-key',
        provider: 'ai-run-sso',
        targetUrl: 'https://custom.example.com/api',
        project: 'team-project',
        model: 'shared-profile-model',
        clientType: 'vscode-byok',
        version: '0.17.0',
        startedAt: new Date().toISOString(),
      },
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'deep', code: 'ok' });

    await createProxyCommand().parseAsync(['connect', 'vscode', '--profile', 'custom'], { from: 'user' });

    expect(stopDaemon).not.toHaveBeenCalled();
    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(writeVsCodeLanguageModelsConfig).toHaveBeenCalledWith(
      'http://127.0.0.1:4001',
      'local-key',
      false,
      'team-project'
    );
  });

  it('restarts a matching daemon when the profile model changed', async () => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { checkStatus, spawnDaemon, stopDaemon } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'custom',
      provider: 'ai-run-sso',
      baseUrl: 'https://custom.example.com/api',
      model: 'new-profile-model',
      codeMieProject: 'team-project',
      codeMieUrl: 'https://custom.example.com',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: {
        pid: process.pid,
        port: 4001,
        url: 'http://127.0.0.1:4001',
        profile: 'custom',
        gatewayKey: 'local-key',
        provider: 'ai-run-sso',
        targetUrl: 'https://custom.example.com/api',
        project: 'team-project',
        model: 'old-profile-model',
        clientType: 'vscode-byok',
        startedAt: new Date().toISOString(),
      },
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'deep', code: 'ok' });
    vi.mocked(spawnDaemon).mockResolvedValue({
      pid: process.pid,
      port: 4001,
      url: 'http://127.0.0.1:4001',
      profile: 'custom',
      gatewayKey: 'local-key',
      clientType: 'vscode-byok',
      model: 'new-profile-model',
      startedAt: new Date().toISOString(),
    } as Awaited<ReturnType<typeof spawnDaemon>>);

    await createProxyCommand().parseAsync(['connect', 'vscode', '--profile', 'custom'], { from: 'user' });

    expect(stopDaemon).toHaveBeenCalled();
    expect(spawnDaemon).toHaveBeenCalled();
  });

});

describe('proxy status', () => {
  afterEach(async () => {
    const { getCommandPath } = await import('@/utils/processes.js');
    vi.mocked(getCommandPath).mockResolvedValue(null);
  });

  it('shows the version and project context, and no client', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { checkStatus } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: {
        pid: process.pid,
        port: 4001,
        url: 'http://127.0.0.1:4001',
        profile: 'work',
        gatewayKey: 'local-key',
        // A state file of this daemon still holds its default client for an older CLI; nothing here reads it.
        clientType: 'vscode-byok',
        project: 'team-project',
        version: '0.17.0',
        startedAt: new Date().toISOString(),
      } as Awaited<ReturnType<typeof checkStatus>>['state'],
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'shallow', code: 'ok' });

    await createProxyCommand().parseAsync(['status'], { from: 'user' });

    expect(consoleLogSpy).toHaveBeenCalledWith('  Version: 0.17.0');
    expect(consoleLogSpy).toHaveBeenCalledWith('  Project: team-project');
    const lines = consoleLogSpy.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.startsWith('  Client:'))).toBe(false);
    consoleLogSpy.mockRestore();
  });

  it('shows the API key', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { checkStatus } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: {
        pid: process.pid,
        port: 4001,
        url: 'http://127.0.0.1:4001',
        profile: 'work',
        gatewayKey: 'local-key',
        startedAt: new Date().toISOString(),
      },
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'shallow', code: 'ok' });

    await createProxyCommand().parseAsync(['status'], { from: 'user' });

    expect(consoleLogSpy).toHaveBeenCalledWith('  API Key: local-key');
    expect(consoleLogSpy).toHaveBeenCalledWith('  Client keys: local-key.<client> — written by codemie proxy connect');
    consoleLogSpy.mockRestore();
  });

  it('emits JSON when --json is passed (running, healthy)', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { checkStatus } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: {
        pid: process.pid,
        port: 4001,
        url: 'http://127.0.0.1:4001',
        profile: 'work',
        gatewayKey: 'local-key',
        clientType: 'vscode-byok',
        project: 'team-project',
        version: '0.17.0',
        startedAt: new Date().toISOString(),
      } as Awaited<ReturnType<typeof checkStatus>>['state'],
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'shallow', code: 'ok' });

    await createProxyCommand().parseAsync(['status', '--json'], { from: 'user' });

    const printed = consoleLogSpy.mock.calls.map((call) => call[0]).join('\n');
    const payload = JSON.parse(printed);
    expect(payload).toEqual({
      status: 'healthy',
      apiKey: 'local-key',
      url: 'http://127.0.0.1:4001',
      port: 4001,
      profile: 'work',
      project: 'team-project',
      uptimeSec: payload.uptimeSec,
      level: 'shallow',
      version: '0.17.0',
    });
    expect(typeof payload.uptimeSec).toBe('number');
    consoleLogSpy.mockRestore();
  });

  it('emits JSON with a reason when unhealthy', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { checkStatus } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: {
        pid: process.pid,
        port: 4001,
        url: 'http://127.0.0.1:4001',
        profile: 'work',
        gatewayKey: 'local-key',
        startedAt: new Date().toISOString(),
      },
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({
      healthy: false,
      level: 'shallow',
      code: 'unreachable',
      reason: 'connection refused',
    });

    await createProxyCommand().parseAsync(['status', '--json'], { from: 'user' });

    const payload = JSON.parse(consoleLogSpy.mock.calls.map((call) => call[0]).join('\n'));
    expect(payload.status).toBe('unhealthy');
    expect(payload.reason).toBe('connection refused');
    consoleLogSpy.mockRestore();
  });

  it('emits JSON with level "deep" when --deep is passed', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { checkStatus } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: {
        pid: process.pid,
        port: 4001,
        url: 'http://127.0.0.1:4001',
        profile: 'work',
        gatewayKey: 'local-key',
        startedAt: new Date().toISOString(),
      },
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'deep', code: 'ok' });

    await createProxyCommand().parseAsync(['status', '--deep', '--json'], { from: 'user' });

    const payload = JSON.parse(consoleLogSpy.mock.calls.map((call) => call[0]).join('\n'));
    expect(payload.level).toBe('deep');
    consoleLogSpy.mockRestore();
  });

  it('emits { status: "stopped" } JSON when the daemon is not running', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { checkStatus } = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });

    await createProxyCommand().parseAsync(['status', '--json'], { from: 'user' });

    expect(consoleLogSpy).toHaveBeenCalledWith(JSON.stringify({ status: 'stopped' }, null, 2));
    consoleLogSpy.mockRestore();
  });

  it('emits lastRecordedIssue in JSON when a prior unhealthy state recovered', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { checkStatus } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: {
        pid: process.pid,
        port: 4001,
        url: 'http://127.0.0.1:4001',
        profile: 'work',
        gatewayKey: 'local-key',
        startedAt: new Date().toISOString(),
        health: 'unhealthy',
        healthReason: 'timed out once',
      },
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'shallow', code: 'ok' });

    await createProxyCommand().parseAsync(['status', '--json'], { from: 'user' });

    const payload = JSON.parse(consoleLogSpy.mock.calls.map((call) => call[0]).join('\n'));
    expect(payload.status).toBe('healthy');
    expect(payload.lastRecordedIssue).toBe('timed out once');
    consoleLogSpy.mockRestore();
  });

  it('--deep over a recorded issue and a passing check prints no stale issue and writes no state', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { checkStatus, writeState } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: {
        pid: process.pid,
        port: 4001,
        url: 'http://127.0.0.1:4001',
        profile: 'work',
        gatewayKey: 'local-key',
        startedAt: new Date().toISOString(),
        health: 'unhealthy',
        healthReason: 'timed out once',
      },
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'deep', code: 'ok' });

    await createProxyCommand().parseAsync(['status', '--deep'], { from: 'user' });

    const output = consoleLogSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('running, healthy (upstream OK)');
    expect(output).not.toContain('last recorded issue');
    expect(writeState).not.toHaveBeenCalled();
    consoleLogSpy.mockRestore();
  });

  it('leaves the default (non-JSON) output byte-identical aside from the new API Key line', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { checkStatus } = await import('../daemon-manager.js');
    const { checkProxyHealth } = await import('../health-check.js');
    const { createProxyCommand } = await import('../index.js');
    vi.mocked(checkStatus).mockResolvedValue({
      running: true,
      state: {
        pid: process.pid,
        port: 4001,
        url: 'http://127.0.0.1:4001',
        profile: 'work',
        gatewayKey: 'local-key',
        startedAt: new Date().toISOString(),
      },
    });
    vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'shallow', code: 'ok' });

    await createProxyCommand().parseAsync(['status'], { from: 'user' });

    const lines = consoleLogSpy.mock.calls.map((call) => call[0]);
    expect(lines).toContain('  URL:     http://127.0.0.1:4001');
    expect(lines).toContain('  Port:    4001');
    expect(lines).toContain('  API Key: local-key');
    expect(lines).toContain('  Profile: work');
    consoleLogSpy.mockRestore();
  });

  describe('Analytics line', () => {
    const analyticsState = {
      pid: process.pid,
      port: 4001,
      url: 'http://127.0.0.1:4001',
      profile: 'work',
      gatewayKey: 'local-key',
      version: '0.17.0',
      startedAt: new Date().toISOString(),
    };
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;

    async function runStatus(args: string[]): Promise<string[]> {
      const { createProxyCommand } = await import('../index.js');
      await createProxyCommand().parseAsync(args, { from: 'user' });
      return consoleLogSpy.mock.calls.map((call) => String(call[0]));
    }

    async function arrange(options: {
      connectorActive: boolean;
      delivery: { status: 'healthy' | 'unhealthy' | 'unknown'; reason?: string; pendingBytes: number };
      reply?: { credentials: 'ok' | 'stale' };
    }): Promise<void> {
      const { checkStatus } = await import('../daemon-manager.js');
      const { checkProxyHealth } = await import('../health-check.js');
      const { hasActiveAnalyticsConnector } = await import('../analytics-connectors.js');
      const { collectDeliveryHealth } = await import('../delivery-health.js');
      vi.mocked(checkStatus).mockResolvedValue({ running: true, state: analyticsState });
      vi.mocked(checkProxyHealth).mockResolvedValue({
        healthy: true,
        level: 'shallow',
        code: 'ok',
        ...(options.reply ? { analytics: options.reply } : {}),
      });
      vi.mocked(hasActiveAnalyticsConnector).mockResolvedValue(options.connectorActive);
      vi.mocked(collectDeliveryHealth).mockResolvedValue(
        options.delivery as Awaited<ReturnType<typeof collectDeliveryHealth>>
      );
    }

    beforeEach(() => {
      consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    it('prints a green healthy line after Uptime when a connector is active', async () => {
      await arrange({ connectorActive: true, delivery: { status: 'healthy', pendingBytes: 0 }, reply: { credentials: 'ok' } });

      const lines = await runStatus(['status']);

      const uptimeIndex = lines.findIndex((line) => line.startsWith('  Uptime:'));
      expect(uptimeIndex).toBeGreaterThan(-1);
      expect(lines[uptimeIndex + 1]).toBe(`Analytics: ${chalk.green('healthy')}`);
      expect(lines.some((line) => line.includes('Run:'))).toBe(false);

      const { checkProxyHealth } = await import('../health-check.js');
      const { collectDeliveryHealth } = await import('../delivery-health.js');
      expect(checkProxyHealth).toHaveBeenCalledWith(expect.objectContaining({ expectedPid: analyticsState.pid }));
      expect(collectDeliveryHealth).toHaveBeenCalledWith(analyticsState, { credentials: 'ok' });
    });

    it('prints the analytics line before the Claude Code OTLP warning', async () => {
      await arrange({ connectorActive: true, delivery: { status: 'healthy', pendingBytes: 0 }, reply: { credentials: 'ok' } });
      const { checkClaudeCodeOtlpEndpoint } = await import('../connectors/claude-code-otlp-endpoint.js');
      vi.mocked(checkClaudeCodeOtlpEndpoint).mockResolvedValueOnce({
        configured: 'http://127.0.0.1:9999',
        expected: 'http://127.0.0.1:4001',
        matches: false,
      } as Awaited<ReturnType<typeof checkClaudeCodeOtlpEndpoint>>);

      const lines = await runStatus(['status']);

      const analyticsIndex = lines.findIndex((line) => line.startsWith('Analytics:'));
      const warningIndex = lines.findIndex((line) => line.includes('Warning:'));
      expect(analyticsIndex).toBeGreaterThan(-1);
      expect(warningIndex).toBeGreaterThan(analyticsIndex);
    });

    it.each([
      ['credentials_expired', 'CodeMie sign-in has expired', 'codemie profile login'],
      ['auth_rejected', 'CodeMie asked you to sign in again', 'codemie profile login'],
      [
        'identity_mismatch',
        "analytics destination doesn't match your signed-in account — affects all sessions on this computer",
        'codemie proxy restart',
      ],
    ])('prints a yellow unhealthy line and a Run tip for %s', async (reason, label, run) => {
      await arrange({
        connectorActive: true,
        delivery: { status: 'unhealthy', reason, pendingBytes: 10 },
        reply: { credentials: 'stale' },
      });

      const lines = await runStatus(['status']);

      const index = lines.indexOf(`Analytics: ${chalk.yellow(`unhealthy (${label})`)}`);
      expect(index).toBeGreaterThan(-1);
      expect(lines[index + 1]).toBe(`  Run: ${run}`);
    });

    it('prints a yellow unhealthy line and no Run tip for send_failed, which the user cannot act on', async () => {
      await arrange({
        connectorActive: true,
        delivery: { status: 'unhealthy', reason: 'send_failed', pendingBytes: 10 },
        reply: { credentials: 'ok' },
      });

      const lines = await runStatus(['status']);

      const index = lines.indexOf(`Analytics: ${chalk.yellow('unhealthy (last send to CodeMie failed, retrying)')}`);
      expect(index).toBeGreaterThan(-1);
      expect(lines.some((line) => line.includes('Run:'))).toBe(false);
    });

    it('prints a dim unknown line with no Run tip when the daemon sent no analytics block', async () => {
      await arrange({ connectorActive: true, delivery: { status: 'unknown', pendingBytes: 0 } });

      const lines = await runStatus(['status']);

      const index = lines.indexOf(`Analytics: ${chalk.dim('unknown (restart the proxy to enable all checks)')}`);
      expect(index).toBeGreaterThan(-1);
      expect(lines[index + 1]?.trimStart().startsWith('Run:') ?? false).toBe(false);
      const { collectDeliveryHealth } = await import('../delivery-health.js');
      expect(collectDeliveryHealth).toHaveBeenCalledWith(analyticsState, undefined);
    });

    it('prints a dim unknown line naming the unreadable local data, not a restart, when the spool is incomplete', async () => {
      await arrange({ connectorActive: true, delivery: { status: 'unknown', incomplete: true }, reply: { credentials: 'ok' } });

      const lines = await runStatus(['status']);

      expect(lines).toContain(`Analytics: ${chalk.dim('unknown (local analytics data could not be read)')}`);
      expect(lines.some((line) => line.includes('restart the proxy'))).toBe(false);
    });

    it('hides the line when nothing is connected, even if the spool holds unsent data', async () => {
      await arrange({ connectorActive: false, delivery: { status: 'healthy', pendingBytes: 2048 } });

      const lines = await runStatus(['status']);

      expect(lines.some((line) => line.startsWith('Analytics:'))).toBe(false);
      expect(lines.some((line) => line.includes('Run:'))).toBe(false);
    });

    it('hides the line and keeps the default output unchanged when nothing is connected or pending', async () => {
      await arrange({ connectorActive: false, delivery: { status: 'unhealthy', reason: 'send_failed', pendingBytes: 0 } });

      const lines = await runStatus(['status']);

      expect(lines).toEqual([
        `Status:  ${chalk.green('running, healthy')}`,
        '  URL:     http://127.0.0.1:4001',
        '  Port:    4001',
        '  API Key: local-key',
        '  Client keys: local-key.<client> — written by codemie proxy connect',
        '  Profile: work',
        '  Version: 0.17.0',
        lines[7],
      ]);
      expect(lines[7]).toMatch(/^ {2}Uptime: {2}\d+s$/);
    });

    it('adds analytics to the JSON payload when a connector is active', async () => {
      await arrange({
        connectorActive: true,
        delivery: {
          status: 'unhealthy',
          reason: 'send_failed',
          pendingBytes: 5,
          sendFailure: { nextAt: 1_800_000_000_000, detail: 'http_503' },
        },
        reply: { credentials: 'ok' },
      });

      const lines = await runStatus(['status', '--json']);

      const payload = JSON.parse(lines.join('\n'));
      expect(payload.analytics).toEqual({
        status: 'unhealthy',
        reason: 'send_failed',
        pendingBytes: 5,
        sendFailure: { nextAt: 1_800_000_000_000, detail: 'http_503' },
      });
      expect(payload.status).toBe('healthy');
      expect(payload.apiKey).toBe('local-key');
      expect(payload.level).toBe('shallow');
    });

    it('omits analytics from the JSON payload when nothing is connected', async () => {
      await arrange({ connectorActive: false, delivery: { status: 'unknown', pendingBytes: 0 } });

      const lines = await runStatus(['status', '--json']);

      expect(JSON.parse(lines.join('\n'))).not.toHaveProperty('analytics');
    });

    it('omits analytics from the JSON payload when nothing is connected, even if the spool holds unsent data', async () => {
      await arrange({ connectorActive: false, delivery: { status: 'healthy', pendingBytes: 2048 } });

      const lines = await runStatus(['status', '--json']);

      expect(JSON.parse(lines.join('\n'))).not.toHaveProperty('analytics');
    });

    it('leaves the stopped output untouched and collects nothing', async () => {
      const { checkStatus } = await import('../daemon-manager.js');
      const { checkProxyHealth } = await import('../health-check.js');
      const { collectDeliveryHealth } = await import('../delivery-health.js');
      const { readDesktopGateway } = await import('../connectors/desktop.js');
      vi.mocked(checkProxyHealth).mockClear();
      vi.mocked(collectDeliveryHealth).mockClear();
      vi.mocked(readDesktopGateway).mockClear();
      vi.mocked(checkStatus).mockResolvedValue({ running: false, state: null });

      expect(await runStatus(['status'])).toEqual(['Status: stopped']);
      consoleLogSpy.mockClear();
      expect(await runStatus(['status', '--json'])).toEqual([JSON.stringify({ status: 'stopped' }, null, 2)]);
      expect(checkProxyHealth).not.toHaveBeenCalled();
      expect(collectDeliveryHealth).not.toHaveBeenCalled();
      expect(readDesktopGateway).not.toHaveBeenCalled();
    });

    describe('Desktop line', () => {
      beforeEach(() => {
        vi.stubEnv('TZ', 'America/New_York'); // the drop time prints in the local zone; November, after DST ended (EST, -05:00)
      });

      afterEach(() => {
        vi.unstubAllEnvs();
      });

      const dropAt = Date.parse('2026-11-11T10:00:00.000Z');
      const latestDrop = { reason: 'cli_analytics_disabled', stream: 'hooks', at: dropAt, local: false };

      async function arrangeDesktop(gatewayPort: number, state: Record<string, unknown>): Promise<void> {
        await arrange({ connectorActive: true, delivery: { status: 'healthy', pendingBytes: 0 }, reply: { credentials: 'ok' } });
        const { checkStatus } = await import('../daemon-manager.js');
        const { readDesktopGateway } = await import('../connectors/desktop.js');
        const { collectDeliveryHealth } = await import('../delivery-health.js');
        vi.mocked(checkStatus).mockResolvedValue({
          running: true,
          state: { ...analyticsState, ...state } as Awaited<ReturnType<typeof checkStatus>>['state'],
        });
        vi.mocked(readDesktopGateway).mockResolvedValue({ port: gatewayPort });
        vi.mocked(collectDeliveryHealth).mockResolvedValue(
          { status: 'healthy', pendingBytes: 0, latestDrop } as Awaited<ReturnType<typeof collectDeliveryHealth>>
        );
      }

      const connectedSince = { desktopConnectedSince: '2026-11-16T10:00:00.000Z' };

      it('prints collecting, then the Analytics and Last dropped lines after Uptime', async () => {
        await arrangeDesktop(4001, connectedSince);

        const lines = await runStatus(['status']);

        const uptimeIndex = lines.findIndex((line) => line.startsWith('  Uptime:'));
        expect(lines.slice(uptimeIndex + 1, uptimeIndex + 4)).toEqual([
          '  Desktop: collecting',
          `Analytics: ${chalk.green('healthy')}`,
          '  Last dropped: cli_analytics_disabled (hooks, 2026-11-11 05:00:00 -05:00)',
        ]);
      });

      it('adds desktop and analytics.latestDrop to the JSON payload', async () => {
        await arrangeDesktop(4001, connectedSince);

        const payload = JSON.parse((await runStatus(['status', '--json'])).join('\n'));

        expect(payload.desktop).toEqual({ connected: true, collecting: true });
        expect(payload.analytics.latestDrop).toEqual(latestDrop);
      });

      it('says Desktop is not connected yet while the daemon has not noticed it on its own port', async () => {
        await arrangeDesktop(4001, {});

        const lines = await runStatus(['status']);
        const payload = (await runStatus(['status', '--json'])).at(-1) as string;

        expect(lines).toContain(chalk.yellow('  Desktop: NOT collecting — Desktop is not connected to this proxy yet'));
        expect(JSON.parse(payload).desktop).toEqual({
          connected: true,
          collecting: false,
          reason: 'Desktop is not connected to this proxy yet',
        });
      });

      it('prints the older-CLI line and no Desktop line for a daemon whose state has no version', async () => {
        await arrangeDesktop(4001, { version: undefined, telemetryMode: 'claude-desktop', clientType: 'claude-desktop' });

        const lines = await runStatus(['status']);
        consoleLogSpy.mockClear();
        const payload = JSON.parse((await runStatus(['status', '--json'])).join('\n'));

        expect(lines).toContain(chalk.yellow('  Version: older CLI — Run: codemie proxy restart'));
        expect(lines.some((line) => line.includes('Desktop:'))).toBe(false);
        expect(payload.version).toBeNull();
        expect(payload).not.toHaveProperty('desktop');
      });

      it('names both ports when Desktop points at another port than the daemon listens on', async () => {
        await arrangeDesktop(4001, { port: 4002, url: 'http://127.0.0.1:4002' });

        const lines = await runStatus(['status']);
        const payload = (await runStatus(['status', '--json'])).at(-1) as string;

        expect(lines).toContain(chalk.yellow(
          '  Desktop: NOT collecting — Claude Desktop points at port 4001, the proxy listens on 4002; ' +
          'run: codemie proxy connect --claude-desktop'
        ));
        expect(JSON.parse(payload).desktop).toEqual({
          connected: true,
          collecting: false,
          reason: 'Claude Desktop points at port 4001, the proxy listens on 4002',
          remedy: 'run: codemie proxy connect --claude-desktop',
        });
      });
    });
  });

  describe('the clients the status names', () => {
    // This install: the package these sources run from.
    const ownPackage = fileURLToPath(new URL('../../../../../', import.meta.url));
    const ownScript = join(ownPackage, 'bin', 'codemie.js');
    const baseState = {
      pid: process.pid,
      port: 60122,
      url: 'http://127.0.0.1:60122',
      profile: 'work',
      gatewayKey: 'codemie-proxy',
      version: '0.17.0',
      startedAt: new Date().toISOString(),
    };
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { checkStatus } = await import('../daemon-manager.js');
      const { checkProxyHealth } = await import('../health-check.js');
      const { hasActiveAnalyticsConnector } = await import('../analytics-connectors.js');
      vi.mocked(checkStatus).mockResolvedValue({ running: true, state: baseState });
      vi.mocked(checkProxyHealth).mockResolvedValue({ healthy: true, level: 'shallow', code: 'ok' });
      vi.mocked(hasActiveAnalyticsConnector).mockResolvedValue(false);
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    async function status(): Promise<string[]> {
      const { createProxyCommand } = await import('../index.js');
      consoleLogSpy.mockClear();
      await createProxyCommand().parseAsync(['status'], { from: 'user' });
      return consoleLogSpy.mock.calls.map((call) => String(call[0]));
    }

    async function statusJson(): Promise<Record<string, unknown>> {
      const { createProxyCommand } = await import('../index.js');
      consoleLogSpy.mockClear();
      await createProxyCommand().parseAsync(['status', '--json'], { from: 'user' });
      return JSON.parse(consoleLogSpy.mock.calls.map((call) => String(call[0])).join('\n')) as Record<string, unknown>;
    }

    async function writeFileAt(path: string, content: string): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }

    async function codexConfig(text: string): Promise<void> {
      await writeFileAt(join(clientHome, '.codex', 'config.toml'), text);
    }

    const managedCodex = (baseUrl: string, authorization: string): string => [
      '# >>> codemie proxy connect (codex-desktop) header - managed block, do not edit',
      'model_provider = "codemie"',
      'model = "gpt-5"',
      '# <<< codemie proxy connect (codex-desktop) header',
      '',
      '# >>> codemie proxy connect (codex-desktop) provider - managed block, do not edit',
      '[model_providers.codemie]',
      'name = "CodeMie"',
      `base_url = "${baseUrl}"`,
      'wire_api = "responses"',
      '[model_providers.codemie.http_headers]',
      `Authorization = "${authorization}"`,
      '# <<< codemie proxy connect (codex-desktop) provider',
      '',
    ].join('\n');

    async function extensionSettings(insiders: boolean, baseUrl: string, token: string): Promise<void> {
      const { getVsCodeProductDir } = await import('../connectors/vscode.js');
      await writeFileAt(join(getVsCodeProductDir(insiders), 'User', 'settings.json'), JSON.stringify({
        'claudeCode.environmentVariables': [
          { name: 'ANTHROPIC_BASE_URL', value: baseUrl },
          { name: 'ANTHROPIC_AUTH_TOKEN', value: token },
        ],
      }));
    }

    const win32 = process.platform === 'win32';
    /** A hook command's path: quoted on win32, where a temporary home may hold a space; a POSIX path as is. */
    const hookPath = (path: string): string => (win32 ? `"${path}"` : path);

    /**
     * An install of another CodeMie CLI under the home, the way this platform's npm lays it out: its package, its
     * script and its shim — `bin/codemie`, a symlink into the package; on win32 `codemie.cmd` in the prefix.
     */
    async function otherInstall(version = '0.16.6'): Promise<{ script: string; shim: string }> {
      const prefix = join(clientHome, 'other-prefix');
      const pkg = win32
        ? join(prefix, 'node_modules', '@codemieai', 'code')
        : join(prefix, 'lib', 'node_modules', '@codemieai', 'code');
      const script = join(pkg, 'bin', 'codemie.js');
      await writeFileAt(join(pkg, 'package.json'), JSON.stringify({ name: '@codemieai/code', version }));
      await writeFileAt(script, '');
      if (win32) {
        const shim = join(prefix, 'codemie.cmd');
        await writeFileAt(shim, NPM_WIN32_SHIMS['codemie.cmd']);
        return { script, shim };
      }
      const shim = join(prefix, 'bin', 'codemie');
      await mkdir(dirname(shim), { recursive: true });
      await symlink(script, shim);
      return { script, shim };
    }

    /** A win32 npm prefix of this install: its `node_modules/@codemieai/code` a junction to this package, and shim `name`. */
    async function ownWin32Shim(name: keyof typeof NPM_WIN32_SHIMS): Promise<string> {
      const prefix = join(clientHome, 'own-prefix');
      const link = join(prefix, 'node_modules', '@codemieai', 'code');
      await mkdir(dirname(link), { recursive: true });
      await symlink(ownPackage, link, 'junction');
      const shim = join(prefix, name);
      await writeFileAt(shim, NPM_WIN32_SHIMS[name]);
      return shim;
    }

    async function copilotCliHooks(script: string): Promise<void> {
      await writeFileAt(join(clientHome, '.copilot', 'hooks', 'codemie-copilot-cli-hooks.json'), JSON.stringify({
        version: 1,
        hooks: { sessionStart: [{ exec: process.execPath, args: [script, 'hook', '--agent', 'copilot-cli-otlp'], timeoutSec: 30 }] },
      }));
    }

    async function claudeCodeHooks(command: string): Promise<void> {
      await writeFileAt(join(clientHome, '.claude', 'settings.json'), JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] },
      }));
    }

    const yellow = (text: string): string => chalk.yellow(text);

    it('names a Codex config set up for another port, in the text and the JSON', async () => {
      await codexConfig(managedCodex('http://127.0.0.1:52311/v1', 'Bearer codemie-proxy.codex-desktop'));

      expect(await status()).toContain(yellow(
        '  Codex desktop: points at port 52311, the proxy listens on 60122 — Run: codemie proxy connect --codex-desktop'
      ));
      expect((await statusJson()).clientPortMismatch).toEqual([
        { client: 'codex-desktop', configuredPort: 52311, flag: '--codex-desktop' },
      ]);
    });

    it('names an extension config holding the shared key, and none holding its named key', async () => {
      await extensionSettings(false, 'http://127.0.0.1:60122', 'codemie-proxy');

      expect(await status()).toContain(yellow(
        '  VS Code Claude Code extension: uses the shared key — Run: codemie proxy connect --vscode-claude-code'
      ));
      expect((await statusJson()).clientSharedKey).toEqual([{ client: 'vscode-claude-code', flag: '--vscode-claude-code' }]);

      await extensionSettings(false, 'http://127.0.0.1:60122', 'codemie-proxy.vscode-claude-code');
      expect((await status()).some((line) => line.includes('VS Code Claude Code extension'))).toBe(false);
    });

    it('names an extension config holding a key the proxy refuses', async () => {
      await extensionSettings(false, 'http://127.0.0.1:60122', 'another-daemon-key.vscode-claude-code');

      expect(await status()).toContain(yellow(
        '  VS Code Claude Code extension: points at a local gateway with a key this proxy does not accept — if it should use CodeMie, run: codemie proxy connect --vscode-claude-code'
      ));
      expect((await statusJson()).clientSharedKey).toEqual([
        { client: 'vscode-claude-code', flag: '--vscode-claude-code', refused: true },
      ]);
    });

    describe('under a daemon whose state has no version', () => {
      beforeEach(async () => {
        const { checkStatus } = await import('../daemon-manager.js');
        vi.mocked(checkStatus).mockResolvedValue({ running: true, state: { ...baseState, version: undefined } });
      });

      it('names no extension config holding the shared key, beside the restart line', async () => {
        await extensionSettings(false, 'http://127.0.0.1:60122', 'codemie-proxy');

        const lines = await status();

        expect(lines).toContain(yellow('  Version: older CLI — Run: codemie proxy restart'));
        expect(lines.some((line) => line.includes('uses the shared key'))).toBe(false);
        expect(await statusJson()).not.toHaveProperty('clientSharedKey');
      });

      it('names no Desktop config holding a plain key the proxy does not accept', async () => {
        const { getClaudeDesktopBaseDir } = await import('@/telemetry/clients/claude-desktop/claude-desktop.paths.js');
        const libDir = join(getClaudeDesktopBaseDir(), 'configLibrary');
        await writeFileAt(join(libDir, '_meta.json'), JSON.stringify({ appliedId: 'cfg' }));
        await writeFileAt(join(libDir, 'cfg.json'), JSON.stringify({
          inferenceProvider: 'gateway',
          inferenceGatewayBaseUrl: 'http://127.0.0.1:60122',
          inferenceGatewayApiKey: 'other-key',
        }));

        expect((await status()).some((line) => line.includes('Claude Desktop:'))).toBe(false);
        expect(await statusJson()).not.toHaveProperty('clientSharedKey');
      });

      it('still names an extension config on another loopback port', async () => {
        await extensionSettings(false, 'http://127.0.0.1:4001', 'codemie-proxy');

        expect(await status()).toContain(yellow(
          '  VS Code Claude Code extension: points at port 4001, the proxy listens on 60122 — ' +
          'Run: codemie proxy connect --vscode-claude-code'
        ));
        expect((await statusJson()).clientPortMismatch).toEqual([
          { client: 'vscode-claude-code', configuredPort: 4001, flag: '--vscode-claude-code' },
        ]);
      });
    });

    it('names the Insiders and the stable extension settings on different ports each on its own line', async () => {
      await extensionSettings(false, 'http://127.0.0.1:4001', 'codemie-proxy.vscode-claude-code');
      await extensionSettings(true, 'http://127.0.0.1:4002', 'codemie-proxy.vscode-claude-code');

      const lines = await status();
      expect(lines).toContain(yellow(
        '  VS Code Claude Code extension: points at port 4001, the proxy listens on 60122 — ' +
        'Run: codemie proxy connect --vscode-claude-code'
      ));
      expect(lines).toContain(yellow(
        '  VS Code Insiders Claude Code extension: points at port 4002, the proxy listens on 60122 — ' +
        'Run: codemie proxy connect --vscode-claude-code --insiders'
      ));
      expect((await statusJson()).clientPortMismatch).toEqual([
        { client: 'vscode-claude-code', configuredPort: 4001, flag: '--vscode-claude-code' },
        { client: 'vscode-claude-code', configuredPort: 4002, flag: '--vscode-claude-code --insiders' },
      ]);
    });

    it('names nothing for a Codex config whose managed block was removed by hand', async () => {
      await codexConfig('[model_providers.codemie]\nbase_url = "http://127.0.0.1:52311/v1"\n');

      const payload = await statusJson();
      expect(payload).not.toHaveProperty('clientPortMismatch');
      expect(payload).not.toHaveProperty('clientSharedKey');
    });

    it('names nothing for an unreadable reader file and the command succeeds', async () => {
      await codexConfig('# >>> codemie proxy connect (codex-desktop) provider - managed block, do not edit\n[[[');

      const lines = await status();
      expect(lines.some((line) => line.includes('Codex desktop'))).toBe(false);
      expect(lines[0]).toBe(`Status:  ${chalk.green('running, healthy')}`);
    });

    it('names Desktop on another port by its Desktop line alone, beside the analytics lines', async () => {
      const { readDesktopGateway } = await import('../connectors/desktop.js');
      const { hasActiveAnalyticsConnector } = await import('../analytics-connectors.js');
      const { collectDeliveryHealth } = await import('../delivery-health.js');
      const { getClaudeDesktopBaseDir } = await import('@/telemetry/clients/claude-desktop/claude-desktop.paths.js');
      const libDir = join(getClaudeDesktopBaseDir(), 'configLibrary');
      await writeFileAt(join(libDir, '_meta.json'), JSON.stringify({ appliedId: 'cfg' }));
      await writeFileAt(join(libDir, 'cfg.json'), JSON.stringify({
        inferenceProvider: 'gateway',
        inferenceGatewayBaseUrl: 'http://127.0.0.1:4001',
        inferenceGatewayApiKey: 'codemie-proxy.claude-desktop',
      }));
      vi.mocked(readDesktopGateway).mockResolvedValue({ port: 4001 });
      vi.mocked(hasActiveAnalyticsConnector).mockResolvedValue(true);
      vi.mocked(collectDeliveryHealth).mockResolvedValue({ status: 'healthy', pendingBytes: 0 });

      const lines = await status();

      expect(lines).toContain(`Analytics: ${chalk.green('healthy')}`);
      expect(lines).toContain(yellow(
        '  Desktop: NOT collecting — Claude Desktop points at port 4001, the proxy listens on 60122; ' +
        'run: codemie proxy connect --claude-desktop'
      ));
      expect(lines.filter((line) => line.includes('Claude Desktop'))).toHaveLength(1);
    });

    it('names a Desktop config holding the shared key', async () => {
      const { getClaudeDesktopBaseDir } = await import('@/telemetry/clients/claude-desktop/claude-desktop.paths.js');
      const libDir = join(getClaudeDesktopBaseDir(), 'configLibrary');
      await writeFileAt(join(libDir, '_meta.json'), JSON.stringify({ appliedId: 'cfg' }));
      await writeFileAt(join(libDir, 'cfg.json'), JSON.stringify({
        inferenceProvider: 'gateway',
        inferenceGatewayBaseUrl: 'http://127.0.0.1:60122',
        inferenceGatewayApiKey: 'codemie-proxy',
      }));

      expect(await status()).toContain(yellow(
        '  Claude Desktop: uses the shared key — Run: codemie proxy connect --claude-desktop'
      ));
      expect((await statusJson()).clientSharedKey).toEqual([{ client: 'claude-desktop', flag: '--claude-desktop' }]);
    });

    describe('a Desktop config whose key Desktop has sealed', () => {
      /** Desktop's applied config sealed on `port`, read by the real reader; the daemon's state with `extra`. */
      async function sealedDesktop(port: number, extra: Record<string, unknown>): Promise<void> {
        const { getClaudeDesktopBaseDir } = await import('@/telemetry/clients/claude-desktop/claude-desktop.paths.js');
        const libDir = join(getClaudeDesktopBaseDir(), 'configLibrary');
        await writeFileAt(join(libDir, '_meta.json'), JSON.stringify({ appliedId: 'cfg' }));
        await writeFileAt(join(libDir, 'cfg.json'), JSON.stringify({
          inferenceProvider: 'gateway',
          inferenceGatewayBaseUrl: `http://127.0.0.1:${port}`,
          inferenceGatewayApiKey: '__sealed__:v1:QUJD',
        }));
        const actual = await vi.importActual<typeof import('../connectors/desktop.js')>('../connectors/desktop.js');
        const { readDesktopGateway } = await import('../connectors/desktop.js');
        vi.mocked(readDesktopGateway).mockImplementation(() => actual.readDesktopGateway());
        const { checkStatus, readState } = await import('../daemon-manager.js');
        const state = { ...baseState, ...extra } as Awaited<ReturnType<typeof checkStatus>>['state'];
        vi.mocked(checkStatus).mockResolvedValue({ running: true, state });
        vi.mocked(readState).mockResolvedValue(state);
      }

      afterEach(async () => {
        const { readDesktopGateway } = await import('../connectors/desktop.js');
        const { readState } = await import('../daemon-manager.js');
        vi.mocked(readDesktopGateway).mockReset().mockResolvedValue(null);
        vi.mocked(readState).mockReset();
      });

      it.each([
        [
          'on the daemon\'s port, Desktop noticed',
          60122,
          { desktopConnectedSince: '2026-11-16T10:00:00.000Z' },
          '  Desktop: collecting',
          { connected: true, collecting: true },
        ],
        [
          'on the daemon\'s port, not noticed yet',
          60122,
          {},
          chalk.yellow('  Desktop: NOT collecting — Desktop is not connected to this proxy yet'),
          { connected: true, collecting: false, reason: 'Desktop is not connected to this proxy yet' },
        ],
        [
          'on another port',
          4123,
          {},
          chalk.yellow(
            '  Desktop: NOT collecting — Claude Desktop points at port 4123, the proxy listens on 60122; ' +
            'run: codemie proxy connect --claude-desktop'
          ),
          {
            connected: true,
            collecting: false,
            reason: 'Claude Desktop points at port 4123, the proxy listens on 60122',
            remedy: 'run: codemie proxy connect --claude-desktop',
          },
        ],
      ])('%s: the Desktop line and no key line', async (_case, port, extra, line, desktop) => {
        await sealedDesktop(port, extra);

        const lines = await status();
        const payload = await statusJson();

        expect(lines).toContain(line);
        expect(lines.some((printed) => printed.includes('Claude Desktop:'))).toBe(false);
        expect(payload.desktop).toEqual(desktop);
        expect(payload).not.toHaveProperty('clientSharedKey');
      });

      it('edge: the daemon of an older CLI: no key line and no Desktop line', async () => {
        await sealedDesktop(60122, { version: undefined });

        const lines = await status();

        expect(lines.some((printed) => printed.includes('Claude Desktop:'))).toBe(false);
        expect(lines.some((printed) => printed.includes('Desktop:'))).toBe(false);
        expect(await statusJson()).not.toHaveProperty('clientSharedKey');
      });
    });

    it('names a Desktop config holding a key the proxy refuses', async () => {
      const { getClaudeDesktopBaseDir } = await import('@/telemetry/clients/claude-desktop/claude-desktop.paths.js');
      const libDir = join(getClaudeDesktopBaseDir(), 'configLibrary');
      await writeFileAt(join(libDir, '_meta.json'), JSON.stringify({ appliedId: 'cfg' }));
      await writeFileAt(join(libDir, 'cfg.json'), JSON.stringify({
        inferenceProvider: 'gateway',
        inferenceGatewayBaseUrl: 'http://127.0.0.1:60122',
        inferenceGatewayApiKey: 'other-key',
      }));

      expect(await status()).toContain(yellow(
        '  Claude Desktop: points at a local gateway with a key this proxy does not accept — if it should use CodeMie, run: codemie proxy connect --claude-desktop'
      ));
      expect((await statusJson()).clientSharedKey).toEqual([
        { client: 'claude-desktop', flag: '--claude-desktop', refused: true },
      ]);
    });

    it.each([
      [false, 'VS Code BYOK', '--vscode'],
      [true, 'VS Code Insiders BYOK', '--vscode --insiders'],
    ])('names BYOK models on another port (insiders: %s)', async (insiders, label, flag) => {
      const { getVsCodeProductDir } = await import('../connectors/vscode.js');
      await writeFileAt(join(getVsCodeProductDir(insiders), 'User', 'chatLanguageModels.json'), JSON.stringify([{
        name: 'CodeMie',
        vendor: 'customendpoint',
        models: [{ id: 'claude-sonnet-4-6', url: 'http://127.0.0.1:52311/v1/chat/completions' }],
      }]));

      expect(await status()).toContain(yellow(
        `  ${label}: points at port 52311, the proxy listens on 60122 — Run: codemie proxy connect ${flag}`
      ));
      expect((await statusJson()).clientPortMismatch).toEqual([
        { client: 'vscode-byok', configuredPort: 52311, flag },
      ]);
    });

    it('warns about an older install first on PATH, and says nothing when the lookup finds none', async () => {
      const { getCommandPath } = await import('@/utils/processes.js');
      const { shim } = await otherInstall('0.16.6');
      vi.mocked(getCommandPath).mockResolvedValue(shim);

      expect(await status()).toContain(yellow(
        `  Warning: an older CodeMie CLI is first on PATH: ${shim} (0.16.6). ` +
        'Its hooks start an older proxy, which can refuse the keys of the connected clients.'
      ));
      expect((await statusJson()).olderCliOnPath).toEqual({ path: shim, version: '0.16.6' });

      vi.mocked(getCommandPath).mockResolvedValue(null);
      expect((await status()).some((line) => line.includes('older CodeMie CLI'))).toBe(false);
      expect(await statusJson()).not.toHaveProperty('olderCliOnPath');
    });

    it('names Copilot CLI hooks that run another install, and none that run this one', async () => {
      const { script } = await otherInstall();
      await copilotCliHooks(script);

      expect(await status()).toContain(yellow(
        `  Copilot CLI hooks: run another install (${script}) — Run: codemie proxy connect --copilot-cli-otlp`
      ));
      expect((await statusJson()).hooksOfAnotherInstall).toEqual([
        { connector: 'copilot-cli-otlp', path: script, flag: '--copilot-cli-otlp' },
      ]);

      await copilotCliHooks(ownScript);
      expect((await status()).some((line) => line.includes('Copilot CLI hooks'))).toBe(false);
    });

    it.each([
      ['resolves a directory that does not exist', () => ({ dir: join(clientHome, 'missing-install'), manifest: {} })],
      ['rejects', () => { throw new Error('lookup failed'); }],
    ])('names no hooks of another install and succeeds when the lookup of its own install %s', async (_case, lookup) => {
      const { findFirstManifest } = await import('@/utils/active-cli.js');
      const { script } = await otherInstall();
      await copilotCliHooks(script);
      vi.mocked(findFirstManifest).mockImplementationOnce(async () => lookup());

      const lines = await status();

      expect(lines[0]).toBe(`Status:  ${chalk.green('running, healthy')}`);
      expect(lines.some((line) => line.includes('run another install'))).toBe(false);
    });

    it('names Copilot Chat hooks that run another install', async () => {
      const { script } = await otherInstall();
      await writeFileAt(join(clientHome, 'hooks', 'copilot-chat-hooks.json'), JSON.stringify({
        hooks: { SessionStart: [{ type: 'command', command: `"${process.execPath}" "${script}" hook --agent copilot-chat-otlp` }] },
      }));

      expect(await status()).toContain(yellow(
        `  Copilot Chat hooks: run another install (${script}) — Run: codemie proxy connect --copilot-chat-otlp`
      ));
      expect((await statusJson()).hooksOfAnotherInstall).toEqual([
        { connector: 'copilot-chat-otlp', path: script, flag: '--copilot-chat-otlp' },
      ]);
    });

    it('reads the clients\' configs and Claude Code\'s OTLP endpoint while the PATH lookup is still open', async () => {
      const { getCommandPath } = await import('@/utils/processes.js');
      const { checkClaudeCodeOtlpEndpoint } = await import('../connectors/claude-code-otlp-endpoint.js');
      vi.mocked(checkClaudeCodeOtlpEndpoint).mockClear();
      const pending: Array<(path: string | null) => void> = [];
      vi.mocked(getCommandPath).mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
      const { shim } = await otherInstall();
      await codexConfig(managedCodex('http://127.0.0.1:52311/v1', 'Bearer codemie-proxy.codex-desktop'));
      await claudeCodeHooks(`${hookPath(shim)} hook --agent claude-code-otlp`);

      const printed = status();
      // Two lookups open — the older-CLI check's and the one for Claude Code's hooks of another install — means the
      // reader loop has read the Codex config and Claude Code's settings.
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      expect(checkClaudeCodeOtlpEndpoint).toHaveBeenCalled();
      await rm(join(clientHome, '.codex'), { recursive: true, force: true });
      await rm(join(clientHome, '.claude'), { recursive: true, force: true });
      for (const release of pending) release(null);

      const lines = await printed;
      expect(lines).toContain(yellow(
        '  Codex desktop: points at port 52311, the proxy listens on 60122 — Run: codemie proxy connect --codex-desktop'
      ));
      expect(lines).toContain(yellow(
        `  Claude Code hooks: run another install (${shim}) — Run: codemie proxy connect --claude-code-otlp`
      ));
    });

    it('names Claude Code hooks whose command is the absolute path of another install', async () => {
      const { shim } = await otherInstall();
      await claudeCodeHooks(`${hookPath(shim)} hook --agent claude-code-otlp`);

      expect(await status()).toContain(yellow(
        `  Claude Code hooks: run another install (${shim}) — Run: codemie proxy connect --claude-code-otlp`
      ));
    });

    it('gives the PATH remedy when the other install of the hooks is also first on PATH', async () => {
      const { getCommandPath } = await import('@/utils/processes.js');
      const { shim } = await otherInstall();
      vi.mocked(getCommandPath).mockResolvedValue(shim);
      await claudeCodeHooks(`${hookPath(shim)} hook --agent claude-code-otlp`);

      expect(await status()).toContain(yellow(
        `  Claude Code hooks: run another install (${shim}) — ` +
        'put this install first on PATH, then run: codemie proxy connect --claude-code-otlp'
      ));
    });

    it.each([
      ['a bare codemie command', async () => 'codemie hook --agent claude-code-otlp'],
      [
        win32
          ? 'this install\'s own shim, npm\'s sh shim in a prefix linked to its package (win32 npm makes no symlink)'
          : 'this install\'s own shim, a symlink into its package',
        async () => {
          if (win32) return `${hookPath(await ownWin32Shim('codemie'))} hook --agent claude-code-otlp`;
          const shim = join(clientHome, 'own-prefix', 'bin', 'codemie');
          await mkdir(dirname(shim), { recursive: true });
          await symlink(ownScript, shim);
          return `${shim} hook --agent claude-code-otlp`;
        },
      ],
      ['this install\'s codemie.cmd', async () => {
        if (win32) return `${hookPath(await ownWin32Shim('codemie.cmd'))} hook --agent claude-code-otlp`;
        const cmd = join(clientHome, 'own-prefix', 'codemie.cmd');
        await mkdir(dirname(cmd), { recursive: true });
        await symlink(ownScript, cmd);
        return `"${cmd}" hook --agent claude-code-otlp`;
      }],
      ['node with this install\'s own script', async () => `"${process.execPath}" "${ownScript}" hook --agent claude-code-otlp`],
    ])('names no Claude Code hooks for %s', async (_case, command) => {
      await claudeCodeHooks(await command());

      expect((await status()).some((line) => line.includes('Claude Code hooks'))).toBe(false);
    });

    it('prints the output of a daemon with no client and no JSON client keys when no reader finds a file', async () => {
      const lines = await status();

      expect(lines).toEqual([
        `Status:  ${chalk.green('running, healthy')}`,
        '  URL:     http://127.0.0.1:60122',
        '  Port:    60122',
        '  API Key: codemie-proxy',
        '  Client keys: codemie-proxy.<client> — written by codemie proxy connect',
        '  Profile: work',
        '  Version: 0.17.0',
        lines[7],
      ]);
      const payload = await statusJson();
      for (const key of ['clientPortMismatch', 'clientSharedKey', 'olderCliOnPath', 'hooksOfAnotherInstall']) {
        expect(payload).not.toHaveProperty(key);
      }
    });
  });
});

describe('proxy restart', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  const runningState = {
    pid: 4242,
    url: 'http://127.0.0.1:4001',
    profile: 'work',
    port: 4001,
    clientType: 'claude-desktop',
    telemetryMode: 'claude-desktop' as const,
    gatewayKey: 'k',
    model: 'm',
    project: 'recorded-project',
    startedAt: new Date().toISOString(),
  };

  const setup = async (
    status: { running: boolean; state: (typeof runningState & { projectBinding?: string }) | null },
    spawnedPort = 4001,
    configName = 'work',
    resolvedBinding = 'own'
  ) => {
    const { ConfigLoader } = await import('../../../../utils/config.js');
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    const daemon = await import('../daemon-manager.js');
    const { createProxyCommand } = await import('../index.js');

    // The read before the preparation and the first read under the lock: the daemon being restarted.
    // Later calls (the pre-spawn re-check): nothing running, as after a real stop.
    vi.mocked(daemon.readDaemonStatus).mockResolvedValue(status);
    vi.mocked(daemon.readConnectionRecord).mockReset();
    vi.mocked(daemon.checkStatus)
      .mockReset()
      .mockResolvedValueOnce(status)
      .mockResolvedValue({ running: false, state: null });
    vi.mocked(daemon.stopDaemon).mockResolvedValue(undefined);
    vi.mocked(ConfigLoader.load).mockImplementation(async (_cwd, options) => ({
      name: (options as { name?: string } | undefined)?.name ?? configName,
      provider: 'ai-run-sso',
      baseUrl: 'https://example.com/api',
      codeMieProject: 'config-project',
    }) as Awaited<ReturnType<typeof ConfigLoader.load>>);
    vi.mocked(ConfigLoader.resolveProfileIdentity).mockImplementation(async (_cwd, name) => ({
      state: resolvedBinding,
      profileName: name ?? configName,
      shared: {},
    }) as unknown as Awaited<ReturnType<typeof ConfigLoader.resolveProfileIdentity>>);
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockResolvedValue({ token: 'tok' }) };
    } as unknown as typeof CodeMieSSO);
    vi.mocked(daemon.spawnDaemon).mockImplementation(async opts => ({
      pid: 5151,
      url: `http://127.0.0.1:${spawnedPort}`,
      profile: opts.profile,
      port: spawnedPort,
      gatewayKey: opts.gatewayKey ?? 'codemie-proxy',
      startedAt: new Date().toISOString(),
    }));

    return { ConfigLoader, daemon, command: createProxyCommand() };
  };

  const loggedOutput = (): string =>
    consoleLogSpy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n');
  const errorOutput = (): string =>
    consoleErrorSpy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n');

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit:${code}`);
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('re-spawns a running daemon with its port, key and model, no identity, and the profile\'s current project (AC12)', async () => {
    const { ConfigLoader, daemon, command } = await setup({ running: true, state: runningState });

    await command.parseAsync(['restart'], { from: 'user' });

    expect(daemon.stopDaemon).toHaveBeenCalledTimes(1);
    expect(vi.mocked(daemon.stopDaemon).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(daemon.spawnDaemon).mock.invocationCallOrder[0]);
    expect(ConfigLoader.load).toHaveBeenCalledWith(process.cwd(), { name: 'work' });
    expect(vi.mocked(daemon.spawnDaemon).mock.calls[0][0]).not.toHaveProperty('clientType');
    expect(vi.mocked(daemon.spawnDaemon).mock.calls[0][0]).not.toHaveProperty('telemetryMode');
    expect(vi.mocked(daemon.spawnDaemon).mock.calls[0][0]).toMatchObject({
      profile: 'work',
      port: 4001,
      gatewayKey: 'k',
      model: 'm',
      // Re-read from the profile, not the recorded state: a profile that gained its own
      // project since the daemon started bills it after the restart (EPMCDME-15411).
      project: 'config-project',
      projectBinding: 'own',
    });
    expect(errorOutput()).not.toContain('already running with different settings');
    expect(loggedOutput()).toContain('✓ Proxy restarted at http://127.0.0.1:4001');
  });

  describe('a restart from another directory keeps the project (PR #758 review, finding 6)', () => {
    it('a project recorded from a repo config (local) is kept, though the profile resolves elsewhere', async () => {
      const { daemon, command } = await setup({ running: true, state: { ...runningState, projectBinding: 'local' } }, 4001, 'work', 'own');

      await command.parseAsync(['restart'], { from: 'user' });

      expect(vi.mocked(daemon.spawnDaemon).mock.calls[0][0]).toMatchObject({ project: 'recorded-project', projectBinding: 'local', gatewayKey: 'k' });
    });

    it('an unowned profile keeps the recorded project (state file from an older CLI, no binding)', async () => {
      const { daemon, command } = await setup({ running: true, state: runningState }, 4001, 'work', 'unowned');

      await command.parseAsync(['restart'], { from: 'user' });

      expect(vi.mocked(daemon.spawnDaemon).mock.calls[0][0]).toMatchObject({ project: 'recorded-project' });
    });

    it('a profile that is now off CodeMie drops the recorded project', async () => {
      const { ConfigLoader, daemon, command } = await setup({ running: true, state: runningState }, 4001, 'work', 'none');
      vi.mocked(ConfigLoader.load).mockResolvedValue({ name: 'work', provider: 'ai-run-sso', baseUrl: 'https://example.com/api' } as Awaited<ReturnType<typeof ConfigLoader.load>>);

      await command.parseAsync(['restart'], { from: 'user' });

      expect(vi.mocked(daemon.spawnDaemon).mock.calls[0][0].project).toBeUndefined();
      expect(vi.mocked(daemon.spawnDaemon).mock.calls[0][0].projectBinding).toBe('none');
    });
  });

  it('switches only the profile when --profile is given', async () => {
    const { ConfigLoader, daemon, command } = await setup({ running: true, state: runningState });

    await command.parseAsync(['restart', '--profile', 'other'], { from: 'user' });

    expect(ConfigLoader.load).toHaveBeenCalledWith(process.cwd(), { name: 'other' });
    expect(vi.mocked(daemon.spawnDaemon).mock.calls[0][0]).toMatchObject({
      profile: 'other',
      port: 4001,
      project: 'config-project',
    });
    // The old profile's model may not exist on the new profile's tenant.
    expect(vi.mocked(daemon.spawnDaemon).mock.calls[0][0].model).toBeUndefined();
  });

  it('leaves the running daemon untouched when SSO credentials are missing', async () => {
    const { daemon, command } = await setup({ running: true, state: runningState });
    const { CodeMieSSO } = await import('../../../../providers/plugins/sso/sso.auth.js');
    vi.mocked(CodeMieSSO).mockImplementation(function MockCodeMieSSO() {
      return { getStoredCredentials: vi.fn().mockResolvedValue(null) };
    } as unknown as typeof CodeMieSSO);

    await expect(command.parseAsync(['restart'], { from: 'user' })).rejects.toThrow('process.exit:1');

    expect(daemon.stopDaemon).not.toHaveBeenCalled();
    expect(daemon.spawnDaemon).not.toHaveBeenCalled();
  });

  it('leaves the running daemon untouched when the profile has no base URL', async () => {
    const { ConfigLoader, daemon, command } = await setup({ running: true, state: runningState });
    vi.mocked(ConfigLoader.load).mockResolvedValue(
      { name: 'work', provider: 'ai-run-sso' } as Awaited<ReturnType<typeof ConfigLoader.load>>
    );

    await expect(command.parseAsync(['restart'], { from: 'user' })).rejects.toThrow('process.exit:1');

    expect(daemon.stopDaemon).not.toHaveBeenCalled();
    expect(errorOutput()).toContain('No API URL configured');
  });

  it('leaves the running daemon untouched when the profile cannot be loaded', async () => {
    const { ConfigLoader, daemon, command } = await setup({ running: true, state: runningState });
    vi.mocked(ConfigLoader.load).mockRejectedValue(new Error("Profile 'typo' not found"));

    await expect(
      command.parseAsync(['restart', '--profile', 'typo'], { from: 'user' })
    ).rejects.toThrow('process.exit:1');

    expect(daemon.stopDaemon).not.toHaveBeenCalled();
  });

  it('syncs skills before stopping the running daemon', async () => {
    const { daemon, command } = await setup({ running: true, state: runningState });
    const { syncRegisteredSkills } = await import('../../../../cli/commands/skills/setup/sync.js');

    await command.parseAsync(['restart'], { from: 'user' });

    expect(vi.mocked(syncRegisteredSkills).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(daemon.stopDaemon).mock.invocationCallOrder[0]);
  });

  it('stops a daemon that started during the restart window before re-spawning', async () => {
    const { daemon, command } = await setup({ running: true, state: runningState });
    vi.mocked(daemon.checkStatus)
      .mockReset()
      .mockResolvedValueOnce({ running: true, state: runningState })
      .mockResolvedValueOnce({ running: true, state: { ...runningState, pid: 777, clientType: 'claude-code-otlp' } })
      .mockResolvedValue({ running: false, state: null });

    await command.parseAsync(['restart'], { from: 'user' });

    expect(daemon.stopDaemon).toHaveBeenCalledTimes(2);
    expect(vi.mocked(daemon.stopDaemon).mock.invocationCallOrder[1])
      .toBeLessThan(vi.mocked(daemon.spawnDaemon).mock.invocationCallOrder[0]);
    expect(vi.mocked(daemon.spawnDaemon).mock.calls[0][0]).toMatchObject({ port: 4001, gatewayKey: 'k' });
  });

  it('behaves like start when the recorded daemon is not running', async () => {
    const { DEFAULT_DAEMON_PORT } = await import('../connect-orchestrator.js');
    const { daemon, command } = await setup({ running: false, state: runningState }, DEFAULT_DAEMON_PORT, 'default');

    await command.parseAsync(['restart'], { from: 'user' });

    expect(daemon.stopDaemon).not.toHaveBeenCalled();
    const options = vi.mocked(daemon.spawnDaemon).mock.calls[0][0];
    expect(options).toMatchObject({
      profile: 'default',
      port: DEFAULT_DAEMON_PORT,
    });
    expect(options).not.toHaveProperty('clientType');
    expect(options).not.toHaveProperty('telemetryMode');
    expect(options).not.toHaveProperty('gatewayKey');
    expect(options).not.toHaveProperty('model');
  });

  it('stops the new daemon and fails when it could not rebind the recorded port', async () => {
    const { daemon, command } = await setup({ running: true, state: runningState }, 54321);

    await expect(command.parseAsync(['restart'], { from: 'user' })).rejects.toThrow('process.exit:1');

    expect(daemon.stopDaemon).toHaveBeenCalledTimes(2);
    expect(errorOutput()).toContain('4001');
    // A plain re-run would hit the not-running branch and drop the identity,
    // so the error names what is lost and the command that restores the port.
    expect(errorOutput()).not.toContain('run: codemie proxy restart');
    expect(errorOutput().replace(/\s+/g, ' ')).toContain('codemie proxy start --port 4001 --profile work');
    expect(errorOutput().replace(/\s+/g, ' ')).toContain('port 4001 and its gateway key');
    expect(loggedOutput()).not.toContain('✓');
  });

  it('names the lost identity and the restore command when the re-spawn fails', async () => {
    const { daemon, command } = await setup({ running: true, state: runningState });
    vi.mocked(daemon.spawnDaemon).mockRejectedValue(new Error('Daemon failed to start within 5 seconds'));

    await expect(command.parseAsync(['restart'], { from: 'user' })).rejects.toThrow('process.exit:1');

    // The message wraps; compare it as one line.
    const output = errorOutput().replace(/\s+/g, ' ');
    expect(output).toContain('Daemon failed to start within 5 seconds');
    expect(output).toContain('codemie proxy start --port 4001 --profile work');
    expect(output).toContain('port 4001 and its gateway key');
    expect(loggedOutput()).not.toContain('✓');
  });

  it.each(['claude-code-otlp', 'vscode-byok'])('spawns with no identity when the state names %s', async (clientType) => {
    const { daemon, command } = await setup({ running: true, state: { ...runningState, clientType } });

    await command.parseAsync(['restart'], { from: 'user' });

    expect(vi.mocked(daemon.spawnDaemon).mock.calls[0][0]).not.toHaveProperty('clientType');
    expect(vi.mocked(daemon.spawnDaemon).mock.calls[0][0]).not.toHaveProperty('telemetryMode');
  });

  it('re-spawns a running daemon of an older CLI whose state has no model with the global profile\'s model', async () => {
    const { ConfigLoader, daemon, command } = await setup({ running: true, state: { ...runningState, model: undefined } as typeof runningState });
    vi.mocked(ConfigLoader.loadGlobalConfigProfile).mockResolvedValueOnce({ name: 'work', model: 'global-model' });

    await command.parseAsync(['restart'], { from: 'user' });

    expect(ConfigLoader.loadGlobalConfigProfile).toHaveBeenCalledWith('work');
    expect(vi.mocked(daemon.spawnDaemon).mock.calls[0][0].model).toBe('global-model');
  });

  it.each([
    ['disappeared', { running: false, state: null }],
    ['was replaced by another run', { running: true, state: { ...runningState, pid: 9191 } }],
    ['was restarted with another start time', { running: true, state: { ...runningState, startedAt: '2026-01-01T00:00:00.000Z' } }],
  ])('fails, touching nothing, when the daemon %s during the preparation', async (_label, underLock) => {
    const { daemon, command } = await setup({ running: true, state: runningState });
    vi.mocked(daemon.checkStatus).mockReset().mockResolvedValue(underLock as Awaited<ReturnType<typeof daemon.checkStatus>>);
    const files = await arrangeClientFiles(clientHome, OLDER_RECORD, 'k');
    const before = await Promise.all(Object.values(files).map((path) => readFile(path, 'utf-8')));

    await expect(command.parseAsync(['restart'], { from: 'user' })).rejects.toThrow('process.exit:1');

    expect(errorOutput()).toContain('The proxy changed while restarting; run the command again.');
    expect(daemon.stopDaemon).not.toHaveBeenCalled();
    expect(daemon.spawnDaemon).not.toHaveBeenCalled();
    expect(await Promise.all(Object.values(files).map((path) => readFile(path, 'utf-8')))).toEqual(before);
  });

  it.each([
    ['the record\'s profile and port', ['restart'], 'recorded'],
    ['--profile p2 and the record\'s port', ['restart', '--profile', 'p2'], 'p2'],
  ])('starts a stopped daemon with %s', async (_label, argv, profile) => {
    const { ConfigLoader, daemon, command } = await setup({ running: false, state: null }, 52311, 'default');
    vi.mocked(daemon.readConnectionRecord).mockResolvedValue({ version: 1, profile: 'recorded', updatedAt: '', port: 52311 });

    await command.parseAsync(argv, { from: 'user' });

    expect(ConfigLoader.load).toHaveBeenCalledWith(process.cwd(), { name: profile });
    expect(vi.mocked(daemon.spawnDaemon).mock.calls[0][0]).toMatchObject({ profile, port: 52311 });
  });

  it('starts a stopped daemon with the loaded config\'s values and no model', async () => {
    const { ConfigLoader, daemon, command } = await setup({ running: false, state: null }, 4001, 'p');
    vi.mocked(daemon.readConnectionRecord).mockResolvedValue(null);
    vi.mocked(ConfigLoader.load).mockResolvedValue({
      name: 'p', provider: 'ai-run-sso', baseUrl: 'https://t', codeMieProject: 'A', model: 'm1',
      ssoConfig: { apiUrl: 'https://s' }, codeMieUrl: 'https://c',
    } as Awaited<ReturnType<typeof ConfigLoader.load>>);

    await command.parseAsync(['restart'], { from: 'user' });

    expect(vi.mocked(daemon.spawnDaemon).mock.calls[0][0]).toEqual({
      targetUrl: 'https://t', provider: 'ai-run-sso', profile: 'p', project: 'A', projectBinding: 'own',
      syncApiUrl: 'https://s', syncCodeMieUrl: 'https://c', port: 4001, writeRecord: true,
    });
  });

  describe('while Claude Desktop is connected', () => {
    async function connectDesktop(port: number): Promise<void> {
      const { readDesktopGateway } = await import('../connectors/desktop.js');
      vi.mocked(readDesktopGateway).mockResolvedValue({ port });
    }

    it.each([
      ['on the gateway port', 4001],
      ['on its own port, not the gateway port', 4002],
    ])('re-spawns a running daemon with no identity %s and records it', async (_label, port) => {
      const onPort = { ...runningState, clientType: 'claude-code-otlp', port, url: `http://127.0.0.1:${port}` };
      const { daemon, command } = await setup({ running: true, state: onPort }, port);
      await connectDesktop(4001);
      vi.mocked(daemon.readConnectionRecord).mockResolvedValue(null);

      await command.parseAsync(['restart'], { from: 'user' });

      const [spawned] = vi.mocked(daemon.spawnDaemon).mock.calls[0];
      expect(spawned.port).toBe(port);
      expect(spawned).not.toHaveProperty('clientType');
      expect(spawned).not.toHaveProperty('telemetryMode');
      expect(daemon.writeConnectionRecord).toHaveBeenCalledWith(expect.objectContaining({ port }), 'work');
      expect(loggedOutput()).toContain(`✓ Proxy restarted at http://127.0.0.1:${port}`);
    });

    it('stops a replacement that could not rebind the running daemon port', async () => {
      const onOwnPort = { ...runningState, port: 4002, url: 'http://127.0.0.1:4002' };
      const { daemon, command } = await setup({ running: true, state: onOwnPort }, 54321);
      await connectDesktop(4001);

      await expect(command.parseAsync(['restart'], { from: 'user' })).rejects.toThrow('process.exit:1');

      expect(daemon.stopDaemon).toHaveBeenCalledTimes(2);
      expect(errorOutput().replace(/\s+/g, ' ')).toContain('codemie proxy start --port 4002');
      expect(loggedOutput()).not.toContain('✓');
    });

    it.each([
      ['comes up there', 4005],
      ['comes up off that port', 62000],
    ])('starts a stopped daemon with no identity on Desktop\'s gateway port when nothing else names one, and %s', async (_label, upOn) => {
      const { daemon, command } = await setup({ running: false, state: null }, upOn, 'default');
      await connectDesktop(4005);

      await command.parseAsync(['restart'], { from: 'user' });

      expect(daemon.stopDaemon).not.toHaveBeenCalled();
      const [spawned] = vi.mocked(daemon.spawnDaemon).mock.calls[0];
      expect(spawned).toMatchObject({ port: 4005, writeRecord: true });
      expect(spawned).not.toHaveProperty('clientType');
      expect(spawned).not.toHaveProperty('telemetryMode');
      expect(loggedOutput()).toContain(`✓ Proxy restarted at http://127.0.0.1:${upOn}`);
    });
  });

  describe('restart writes the connection record', () => {
    const validRecord = { version: 1 as const, profile: 'recorded', updatedAt: new Date().toISOString() };

    it('defers the write of a running restart to after the port check', async () => {
      const { daemon, command } = await setup({ running: true, state: runningState });

      await command.parseAsync(['restart'], { from: 'user' });

      expect(vi.mocked(daemon.spawnDaemon).mock.calls[0][0]).toMatchObject({ writeRecord: false });
    });

    it('writes the restarted daemon\'s profile when there is no valid record', async () => {
      const { daemon, command } = await setup({ running: true, state: runningState });
      vi.mocked(daemon.readConnectionRecord).mockResolvedValue(null);

      await command.parseAsync(['restart'], { from: 'user' });

      expect(daemon.writeConnectionRecord).toHaveBeenCalledTimes(1);
      expect(daemon.writeConnectionRecord).toHaveBeenCalledWith(
        expect.objectContaining({ profile: 'work', port: 4001 }),
        'work'
      );
    });

    it('writes the switched profile when --profile is given, even if a valid record exists', async () => {
      const { daemon, command } = await setup({ running: true, state: runningState });
      vi.mocked(daemon.readConnectionRecord).mockResolvedValue(validRecord);

      await command.parseAsync(['restart', '--profile', 'other'], { from: 'user' });

      expect(daemon.writeConnectionRecord).toHaveBeenCalledWith(
        expect.objectContaining({ profile: 'other' }),
        'other'
      );
    });

    it('leaves the record alone when there is no --profile and a valid record exists', async () => {
      const { daemon, command } = await setup({ running: true, state: runningState });
      vi.mocked(daemon.readConnectionRecord).mockResolvedValue(validRecord);

      await command.parseAsync(['restart'], { from: 'user' });

      expect(daemon.writeConnectionRecord).not.toHaveBeenCalled();
    });

    it('a restart of a running daemon moves the clients off the shared key and drops the record\'s older identity', async () => {
      const { daemon, command } = await setup({ running: true, state: runningState });
      vi.mocked(daemon.readConnectionRecord).mockResolvedValue(null);
      const files = await arrangeClientFiles(clientHome, OLDER_RECORD, 'k');

      await command.parseAsync(['restart'], { from: 'user' });

      expect(daemon.writeConnectionRecord).toHaveBeenCalledWith(expect.objectContaining({ profile: 'work' }), 'work');
      await expectMovedToNamedKeys(files, 'k', consoleLogSpy.mock.calls.map((call: unknown[]) => String(call[0])));
    });

    it('a restart with no daemon running starts one and moves the clients off the shared key', async () => {
      const { daemon, command } = await setup({ running: false, state: null }, 4001, 'default');
      const files = await arrangeClientFiles(clientHome, OLDER_RECORD, 'codemie-proxy');

      await command.parseAsync(['restart'], { from: 'user' });

      expect(daemon.stopDaemon).not.toHaveBeenCalled();
      expect(vi.mocked(daemon.spawnDaemon).mock.calls[0][0]).toMatchObject({ profile: 'default', port: 4001 });
      await expectMovedToNamedKeys(
        files, 'codemie-proxy', consoleLogSpy.mock.calls.map((call: unknown[]) => String(call[0]))
      );
    });

    it('writes nothing when the new daemon could not rebind the recorded port', async () => {
      const { daemon, command } = await setup({ running: true, state: runningState }, 54321);
      vi.mocked(daemon.readConnectionRecord).mockResolvedValue(null);

      await expect(command.parseAsync(['restart'], { from: 'user' })).rejects.toThrow('process.exit:1');

      expect(daemon.writeConnectionRecord).not.toHaveBeenCalled();
    });

    it.each([
      ['--profile is given', ['restart', '--profile', 'other'], validRecord, true],
      ['there is no valid record', ['restart'], null, true],
      ['a valid record exists and there is no --profile', ['restart'], validRecord, false],
    ])('decides the stopped-restart write when %s', async (_description, argv, record, expected) => {
      const { DEFAULT_DAEMON_PORT } = await import('../connect-orchestrator.js');
      const { daemon, command } = await setup({ running: false, state: null }, DEFAULT_DAEMON_PORT, 'default');
      vi.mocked(daemon.readConnectionRecord).mockResolvedValue(record);

      await command.parseAsync(argv, { from: 'user' });

      expect(vi.mocked(daemon.spawnDaemon).mock.calls[0][0]).toMatchObject({ writeRecord: expected });
      expect(daemon.writeConnectionRecord).not.toHaveBeenCalled();
    });
  });
});
