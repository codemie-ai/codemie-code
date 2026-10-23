/**
 * SessionStore.updateSessionLiveness guard rails.
 *
 * The owning process heartbeat is best-effort: it must never resurrect or mutate a
 * session that reconciliation (or the live hook) has already finalized, and it must
 * no-op quietly for a session the generic hook path never persisted.
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

describe('SessionStore.updateSessionLiveness', () => {
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

  it('persists the heartbeat on an active session and reports success', async () => {
    const sessionId = `liveness-${process.pid}-1`;
    sessionIds.push(sessionId);
    writeSession(sessionId);
    const liveness = { ownerRunId: sessionId, pid: 1234, host: 'test-host', lastHeartbeatAt: Date.now() };

    const written = await store.updateSessionLiveness(sessionId, liveness);

    expect(written).toBe(true);
    const saved = readSession(sessionId);
    expect(saved.liveness).toEqual(liveness);
  });

  it('does not resurrect or mutate a session already finalized (reports failure)', async () => {
    const sessionId = `liveness-${process.pid}-2`;
    sessionIds.push(sessionId);
    const endTime = Date.now() - 1_000;
    writeSession(sessionId, { status: 'completed', endTime, reason: 'exit' });

    const written = await store.updateSessionLiveness(sessionId, {
      ownerRunId: sessionId,
      pid: 1234,
      host: 'test-host',
      lastHeartbeatAt: Date.now(),
    });

    expect(written).toBe(false);
    const saved = readSession(sessionId);
    expect(saved.liveness).toBeUndefined();
    expect(saved.endTime).toBe(endTime);
  });

  it('no-ops quietly for a session that was never persisted', async () => {
    const written = await store.updateSessionLiveness('does-not-exist', {
      ownerRunId: 'does-not-exist',
      pid: 1234,
      host: 'test-host',
      lastHeartbeatAt: Date.now(),
    });

    expect(written).toBe(false);
  });

  it('clears liveness once the session is finalized (updateSessionStatus)', async () => {
    const sessionId = `liveness-${process.pid}-3`;
    sessionIds.push(sessionId);
    writeSession(sessionId, {
      liveness: { ownerRunId: sessionId, pid: 1234, host: 'test-host', lastHeartbeatAt: Date.now() },
    });

    await store.updateSessionStatus(sessionId, 'completed', 'exit');

    const saved = readSession(sessionId);
    expect(saved.liveness).toBeUndefined();
  });
});
