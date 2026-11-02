/**
 * Managed Copilot CLI analytics: deterministic native-session pinning (--session-id), no
 * heuristic correlation, and idempotent MetricsWriter deltas across retries and the
 * completed_ rename.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotCliSessionAdapter } from '../copilot-cli.session.js';
import { CopilotCliPluginMetadata } from '../copilot-cli.plugin.js';
import type { AgentConfig } from '../../../core/types.js';

const processEventMock = vi.fn();
vi.mock('../../../../cli/commands/hook.js', () => ({ processEvent: (...a: unknown[]) => processEventMock(...a) }));
vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

let copilotHome: string;
let codemieHome: string;
let cwd: string;
const saved = {
  codemieHome: process.env.CODEMIE_HOME,
  sessionId: process.env.CODEMIE_SESSION_ID,
  pinned: process.env.CODEMIE_COPILOT_NATIVE_SESSION_ID,
};

const T0 = Date.parse('2026-10-24T10:00:00.000Z');
const iso = (ms: number): string => new Date(T0 + ms).toISOString();

type Ev = Record<string, unknown>;
const start = (id: string, at = 0): Ev => ({
  type: 'session.start', timestamp: iso(at),
  data: { sessionId: id, copilotVersion: '1.0.103', startTime: iso(at), context: { cwd, gitRoot: cwd, branch: 'main' } },
});
const user = (at: number): Ev => ({ type: 'user.message', timestamp: iso(at), data: { text: 'prompt' } });
const assistant = (at: number): Ev => ({ type: 'assistant.message', timestamp: iso(at), data: { model: 'gpt-5.4', outputTokens: 5 } });
const toolStart = (id: string, at: number): Ev => ({ type: 'tool.execution_start', timestamp: iso(at), data: { toolCallId: id, toolName: 'view', arguments: { path: '/x.ts' } } });
const toolDone = (id: string, at: number): Ev => ({ type: 'tool.execution_complete', timestamp: iso(at), data: { toolCallId: id, success: true } });

function writeNative(id: string, events: Ev[], sessionCwd = cwd): string {
  const dir = join(copilotHome, 'session-state', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'workspace.yaml'), [`id: ${id}`, `cwd: ${sessionCwd}`, `git_root: ${sessionCwd}`, 'branch: main', `created_at: ${iso(0)}`, `updated_at: ${iso(1)}`].join('\n'));
  const file = join(dir, 'events.jsonl');
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

function writeRecord(id: string): void {
  mkdirSync(join(codemieHome, 'sessions'), { recursive: true });
  writeFileSync(
    join(codemieHome, 'sessions', `${id}.json`),
    JSON.stringify({ sessionId: id, agentName: 'copilot-cli', provider: 'ai-run-sso', workingDirectory: cwd, startTime: T0, status: 'active',
      correlation: { status: 'matched', agentSessionId: id, agentSessionFile: '', retryCount: 0 } })
  );
}

const readRecord = (id: string) =>
  JSON.parse(readFileSync(join(codemieHome, 'sessions', `${id}.json`), 'utf-8')) as { correlation: { agentSessionFile: string; agentSessionId: string } };

const lifecycle = CopilotCliPluginMetadata.lifecycle!;
const config = {} as AgentConfig;

/** Launch args as `BaseAgentAdapter` would hand them over: CODEMIE_SESSION_ID is in process.env. */
function launch(id: string, args: string[] = []): string[] {
  process.env.CODEMIE_SESSION_ID = id;
  return lifecycle.enrichArgs!(args, config);
}

async function endSession(id: string, copilotHomeEnv = copilotHome): Promise<void> {
  await lifecycle.onSessionEnd!(0, { CODEMIE_SESSION_ID: id, COPILOT_HOME: copilotHomeEnv });
}

