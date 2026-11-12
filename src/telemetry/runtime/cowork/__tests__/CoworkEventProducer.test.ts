/**
 * The Cowork producer end to end: `run(now)` over a temp Claude Desktop tree (HOME), a temp ~/.codemie (CODEMIE_HOME,
 * which holds the spool, the cursors and the CodeMie profile) and the synthetic fixture session; what lands in
 * `<spool>/<cliSessionId>.hooks.ndjson`. The spool write's `appendFile` is the one stubbed boundary; the forwarder's
 * send additionally stubs `fetch` and the daemon state it reads its destination from.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';

const spoolFault = vi.hoisted(() => ({ failures: 0 }));
const readStateMock = vi.hoisted(() => vi.fn());

// Real fs; `appendFile` on a spool hooks file can be told to reject (the bytes-landing step of appendSpool).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    appendFile: (...args: Parameters<typeof actual.appendFile>): Promise<void> => {
      if (spoolFault.failures > 0 && String(args[0]).endsWith('.hooks.ndjson')) {
        spoolFault.failures -= 1;
        return Promise.reject(new Error('ENOSPC: simulated spool write failure'));
      }
      return actual.appendFile(...args);
    },
  };
});

vi.mock('@/cli/commands/proxy/daemon-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/cli/commands/proxy/daemon-manager.js')>()),
  readState: readStateMock,
}));

import { boundedText, TEXT_FIELD_LIMITS } from '@/agents/core/OtlpAgentAdapter.js';
import { logger } from '@/utils/logger.js';
import { forwardSession } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/forwarder.js';
import { discoverClaudeDesktopSessions } from '@/telemetry/clients/claude-desktop/claude-desktop.discovery.js';
import { getClaudeDesktopBaseDir, getClaudeDesktopLocalSessionsRoot } from '@/telemetry/clients/claude-desktop/claude-desktop.paths.js';
import { CoworkEventProducer, desktopAnalyticsBackfillDays } from '../CoworkEventProducer.js';
import { COWORK_ACCOUNT_SEGMENTS, coworkFixtureFile, installCoworkFixture } from './cowork-fixture.js';

type WireEvent = Record<string, unknown>;

const CLI = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const LOCAL = 'local_1a2b3c4d-1111-4222-8333-444455556666';
const AGENT = 'a11111111111111111';
const CLI_2 = '8d2e3f40-5b6c-4d7e-9f0a-1b2c3d4e5f60';
const LOCAL_2 = 'local_2b3c4d5e-1111-4222-8333-444455556666';
const ACCOUNT_DIR = join(...COWORK_ACCOUNT_SEGMENTS);
const LAST_LINE_MS = Date.parse('2026-11-10T10:00:30.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const INACTIVITY_TIMEOUT_MS = 300_000;
const ROUTE = 'bedrock/eu.anthropic.claude-opus-5';

/** The fixture session's events in spool order: the main pass, the subagent pass, then the producer's own. */
const FIRST_PROCESSING_TYPES = [
  'agent.usage.request', 'agent.usage.request', 'agent.usage.request', 'agent.session.summary',
  'agent.usage.request', 'agent.usage.request', 'agent.subagent.usage',
  'agent.session.start', 'agent.prompt.submit', 'agent.tool.start', 'agent.tool.end', 'agent.tool.start',
  'agent.tool.end', 'agent.prompt.submit', 'agent.subagent.start', 'agent.tool.start', 'agent.tool.end',
  'agent.subagent.stop',
];

let home: string;
let codemieHome: string;

function sessionDir(short = '1a2b3c4d'): string {
  return join(getClaudeDesktopLocalSessionsRoot(), ACCOUNT_DIR, short);
}

function metadataPath(local = LOCAL): string {
  return join(getClaudeDesktopLocalSessionsRoot(), ACCOUNT_DIR, `${local}.json`);
}

function projectsDir(short = '1a2b3c4d'): string {
  return join(sessionDir(short), '.claude', 'projects', 'session');
}

function mainPath(): string {
  return join(projectsDir(), `${CLI}.jsonl`);
}

function subagentPath(agentId: string, extension = '.jsonl'): string {
  return join(projectsDir(), CLI, 'subagents', `agent-${agentId}${extension}`);
}

function spoolPath(sessionId = CLI, extension = '.hooks.ndjson'): string {
  return join(codemieHome, 'proxy', 'otlp-spool', `${sessionId}${extension}`);
}

function spooled(sessionId = CLI): Array<{ agentName: string; event: WireEvent; raw: string }> {
  if (!existsSync(spoolPath(sessionId))) return [];
  return readFileSync(spoolPath(sessionId), 'utf-8').split('\n').filter((line) => line.length > 0).map((raw) => {
    const record = JSON.parse(raw) as { agentName: string; hookEvent: string };
    return { agentName: record.agentName, event: JSON.parse(record.hookEvent) as WireEvent, raw };
  });
}

function events(sessionId = CLI): WireEvent[] {
  return spooled(sessionId).map((line) => line.event);
}

function line(fields: Record<string, unknown>): string {
  return JSON.stringify({ sessionId: CLI, entrypoint: 'local-agent', version: '2.1.317', isSidechain: false, ...fields }) + '\n';
}

function assistantLine(uuid: string, timestamp: string, messageId: string, content: unknown[]): string {
  return line({
    type: 'assistant', uuid, timestamp,
    message: { id: messageId, role: 'assistant', model: 'claude-opus-5', content, stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 3 } },
  });
}

function userLine(uuid: string, timestamp: string, content: unknown, extra: Record<string, unknown> = {}): string {
  return line({ type: 'user', uuid, timestamp, message: { role: 'user', content }, ...extra });
}

function writeMetadata(local: string, fields: Record<string, unknown>): void {
  const path = metadataPath(LOCAL);
  const metadata = { ...(JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>), sessionId: local, ...fields };
  writeFileSync(metadataPath(local), JSON.stringify(metadata));
}

