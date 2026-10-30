/**
 * Session reconciliation: every wrapper start finalizes and delivers other sessions' records.
 *
 * - `stranded` — an `active` record whose owner process (`ownerPid` + `ownerStartedAt`) is gone:
 *   finalized by a synthetic SessionEnd that ends it at its last recorded activity, and delivered
 *   when its CodeMie host is this launch's (a Claude Desktop record is only closed locally — its
 *   daemon delivers it);
 * - `undelivered` — a `completed` record still named `{id}.json`: its end metric or pending data
 *   never reached its host; delivered through this launch's send path when the host is this launch's;
 * - `legacy` — an `active` record without `ownerPid` (written before owners were recorded), idle
 *   longer than {@link LEGACY_IDLE_MS}: finalized locally, nothing sent.
 *
 * Every record is handled under its `{id}.reconcile.lock`, re-checked under it, and its attempt
 * counter is saved before the attempt, so a crash spends the attempt and a later start goes on.
 */
import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import type { HookProcessingConfig } from '@/cli/commands/hook.js';
import type { BaseHookEvent } from '../types.js';
import type { Session } from './types.js';
import { SessionStore } from './SessionStore.js';
import { getSessionConversationPath, getSessionMetricsPath, getSessionPath } from './session-config.js';
import { latestRecordTime } from './BaseSessionAdapter.js';
import { syntheticSessionEnd } from './synthetic-session-end.js';
import { nextRecordStart, SESSION_UUID_PATTERN } from './next-record-start.js';
import { EXIT_NETWORK_BUDGET_MS } from './start-pass.js';
import { getCodemiePath } from '@/utils/paths.js';
import { logger } from '@/utils/logger.js';
import { acquirePidLock } from '@/utils/pid-lock.js';
import { isOwnerAlive } from '@/utils/processes.js';
import { sendWasAttempted } from '@/providers/plugins/sso/session/bounded-request.js';
import { hasSendPath, recordHookConfig, sameHost } from './send-path.js';
import { readJSONL } from '@/providers/plugins/sso/session/utils/jsonl-reader.js';
import { getPayloadId } from '@/providers/plugins/sso/session/processors/conversations/payload-queue.js';
import { CONVERSATION_SYNC_STATUS, type ConversationPayloadRecord } from '@/providers/plugins/sso/session/processors/conversations/types.js';

/**
 * A record without an owner is finalized once idle this long.
 * ponytail: measured on one user's Claude Code transcripts of 30 days: the longest idle gap inside a
 * session 18 h; 72 h covers a weekend; other clients not measured.
 */
export const LEGACY_IDLE_MS = 72 * 60 * 60 * 1000;

/** At most this many records are handled per start, newest `startTime` first. */
export const RECONCILE_PER_START = 5;

/** Attempts per record: past them a stranded record is finalized without its flush, an undelivered one renamed unsent. */
export const MAX_ATTEMPTS = 3;

/** How long `abandon()` waits for the attempt in hand to stop and roll its own counter back. */
export const ABANDON_WAIT_MS = 500;

const LIVE_RECORD_NAME = new RegExp(`^${SESSION_UUID_PATTERN}\\.json$`, 'i');

/**
 * A live session record file: exactly `<uuid>.json` — never `completed_*`, a `*-codemie-marker.json`,
 * a generation name `<uuid>-…`, or a temp file.
 */
export function isLiveRecordFileName(name: string): boolean {
  return LIVE_RECORD_NAME.test(name);
}

/**
 * Env key (in the env a wrapper hands its in-process plugin hooks) carrying the wrapper's exit
 * deadline (epoch ms): the SessionEnd they run stops its network work there.
 */
export const EXIT_DEADLINE_ENV = 'CODEMIE_EXIT_DEADLINE_MS';

/** The lock every finalization and delivery of a session takes. */
export function reconcileLockPath(sessionId: string): string {
  return getCodemiePath('sessions', `${sessionId}.reconcile.lock`);
}

export type ProcessEventFn = (event: BaseHookEvent, config: HookProcessingConfig) => Promise<void>;
export type DeliverSessionFn = (sessionId: string, config: HookProcessingConfig) => Promise<void>;
export type RenameSessionFilesFn = (sessionId: string) => Promise<void>;

/** The hook pipeline the reconciler drives; tests replace it at this boundary. */
export interface HookPipeline {
  processEvent: ProcessEventFn;
  deliverSession: DeliverSessionFn;
  renameSessionFiles: RenameSessionFilesFn;
}

