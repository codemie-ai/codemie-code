/**
 * The Cowork producer end to end: `run(now)` over a temp Claude Desktop tree (HOME), a temp ~/.codemie (CODEMIE_HOME,
 * which holds the spool, the cursors and the CodeMie profile) and the synthetic fixture session; what lands in
 * `<spool>/<cliSessionId>.hooks.ndjson`. The spool write's `appendFile` is the one stubbed boundary; the forwarder's
 * send additionally stubs `fetch` and the daemon state it reads its destination from.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const spoolFault = vi.hoisted(() => ({ failures: 0 }));
const unlinkFault = vi.hoisted(() => ({ before: undefined as ((path: string) => void) | undefined }));
const readStateMock = vi.hoisted(() => vi.fn());

// Real fs; `appendFile` on a spool hooks file can be told to reject (the bytes-landing step of appendSpool), and an
// `unlink` can be told to let another process remove the file first.
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
    unlink: (...args: Parameters<typeof actual.unlink>): Promise<void> => {
      unlinkFault.before?.(String(args[0]));
      return actual.unlink(...args);
    },
  };
});

vi.mock('@/cli/commands/proxy/daemon-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/cli/commands/proxy/daemon-manager.js')>()),
  readState: readStateMock,
}));

import { boundedText, TEXT_FIELD_LIMITS } from '@/agents/core/otlp-field-limits.js';
import { logger } from '@/utils/logger.js';
import { forwardSession } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/forwarder.js';
import { appendSpool } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/spool-io.js';
import { discoverClaudeDesktopSessions } from '@/telemetry/clients/claude-desktop/claude-desktop.discovery.js';
import { getClaudeDesktopBaseDir, getClaudeDesktopLocalSessionsRoot } from '@/telemetry/clients/claude-desktop/claude-desktop.paths.js';
import { CoworkEventProducer, desktopAnalyticsBackfillDays } from '../CoworkEventProducer.js';
import { markCoworkSessionServed } from '../cowork-served-mark.js';
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
let gitConfigDir: string;
let emptyGitConfig: string;
const savedGitEnv: Record<string, string | undefined> = {};

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

/** The served mark the proxy daemon leaves beside a session's cursor. */
function servedMarkPath(cliSessionId: string): string {
  return join(codemieHome, 'analytics', 'state', `${cliSessionId}.cowork-served`);
}

function markServed(cliSessionId: string): void {
  mkdirSync(dirname(servedMarkPath(cliSessionId)), { recursive: true });
  writeFileSync(servedMarkPath(cliSessionId), '');
}

function writeProfile(project: string): void {
  const profile = { provider: 'ai-run-sso', baseUrl: 'https://api.example.com', model: 'model', codeMieUrl: 'https://api.example.com', codeMieProject: project };
  writeFileSync(join(codemieHome, 'codemie-cli.config.json'), JSON.stringify({ version: 2, activeProfile: 'cowork', profiles: { cowork: profile } }));
}

function newProducer(discover?: (sinceMs: number) => ReturnType<typeof discoverClaudeDesktopSessions>): CoworkEventProducer {
  return new CoworkEventProducer({ profile: 'cowork', inactivityTimeoutMs: INACTIVITY_TIMEOUT_MS, ...(discover && { discover }) });
}

/** Two runs one poll apart: the first sees the current files, the second processes them. */
async function settle(producer: CoworkEventProducer, now: number, connected = true): Promise<void> {
  await producer.run(now, connected);
  await producer.run(now + 10_000, connected);
}

function warnings(): unknown[][] {
  return vi.mocked(logger.warn).mock.calls;
}

// A git hook exports GIT_DIR / GIT_WORK_TREE, which would point every git call here at the outer repository; the
// developer's git config differs per machine.
beforeAll(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_')) {
      savedGitEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
  gitConfigDir = mkdtempSync(join(tmpdir(), 'cowork-gitconfig-'));
  emptyGitConfig = join(gitConfigDir, 'empty-gitconfig');
  writeFileSync(emptyGitConfig, '');
  process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

afterAll(() => {
  delete process.env.GIT_CONFIG_GLOBAL;
  delete process.env.GIT_CONFIG_NOSYSTEM;
  for (const [key, value] of Object.entries(savedGitEnv)) process.env[key] = value;
  if (gitConfigDir) rmSync(gitConfigDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

beforeEach(() => {
  // The native resolver also expands a Windows 8.3 short name, which the JS one leaves in the path.
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'cowork-home-')));
  codemieHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'cowork-codemie-')));
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
  // Both sessions were served by this daemon unless a test says otherwise
  markServed(CLI);
  markServed(CLI_2);
  vi.spyOn(logger, 'warn');
});

