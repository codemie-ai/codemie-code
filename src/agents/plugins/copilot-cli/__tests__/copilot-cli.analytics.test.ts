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
const resume = (at: number): Ev => ({ type: 'session.resume', timestamp: iso(at), data: { resumeTime: iso(at), context: { cwd, gitRoot: cwd, branch: 'main' } } });

// Probe-shaped events of copilot 1.0.105: per-request usage records and per-call tool telemetry
const MODEL = 'gpt-5.5-2026-04-24';
const prompt = (at: number, text: string): Ev => ({ type: 'user.message', timestamp: iso(at), data: { text } });
const reply = (at: number, outputTokens?: number): Ev => ({ type: 'assistant.message', timestamp: iso(at), data: { model: MODEL, outputTokens } });
const usageRecord = (at: number, inputTokens: number, outputTokens: number): Ev => ({
  type: 'session.usage_record', timestamp: iso(at),
  data: { usage: { model: MODEL, inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, initiator: 'user' } },
});
const viewCall = (id: string, at: number): Ev[] => [
  toolStart(id, at),
  { type: 'tool.execution_complete', timestamp: iso(at + 10), data: { toolCallId: id, success: true,
    toolTelemetry: { properties: { command: 'view' }, restrictedProperties: {}, metrics: { resultLength: 16 } } } },
];
const patchCall = (id: string, at: number, patch: string, files: string[], added: string[], linesAdded: number): Ev[] => [
  { type: 'tool.execution_start', timestamp: iso(at), data: { toolCallId: id, toolName: 'apply_patch', arguments: patch } },
  { type: 'tool.execution_complete', timestamp: iso(at + 10), data: { toolCallId: id, success: true, toolTelemetry: {
    restrictedProperties: { filePaths: JSON.stringify(files), movedFromPaths: '[]', addedPaths: JSON.stringify(added), deletedPaths: '[]' },
    metrics: { linesAdded, linesRemoved: 0 },
  } } },
];
const shutdown = (at: number, data: Record<string, unknown>): Ev => ({ type: 'session.shutdown', timestamp: iso(at), data });

