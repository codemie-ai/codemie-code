/**
 * The analytics clients of `proxy status`: found, connected, the remedy flag, the block.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { DaemonState } from '../daemon-manager.js';

let root = '';

vi.mock('@/utils/processes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/processes.js')>()),
  getCommandPath: vi.fn(async () => null),
}));

vi.mock('../connectors/vscode.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/vscode.js')>()),
  getVsCodeProductDir: vi.fn((insiders: boolean) => join(root, insiders ? 'Code - Insiders' : 'Code')),
}));

vi.mock('@/telemetry/clients/claude-desktop/claude-desktop.paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/telemetry/clients/claude-desktop/claude-desktop.paths.js')>()),
  getClaudeDesktopAppCandidates: vi.fn(() => [join(root, 'Applications', 'Claude.app')]),
}));

vi.mock('@/telemetry/clients/claude-desktop/claude-desktop.gateway.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/telemetry/clients/claude-desktop/claude-desktop.gateway.js')>()),
  readDesktopGatewayConfig: vi.fn(async () => null),
}));

vi.mock('../connectors/desktop.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/desktop.js')>()),
  readDesktopGateway: vi.fn(async () => null),
}));

vi.mock('../connectors/claude-code-otlp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connectors/claude-code-otlp.js')>()),
  hasClaudeCodeOtlpHooks: vi.fn(async () => false),
}));

vi.mock('@/agents/core/copilot-connector-scope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/agents/core/copilot-connector-scope.js')>()),
  readCopilotConnectorScope: vi.fn(async () => ({ kind: 'ok', value: { enabled: false } })),
}));

const { getCommandPath } = await import('@/utils/processes.js');
const { getClaudeDesktopAppCandidates } = await import('@/telemetry/clients/claude-desktop/claude-desktop.paths.js');
const { readDesktopGatewayConfig } = await import('@/telemetry/clients/claude-desktop/claude-desktop.gateway.js');
const { hasClaudeCodeOtlpHooks } = await import('../connectors/claude-code-otlp.js');
const { readDesktopGateway } = await import('../connectors/desktop.js');
const { readCopilotConnectorScope } = await import('@/agents/core/copilot-connector-scope.js');
const { getVsCodeProductDir } = await import('../connectors/vscode.js');
const { writeVsCodeClaudeCodeConfigAtPath } = await import('../connectors/vscode-claude-code.js');
const {
  aggregateFlags,
  collectAnalyticsClients,
  dropMembersNotFound,
  analyticsClientHint,
  ANALYTICS_CLIENT_TARGET_IDS,
  isMemberConfigured,
  isMemberFound,
  membersOf,
} = await import('../analytics-clients.js');

const state = {
  pid: process.pid,
  port: 4001,
  url: 'http://127.0.0.1:4001',
  profile: 'work',
  gatewayKey: 'codemie-proxy',
  version: '0.17.0',
  startedAt: new Date().toISOString(),
} as DaemonState;

const originalPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

async function present(...parts: string[]): Promise<void> {
  const path = join(root, ...parts);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '');
}

const stableDir = () => mkdir(join(root, 'Code'), { recursive: true });
const insidersDir = () => mkdir(join(root, 'Code - Insiders'), { recursive: true });
/** The extension's route in an edition's settings, as `--vscode-claude-code` writes it for gateway key `key`. */
const route = (edition: 'Code' | 'Code - Insiders', port: number, key = 'codemie-proxy') =>
  writeVsCodeClaudeCodeConfigAtPath(join(root, edition, 'User', 'settings.json'), `http://127.0.0.1:${port}`, key);
const desktopApp = () => mkdir(join(root, 'Applications', 'Claude.app'), { recursive: true });
const binaries = (claude: boolean, copilot: boolean) =>
  vi.mocked(getCommandPath).mockImplementation(async (command) =>
    (command === 'claude' && claude) || (command === 'copilot' && copilot) ? `/usr/bin/${command}` : null);
