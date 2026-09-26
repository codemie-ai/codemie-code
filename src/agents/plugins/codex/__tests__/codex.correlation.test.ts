import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import { logger } from '../../../../utils/logger.js';
import { findRolloutForRun, recordRolloutCorrelation } from '../codex.correlation.js';
import type { SessionDescriptor } from '../../../core/session/discovery-types.js';

interface FakeRollout {
  filePath: string;
  /** session_meta.timestamp of the rollout, Unix ms */
  startedAt: number;
  /** file mtime, Unix ms */
  mtime: number;
  cwd: string;
}

function fakeAdapter(rollouts: FakeRollout[]) {
  const descriptors: SessionDescriptor[] = rollouts
    .map((r) => ({ sessionId: r.filePath, filePath: r.filePath, createdAt: r.mtime, agentName: 'codex' }))
    .sort((a, b) => b.createdAt - a.createdAt);
  const byPath = new Map(rollouts.map((r) => [r.filePath, r]));
  return {
    discoverSessions: vi.fn().mockResolvedValue(descriptors),
    parseSessionFile: vi.fn().mockImplementation(async (filePath: string, sessionId: string) => {
      const r = byPath.get(filePath)!;
      return {
        sessionId,
        agentName: 'Codex CLI',
        metadata: { projectPath: r.cwd, createdAt: new Date(r.startedAt).toISOString() },
        messages: [],
        metrics: undefined,
      };
    }),
  };
}

describe('codex rollout correlation', () => {
  let home: string;
  let cwd: string;
  const originalHome = process.env.CODEMIE_HOME;

  async function writeSessionRecord(sessionId: string, agentSessionFile = ''): Promise<void> {
    await mkdir(join(home, 'sessions'), { recursive: true });
    await writeFile(
      join(home, 'sessions', `${sessionId}.json`),
      JSON.stringify({
        sessionId,
        agentName: 'codex',
        status: 'active',
        correlation: { status: 'matched', agentSessionId: sessionId, agentSessionFile, retryCount: 0 },
      })
    );
  }

  async function readAgentSessionFile(sessionId: string): Promise<string | undefined> {
    const raw = await readFile(join(home, 'sessions', `${sessionId}.json`), 'utf-8');
    return (JSON.parse(raw) as { correlation: { agentSessionFile?: string } }).correlation.agentSessionFile;
  }

  async function endRun(adapter: ReturnType<typeof fakeAdapter>, sessionId: string, startedAt: number) {
    const rollout = await findRolloutForRun(adapter, { sessionId, startedAt, cwd });
    if (rollout) await recordRolloutCorrelation(sessionId, rollout.filePath);
    return rollout?.filePath;
  }

  beforeEach(async () => {
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.debug).mockClear();
    home = await mkdtemp(join(tmpdir(), 'codex-corr-'));
    cwd = await mkdtemp(join(tmpdir(), 'codex-corr-cwd-'));
    process.env.CODEMIE_HOME = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = originalHome;
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  function concurrentRuns() {
    const t0 = Date.now() - 60_000;
    const runA = { sessionId: 'run-a', startedAt: t0 };
    const runB = { sessionId: 'run-b', startedAt: t0 + 5_000 };
    const rolloutA: FakeRollout = { filePath: '/codex/rollout-a.jsonl', startedAt: t0 + 1_000, mtime: t0 + 50_000, cwd };
    // B's rollout was written to last, so it sorts first by mtime.
    const rolloutB: FakeRollout = { filePath: '/codex/rollout-b.jsonl', startedAt: t0 + 6_000, mtime: t0 + 55_000, cwd };
    return { runA, runB, adapter: fakeAdapter([rolloutA, rolloutB]), rolloutA, rolloutB };
  }

  it('gives two concurrent runs in one cwd their own rollout when the earlier run exits first', async () => {
    const { runA, runB, adapter, rolloutA, rolloutB } = concurrentRuns();
    await writeSessionRecord(runA.sessionId);
    await writeSessionRecord(runB.sessionId);

    expect(await endRun(adapter, runA.sessionId, runA.startedAt)).toBe(rolloutA.filePath);
    expect(await endRun(adapter, runB.sessionId, runB.startedAt)).toBe(rolloutB.filePath);
    expect(await readAgentSessionFile(runA.sessionId)).toBe(rolloutA.filePath);
    expect(await readAgentSessionFile(runB.sessionId)).toBe(rolloutB.filePath);
  });

  it('gives two concurrent runs in one cwd their own rollout when the later run exits first', async () => {
    const { runA, runB, adapter, rolloutA, rolloutB } = concurrentRuns();
    await writeSessionRecord(runA.sessionId);
    await writeSessionRecord(runB.sessionId);

    expect(await endRun(adapter, runB.sessionId, runB.startedAt)).toBe(rolloutB.filePath);
    expect(await endRun(adapter, runA.sessionId, runA.startedAt)).toBe(rolloutA.filePath);
  });

  it('skips a rollout already correlated to another CodeMie session', async () => {
    const { runA, rolloutA, rolloutB } = concurrentRuns();
    // The claimed rollout is both the newest by mtime and the closest by start time.
    const adapter = fakeAdapter([{ ...rolloutA, mtime: rolloutB.mtime + 1_000 }, rolloutB]);
    await writeSessionRecord('other-run', rolloutA.filePath);
    await writeSessionRecord(runA.sessionId);

    expect(await endRun(adapter, runA.sessionId, runA.startedAt)).toBe(rolloutB.filePath);
  });

  it('logs when more than one rollout could belong to the run', async () => {
    const { runA, adapter } = concurrentRuns();
    await writeSessionRecord(runA.sessionId);

    await endRun(adapter, runA.sessionId, runA.startedAt);

    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('2 rollout candidates'));
  });

  it('does not overwrite an existing agentSessionFile that points to a different rollout', async () => {
    await writeSessionRecord('run-x', '/codex/rollout-original.jsonl');

    await recordRolloutCorrelation('run-x', '/codex/rollout-other.jsonl');

    expect(await readAgentSessionFile('run-x')).toBe('/codex/rollout-original.jsonl');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('fills an empty agentSessionFile', async () => {
    await writeSessionRecord('run-y');

    await recordRolloutCorrelation('run-y', '/codex/rollout-y.jsonl');

    expect(await readAgentSessionFile('run-y')).toBe('/codex/rollout-y.jsonl');
  });
});
