/**
 * A generation set aside past the evidence retention is a drop
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@/agents/core/session/types.js';

const DAY = 86_400_000;
const ID = 'd4e5f6a7-0000-4000-8000-000000000004';

function record(overrides: Partial<Session> = {}): Session {
  const now = Date.now();
  return {
    sessionId: ID,
    agentName: 'claude',
    provider: 'ai-run-sso',
    startTime: now - 120 * DAY,
    endTime: now - 100 * DAY,
    workingDirectory: '/tmp/project',
    status: 'completed',
    activeDurationMs: 0,
    correlation: { status: 'matched', agentSessionId: 'native-1', retryCount: 0 },
    ...overrides,
  };
}

describe('setGenerationAside', () => {
  let home: string;
  let sessionsDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['CODEMIE_HOME', 'CODEMIE_EVIDENCE_RECORD_IDLE_DAYS']) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    home = mkdtempSync(join(tmpdir(), 'generation-aside-'));
    process.env.CODEMIE_HOME = home;
    sessionsDir = join(home, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    const { logger } = await import('@/utils/logger.js');
    await logger.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  function generationRecords(): Session[] {
    return readdirSync(sessionsDir)
      .filter((name) => name.endsWith('.json') && name.includes(ID))
      .map((name) => JSON.parse(readFileSync(join(sessionsDir, name), 'utf-8')) as Session);
  }

  it('marks a generation of this launch past the evidence retention dropped, with its data unsent, before moving it', async () => {
    writeFileSync(join(sessionsDir, `${ID}.json`), JSON.stringify(record()));
    const { setGenerationAside } = await import('../generation-close.js');

    await setGenerationAside(ID, true, {});

    expect(existsSync(join(sessionsDir, `${ID}.json`))).toBe(false);
    const moved = generationRecords();
    expect(moved).toHaveLength(1);
    expect(moved[0].droppedReason).toBe('retention expired');
    expect(moved[0].droppedAt).toBeTypeOf('number');
  });

  it('marks nothing for a generation of another launch, or one whose data was all delivered', async () => {
    writeFileSync(join(sessionsDir, `${ID}.json`), JSON.stringify(record({ endMetricSentAt: Date.now() - 99 * DAY })));
    const { setGenerationAside } = await import('../generation-close.js');

    await setGenerationAside(ID, true, {});

    expect(generationRecords().every((r) => r.droppedAt === undefined)).toBe(true);
  });
});