async function loadHookPipeline(overrides?: Partial<HookPipeline>): Promise<HookPipeline> {
  const hook = await import('@/cli/commands/hook.js');
  return {
    processEvent: overrides?.processEvent ?? (hook.processEvent as ProcessEventFn),
    deliverSession: overrides?.deliverSession ?? (await import('@/cli/commands/hook/delivery.js')).deliverSession,
    renameSessionFiles: overrides?.renameSessionFiles ?? (await import('./session-generation.js')).renameSessionFiles,
  };
}

/** The record at `{id}.json` exactly (no `completed_` fallback); undefined when missing or unreadable. */
export async function readLiveRecord(sessionId: string): Promise<Session | undefined> {
  try {
    return JSON.parse(await readFile(getSessionPath(sessionId), 'utf-8')) as Session;
  } catch {
    return undefined;
  }
}

/** The latest delta `timestamp` (epoch ms) already in `{id}_metrics.jsonl`; undefined when none. */
export async function maxDeltaTimestamp(sessionId: string): Promise<number | undefined> {
  let content: string;
  try {
    content = await readFile(getSessionMetricsPath(sessionId), 'utf-8');
  } catch {
    return undefined;
  }
  return latestRecordTime(content.split('\n').map((line) => {
    try {
      return (JSON.parse(line) as { timestamp?: number | string }).timestamp;
    } catch {
      // A blank line, or a torn last line after a hard kill
      return undefined;
    }
  }));
}

/**
 * Whether a closed record still holds data it was to send: an end metric neither sent nor skipped,
 * or — for a matched record — a metric line not synced or a conversation payload neither sent nor
 * superseded. Lines that cannot be read are not delivered.
 */