beforeEach(() => {
  copilotHome = mkdtempSync(join(tmpdir(), 'copilot-an-home-'));
  codemieHome = mkdtempSync(join(tmpdir(), 'copilot-an-codemie-'));
  cwd = mkdtempSync(join(tmpdir(), 'copilot-an-cwd-'));
  process.env.COPILOT_HOME = copilotHome;
  process.env.CODEMIE_HOME = codemieHome;
  processEventMock.mockReset();
});

afterEach(() => {
  delete process.env.COPILOT_HOME;
  for (const [key, value] of [['CODEMIE_HOME', saved.codemieHome], ['CODEMIE_SESSION_ID', saved.sessionId], ['CODEMIE_COPILOT_NATIVE_SESSION_ID', saved.pinned]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const d of [copilotHome, codemieHome, cwd]) rmSync(d, { recursive: true, force: true });
});

describe('copilot-cli launch args (--session-id pinning)', () => {
  it('pins the native session UUID to the CodeMie session id', () => {
    expect(launch('11111111-1111-4111-8111-111111111111', ['--model', 'm'])).toEqual([
      '--model', 'm', '--session-id', '11111111-1111-4111-8111-111111111111',
    ]);
  });

  it.each([['--resume'], ['--resume=abc'], ['-r'], ['--continue'], ['--session-id'], ['--session-id=abc'], ['--connect']])(
    'leaves a user-selected session alone (%s)',
    (flag) => {
      const args = launch('22222222-2222-4222-8222-222222222222', [flag, '--model', 'm']);
      expect(args.filter((a) => a === '--session-id' || a.startsWith('--session-id=')).length).toBe(flag.startsWith('--session-id') ? 1 : 0);
      expect(process.env.CODEMIE_COPILOT_NATIVE_SESSION_ID).toBeUndefined();
    }
  );
});

describe('copilot-cli SessionEnd correlation', () => {
  it('gives two concurrent managed sessions in one cwd their own native session, ignoring a newer standalone one', async () => {
    const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const fileA = writeNative(a, [start(a), user(100), assistant(200)]);
    const fileB = writeNative(b, [start(b, 50), user(150), assistant(250)]);
    const standalone = writeNative('standalone-1', [start('standalone-1', 300), user(400), assistant(500)]);
    writeRecord(a);
    writeRecord(b);

    launch(a);
    await endSession(a);
    launch(b);
    await endSession(b);

    expect(readRecord(a).correlation.agentSessionFile).toBe(fileA);
    expect(readRecord(b).correlation.agentSessionFile).toBe(fileB);
    expect(readRecord(a).correlation.agentSessionFile).not.toBe(standalone);
    const transcripts = processEventMock.mock.calls.map(([event]) => (event as { transcript_path: string }).transcript_path);
    expect(transcripts).toEqual([fileA, fileB]);
  });

  it('claims nothing when the managed launch produced no native session, even if a standalone one exists', async () => {
    const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    writeNative('standalone-1', [start('standalone-1', 10), user(20), assistant(30)]);
    writeRecord(id);

    launch(id);
    await endSession(id);

    expect(readRecord(id).correlation.agentSessionFile).toBe('');
    expect((processEventMock.mock.calls[0][0] as { transcript_path: string }).transcript_path).toBe('');
  });

  it('claims nothing when the user selected their own session (no pinned id)', async () => {
    const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    writeNative(id, [start(id), user(10), assistant(20)]);
    writeRecord(id);

    launch(id, ['--resume']);
    await endSession(id);

    expect(readRecord(id).correlation.agentSessionFile).toBe('');
  });

  it('reads the native transcript from a custom COPILOT_HOME given in the launch env', async () => {
    const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const custom = mkdtempSync(join(tmpdir(), 'copilot-custom-home-'));
    try {
      const dir = join(custom, 'session-state', id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'events.jsonl'), JSON.stringify(start(id)) + '\n');
      writeRecord(id);

      launch(id);
      await endSession(id, custom);

      expect(readRecord(id).correlation.agentSessionFile).toBe(join(dir, 'events.jsonl'));
    } finally {
      rmSync(custom, { recursive: true, force: true });
    }
  });
});

