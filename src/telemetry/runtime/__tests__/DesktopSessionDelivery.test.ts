import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Session } from '@/agents/core/session/types.js';
import { logger } from '@/utils/logger.js';

const OTHER_LIVE_PID = 4_242;

vi.mock('@/utils/processes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/processes.js')>()),
  isOwnerAlive: vi.fn(async ({ pid }: { pid: number }) => pid === process.pid || pid === OTHER_LIVE_PID)
}));

vi.mock('@/providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: vi.fn(function (this: Record<string, unknown>) {
    this.getStoredCredentials = vi.fn().mockResolvedValue({ cookies: { session: 'abc123' } });
  })
}));

import { SessionStore } from '@/agents/core/session/SessionStore.js';
import { reconcileLockPath } from '@/agents/core/session/stale-session-reconciliation.js';
import { acquirePidLock } from '@/utils/pid-lock.js';
import { DesktopSessionDelivery } from '../DesktopSessionDelivery.js';
import { DesktopSessionMetrics } from '../DesktopSessionMetrics.js';
import type { DesktopTelemetryRuntimeConfig, LocalTelemetryAdapter } from '../types.js';

const T0 = new Date('2026-09-29T10:00:00Z').getTime();

const config: DesktopTelemetryRuntimeConfig = {
  clientType: 'claude-desktop',
  targetApiUrl: 'https://api.example.com',
  provider: 'ai-run-sso',
  version: '1.0.0',
  pollIntervalMs: 10_000,
  inactivityTimeoutMs: 300_000,
  port: 4001,
  gatewayKey: 'codemie-proxy'
};

let codemieHome: string;
const sync = vi.fn().mockResolvedValue({ message: 'ok' });
const sendSessionEndMetric = vi.fn().mockResolvedValue(undefined);

function sessionsDir(): string {
  return join(codemieHome, 'sessions');
}

function record(id: number, fields: Partial<Session>): Session {
  return {
    sessionId: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    agentName: 'claude-desktop',
    provider: 'ai-run-sso',
    startTime: T0 - 3_600_000,
    workingDirectory: '/Users/test/project',
    status: 'active',
    activeDurationMs: 0,
    correlation: { status: 'matched', agentSessionId: `agent-${id}`, retryCount: 0 },
    runtimeCheckpoint: { externalSessionId: `ext-${id}`, lastSeenActivityAt: T0 - 60_000 },
    ownerPid: process.pid,
    ...fields
  };
}

async function save(session: Session): Promise<Session> {
  await new SessionStore().saveSession(session);
  return session;
}

function liveFile(session: Session): string {
  return join(sessionsDir(), `${session.sessionId}.json`);
}

function completedRecord(session: Session): Session {
  return JSON.parse(readFileSync(join(sessionsDir(), `completed_${session.sessionId}.json`), 'utf-8')) as Session;
}

function createDelivery(): DesktopSessionDelivery {
  const metrics = {
    credentialsUrl: config.targetApiUrl,
    canDeliver: vi.fn().mockResolvedValue(true),
    buildProcessingContext: vi.fn().mockResolvedValue({}),
    sendSessionEndMetric
  } as unknown as DesktopSessionMetrics;
  return new DesktopSessionDelivery(
    config,
    new SessionStore(),
    { sync } as never,
    { discoverSessions: vi.fn().mockResolvedValue([]) } as unknown as LocalTelemetryAdapter,
    metrics
  );
}

describe('DesktopSessionDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    codemieHome = mkdtempSync(join(tmpdir(), 'desktop-delivery-'));
    vi.stubEnv('CODEMIE_HOME', codemieHome);
    mkdirSync(sessionsDir(), { recursive: true });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await logger.close();
    rmSync(codemieHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('closeLiveRecordsLocally', () => {
    it('closes active and undelivered completed records without sending anything', async () => {
      const active = await save(record(1, {}));
      const completed = await save(record(2, { status: 'completed', reason: 'desktop-inactive-timeout', endTime: T0 }));

      const closed = await createDelivery().closeLiveRecordsLocally(new Map([[active.sessionId, T0 - 5_000]]));

      expect(closed).toBe(true);
      expect(existsSync(liveFile(active))).toBe(false);
      expect(existsSync(liveFile(completed))).toBe(false);
      expect(completedRecord(active)).toMatchObject({
        status: 'completed',
        reason: 'desktop-analytics-disabled',
        endTime: T0 - 5_000
      });
      expect(completedRecord(active).droppedAt).toBeUndefined();
      expect(completedRecord(completed).reason).toBe('desktop-inactive-timeout');
      expect(sync).not.toHaveBeenCalled();
      expect(sendSessionEndMetric).not.toHaveBeenCalled();
    });

    it('leaves a record whose reconcile lock is held live and reports it unclosed', async () => {
      const active = await save(record(1, {}));
      const held = (await acquirePidLock(reconcileLockPath(active.sessionId), { mode: 'try' }))!;

      const closed = await createDelivery().closeLiveRecordsLocally();
      await held.release();

      expect(closed).toBe(false);
      expect(existsSync(liveFile(active))).toBe(true);
    });

    it('leaves a foreign-host record and an active record of another live daemon untouched', async () => {
      const foreign = await save(record(1, { codemieUrl: 'https://other-host.example.org' }));
      const otherDaemon = await save(record(2, { ownerPid: OTHER_LIVE_PID }));
      const otherClient = await save(record(3, { agentName: 'claude' }));

      const closed = await createDelivery().closeLiveRecordsLocally();

      expect(closed).toBe(true);
      for (const untouched of [foreign, otherDaemon, otherClient]) {
        expect(existsSync(liveFile(untouched))).toBe(true);
        expect(JSON.parse(readFileSync(liveFile(untouched), 'utf-8')).status).toBe('active');
      }
    });

    it('closes the active record of a gone daemon', async () => {
      const gone = await save(record(1, { ownerPid: 999_999 }));

      expect(await createDelivery().closeLiveRecordsLocally()).toBe(true);
      expect(completedRecord(gone).reason).toBe('desktop-analytics-disabled');
    });
  });

  describe('DesktopSessionMetrics.canDeliver', () => {
    it('is false while the switch is off and while the file is corrupt, true with usable credentials otherwise', async () => {
      const metrics = new DesktopSessionMetrics(config, new SessionStore());
      const preferences = join(codemieHome, 'claude-analytics.json');
      expect(await metrics.canDeliver()).toBe(true);

      writeFileSync(preferences, JSON.stringify({ enabled: false }));
      expect(await metrics.canDeliver()).toBe(false);

      writeFileSync(preferences, 'not json');
      expect(await metrics.canDeliver()).toBe(false);
    });
  });
});