async function hasUndeliveredData(record: Session): Promise<boolean> {
  if (record.endMetricSentAt === undefined && record.endMetricSkipped === undefined) return true;
  if (record.correlation?.status !== 'matched') return false;
  try {
    const deltas = await readJSONL<{ syncStatus?: string }>(getSessionMetricsPath(record.sessionId));
    if (deltas.some((delta) => delta.syncStatus !== 'synced')) return true;
    const payloads = await readJSONL<ConversationPayloadRecord>(getSessionConversationPath(record.sessionId));
    const sent = new Set(payloads.filter((p) => p.status === CONVERSATION_SYNC_STATUS.SUCCESS).map(getPayloadId));
    return payloads.some((p) =>
      (p.status === CONVERSATION_SYNC_STATUS.PENDING || p.status === CONVERSATION_SYNC_STATUS.FAILED) && !sent.has(getPayloadId(p)));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[reconcile] ${record.sessionId}: cannot read its pending data; counted undelivered: ${msg}`);
    return true;
  }
}

/** Writes `droppedAt` into the live `{id}.json` when it leaves the delivery queue with data still unsent. */
export async function markDroppedIfUndelivered(sessionId: string): Promise<void> {
  const record = await readLiveRecord(sessionId);
  if (!record || !(await hasUndeliveredData(record))) return;
  await new SessionStore().saveSession({ ...record, droppedAt: Date.now() });
  logger.warn(`[reconcile] ${sessionId}: leaves the delivery queue with data unsent; marked dropped`);
}

// ---------------------------------------------------------------------------
// The start pass
// ---------------------------------------------------------------------------

type RecordKind = 'stranded' | 'desktop-gone' | 'undelivered' | 'unqueued' | 'legacy';

/** When a legacy record was last seen active: its start, activity, latest delta and transcript write. */
async function legacyLastActivity(record: Session): Promise<number> {
  const times = [record.startTime, record.activityStartedAt ?? 0, (await maxDeltaTimestamp(record.sessionId)) ?? 0];
  const transcript = record.correlation?.agentSessionFile;
  if (transcript && (await nextRecordStart(record)) === undefined) {
    const info = await stat(transcript).catch(() => null);
    if (info) times.push(info.mtimeMs);
  }
  return Math.max(...times.filter((time) => Number.isFinite(time)));
}

async function classifyRecord(record: Session, env: NodeJS.ProcessEnv, now: number): Promise<RecordKind | undefined> {
  if (record.status === 'active') {
    if (record.ownerPid !== undefined) {
      if (await isOwnerAlive({ pid: record.ownerPid, startedAt: record.ownerStartedAt })) return undefined;
      return record.agentName === 'claude-desktop' ? 'desktop-gone' : 'stranded';
    }
    // A Desktop record without an owner is the daemon's
    if (record.agentName === 'claude-desktop' || typeof record.startTime !== 'number') return undefined;
    return now - (await legacyLastActivity(record)) > LEGACY_IDLE_MS ? 'legacy' : undefined;
  }
  if (record.status === 'completed' && record.agentName !== 'claude-desktop') {
    // A live owner delivers its own record at its exit
    if (record.ownerPid !== undefined && (await isOwnerAlive({ pid: record.ownerPid, startedAt: record.ownerStartedAt }))) {
      return undefined;
    }
    if (!record.codemieUrl) return 'unqueued';
    // Another host's record is delivered by a launch against that host; a launch that cannot
    // send leaves it for one that can, without spending a slot of the cap on it
    return sameHost(record, env) && hasSendPath(env) ? 'undelivered' : undefined;
  }
  return undefined;
}

export interface ReconcileContext {
  /** This launch's env: its CodeMie URL, send path and profile */
  env: NodeJS.ProcessEnv;
  /** This launch's own session, never handled by the pass */
  ownSessionId: string;
  /** Replaces parts of the hook pipeline (tests) */
  pipeline?: Partial<HookPipeline>;
}

export interface ReconcilePass {
  /** Settles when the pass is done; never rejects */
  done: Promise<void>;
  /**
   * Stops the pass: aborts its requests and waits up to {@link ABANDON_WAIT_MS} for the attempt in
   * hand to stop, which rolls its counter back itself unless a send already ran for it. That
   * record's lock stays held while its attempt may still be writing: the pass releases it once the
   * attempt stops, and a lock left at process exit names a dead holder, so the next process
   * reclaims it at once.
   */
  abandon(): Promise<void>;
}

interface Attempt {
  sessionId: string;
  field: 'finalizeAttempts' | 'deliveryAttempts';
  before: number | undefined;
  signal: AbortSignal;
}

/** Saves the record with its counter + 1 BEFORE the attempt; returns the attempt to roll back. */
async function beginAttempt(
  record: Session,
  field: Attempt['field'],
  signal: AbortSignal
): Promise<{ attempt: Attempt; exhausted: boolean }> {
  const before = record[field];
  const exhausted = (before ?? 0) >= MAX_ATTEMPTS;
  await new SessionStore().saveSession({ ...record, [field]: (before ?? 0) + 1 });
  return { attempt: { sessionId: record.sessionId, field, before, signal }, exhausted };
}

/** An attempt stopped by the abort / deadline before any send is not an attempt: its counter goes back. */
async function rollBackAttempt(attempt: Attempt): Promise<void> {
  if (sendWasAttempted(attempt.signal)) return;
  const store = new SessionStore();
  const record = await store.loadSession(attempt.sessionId);
  if (!record) return;
  const restored: Session = { ...record };
  if (attempt.before === undefined) {
    delete restored[attempt.field];
  } else {
    restored[attempt.field] = attempt.before;
  }
  await store.saveSession(restored);
  logger.info(`[reconcile] ${attempt.sessionId}: attempt stopped before any send; ${attempt.field} rolled back`);
}

interface AttemptOptions {
  kind: RecordKind;
  env: NodeJS.ProcessEnv;
  pipeline: HookPipeline;
  /** The attempt's requests stop with it */
  parent: AbortSignal;
  deadlineMs?: number;
}

/**
 * A record past its attempts whose finalize still fails is closed here, nothing sent: `completed`,
 * `interrupted`, ending at its latest recorded activity, renamed — so it never holds a slot of the cap.
 */
async function closeExhaustedLocally(sessionId: string, error: unknown, pipeline: HookPipeline, deliver: boolean): Promise<void> {
  const current = await readLiveRecord(sessionId);
  if (!current) throw error;
  const times = [current.startTime, current.activityStartedAt ?? 0, (await maxDeltaTimestamp(sessionId)) ?? 0];
  const endTime = Math.max(...times.filter((time) => Number.isFinite(time)));
  await new SessionStore().saveSession({ ...current, status: 'completed', reason: 'interrupted', endTime });
  // A record this launch was not to deliver (another host, no send path, legacy) is never marked
  if (deliver) await markDroppedIfUndelivered(sessionId);
  await pipeline.renameSessionFiles(sessionId);
  const msg = error instanceof Error ? error.message : String(error);
  logger.warn(`[reconcile] ${sessionId}: finalize failed past ${MAX_ATTEMPTS} attempts (${msg}); closed locally, nothing sent`);
}

/** Closes a record that takes no attempt (a gone Desktop daemon's, an unqueued one); true when it was one. */
async function closeWithoutAttempt(record: Session, kind: RecordKind, pipeline: HookPipeline): Promise<boolean> {
  const id = record.sessionId;
  if (kind === 'desktop-gone') {
    const checkpoint = record.runtimeCheckpoint;
    const times = [record.startTime, checkpoint?.lastSeenActivityAt ?? 0, checkpoint?.lastDiscoveredAt ?? 0];
    const endTime = Math.max(...times.filter((time) => Number.isFinite(time)));
    await new SessionStore().saveSession({ ...record, status: 'completed', reason: 'desktop-daemon-gone', endTime });
    logger.info(`[reconcile] ${id}: Claude Desktop record of a gone daemon closed locally (its daemon delivers it)`);
    return true;
  }
  if (kind === 'unqueued') {
    logger.info(`[reconcile] ${id}: completed record with no CodeMie host; renamed, nothing sent`);
    await pipeline.renameSessionFiles(id);
    return true;
  }
  return false;
}

/**
 * The synthetic end of a stranded / legacy record, delivered when this launch can. True when a
 * finalize past its attempts failed and the record was closed locally instead.
 */
async function finalizeRecord(record: Session, options: AttemptOptions, signal: AbortSignal, exhausted: boolean): Promise<boolean> {
  const { kind, env, pipeline, deadlineMs } = options;
  const id = record.sessionId;
  const deliver = kind === 'stranded' && sameHost(record, env) && hasSendPath(env);
  if (exhausted) {
    logger.warn(`[reconcile] ${id}: ${kind} after ${MAX_ATTEMPTS} attempts; finalized without the flush`);
  }
  logger.info(`[reconcile] ${id}: ${kind} ${record.agentName} record; finalizing${deliver ? ' and delivering' : ' locally'}`);
  const event = await syntheticSessionEnd(record, { flush: !exhausted });
  try {
    await pipeline.processEvent(event, recordHookConfig(record, env, { deliver, abortSignal: signal, deadlineMs }));
  } catch (error) {
    if (!exhausted) throw error;
    await closeExhaustedLocally(id, error, pipeline, deliver);
    return true;
  }
  if (kind === 'legacy') {
    await pipeline.renameSessionFiles(id);
  }
  return false;
}

/** One attempt on a record whose lock the caller holds. */
async function attemptRecord(record: Session, options: AttemptOptions): Promise<void> {
  const { kind, env, pipeline, parent, deadlineMs } = options;
  const id = record.sessionId;
  if (await closeWithoutAttempt(record, kind, pipeline)) return;

  const controller = new AbortController();
  const follow = () => controller.abort();
  parent.addEventListener('abort', follow, { once: true });
  if (parent.aborted) controller.abort();
  const stopped = () => controller.signal.aborted || (deadlineMs !== undefined && Date.now() >= deadlineMs);

  try {
    const field = kind === 'undelivered' ? 'deliveryAttempts' : 'finalizeAttempts';
    const { attempt, exhausted } = await beginAttempt(record, field, controller.signal);

    if (kind === 'undelivered') {
      if (exhausted) {
        logger.warn(`[reconcile] ${id}: undelivered after ${MAX_ATTEMPTS} attempts; renamed without sending`);
        await markDroppedIfUndelivered(id);
        await pipeline.renameSessionFiles(id);
      } else {
        logger.info(`[reconcile] ${id}: undelivered … redeliver(attempt ${(attempt.before ?? 0) + 1}/${MAX_ATTEMPTS})`);
        await pipeline.deliverSession(id, recordHookConfig(record, env, { deliver: true, abortSignal: controller.signal, deadlineMs }));
      }
    } else if (await finalizeRecord(record, options, controller.signal, exhausted)) {
      return;
    }

    if (stopped()) {
      await rollBackAttempt(attempt);
    }
  } finally {
    parent.removeEventListener('abort', follow);
  }
}

async function listCandidates(env: NodeJS.ProcessEnv, ownSessionId: string): Promise<Session[]> {
  const sessionsDir = getCodemiePath('sessions');
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return [];
  }

  const now = Date.now();
  const candidates: Session[] = [];
  for (const name of names) {
    if (!isLiveRecordFileName(name)) continue;
    let record: Session;
    try {
      record = JSON.parse(await readFile(join(sessionsDir, name), 'utf-8')) as Session;
    } catch {
      continue;
    }
    if (record.sessionId !== name.slice(0, -'.json'.length) || record.sessionId === ownSessionId) continue;
    if (await classifyRecord(record, env, now)) candidates.push(record);
  }
  return candidates
    .sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0))
    .slice(0, RECONCILE_PER_START);
}

/** One record of the start pass under its reconcile lock, skipped when another process holds it. */
async function attemptLocked(
  id: string,
  env: NodeJS.ProcessEnv,
  pipeline: HookPipeline,
  parent: AbortSignal,
  budgetMs: number
): Promise<void> {
  const lock = await acquirePidLock(reconcileLockPath(id), { mode: 'try' });
  if (!lock) {
    logger.info(`[reconcile] ${id}: held by another process; skipped`);
    return;
  }
  try {
    if (parent.aborted) return;
    // Re-checked under the lock: another process may have handled it meanwhile
    const record = await readLiveRecord(id);
    const kind = record ? await classifyRecord(record, env, Date.now()) : undefined;
    if (!record || !kind) {
      logger.debug(`[reconcile] ${id}: no longer needs handling`);
      return;
    }
    await attemptRecord(record, { kind, env, pipeline, parent, deadlineMs: Date.now() + budgetMs });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[reconcile] ${id}: failed: ${msg}`);
  } finally {
    await lock.release();
  }
}

