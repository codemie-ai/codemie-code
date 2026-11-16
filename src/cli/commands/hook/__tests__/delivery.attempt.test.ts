/**
 * deliverSessionRecord: the attempt a local throw ends is given back
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@/agents/core/session/types.js';

vi.mock('../end-metric.js', () => ({
  sendSessionEndMetrics: vi.fn(async () => {
    throw new Error('lock timeout');
  }),
}));

const ID = 'e5f6a7b8-0000-4000-8000-000000000005';

describe('deliverSessionRecord', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.CODEMIE_HOME;
    home = mkdtempSync(join(tmpdir(), 'hook-delivery-'));
    process.env.CODEMIE_HOME = home;
    mkdirSync(join(home, 'sessions'), { recursive: true });
    const session: Session = {
      sessionId: ID, agentName: 'claude', provider: 'ai-run-sso', startTime: Date.now() - 3_600_000, endTime: Date.now() - 1_800_000,
      workingDirectory: '/tmp/project', status: 'completed', activeDurationMs: 0, deliveryRealAttempts: 1,
      correlation: { status: 'matched', agentSessionId: 'native-1', retryCount: 0 },
    };
    writeFileSync(join(home, 'sessions', `${ID}.json`), JSON.stringify(session));
  });

  afterEach(async () => {
    const { logger } = await import('@/utils/logger.js');
    await logger.close();
    if (originalHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('a local throw in the send gives the attempt back before it is rethrown: no real attempt stays spent, no clock starts', async () => {
    const { deliverSessionRecord } = await import('../delivery.js');
    const config = { agentName: 'claude', sessionId: ID, provider: 'ai-run-sso', ssoUrl: 'https://codemie.example.com' } as Parameters<typeof deliverSessionRecord>[3];

    await expect(deliverSessionRecord(ID, 'native-1', 'exit', config, {})).rejects.toThrow('lock timeout');

    const saved = JSON.parse(readFileSync(join(home, 'sessions', `${ID}.json`), 'utf-8')) as Session;
    // One attempt was begun (1 → 2) and handed back (→ 1): the count the record had before this delivery
    expect(saved.deliveryRealAttempts).toBe(1);
    expect(saved.deliveryFailingSince ?? undefined).toBeUndefined();
    expect(saved.droppedAt).toBeUndefined();
  });
});
