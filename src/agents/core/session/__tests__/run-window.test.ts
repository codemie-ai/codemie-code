/**
 * resolveRunWindow: the record's start as the lower bound; the next record over the same transcript as
 * the upper one, except inside a hook process, which knows no later record.
 *
 * Seam: the resolver over a temp sessions directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), isDebugMode: () => false },
}));

const { resolveRunWindow } = await import('../run-window.js');

const FIRST = '00000000-0000-4000-8000-000000000001';
const SECOND = '00000000-0000-4000-8000-000000000002';

let home: string;
let sessionsDir: string;
const previousHome = process.env.CODEMIE_HOME;

function writeRecord(sessionId: string, startTime: number): void {
  writeFileSync(join(sessionsDir, `${sessionId}.json`), JSON.stringify({
    sessionId,
    agentName: 'claude',
    startTime,
    correlation: { status: 'matched', retryCount: 0, agentSessionId: 'native', agentSessionFile: '/transcripts/native.jsonl' },
  }));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'run-window-'));
  process.env.CODEMIE_HOME = home;
  sessionsDir = join(home, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeRecord(FIRST, 1000);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEMIE_HOME;
  else process.env.CODEMIE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('resolveRunWindow', () => {
  it('has the record start and no upper bound while no later record shares the transcript', async () => {
    expect(await resolveRunWindow(FIRST, {} as never)).toMatchObject({ startTime: 1000, upperBound: undefined });
  });

  it('bounds a wrapper at the next record over the same transcript, even one that starts in the future', async () => {
    const future = Date.now() + 86_400_000;
    writeRecord(SECOND, future);

    expect((await resolveRunWindow(FIRST, {} as never)).upperBound).toBe(future);
  });

  it('puts no upper bound on a hook process, which knows no later record', async () => {
    writeRecord(SECOND, 5000);

    expect((await resolveRunWindow(FIRST, { hookProcess: true } as never)).upperBound).toBeUndefined();
  });

  it('takes the caller\'s bound when the context carries one', async () => {
    writeRecord(SECOND, 5000);

    expect((await resolveRunWindow(FIRST, { recordsBeforeMs: 3000 } as never)).upperBound).toBe(3000);
  });

  it('throws for a missing record rather than guessing a start', async () => {
    await expect(resolveRunWindow('00000000-0000-4000-8000-0000000000ff', {} as never)).rejects.toThrow(/Session record not found/);
  });
});