/**
 * The start pass over other sessions' records: stranded, undelivered and legacy records are
 * finalized / delivered, at most {@link RECONCILE_PER_START} per start, newest first; each record's
 * attempt stops its network work and saves `EXIT_NETWORK_BUDGET_MS` after it starts, so a lock it
 * holds is never held longer.
 *
 * ponytail: the directory is listed and every record parsed per call; a transcript parse is
 * whole-file and synchronous in the wrapper's process — at most 5 records per start.
 */
export function reconcileOtherSessions(ctx: ReconcileContext): ReconcilePass {
  const controller = new AbortController();

  const run = async (): Promise<void> => {
    const pipeline = await loadHookPipeline(ctx.pipeline);
    const candidates = await listCandidates(ctx.env, ctx.ownSessionId);
    if (candidates.length > 0) {
      logger.info(`[reconcile] ${candidates.length} record(s) to finalize or deliver`);
    }

    for (const listed of candidates) {
      if (controller.signal.aborted) return;
      await attemptLocked(listed.sessionId, ctx.env, pipeline, controller.signal, EXIT_NETWORK_BUDGET_MS);
    }
  };

  const done = run().catch((error: unknown) => {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn(`[reconcile] Start pass failed: ${msg}`);
  });

  return {
    done,
    async abandon() {
      controller.abort();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([done, new Promise<void>((resolve) => { timer = setTimeout(resolve, ABANDON_WAIT_MS); })]);
      clearTimeout(timer);
    },
  };
}

