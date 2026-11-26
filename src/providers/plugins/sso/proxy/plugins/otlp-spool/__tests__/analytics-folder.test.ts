/**
 * The move of the local mode into the analytics folder: what lands there, a move cut and repeated, the grace, the
 * exclusion mark, and that a hook is never kept waiting by a copy.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type FsCall = { fn: 'appendFile' | 'truncate' | 'unlink'; path: string; data?: string };
const fsCalls: FsCall[] = [];
/** Runs before each recorded call reaches the file system; a throw fails that call. */
let beforeFsCall: ((call: FsCall) => Promise<void> | void) | undefined;

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const wrap = (fn: FsCall['fn']) =>
    async (...args: unknown[]) => {
      const call: FsCall = { fn, path: String(args[0]), ...(fn === 'appendFile' ? { data: String(args[1]) } : {}) };
      fsCalls.push(call);
      await beforeFsCall?.(call);
      return (real[fn] as (...a: unknown[]) => Promise<unknown>)(...args);
    };
  return { ...real, appendFile: wrap('appendFile'), truncate: wrap('truncate'), unlink: wrap('unlink') };
});

const MINUTE = 60_000;
let home: string;
let start: number;

async function modules() {
  const paths = await import('../spool-paths.js');
  const folderPaths = await import('../analytics-folder-paths.js');
  paths.useSpoolRoot(folderPaths.localSpoolRoot());
  return {
    ...paths,
    ...folderPaths,
    ...(await import('../analytics-folder.js')),
    ...(await import('../spool-io.js')),
    ...(await import('../session-status.js')),
    ...(await import('../analytics-exclusion-mark.js')),
  };
}

const spoolDir = () => join(home, 'analytics', 'spool');
const folderDir = () => join(home, 'analytics', 'sessions');
const hookLine = (event: Record<string, unknown>) => JSON.stringify({ agentName: 'claude-code-otlp', hookEvent: JSON.stringify(event) });
const LOGS = JSON.stringify({ resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [] }] });
const METRICS = JSON.stringify({ resourceMetrics: [{ resource: { attributes: [] }, scopeMetrics: [] }] });
const TRACES = JSON.stringify({ resourceSpans: [{ scopeSpans: [] }] });
/** A logs export other than `LOGS`. */
const LOGS_2 = JSON.stringify({ resourceLogs: [{ resource: { attributes: [{ key: 'n', value: { stringValue: '2' } }] }, scopeLogs: [] }] });

/** Every spool file of a session written at `start`, so a move's `nowMs` is the same in every home. */
function age(sessionId: string): void {
  for (const name of readdirSync(spoolDir())) {
    if (name.startsWith(sessionId + '.')) utimesSync(join(spoolDir(), name), start / 1000, start / 1000);
  }
}

async function writeSession(
  sessionId: string,
  parts: { hooks?: Record<string, unknown>[]; logs?: boolean; metrics?: boolean; traces?: boolean; bin?: boolean } = {}
): Promise<void> {
  const m = await modules();
  if (parts.hooks) await m.appendSpool(sessionId, 'hooks', parts.hooks.map((event) => hookLine(event) + '\n').join(''));
  if (parts.logs) await m.appendSpool(sessionId, 'logsJson', LOGS + '\n');
  if (parts.metrics) await m.appendSpool(sessionId, 'metricsJson', METRICS + '\n');
  if (parts.traces) await m.appendSpool(sessionId, 'tracesJson', TRACES + '\n');
  if (parts.bin) await m.appendSpool(sessionId, 'logs', Buffer.from([1, 2, 3]));
  age(sessionId);
}

const EVENTS = (sessionId: string) => [
  { type: 'agent.session.start', session_id: sessionId, event_id: 'e1', timestamp: '2026-11-25T10:00:00.000Z', user_email: 'a@b.c' },
  { type: 'agent.prompt.submit', session_id: sessionId, event_id: 'e2' },
];

const folderFiles = (): string[] => (existsSync(folderDir()) ? readdirSync(folderDir()).sort() : []);
const folderText = (name: string): string => readFileSync(join(folderDir(), name), 'utf-8');
const spoolFilesOf = (sessionId: string): string[] =>
  existsSync(spoolDir()) ? readdirSync(spoolDir()).filter((name) => name.startsWith(sessionId + '.')) : [];
const folderSnapshot = (): Record<string, string> => Object.fromEntries(folderFiles().map((name) => [name, folderText(name)]));