/** `which` runs out for every command: as `getCommandPath` does, it rejects only for a caller that asks, else null. */
const timedOut = () =>
  vi.mocked(getCommandPath).mockImplementation(async (_command, _timeoutMs, options) => {
    if (options?.throwIfUnanswered) throw new Error('Command timed out after 3000ms');
    return null;
  });
const scopes = (enabled: boolean) =>
  vi.mocked(readCopilotConnectorScope).mockResolvedValue({ kind: 'ok', value: enabled ? { enabled: true, scope: 'user' } : { enabled: false } });

const pick = (rows: Awaited<ReturnType<typeof collectAnalyticsClients>>, client: string) =>
  rows.find((r) => r.client === client)!;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codemie-analytics-clients-'));
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('USERPROFILE', join(root, 'home'));
  vi.stubEnv('CODEMIE_COPILOT_BIN', '');
  binaries(false, false);
  scopes(false);
  vi.mocked(hasClaudeCodeOtlpHooks).mockResolvedValue(false);
  vi.mocked(readDesktopGatewayConfig).mockReset().mockResolvedValue(null);
  vi.mocked(readDesktopGateway).mockReset().mockResolvedValue(null);
});

afterEach(async () => {
  setPlatform(originalPlatform);
  vi.unstubAllEnvs();
  // Windows can briefly hold a handle (the logger) on a file under the temp home.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('collectAnalyticsClients', () => {
  it('reads every client found and connected, the aggregate flags, in order', async () => {
    binaries(true, true);
    await stableDir();
    await route('Code', 4001);
    await desktopApp();
    vi.mocked(hasClaudeCodeOtlpHooks).mockResolvedValue(true);
    scopes(true);
    vi.mocked(readDesktopGatewayConfig).mockResolvedValue({ port: 4001, apiKey: 'codemie-proxy.claude-desktop' });

    const rows = await collectAnalyticsClients(state);

    expect(rows.map(({ client, found, connected, flag }) => ({ client, found, connected, flag }))).toEqual([
      { client: 'claude-code', found: true, connected: true, flag: '--claude-otlp' },
      { client: 'vscode-claude-code', found: true, connected: true, flag: '--claude-otlp' },
      { client: 'claude-desktop', found: true, connected: true, flag: '--claude-otlp' },
      { client: 'copilot-chat', found: true, connected: true, flag: '--copilot-otlp' },
      { client: 'copilot-cli', found: true, connected: true, flag: '--copilot-otlp' },
    ]);
  });

  it('names each member flag when nothing is found or connected', async () => {
    const rows = await collectAnalyticsClients(state);

    expect(rows.map(({ client, found, connected, flag, otherGateway }) => ({ client, found, connected, flag, otherGateway }))).toEqual([
      { client: 'claude-code', found: false, connected: false, flag: '--claude-code-otlp', otherGateway: false },
      { client: 'vscode-claude-code', found: false, connected: false, flag: '--vscode-claude-code', otherGateway: false },
      { client: 'claude-desktop', found: false, connected: false, flag: '--claude-desktop', otherGateway: false },
      { client: 'copilot-chat', found: false, connected: false, flag: '--copilot-chat-otlp', otherGateway: false },
      { client: 'copilot-cli', found: false, connected: false, flag: '--copilot-cli-otlp', otherGateway: false },
    ]);
  });

  it('names the aggregate of a client found and not connected', async () => {
    binaries(true, true);
    await stableDir();
    await desktopApp();

    const rows = await collectAnalyticsClients(state);

    expect(rows.map((r) => [r.found, r.connected, r.flag])).toEqual([
      [true, false, '--claude-otlp'],
      [true, false, '--claude-otlp'],
      [true, false, '--claude-otlp'],
      [true, false, '--copilot-otlp'],
      [true, false, '--copilot-otlp'],
    ]);
  });

  it('finds the extension by the Insiders directory alone and names --insiders; Copilot Chat is not found', async () => {
    await insidersDir();

    const rows = await collectAnalyticsClients(state);

    expect(pick(rows, 'vscode-claude-code')).toMatchObject({ found: true, flag: '--claude-otlp --insiders' });
    expect(pick(rows, 'copilot-chat')).toMatchObject({ found: false, flag: '--copilot-chat-otlp' });
  });

  it('reads no gateway config and no Desktop connection with no daemon', async () => {
    await desktopApp();
    vi.mocked(readDesktopGatewayConfig).mockResolvedValue({ port: 4001, apiKey: 'codemie-proxy' });

    const rows = await collectAnalyticsClients(null);

    expect(pick(rows, 'claude-desktop')).toMatchObject({ found: true, connected: false, otherGateway: false });
    expect(readDesktopGatewayConfig).not.toHaveBeenCalled();
  });

  it('reads Desktop on another port than the daemon as not connected, no other gateway', async () => {
    await desktopApp();
    vi.mocked(readDesktopGatewayConfig).mockResolvedValue({ port: 4999, apiKey: 'codemie-proxy' });

    expect(pick(await collectAnalyticsClients(state), 'claude-desktop'))
      .toMatchObject({ connected: false, otherGateway: false });
  });

  it('reads Desktop on a local gateway with a key this proxy refuses as another gateway', async () => {
    await desktopApp();
    vi.mocked(readDesktopGatewayConfig).mockResolvedValue({ port: 4001, apiKey: 'someone-else' });

    expect(pick(await collectAnalyticsClients(state), 'claude-desktop'))
      .toMatchObject({ connected: false, otherGateway: true });
  });

  it('reads Claude Code connected and found by its hooks with no binary', async () => {
    vi.mocked(hasClaudeCodeOtlpHooks).mockResolvedValue(true);

    expect(pick(await collectAnalyticsClients(state), 'claude-code'))
      .toMatchObject({ found: true, connected: true, flag: '--claude-otlp' });
  });

  it('reads the extension not connected and not found with the hooks and no VS Code directory', async () => {
    vi.mocked(hasClaudeCodeOtlpHooks).mockResolvedValue(true);

    expect(pick(await collectAnalyticsClients(state), 'vscode-claude-code'))
      .toMatchObject({ found: false, connected: false, flag: '--vscode-claude-code' });
  });

  it('reads the extension with the Insiders directory alone and the hooks, no route in either edition, not connected', async () => {
    await insidersDir();
    vi.mocked(hasClaudeCodeOtlpHooks).mockResolvedValue(true);

    expect(pick(await collectAnalyticsClients(state), 'vscode-claude-code'))
      .toMatchObject({ found: true, connected: false, flag: '--claude-otlp --insiders' });
  });

  it('reads the extension connected by its Insiders route at the daemon port with the key vscode-claude-code', async () => {
    await insidersDir();
    await route('Code - Insiders', 4001);
    vi.mocked(hasClaudeCodeOtlpHooks).mockResolvedValue(true);

    expect(pick(await collectAnalyticsClients(state), 'vscode-claude-code'))
      .toMatchObject({ found: true, connected: true, flag: '--claude-otlp --insiders' });
  });

  it('reads the extension not connected by a route at another port than the running daemon', async () => {
    await insidersDir();
    await route('Code - Insiders', 4999);
    vi.mocked(hasClaudeCodeOtlpHooks).mockResolvedValue(true);

    expect(pick(await collectAnalyticsClients(state), 'vscode-claude-code').connected).toBe(false);
  });

  it('reads the extension not connected by a route with a key the running daemon refuses', async () => {
    await insidersDir();
    await route('Code - Insiders', 4001, 'someone-else');
    vi.mocked(hasClaudeCodeOtlpHooks).mockResolvedValue(true);

    expect(pick(await collectAnalyticsClients(state), 'vscode-claude-code').connected).toBe(false);
  });

  it('with no daemon reads the extension connected by any stable loopback route and the hooks, not without a route', async () => {
    await stableDir();
    vi.mocked(hasClaudeCodeOtlpHooks).mockResolvedValue(true);
    expect(pick(await collectAnalyticsClients(null), 'vscode-claude-code').connected).toBe(false);

    await route('Code', 4999, 'someone-else');
    expect(pick(await collectAnalyticsClients(null), 'vscode-claude-code').connected).toBe(true);
  });

  it('reads the extension not connected by its route without the hooks', async () => {
    await stableDir();
    await route('Code', 4001);

    expect(pick(await collectAnalyticsClients(state), 'vscode-claude-code').connected).toBe(false);
  });

  it('finds Claude Code by the native installer binary on darwin, not on win32', async () => {
    await present('home', '.local', 'bin', 'claude');

    setPlatform('darwin');
    expect(pick(await collectAnalyticsClients(state), 'claude-code').found).toBe(true);
    setPlatform('win32');
    expect(pick(await collectAnalyticsClients(state), 'claude-code').found).toBe(false);
  });

  it('looks the binaries up with the 3000 ms timeout and reads null as not found', async () => {
    const rows = await collectAnalyticsClients(state);

    expect(pick(rows, 'claude-code').found).toBe(false);
    expect(pick(rows, 'copilot-cli').found).toBe(false);
    expect(getCommandPath).toHaveBeenCalledWith('claude', 3000, { throwIfUnanswered: true });
    expect(getCommandPath).toHaveBeenCalledWith('copilot', 3000, { throwIfUnanswered: true });
  });

  it('counts a timed-out claude and copilot lookup as found, with no ~/.local/bin/claude', async () => {
    timedOut();

    const rows = await collectAnalyticsClients(state);

    expect(pick(rows, 'claude-code').found).toBe(true);
    expect(pick(rows, 'copilot-cli').found).toBe(true);
    expect(await isMemberFound('claudeCodeOtlp', { insiders: false })).toBe(true);
    expect(await isMemberFound('copilotCliOtlp', { insiders: false })).toBe(true);
  });

  it('does not find claudeCodeOtlp or copilotCliOtlp by a clean no-such-command lookup', async () => {
    expect(await isMemberFound('claudeCodeOtlp', { insiders: false })).toBe(false);
    expect(await isMemberFound('copilotCliOtlp', { insiders: false })).toBe(false);
  });

  it('counts a rejected lookup as found and a rejected reader as not connected', async () => {
    vi.mocked(getCommandPath).mockImplementation(async (command) => {
      if (command === 'copilot') throw new Error('spawn failed');
      return null;
    });
    vi.mocked(hasClaudeCodeOtlpHooks).mockRejectedValue(new Error('unreadable'));

    const rows = await collectAnalyticsClients(state);

    expect(pick(rows, 'copilot-cli').found).toBe(true);
    expect(pick(rows, 'claude-code').connected).toBe(false);
  });

  it('finds the Copilot CLI by an absolute CODEMIE_COPILOT_BIN that exists, with no command lookup of it', async () => {
    await present('bin', 'copilot');
    const bin = join(root, 'bin', 'copilot');
    vi.stubEnv('CODEMIE_COPILOT_BIN', bin);

    expect(pick(await collectAnalyticsClients(state), 'copilot-cli').found).toBe(true);
    expect(vi.mocked(getCommandPath).mock.calls.map((call) => call[0])).not.toContain(bin);
  });

  it('reads the Copilot CLI not found by an absolute CODEMIE_COPILOT_BIN of no file', async () => {
    vi.mocked(getCommandPath).mockImplementation(async (command) => `/usr/bin/${command}`);
    vi.stubEnv('CODEMIE_COPILOT_BIN', join(root, 'missing', 'copilot'));

    expect(pick(await collectAnalyticsClients(state), 'copilot-cli').found).toBe(false);
  });

  it('finds the Copilot CLI by a relative CODEMIE_COPILOT_BIN that exists, with no command lookup of it', async () => {
    await present('bin', 'copilot');
    const bin = relative(process.cwd(), join(root, 'bin', 'copilot'));
    vi.stubEnv('CODEMIE_COPILOT_BIN', bin);

    expect(pick(await collectAnalyticsClients(state), 'copilot-cli').found).toBe(true);
    expect(vi.mocked(getCommandPath).mock.calls.map((call) => call[0])).not.toContain(bin);
  });

  it('reads the Copilot CLI not found by a relative CODEMIE_COPILOT_BIN of no file, with no command lookup of it', async () => {
    vi.mocked(getCommandPath).mockImplementation(async (command) => `/usr/bin/${command}`);
    const bin = relative(process.cwd(), join(root, 'missing', 'copilot'));
    vi.stubEnv('CODEMIE_COPILOT_BIN', bin);

    expect(pick(await collectAnalyticsClients(state), 'copilot-cli').found).toBe(false);
    expect(vi.mocked(getCommandPath).mock.calls.map((call) => call[0])).not.toContain(bin);
  });

  it('looks a bare CODEMIE_COPILOT_BIN name up on PATH', async () => {
    vi.mocked(getCommandPath).mockImplementation(async (command) => (command === 'my-copilot' ? '/usr/bin/my-copilot' : null));
    vi.stubEnv('CODEMIE_COPILOT_BIN', 'my-copilot');

    expect(pick(await collectAnalyticsClients(state), 'copilot-cli').found).toBe(true);
    expect(getCommandPath).toHaveBeenCalledWith('my-copilot', 3000, { throwIfUnanswered: true });
  });

  it('reads a backslash CODEMIE_COPILOT_BIN on win32 as a path of no file, with no command lookup of it', async () => {
    setPlatform('win32');
    vi.mocked(getCommandPath).mockImplementation(async (command) => `C:\\tools\\${command}`);
    vi.stubEnv('CODEMIE_COPILOT_BIN', 'bin\\copilot');

    expect(pick(await collectAnalyticsClients(state), 'copilot-cli').found).toBe(false);
    expect(vi.mocked(getCommandPath).mock.calls.map((call) => call[0])).not.toContain('bin\\copilot');
  });

  it('looks a backslash CODEMIE_COPILOT_BIN up on PATH on linux, where a backslash is a file-name character', async () => {
    setPlatform('linux');
    vi.mocked(getCommandPath).mockImplementation(async (command) => `/usr/bin/${command}`);
    vi.stubEnv('CODEMIE_COPILOT_BIN', 'bin\\copilot');

    expect(pick(await collectAnalyticsClients(state), 'copilot-cli').found).toBe(true);
    expect(getCommandPath).toHaveBeenCalledWith('bin\\copilot', 3000, { throwIfUnanswered: true });
  });

  it('reads both Copilot rows not connected with a corrupt scope file', async () => {
    vi.mocked(readCopilotConnectorScope).mockResolvedValue({ kind: 'corrupt' });

    const rows = await collectAnalyticsClients(state);

    expect(pick(rows, 'copilot-chat').connected).toBe(false);
    expect(pick(rows, 'copilot-cli').connected).toBe(false);
  });

  it('reads each Copilot row from the scope of its own connector', async () => {
    vi.mocked(readCopilotConnectorScope).mockImplementation(async (connectorId) => ({
      kind: 'ok',
      value: connectorId === 'copilot-cli-otlp' ? { enabled: true, scope: 'user' } : { enabled: false },
    }));

    const rows = await collectAnalyticsClients(state);

    expect(pick(rows, 'copilot-cli').connected).toBe(true);
    expect(pick(rows, 'copilot-chat').connected).toBe(false);
  });
});

