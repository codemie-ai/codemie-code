/**
 * Tick processor invariant: OTEL-only sessions are never forwarded.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SSOCredentials } from '../../../../../../core/types.js';

const state = vi.hoisted(() => ({ root: '' }));

vi.mock('../spool-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../spool-paths.js')>();
  const { join: pathJoin } = await import('node:path');
  return {
    ...actual,
    spoolRoot: (): string => state.root,
    streamFile: (sessionId: string, stream: string): string => {
      const ext: Record<string, string> = {
        hooks: '.hooks.ndjson',
        logs: '.otel_logs.bin',
        metrics: '.otel_metrics.bin',
        traces: '.otel_traces.bin',
      };
      return pathJoin(state.root, sessionId + ext[stream]);
    },
    statusFile: (sessionId: string): string => pathJoin(state.root, sessionId + '.status'),
  };
});

vi.mock('../forwarder.js', () => ({ forwardSession: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../auth-state.js', () => ({ areCredentialsStale: vi.fn().mockReturnValue(false) }));
vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const credentials = { cookies: {}, apiUrl: 'http://localhost' } as unknown as SSOCredentials;
const SESSION = 'sess-1';

async function seed(files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(state.root, name), content);
  }
}

async function readStatusRaw(): Promise<{ cursors: Record<string, number>; waitTicks: number }> {
  const { readStatus } = await import('../session-status.js');
  const status = await readStatus(SESSION);
  if (!status) throw new Error('status missing');
  return status;
}

describe('processSessionTick (OTEL-only invariant)', () => {
  beforeEach(async () => {
    state.root = await mkdtemp(join(tmpdir(), 'otlp-tick-'));
    await mkdir(state.root, { recursive: true });
    delete process.env.OTLP_SEND_MAX_ATTEMPTS;
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(state.root, { recursive: true, force: true });
  });

  async function limit(): Promise<number> {
    const { hooksOnlyWaitTicks } = await import('../spool-config.js');
    return hooksOnlyWaitTicks();
  }

  it('skips an OTEL-only session past the wait limit: cursors reach file sizes and nothing is forwarded', async () => {
    const { writeStatus, createStatus } = await import('../session-status.js');
    const { forwardSession } = await import('../forwarder.js');
    const { processSessionTick } = await import('../tick-processor.js');
    await seed({ [`${SESSION}.otel_logs.bin`]: 'abcde', [`${SESSION}.otel_traces.bin`]: 'xyz' });
    await writeStatus(SESSION, { ...createStatus(), waitTicks: await limit() });

    await expect(
      Promise.race([
        processSessionTick(SESSION, credentials),
        new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock')), 2000)),
      ])
    ).resolves.toBeUndefined();

    const status = await readStatusRaw();
    expect(status.cursors).toEqual({ hooks: 0, logs: 5, metrics: 0, traces: 3 });
    expect(forwardSession).not.toHaveBeenCalled();
  });

  it('does not rewrite the status when the session is already drained', async () => {
    const { writeStatus, createStatus } = await import('../session-status.js');
    const { forwardSession } = await import('../forwarder.js');
    const { processSessionTick } = await import('../tick-processor.js');
    await seed({ [`${SESSION}.otel_logs.bin`]: 'abcde' });
    const status = createStatus();
    status.cursors.logs = 5;
    status.waitTicks = await limit();
    await writeStatus(SESSION, status);
    const before = await stat(join(state.root, `${SESSION}.status`));
    await new Promise((resolve) => setTimeout(resolve, 20));

    await processSessionTick(SESSION, credentials);

    const after = await stat(join(state.root, `${SESSION}.status`));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(forwardSession).not.toHaveBeenCalled();
  });

  it('increments waitTicks and keeps the data below the wait limit', async () => {
    const { writeStatus, createStatus } = await import('../session-status.js');
    const { forwardSession } = await import('../forwarder.js');
    const { processSessionTick } = await import('../tick-processor.js');
    await seed({ [`${SESSION}.otel_logs.bin`]: 'abcde' });
    await writeStatus(SESSION, { ...createStatus(), waitTicks: 0 });

    await processSessionTick(SESSION, credentials);

    const status = await readStatusRaw();
    expect(status.waitTicks).toBe(1);
    expect(status.cursors.logs).toBe(0);
    expect(forwardSession).not.toHaveBeenCalled();
  });

  it('still forwards when hooks and OTEL are both present', async () => {
    const { writeStatus, createStatus } = await import('../session-status.js');
    const { forwardSession } = await import('../forwarder.js');
    const { processSessionTick } = await import('../tick-processor.js');
    await seed({ [`${SESSION}.otel_logs.bin`]: 'abcde', [`${SESSION}.hooks.ndjson`]: '{}\n' });
    await writeStatus(SESSION, { ...createStatus(), project: 'A', projectScanned: true });

    await processSessionTick(SESSION, credentials);

    expect(forwardSession).toHaveBeenCalledWith(SESSION, false, credentials);
  });
});

describe('processSessionTick (project gate)', () => {
  const fetchMock = vi.fn();
  const hookLine = (project?: string): string => {
    const event: Record<string, unknown> = { type: 'agent.tool.end', session_id: SESSION };
    if (project !== undefined) event['codemie_project_name'] = project;
    return JSON.stringify({ agentName: 'x', hookEvent: JSON.stringify(event) }) + '\n';
  };

  beforeEach(async () => {
    state.root = await mkdtemp(join(tmpdir(), 'otlp-tick-gate-'));
    delete process.env.OTLP_SEND_MAX_ATTEMPTS;
    process.env.OTLP_ALLOW_HOOKS_ONLY_FORWARD = 'false';
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    delete process.env.OTLP_ALLOW_HOOKS_ONLY_FORWARD;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    await rm(state.root, { recursive: true, force: true });
  });

  async function tickWith(files: Record<string, string>, legacy = true): Promise<void> {
    const { writeStatus, createStatus } = await import('../session-status.js');
    const { processSessionTick } = await import('../tick-processor.js');
    await seed(files);
    await writeStatus(SESSION, legacy ? createStatus() : { ...createStatus(), projectScanned: true });
    await processSessionTick(SESSION, credentials);
  }

  async function expectNothingSent(): Promise<void> {
    const { forwardSession } = await import('../forwarder.js');
    expect(forwardSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  }

  it('discards an unbound hooks-only session at the tick, without a wait tick', async () => {
    const hooks = hookLine('') + hookLine();
    await tickWith({ [`${SESSION}.hooks.ndjson`]: hooks });

    const status = await readStatusRaw();
    expect(status.cursors.hooks).toBe(Buffer.byteLength(hooks));
    expect(status.waitTicks).toBe(0);
    await expectNothingSent();
  });

  it('records a conflict from a legacy status and discards the backlog', async () => {
    const hooks = hookLine('A') + hookLine('B');
    await tickWith({ [`${SESSION}.hooks.ndjson`]: hooks, [`${SESSION}.otel_logs.bin`]: 'abc' });

    const { readStatus } = await import('../session-status.js');
    const status = await readStatus(SESSION);
    expect(status?.projectConflict).toEqual(['A', 'B']);
    expect(status?.cursors).toEqual({ hooks: Buffer.byteLength(hooks), logs: 3, metrics: 0, traces: 0 });
    expect(status?.waitTicks).toBe(0);
    await expectNothingSent();
  });

  it('binds a single legacy project, discards nothing and takes the normal wait path', async () => {
    await tickWith({ [`${SESSION}.hooks.ndjson`]: hookLine('A') });

    const { readStatus } = await import('../session-status.js');
    const status = await readStatus(SESSION);
    expect(status).toMatchObject({ project: 'A', projectScanned: true, waitTicks: 1 });
    expect(status?.cursors.hooks).toBe(0);
    await expectNothingSent();
  });

  it('leaves an OTEL-only session to the existing wait path', async () => {
    await tickWith({ [`${SESSION}.otel_logs.bin`]: 'abcde' });

    const status = await readStatusRaw();
    expect(status.waitTicks).toBe(1);
    expect(status.cursors.logs).toBe(0);
    await expectNothingSent();
  });

  it('still forwards a bound session once the flag allows it and the wait ticks are used up', async () => {
    process.env.OTLP_ALLOW_HOOKS_ONLY_FORWARD = 'true';
    const { writeStatus, createStatus } = await import('../session-status.js');
    const { forwardSession } = await import('../forwarder.js');
    const { processSessionTick } = await import('../tick-processor.js');
    await seed({ [`${SESSION}.hooks.ndjson`]: hookLine('A') });
    await writeStatus(SESSION, {
      ...createStatus(),
      project: 'A',
      projectScanned: true,
      waitTicks: await (async () => (await import('../spool-config.js')).hooksOnlyWaitTicks())(),
    });

    await processSessionTick(SESSION, credentials);

    expect(forwardSession).toHaveBeenCalledWith(SESSION, true, credentials);
  });

  it('does not rewrite the status of an already discarded conflicted session', async () => {
    const hooks = hookLine('A') + hookLine('B');
    await tickWith({ [`${SESSION}.hooks.ndjson`]: hooks });
    const before = await stat(join(state.root, `${SESSION}.status`));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const { processSessionTick } = await import('../tick-processor.js');
    await processSessionTick(SESSION, credentials);

    const after = await stat(join(state.root, `${SESSION}.status`));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  describe('hooks seal', () => {
    const aLine = hookLine('A');
    const hooks = aLine + hookLine('B');
    const sealedStatus = async (hooksEnd: number): Promise<void> => {
      const { writeStatus, createStatus } = await import('../session-status.js');
      await writeStatus(SESSION, {
        ...createStatus(),
        project: 'A',
        projectConflict: ['A', 'B'],
        projectSeal: { v: 1, project: 'A', hooksEnd },
        projectScanned: true,
      });
    };

    it('flushes the sealed prefix hooks-only at once, with no wait tick, and discards OTLP', async () => {
      process.env.OTLP_ALLOW_HOOKS_ONLY_FORWARD = 'true';
      const { forwardSession } = await import('../forwarder.js');
      const { processSessionTick } = await import('../tick-processor.js');
      await seed({ [`${SESSION}.hooks.ndjson`]: hooks, [`${SESSION}.otel_logs.bin`]: 'abc' });
      await sealedStatus(Buffer.byteLength(aLine));

      await processSessionTick(SESSION, credentials);

      expect(forwardSession).toHaveBeenCalledWith(SESSION, true, credentials);
      const status = await readStatusRaw();
      expect(status.waitTicks).toBe(0);
      expect(status.cursors).toEqual({ hooks: 0, logs: 3, metrics: 0, traces: 0 });
    });

    it('with OTLP_ALLOW_HOOKS_ONLY_FORWARD=false discards the sealed session entirely and forwards nothing', async () => {
      const { processSessionTick } = await import('../tick-processor.js');
      await seed({ [`${SESSION}.hooks.ndjson`]: hooks, [`${SESSION}.otel_logs.bin`]: 'abc' });
      await sealedStatus(Buffer.byteLength(aLine));

      await processSessionTick(SESSION, credentials);

      expect((await readStatusRaw()).cursors).toEqual({ hooks: Buffer.byteLength(hooks), logs: 3, metrics: 0, traces: 0 });
      await expectNothingSent();
    });

    it('discards the rest of the hooks once the sealed prefix is acknowledged', async () => {
      process.env.OTLP_ALLOW_HOOKS_ONLY_FORWARD = 'true';
      const { processSessionTick } = await import('../tick-processor.js');
      await seed({ [`${SESSION}.hooks.ndjson`]: hooks });
      await sealedStatus(Buffer.byteLength(aLine));
      const { advanceCursor } = await import('../session-status.js');
      await advanceCursor(SESSION, 'hooks', Buffer.byteLength(aLine));

      await processSessionTick(SESSION, credentials);

      expect((await readStatusRaw()).cursors.hooks).toBe(Buffer.byteLength(hooks));
      await expectNothingSent();
    });

    it.each([
      { name: 'bound', status: { project: 'A', projectScanned: true }, flag: 'true', hooks: aLine, otel: 'abc' },
      { name: 'conflict without a seal', status: { project: 'A', projectConflict: ['A', 'B'], projectScanned: true }, flag: 'true', hooks, otel: 'abc' },
      { name: 'sealed, flag on', status: { project: 'A', projectConflict: ['A', 'B'], projectSeal: { v: 1 as const, project: 'A', hooksEnd: Buffer.byteLength(aLine) }, projectScanned: true }, flag: 'true', hooks, otel: 'abc' },
      { name: 'sealed, flag off', status: { project: 'A', projectConflict: ['A', 'B'], projectSeal: { v: 1 as const, project: 'A', hooksEnd: Buffer.byteLength(aLine) }, projectScanned: true }, flag: 'false', hooks, otel: 'abc' },
      { name: 'unbound with hooks', status: { projectScanned: true }, flag: 'true', hooks: hookLine(''), otel: 'abc' },
    ])('tick and snapshots leave the same cursors: $name', async ({ status, flag, hooks: hooksText, otel }) => {
      process.env.OTLP_ALLOW_HOOKS_ONLY_FORWARD = flag;
      const { writeStatus, createStatus, readStatus } = await import('../session-status.js');
      const { processSessionTick } = await import('../tick-processor.js');
      const io = await import('../spool-io.js');
      const files = { [`${SESSION}.hooks.ndjson`]: hooksText, [`${SESSION}.otel_logs.bin`]: otel };

      await seed(files);
      await writeStatus(SESSION, { ...createStatus(), ...status });
      await processSessionTick(SESSION, credentials);
      const viaTick = (await readStatus(SESSION))?.cursors;

      await rm(join(state.root, `${SESSION}.status`));
      await seed(files);
      await writeStatus(SESSION, { ...createStatus(), ...status });
      await io.snapshotPendingHookRecords(SESSION);
      for (const stream of ['logs', 'metrics', 'traces'] as const) {
        await io.snapshotPendingBytes(SESSION, stream);
      }
      const viaSnapshots = (await readStatus(SESSION))?.cursors;

      expect(viaSnapshots).toEqual(viaTick);
    });
  });
});