afterEach(async () => {
  spoolFault.failures = 0;
  unlinkFault.before = undefined;
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
    const listFiles = (dir: string, prefix: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? listFiles(join(dir, entry.name), `${prefix}${entry.name}/`)
          : [`${prefix}${entry.name}`]);
    const files = listFiles(root, '').sort();

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
    const sessionStart = lines.find((spoolLine) => spoolLine.event['type'] === 'agent.session.start')?.event;
    expect(sessionStart).toMatchObject({ timestamp: '2026-11-10T10:00:00.000Z', cwd: 'Cowork' });
    // EPMCDME-17317: Desktop's own auto-title ("Synthetic notes task" in the fixture's metadata.json)
    // must never reach the wire as session_title, even though Desktop set one.
    expect(sessionStart).not.toHaveProperty('session_title');
    for (const { event } of lines) {
      expect(event).not.toHaveProperty('session_title');
    }
    expect(lines.filter((spoolLine) => spoolLine.event['git_branch'] !== '' || spoolLine.event['cwd'] !== 'Cowork')).toEqual([]);
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

  describe('the branch of the session\'s folder', () => {
    const folders: string[] = [];

    function git(cwd: string, ...args: string[]): void {
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
        cwd, stdio: 'pipe', timeout: 10_000,
      });
    }

    /** A folder `<temp>/synthetic-parent/synthetic-folder`, selected as the fixture session's folder. */
    function selectFolder(): string {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cowork-folder-')));
      folders.push(root);
      const folder = join(root, 'synthetic-parent', 'synthetic-folder');
      mkdirSync(folder, { recursive: true });
      writeMetadata(LOCAL, { userSelectedFolders: [folder] });
      return folder;
    }

    function selectRepository(): string {
      const folder = selectFolder();
      git(folder, 'init', '-q', '-b', 'main');
      git(folder, 'commit', '-q', '--allow-empty', '-m', 'synthetic');
      git(folder, 'checkout', '-q', '-b', 'qa-17128-cw2');
      return folder;
    }

    afterAll(() => {
      for (const folder of folders) rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('stamps every event with the folder\'s branch and every summary with it as branch_dominant', async () => {
      selectRepository();

      await settle(newProducer(), LAST_LINE_MS + 20_000);

      const written = events();
      expect(written.map((event) => event['type'])).toEqual(FIRST_PROCESSING_TYPES);
      expect(written.filter((event) => event['git_branch'] !== 'qa-17128-cw2')).toEqual([]);
      expect(spooled().filter((spoolLine) => spoolLine.raw.includes('\\"git_branch\\":\\"HEAD\\"'))).toEqual([]);
      const summaries = written.filter((event) => event['type'] === 'agent.session.summary');
      expect(summaries.length).toBeGreaterThan(0);
      for (const summary of summaries) {
        expect(summary['branch_dominant']).toBe('qa-17128-cw2');
        expect(summary).not.toHaveProperty('branch_counts');
      }
    });

    it('edge: stamps an empty branch and no branch_dominant while the folder\'s HEAD is detached', async () => {
      git(selectRepository(), 'checkout', '-q', '--detach');

      await settle(newProducer(), LAST_LINE_MS + 20_000);

      const written = events();
      expect(written.length).toBeGreaterThan(0);
      expect(written.filter((event) => event['git_branch'] !== '')).toEqual([]);
      expect(written.filter((event) => event['type'] === 'agent.session.summary' && Object.prototype.hasOwnProperty.call(event, 'branch_dominant'))).toEqual([]);
    });

    it('edge: stamps an empty branch and the folder\'s two last segments for a folder outside Git', async () => {
      selectFolder();

      await settle(newProducer(), LAST_LINE_MS + 20_000);

      const written = events();
      expect(written.length).toBeGreaterThan(0);
      expect(written.filter((event) => event['git_branch'] !== '' || event['cwd'] !== 'synthetic-parent/synthetic-folder')).toEqual([]);
    });

    it('edge: stamps the new lines with the branch the folder is on when they are read, and appends no line twice', async () => {
      const folder = selectRepository();
      const producer = newProducer();
      await settle(producer, LAST_LINE_MS + 20_000);
      const before = spooled().length;

      git(folder, 'checkout', '-q', '-b', 'other');
      appendFileSync(mainPath(), userLine('00000000-0000-4000-8000-0000000000e1', '2026-11-10T10:00:40.000Z', 'One more synthetic question'));
      appendFileSync(mainPath(), assistantLine('00000000-0000-4000-8000-0000000000e2', '2026-11-10T10:00:45.000Z', 'msg_synthetic_E', [{ type: 'text', text: 'Answered.' }]));
      await settle(producer, LAST_LINE_MS + 60_000);

      const written = events();
      const grown = written.slice(before);
      expect(written.slice(0, before).filter((event) => event['git_branch'] !== 'qa-17128-cw2')).toEqual([]);
      expect(grown.map((event) => event['event_id'])).toContain(`agent.prompt.submit:${CLI}:00000000-0000-4000-8000-0000000000e1`);
      expect(grown.filter((event) => event['git_branch'] !== 'other')).toEqual([]);
      expect(new Set(written.map((event) => event['event_id'])).size).toBe(written.length);
    });
  });
});

describe('CoworkEventProducer and the served mark', () => {
  const cursorPath = (cliSessionId = CLI) => join(codemieHome, 'analytics', 'state', `${cliSessionId}.cowork.json`);

  beforeEach(() => {
    rmSync(servedMarkPath(CLI));
  });

  it('appends nothing for a session in the window with no mark and no cursor', async () => {
    await settle(newProducer(), LAST_LINE_MS + 20_000);

    expect(existsSync(spoolPath())).toBe(false);
    expect(existsSync(cursorPath())).toBe(false);
  });

  it('collects the same session from its first line once it has a mark', async () => {
    await settle(newProducer(), LAST_LINE_MS + 20_000);
    markServed(CLI);

    await settle(newProducer(), LAST_LINE_MS + 40_000);

    expect(events().map((event) => event['type'])).toEqual(FIRST_PROCESSING_TYPES);
  });

  it('collects a session with a cursor and no mark as today', async () => {
    markServed(CLI);
    const producer = newProducer();
    await settle(producer, LAST_LINE_MS + 20_000);
    const before = spooled().length;
    rmSync(servedMarkPath(CLI));
    appendFileSync(mainPath(), userLine('00000000-0000-4000-8000-0000000000e1', '2026-11-10T10:01:00.000Z', 'A synthetic follow-up'));

    await settle(newProducer(), LAST_LINE_MS + 90_000);

    expect(events().slice(before).map((event) => event['type'])).toEqual(['agent.session.summary', 'agent.prompt.submit']);
  });

  it('keeps a session marked for a new producer over the same home (a daemon restart)', async () => {
    markServed(CLI);
    await newProducer().run(LAST_LINE_MS + 20_000);

    await settle(newProducer(), LAST_LINE_MS + 40_000);

    expect(events().map((event) => event['type'])).toEqual(FIRST_PROCESSING_TYPES);
  });

  it.each([
    ['a mark file', () => writeFileSync(servedMarkPath(CLI), '\u0000not a mark')],
    ['a cursor file', () => writeFileSync(cursorPath(), '{not json')],
  ])('takes a session whose %s exists and cannot be parsed', async (_case, write) => {
    mkdirSync(dirname(cursorPath()), { recursive: true });
    write();

    await settle(newProducer(), LAST_LINE_MS + 20_000);

    expect(events().map((event) => event['type'])).toEqual(FIRST_PROCESSING_TYPES);
  });

  it('edge: a mark written after the producer listed its sessions is taken at the next list refresh, not sooner', async () => {
    const producer = newProducer();
    const start = LAST_LINE_MS + 20_000;
    await settle(producer, start);
    markServed(CLI);

    for (let at = start + 20_000; at < start + INACTIVITY_TIMEOUT_MS; at += 10_000) await producer.run(at);
    const beforeRefresh = existsSync(spoolPath());
    await settle(producer, start + INACTIVITY_TIMEOUT_MS);

    expect(beforeRefresh).toBe(false);
    expect(events().filter((event) => event['type'] === 'agent.session.start')).toHaveLength(1);
  });
});