describe('isMemberFound', () => {
  it('finds claudeCodeOtlp by the stable VS Code directory with no binary', async () => {
    await stableDir();
    expect(await isMemberFound('claudeCodeOtlp', { insiders: false })).toBe(true);
  });

  it('finds claudeCodeOtlp by the Insiders directory alone only with insiders', async () => {
    await insidersDir();
    expect(await isMemberFound('claudeCodeOtlp', { insiders: false })).toBe(false);
    expect(await isMemberFound('claudeCodeOtlp', { insiders: true })).toBe(true);
  });

  it('does not find vscodeClaudeCode by the Insiders directory alone without insiders', async () => {
    await insidersDir();
    expect(await isMemberFound('vscodeClaudeCode', { insiders: false })).toBe(false);
  });

  it('does not find copilotChatOtlp by the Insiders directory alone, even with insiders', async () => {
    await insidersDir();
    expect(await isMemberFound('copilotChatOtlp', { insiders: true })).toBe(false);
  });

  it('finds claudeDesktop on a platform with no candidates', async () => {
    vi.mocked(getClaudeDesktopAppCandidates).mockReturnValueOnce([]);
    expect(await isMemberFound('claudeDesktop', { insiders: false })).toBe(true);
  });

  it('counts a lookup that throws as found', async () => {
    vi.mocked(getVsCodeProductDir).mockImplementationOnce(() => {
      throw new Error('unsupported platform');
    });
    expect(await isMemberFound('vscodeClaudeCode', { insiders: false })).toBe(true);
  });
});

