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
    await writeStatus(SESSION, createStatus());

    await processSessionTick(SESSION, credentials);

    expect(forwardSession).toHaveBeenCalledWith(SESSION, false, credentials);
  });
});
