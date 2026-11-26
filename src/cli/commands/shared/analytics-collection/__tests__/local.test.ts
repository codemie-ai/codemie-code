/**
 * The local collection's own parts on a home of its own, with stand-in daemon processes: the hooks' policy, the
 * exported file, the guard of the proxy commands, `proxy start` / `restart`, the status line and the teardown.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RawSessionData } from '../../../analytics/data-loader.js';
import type { CostSummary, SessionCostIndex } from '../../../analytics/cost/types.js';
import type { AnalyticsSource } from '../../../analytics/sources/types.js';
import type { SyncSettings } from '../../../analytics/sync/types.js';
import { dailyWindow } from '../../../analytics/sync/window.js';
import { isPidAlive, setUpHome, spawnedArgs, stateFile, tearDownHome, writeLiveState } from './stand.js';

vi.mock('@/utils/processes.js', async (importOriginal) => {
  const { isPidAlive: alive, standInSpawn: spawnStandIn } = await import('./stand.js');
  return {
    ...(await importOriginal<typeof import('@/utils/processes.js')>()),
    spawnDetached: vi.fn(spawnStandIn),
    // The start-time comparison runs `ps`: a live pid is the daemon.
    isOwnerAlive: vi.fn(async ({ pid }: { pid: number }) => alive(pid)),
    // No `codemie` on PATH: the hook commands name this build.
    getCommandPath: vi.fn(async () => null),
  };
});
vi.mock('@/utils/cli-updater.js', async (importOriginal) => {
  const { OWN_VERSION } = await import('./stand.js');
  return {
    ...(await importOriginal<typeof import('@/utils/cli-updater.js')>()),
    getCurrentCliVersion: vi.fn(async () => OWN_VERSION),
  };
});

const SETTINGS: SyncSettings = {
  webhookUrl: 'https://example.invalid/hook?sig=FAKE',
  format: 'json',
  includeExternal: 'never',
  at: '03:00',
  local: true,
  localJob: { node: '/usr/bin/node', entry: '/opt/codemie/bin/codemie.js' },
};
const REFUSAL =
  'This machine runs the local analytics mode of `codemie analytics sync`. Run `codemie analytics sync uninstall` first.';

let home: string;
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  home = setUpHome();
  vi.resetModules();
  vi.clearAllMocks();
  writeFileSync(join(home, 'analytics-sync.json'), JSON.stringify(SETTINGS));
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(async () => {
  log.mockRestore();
  await tearDownHome(home);
});

async function collection(settings: SyncSettings = SETTINGS) {
  return (await import('../local.js')).localCollection(settings);
}

const NOW = new Date('2026-10-29T12:00:00.000Z');
const EMAIL = 'Jane.Doe@x.com';
const OTLP_NAME = 'codemie-analytics-jane-doe-x-com-2026-10-29.otlp.jsonl.gz';
const REPORT_NAME = 'codemie-analytics-jane-doe-x-com-2026-10-29.report.json';

/** A session in the analytics folder, its file written a day before NOW. */
function folderSession(home: string, sessionId: string): void {
  const folder = join(home, 'analytics', 'sessions');
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${sessionId}.hooks.jsonl`);
  writeFileSync(file, `${JSON.stringify({ resourceLogs: [] })}\n`);
  const written = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
  utimesSync(file, written, written);
}

/** An analytics source holding `sessionIds` with their cost, so the report needs no client logs. */
function reportSessions(...sessionIds: string[]): AnalyticsSource {
  const rawSessions = sessionIds.map((sessionId) => ({
    sessionId,
    startEvent: { recordId: sessionId, type: 'session_start', timestamp: 1000, codeMieSessionId: sessionId, agentName: 'claude', syncStatus: 'synced', data: { provider: 'native', workingDirectory: '/repo', startTime: 1000 } },
    endEvent: { recordId: `${sessionId}-end`, type: 'session_end', timestamp: 2000, codeMieSessionId: sessionId, agentName: 'claude', syncStatus: 'synced', data: { endTime: 2000, duration: 1000, totalTurns: 1 } },
    deltas: [],
  })) as unknown as RawSessionData[];
  const index: SessionCostIndex = new Map(sessionIds.map((sessionId) => [sessionId, {
    sessionId,
    tokens: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0, total: 150 },
    costUSD: 0.01,
    perModel: [],
    priced: true,
    hadLog: true,
  }]));
  const summary: CostSummary = { totalCostUSD: 0.01 * sessionIds.length, pricedSessions: sessionIds.length, totalSessions: sessionIds.length, unpricedModels: [], estimatedModels: [], localModels: [] };
  return { load: async () => ({ rawSessions, ...(sessionIds.length > 0 && { cost: { index, summary } }) }) };
}

describe('LocalExportSource', () => {
  const input = () => ({ window: dailyWindow(NOW, null, 7), email: EMAIL, includeExternal: false, now: NOW });

  async function build(source: AnalyticsSource) {
    const { LocalExportSource } = await import('../local.js');
    const { OtlpFolderSource } = await import('../../../analytics/sync/otlp-file-builder.js');
    const { ReportSource } = await import('../../../analytics/sync/report-builder.js');
    return new LocalExportSource(new OtlpFolderSource(), new ReportSource(source)).build(input());
  }

  it('is the export source of the local collection', async () => {
    const { LocalExportSource } = await import('../local.js');
    expect((await collection()).exportSource()).toBeInstanceOf(LocalExportSource);
  });

  it('a folder session and a report session: the OTLP file, then the report ReportSource alone builds', async () => {
    folderSession(home, 's1');
    const { ReportSource } = await import('../../../analytics/sync/report-builder.js');
    const alone = await new ReportSource(reportSessions('r1')).build(input());

    const files = await build(reportSessions('r1'));

    expect(files?.map((file) => file.fileName)).toEqual([OTLP_NAME, REPORT_NAME]);
    expect(files?.[1].bytes.equals(alone![0].bytes)).toBe(true);
  });

  it('a report session alone: that one report', async () => {
    expect((await build(reportSessions('r1')))?.map((file) => file.fileName)).toEqual([REPORT_NAME]);
  });

  it('a folder session alone: the OTLP file alone', async () => {
    folderSession(home, 's1');
    expect((await build(reportSessions()))?.map((file) => file.fileName)).toEqual([OTLP_NAME]);
  });

  it('neither: null', async () => {
    expect(await build(reportSessions())).toBeNull();
  });
});

describe('localCollection', () => {
  it('collects under LocalPolicy built from the --include-external answer of this platform', async () => {
    const { LocalPolicy } = await import('../local-policy.js');
    const gate = async (): Promise<'continue' | 'stop'> => 'continue';
    const always = (await collection({ ...SETTINGS, includeExternal: 'always' })).hookPolicy();
    const never = (await collection({ ...SETTINGS, includeExternal: 'never' })).hookPolicy();

    expect(always).toBeInstanceOf(LocalPolicy);
    expect(await always.admit('s-1', gate, () => false)).toBe('continue');
    expect(await never.admit('s-1', gate, () => false)).toBe('stop');
  });

  it('prints the mode as the status line of sync status', async () => {
    expect((await collection()).statusLines()).toEqual(['Mode: local — delivers the OTLP files of ~/.codemie/analytics/sessions beside the JSON report']);
  });

  it('its doctor plan names the local next steps, no status lines, no keyed probe and the mode as the daemon label', async () => {
    const { doctor } = await collection();
    const state = { pid: 1, port: 4001, url: 'http://127.0.0.1:4001', profile: '', gatewayKey: 'codemie-proxy', mode: 'local' as const, startedAt: '2026-11-22T00:00:00.000Z' };
    const steps = ['codemie proxy start', 'codemie analytics sync status', 'codemie proxy doctor'];

    expect(doctor.nextSteps('stop')).toEqual(steps);
    expect(doctor.nextSteps('status')).toEqual(steps);
    expect(doctor.statusLines(state)).toEqual([]);
    expect(doctor.authProbe(true)).toBe(false);
    expect(doctor.daemonLabel(state)).toBe('local analytics mode');
  });

  it.each(['connect', 'disconnect'] as const)('refuses proxy %s, naming sync uninstall', async (name) => {
    const { ConfigurationError } = await import('@/utils/errors.js');
    const local = await collection();

    expect(() => local.guardProxyCommand(name)).toThrow(ConfigurationError);
    expect(() => local.guardProxyCommand(name)).toThrow(REFUSAL);
  });
});

describe('localCollection.daemon', () => {
  it('start with no daemon spawns the local one on the port given and prints its URL', async () => {
    await (await collection()).daemon.start({ port: '4555' });

    expect(await spawnedArgs()).toEqual([['--mode', 'local', '--gateway-key', 'codemie-proxy', '--state-file', stateFile(home), '--port', '4555']]);
    expect(log).toHaveBeenCalledWith('The local analytics proxy is running on http://127.0.0.1:4555.');
  });

  it('start with a live local daemon spawns nothing and prints its URL', async () => {
    await writeLiveState(home, { mode: 'local', port: 4002 });

    await (await collection()).daemon.start({});

    expect(await spawnedArgs()).toEqual([]);
    expect(log).toHaveBeenCalledWith('The local analytics proxy is running on http://127.0.0.1:4002.');
  });

  it('restart stops the live daemon and starts the local one on its port', async () => {
    const old = await writeLiveState(home, { mode: 'local', port: 4777 });

    await (await collection()).daemon.restart({});

    expect(isPidAlive(old)).toBe(false);
    expect(await spawnedArgs()).toEqual([['--mode', 'local', '--gateway-key', 'codemie-proxy', '--state-file', stateFile(home), '--port', '4777']]);
    expect(log).toHaveBeenCalledWith('The local analytics proxy is running on http://127.0.0.1:4777.');
  });

  it.each([
    ['start', (local: Awaited<ReturnType<typeof collection>>) => local.daemon.start({ profile: 'work' })],
    ['restart', (local: Awaited<ReturnType<typeof collection>>) => local.daemon.restart({ profile: 'work' })],
  ] as const)('%s with a --profile is refused and starts or stops nothing', async (_name, run) => {
    const running = await writeLiveState(home, { mode: 'local' });

    await expect(run(await collection())).rejects.toThrow(REFUSAL);
    expect(await spawnedArgs()).toEqual([]);
    expect(isPidAlive(running)).toBe(true);
  });
});

describe('localCollection.teardown', () => {
  async function wireClients(): Promise<void> {
    const { writeClaudeCodeOtlpConfig } = await import('../../../proxy/connectors/claude-code-otlp.js');
    const { writeCopilotCliOtlpConfig } = await import('../../../proxy/connectors/copilot-cli-otlp.js');
    await writeClaudeCodeOtlpConfig({ promptStatus: null, keepProjectList: true });
    await writeCopilotCliOtlpConfig({ keepProjectList: true });
  }

  it('removes the hooks, then under the daemon lock stops the local daemon, resolves the moves, removes the spool and the marks, and the install last', async () => {
    const daemon = await writeLiveState(home, { mode: 'local' });
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }));
    await wireClients();
    const folder = join(home, 'analytics', 'sessions');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 's1.hooks.jsonl'), 'abc\ndef\n');
    writeFileSync(join(folder, 's1.moving'), JSON.stringify({
      lengths: { 's1.hooks.jsonl': 4 },
      from: { hooks: 0, logsJson: 0, metricsJson: 0, tracesJson: 0 },
      upto: { hooks: 0, logsJson: 0, metricsJson: 0, tracesJson: 0 },
      nowMs: 0,
    }));
    mkdirSync(join(home, 'analytics', 'spool'), { recursive: true });
    writeFileSync(join(home, 'analytics', 'spool', 's1.hooks.ndjson'), 'x\n');
    mkdirSync(join(home, 'analytics', 'excluded'), { recursive: true });
    writeFileSync(join(home, 'analytics', 'excluded', 's2'), '');
    const { hasClaudeCodeOtlpHooks } = await import('../../../proxy/connectors/claude-code-otlp.js');
    const { readCopilotConnectorScope } = await import('@/agents/core/copilot-connector-scope.js');
    const local = await collection();
    const atRemoval: Record<string, unknown> = {};
    let launched: Promise<void> | undefined;
    const { isOwnerAlive } = await import('@/utils/processes.js');
    let parked!: () => void;
    const hookParked = new Promise<void>((resolve) => {
      parked = resolve;
    });
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    await local.teardown(async () => {
      Object.assign(atRemoval, {
        lockHeld: existsSync(join(home, 'proxy-daemon.lock')),
        daemonAlive: isPidAlive(daemon),
        claudeHooks: await hasClaudeCodeOtlpHooks(),
        copilotCliScope: await readCopilotConnectorScope('copilot-cli-otlp'),
        marker: existsSync(join(folder, 's1.moving')),
        folderFile: readFileSync(join(folder, 's1.hooks.jsonl'), 'utf-8'),
        spool: existsSync(join(home, 'analytics', 'spool')),
        excluded: existsSync(join(home, 'analytics', 'excluded')),
      });
      // A hook between the stop and the removal waits for the lock, then finds no settings. Its wait is held in the
      // judgement of the lock's holder, after its read of the lock file has closed, until the lock is released: no
      // handle of this process is open on the lock file when the release removes it.
      vi.mocked(isOwnerAlive).mockImplementation(async ({ pid }) => {
        if (pid !== process.pid) return isPidAlive(pid);
        parked();
        await gate;
        return true;
      });
      launched = local.launcher('claude-code-otlp', 'Stop');
      await hookParked;
      const { unlinkSync } = await import('node:fs');
      unlinkSync(join(home, 'analytics-sync.json'));
    });
    openGate();
    await launched;

    expect(atRemoval).toEqual({
      lockHeld: true,
      daemonAlive: false,
      claudeHooks: false,
      copilotCliScope: { kind: 'ok', value: { enabled: false } },
      marker: false,
      folderFile: 'abc\n',
      spool: false,
      excluded: false,
    });
    expect(await spawnedArgs()).toEqual([]);
    expect(existsSync(join(folder, 's1.hooks.jsonl'))).toBe(true);
    const claude = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
    expect(claude.model).toBe('opus');
    expect(claude.env ?? {}).not.toHaveProperty('CLAUDE_CODE_ENABLE_TELEMETRY');
    expect(claude.env ?? {}).not.toHaveProperty('OTEL_LOGS_EXPORTER');
    expect(claude.env ?? {}).not.toHaveProperty('OTEL_EXPORTER_OTLP_ENDPOINT');
  });

  it('leaves Claude Code settings with no CodeMie hook byte for byte, and their backup in place', async () => {
    const claudeDir = join(home, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const own = JSON.stringify({
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.invalid',
      },
    }, null, 2);
    writeFileSync(join(claudeDir, 'settings.json'), own);
    writeFileSync(join(claudeDir, 'settings.json.codemie-backup'), '{}');

    await (await collection()).teardown(async () => undefined);

    expect(readFileSync(join(claudeDir, 'settings.json'), 'utf-8')).toBe(own);
    expect(existsSync(join(claudeDir, 'settings.json.codemie-backup'))).toBe(true);
  });

  it('writes no Copilot scope record on a home that has none', async () => {
    await (await collection()).teardown(async () => undefined);

    expect(existsSync(join(home, 'copilot-connectors.json'))).toBe(false);
  });

  it('removes the Copilot CLI hook file when its scope record is gone', async () => {
    const { getCopilotCliHookFilePath, writeCopilotCliOtlpConfig } = await import('../../../proxy/connectors/copilot-cli-otlp.js');
    const { getCopilotConnectorsConfigPath } = await import('@/agents/core/copilot-connector-scope.js');
    await writeCopilotCliOtlpConfig({ keepProjectList: true });
    rmSync(getCopilotConnectorsConfigPath());

    await (await collection()).teardown(async () => undefined);

    expect(existsSync(getCopilotCliHookFilePath())).toBe(false);
  });

  it('removes the Copilot CLI hook file over a scope record that is not JSON, fails on that record, and a second run goes through', async () => {
    const { getCopilotCliHookFilePath, writeCopilotCliOtlpConfig } = await import('../../../proxy/connectors/copilot-cli-otlp.js');
    const { getCopilotConnectorsConfigPath } = await import('@/agents/core/copilot-connector-scope.js');
    await writeCopilotCliOtlpConfig({ keepProjectList: true });
    writeFileSync(getCopilotConnectorsConfigPath(), '{ not json');
    let removedInstall = false;
    const removeInstall = async (): Promise<void> => {
      removedInstall = true;
    };
    const local = await collection();

    await expect(local.teardown(removeInstall)).rejects.toThrow(
      `Copilot connector config is corrupt and was not changed: ${getCopilotConnectorsConfigPath()}`
    );
    expect(existsSync(getCopilotCliHookFilePath())).toBe(false);
    expect(removedInstall).toBe(false);

    await local.teardown(removeInstall);
    expect(removedInstall).toBe(true);
  });

  it('removes the CodeMie key of chat.hookFilesLocations when the Copilot Chat scope record is gone', async () => {
    const { getCopilotChatHookFilePath, getVsCodeChatSettingsPath, writeCopilotChatOtlpConfig } = await import(
      '../../../proxy/connectors/copilot-chat-otlp.js'
    );
    const { getCopilotConnectorsConfigPath } = await import('@/agents/core/copilot-connector-scope.js');
    await writeCopilotChatOtlpConfig({ keepProjectList: true });
    rmSync(getCopilotConnectorsConfigPath());
    rmSync(getCopilotChatHookFilePath());

    await (await collection()).teardown(async () => undefined);

    const settings = JSON.parse(readFileSync(getVsCodeChatSettingsPath(), 'utf-8')) as Record<string, unknown>;
    expect(settings['chat.hookFilesLocations']).toBeUndefined();
  });

  it('leaves a live daemon that is not the local one running', async () => {
    const backend = await writeLiveState(home, { profile: 'work', targetUrl: 'https://codemie.example.invalid', provider: 'ai-run-sso' });
    const removeInstall = vi.fn(async () => undefined);

    await (await collection()).teardown(removeInstall);

    expect(isPidAlive(backend)).toBe(true);
    expect(removeInstall).toHaveBeenCalledOnce();
  });
});