describe('analyticsClientHint', () => {
  const row = (client: string, label: string, found: boolean, connected: boolean, flag: string, otherGateway = false) =>
    ({ client, label, found, connected, flag, otherGateway }) as Awaited<ReturnType<typeof collectAnalyticsClients>>[number];
  const rows = [
    row('claude-code', 'Claude Code', true, true, '--claude-otlp'),
    row('vscode-claude-code', 'VS Code Claude Code extension', true, true, '--claude-otlp'),
    row('claude-desktop', 'Claude Desktop', true, false, '--claude-otlp'),
    row('copilot-chat', 'Copilot Chat', true, false, '--copilot-otlp'),
    row('copilot-cli', 'Copilot CLI', false, false, '--copilot-cli-otlp'),
  ];

  it('names the vendor flag for a found client, its own flag for one not found, nothing for a connected one', () => {
    expect(rows.map((r) => analyticsClientHint(r, true))).toEqual([
      undefined,
      undefined,
      'not connected — run: codemie proxy connect --claude-otlp',
      'not connected — run: codemie proxy connect --copilot-otlp',
      'not found — if it is installed, run: codemie proxy connect --copilot-cli-otlp',
    ]);
  });

  it('names no command for a found client without commands', () => {
    expect(rows.slice(2).map((r) => analyticsClientHint(r, false))).toEqual([
      'not connected',
      'not connected',
      'not found — if it is installed, run: codemie proxy connect --copilot-cli-otlp',
    ]);
  });

  it('names another local gateway for Desktop', () => {
    expect(analyticsClientHint(row('claude-desktop', 'Claude Desktop', true, false, '--claude-otlp', true), true))
      .toBe('points at a local gateway with a key this proxy does not accept — ' +
        'if it should use CodeMie, run: codemie proxy connect --claude-otlp');
  });

  it.each([
    [false, 'not found — if it is installed, run: codemie proxy connect --claude-desktop'],
    [true, 'points at a local gateway with a key this proxy does not accept — ' +
      'if it should use CodeMie, run: codemie proxy connect --claude-desktop'],
  ])('a not found Desktop row on another local gateway, commands %s', (commands, hint) => {
    const desktop = row('claude-desktop', 'Claude Desktop', false, false, '--claude-desktop', true);
    expect(analyticsClientHint(desktop, commands)).toBe(hint);
  });

  it('maps every analytics client onto one client-target row', async () => {
    const { CLIENT_TARGETS } = await import('../client-targets.js');
    const ids = Object.values(ANALYTICS_CLIENT_TARGET_IDS);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(CLIENT_TARGETS.some((target) => target.id === id), id).toBe(true);
  });
});

