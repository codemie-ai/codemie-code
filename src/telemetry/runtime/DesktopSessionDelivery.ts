import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import type { SessionStore } from '@/agents/core/session/SessionStore.js';
import type { Session } from '@/agents/core/session/types.js';
import { hostOf } from '@/agents/core/session/send-path.js';
import { renameSessionFiles } from '@/agents/core/session/session-generation.js';
import {
  isLiveRecordFileName,
  LEGACY_IDLE_MS,
  markDroppedIfUndelivered,
  MAX_ATTEMPTS,
  readLiveRecord,
  reconcileLockPath,
  settleAttempt
} from '@/agents/core/session/stale-session-reconciliation.js';
import { isDeliveryDone } from '@/cli/commands/hook/delivery.js';
import type { SessionSyncer } from '@/providers/plugins/sso/session/SessionSyncer.js';
import type {
  DesktopTelemetryRuntimeConfig,
  LocalTelemetryAdapter,
  LocalTelemetryDiscoveredSession
} from '@/telemetry/runtime/types.js';
import type { DesktopSessionMetrics } from '@/telemetry/runtime/DesktopSessionMetrics.js';
import { desktopEndTime, isForeignRecord, type RecordKind } from '@/telemetry/runtime/desktop-session.js';
import { logger } from '@/utils/logger.js';
import { isOwnerAlive } from '@/utils/processes.js';
import { acquirePidLock } from '@/utils/pid-lock.js';
import { getCodemiePath } from '@/utils/paths.js';

/** The processing, finalization, delivery and start-up / re-delivery reconciliation of Desktop records. */
export class DesktopSessionDelivery {
  constructor(
    private readonly config: DesktopTelemetryRuntimeConfig,
    private readonly sessionStore: SessionStore,
    private readonly syncer: SessionSyncer,
    private readonly adapter: LocalTelemetryAdapter,
    private readonly metrics: DesktopSessionMetrics
  ) {}

  /** `sync: false` keeps it local: the pending data is written, nothing is sent. */
  async processSession(
    session: Session,
    discovered: LocalTelemetryDiscoveredSession,
    sync: boolean,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const parsedSession = await this.adapter.parseSession(discovered, session.sessionId);
    const context = await this.metrics.buildProcessingContext(session, discovered, abortSignal);

    // Persisted with the session, so a crash before this point still applies it next time.
    const baselineCutoffMs = session.runtimeCheckpoint?.baselineCutoffMs;
    if (baselineCutoffMs !== undefined && this.adapter.applyBaseline) {
      await this.adapter.applyBaseline(parsedSession, baselineCutoffMs, context);
      if (!parsedSession.subagentsIncomplete) {
        delete session.runtimeCheckpoint!.baselineCutoffMs;
      }
    }

    const result = await this.adapter.processParsedSession(parsedSession, context);

    if (sync && result.totalRecords > 0) {
      const syncResult = await this.syncer.sync(session.sessionId, context);
      logger.info('[desktop-telemetry] Session synced', {
        sessionId: session.sessionId,
        externalSessionId: discovered.externalSessionId,
        totalRecords: result.totalRecords,
        syncMessage: syncResult.message
      });
    }
  }

  /** `completed` at its last activity, then delivered as one counted attempt; the caller holds the lock. */
  async finalizeLocked(session: Session, reason: string, trackedActivityAt?: number): Promise<void> {
    const completed: Session = {
      ...session,
      status: 'completed',
      reason,
      endTime: desktopEndTime(session, trackedActivityAt)
    };
    await this.deliverLocked(completed, { countAttempt: true, flush: true });
    logger.info('[desktop-telemetry] Session finalized', {
      sessionId: session.sessionId,
      reason,
      endTime: completed.endTime,
      repository: session.repository,
      gitBranch: session.gitBranch,
    });
  }