describe('CopilotCliMetricsProcessor', () => {
  const sid = 'codemie-1';
  const ctx = { apiBaseUrl: '', cookies: '', clientType: 'codemie-copilot', version: '1', dryRun: false, sessionId: sid, agentSessionId: sid };
  const run = (file: string) => new CopilotCliSessionAdapter(CopilotCliPluginMetadata).processSession(file, sid, ctx);
  const sessionsDir = () => join(codemieHome, 'sessions');
  const read = (name: string) =>
    readFileSync(join(sessionsDir(), name), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { recordId: string; tools?: Record<string, number> });
  const toolTotal = (rows: Array<{ tools?: Record<string, number> }>) => rows.reduce((n, r) => n + (r.tools?.view ?? 0), 0);

  it('writes nothing for a zero-turn session and one delta per real assistant turn otherwise', async () => {
    const empty = writeNative('empty', [start('empty'), user(10)]);
    await run(empty);
    expect(readdirSync(codemieHome).includes('sessions') ? readdirSync(sessionsDir()).filter((f) => f.endsWith('_metrics.jsonl')) : []).toEqual([]);

    const file = writeNative('two-turns', [start('two-turns'), user(10), assistant(20), user(30), assistant(40)]);
    await run(file);
    expect(read(`${sid}_metrics.jsonl`)).toHaveLength(2);
  });

  it('counts tool calls once and still records a no-tool session', async () => {
    const file = writeNative('n1', [start('n1'), user(10), assistant(20), toolStart('c1', 30), toolDone('c1', 40), user(50), assistant(60)]);
    await run(file);
    await run(file);
    const rows = read(`${sid}_metrics.jsonl`);
    expect(rows).toHaveLength(2);
    expect(toolTotal(rows)).toBe(1);
  });

  it('does not duplicate when SessionEnd runs again after the completed_ rename', async () => {
    const file = writeNative('n1', [start('n1'), user(10), assistant(20), toolStart('c1', 30), toolDone('c1', 40)]);
    await run(file);
    renameSync(join(sessionsDir(), `${sid}_metrics.jsonl`), join(sessionsDir(), `completed_${sid}_metrics.jsonl`));
    await run(file);

    expect(readdirSync(sessionsDir()).filter((f) => f.endsWith('_metrics.jsonl'))).toEqual([`completed_${sid}_metrics.jsonl`]);
    const rows = read(`completed_${sid}_metrics.jsonl`);
    expect(rows).toHaveLength(1);
    expect(toolTotal(rows)).toBe(1);
  });

  it('keeps tool results that arrive after their turn was written, without duplicating them', async () => {
    const turn1 = [start('n1'), user(10), assistant(20), toolStart('c1', 30)];
    const file = writeNative('n1', turn1);
    await run(file);
    expect(toolTotal(read(`${sid}_metrics.jsonl`))).toBe(0);

    writeNative('n1', [...turn1, toolDone('c1', 40), user(50), assistant(60), toolStart('c2', 70), toolDone('c2', 80)]);
    await run(file);
    await run(file);
    const rows = read(`${sid}_metrics.jsonl`);
    expect(rows).toHaveLength(2);
    expect(toolTotal(rows)).toBe(2);
  });

  it('keeps a late tool result with no new turn as one identified supplement delta', async () => {
    const base = [start('n1'), user(10), assistant(20), toolStart('c1', 30)];
    const file = writeNative('n1', base);
    await run(file);
    writeNative('n1', [...base, toolDone('c1', 40)]);
    await run(file);
    await run(file);
    const rows = read(`${sid}_metrics.jsonl`);
    expect(rows.map((r) => r.recordId)).toEqual([`${sid}-turn-0`, `${sid}-supplement-1`]);
    expect(toolTotal(rows)).toBe(1);
  });
});
