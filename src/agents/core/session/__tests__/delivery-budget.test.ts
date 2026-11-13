/**
 * Delivery budget: the window, the real-attempt count and the drop reasons
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../types.js';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const ID = 'c3d4e5f6-0000-4000-8000-000000000003';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: ID,
    agentName: 'claude',
    provider: 'ai-run-sso',
    startTime: NOW - 30 * HOUR,
    endTime: NOW - 29 * HOUR,
    workingDirectory: '/tmp/project',
    status: 'completed',
    activeDurationMs: 0,
    correlation: { status: 'matched', agentSessionId: 'native-1', retryCount: 0 },
    ...overrides,
  };
}

describe('delivery budget', () => {
  let home: string;
  let sessionsDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['CODEMIE_HOME', 'CODEMIE_DELIVERY_RETRY_WINDOW_MS', 'CODEMIE_EVIDENCE_RECORD_IDLE_DAYS']) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    home = mkdtempSync(join(tmpdir(), 'delivery-budget-'));
    process.env.CODEMIE_HOME = home;
    sessionsDir = join(home, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    const { logger } = await import('../../../../utils/logger.js');
    await logger.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  describe('budgetSpent', () => {
    it('is not spent at 23h with 5 counted attempts', async () => {
      const { budgetSpent } = await import('../delivery-budget.js');
      const s = makeSession({ startTime: NOW - HOUR, endTime: NOW - HOUR, deliveryFailingSince: NOW - 23 * HOUR, deliveryRealAttempts: 5 });
      expect(budgetSpent(s, 'counted', NOW)).toBeUndefined();
    });

    it('is not spent at 25h with only 2 attempts', async () => {
      const { budgetSpent } = await import('../delivery-budget.js');
      const s = makeSession({ startTime: NOW - HOUR, endTime: NOW - HOUR, deliveryFailingSince: NOW - 25 * HOUR, deliveryRealAttempts: 2 });
      expect(budgetSpent(s, 'counted', NOW)).toBeUndefined();
    });

    it('is spent at 25h with 3 attempts after a counted failure', async () => {
      const { budgetSpent } = await import('../delivery-budget.js');
      const s = makeSession({ startTime: NOW - HOUR, endTime: NOW - HOUR, deliveryFailingSince: NOW - 25 * HOUR, deliveryRealAttempts: 3 });
      expect(budgetSpent(s, 'counted', NOW)).toBe('retry budget exhausted');
    });

    it('is not spent after an outage', async () => {
      const { budgetSpent } = await import('../delivery-budget.js');
      const s = makeSession({ startTime: NOW - HOUR, endTime: NOW - HOUR, deliveryFailingSince: NOW - 25 * HOUR, deliveryRealAttempts: 9 });
      expect(budgetSpent(s, 'outage', NOW)).toBeUndefined();
    });

    it('reports retention expired past the evidence retention', async () => {
      const { budgetSpent } = await import('../delivery-budget.js');
      const s = makeSession({ startTime: NOW - 100 * 24 * HOUR, endTime: NOW - 100 * 24 * HOUR });
      expect(budgetSpent(s, 'outage', NOW)).toBe('retention expired');
    });

    it('future clock never spends budget', async () => {
      const { budgetSpent } = await import('../delivery-budget.js');
      const s = makeSession({ startTime: NOW - HOUR, endTime: NOW - HOUR, deliveryFailingSince: NOW + 48 * HOUR, deliveryRealAttempts: 50 });
      expect(budgetSpent(s, 'counted', NOW)).toBeUndefined();
    });

    it('honours the window override of 1000 ms', async () => {
      process.env.CODEMIE_DELIVERY_RETRY_WINDOW_MS = '1000';
      const { budgetSpent, retryWindowMs } = await import('../delivery-budget.js');
      expect(retryWindowMs()).toBe(1000);
      const s = makeSession({ startTime: NOW - HOUR, endTime: NOW - HOUR, deliveryFailingSince: NOW - 2000, deliveryRealAttempts: 3 });
      expect(budgetSpent(s, 'counted', NOW)).toBe('retry budget exhausted');
    });

    it('defaults the window to 24h and ignores a bad override', async () => {
      process.env.CODEMIE_DELIVERY_RETRY_WINDOW_MS = 'soon';
      const { retryWindowMs } = await import('../delivery-budget.js');
      expect(retryWindowMs()).toBe(86_400_000);
    });
  });

  describe('attempts and outcomes', () => {
    it('beginRealAttempt adds one', async () => {
      const { beginRealAttempt } = await import('../delivery-budget.js');
      expect(beginRealAttempt(makeSession()).deliveryRealAttempts).toBe(1);
      expect(beginRealAttempt(makeSession({ deliveryRealAttempts: 2 })).deliveryRealAttempts).toBe(3);
    });

    it('a counted outcome starts the clock and keeps the attempt', async () => {
      const { noteOutcome } = await import('../delivery-budget.js');
      const s = noteOutcome(makeSession({ deliveryRealAttempts: 1 }), 'counted', NOW);
      expect(s.deliveryFailingSince).toBe(NOW);
      expect(s.deliveryRealAttempts).toBe(1);
    });

    it('keeps the first clock', async () => {
      const { noteOutcome } = await import('../delivery-budget.js');
      const s = noteOutcome(makeSession({ deliveryRealAttempts: 2, deliveryFailingSince: NOW - HOUR }), 'counted', NOW);
      expect(s.deliveryFailingSince).toBe(NOW - HOUR);
    });

    it.each(['outage', 'auth'] as const)('a %s outcome starts the clock and gives the attempt back', async (outcome) => {
      const { noteOutcome } = await import('../delivery-budget.js');
      const s = noteOutcome(makeSession({ deliveryRealAttempts: 2 }), outcome, NOW);
      expect(s.deliveryFailingSince).toBe(NOW);
      expect(s.deliveryRealAttempts).toBe(1);
    });

    it('a not-attempt outcome (no request made) starts no clock and gives the attempt back', async () => {
      const { noteOutcome } = await import('../delivery-budget.js');
      const s = noteOutcome(makeSession({ deliveryRealAttempts: 2 }), 'not-attempt', NOW);
      expect(s.deliveryFailingSince).toBeUndefined();
      expect(s.deliveryRealAttempts).toBe(1);
    });

    it('an ok outcome starts no clock and gives the attempt back', async () => {
      const { noteOutcome } = await import('../delivery-budget.js');
      const s = noteOutcome(makeSession({ deliveryRealAttempts: 1 }), 'ok', NOW);
      expect(s.deliveryFailingSince).toBeUndefined();
      expect(s.deliveryRealAttempts).toBe(0);
    });

    it('an ok outcome clears a running failing clock explicitly and keeps the real-attempt count', async () => {
      const { noteOutcome, budgetSpent, notDroppedBefore } = await import('../delivery-budget.js');
      const s = noteOutcome(makeSession({ deliveryRealAttempts: 4, deliveryFailingSince: NOW - 30 * HOUR }), 'ok', NOW);
      expect(s.deliveryFailingSince).toBeNull();
      expect(s.deliveryRealAttempts).toBe(3);
      // the next failure starts a fresh clock, not the old one
      const next = noteOutcome(s, 'counted', NOW + HOUR);
      expect(next.deliveryFailingSince).toBe(NOW + HOUR);
      expect(budgetSpent({ ...s, deliveryRealAttempts: 9 }, 'counted', NOW)).toBeUndefined();
      expect(notDroppedBefore(s, NOW)).toBe(NOW + 24 * HOUR);
    });

    it('a rejected outcome stamps the drop reason once', async () => {
      const { noteOutcome } = await import('../delivery-budget.js');
      const first = noteOutcome(makeSession({ deliveryRealAttempts: 1 }), 'rejected', NOW);
      expect(first.droppedAt).toBe(NOW);
      expect(first.droppedReason).toBe('rejected by the server');
      const second = noteOutcome({ ...first, droppedReason: 'retry budget exhausted' }, 'rejected', NOW + 5);
      expect(second.droppedAt).toBe(NOW);
      expect(second.droppedReason).toBe('retry budget exhausted');
    });

    it('notDroppedBefore is never a moment already past', async () => {
      const { notDroppedBefore } = await import('../delivery-budget.js');
      expect(notDroppedBefore(makeSession({ deliveryFailingSince: NOW - 48 * HOUR }), NOW)).toBe(NOW);
    });

    it('notDroppedBefore is the clock plus the window, or now plus the window', async () => {
      const { notDroppedBefore } = await import('../delivery-budget.js');
      expect(notDroppedBefore(makeSession({ deliveryFailingSince: NOW - HOUR }), NOW)).toBe(NOW - HOUR + 24 * HOUR);
      expect(notDroppedBefore(makeSession(), NOW)).toBe(NOW + 24 * HOUR);
    });

    it('notDroppedBefore is the retention end when the evidence retention ends before the window', async () => {
      const { notDroppedBefore } = await import('../delivery-budget.js');
      const endTime = NOW - 90 * 24 * HOUR + 2 * HOUR;
      expect(notDroppedBefore(makeSession({ startTime: endTime - HOUR, endTime, deliveryFailingSince: NOW - HOUR }), NOW)).toBe(NOW + 2 * HOUR);
    });
  });

  describe('hasUndeliveredData and leaveQueue', () => {
    const metricsPath = () => join(sessionsDir, `${ID}_metrics.jsonl`);
    const livePath = () => join(sessionsDir, `${ID}.json`);

    function writeDeltas(...statuses: string[]): void {
      writeFileSync(metricsPath(), statuses.map((syncStatus, i) => JSON.stringify({ recordId: `r${i}`, syncStatus })).join('\n') + '\n');
    }

    it('counts a pending line, not a rejected one, and ignores syncAttempts', async () => {
      const { hasUndeliveredData } = await import('../delivery-budget.js');
      const s = makeSession({ endMetricSentAt: NOW });
      writeDeltas('synced', 'rejected');
      expect(await hasUndeliveredData(s)).toBe(false);
      writeDeltas('synced', 'rejected', 'pending');
      expect(await hasUndeliveredData(s)).toBe(true);
      writeFileSync(metricsPath(), JSON.stringify({ recordId: 'r', syncStatus: 'failed', syncAttempts: 99 }) + '\n');
      expect(await hasUndeliveredData(s)).toBe(true);
    });

    it('a syncing line is not counted: the metrics processor never resends it, so it cannot hold the record queued', async () => {
      const { hasUndeliveredData } = await import('../delivery-budget.js');
      writeDeltas('synced', 'syncing');
      expect(await hasUndeliveredData(makeSession({ endMetricSentAt: NOW }))).toBe(false);
    });

    it('counts an unsent end metric and ignores a legacy-withheld delta', async () => {
      const { hasUndeliveredData } = await import('../delivery-budget.js');
      expect(await hasUndeliveredData(makeSession())).toBe(true);
      writeDeltas('pending');
      expect(await hasUndeliveredData(makeSession({ endMetricSentAt: NOW, legacyMetricsWithheld: 'no-work-consent' }))).toBe(false);
    });

    it('leaveQueue marks a record with data unsent and renames it', async () => {
      const { leaveQueue } = await import('../delivery-budget.js');
      const s = makeSession({ endMetricSentAt: NOW });
      writeFileSync(livePath(), JSON.stringify(s));
      writeDeltas('pending');
      await leaveQueue(s, 'retry budget exhausted', NOW);
      expect(existsSync(livePath())).toBe(false);
      const done = JSON.parse(readFileSync(join(sessionsDir, `completed_${ID}.json`), 'utf-8')) as Session;
      expect(done.droppedAt).toBe(NOW);
      expect(done.droppedReason).toBe('retry budget exhausted');
    });

    it('leaveQueue marks nothing when everything was delivered or no reason is given', async () => {
      const { leaveQueue } = await import('../delivery-budget.js');
      const s = makeSession({ endMetricSentAt: NOW });
      writeFileSync(livePath(), JSON.stringify(s));
      writeDeltas('synced');
      await leaveQueue(s, 'retry budget exhausted', NOW);
      const done = JSON.parse(readFileSync(join(sessionsDir, `completed_${ID}.json`), 'utf-8')) as Session;
      expect(done.droppedAt).toBeUndefined();
      expect(done.droppedReason).toBeUndefined();
    });

    it('leaveQueue that cannot rename saves the record as given and clears the mark it just wrote', async () => {
      const { leaveQueue } = await import('../delivery-budget.js');
      const s = makeSession({ endMetricSentAt: NOW, deliveryRealAttempts: 3, deliveryFailingSince: NOW - 25 * HOUR });
      writeFileSync(livePath(), JSON.stringify(makeSession({ endMetricSentAt: NOW })));
      writeDeltas('pending');
      expect(await leaveQueue(s, 'retry budget exhausted', NOW, async () => false)).toBe(false);
      const live = JSON.parse(readFileSync(livePath(), 'utf-8')) as Session;
      expect(live.droppedAt).toBeUndefined();
      expect(live.droppedReason).toBeUndefined();
      expect(live.deliveryRealAttempts).toBe(3);
      expect(live.deliveryFailingSince).toBe(NOW - 25 * HOUR);
    });

    it('leaveQueue that cannot rename keeps an earlier drop mark of the record', async () => {
      const { leaveQueue } = await import('../delivery-budget.js');
      const s = makeSession({ endMetricSentAt: NOW, droppedAt: NOW - HOUR, droppedReason: 'rejected by the server' });
      writeFileSync(livePath(), JSON.stringify(s));
      writeDeltas('pending');
      await leaveQueue(s, 'retry budget exhausted', NOW, async () => false);
      const live = JSON.parse(readFileSync(livePath(), 'utf-8')) as Session;
      expect(live.droppedAt).toBe(NOW - HOUR);
      expect(live.droppedReason).toBe('rejected by the server');
    });

    it('leaveQueue with no reason leaves local closes unmarked even with data unsent', async () => {
      const { leaveQueue } = await import('../delivery-budget.js');
      const s = makeSession();
      writeFileSync(livePath(), JSON.stringify(s));
      await leaveQueue(s, undefined, NOW);
      const done = JSON.parse(readFileSync(join(sessionsDir, `completed_${ID}.json`), 'utf-8')) as Session;
      expect(done.droppedAt).toBeUndefined();
    });
  });
});