  /**
   * One delivery of a `completed` record — its final flush when asked, the sync of its pending data, its end
   * metric — then the `completed_*` rename once delivered; the caller holds the reconcile lock. Without
   * usable credentials (no stored cookies, or the analytics auth marked invalid) the record is saved, its flush
   * processed locally, nothing sent, and it waits for a re-login. A counted attempt saves the record with `deliveryAttempts` + 1 before any send and
   * gives it back when the server rejected the credentials; past {@link MAX_ATTEMPTS} the record is renamed
   * without sending. A failed send is logged, never thrown: the record stays `{id}.json`.
   */
  private async deliverLocked(record: Session, options: { countAttempt: boolean; flush: boolean }): Promise<void> {
    const sessionId = record.sessionId;
    if (!(await this.metrics.canDeliver())) {
      logger.info('[desktop-telemetry] No usable analytics credentials; record kept for a re-login, nothing sent', { sessionId });
      await this.sessionStore.saveSession(record);
      if (options.flush) {
        await this.flushTranscript(record, false);
      }
      return;
    }
    // Never aborted: it only tags this attempt's requests, so the API clients can note a credential rejection
    const signal = new AbortController().signal;
    if (options.countAttempt) {
      const attempts = record.deliveryAttempts ?? 0;
      if (attempts >= MAX_ATTEMPTS) {
        logger.warn('[desktop-telemetry] Undelivered after the last attempt; renamed without sending', { sessionId, attempts });
        await this.sessionStore.saveSession(record);
        await markDroppedIfUndelivered(sessionId);
        await renameSessionFiles(sessionId);
        return;
      }
      await this.sessionStore.saveSession({ ...record, deliveryAttempts: attempts + 1 });
    }

    if (options.flush) {
      await this.flushTranscript(record, true, signal);
    }
    try {
      await this.syncer.sync(sessionId, await this.metrics.buildProcessingContext(record, undefined, signal));
    } catch (error) {
      logger.warn('[desktop-telemetry] Sync of a completed session failed; kept for a later attempt', {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    try {
      await this.metrics.sendSessionEndMetric((await this.sessionStore.loadSession(sessionId)) ?? record, signal);
    } catch (error) {
      logger.warn('[desktop-telemetry] Session END metric failed; kept for a later attempt', {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    if (options.countAttempt) {
      await settleAttempt({ sessionId, field: 'deliveryAttempts', before: record.deliveryAttempts, signal }, false);
    }
    await this.renameToCompleted(sessionId);
  }

  /** The final transcript processing of a session, its transcript rediscovered; a failure is logged. */
  private async flushTranscript(session: Session, sync: boolean, abortSignal?: AbortSignal): Promise<void> {
    const externalSessionId = session.runtimeCheckpoint?.externalSessionId;
    if (!externalSessionId) {
      return;
    }
    try {
      const sinceMs = Math.max(
        0,
        (session.runtimeCheckpoint?.lastSeenActivityAt
          ?? session.runtimeCheckpoint?.lastDiscoveredAt
          ?? session.startTime) - this.config.pollIntervalMs
      );
      const discoveredSessions = await this.adapter.discoverSessions(sinceMs);
      const discovered = discoveredSessions.find(
        candidate => candidate.externalSessionId === externalSessionId
      );

      if (discovered) {
        await this.processSession(session, discovered, sync, abortSignal);
      } else {
        logger.warn('[desktop-telemetry] Failed to rediscover session during finalization', {
          sessionId: session.sessionId,
          externalSessionId
        });
      }
    } catch (error) {
      logger.warn('[desktop-telemetry] Final transcript processing failed', {
        sessionId: session.sessionId,
        externalSessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /** Renames the live set `completed_*` once delivered: its end metric sent or skipped, no data pending. */
  private async renameToCompleted(sessionId: string): Promise<void> {
    const record = await readLiveRecord(sessionId);
    if (!record) {
      return;
    }
    const delivered = await isDeliveryDone(sessionId, {
      agentName: this.config.clientType,
      sessionId,
      provider: this.config.provider,
      ssoUrl: this.config.syncCodeMieUrl,
      syncApiUrl: this.config.syncApiUrl
    });
    if (!delivered) {
      logger.info('[desktop-telemetry] Session not fully delivered yet; kept for a later attempt', { sessionId });
      return;
    }
    await renameSessionFiles(sessionId);
  }

  /**
   * The daemon's pass over its client's live records, each under its reconcile lock (skipped while another
   * process holds it) and re-checked under it. At start: an `active` record whose owning daemon is gone is
   * finalized at its last activity (`desktop-daemon-restart`), an ownerless (legacy) `active` one idle longer
   * than {@link LEGACY_IDLE_MS} is closed locally (nothing sent), and an undelivered `completed` one with an
   * owner is delivered as a counted attempt (of this daemon's host; another host's gone `active` record is
   * closed locally `desktop-daemon-gone`, its `completed` one left as it is). Every `DESKTOP_REDELIVERY_INTERVAL_MS`: undelivered records
   * only, no attempt counted, so an outage of any length on a live daemon never drops a record unsent.
   */
  async reconcileRecords(atStart: boolean): Promise<void> {
    const sessionsDir = getCodemiePath('sessions');
    let names: string[];
    try {
      names = await readdir(sessionsDir);
    } catch {
      return;
    }

    for (const name of names) {
      if (!isLiveRecordFileName(name)) {
        continue;
      }
      const sessionId = name.slice(0, -'.json'.length);
      try {
        const listed = JSON.parse(await readFile(join(sessionsDir, name), 'utf-8')) as Session;
        if (!(await this.classifyRecord(listed, atStart))) {
          continue;
        }
        const lock = await acquirePidLock(reconcileLockPath(sessionId), { mode: 'try' });
        if (!lock) {
          logger.debug('[desktop-telemetry] Record held by another process; skipped', { sessionId });
          continue;
        }
        try {
          const record = await readLiveRecord(sessionId);
          const kind = record && await this.classifyRecord(record, atStart);
          if (record && kind) {
            await this.reconcileRecord(record, kind, atStart);
          }
        } finally {
          await lock.release();
        }
      } catch (error) {
        logger.warn('[desktop-telemetry] Record reconciliation failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  /** The kind of a listed record this pass acts on; a record of another CodeMie host is never delivered. */
  private async classifyRecord(record: Session, atStart: boolean): Promise<RecordKind | undefined> {
    if (record.agentName !== this.config.clientType) {
      return undefined;
    }
    const foreign = isForeignRecord(record, this.metrics.credentialsUrl);
    // Never a legacy record: re-delivering ownerless records sent duplicate end metrics
    if (record.status === 'completed') {
      return record.ownerPid !== undefined && !foreign ? 'undelivered' : undefined;
    }
    if (!atStart || record.status !== 'active') {
      return undefined;
    }
    if (record.ownerPid === undefined) {
      return Date.now() - desktopEndTime(record) > LEGACY_IDLE_MS ? 'legacy' : undefined;
    }
    if (await isOwnerAlive({ pid: record.ownerPid, startedAt: record.ownerStartedAt })) {
      return undefined;
    }
    return foreign ? 'foreign-gone' : 'restart';
  }

  private async reconcileRecord(record: Session, kind: RecordKind, atStart: boolean): Promise<void> {
    if (kind === 'restart') {
      logger.info('[desktop-telemetry] Record of a gone daemon — finalizing', {
        sessionId: record.sessionId,
        ownerPid: record.ownerPid,
      });
      await this.finalizeLocked(record, 'desktop-daemon-restart');
    } else if (kind === 'foreign-gone') {
      logger.info('[desktop-telemetry] Record of another CodeMie host\'s gone daemon — closed locally, its daemon delivers it', {
        sessionId: record.sessionId,
        host: hostOf(record.codemieUrl),
      });
      await this.sessionStore.saveSession({
        ...record,
        status: 'completed',
        reason: 'desktop-daemon-gone',
        endTime: desktopEndTime(record)
      });
    } else if (kind === 'legacy') {
      logger.info('[desktop-telemetry] Legacy record idle past the limit — closed locally, nothing sent', {
        sessionId: record.sessionId,
      });
      await this.sessionStore.saveSession({
        ...record,
        status: 'completed',
        reason: 'interrupted',
        endTime: desktopEndTime(record)
      });
      await renameSessionFiles(record.sessionId);
    } else {
      logger.info('[desktop-telemetry] Undelivered record — delivering', {
        sessionId: record.sessionId,
        reason: record.reason,
        countAttempt: atStart,
      });
      // A record the CLI closed locally was never flushed
      await this.deliverLocked(record, { countAttempt: atStart, flush: record.reason === 'desktop-daemon-gone' });
    }
  }
}