/** The line id of every resource of one folder line. */
function resourceIds(line: string): Array<string | undefined> {
  const parsed = JSON.parse(line) as Record<string, Array<{ resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> } }>>;
  return Object.values(parsed).flat().map((entry) => entry.resource.attributes.find((a) => a.key === 'codemie.line_id')?.value.stringValue);
}

/** The line id of each line of a folder file, in order; every resource of a line carries the same one. */
function lineIds(name: string): string[] {
  return folderText(name).split('\n').slice(0, -1).map((line) => {
    const ids = resourceIds(line);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(1);
    return String(ids[0]);
  });
}

const escaped = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every line of a folder file, each with a line id of the file's name and a hash, no two lines sharing one. */
function linesWithIds(name: string): Array<Record<string, unknown>> {
  const ids = lineIds(name);
  for (const id of ids) expect(id).toMatch(new RegExp(`^${escaped(name)}:[0-9a-f]{32}$`));
  expect(new Set(ids).size).toBe(ids.length);
  return folderText(name).split('\n').slice(0, -1).map((line) => JSON.parse(line) as Record<string, unknown>);
}

const eventIds = (name: string): string[] =>
  folderText(name)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const record = JSON.parse(line).resourceLogs[0].scopeLogs[0].logRecords[0];
      return String(record.attributes.find((a: { key: string }) => a.key === 'event_id')?.value.stringValue);
    });

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), 'analytics-folder-'));
  vi.stubEnv('CODEMIE_HOME', home);
  start = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(start);
  fsCalls.length = 0;
  beforeFsCall = undefined;
});