/** A second Cowork session beside the fixture one, with its own ids and the fixture's inner transcript. */
function addSecondSession(lastActivityAt: number): string {
  writeMetadata(LOCAL_2, { cliSessionId: CLI_2, lastActivityAt });
  const dir = projectsDir('2b3c4d5e');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(sessionDir('2b3c4d5e'), 'audit.jsonl'), '{"type":"system"}\n');
  const inner = join(dir, `${CLI_2}.jsonl`);
  writeFileSync(inner, readFileSync(mainPath(), 'utf-8').replaceAll(CLI, CLI_2));
  return inner;
}

function writeProfile(project: string): void {
  const profile = { provider: 'ai-run-sso', baseUrl: 'https://api.example.com', model: 'model', codeMieUrl: 'https://api.example.com', codeMieProject: project };
  writeFileSync(join(codemieHome, 'codemie-cli.config.json'), JSON.stringify({ version: 2, activeProfile: 'cowork', profiles: { cowork: profile } }));
}

function newProducer(discover?: (sinceMs: number) => ReturnType<typeof discoverClaudeDesktopSessions>): CoworkEventProducer {
  return new CoworkEventProducer({ profile: 'cowork', inactivityTimeoutMs: INACTIVITY_TIMEOUT_MS, ...(discover && { discover }) });
}

/** Two runs one poll apart: the first sees the current files, the second processes them. */
async function settle(producer: CoworkEventProducer, now: number): Promise<void> {
  await producer.run(now);
  await producer.run(now + 10_000);
}

function warnings(): unknown[][] {
  return vi.mocked(logger.warn).mock.calls;
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'cowork-home-')));
  codemieHome = realpathSync(mkdtempSync(join(tmpdir(), 'cowork-codemie-')));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
  vi.stubEnv('LOCALAPPDATA', join(home, 'AppData', 'Local'));
  vi.stubEnv('CODEMIE_HOME', codemieHome);
  for (const key of [
    'CODEMIE_PROJECT', 'CODEMIE_PROFILE_CONFIG', 'CODEMIE_PROFILE_NAME', 'CLAUDE_PROJECT_DIR', 'CODEMIE_LAUNCH_MODE',
    'CODEMIE_DESKTOP_ANALYTICS_BACKFILL_DAYS', 'OTLP_ALLOW_HOOKS_ONLY_FORWARD',
  ]) {
    vi.stubEnv(key, undefined);
  }
  installCoworkFixture(getClaudeDesktopBaseDir());
  writeProfile('synthetic-project');
  vi.spyOn(logger, 'warn');
});