// ---------------------------------------------------------------------------
// The wrapper's own record at exit
// ---------------------------------------------------------------------------

export interface OwnRecordContext {
  /** The wrapper's env (its CodeMie URL and send path) */
  env: NodeJS.ProcessEnv;
  /** The exit budget's deadline (epoch ms), shared by the lock wait and the sends */
  deadlineMs: number;
  /** Replaces parts of the hook pipeline (tests) */
  pipeline?: Partial<HookPipeline>;
}

/**
 * The wrapper's own record at exit, under its reconcile lock (waited for until the deadline):
 * still `active` → the synthetic end through the live proxy; `completed` but not delivered
 * (`{id}.json`) → delivered now; `completed_*` → nothing.
 */
export async function finalizeOwnRecord(sessionId: string, ctx: OwnRecordContext): Promise<void> {
  const lock = await acquirePidLock(reconcileLockPath(sessionId), { mode: 'wait', deadlineMs: ctx.deadlineMs });
  if (!lock) {
    logger.info(`[reconcile] Own record ${sessionId} still locked at the exit deadline; left for the next start`);
    return;
  }
  try {
    const record = await readLiveRecord(sessionId);
    if (!record) return;
    const pipeline = await loadHookPipeline(ctx.pipeline);
    if (record.status === 'active') {
      logger.info(`[reconcile] Own record ${sessionId} still active at exit; finalizing it`);
      const event = await syntheticSessionEnd(record, { flush: true });
      await pipeline.processEvent(event, recordHookConfig(record, ctx.env, { deliver: true, deadlineMs: ctx.deadlineMs }));
    } else if (record.status === 'completed' && hasSendPath(ctx.env)) {
      await attemptRecord(record, {
        kind: 'undelivered',
        env: ctx.env,
        pipeline,
        parent: new AbortController().signal,
        deadlineMs: ctx.deadlineMs,
      });
    }
  } finally {
    await lock.release();
  }
}