afterEach(async () => {
  vi.useRealTimers();
  await (await import('@/utils/logger.js')).logger.close();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const past = (minutes = 61) => vi.setSystemTime(start + minutes * MINUTE);

/** The folder of a clean move of the default session `s1`, made in a home of its own. */
async function cleanMove(): Promise<Record<string, string>> {
  const own = home;
  home = mkdtempSync(join(tmpdir(), 'analytics-folder-clean-'));
  vi.stubEnv('CODEMIE_HOME', home);
  vi.setSystemTime(start);
  await writeSession('s1', { hooks: EVENTS('s1'), logs: true, metrics: true, traces: true });
  past();
  await (await modules()).sweepToFolder();
  const snapshot = folderSnapshot();
  await (await import('@/utils/logger.js')).logger.close();
  rmSync(home, { recursive: true, force: true });
  home = own;
  vi.stubEnv('CODEMIE_HOME', home);
  vi.setSystemTime(start);
  return snapshot;
}

describe('sweepToFolder', () => {
  it('moves a session past its grace into four .jsonl files, every line with its own line id', async () => {
    await writeSession('s1', { hooks: EVENTS('s1'), logs: true, metrics: true, traces: true, bin: true });
    past();

    await (await modules()).sweepToFolder();

    expect(folderFiles()).toEqual(['s1.hooks.jsonl', 's1.otel_logs.jsonl', 's1.otel_metrics.jsonl', 's1.otel_traces.jsonl']);
    const hooks = linesWithIds('s1.hooks.jsonl') as Array<{ resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ eventName: string }> }> }> }>;
    expect(hooks.map((record) => record.resourceLogs[0].scopeLogs[0].logRecords[0].eventName)).toEqual(['agent.session.start', 'agent.prompt.submit']);
    for (const name of ['s1.otel_logs.jsonl', 's1.otel_metrics.jsonl', 's1.otel_traces.jsonl']) expect(linesWithIds(name)).toHaveLength(1);
    expect(spoolFilesOf('s1')).toEqual([]);
  });

  it('moves a snake_case telemetry line of a session with hook events, with its line id', async () => {
    const snake = JSON.stringify({ resource_logs: [{ resource: { attributes: [] }, scope_logs: [] }] });
    await (await modules()).appendSpool('s1', 'logsJson', snake + '\n');
    await writeSession('s1', { hooks: EVENTS('s1') });
    past();

    await (await modules()).sweepToFolder();

    const [line] = linesWithIds('s1.otel_logs.jsonl');
    expect(line).toHaveProperty('resource_logs');
  });

  it('a throw after the hooks append, then a second sweep → the files of a clean move, byte for byte', async () => {
    const clean = await cleanMove();
    await writeSession('s1', { hooks: EVENTS('s1'), logs: true, metrics: true, traces: true });
    past();
    let thrown = false;
    beforeFsCall = (call) => {
      if (!thrown && call.fn === 'appendFile' && call.path.endsWith('s1.otel_logs.jsonl')) {
        thrown = true;
        throw new Error('injected');
      }
    };
    const m = await modules();

    await m.sweepToFolder();
    expect(existsSync(join(folderDir(), 's1.moving'))).toBe(true);
    await m.sweepToFolder();

    expect(folderSnapshot()).toEqual(clean);
  });

  it('a throw after the cursors are written, then a second sweep → the same files, nothing doubled', async () => {
    const clean = await cleanMove();
    await writeSession('s1', { hooks: EVENTS('s1'), logs: true, metrics: true, traces: true });
    past();
    let thrown = false;
    beforeFsCall = (call) => {
      if (!thrown && call.fn === 'unlink' && call.path.endsWith('s1.moving')) {
        thrown = true;
        throw new Error('injected');
      }
    };
    const m = await modules();

    await m.sweepToFolder();
    await m.sweepToFolder();

    expect(folderSnapshot()).toEqual(clean);
    expect(spoolFilesOf('s1')).toEqual([]);
  });

  it('a hook appended while a chunk is pending is answered at once, kept, and moved by a later sweep once', async () => {
    await writeSession('s1', { hooks: EVENTS('s1') });
    past();
    const m = await modules();
    let appended = false;
    beforeFsCall = async (call) => {
      if (!appended && call.fn === 'appendFile' && call.path.endsWith('s1.hooks.jsonl')) {
        appended = true;
        // Resolves only if the copy holds no session lock.
        await m.appendSpool('s1', 'hooks', hookLine({ type: 'agent.session.stop', session_id: 's1', event_id: 'e3' }) + '\n');
      }
    };

    await m.sweepToFolder();
    expect(appended).toBe(true);
    expect(eventIds('s1.hooks.jsonl')).toEqual(['e1', 'e2']);
    expect(spoolFilesOf('s1')).toContain('s1.hooks.ndjson');

    beforeFsCall = undefined;
    age('s1');
    await m.sweepToFolder();
    await m.sweepToFolder();

    expect(eventIds('s1.hooks.jsonl')).toEqual(['e1', 'e2', 'e3']);
    linesWithIds('s1.hooks.jsonl');
    expect(spoolFilesOf('s1')).toEqual([]);
  });

  it('a session resumed after a move gets its new lines after the first, each with an id no earlier line has', async () => {
    await writeSession('s1', { hooks: EVENTS('s1'), logs: true });
    past();
    const m = await modules();
    await m.sweepToFolder();
    const firstHooks = folderText('s1.hooks.jsonl');
    const firstLogs = folderText('s1.otel_logs.jsonl');

    vi.setSystemTime(start);
    await writeSession('s1', { hooks: [{ type: 'agent.session.start', session_id: 's1', event_id: 'e9', source: 'resume' }] });
    await m.appendSpool('s1', 'logsJson', LOGS_2 + '\n');
    age('s1');
    past();
    await m.sweepToFolder();

    expect(eventIds('s1.hooks.jsonl')).toEqual(['e1', 'e2', 'e9']);
    expect(folderText('s1.hooks.jsonl').startsWith(firstHooks)).toBe(true);
    expect(folderText('s1.otel_logs.jsonl').startsWith(firstLogs)).toBe(true);
    linesWithIds('s1.hooks.jsonl');
    expect(linesWithIds('s1.otel_logs.jsonl')).toHaveLength(2);
  });

  it('a session moved, its folder files deleted, then resumed and moved again gets no id of the first move', async () => {
    await writeSession('s1', { hooks: EVENTS('s1'), logs: true });
    past();
    const m = await modules();
    await m.sweepToFolder();
    const names = ['s1.hooks.jsonl', 's1.otel_logs.jsonl'];
    const first = new Set(names.flatMap(lineIds));
    for (const name of folderFiles()) rmSync(join(folderDir(), name));

    vi.setSystemTime(start);
    await writeSession('s1', { hooks: [{ type: 'agent.prompt.submit', session_id: 's1', event_id: 'e9' }] });
    await m.appendSpool('s1', 'logsJson', LOGS_2 + '\n');
    age('s1');
    past();
    await m.sweepToFolder();

    const second = names.flatMap(lineIds);
    expect(second).toHaveLength(2);
    for (const id of second) expect(first.has(id)).toBe(false);
  });

  it('the same telemetry line spooled twice lands as two folder lines with one id', async () => {
    await writeSession('s1', { hooks: EVENTS('s1'), logs: true });
    const m = await modules();
    await m.appendSpool('s1', 'logsJson', LOGS + '\n');
    age('s1');
    past();

    await m.sweepToFolder();

    const ids = lineIds('s1.otel_logs.jsonl');
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it('a move resumed over folder lines with ids of another form leaves those bytes and gives its own lines the hash form', async () => {
    const { encodeHookRecord, addLineId } = await import('../hook-record-format.js');
    mkdirSync(folderDir(), { recursive: true });
    const oldHooks = encodeHookRecord({ type: 'agent.session.start', session_id: 's1', event_id: 'old1' }, { lineId: 's1.hooks.jsonl:0', nowMs: start }) + '\n';
    const oldLogs = addLineId(LOGS_2, 's1.otel_logs.jsonl:0') + '\n';
    writeFileSync(join(folderDir(), 's1.hooks.jsonl'), oldHooks);
    writeFileSync(join(folderDir(), 's1.otel_logs.jsonl'), oldLogs);
    await writeSession('s1', { hooks: EVENTS('s1'), logs: true });
    past();
    let thrown = false;
    beforeFsCall = (call) => {
      if (!thrown && call.fn === 'appendFile' && call.path.endsWith('s1.otel_logs.jsonl')) {
        thrown = true;
        throw new Error('injected');
      }
    };
    const m = await modules();

    await m.sweepToFolder();
    expect(existsSync(join(folderDir(), 's1.moving'))).toBe(true);
    await m.sweepToFolder();

    for (const [name, old] of [['s1.hooks.jsonl', oldHooks], ['s1.otel_logs.jsonl', oldLogs]] as const) {
      const text = folderText(name);
      expect(text.startsWith(old)).toBe(true);
      const added = text.slice(old.length).split('\n').slice(0, -1);
      expect(added.length).toBeGreaterThan(0);
      for (const line of added) {
        for (const id of resourceIds(line)) expect(id).toMatch(new RegExp(`^${escaped(name)}:[0-9a-f]{32}$`));
      }
    }
    expect(eventIds('s1.hooks.jsonl')).toEqual(['old1', 'e1', 'e2']);
  });

  it('writes an event_id once, never again after a resume; events with no event_id all', async () => {
    const usage = { type: 'agent.usage', session_id: 's1', event_id: 'u1' };
    await writeSession('s1', { hooks: [usage, usage, { type: 'a', session_id: 's1' }, { type: 'b', session_id: 's1' }] });
    past();
    const m = await modules();
    await m.sweepToFolder();

    vi.setSystemTime(start);
    await writeSession('s1', { hooks: [usage] });
    past();
    await m.sweepToFolder();

    expect(eventIds('s1.hooks.jsonl')).toEqual(['u1', 'undefined', 'undefined']);
  });

  it('a telemetry-only session is deleted with no folder file; with a hooks file in the folder its lines are appended', async () => {
    await writeSession('t1', { logs: true, bin: true });
    await writeSession('t2', { hooks: EVENTS('t2') });
    past();
    const m = await modules();
    await m.sweepToFolder();

    vi.setSystemTime(start);
    await writeSession('t2', { traces: true });
    past();
    await m.sweepToFolder();

    expect(folderFiles()).toEqual(['t2.hooks.jsonl', 't2.otel_traces.jsonl']);
    expect(spoolFilesOf('t1')).toEqual([]);
    expect(spoolFilesOf('t2')).toEqual([]);
  });

  it('an excluded session is dropped from the spool, its earlier folder files kept; its new telemetry dropped at the next sweep', async () => {
    await writeSession('x1', { hooks: EVENTS('x1') });
    past();
    const m = await modules();
    await m.sweepToFolder();
    const before = folderSnapshot();

    vi.setSystemTime(start);
    await writeSession('x1', { hooks: [{ type: 'agent.prompt.submit', session_id: 'x1', event_id: 'e5' }], logs: true });
    await m.markSessionExcluded('x1');
    past();
    await m.sweepToFolder();
    expect(spoolFilesOf('x1')).toEqual([]);
    expect(folderSnapshot()).toEqual(before);

    await m.appendSpool('x1', 'logsJson', LOGS + '\n');
    await m.sweepToFolder();
    expect(spoolFilesOf('x1')).toEqual([]);
    expect(folderSnapshot()).toEqual(before);
  });

  it('a move cut after its marker of a session excluded meanwhile → the folder at the marker\'s lengths, the spool and the marker gone', async () => {
    await writeSession('x2', { hooks: EVENTS('x2'), logs: true });
    past();
    const m = await modules();
    await m.sweepToFolder();
    const before = folderSnapshot();

    vi.setSystemTime(start);
    await writeSession('x2', { hooks: [{ type: 'agent.prompt.submit', session_id: 'x2', event_id: 'e7' }], logs: true });
    past();
    beforeFsCall = (call) => {
      if (call.fn === 'appendFile' && call.path.endsWith('x2.otel_logs.jsonl')) throw new Error('injected');
    };
    await m.sweepToFolder();
    expect(existsSync(join(folderDir(), 'x2.moving'))).toBe(true);
    expect(folderText('x2.hooks.jsonl')).not.toBe(before['x2.hooks.jsonl']);

    beforeFsCall = undefined;
    await m.markSessionExcluded('x2');
    await m.sweepToFolder();

    expect(folderSnapshot()).toEqual(before);
    expect(spoolFilesOf('x2')).toEqual([]);
    expect(existsSync(join(folderDir(), 'x2.moving'))).toBe(false);
  });

  it('the grace decides: an ended session after 15 minutes, another after 60 quiet minutes', async () => {
    const m = await modules();
    await writeSession('ended', { hooks: EVENTS('ended') });
    await writeSession('quiet', { hooks: EVENTS('quiet') });
    await m.markSessionEnded('ended');

    past(14);
    await m.sweepToFolder();
    expect(folderFiles()).toEqual([]);

    past(16);
    await m.sweepToFolder();
    expect(folderFiles()).toEqual(['ended.hooks.jsonl']);

    past(59);
    await m.sweepToFolder();
    expect(folderFiles()).toEqual(['ended.hooks.jsonl']);

    past(61);
    await m.sweepToFolder();
    expect(folderFiles()).toEqual(['ended.hooks.jsonl', 'quiet.hooks.jsonl']);
  });

  it('a marker whose spool files are gone → the folder cut to its lengths, the marker removed, no session created', async () => {
    const m = await modules();
    mkdirSync(folderDir(), { recursive: true });
    writeFileSync(join(folderDir(), 'g1.hooks.jsonl'), 'kept\nhalf-written');
    writeFileSync(join(folderDir(), 'g1.moving'), JSON.stringify({
      lengths: { 'g1.hooks.jsonl': 5, 'g1.otel_logs.jsonl': 0, 'g1.otel_metrics.jsonl': 0, 'g1.otel_traces.jsonl': 0 },
      from: { hooks: 0, logsJson: 0, metricsJson: 0, tracesJson: 0 },
      upto: { hooks: 10, logsJson: 0, metricsJson: 0, tracesJson: 0 },
      nowMs: start,
    }));

    await m.sweepToFolder();

    expect(folderFiles()).toEqual(['g1.hooks.jsonl']);
    expect(folderText('g1.hooks.jsonl')).toBe('kept\n');
    expect(spoolFilesOf('g1')).toEqual([]);
    expect(await m.readStatus('g1')).toBeNull();
  });

  it('resolveMarkers cuts the folder to every marker\'s lengths and removes the markers', async () => {
    const m = await modules();
    mkdirSync(folderDir(), { recursive: true });
    for (const id of ['r1', 'r2']) {
      writeFileSync(join(folderDir(), `${id}.otel_logs.jsonl`), 'line\nextra');
      writeFileSync(join(folderDir(), `${id}.moving`), JSON.stringify({
        lengths: { [`${id}.hooks.jsonl`]: 0, [`${id}.otel_logs.jsonl`]: 5, [`${id}.otel_metrics.jsonl`]: 0, [`${id}.otel_traces.jsonl`]: 0 },
        from: { hooks: 0, logsJson: 0, metricsJson: 0, tracesJson: 0 },
        upto: { hooks: 0, logsJson: 0, metricsJson: 0, tracesJson: 0 },
        nowMs: start,
      }));
    }

    await m.resolveMarkers();

    expect(folderFiles()).toEqual(['r1.otel_logs.jsonl', 'r2.otel_logs.jsonl']);
    expect(folderText('r1.otel_logs.jsonl')).toBe('line\n');
    expect(folderText('r2.otel_logs.jsonl')).toBe('line\n');
  });

  it('resolveMarkers leaves a folder file shorter than its marker\'s length, and one that is gone, as they are', async () => {
    const m = await modules();
    mkdirSync(folderDir(), { recursive: true });
    writeFileSync(join(folderDir(), 'c1.hooks.jsonl'), 'abc\n');
    for (const id of ['c1', 'c2']) {
      writeFileSync(join(folderDir(), `${id}.moving`), JSON.stringify({
        lengths: { [`${id}.hooks.jsonl`]: 10, [`${id}.otel_logs.jsonl`]: 0, [`${id}.otel_metrics.jsonl`]: 0, [`${id}.otel_traces.jsonl`]: 0 },
        from: { hooks: 0, logsJson: 0, metricsJson: 0, tracesJson: 0 },
        upto: { hooks: 0, logsJson: 0, metricsJson: 0, tracesJson: 0 },
        nowMs: start,
      }));
    }

    await m.resolveMarkers();

    expect(folderFiles()).toEqual(['c1.hooks.jsonl']);
    expect(readFileSync(join(folderDir(), 'c1.hooks.jsonl'))).toEqual(Buffer.from('abc\n'));
  });

  it('resolveMarkers removes a marker that is not JSON and goes on: the next marker\'s files cut, the other session\'s untouched', async () => {
    const m = await modules();
    mkdirSync(folderDir(), { recursive: true });
    writeFileSync(join(folderDir(), 'b1.moving'), '{ not json');
    writeFileSync(join(folderDir(), 'b1.otel_logs.jsonl'), 'line\nextra');
    writeFileSync(join(folderDir(), 'b2.otel_logs.jsonl'), 'line\nextra');
    writeFileSync(join(folderDir(), 'b2.moving'), JSON.stringify({
      lengths: { 'b2.hooks.jsonl': 0, 'b2.otel_logs.jsonl': 5, 'b2.otel_metrics.jsonl': 0, 'b2.otel_traces.jsonl': 0 },
      from: { hooks: 0, logsJson: 0, metricsJson: 0, tracesJson: 0 },
      upto: { hooks: 0, logsJson: 0, metricsJson: 0, tracesJson: 0 },
      nowMs: start,
    }));

    await m.resolveMarkers();

    expect(folderFiles()).toEqual(['b1.otel_logs.jsonl', 'b2.otel_logs.jsonl']);
    expect(folderText('b1.otel_logs.jsonl')).toBe('line\nextra');
    expect(folderText('b2.otel_logs.jsonl')).toBe('line\n');
  });

  it('resolveMarkers removes markers that hold null, {}, a negative length, a fractional or negative offset or no finite time and goes on: the valid marker\'s files cut, the others\' untouched', async () => {
    const m = await modules();
    mkdirSync(folderDir(), { recursive: true });
    writeFileSync(join(folderDir(), 'n1.moving'), 'null');
    writeFileSync(join(folderDir(), 'n2.moving'), '{}');
    for (const id of ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']) writeFileSync(join(folderDir(), `${id}.otel_logs.jsonl`), 'line\nextra');
    writeFileSync(join(folderDir(), 'n4.moving'), JSON.stringify({
      lengths: { 'n4.hooks.jsonl': 0, 'n4.otel_logs.jsonl': -1, 'n4.otel_metrics.jsonl': 0, 'n4.otel_traces.jsonl': 0 },
      from: { hooks: 0, logsJson: 0, metricsJson: 0, tracesJson: 0 },
      upto: { hooks: 0, logsJson: 0, metricsJson: 0, tracesJson: 0 },
      nowMs: start,
    }));
    writeFileSync(join(folderDir(), 'n5.moving'), JSON.stringify({
      lengths: { 'n5.hooks.jsonl': 0, 'n5.otel_logs.jsonl': 5, 'n5.otel_metrics.jsonl': 0, 'n5.otel_traces.jsonl': 0 },
      from: { hooks: 1.5, logsJson: 0, metricsJson: 0, tracesJson: 0 },
      upto: { hooks: 0, logsJson: 0, metricsJson: 0, tracesJson: 0 },
      nowMs: start,
    }));
    writeFileSync(join(folderDir(), 'n6.moving'), JSON.stringify({
      lengths: { 'n6.hooks.jsonl': 0, 'n6.otel_logs.jsonl': 5, 'n6.otel_metrics.jsonl': 0, 'n6.otel_traces.jsonl': 0 },
      from: { hooks: 0, logsJson: 0, metricsJson: 0, tracesJson: 0 },
      upto: { hooks: -1, logsJson: 0, metricsJson: 0, tracesJson: 0 },
      nowMs: start,
    }));
    // 1e400 parses to Infinity: a number, and no time.
    writeFileSync(join(folderDir(), 'n7.moving'), JSON.stringify({
      lengths: { 'n7.hooks.jsonl': 0, 'n7.otel_logs.jsonl': 5, 'n7.otel_metrics.jsonl': 0, 'n7.otel_traces.jsonl': 0 },
      from: { hooks: 0, logsJson: 0, metricsJson: 0, tracesJson: 0 },
      upto: { hooks: 0, logsJson: 0, metricsJson: 0, tracesJson: 0 },
      nowMs: 0,
    }).replace('"nowMs":0', '"nowMs":1e400'));
    writeFileSync(join(folderDir(), 'n3.moving'), JSON.stringify({
      lengths: { 'n3.hooks.jsonl': 0, 'n3.otel_logs.jsonl': 5, 'n3.otel_metrics.jsonl': 0, 'n3.otel_traces.jsonl': 0 },
      from: { hooks: 0, logsJson: 0, metricsJson: 0, tracesJson: 0 },
      upto: { hooks: 0, logsJson: 0, metricsJson: 0, tracesJson: 0 },
      nowMs: start,
    }));

    await m.resolveMarkers();

    expect(folderFiles()).toEqual([
      'n1.otel_logs.jsonl', 'n2.otel_logs.jsonl', 'n3.otel_logs.jsonl', 'n4.otel_logs.jsonl', 'n5.otel_logs.jsonl',
      'n6.otel_logs.jsonl', 'n7.otel_logs.jsonl',
    ]);
    for (const id of ['n1', 'n2', 'n4', 'n5', 'n6', 'n7']) expect(folderText(`${id}.otel_logs.jsonl`)).toBe('line\nextra');
    expect(folderText('n3.otel_logs.jsonl')).toBe('line\n');
  });

  it('a sweep keeps a session whose marker holds {} where it is, and moves another session past its grace', async () => {
    const m = await modules();
    await writeSession('bad', { hooks: EVENTS('bad'), logs: true });
    await writeSession('good', { hooks: EVENTS('good') });
    mkdirSync(folderDir(), { recursive: true });
    writeFileSync(join(folderDir(), 'bad.moving'), '{}');
    const spoolBefore = spoolFilesOf('bad').sort();
    past();

    await m.sweepToFolder();

    expect(folderFiles()).toEqual(['bad.moving', 'good.hooks.jsonl']);
    expect(folderText('bad.moving')).toBe('{}');
    expect(spoolFilesOf('bad').sort()).toEqual(spoolBefore);
    expect(spoolFilesOf('good')).toEqual([]);
  });

  it('the marker exists before the first truncate and append, and is removed after the status write', async () => {
    await writeSession('s1', { hooks: EVENTS('s1'), logs: true });
    past();
    const m = await modules();
    const seen: Array<{ fn: string; marker: boolean; cursors?: unknown }> = [];
    beforeFsCall = async (call) => {
      if (!call.path.startsWith(folderDir())) return;
      const marker = existsSync(join(folderDir(), 's1.moving'));
      const cursors = call.fn === 'unlink' ? (await m.readStatus('s1'))?.cursors : undefined;
      seen.push({ fn: call.fn, marker, ...(cursors ? { cursors } : {}) });
    };
    const hooksSize = statSync(join(spoolDir(), 's1.hooks.ndjson')).size;
    const logsSize = statSync(join(spoolDir(), 's1.otel_logs.ndjson')).size;

    await m.sweepToFolder();

    expect(seen.filter((call) => call.fn !== 'unlink').every((call) => call.marker)).toBe(true);
    // A first move finds no folder file longer than its length (0), so nothing is cut before the appends.
    expect(seen.map((call) => call.fn)).toEqual(['appendFile', 'appendFile', 'unlink']);
    expect(seen.at(-1)?.cursors).toMatchObject({ hooks: hooksSize, logsJson: logsSize });
    expect(existsSync(join(folderDir(), 's1.moving'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('creates the folder 0700, each session file and the marker 0600', async () => {
    await writeSession('s1', { hooks: EVENTS('s1'), logs: true, metrics: true, traces: true });
    past();
    const markerModes: number[] = [];
    beforeFsCall = (call) => {
      if (call.fn === 'appendFile') markerModes.push(statSync(join(folderDir(), 's1.moving')).mode & 0o777);
    };

    await (await modules()).sweepToFolder();

    expect(statSync(folderDir()).mode & 0o777).toBe(0o700);
    expect(folderFiles()).toHaveLength(4);
    for (const name of folderFiles()) expect(statSync(join(folderDir(), name)).mode & 0o777).toBe(0o600);
    expect(markerModes.length).toBeGreaterThan(0);
    expect(markerModes.every((mode) => mode === 0o600)).toBe(true);
  });

  it('a second sweep called while one runs returns and moves nothing twice', async () => {
    await writeSession('s1', { hooks: EVENTS('s1'), logs: true });
    past();
    const m = await modules();

    await Promise.all([m.sweepToFolder(), m.sweepToFolder()]);

    expect(eventIds('s1.hooks.jsonl')).toEqual(['e1', 'e2']);
    expect(linesWithIds('s1.otel_logs.jsonl')).toHaveLength(1);
  });

  it('yields between chunks of at most 1 MiB of input', async () => {
    const padding = 'x'.repeat(900);
    const events = Array.from({ length: 2600 }, (_, i) => ({ type: 't', session_id: 'big', event_id: `e${String(i).padStart(5, '0')}`, padding }));
    const lineBytes = Buffer.byteLength(hookLine(events[0])) + 1;
    await writeSession('big', { hooks: events });
    past();
    const m = await modules();
    const sequence: Array<number | 'yield'> = [];
    const realSetImmediate = globalThis.setImmediate;
    const immediate = vi.spyOn(globalThis, 'setImmediate').mockImplementation(((callback: () => void) => {
      sequence.push('yield');
      return realSetImmediate(callback);
    }) as typeof setImmediate);
    beforeFsCall = (call) => {
      if (call.fn === 'appendFile' && call.path.endsWith('big.hooks.jsonl')) sequence.push((call.data ?? '').split('\n').length - 1);
    };

    await m.sweepToFolder();
    immediate.mockRestore();

    const appends = sequence.filter((entry): entry is number => entry !== 'yield');
    expect(appends.length).toBeGreaterThanOrEqual(3);
    expect(appends.every((lines) => lines <= Math.floor((1024 * 1024) / lineBytes))).toBe(true);
    // Between two appends the copy waits on a setImmediate of its own.
    const between = sequence.slice(sequence.indexOf(appends[0]) + 1).join(',').split(/,?\d+,?/).slice(0, appends.length - 1);
    expect(between.every((gap) => gap.includes('yield'))).toBe(true);
    expect(eventIds('big.hooks.jsonl')).toHaveLength(2600);
  });

  describe('edge', () => {
    it('an empty hooks file and nothing in the folder → deleted', async () => {
      await writeSession('em', { hooks: [] });
      past();

      await (await modules()).sweepToFolder();

      expect(spoolFilesOf('em')).toEqual([]);
      expect(folderFiles()).toEqual([]);
    });

    it('a hook event with no type is dropped; nothing left after the drops → folder unchanged, session deleted', async () => {
      await writeSession('nt', { hooks: [{ session_id: 'nt', event_id: 'n1' }] });
      past();

      await (await modules()).sweepToFolder();

      expect(folderFiles()).toEqual([]);
      expect(spoolFilesOf('nt')).toEqual([]);
    });

    /** A hooks file of only lines the copy drops — one not JSON, one with no `type` — beside lines of telemetry. */
    async function writeDropped(sessionId: string): Promise<void> {
      await (await modules()).appendSpool(sessionId, 'hooks', 'not json\n' + hookLine({ session_id: sessionId, event_id: 'd1' }) + '\n');
      await writeSession(sessionId, { logs: true, metrics: true, traces: true });
    }

    it('only dropped hook lines and nothing in the folder → no folder file, no marker, the session deleted', async () => {
      await writeDropped('dr');
      past();

      await (await modules()).sweepToFolder();

      expect(folderFiles()).toEqual([]);
      expect(spoolFilesOf('dr')).toEqual([]);
    });

    it('only dropped hook lines with a hooks file in the folder → its telemetry appended with line ids, the hooks file unchanged', async () => {
      await writeSession('dh', { hooks: EVENTS('dh') });
      past();
      const m = await modules();
      await m.sweepToFolder();
      const hooksBefore = folderText('dh.hooks.jsonl');

      vi.setSystemTime(start);
      await writeDropped('dh');
      past();
      await m.sweepToFolder();

      expect(folderText('dh.hooks.jsonl')).toBe(hooksBefore);
      for (const name of ['dh.otel_logs.jsonl', 'dh.otel_metrics.jsonl', 'dh.otel_traces.jsonl']) expect(linesWithIds(name)).toHaveLength(1);
      expect(spoolFilesOf('dh')).toEqual([]);
    });

    it('only dropped hook lines, a throw at the marker\'s unlink, then a second sweep → no folder file, the session deleted', async () => {
      await writeDropped('dr');
      past();
      let thrown = false;
      beforeFsCall = (call) => {
        if (!thrown && call.fn === 'unlink' && call.path.endsWith('dr.moving')) {
          thrown = true;
          throw new Error('injected');
        }
      };
      const m = await modules();

      await m.sweepToFolder();
      expect(existsSync(join(folderDir(), 'dr.moving'))).toBe(true);
      await m.sweepToFolder();

      expect(folderFiles()).toEqual([]);
      expect(spoolFilesOf('dr')).toEqual([]);
    });
  });
});