/** Run A (T0+0 … T0+330) killed after its apply_patch; run C resumes the session at T0+1000 and shuts it down. */
function killResumeEvents(native: string, x: string): Ev[] {
  return [
    start(native, 0), prompt(100, 'first ALPHA'), usageRecord(200, 100, 10), reply(210), ...viewCall('a1', 220),
    usageRecord(300, 200, 20), reply(310), ...patchCall('a2', 320, '*** Begin Patch\n*** Add File: x.txt\n+ALPHA\n*** End Patch\n', [x], [x], 2),
    resume(1000), prompt(1100, 'second BRAVO'), usageRecord(1200, 300, 30), reply(1210), ...viewCall('c1', 1220),
    usageRecord(1300, 400, 40), reply(1310), ...patchCall('c2', 1320, '*** Begin Patch\n*** Update File: x.txt\n@@\n ALPHA\n+BRAVO\n*** End Patch\n', [x], [], 1),
    usageRecord(1400, 500, 50), reply(1410),
    shutdown(1500, { shutdownType: 'routine', totalPremiumRequests: 3, codeChanges: { linesAdded: 3, linesRemoved: 0, filesModified: [x] },
      modelMetrics: { [MODEL]: { requests: { count: 5 }, usage: { inputTokens: 1500, outputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } } }),
  ];
}

function writeNative(id: string, events: Ev[], sessionCwd = cwd): string {
  const dir = join(copilotHome, 'session-state', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'workspace.yaml'), [`id: ${id}`, `cwd: ${sessionCwd}`, `git_root: ${sessionCwd}`, 'branch: main', `created_at: ${iso(0)}`, `updated_at: ${iso(1)}`].join('\n'));
  const file = join(dir, 'events.jsonl');
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

/** A live record as SessionStart writes it: `agentSessionId` is the id the run goes under. */
function writeRecord(id: string, agentSessionId = id, startTime = T0): void {
  mkdirSync(join(codemieHome, 'sessions'), { recursive: true });
  writeFileSync(
    join(codemieHome, 'sessions', `${id}.json`),
    JSON.stringify({ sessionId: id, agentName: 'copilot-cli', provider: 'ai-run-sso', workingDirectory: cwd, startTime, status: 'active',
      correlation: { status: 'matched', agentSessionId, agentSessionFile: '', retryCount: 0 } })
  );
}

const readRecord = (id: string) =>
  JSON.parse(readFileSync(join(codemieHome, 'sessions', `${id}.json`), 'utf-8')) as {
    correlation: { status: string; agentSessionFile?: string; agentSessionId: string };
  };

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

describe('copilot-cli SessionStart', () => {
  const resumedNative = '99999999-9999-4999-8999-999999999999';

  it.each([
    ['--resume <uuid> / -r <uuid> / --session-id <uuid>', resumedNative, resumedNative],
    ['--resume <upper-case uuid>', 'ABCDEF01-ABCD-4ABC-8ABC-ABCDEF012345', 'abcdef01-abcd-4abc-8abc-abcdef012345'],
    ['--continue (no session named)', '', 'sid-run'],
    ['--resume <id prefix>', '99999999', 'sid-run'],
    ['--resume <session name>', 'my-session', 'sid-run'],
  ])('the run goes under the resumed native id only on a full UUID: %s', async (_form, resumeId, expected) => {
    await lifecycle.onSessionStart!('sid-run', { CODEMIE_RESUME_SESSION_ID: resumeId });

    expect((processEventMock.mock.calls[0][0] as { session_id: string }).session_id).toBe(expected);
    expect((processEventMock.mock.calls[0][1] as { sessionId: string }).sessionId).toBe('sid-run');
  });

  it('hands processEvent the wrapper owner from the env, so the record stores it', async () => {
    await lifecycle.onSessionStart!('sid-owner', { CODEMIE_WRAPPER_PID: '4242', CODEMIE_WRAPPER_STARTED_AT: '1790000000000' });

    expect(processEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ hook_event_name: 'SessionStart' }),
      expect.objectContaining({ ownerPid: 4242, ownerStartedAt: 1_790_000_000_000 }),
    );
  });
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

  it('claims nothing when the managed launch produced no native session, even if a standalone one exists: not correlated', async () => {
    const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    writeNative('standalone-1', [start('standalone-1', 10), user(20), assistant(30)]);
    writeRecord(id);

    launch(id);
    await endSession(id);

    expect(readRecord(id).correlation.status).toBe('failed');
    expect(readRecord(id).correlation.agentSessionFile).toBeUndefined();
    expect((processEventMock.mock.calls[0][0] as { transcript_path: string }).transcript_path).toBe('');
  });

  it('a run resumed by its full native id reads that session\'s transcript and ends under that id', async () => {
    const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const resumed = 'abababab-abab-4bab-8bab-abababababab';
    const file = writeNative(resumed, [start(resumed, -5000), user(-4000), assistant(-3000), resume(100), user(200), assistant(300)]);
    writeRecord(id, resumed);

    launch(id, ['--resume', resumed]);
    await endSession(id);

    expect(readRecord(id).correlation).toMatchObject({ status: 'matched', agentSessionId: resumed, agentSessionFile: file });
    expect(processEventMock.mock.calls[0][0]).toMatchObject({ session_id: resumed, transcript_path: file });
  });

  it('a run resumed by a full native id with no transcript of it is not correlated', async () => {
    const id = 'dededede-dede-4ede-8ede-dededededede';
    const resumed = 'acacacac-acac-4cac-8cac-acacacacacac';
    writeNative('other-1', [start('other-1', 10), user(20), assistant(30)]);
    writeRecord(id, resumed);

    launch(id, ['--resume', resumed]);
    await endSession(id);

    expect(readRecord(id).correlation.status).toBe('failed');
    expect(readRecord(id).correlation.agentSessionFile).toBeUndefined();
    expect(readRecord(id).correlation.agentSessionId).toBe(id);
    expect(processEventMock.mock.calls[0][0]).toMatchObject({ session_id: resumed, transcript_path: '' });
  });

  it.each([[['--continue']], [['--resume', 'abababab']]])(
    'a session the wrapper cannot name (%j) is located by the run window and the run stays under its CodeMie id',
    async (args) => {
      const id = 'dfdfdfdf-dfdf-4fdf-8fdf-dfdfdfdfdfdf';
      const native = 'adadadad-adad-4dad-8dad-adadadadadad';
      const file = writeNative(native, [start(native, -5000), user(-4000), assistant(-3000), resume(100), user(200), assistant(300)]);
      writeRecord(id);

      launch(id, args);
      await endSession(id);

      expect(readRecord(id).correlation).toMatchObject({ status: 'matched', agentSessionId: id, agentSessionFile: file });
      expect(processEventMock.mock.calls[0][0]).toMatchObject({ session_id: id, transcript_path: file });
    }
  );

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

  // The live record: a metrics file is created only while it exists
  beforeEach(() => {
    mkdirSync(sessionsDir(), { recursive: true });
    writeFileSync(join(sessionsDir(), `${sid}.json`), JSON.stringify({ sessionId: sid, startTime: 0 }));
  });

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

  it('drops the write when SessionEnd runs again after the completed_ rename', async () => {
    const file = writeNative('n1', [start('n1'), user(10), assistant(20), toolStart('c1', 30), toolDone('c1', 40)]);
    await run(file);
    renameSync(join(sessionsDir(), `${sid}_metrics.jsonl`), join(sessionsDir(), `completed_${sid}_metrics.jsonl`));
    renameSync(join(sessionsDir(), `${sid}.json`), join(sessionsDir(), `completed_${sid}.json`));
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

  it('writes a turn before recordsBeforeMs, none at it: the next record over the same transcript owns it', async () => {
    const file = writeNative('n1', [start('n1'), user(10), assistant(20), user(30), assistant(40)]);
    await new CopilotCliSessionAdapter(CopilotCliPluginMetadata).processSession(file, sid, { ...ctx, recordsBeforeMs: T0 + 40 });

    expect(read(`${sid}_metrics.jsonl`).map((r) => r.recordId)).toEqual([`${sid}-turn-0`]);
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

describe('copilot-cli runs over one resumed native session', () => {
  const native = 'a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0';
  const runA = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
  const runC = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
  const adapter = () => new CopilotCliSessionAdapter(CopilotCliPluginMetadata);
  const ctx = (id: string) => ({ apiBaseUrl: '', cookies: '', clientType: 'codemie-copilot', version: '1', dryRun: false, sessionId: id, agentSessionId: native });
  const usageRows = (messages: unknown[]) => (messages as Array<{ usage?: unknown }>).filter((m) => m.usage);
  const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 });

  interface Row { tools?: Record<string, number>; fileOperations?: unknown[]; userPrompts?: unknown[] }
  const rowsOf = (id: string): Row[] =>
    readFileSync(join(codemieHome, 'sessions', `${id}_metrics.jsonl`), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Row);
  const sum = (rows: Row[]) => ({
    tools: rows.reduce<Record<string, number>>((all, r) => {
      for (const [k, n] of Object.entries(r.tools ?? {})) all[k] = (all[k] ?? 0) + n;
      return all;
    }, {}),
    fileOperations: rows.flatMap((r) => r.fileOperations ?? []),
    userPrompts: rows.flatMap((r) => r.userPrompts ?? []),
  });

  it('each run writes only its own window: A its tools, +2 lines and prompt; C its own, the cumulative shutdown leaking nothing of A', async () => {
    const x = join(cwd, 'x.txt');
    const file = writeNative(native, killResumeEvents(native, x));
    writeRecord(runA, native, T0 - 50);
    writeRecord(runC, native, T0 + 900);

    await adapter().processSession(file, runA, ctx(runA));
    await adapter().processSession(file, runC, ctx(runC));

    expect(rowsOf(runA)).toHaveLength(2);
    expect(sum(rowsOf(runA))).toEqual({
      tools: { view: 1, apply_patch: 1 },
      fileOperations: [{ type: 'write', path: x, linesAdded: 2, linesRemoved: 0 }],
      userPrompts: [{ count: 1, text: 'first ALPHA' }],
    });
    expect(rowsOf(runC)).toHaveLength(3);
    expect(sum(rowsOf(runC))).toEqual({
      tools: { view: 1, apply_patch: 1 },
      fileOperations: [{ type: 'edit', path: x, linesAdded: 1, linesRemoved: 0 }],
      userPrompts: [{ count: 1, text: 'second BRAVO' }],
    });
  });

  it('tokens and requests come from the usage records inside each run window; a resumed run carries no premium requests', async () => {
    const file = writeNative(native, killResumeEvents(native, join(cwd, 'x.txt')));

    const a = await adapter().parseSessionFile(file, runA, undefined, { startTime: T0 - 50, upperBound: T0 + 900 });
    const c = await adapter().parseSessionFile(file, runC, undefined, { startTime: T0 + 900 });

    expect(usageRows(a.messages)).toEqual([{ model: MODEL, usage: usage(300, 30), requests: 2 }]);
    expect(usageRows(c.messages)).toEqual([{ model: MODEL, usage: usage(1200, 120), requests: 3 }]);
    expect(c.usageMeta?.premiumRequests).toBeUndefined();
  });

  it('a fresh session (started inside the run) carries the premium requests of its rollup', async () => {
    const file = writeNative(native, [start(native, 0), prompt(100, 'p'), usageRecord(200, 100, 10), reply(210),
      shutdown(500, { totalPremiumRequests: 4, modelMetrics: { [MODEL]: { requests: { count: 1 }, usage: usage(100, 10) } } })]);

    const parsed = await adapter().parseSessionFile(file, runA, undefined, { startTime: T0 - 50 });

    expect(parsed.usageMeta?.premiumRequests).toBe(4);
  });

  it('a resumed run window with no usage record carries no tokens', async () => {
    const file = writeNative(native, [start(native, 0), prompt(100, 'p'), reply(210, 10),
      shutdown(500, { totalPremiumRequests: 1, modelMetrics: { [MODEL]: { requests: { count: 1 }, usage: usage(100, 10) } } }),
      resume(1000), prompt(1100, 'q'), reply(1210, 5)]);

    const parsed = await adapter().parseSessionFile(file, runC, undefined, { startTime: T0 + 900 });

    expect(usageRows(parsed.messages)).toEqual([]);
    expect(parsed.usageMeta?.usageUnavailableReason).toBeTruthy();
  });

  it('two apply_patch calls to one path are two file operations, each with its own lines', async () => {
    const x = join(cwd, 'x.txt');
    const parsed = await adapter().parseSessionFile(writeNative(native, killResumeEvents(native, x)), runA);

    expect(parsed.metrics?.fileOperations).toEqual([
      { type: 'write', path: x, linesAdded: 2, linesRemoved: 0 },
      { type: 'edit', path: x, linesAdded: 1, linesRemoved: 0 },
    ]);
  });

  it('a multi-file apply_patch puts its lines on its first file; the others are operations without lines', async () => {
    const [x, y] = [join(cwd, 'x.txt'), join(cwd, 'y.txt')];
    const patch = '*** Begin Patch\n*** Update File: x.txt\n+a\n*** Add File: y.txt\n+b\n+c\n*** End Patch\n';
    const file = writeNative(native, [start(native, 0), prompt(100, 'p'), reply(210), ...patchCall('m1', 220, patch, [x, y], [y], 3)]);

    const parsed = await adapter().parseSessionFile(file, runA);

    expect(parsed.metrics?.fileOperations).toEqual([
      { type: 'edit', path: x, linesAdded: 3, linesRemoved: 0 },
      { type: 'write', path: y },
    ]);
  });

  it('a run with no live and no completed_ record still runs the conversation; only the metrics processor fails', async () => {
    const file = writeNative(native, [start(native, 0), prompt(100, 'p'), reply(210)]);

    const result = await adapter().processSession(file, runA, ctx(runA));

    expect(result.failedProcessors).toEqual(['copilot-cli-metrics']);
    expect(Object.keys(result.processors)).toContain('copilot-cli-conversations');
  });

  it('a create call whose telemetry names only filePaths is a write', async () => {
    const x = join(cwd, 'x.txt');
    const file = writeNative(native, [start(native, 0), prompt(100, 'p'), reply(210),
      { type: 'tool.execution_start', timestamp: iso(220), data: { toolCallId: 'k1', toolName: 'create', arguments: { path: x } } },
      { type: 'tool.execution_complete', timestamp: iso(230), data: { toolCallId: 'k1', success: true,
        toolTelemetry: { restrictedProperties: { filePaths: JSON.stringify([x]) } } } }]);

    const parsed = await adapter().parseSessionFile(file, runA);

    expect(parsed.metrics?.fileOperations).toEqual([{ type: 'write', path: x }]);
  });

  it('an older build\'s apply_patch on a relative path and the shutdown listing it are one operation on the absolute path', async () => {
    const x = join(cwd, 'x.txt');
    const file = writeNative(native, [start(native, 0), prompt(100, 'p'), reply(210),
      { type: 'tool.execution_start', timestamp: iso(220), data: { toolCallId: 'o1', toolName: 'apply_patch', arguments: '*** Begin Patch\n*** Add File: x.txt\n+a\n*** End Patch\n' } },
      { type: 'tool.execution_complete', timestamp: iso(230), data: { toolCallId: 'o1', success: true } },
      shutdown(500, { codeChanges: { linesAdded: 1, linesRemoved: 0, filesModified: [x] } })]);

    const parsed = await adapter().parseSessionFile(file, runA);

    expect(parsed.metrics?.fileOperations).toEqual([{ type: 'write', path: x, linesAdded: 1, linesRemoved: 0 }]);
  });

  const deletePatch = '*** Begin Patch\n*** Delete File: x.txt\n*** End Patch\n';

  it('a call whose telemetry lists a path as deleted is a delete', async () => {
    const x = join(cwd, 'x.txt');
    const file = writeNative(native, [start(native, 0), prompt(100, 'p'), reply(210),
      { type: 'tool.execution_start', timestamp: iso(220), data: { toolCallId: 'd1', toolName: 'apply_patch', arguments: deletePatch } },
      { type: 'tool.execution_complete', timestamp: iso(230), data: { toolCallId: 'd1', success: true,
        toolTelemetry: { restrictedProperties: { filePaths: JSON.stringify([x]), addedPaths: '[]', deletedPaths: JSON.stringify([x]) } } } }]);

    const parsed = await adapter().parseSessionFile(file, runA);

    expect(parsed.metrics?.fileOperations).toEqual([{ type: 'delete', path: x }]);
  });

  it('an apply_patch with no telemetry and a Delete File header is a delete of the absolute path', async () => {
    const file = writeNative(native, [start(native, 0), prompt(100, 'p'), reply(210),
      { type: 'tool.execution_start', timestamp: iso(220), data: { toolCallId: 'd2', toolName: 'apply_patch', arguments: deletePatch } },
      { type: 'tool.execution_complete', timestamp: iso(230), data: { toolCallId: 'd2', success: true } }]);

    const parsed = await adapter().parseSessionFile(file, runA);

    expect(parsed.metrics?.fileOperations).toEqual([{ type: 'delete', path: join(cwd, 'x.txt') }]);
  });

  it('each bounded run counts only the skills invoked inside its window', async () => {
    const skill = (at: number, name: string): Ev => ({ type: 'skill.invoked', timestamp: iso(at), data: { skill: name } });
    const events = [...killResumeEvents(native, join(cwd, 'x.txt')), skill(150, 'skill-a'), skill(1150, 'skill-c')]
      .sort((l, r) => Date.parse(l.timestamp as string) - Date.parse(r.timestamp as string));
    const file = writeNative(native, events);

    const a = await adapter().parseSessionFile(file, runA, undefined, { startTime: T0 - 50, upperBound: T0 + 900 });
    const c = await adapter().parseSessionFile(file, runC, undefined, { startTime: T0 + 900 });

    expect(a.metrics?.skillInvocations).toEqual({ 'skill-a': 1 });
    expect(c.metrics?.skillInvocations).toEqual({ 'skill-c': 1 });
  });

  it('a resumed run with no per-call lines takes the shutdown lines and files beyond the prior shutdown', async () => {
    const [x, y] = [join(cwd, 'x.txt'), join(cwd, 'y.txt')];
    const file = writeNative(native, [start(native, 0), prompt(100, 'p'), reply(210),
      shutdown(500, { codeChanges: { linesAdded: 2, filesModified: [x] } }),
      resume(1000), prompt(1100, 'q'), reply(1210),
      shutdown(1500, { codeChanges: { linesAdded: 5, filesModified: [x, y] } })]);

    const c = await adapter().parseSessionFile(file, runC, undefined, { startTime: T0 + 900 });

    expect(c.metrics?.fileOperations).toEqual([{ type: 'edit', path: y, linesAdded: 3, linesRemoved: 0 }]);
  });
});