describe('membersOf / aggregateFlags', () => {
  it('gives the members of the aggregates given, none for none', () => {
    expect([...membersOf(['claude-otlp'])]).toEqual(['claudeDesktop', 'vscodeClaudeCode', 'claudeCodeOtlp']);
    expect([...membersOf(['copilot-otlp'])]).toEqual(['copilotChatOtlp', 'copilotCliOtlp']);
    expect(membersOf([]).size).toBe(0);
  });

  it('joins the flags in the declared order whatever the order given', () => {
    expect(aggregateFlags(['claude-otlp'])).toBe('--claude-otlp');
    expect(aggregateFlags(['claude-otlp', 'copilot-otlp'])).toBe('--claude-otlp --copilot-otlp');
    expect(aggregateFlags(['copilot-otlp', 'claude-otlp'])).toBe('--claude-otlp --copilot-otlp');
  });
});

describe('dropMembersNotFound', () => {
  const targets = { claudeDesktop: true, vscodeClaudeCode: true, claudeCodeOtlp: true, omp: true };

  it('gives an equal copy and runs no lookup with no aggregate', async () => {
    for (const lookup of [getClaudeDesktopAppCandidates, getCommandPath, getVsCodeProductDir]) vi.mocked(lookup).mockClear();
    const result = await dropMembersNotFound(targets, [], { insiders: false });

    expect(result).toEqual(targets);
    expect(result).not.toBe(targets);
    expect(getClaudeDesktopAppCandidates).not.toHaveBeenCalled();
    expect(getCommandPath).not.toHaveBeenCalled();
    expect(getVsCodeProductDir).not.toHaveBeenCalled();
  });

  it('sets a member not found to false and leaves a target outside the aggregate as given', async () => {
    await desktopApp();

    expect(await dropMembersNotFound(targets, ['claude-otlp'], { insiders: false })).toEqual({
      claudeDesktop: true, vscodeClaudeCode: false, claudeCodeOtlp: false, omp: true,
    });
  });
});

