import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { SessionStore } from '@/agents/core/session/SessionStore.js';
import type { Session } from '@/agents/core/session/types.js';
import { hostOf } from '@/agents/core/session/send-path.js';
import { renameSessionFiles } from '@/agents/core/session/session-generation.js';
import {
  attemptResult,
  isLiveRecordFileName,
  LEGACY_IDLE_MS,
  readLiveRecord,
  RECONCILE_PER_START,
  reconcileLockPath
} from '@/agents/core/session/stale-session-reconciliation.js';
import { beginRealAttempt, budgetSpent, leaveQueue, noteOutcome } from '@/agents/core/session/delivery-budget.js';
import { isDeliveryDone } from '@/cli/commands/hook/delivery.js';
import { authWasRejected, type RequestOutcome } from '@/providers/plugins/sso/session/bounded-request.js';
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
    await this.deliverLocked(completed, { flush: true });
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
   * processed locally, nothing sent, and it waits for a re-login. Every other delivery is one real attempt, saved before
   * any send and reported to the delivery budget after it: the failing clock and the attempt counter follow the outcome of
   * its requests, and a spent budget takes the record out of the queue, marked dropped when data is still unsent. A failed
   * send is logged, never thrown: the record stays `{id}.json`.
   */
  private async deliverLocked(record: Session, options: { flush: boolean }): Promise<void> {
    const sessionId = record.sessionId;
    if (!(await this.metrics.canDeliver())) {
      logger.info('[desktop-telemetry] No usable analytics credentials; record kept for a re-login, nothing sent', { sessionId });
      await this.sessionStore.saveSession(record);
      if (options.flush) {
        await this.flushTranscript(record, false);
      }
      return;
    }
    // Never aborted: it only tags this attempt's requests, so the API clients can note a credential rejection and what became of each request
    const signal = new AbortController().signal;
    const begun = beginRealAttempt(record);
    await this.sessionStore.saveSession(begun);

    const thrown = await this.sendRecord(begun, options.flush, signal);
    // Rejected credentials never spend the budget, whatever else the attempt's requests noted (an SSO login page on 200 among them)
    const outcome: RequestOutcome = authWasRejected(signal) ? 'auth' : attemptResult(signal, thrown);
    if (await this.reportOutcome(sessionId, outcome)) return;
    await this.renameToCompleted(sessionId);
  }

  /** Reports the attempt's outcome to the delivery budget; true when the spent budget took the record out of the queue. */
  private async reportOutcome(sessionId: string, outcome: RequestOutcome): Promise<boolean> {
    const live = await readLiveRecord(sessionId);
    if (!live) return false;
    const now = Date.now();
    const next = noteOutcome(live, outcome, now);
    const reason = budgetSpent(next, outcome, now);
    if (!reason) {
      await this.sessionStore.saveSession(next);
      return false;
    }
    if (!(await leaveQueue(next, reason, now))) return false;
    logger.warn('[desktop-telemetry] Delivery budget spent; renamed without sending', { sessionId, reason });
    return true;
  }

  /** The final flush when asked, the sync and the end-metric send of one delivery; each failure is logged, never thrown. Whether one threw. */
  private async sendRecord(record: Session, flush: boolean, signal: AbortSignal): Promise<boolean> {
    const sessionId = record.sessionId;
    let thrown = false;
    if (flush) {
      await this.flushTranscript(record, true, signal);
    }
    try {
      await this.syncer.sync(sessionId, await this.metrics.buildProcessingContext(record, undefined, signal));
    } catch (error) {
      thrown = true;
      logger.warn('[desktop-telemetry] Sync of a completed session failed; kept for a later attempt', {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    try {
      await this.metrics.sendSessionEndMetric((await this.sessionStore.loadSession(sessionId)) ?? record, signal);
    } catch (error) {
      thrown = true;
      logger.warn('[desktop-telemetry] Session END metric failed; kept for a later attempt', {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return thrown;
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
   * owner is delivered as a real attempt (of this daemon's host; another host's gone `active` record is
   * closed locally `desktop-daemon-gone`, its `completed` one left as it is). Every `DESKTOP_REDELIVERY_INTERVAL_MS`: undelivered records
   * only, each also a real attempt; only a counted failure past the retry window with 3 real attempts drops a record, so an
   * outage of any length never does. Every
   * `restart`, `legacy` and `foreign-gone` record is handled, first: one left `active` would be re-tracked by the
   * first poll with the downtime inside its stretch. Of the `undelivered` ones each pass takes at most
   * {@link RECONCILE_PER_START}, newest `startTime` first, so their sends stay bounded; the rest wait for a later
   * pass, and a host that never answers keeps its records in the queue.
   */
  async reconcileRecords(atStart: boolean): Promise<void> {
    for (const sessionId of await this.listCandidates(atStart)) {
      try {
        const lock = await acquirePidLock(reconcileLockPath(sessionId), { mode: 'try' });
        if (!lock) {
          logger.debug('[desktop-telemetry] Record held by another process; skipped', { sessionId });
          continue;
        }
        try {
          const record = await readLiveRecord(sessionId);
          const kind = record && await this.classifyRecord(record, atStart);
          if (record && kind) {
            await this.reconcileRecord(record, kind);
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

  /**
   * The ids of the live records this pass acts on: every start-time kind first, uncapped, so no dead daemon's
   * `active` record is left for the first poll; then the `undelivered` ones, newest `startTime` first, at most
   * {@link RECONCILE_PER_START}, which bounds the pass's sends.
   */
  private async listCandidates(atStart: boolean): Promise<string[]> {
    const sessionsDir = getCodemiePath('sessions');
    let names: string[];
    try {
      names = await readdir(sessionsDir);
    } catch {
      return [];
    }

    const atStartKinds: string[] = [];
    const undelivered: Array<{ sessionId: string; startTime: number }> = [];
    for (const name of names) {
      if (!isLiveRecordFileName(name)) {
        continue;
      }
      const sessionId = name.slice(0, -'.json'.length);
      try {
        const listed = JSON.parse(await readFile(join(sessionsDir, name), 'utf-8')) as Session;
        const kind = await this.classifyRecord(listed, atStart);
        if (kind === 'undelivered') {
          undelivered.push({ sessionId, startTime: listed.startTime ?? 0 });
        } else if (kind === 'restart' || kind === 'legacy' || kind === 'foreign-gone') {
          atStartKinds.push(sessionId);
        } else if (kind !== undefined) {
          logger.warn('[desktop-telemetry] Record of an unknown kind skipped', { sessionId, kind });
        }
      } catch (error) {
        logger.warn('[desktop-telemetry] Record listing failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    const capped = undelivered
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, RECONCILE_PER_START)
      .map(candidate => candidate.sessionId);
    return [...atStartKinds, ...capped];
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

  private async reconcileRecord(record: Session, kind: RecordKind): Promise<void> {
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
      });
      // A record the CLI closed locally was never flushed
      await this.deliverLocked(record, { flush: record.reason === 'desktop-daemon-gone' });
    }
  }
}
