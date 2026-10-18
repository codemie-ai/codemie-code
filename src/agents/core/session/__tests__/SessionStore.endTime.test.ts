/**
 * SessionStore endTime/asOf threading.
 *
 * `updateSessionStatus` and `accumulateActiveDuration` must honour an explicit
 * endTime/asOf timestamp instead of always stamping `Date.now()` — otherwise a
 * session finalized after the fact (stale-session reconciliation, restart
 * reconciliation) gets billed for the gap between its real last activity and
 * whenever the finalizing code happened to run.
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { SessionStore } from '../SessionStore.js';
import { getSessionPath } from '../session-config.js';
import { getCodemiePath } from '../../../../utils/paths.js';

function writeSession(sessionId: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    getSessionPath(sessionId),
    JSON.stringify({
      sessionId,
      agentName: 'claude',
      provider: 'jwt',
      startTime: Date.now() - 60_000,
      workingDirectory: '/tmp',
      status: 'active',
      activeDurationMs: 0,
      correlation: { status: 'matched', retryCount: 0 },
      ...extra,
    })
  );
}

function readSession(sessionId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(getSessionPath(sessionId), 'utf-8'));
}

describe('SessionStore endTime/asOf threading', () => {
  const store = new SessionStore();
  const sessionIds: string[] = [];

  beforeEach(() => {
    mkdirSync(getCodemiePath('sessions'), { recursive: true });
  });

  afterEach(() => {
    for (const id of sessionIds.splice(0)) {
      const p = getSessionPath(id);
      if (existsSync(p)) rmSync(p, { force: true });
    }
  });

  describe('updateSessionStatus', () => {
    it('stamps endTime at the provided timestamp, not at call time', async () => {
      const sessionId = `endtime-update-${process.pid}-1`;
      sessionIds.push(sessionId);
      writeSession(sessionId);
      const pastEndTime = Date.now() - 45_000;

      await store.updateSessionStatus(sessionId, 'completed', 'desktop-daemon-restart-stale', pastEndTime);

      const saved = readSession(sessionId);
      expect(saved.endTime).toBe(pastEndTime);
      expect(saved.reason).toBe('desktop-daemon-restart-stale');
    });

    it('defaults endTime to now when none is provided (unchanged live-hook behaviour)', async () => {
      const sessionId = `endtime-update-${process.pid}-2`;
      sessionIds.push(sessionId);
      writeSession(sessionId);
      const before = Date.now();

      await store.updateSessionStatus(sessionId, 'completed', 'exit');

      const saved = readSession(sessionId) as { endTime: number };
      expect(saved.endTime).toBeGreaterThanOrEqual(before);
      expect(saved.endTime).toBeLessThanOrEqual(Date.now());
    });

    it('does not stamp endTime for a non-terminal status regardless of the endTime argument', async () => {
      const sessionId = `endtime-update-${process.pid}-3`;
      sessionIds.push(sessionId);
      writeSession(sessionId);

      await store.updateSessionStatus(sessionId, 'active', undefined, Date.now() - 1_000);

      const saved = readSession(sessionId);
      expect(saved.endTime).toBeUndefined();
    });
  });

  describe('accumulateActiveDuration', () => {
    it('accumulates duration up to the provided asOf, not up to call time', async () => {
      const startTime = Date.now() - 60_000;
      const activityStartedAt = startTime + 10_000;
      const asOf = activityStartedAt + 5_000; // 5s of real activity, long before "now"
      const sessionId = `endtime-accum-${process.pid}-1`;
      sessionIds.push(sessionId);
      writeSession(sessionId, { startTime, activityStartedAt });

      const accumulated = await store.accumulateActiveDuration(sessionId, asOf);

      expect(accumulated).toBe(5_000);
      const saved = readSession(sessionId);
      expect(saved.activeDurationMs).toBe(5_000);
      expect(saved.activityStartedAt).toBeUndefined();
    });

    it('clamps to zero when asOf predates activityStartedAt (defensive backstop)', async () => {
      const startTime = Date.now() - 60_000;
      const activityStartedAt = startTime + 50_000;
      const badAsOf = activityStartedAt - 1_000;
      const sessionId = `endtime-accum-${process.pid}-2`;
      sessionIds.push(sessionId);
      writeSession(sessionId, { startTime, activityStartedAt });

      const accumulated = await store.accumulateActiveDuration(sessionId, badAsOf);

      expect(accumulated).toBe(0);
      const saved = readSession(sessionId);
      expect(saved.activeDurationMs).toBe(0);
    });

    it('clamps to the session lifetime when asOf would otherwise exceed it', async () => {
      const startTime = Date.now() - 10_000;
      const activityStartedAt = startTime - 50_000; // stale activityStartedAt from before the session "started"
      const asOf = startTime + 3_000;
      const sessionId = `endtime-accum-${process.pid}-3`;
      sessionIds.push(sessionId);
      writeSession(sessionId, { startTime, activityStartedAt });

      const accumulated = await store.accumulateActiveDuration(sessionId, asOf);

      // Raw delta (asOf - activityStartedAt) would be 53s; clamped to asOf - startTime (3s).
      expect(accumulated).toBe(3_000);
    });

    it('defaults asOf to now when none is provided (unchanged live-hook behaviour)', async () => {
      const activityStartedAt = Date.now() - 1_000;
      const sessionId = `endtime-accum-${process.pid}-4`;
      sessionIds.push(sessionId);
      writeSession(sessionId, { activityStartedAt });

      const accumulated = await store.accumulateActiveDuration(sessionId);

      expect(accumulated).toBeGreaterThanOrEqual(1_000);
    });
  });
});