describe('isMemberConfigured', () => {
  const run = { insiders: false };

  it('claudeDesktop — configured when its applied config points at this proxy', async () => {
    expect(await isMemberConfigured('claudeDesktop', run)).toBe(false);
    vi.mocked(readDesktopGateway).mockResolvedValue({ port: 4001 });
    expect(await isMemberConfigured('claudeDesktop', run)).toBe(true);
  });

  it('claudeDesktop — a loopback gateway with a key this proxy does not accept is not configured', async () => {
    vi.mocked(readDesktopGatewayConfig).mockResolvedValue({ port: 4010, apiKey: 'another-tool' });
    expect(await isMemberConfigured('claudeDesktop', run)).toBe(false);
  });

  it("vscodeClaudeCode — configured when the run's edition directory exists", async () => {
    await insidersDir();
    expect(await isMemberConfigured('vscodeClaudeCode', run)).toBe(false);
    expect(await isMemberConfigured('vscodeClaudeCode', { insiders: true })).toBe(true);
  });

  it('claudeCodeOtlp — configured when the CodeMie hooks are in place', async () => {
    expect(await isMemberConfigured('claudeCodeOtlp', run)).toBe(false);
    vi.mocked(hasClaudeCodeOtlpHooks).mockResolvedValue(true);
    expect(await isMemberConfigured('claudeCodeOtlp', run)).toBe(true);
  });

  it.each([['copilotChatOtlp' as const], ['copilotCliOtlp' as const]])('%s — configured when its scope is enabled', async (member) => {
    expect(await isMemberConfigured(member, run)).toBe(false);
    scopes(true);
    expect(await isMemberConfigured(member, run)).toBe(true);
  });

  it('a corrupt Copilot scope reads as not configured', async () => {
    vi.mocked(readCopilotConnectorScope).mockResolvedValue({ kind: 'corrupt' });
    expect(await isMemberConfigured('copilotCliOtlp', run)).toBe(false);
  });

  it('a reader that rejects reads as configured', async () => {
    vi.mocked(hasClaudeCodeOtlpHooks).mockRejectedValue(new Error('unreadable'));
    expect(await isMemberConfigured('claudeCodeOtlp', run)).toBe(true);
  });
});