afterEach(async () => {
  spoolFault.failures = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  await logger.close();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(codemieHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('installCoworkFixture', () => {
  it('lays the fixture session out in the Claude Desktop layout', () => {
    const root = getClaudeDesktopLocalSessionsRoot();
    const files = (readdirSync(root, { recursive: true }) as string[])
      .filter((path) => statSync(join(root, path)).isFile())
      .map((path) => path.split(sep).join('/'))
      .sort();

    expect(files).toEqual([
      '0f0f0f0f-aaaa-4bbb-8ccc-000000000001/00000000-0000-4000-8000-000000000001/1a2b3c4d/.claude/projects/session/7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f.jsonl',
      '0f0f0f0f-aaaa-4bbb-8ccc-000000000001/00000000-0000-4000-8000-000000000001/1a2b3c4d/.claude/projects/session/7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f/subagents/agent-a11111111111111111.jsonl',
      '0f0f0f0f-aaaa-4bbb-8ccc-000000000001/00000000-0000-4000-8000-000000000001/1a2b3c4d/.claude/projects/session/7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f/subagents/agent-a11111111111111111.meta.json',
      '0f0f0f0f-aaaa-4bbb-8ccc-000000000001/00000000-0000-4000-8000-000000000001/1a2b3c4d/audit.jsonl',
      '0f0f0f0f-aaaa-4bbb-8ccc-000000000001/00000000-0000-4000-8000-000000000001/local_1a2b3c4d-1111-4222-8333-444455556666.json',
    ]);
  });
});

describe('CoworkEventProducer.run', () => {
  it('writes the session on the run after the one that first saw it', async () => {
    const producer = newProducer();

    await producer.run(LAST_LINE_MS + 20_000);
    expect(existsSync(spoolPath())).toBe(false);
    await producer.run(LAST_LINE_MS + 30_000);

    const lines = spooled();
    expect(lines.map((spoolLine) => spoolLine.event['type'])).toEqual(FIRST_PROCESSING_TYPES);
    expect(new Set(lines.map((spoolLine) => spoolLine.agentName))).toEqual(new Set(['claude-code-otlp']));
    for (const { event } of lines) {
      expect(event).toMatchObject({
        platform: 'claude-code', entrypoint: 'local-agent', session_id: CLI, codemie_project_name: 'synthetic-project', schema_version: 2,
      });
      expect(event['event_id']).toEqual(expect.any(String));
      expect(event['event_id']).not.toBe('');
      expect(event).not.toHaveProperty('user_email');
    }
    const usage = lines.map((spoolLine) => spoolLine.event).filter((event) => event['type'] === 'agent.usage.request');
    expect(usage.filter((event) => event['model'] === ROUTE).map((event) => [event['message_id'], event['model_raw']]))
      .toEqual([['msg_synthetic_A', 'claude-opus-5']]);
    expect(usage.filter((event) => event['agent_id'] === AGENT)).toHaveLength(2);
    expect(lines.find((spoolLine) => spoolLine.event['type'] === 'agent.session.start')?.event)
      .toMatchObject({ session_title: 'Synthetic notes task', timestamp: '2026-11-10T10:00:00.000Z', cwd: 'Cowork' });
    expect((JSON.parse(readFileSync(spoolPath(CLI, '.status'), 'utf-8')) as { project?: string }).project).toBe('synthetic-project');
  });

  it('ends an idle session with one agent.session.end and a final summary', async () => {
    const producer = newProducer();
    await settle(producer, LAST_LINE_MS + 20_000);
    const before = spooled().length;

    await producer.run(LAST_LINE_MS + INACTIVITY_TIMEOUT_MS + 40_000);
    await producer.run(LAST_LINE_MS + INACTIVITY_TIMEOUT_MS + 50_000);

    const appended = events().slice(before);
    expect(appended.map((event) => event['type'])).toEqual(['agent.session.summary', 'agent.session.end']);
    expect(appended[0]).toMatchObject({ is_final: true });
    expect(appended[1]).toMatchObject({ timestamp: '2026-11-10T10:00:30.000Z', event_id: `agent.session.end:${CLI}:2026-11-10T10:00:30.000Z` });
  });

  it('appends only the new events of a session that grows after its end, and ends it again with another id', async () => {
    const producer = newProducer();
    await settle(producer, LAST_LINE_MS + 20_000);
    await producer.run(LAST_LINE_MS + INACTIVITY_TIMEOUT_MS + 40_000);
    const before = spooled().length;

    appendFileSync(mainPath(), userLine('00000000-0000-4000-8000-0000000000d1', '2026-11-10T10:20:00.000Z', 'One more synthetic question'));
    appendFileSync(mainPath(), assistantLine('00000000-0000-4000-8000-0000000000d2', '2026-11-10T10:20:05.000Z', 'msg_synthetic_D', [{ type: 'text', text: 'Answered.' }]));
    const resumedAt = Date.parse('2026-11-10T10:20:05.000Z');
    await settle(producer, resumedAt + 60_000);
    const grown = events().slice(before);
    await producer.run(resumedAt + INACTIVITY_TIMEOUT_MS + 10_000);
    const ended = events().slice(before + grown.length);

    expect(grown.map((event) => event['type'])).toEqual(['agent.usage.request', 'agent.session.summary', 'agent.prompt.submit']);
    expect(grown[0]).toMatchObject({ message_id: 'msg_synthetic_D' });
    expect(grown[2]).toMatchObject({ event_id: `agent.prompt.submit:${CLI}:00000000-0000-4000-8000-0000000000d1` });
    expect(ended.map((event) => event['event_id'])).toEqual([
      `agent.session.summary:${CLI}:summary:final:2026-11-10T10:20:05.000Z`,
      `agent.session.end:${CLI}:2026-11-10T10:20:05.000Z`,
    ]);
  });

  it('keeps: writes nothing for a Code-tab session or a Cowork session without an inner transcript', async () => {
    rmSync(join(getClaudeDesktopLocalSessionsRoot(), ACCOUNT_DIR), { recursive: true });
    const codeRoot = join(getClaudeDesktopBaseDir(), 'claude-code-sessions', ACCOUNT_DIR);
    mkdirSync(codeRoot, { recursive: true });
    writeFileSync(join(codeRoot, `${LOCAL}.json`), JSON.stringify({ sessionId: LOCAL, cliSessionId: CLI, createdAt: LAST_LINE_MS - 30_000, lastActivityAt: LAST_LINE_MS, cwd: join(home, 'repo') }));
    const codeTranscript = join(home, '.claude', 'projects', 'synthetic-repo', `${CLI}.jsonl`);
    mkdirSync(dirname(codeTranscript), { recursive: true });
    cpSync(coworkFixtureFile('main.jsonl'), codeTranscript);
    mkdirSync(join(getClaudeDesktopLocalSessionsRoot(), ACCOUNT_DIR, '2b3c4d5e'), { recursive: true });
    writeFileSync(join(getClaudeDesktopLocalSessionsRoot(), ACCOUNT_DIR, '2b3c4d5e', 'audit.jsonl'), '{"type":"system"}\n');
    writeFileSync(metadataPath(LOCAL_2), JSON.stringify({ sessionId: LOCAL_2, cliSessionId: CLI_2, createdAt: LAST_LINE_MS - 30_000, lastActivityAt: LAST_LINE_MS }));
    const discovered = await discoverClaudeDesktopSessions(LAST_LINE_MS - DAY_MS);

    await settle(newProducer(), LAST_LINE_MS + 20_000);

    expect(discovered.map((session) => session.agentSessionId).sort()).toEqual([CLI, CLI_2].sort());
    expect(existsSync(join(codemieHome, 'proxy', 'otlp-spool'))).toBe(false);
  });

  it('appends the same event_ids again after the cursor file was deleted', async () => {
    const producer = newProducer();
    await settle(producer, LAST_LINE_MS + 20_000);
    const first = events();

    rmSync(join(codemieHome, 'analytics', 'state', `${CLI}.cowork.json`));
    await producer.run(LAST_LINE_MS + 40_000);

    const again = events().slice(first.length);
    const firstIds = first.map((event) => event['event_id']);
    expect(again.length).toBeGreaterThan(0);
    expect(again.filter((event) => !firstIds.includes(event['event_id']))).toEqual([]);
    const ownTypes = new Set(['agent.session.start', 'agent.prompt.submit', 'agent.tool.start', 'agent.tool.end', 'agent.subagent.start', 'agent.subagent.stop']);
    const own = (list: WireEvent[]) => list.filter((event) => ownTypes.has(String(event['type']))).map((event) => event['event_id']);
    expect(own(again)).toEqual(own(first));
  });

  it('saves no cursor when the spool write fails, and appends the full set once on the next run', async () => {
    spoolFault.failures = 1;
    const producer = newProducer();

    await settle(producer, LAST_LINE_MS + 20_000);

    expect(existsSync(spoolPath())).toBe(false);
    expect(existsSync(join(codemieHome, 'analytics', 'state', `${CLI}.cowork.json`))).toBe(false);
    expect(existsSync(join(codemieHome, 'analytics', 'state', `${CLI}.json`))).toBe(false);
    expect(warnings().filter(([, meta]) => (meta as { cliSessionId?: string })?.cliSessionId === CLI)).toHaveLength(1);

    await producer.run(LAST_LINE_MS + 40_000);

    const written = events();
    expect(written.map((event) => event['type'])).toEqual(FIRST_PROCESSING_TYPES);
    expect(new Set(written.map((event) => event['event_id'])).size).toBe(written.length);
  });

  it('writes nothing again after a daemon restart over the same CODEMIE_HOME', async () => {
    await settle(newProducer(), LAST_LINE_MS + 20_000);
    const written = readFileSync(spoolPath(), 'utf-8');

    await settle(newProducer(), LAST_LINE_MS + 60_000);

    expect(readFileSync(spoolPath(), 'utf-8')).toBe(written);
  });

  it('does not read a last line until its newline is written', async () => {
    const producer = newProducer();
    await settle(producer, LAST_LINE_MS + 20_000);
    const partial = userLine('00000000-0000-4000-8000-0000000000e1', '2026-11-10T10:00:40.000Z', 'A synthetic follow-up');

    appendFileSync(mainPath(), partial.slice(0, -1));
    await settle(producer, LAST_LINE_MS + 40_000);
    const promptIds = () => events().filter((event) => event['type'] === 'agent.prompt.submit').map((event) => event['event_id']);
    const beforeNewline = promptIds();
    appendFileSync(mainPath(), '\n');
    await settle(producer, LAST_LINE_MS + 60_000);

    expect(beforeNewline).not.toContain(`agent.prompt.submit:${CLI}:00000000-0000-4000-8000-0000000000e1`);
    expect(promptIds()).toContain(`agent.prompt.submit:${CLI}:00000000-0000-4000-8000-0000000000e1`);
  });

  it('appends without a project name or a project binding when no project is resolved, and logs nothing about it', async () => {
    rmSync(join(codemieHome, 'codemie-cli.config.json'));

    await settle(newProducer(), LAST_LINE_MS + 20_000);

    const written = events();
    expect(written).toHaveLength(FIRST_PROCESSING_TYPES.length);
    expect(written.filter((event) => 'codemie_project_name' in event)).toEqual([]);
    expect((JSON.parse(readFileSync(spoolPath(CLI, '.status'), 'utf-8')) as { project?: string }).project).toBeUndefined();
    expect(warnings()).toEqual([]);
  });

  it('appends nothing and saves no cursor while the local config cannot be loaded, and appends the full set once after it is fixed', async () => {
    const [session] = await discoverClaudeDesktopSessions(LAST_LINE_MS - DAY_MS);
    const localConfig = join(session.workingDirectory, '.codemie', 'codemie-cli.config.json');
    mkdirSync(dirname(localConfig), { recursive: true });
    writeFileSync(localConfig, JSON.stringify({ synthetic: true }));
    const producer = newProducer();

    await settle(producer, LAST_LINE_MS + 20_000);

    expect(existsSync(spoolPath())).toBe(false);
    expect(existsSync(join(codemieHome, 'analytics', 'state', `${CLI}.cowork.json`))).toBe(false);
    expect(warnings().filter(([, meta]) => (meta as { cliSessionId?: string })?.cliSessionId === CLI).map(([, meta]) => (meta as { error: string }).error))
      .toEqual([`context: Unrecognized config format at ${localConfig}. Expected multi-provider (version 2) format.`]);

    rmSync(localConfig);
    await producer.run(LAST_LINE_MS + 40_000);

    const written = events();
    expect(written.map((event) => event['type'])).toEqual(FIRST_PROCESSING_TYPES);
    expect(new Set(written.map((event) => event['event_id'])).size).toBe(written.length);
  });

  it.each([
    ['a corrupt preferences file', () => '{not json', true],
    ['enabled: false', () => JSON.stringify({ enabled: false }), false],
    ['the working directory under excludedProjects', () => JSON.stringify({ excludedProjects: [home] }), false],
  ])('produces nothing with %s', async (_case, preferences, warnsCorrupt) => {
    const preferencesPath = join(codemieHome, 'claude-analytics.json');
    writeFileSync(preferencesPath, preferences());

    await settle(newProducer(), LAST_LINE_MS + 20_000);

    expect(existsSync(spoolPath())).toBe(false);
    expect(warnings().map(([message]) => message)).toEqual(warnsCorrupt
      ? [`[cowork-producer] Cowork sessions are not sent while the preferences file is corrupt: ${preferencesPath}`]
      : []);
  });

  it('warns again when the preferences file is corrupt again after a valid read', async () => {
    const preferencesPath = join(codemieHome, 'claude-analytics.json');
    const producer = newProducer();

    writeFileSync(preferencesPath, '{not json');
    await producer.run(LAST_LINE_MS + 20_000);
    writeFileSync(preferencesPath, JSON.stringify({ enabled: false }));
    await producer.run(LAST_LINE_MS + 40_000);
    writeFileSync(preferencesPath, '{not json');
    await producer.run(LAST_LINE_MS + 60_000);

    const corruptMessage = `[cowork-producer] Cowork sessions are not sent while the preferences file is corrupt: ${preferencesPath}`;
    expect(warnings().map(([message]) => message)).toEqual([corruptMessage, corruptMessage]);
  });

  it('cuts a subagent description longer than the limit in agent.subagent.usage', async () => {
    const description = 'Check the synthetic notes and list every open question. '.repeat(10);
    writeFileSync(subagentPath(AGENT, '.meta.json'), JSON.stringify({
      agentType: 'general-purpose', toolUseId: 'toolu_synthetic_agent', description, spawnDepth: 1,
    }));

    await settle(newProducer(), LAST_LINE_MS + 20_000);

    const usage = events().filter((event) => event['type'] === 'agent.subagent.usage');
    expect(usage.map((event) => event['description'])).toEqual([boundedText(description, TEXT_FIELD_LIMITS['description'])]);
  });

  it('skips a session whose metadata sessionId leads its transcript outside the sessions root', async () => {
    const outsideDir = join(getClaudeDesktopBaseDir(), 'outside');
    const outsideProjects = join(outsideDir, '.claude', 'projects', 'session');
    mkdirSync(outsideProjects, { recursive: true });
    writeFileSync(join(outsideDir, 'audit.jsonl'), '{"type":"system"}\n');
    writeFileSync(join(outsideProjects, `${CLI_2}.jsonl`), readFileSync(mainPath(), 'utf-8').replaceAll(CLI, CLI_2));
    const metadata = JSON.parse(readFileSync(metadataPath(), 'utf-8')) as Record<string, unknown>;
    writeFileSync(join(dirname(metadataPath()), 'local_escape.json'), JSON.stringify({
      ...metadata, sessionId: 'local_../../../outside', cliSessionId: CLI_2,
    }));

    await settle(newProducer(), LAST_LINE_MS + 20_000);

    expect(existsSync(spoolPath(CLI_2))).toBe(false);
    expect(events().map((event) => event['type'])).toEqual(FIRST_PROCESSING_TYPES);
  });

  it('emits the usage of a subagent without agentType, and no subagent start or stop', async () => {
    writeFileSync(subagentPath(AGENT, '.meta.json'), JSON.stringify({ toolUseId: 'toolu_synthetic_agent' }));

    await settle(newProducer(), LAST_LINE_MS + 20_000);

    const written = events();
    expect(written.filter((event) => event['type'] === 'agent.usage.request' && event['agent_id'] === AGENT)).toHaveLength(2);
    expect(written.filter((event) => String(event['type']).startsWith('agent.subagent.') && event['type'] !== 'agent.subagent.usage')).toEqual([]);
  });

  it('still writes the second session when the first fails, with one warning naming the first', async () => {
    const inner = addSecondSession(LAST_LINE_MS - 60_000);
    rmSync(inner);
    mkdirSync(inner);

    await settle(newProducer(), LAST_LINE_MS + 20_000);

    expect(events().length).toBe(FIRST_PROCESSING_TYPES.length);
    expect(warnings().map(([, meta]) => (meta as { cliSessionId?: string })?.cliSessionId)).toEqual([CLI_2]);
  });

  it('builds no producer event older than the window from a session read without a cursor', async () => {
    const old = userLine('00000000-0000-4000-8000-0000000000f1', '2026-10-21T10:00:00.000Z', 'An old synthetic question')
      + assistantLine('00000000-0000-4000-8000-0000000000f2', '2026-10-21T10:00:05.000Z', 'msg_synthetic_OLD', [{ type: 'text', text: 'Old answer.' }]);
    writeFileSync(mainPath(), old + readFileSync(mainPath(), 'utf-8'));
    const now = LAST_LINE_MS + 20_000;

    await settle(newProducer(), now);

    const written = events();
    const windowStart = now - 7 * DAY_MS;
    const own = written.filter((event) => !['agent.usage.request', 'agent.session.summary', 'agent.subagent.usage'].includes(String(event['type'])));
    expect(own.filter((event) => Date.parse(String(event['timestamp'])) < windowStart)).toEqual([]);
    expect(own.find((event) => event['type'] === 'agent.session.start')).toMatchObject({ timestamp: '2026-11-10T10:00:00.000Z' });
    expect(written.filter((event) => event['type'] === 'agent.usage.request').map((event) => event['message_id']))
      .toContain('msg_synthetic_OLD');
  });

  it('opens the main pass and two subagent passes one after another, with no lock wait', async () => {
    const second = 'a22222222222222222';
    writeFileSync(subagentPath(second), readFileSync(subagentPath(AGENT), 'utf-8').replaceAll(AGENT, second)
      .replaceAll('msg_synthetic_S', 'msg_synthetic_T').replaceAll('-0000000000b', '-0000000000c').replaceAll('toolu_synthetic_read', 'toolu_synthetic_read2'));
    writeFileSync(subagentPath(second, '.meta.json'), JSON.stringify({ agentType: 'Explore' }));
    // Date frozen: a lock wait (budget measured with Date.now) would never end and the test would time out.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(LAST_LINE_MS + 20_000);

    await settle(newProducer(), LAST_LINE_MS + 20_000);

    const passTypes = new Set(['agent.usage.request', 'agent.session.summary', 'agent.subagent.usage']);
    const passes = events().filter((event) => passTypes.has(String(event['type'])))
      .map((event) => `${String(event['type'])}:${String(event['agent_id'] ?? '')}`);
    expect(passes).toEqual([
      'agent.usage.request:', 'agent.usage.request:', 'agent.usage.request:', 'agent.session.summary:',
      `agent.usage.request:${AGENT}`, `agent.usage.request:${AGENT}`, `agent.subagent.usage:${AGENT}`,
      `agent.usage.request:${second}`, `agent.usage.request:${second}`, `agent.subagent.usage:${second}`,
    ]);
  });

  it('marks the end of a Skill call that forked, and names the skill on the fork\'s start when the marker is present', async () => {
    const fork = 'afork0000000000001';
    appendFileSync(mainPath(), assistantLine('00000000-0000-4000-8000-0000000000g1', '2026-11-10T10:00:32.000Z', 'msg_synthetic_G',
      [{ type: 'tool_use', id: 'toolu_synthetic_skill', name: 'Skill', input: { skill: 'synthetic-review' } }]));
    appendFileSync(mainPath(), userLine('00000000-0000-4000-8000-0000000000g2', '2026-11-10T10:00:40.000Z',
      [{ type: 'tool_result', tool_use_id: 'toolu_synthetic_skill', content: 'Skill synthetic-review forked' }],
      { toolUseResult: { success: true, commandName: 'synthetic-review', status: 'forked', agentId: fork } }));
    writeFileSync(subagentPath(fork), assistantLine('00000000-0000-4000-8000-0000000000g3', '2026-11-10T10:00:35.000Z', 'msg_synthetic_F', [{ type: 'text', text: 'Reviewed.' }]));
    writeFileSync(subagentPath(fork, '.meta.json'), JSON.stringify({ agentType: 'general-purpose', toolUseId: 'toolu_synthetic_skill' }));
    writeFileSync(subagentPath(fork, '.forked-skill.marker.json'), JSON.stringify({ forkedSkill: true, skillName: 'synthetic-review' }));

    await settle(newProducer(), LAST_LINE_MS + 30_000);

    const written = events();
    expect(written.find((event) => event['event_id'] === `agent.tool.end:${CLI}:toolu_synthetic_skill`))
      .toMatchObject({ fork_agent_id: fork, tool_response: `{"agentId":"${fork}"}` });
    expect(written.find((event) => event['event_id'] === `agent.subagent.start:${CLI}:${fork}`))
      .toMatchObject({ skill_name: 'synthetic-review', agent_type: 'general-purpose' });
  });

  it('stops a background agent only at the session\'s end, after the tool events of its late lines, at its last line', async () => {
    const background = 'abg00000000000001';
    appendFileSync(mainPath(), assistantLine('00000000-0000-4000-8000-0000000000h1', '2026-11-10T10:00:32.000Z', 'msg_synthetic_H',
      [{ type: 'tool_use', id: 'toolu_synthetic_bg', name: 'Agent', input: { subagent_type: 'general-purpose', run_in_background: true } }]));
    appendFileSync(mainPath(), userLine('00000000-0000-4000-8000-0000000000h2', '2026-11-10T10:00:33.000Z',
      [{ type: 'tool_result', tool_use_id: 'toolu_synthetic_bg', content: 'Async agent launched' }],
      { toolUseResult: { status: 'async_launched', agentId: background } }));
    writeFileSync(subagentPath(background, '.meta.json'), JSON.stringify({ agentType: 'general-purpose', toolUseId: 'toolu_synthetic_bg' }));
    writeFileSync(subagentPath(background), assistantLine('00000000-0000-4000-8000-0000000000h3', '2026-11-10T10:00:34.000Z', 'msg_synthetic_BG1', []));
    const producer = newProducer();
    const stopId = `agent.subagent.stop:${CLI}:${background}`;
    const stops = () => events().filter((event) => event['event_id'] === stopId);

    await settle(producer, LAST_LINE_MS + 20_000);
    const afterQuietRuns = stops();
    appendFileSync(subagentPath(background), assistantLine('00000000-0000-4000-8000-0000000000h4', '2026-11-10T10:00:44.000Z', 'msg_synthetic_BG2',
      [{ type: 'tool_use', id: 'toolu_synthetic_bg_read', name: 'Read', input: { file_path: '/synthetic/notes.md' } }]));
    appendFileSync(subagentPath(background), userLine('00000000-0000-4000-8000-0000000000h5', '2026-11-10T10:00:45.000Z',
      [{ type: 'tool_result', tool_use_id: 'toolu_synthetic_bg_read', content: 'notes' }]));
    await settle(producer, LAST_LINE_MS + 40_000);
    const afterGrowth = stops();
    await producer.run(LAST_LINE_MS + INACTIVITY_TIMEOUT_MS + 60_000);

    expect(afterQuietRuns).toEqual([]);
    expect(afterGrowth).toEqual([]);
    expect(stops().map((event) => event['timestamp'])).toEqual(['2026-11-10T10:00:45.000Z']);
    const ids = events().map((event) => event['event_id']);
    const stopAt = ids.indexOf(stopId);
    expect(ids.indexOf(`agent.tool.start:${CLI}:toolu_synthetic_bg_read`)).toBeGreaterThan(-1);
    expect(ids.indexOf(`agent.tool.start:${CLI}:toolu_synthetic_bg_read`)).toBeLessThan(stopAt);
    expect(ids.indexOf(`agent.tool.end:${CLI}:toolu_synthetic_bg_read`)).toBeGreaterThan(-1);
    expect(ids.indexOf(`agent.tool.end:${CLI}:toolu_synthetic_bg_read`)).toBeLessThan(stopAt);
  });

  it('keeps a session open while a subagent writes after the main transcript went quiet, and ends it at that line', async () => {
    const long = 'along000000000001';
    appendFileSync(mainPath(), assistantLine('00000000-0000-4000-8000-0000000000l1', '2026-11-10T10:00:32.000Z', 'msg_synthetic_L',
      [{ type: 'tool_use', id: 'toolu_synthetic_long', name: 'Agent', input: { subagent_type: 'general-purpose' } }]));
    writeFileSync(subagentPath(long, '.meta.json'), JSON.stringify({ agentType: 'general-purpose', toolUseId: 'toolu_synthetic_long' }));
    writeFileSync(subagentPath(long), assistantLine('00000000-0000-4000-8000-0000000000l2', '2026-11-10T10:04:00.000Z', 'msg_synthetic_L2', []));
    const producer = newProducer();
    const closing = () => events().filter((event) =>
      event['type'] === 'agent.session.end' || event['event_id'] === `agent.subagent.stop:${CLI}:${long}`);

    await settle(producer, Date.parse('2026-11-10T10:04:10.000Z'));
    await producer.run(Date.parse('2026-11-10T10:06:00.000Z'));
    const whileSubagentWorks = closing();
    await producer.run(Date.parse('2026-11-10T10:09:10.000Z'));

    expect(whileSubagentWorks).toEqual([]);
    expect(closing().map((event) => [event['type'], event['timestamp'], event['event_id']])).toEqual([
      ['agent.subagent.stop', '2026-11-10T10:04:00.000Z', `agent.subagent.stop:${CLI}:${long}`],
      ['agent.session.end', '2026-11-10T10:04:00.000Z', `agent.session.end:${CLI}:2026-11-10T10:04:00.000Z`],
    ]);
  });

  it('masks a secret-shaped token of a prompt in the spool line', async () => {
    const secret = `ghp_${'Zx9'.repeat(10)}`;
    const lines = readFileSync(mainPath(), 'utf-8').split('\n');
    lines[0] = lines[0].replace('Draft a three-line notes file for the synthetic project', `Use ${secret} for the synthetic notes`);
    writeFileSync(mainPath(), lines.join('\n'));

    await settle(newProducer(), LAST_LINE_MS + 20_000);

    const prompt = spooled().find((spoolLine) => spoolLine.event['event_id'] === `agent.prompt.submit:${CLI}:00000000-0000-4000-8000-0000000000a1`);
    expect(prompt?.event['prompt_body']).toBe('Use [REDACTED] for the synthetic notes');
    expect(readFileSync(spoolPath(), 'utf-8')).not.toContain(secret);
  });

  it('skips a session whose metadata carries otelConfig, with one warning', async () => {
    writeMetadata(LOCAL, { otelConfig: { endpoint: 'http://127.0.0.1:9' } });
    const producer = newProducer();

    await settle(producer, LAST_LINE_MS + 20_000);
    await settle(producer, LAST_LINE_MS + INACTIVITY_TIMEOUT_MS + 40_000);

    expect(existsSync(spoolPath())).toBe(false);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0][1]).toEqual({ cliSessionId: CLI });
  });

  it('warns again about an otelConfig session that left the list and was listed again', async () => {
    writeMetadata(LOCAL, { otelConfig: { endpoint: 'http://127.0.0.1:9' } });
    let listedNow = true;
    const producer = newProducer(async (sinceMs) => (listedNow ? discoverClaudeDesktopSessions(sinceMs) : []));
    const start = LAST_LINE_MS + 20_000;

    await producer.run(start);
    await producer.run(start + INACTIVITY_TIMEOUT_MS);
    const whileListed = warnings().length;
    listedNow = false;
    await producer.run(start + 2 * INACTIVITY_TIMEOUT_MS);
    listedNow = true;
    await producer.run(start + 3 * INACTIVITY_TIMEOUT_MS);

    expect(whileListed).toBe(1);
    expect(warnings()).toHaveLength(2);
    expect(warnings().map(([, meta]) => meta)).toEqual([{ cliSessionId: CLI }, { cliSessionId: CLI }]);
  });

  it('produces nothing while OTLP_ALLOW_HOOKS_ONLY_FORWARD is false, with one warning for the process', async () => {
    vi.stubEnv('OTLP_ALLOW_HOOKS_ONLY_FORWARD', 'false');
    const producer = newProducer();

    await settle(producer, LAST_LINE_MS + 20_000);

    expect(existsSync(spoolPath())).toBe(false);
    expect(warnings()).toEqual([['[cowork-producer] Cowork sessions are not sent while OTLP_ALLOW_HOOKS_ONLY_FORWARD is false']]);
  });

  it('reads a session that appeared between two list refreshes only after the next refresh', async () => {
    const listings: number[] = [];
    const producer = newProducer(async (sinceMs) => {
      listings.push(sinceMs);
      return discoverClaudeDesktopSessions(sinceMs);
    });
    const start = LAST_LINE_MS + 20_000;
    await settle(producer, start);
    addSecondSession(LAST_LINE_MS);

    for (let at = start + 20_000; at < start + INACTIVITY_TIMEOUT_MS; at += 10_000) await producer.run(at);
    const beforeRefresh = existsSync(spoolPath(CLI_2));
    await settle(producer, start + INACTIVITY_TIMEOUT_MS);

    expect(beforeRefresh).toBe(false);
    expect(events(CLI_2).filter((event) => event['type'] === 'agent.session.start')).toHaveLength(1);
    expect(listings).toEqual([start - 7 * DAY_MS, start + INACTIVITY_TIMEOUT_MS - 7 * DAY_MS]);
  });

  it('skips a session last active 8 days ago and reads one of 6 days ago from its first line', async () => {
    await settle(newProducer(), LAST_LINE_MS + 8 * DAY_MS);
    const eightDays = existsSync(spoolPath());

    await settle(newProducer(), LAST_LINE_MS + 6 * DAY_MS);

    expect(eightDays).toBe(false);
    expect(events().find((event) => event['type'] === 'agent.session.start')).toMatchObject({ timestamp: '2026-11-10T10:00:00.000Z' });
  });

  it('reads a session 13 days back with CODEMIE_DESKTOP_ANALYTICS_BACKFILL_DAYS=30', async () => {
    vi.stubEnv('CODEMIE_DESKTOP_ANALYTICS_BACKFILL_DAYS', '30');

    await settle(newProducer(), LAST_LINE_MS + 13 * DAY_MS);

    expect(events().filter((event) => event['type'] === 'agent.session.start')).toHaveLength(1);
  });

  it.each([
    ['empty', ''],
    ['holding only an api-request-blob line', '{"type":"api-request-blob","message":{"role":"user","content":"synthetic copy"}}\n'],
  ])('writes no spool file for an inner transcript %s', async (_case, content) => {
    writeFileSync(mainPath(), content);
    rmSync(join(projectsDir(), CLI), { recursive: true });

    await settle(newProducer(), LAST_LINE_MS + 20_000);

    expect(existsSync(spoolPath())).toBe(false);
  });

  it('builds no producer event for a session whose every line is older than the window, and records its end once', async () => {
    const now = LAST_LINE_MS + 10 * DAY_MS;
    writeMetadata(LOCAL, { lastActivityAt: now - DAY_MS });
    const producer = newProducer();

    await settle(producer, now);
    const written = readFileSync(spoolPath(), 'utf-8');
    await producer.run(now + 20_000);
    await producer.run(now + 30_000);

    const types = events().map((event) => String(event['type']));
    expect(types.filter((type) => type === 'agent.usage.request')).toHaveLength(5);
    const ownTypes = ['agent.session.start', 'agent.session.end', 'agent.prompt.submit', 'agent.subagent.start', 'agent.subagent.stop'];
    expect(types.filter((type) => ownTypes.includes(type) || type.startsWith('agent.tool.'))).toEqual([]);
    expect(readFileSync(spoolPath(), 'utf-8')).toBe(written);
  });

  it('reads a session again from its start when its cursor parses to another shape, and saves a valid one', async () => {
    await settle(newProducer(), LAST_LINE_MS + 20_000);
    const first = events();
    const cursorFile = join(codemieHome, 'analytics', 'state', `${CLI}.cowork.json`);
    writeFileSync(cursorFile, '{"offsets":null}');

    await settle(newProducer(), LAST_LINE_MS + 40_000);

    expect(warnings().filter(([, meta]) => (meta as { cliSessionId?: string })?.cliSessionId === CLI)).toHaveLength(1);
    const again = events().slice(first.length);
    const firstIds = first.map((event) => event['event_id']);
    expect(again.filter((event) => !firstIds.includes(event['event_id']))).toEqual([]);
    const ownTypes = new Set(['agent.session.start', 'agent.prompt.submit', 'agent.tool.start', 'agent.tool.end', 'agent.subagent.start', 'agent.subagent.stop']);
    const own = (list: WireEvent[]) => list.filter((event) => ownTypes.has(String(event['type']))).map((event) => event['event_id']);
    expect(own(again)).toEqual(own(first));
    expect(JSON.parse(readFileSync(cursorFile, 'utf-8'))).toMatchObject({ offsets: { [`${CLI}.jsonl`]: expect.any(Number) } });
  });

  it('names the skill on the start of a marked fork only, beside an ordinary agent', async () => {
    const fork = 'afork0000000000002';
    writeFileSync(subagentPath(fork), assistantLine('00000000-0000-4000-8000-0000000000k1', '2026-11-10T10:00:20.000Z', 'msg_synthetic_K', [{ type: 'text', text: 'Reviewed.' }]));
    writeFileSync(subagentPath(fork, '.meta.json'), JSON.stringify({ agentType: 'general-purpose' }));
    writeFileSync(subagentPath(fork, '.forked-skill.marker.json'), JSON.stringify({ forkedSkill: true, skillName: 'synthetic-review' }));

    await settle(newProducer(), LAST_LINE_MS + 20_000);

    expect(events().filter((event) => event['type'] === 'agent.subagent.start').map((event) => [event['agent_id'], event['skill_name'] ?? null]))
      .toEqual([[AGENT, null], [fork, 'synthetic-review']]);
  });

  it('reads no cursor of a session already processed and ended while its files stay unchanged', async () => {
    const producer = newProducer();
    await settle(producer, LAST_LINE_MS + 20_000);
    await producer.run(LAST_LINE_MS + INACTIVITY_TIMEOUT_MS + 40_000);
    const written = readFileSync(spoolPath(), 'utf-8');
    writeFileSync(join(codemieHome, 'analytics', 'state', `${CLI}.cowork.json`), 'not a cursor');
    vi.mocked(logger.warn).mockClear();

    await producer.run(LAST_LINE_MS + INACTIVITY_TIMEOUT_MS + 50_000);
    await producer.run(LAST_LINE_MS + INACTIVITY_TIMEOUT_MS + 60_000);

    expect(events().filter((event) => event['type'] === 'agent.session.end')).toHaveLength(1);
    expect(warnings()).toEqual([]);
    expect(readFileSync(spoolPath(), 'utf-8')).toBe(written);
  });
});

describe('CoworkEventProducer and the forwarder\'s send', () => {
  const credentials = { cookies: { codemie_access_token: 'tok' }, apiUrl: 'https://api', timestamp: 0 };
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
    readStateMock.mockResolvedValue({ url: 'http://127.0.0.1:1', targetUrl: 'https://api.example.com' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The events of every request sent from the `from`-th on, with each request's URL and project header. */
  function sent(from = 0): Array<{ url: string; project: unknown; event: WireEvent }> {
    return fetchMock.mock.calls.slice(from).flatMap(([url, init]) => {
      const request = init as { headers: Record<string, string>; body: string };
      return request.body.split('\n').filter((body) => body.length > 0)
        .map((body) => ({ url: String(url), project: request.headers['X-CodeMie-Project'], event: JSON.parse(body) as WireEvent }));
    });
  }

  async function forward(): Promise<void> {
    await forwardSession(CLI, true, credentials as never);
  }

  it('sends the producer\'s events to event-hooks under the session\'s project', async () => {
    await settle(newProducer(), LAST_LINE_MS + 20_000);
    await forward();

    const requests = sent();
    expect(requests.length).toBeGreaterThan(0);
    for (const { url, project, event } of requests) {
      expect(url).toBe('https://api.example.com/v1/analytics/cli-analytics/event-hooks');
      expect(project).toBe('synthetic-project');
      expect(event).toMatchObject({ session_id: CLI, codemie_project_name: 'synthetic-project' });
    }
    const ids = requests.map(({ event }) => event['event_id']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(events().map((event) => event['event_id']));
  });

  it('sends nothing on a second producer run and forward with the cursor kept', async () => {
    await settle(newProducer(), LAST_LINE_MS + 20_000);
    await forward();
    const before = fetchMock.mock.calls.length;

    await settle(newProducer(), LAST_LINE_MS + 60_000);
    await forward();

    expect(sent(before)).toEqual([]);
  });

  it('sends the same event_id set again after the cursor files were deleted', async () => {
    await settle(newProducer(), LAST_LINE_MS + 20_000);
    await forward();
    const before = fetchMock.mock.calls.length;
    const firstIds = new Set(sent().map(({ event }) => event['event_id']));

    // The producer's cursor and the orchestrator's: with only the first gone the usage events stay deduplicated.
    rmSync(join(codemieHome, 'analytics', 'state', `${CLI}.cowork.json`));
    rmSync(join(codemieHome, 'analytics', 'state', `${CLI}.json`));
    await settle(newProducer(), LAST_LINE_MS + 40_000);
    await forward();

    const resent = sent(before).map(({ event }) => event['event_id']);
    expect(new Set(resent)).toEqual(firstIds);
    expect(resent).toHaveLength(firstIds.size);
  });
});

describe('desktopAnalyticsBackfillDays', () => {
  it.each([
    [undefined, 7], ['abc', 7], ['0', 7], ['-3', 7], ['10', 10], ['30', 14],
  ])('reads %s as %d days', (value, days) => {
    vi.stubEnv('CODEMIE_DESKTOP_ANALYTICS_BACKFILL_DAYS', value);

    expect(desktopAnalyticsBackfillDays()).toBe(days);
  });
});