describe('CoworkEventProducer while Desktop is not connected', () => {
  const cursorPath = (cliSessionId = CLI) => join(codemieHome, 'analytics', 'state', `${cliSessionId}.cowork.json`);
  const ENDED_AT = '2026-11-10T10:00:30.000Z';
  const RESUMED_AT = Date.parse('2026-11-10T10:20:05.000Z');
  const UNPARSABLE_CURSOR = '[cowork-producer] Unparsable cursor; the session is read again from its start';

  function appendTurn(): void {
    appendFileSync(mainPath(), userLine('00000000-0000-4000-8000-0000000000d1', '2026-11-10T10:20:00.000Z', 'One more synthetic question'));
    appendFileSync(mainPath(), assistantLine('00000000-0000-4000-8000-0000000000d2', '2026-11-10T10:20:05.000Z', 'msg_synthetic_D', [{ type: 'text', text: 'Answered.' }]));
  }

  it('ends a session whose cursor holds no end, once and with the final summary', async () => {
    const producer = newProducer();
    await settle(producer, LAST_LINE_MS + 20_000);
    const before = spooled().length;

    await producer.run(LAST_LINE_MS + INACTIVITY_TIMEOUT_MS + 40_000, false);
    await producer.run(LAST_LINE_MS + INACTIVITY_TIMEOUT_MS + 50_000, false);
    await producer.run(LAST_LINE_MS + 2 * INACTIVITY_TIMEOUT_MS + 60_000, false);

    const appended = events().slice(before);
    expect(appended.map((event) => event['type'])).toEqual(['agent.session.summary', 'agent.session.end']);
    expect(appended[0]).toMatchObject({ is_final: true });
    expect(appended[1]).toMatchObject({ event_id: `agent.session.end:${CLI}:${ENDED_AT}` });
    const cursor = JSON.parse(readFileSync(cursorPath(), 'utf-8')) as { lastEndedAt: string; events: { lastLineAt: string } };
    expect(cursor).toMatchObject({ lastEndedAt: ENDED_AT, events: { lastLineAt: ENDED_AT } });
  });

  it('reads the lines a session with no end wrote after its cursor, then ends it', async () => {
    const producer = newProducer();
    await settle(producer, LAST_LINE_MS + 20_000);
    const before = spooled().length;

    appendTurn();
    await settle(producer, RESUMED_AT + 60_000, false);
    const grown = events().slice(before);
    await producer.run(RESUMED_AT + INACTIVITY_TIMEOUT_MS + 10_000, false);
    const ended = events().slice(before + grown.length);

    expect(grown.map((event) => event['type'])).toEqual(['agent.usage.request', 'agent.session.summary', 'agent.prompt.submit']);
    expect(grown[0]).toMatchObject({ message_id: 'msg_synthetic_D' });
    expect(ended.map((event) => event['event_id'])).toEqual([
      `agent.session.summary:${CLI}:summary:final:2026-11-10T10:20:05.000Z`,
      `agent.session.end:${CLI}:2026-11-10T10:20:05.000Z`,
    ]);
  });

  it('reads neither a session with a served mark alone nor one whose cursor holds its end and that grew; a connected run after it reads both', async () => {
    const producer = newProducer();
    await settle(producer, LAST_LINE_MS + 20_000);
    await producer.run(LAST_LINE_MS + INACTIVITY_TIMEOUT_MS + 40_000);
    const before = spooled().length;
    const endedCursor = readFileSync(cursorPath(), 'utf-8');
    appendTurn();
    addSecondSession(RESUMED_AT);

    const notConnected = newProducer();
    await settle(notConnected, RESUMED_AT + 60_000, false);

    expect(spooled().length).toBe(before);
    expect(readFileSync(cursorPath(), 'utf-8')).toBe(endedCursor);
    expect(existsSync(spoolPath(CLI_2))).toBe(false);
    expect(existsSync(cursorPath(CLI_2))).toBe(false);

    await settle(notConnected, RESUMED_AT + 80_000);

    expect(events().slice(before).map((event) => event['type'])).toEqual(['agent.usage.request', 'agent.session.summary', 'agent.prompt.submit']);
    expect(events(CLI_2).filter((event) => event['type'] === 'agent.session.start')).toHaveLength(1);
    expect(existsSync(cursorPath(CLI_2))).toBe(true);
  });

  it('edge: a new producer ends a session whose cursor holds no end', async () => {
    await settle(newProducer(), LAST_LINE_MS + 20_000);
    const before = spooled().length;

    await settle(newProducer(), LAST_LINE_MS + INACTIVITY_TIMEOUT_MS + 40_000, false);

    const appended = events().slice(before);
    expect(appended.map((event) => event['type'])).toEqual(['agent.session.summary', 'agent.session.end']);
    expect(appended[0]).toMatchObject({ is_final: true });
    expect(appended[1]).toMatchObject({ event_id: `agent.session.end:${CLI}:${ENDED_AT}` });
  });

  const unparsableWarnings = () => warnings().filter(([message]) => message === UNPARSABLE_CURSOR);

  it.each([
    ['an unparsable cursor', '{not json', 1],
    ['a cursor with no line', JSON.stringify({ offsets: {}, fingerprints: {}, lastEndedAt: '' }), 0],
  ])('edge: appends nothing for a session with %s, leaves the file as it is and reads it once while it is unchanged', async (_case, content, warned) => {
    mkdirSync(dirname(cursorPath()), { recursive: true });
    writeFileSync(cursorPath(), content);
    appendTurn();
    const producer = newProducer();

    await settle(producer, RESUMED_AT + INACTIVITY_TIMEOUT_MS + 20_000, false);
    for (const at of [40_000, 50_000, 60_000]) await producer.run(RESUMED_AT + INACTIVITY_TIMEOUT_MS + at, false);

    expect(existsSync(spoolPath())).toBe(false);
    expect(readFileSync(cursorPath(), 'utf-8')).toBe(content);
    expect(unparsableWarnings()).toHaveLength(warned);
  });

  it('edge: reads no cursor of a session it left again until the session\'s files change', async () => {
    const producer = newProducer();
    await settle(producer, LAST_LINE_MS + 20_000);
    await producer.run(LAST_LINE_MS + INACTIVITY_TIMEOUT_MS + 40_000);
    const before = spooled().length;
    appendTurn();
    await settle(producer, RESUMED_AT + 60_000, false);
    writeFileSync(cursorPath(), '{not json');

    for (const at of [80_000, 90_000, 100_000]) await producer.run(RESUMED_AT + at, false);
    const whileUnchanged = unparsableWarnings().length;
    appendFileSync(mainPath(), userLine('00000000-0000-4000-8000-0000000000d3', '2026-11-10T10:22:00.000Z', 'A synthetic follow-up'));
    for (const at of [130_000, 140_000, 150_000]) await producer.run(RESUMED_AT + at, false);

    expect(whileUnchanged).toBe(0);
    expect(unparsableWarnings()).toHaveLength(1);
    expect(spooled().length).toBe(before);
  });

  it('edge: ends a session it left with a served mark alone once a connected run collected it', async () => {
    const producer = newProducer();
    await settle(producer, LAST_LINE_MS + 20_000, false);
    await producer.run(LAST_LINE_MS + 40_000, false);
    expect(existsSync(spoolPath())).toBe(false);

    await producer.run(LAST_LINE_MS + 50_000);
    const before = spooled().length;
    await producer.run(LAST_LINE_MS + INACTIVITY_TIMEOUT_MS + 40_000, false);
    await producer.run(LAST_LINE_MS + INACTIVITY_TIMEOUT_MS + 50_000, false);

    expect(before).toBeGreaterThan(0);
    const appended = events().slice(before);
    expect(appended.map((event) => event['type'])).toEqual(['agent.session.summary', 'agent.session.end']);
    expect(appended[0]).toMatchObject({ is_final: true });
    expect(appended[1]).toMatchObject({ event_id: `agent.session.end:${CLI}:${ENDED_AT}` });
  });

  it('edge: appends nothing with analytics disabled, a cursor with no end included', async () => {
    await settle(newProducer(), LAST_LINE_MS + 20_000);
    const before = spooled().length;
    writeFileSync(join(codemieHome, 'claude-analytics.json'), JSON.stringify({ enabled: false }));

    await settle(newProducer(), LAST_LINE_MS + INACTIVITY_TIMEOUT_MS + 40_000, false);

    expect(spooled().length).toBe(before);
  });
});

describe('CoworkEventProducer and the pruning of served marks', () => {
  /** A session discovery does not list: no Desktop session of the fixture has this id. */
  const GONE = '9e3f4051-6c7d-4e8f-a01b-2c3d4e5f6071';
  const GONE_2 = 'af405162-7d8e-4f90-b12c-3d4e5f607182';
  const NOW = LAST_LINE_MS + 20_000;
  const stateDir = () => join(codemieHome, 'analytics', 'state');
  const markWarnings = () => warnings().filter(([message]) => message === '[cowork-served-mark] Served mark not removed');

  function age(path: string, days: number, now = NOW): void {
    const at = new Date(now - days * DAY_MS);
    utimesSync(path, at, at);
  }

  function oldMark(cliSessionId: string, days = 15, now = NOW): void {
    markServed(cliSessionId);
    age(servedMarkPath(cliSessionId), days, now);
  }

  it('deletes a mark 15 days old of a session discovery does not list', async () => {
    oldMark(GONE);

    await newProducer().run(NOW);

    expect(existsSync(servedMarkPath(GONE))).toBe(false);
  });

  it('deletes a mark this process wrote, and the next request of the session writes it again', async () => {
    await markCoworkSessionServed(GONE);
    age(servedMarkPath(GONE), 15);

    await newProducer().run(NOW);
    const afterRun = existsSync(servedMarkPath(GONE));
    await markCoworkSessionServed(GONE);

    expect(afterRun).toBe(false);
    expect(existsSync(servedMarkPath(GONE))).toBe(true);
  });

  it('keeps a mark 15 days old of a listed session active yesterday, and collects the session', async () => {
    const now = LAST_LINE_MS + DAY_MS;
    oldMark(CLI, 15, now);

    await settle(newProducer(), now);

    expect(existsSync(servedMarkPath(CLI))).toBe(true);
    expect(events().filter((event) => event['type'] === 'agent.session.start')).toHaveLength(1);
  });

  it('keeps a mark 15 days old of a listed session the producer does not take (no inner transcript)', async () => {
    rmSync(mainPath());
    oldMark(CLI);

    await newProducer().run(NOW);

    expect(existsSync(servedMarkPath(CLI))).toBe(true);
  });

  it('keeps a mark 1 day old of a session discovery does not list', async () => {
    oldMark(GONE, 1);

    await newProducer().run(NOW);

    expect(existsSync(servedMarkPath(GONE))).toBe(true);
  });

  it('with CODEMIE_DESKTOP_ANALYTICS_BACKFILL_DAYS=14 keeps an unlisted mark 10 days old and deletes one 15 days old', async () => {
    vi.stubEnv('CODEMIE_DESKTOP_ANALYTICS_BACKFILL_DAYS', '14');
    oldMark(GONE, 10);
    oldMark(GONE_2, 15);

    await newProducer().run(NOW);

    expect(existsSync(servedMarkPath(GONE))).toBe(true);
    expect(existsSync(servedMarkPath(GONE_2))).toBe(false);
  });

  it('keeps the cursor and the record of an unlisted session, byte for byte', async () => {
    const cursor = join(stateDir(), `${GONE}.cowork.json`);
    const record = join(stateDir(), `${GONE}.json`);
    writeFileSync(cursor, '{"synthetic":"cursor"}');
    writeFileSync(record, '{"synthetic":"record"}');
    age(cursor, 15);
    age(record, 15);

    await newProducer().run(NOW);

    expect(readFileSync(cursor, 'utf-8')).toBe('{"synthetic":"cursor"}');
    expect(readFileSync(record, 'utf-8')).toBe('{"synthetic":"record"}');
  });

  it.each([
    ['a corrupt preferences file', () => writeFileSync(join(codemieHome, 'claude-analytics.json'), '{not json')],
    ['enabled: false', () => writeFileSync(join(codemieHome, 'claude-analytics.json'), JSON.stringify({ enabled: false }))],
    ['OTLP_ALLOW_HOOKS_ONLY_FORWARD=false', () => vi.stubEnv('OTLP_ALLOW_HOOKS_ONLY_FORWARD', 'false')],
  ])('deletes an unlisted mark 15 days old and appends nothing with %s', async (_case, closeGate) => {
    closeGate();
    oldMark(GONE);

    await settle(newProducer(), NOW);

    expect(existsSync(servedMarkPath(GONE))).toBe(false);
    expect(existsSync(join(codemieHome, 'proxy', 'otlp-spool'))).toBe(false);
  });

  it('edge: with no state directory lists no mark, deletes nothing and warns nothing', async () => {
    rmSync(stateDir(), { recursive: true });

    await settle(newProducer(), NOW);

    expect(existsSync(stateDir())).toBe(false);
    expect(warnings()).toEqual([]);
  });

  it('edge: a mark another process removes before the removal costs no warning, and the run goes on', async () => {
    oldMark(GONE);
    unlinkFault.before = (path) => {
      if (path === servedMarkPath(GONE)) rmSync(path, { force: true });
    };

    await settle(newProducer(), NOW);

    expect(existsSync(servedMarkPath(GONE))).toBe(false);
    expect(warnings()).toEqual([]);
    expect(events().filter((event) => event['type'] === 'agent.session.start')).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('edge: a removal that fails warns once and the listed session is collected', async () => {
    if (process.getuid?.() === 0) return; // root bypasses file-mode permission checks; nothing to assert here.
    oldMark(GONE);
    const producer = newProducer();
    // Read-only for the run that refreshes the list; the next run processes the session, which writes its cursor there.
    chmodSync(stateDir(), 0o555);
    try {
      await producer.run(NOW);
    } finally {
      chmodSync(stateDir(), 0o755);
    }
    await producer.run(NOW + 10_000);

    expect(existsSync(servedMarkPath(GONE))).toBe(true);
    expect(markWarnings()).toHaveLength(1);
    expect(events().filter((event) => event['type'] === 'agent.session.start')).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('edge: a removal that fails at two refreshes in a row warns once', async () => {
    if (process.getuid?.() === 0) return; // root bypasses file-mode permission checks; nothing to assert here.
    oldMark(GONE);
    const producer = newProducer(async () => []);
    chmodSync(stateDir(), 0o555);
    try {
      await producer.run(NOW);
      await producer.run(NOW + INACTIVITY_TIMEOUT_MS);
    } finally {
      chmodSync(stateDir(), 0o755);
    }

    expect(existsSync(servedMarkPath(GONE))).toBe(true);
    expect(markWarnings()).toHaveLength(1);
  });

  it('edge: a second refresh over the same old mark deletes nothing and logs nothing', async () => {
    oldMark(GONE);
    const producer = newProducer();

    await producer.run(NOW);
    await producer.run(NOW + INACTIVITY_TIMEOUT_MS);

    expect(existsSync(servedMarkPath(GONE))).toBe(false);
    expect(warnings()).toEqual([]);
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

describe('CoworkEventProducer and the session\'s fixed project (EPMCDME-17385)', () => {
  const credentials = { cookies: { codemie_access_token: 'tok' }, apiUrl: 'https://api', timestamp: 0 };
  const fetchMock = vi.fn();
  const FIRST = LAST_LINE_MS + 20_000;
  const END = LAST_LINE_MS + INACTIVITY_TIMEOUT_MS + 40_000;
  const attributionPath = () => join(codemieHome, 'analytics', 'state', `${CLI}.cowork-attribution.json`);
  const status = () => JSON.parse(readFileSync(spoolPath(CLI, '.status'), 'utf-8')) as { project?: string; projectConflict?: string[]; projectSeal?: unknown };

  const PROFILE = { provider: 'ai-run-sso', baseUrl: 'https://api.example.com', model: 'model', codeMieUrl: 'https://api.example.com' };

  /** A profile without a project of its own: the shared (global workspace) project applies, as for a session with no folder. */
  function writeSharedProject(project: string): void {
    writeFileSync(join(codemieHome, 'codemie-cli.config.json'), JSON.stringify({ version: 2, activeProfile: 'cowork', profiles: { cowork: PROFILE }, workspace: { codeMieProject: project } }));
  }

  beforeEach(() => {
    writeSharedProject('synthetic-project');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
    readStateMock.mockResolvedValue({ url: 'http://127.0.0.1:1', targetUrl: 'https://api.example.com' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A folder of another project joins the session: its own config now names `other-project`, as `.codemie/codemie-cli.config.json` of a linked repository does. */
  async function linkFolderOfOtherProject(): Promise<void> {
    const [session] = await discoverClaudeDesktopSessions(LAST_LINE_MS - DAY_MS);
    const localConfig = join(session.workingDirectory, '.codemie', 'codemie-cli.config.json');
    mkdirSync(dirname(localConfig), { recursive: true });
    writeFileSync(localConfig, JSON.stringify({ version: 2, activeProfile: 'cowork', profiles: { cowork: PROFILE }, workspace: { codeMieProject: 'other-project' } }));
  }

  /** Every event of every request sent so far, with the request's X-CodeMie headers. */
  function sentRequests(): Array<{ headers: Record<string, string>; events: WireEvent[] }> {
    return fetchMock.mock.calls.map(([, init]) => {
      const request = init as { headers: Record<string, string>; body: string };
      return {
        headers: request.headers,
        events: request.body.split('\n').filter((body) => body.length > 0).map((body) => JSON.parse(body) as WireEvent),
      };
    });
  }

  it('keeps the first project for the end and the summaries after a folder of another project joined, and the spool sees no conflict', async () => {
    const producer = newProducer();
    await settle(producer, FIRST);
    await linkFolderOfOtherProject();
    const before = spooled().length;

    await producer.run(END);
    await producer.run(END + 10_000);

    const appended = events().slice(before);
    expect(appended.map((event) => event['type'])).toEqual(['agent.session.summary', 'agent.session.end']);
    for (const event of events()) expect(event['codemie_project_name']).toBe('synthetic-project');
    expect(status().projectConflict).toBeUndefined();
    expect(status().project).toBe('synthetic-project');
    expect(JSON.parse(readFileSync(attributionPath(), 'utf-8'))).toEqual({ project: 'synthetic-project', projectSource: 'profile' });
  });

  it('delivers the session end under the first project through the forwarder (synthetic HTTP): the final summary is sent, not discarded', async () => {
    const producer = newProducer();
    await settle(producer, FIRST);
    await forwardSession(CLI, true, credentials as never);
    await linkFolderOfOtherProject();
    await producer.run(END);
    await producer.run(END + 10_000);
    await forwardSession(CLI, true, credentials as never);

    const requests = sentRequests();
    const types = requests.flatMap(({ events: sentEvents }) => sentEvents.map((event) => event['type']));
    expect(types).toContain('agent.session.end');
    expect(requests.flatMap(({ events: sentEvents }) => sentEvents).find((event) => event['type'] === 'agent.session.summary' && event['is_final'] === true)).toBeDefined();
    for (const { headers, events: sentEvents } of requests) {
      expect(headers['X-CodeMie-Project']).toBe('synthetic-project');
      for (const event of sentEvents) expect(event['codemie_project_name']).toBe('synthetic-project');
    }
    expect(status().projectConflict).toBeUndefined();
  });

  /** A folder of its own under the temp home whose `.codemie` config links it to `project`. */
  function linkedFolder(name: string, project: string): string {
    const folder = join(home, name);
    mkdirSync(join(folder, '.codemie'), { recursive: true });
    writeFileSync(join(folder, '.codemie', 'codemie-cli.config.json'), JSON.stringify({ version: 2, activeProfile: 'cowork', profiles: { cowork: PROFILE }, workspace: { codeMieProject: project } }));
    return folder;
  }

  // Desktop's own transition: userSelectedFolders changes (a DISTINCT directory resolving another project) while the
  // task keeps working. Synthetic fixture: real producer, spool and forwarder, mocked HTTP; not a live backend.
  it.each([
    { change: 'a folder is added', initial: [], next: ['p2'], first: 'synthetic-project', restart: false },
    { change: 'the folders are reordered, then the daemon restarts', initial: ['p2', 'p3'], next: ['p3', 'p2'], first: 'other-project', restart: true },
    { change: 'the only folder is removed, then the daemon restarts', initial: ['p2'], next: [], first: 'other-project', restart: true },
  ])('sends work done after the folders change under the first project, and delivers the final summary and end: $change', async ({ initial, next, first, restart }) => {
    const dirs: Record<string, string> = { p2: linkedFolder('folder-p2', 'other-project'), p3: linkedFolder('folder-p3', 'third-project') };
    const select = (keys: string[]): void => writeMetadata(LOCAL, { userSelectedFolders: keys.map((key) => dirs[key]) });
    const cwdOf = async (): Promise<string> => (await discoverClaudeDesktopSessions(LAST_LINE_MS - DAY_MS))[0].workingDirectory;
    select(initial);
    const initialCwd = await cwdOf();
    let producer = newProducer();
    await settle(producer, FIRST);
    await forwardSession(CLI, true, credentials as never);
    const firstRequests = fetchMock.mock.calls.length;
    expect(firstRequests).toBeGreaterThan(0);

    // Desktop now lists other folders, and the task does new work: a prompt, a tool call and its result, an answer with usage.
    select(next);
    expect(await cwdOf()).not.toBe(initialCwd);
    appendFileSync(mainPath(), userLine('00000000-0000-4000-8000-0000000000h1', '2026-11-10T10:01:00.000Z', 'Create notes2.md in the new folder'));
    appendFileSync(mainPath(), assistantLine('00000000-0000-4000-8000-0000000000h2', '2026-11-10T10:01:05.000Z', 'msg_synthetic_H1',
      [{ type: 'tool_use', id: 'toolu_synthetic_h', name: 'Write', input: { file_path: 'notes2.md', content: 'x' } }]));
    appendFileSync(mainPath(), userLine('00000000-0000-4000-8000-0000000000h3', '2026-11-10T10:01:10.000Z',
      [{ type: 'tool_result', tool_use_id: 'toolu_synthetic_h', content: 'ok' }]));
    appendFileSync(mainPath(), assistantLine('00000000-0000-4000-8000-0000000000h4', '2026-11-10T10:01:15.000Z', 'msg_synthetic_H2', [{ type: 'text', text: 'Done.' }]));

    // Inside the discovery window (the producer still holds its cached folder), then after the refresh, then the end.
    await settle(producer, FIRST + 60_000);
    await forwardSession(CLI, true, credentials as never);
    if (restart) producer = newProducer();
    await settle(producer, FIRST + INACTIVITY_TIMEOUT_MS + 60_000);
    await settle(producer, FIRST + 2 * INACTIVITY_TIMEOUT_MS + 120_000);
    await forwardSession(CLI, true, credentials as never);

    const requests = sentRequests();
    const afterChange = requests.slice(firstRequests).flatMap(({ events: sentEvents }) => sentEvents);
    const idsAfter = afterChange.map((event) => event['event_id']);
    expect(idsAfter).toContain(`agent.prompt.submit:${CLI}:00000000-0000-4000-8000-0000000000h1`);
    expect(afterChange.filter((event) => event['type'] === 'agent.tool.start' || event['type'] === 'agent.tool.end').length).toBeGreaterThanOrEqual(2);
    expect(afterChange.filter((event) => event['type'] === 'agent.usage.request').map((event) => event['message_id'])).toContain('msg_synthetic_H2');
    expect(afterChange.some((event) => event['type'] === 'agent.session.summary' && event['is_final'] === true)).toBe(true);
    expect(afterChange.some((event) => event['type'] === 'agent.session.end')).toBe(true);
    for (const { headers, events: sentEvents } of requests) {
      expect(headers['X-CodeMie-Project']).toBe(first);
      for (const event of sentEvents) expect(event['codemie_project_name']).toBe(first);
    }
    for (const event of events()) expect(event['codemie_project_name']).toBe(first);
    expect(status().projectConflict).toBeUndefined();
    expect(status().project).toBe(first);
  });

  it('keeps the first project over a daemon restart (a new producer) when the folder\'s or the profile\'s project changed meanwhile', async () => {
    await settle(newProducer(), FIRST);
    writeSharedProject('profile-project-2');
    await linkFolderOfOtherProject();

    const restarted = newProducer();
    await restarted.run(END);
    await restarted.run(END + 10_000);

    for (const event of events()) expect(event['codemie_project_name']).toBe('synthetic-project');
    expect(status().projectConflict).toBeUndefined();
  });

  it('keeps the project of a session first resolved from a linked folder after the folder is removed', async () => {
    await linkFolderOfOtherProject();
    const producer = newProducer();
    await settle(producer, FIRST);
    const [session] = await discoverClaudeDesktopSessions(LAST_LINE_MS - DAY_MS);
    rmSync(join(session.workingDirectory, '.codemie'), { recursive: true });

    await producer.run(END);
    await producer.run(END + 10_000);

    expect(JSON.parse(readFileSync(attributionPath(), 'utf-8'))).toEqual({ project: 'other-project', projectSource: 'linked_folder' });
    for (const event of events()) expect(event['codemie_project_name']).toBe('other-project');
    expect(status().projectConflict).toBeUndefined();
  });

  it('a session first resolved without any project stays without one when a project appears later (nothing is sent under a late project)', async () => {
    rmSync(join(codemieHome, 'codemie-cli.config.json'));
    const producer = newProducer();
    await settle(producer, FIRST);
    writeProfile('late-project');

    await producer.run(END);
    await producer.run(END + 10_000);

    expect(events().filter((event) => 'codemie_project_name' in event)).toEqual([]);
    expect(status().project).toBeUndefined();
  });

  it('boundary: a session already bound by the spool with no pin keeps the spool\'s project and is pinned to it', async () => {
    await settle(newProducer(), FIRST);
    // A session collected before pins existed: spool bound to synthetic-project, no attribution file.
    rmSync(attributionPath());
    writeSharedProject('profile-project-2');
    await linkFolderOfOtherProject();

    const producer = newProducer();
    await producer.run(END);
    await producer.run(END + 10_000);

    for (const event of events()) expect(event['codemie_project_name']).toBe('synthetic-project');
    expect(status().projectConflict).toBeUndefined();
    // Its source cannot be told from the new folder's: no funding declaration is made for it (see the funding tests).
    expect(JSON.parse(readFileSync(attributionPath(), 'utf-8'))).toEqual({ project: 'synthetic-project', projectSource: 'none' });
  });

  it('boundary: an unreadable pin cannot move a session whose project the spool already holds', async () => {
    await settle(newProducer(), FIRST);
    writeFileSync(attributionPath(), '{nope');
    writeSharedProject('profile-project-2');
    await linkFolderOfOtherProject();

    await producer2RunAtEnd();

    for (const event of events()) expect(event['codemie_project_name']).toBe('synthetic-project');
    expect(status().projectConflict).toBeUndefined();
    expect(JSON.parse(readFileSync(attributionPath(), 'utf-8')).project).toBe('synthetic-project');
  });

  async function producer2RunAtEnd(): Promise<void> {
    const producer = newProducer();
    await producer.run(END);
    await producer.run(END + 10_000);
  }

  it('boundary: a session with a cursor and neither pin nor spool binding is pinned at its next processing', async () => {
    await settle(newProducer(), FIRST);
    rmSync(attributionPath());
    rmSync(spoolPath(CLI, '.status'));
    rmSync(spoolPath());

    await settle(newProducer(), END);

    expect(existsSync(attributionPath())).toBe(true);
    expect(JSON.parse(readFileSync(attributionPath(), 'utf-8'))).toEqual({ project: 'synthetic-project', projectSource: 'profile' });
  });

  it('writes no pin while the local config cannot be loaded', async () => {
    const [session] = await discoverClaudeDesktopSessions(LAST_LINE_MS - DAY_MS);
    const localConfig = join(session.workingDirectory, '.codemie', 'codemie-cli.config.json');
    mkdirSync(dirname(localConfig), { recursive: true });
    writeFileSync(localConfig, JSON.stringify({ synthetic: true }));

    await settle(newProducer(), FIRST);

    expect(existsSync(attributionPath())).toBe(false);
    expect(existsSync(spoolPath())).toBe(false);
  });

  describe('funding (EPMCDME-17410), through the real forwarder with a stubbed fetch', () => {
    // The sender adds X-CodeMie-CLI and X-CodeMie-Client to every request; only the attribution headers are compared.
    const fundingHeaders = (headers: Record<string, string>) => Object.fromEntries(
      Object.entries(headers).filter(([name]) => name.startsWith('X-CodeMie') && !['X-CodeMie-CLI', 'X-CodeMie-Client'].includes(name)));

    it('declares CodeMie funding with the pinned project and source on every request of a served Cowork session, and no consent or contract', async () => {
      await settle(newProducer(), FIRST);
      await forwardSession(CLI, true, credentials as never);

      const requests = sentRequests();
      expect(requests.length).toBeGreaterThan(0);
      for (const { headers } of requests) {
        expect(fundingHeaders(headers)).toEqual({
          'X-CodeMie-Session-Id': CLI,
          'X-CodeMie-Routed-Via-CodeMie': 'true',
          'X-CodeMie-Subscription-Type': 'codemie',
          'X-CodeMie-Project': 'synthetic-project',
          'X-CodeMie-Project-Source': 'profile',
        });
      }
    });

    it('declares the linked-folder source when the project came from the folder', async () => {
      await linkFolderOfOtherProject();
      await settle(newProducer(), FIRST);
      await forwardSession(CLI, true, credentials as never);

      for (const { headers } of sentRequests()) {
        expect(fundingHeaders(headers)).toMatchObject({ 'X-CodeMie-Project': 'other-project', 'X-CodeMie-Project-Source': 'linked_folder', 'X-CodeMie-Subscription-Type': 'codemie' });
      }
    });

    it('sends the legacy Project header alone for a collected session with no served mark (legacy cursor-only boundary)', async () => {
      await settle(newProducer(), FIRST);
      rmSync(join(codemieHome, 'analytics', 'state', `${CLI}.cowork-served`));
      await forwardSession(CLI, true, credentials as never);

      const requests = sentRequests();
      expect(requests.length).toBeGreaterThan(0);
      for (const { headers } of requests) expect(fundingHeaders(headers)).toEqual({ 'X-CodeMie-Project': 'synthetic-project' });
    });

    it('sends the legacy Project header alone for a session pinned without a source (spool-bound boundary)', async () => {
      await settle(newProducer(), FIRST);
      rmSync(attributionPath());
      writeSharedProject('profile-project-2');
      await producer2Run();
      await forwardSession(CLI, true, credentials as never);

      for (const { headers } of sentRequests()) expect(fundingHeaders(headers)).toEqual({ 'X-CodeMie-Project': 'synthetic-project' });
    });

    it('a transient project-origin lookup failure appends and pins nothing, and the retry declares funding with the real source', async () => {
      const { ConfigLoader } = await import('@/utils/config.js');
      const spy = vi.spyOn(ConfigLoader, 'resolveProfileIdentity').mockRejectedValue(new Error('identity unavailable'));
      try {
        await settle(newProducer(), FIRST);
        expect(existsSync(attributionPath())).toBe(false);
        expect(existsSync(spoolPath())).toBe(false);
      } finally {
        spy.mockRestore();
      }

      // Recovery: the same producer retries before any append.
      const producer = newProducer();
      await settle(producer, FIRST + 60_000);
      expect(JSON.parse(readFileSync(attributionPath(), 'utf-8'))).toEqual({ project: 'synthetic-project', projectSource: 'profile' });
      await forwardSession(CLI, true, credentials as never);

      const requests = sentRequests();
      expect(requests.length).toBeGreaterThan(0);
      for (const { headers } of requests) {
        expect(fundingHeaders(headers)).toMatchObject({ 'X-CodeMie-Routed-Via-CodeMie': 'true', 'X-CodeMie-Subscription-Type': 'codemie', 'X-CodeMie-Project': 'synthetic-project', 'X-CodeMie-Project-Source': 'profile' });
      }
    });

    it('a failure for a session the spool already holds (no pin yet) appends nothing, and the retry pins the real source under the bound project', async () => {
      await settle(newProducer(), FIRST);
      rmSync(attributionPath()); // collected before pins existed: spool bound, no pin
      const before = events().length;
      const { ConfigLoader } = await import('@/utils/config.js');
      const spy = vi.spyOn(ConfigLoader, 'resolveProfileIdentity').mockRejectedValue(new Error('identity unavailable'));
      try {
        await producer2Run();
        expect(existsSync(attributionPath())).toBe(false);
        expect(events()).toHaveLength(before);
      } finally {
        spy.mockRestore();
      }

      const producer = newProducer();
      await producer.run(END + 60_000);
      await producer.run(END + 70_000);
      expect(JSON.parse(readFileSync(attributionPath(), 'utf-8'))).toEqual({ project: 'synthetic-project', projectSource: 'profile' });
      for (const event of events()) expect(event['codemie_project_name']).toBe('synthetic-project');
      expect(events().length).toBeGreaterThan(before);
    });

    /** One more processing so the pin is rewritten for the bound session. */
    async function producer2Run(): Promise<void> {
      const producer = newProducer();
      await producer.run(END);
      await producer.run(END + 10_000);
    }

    it('control: a native (not Cowork) session is sent exactly as before, with the Project header alone', async () => {
      const NATIVE = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
      const hook = { session_id: NATIVE, type: 'agent.session.start', codemie_project_name: 'native-project', event_id: 'native-1', timestamp: '2026-11-10T10:00:00.000Z' };
      await appendSpool(NATIVE, 'hooks', JSON.stringify({ agentName: 'claude-code-otlp', hookEvent: JSON.stringify(hook) }) + '\n', ['native-project']);

      await forwardSession(NATIVE, true, credentials as never);

      const requests = sentRequests();
      expect(requests).toHaveLength(1);
      expect(fundingHeaders(requests[0].headers)).toEqual({ 'X-CodeMie-Project': 'native-project' });
    });
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
