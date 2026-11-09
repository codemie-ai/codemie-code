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
import { desktopEndTime } from '@/telemetry/runtime/desktop-session.js';
import { attemptNeverReached, authWasRejected, sendWasAttempted } from '@/providers/plugins/sso/session/bounded-request.js';
import { hasSendPath, recordHookConfig, sameHost, sendPathApiUrl } from './send-path.js';
import { getAnalyticsAuthStatus } from '@/utils/analytics-auth-status.js';
import { readJSONLTolerant } from '@/agents/core/session/utils/jsonl-reader.js';
import { getPayloadId } from '@/providers/plugins/sso/session/processors/conversations/payload-queue.js';
import { CONVERSATION_SYNC_STATUS, type ConversationPayloadRecord } from '@/providers/plugins/sso/session/processors/conversations/types.js';

/**
 * A record without an owner is finalized once idle this long.
 * ponytail: measured on one user's Claude Code transcripts of 30 days: the longest idle gap inside a
 * session 18 h; 72 h covers a weekend; other clients not measured.
 */
export const LEGACY_IDLE_MS = 72 * 60 * 60 * 1000;

/**
 * The CLI start pass handles at most this many records per start, newest `startTime` first. The Desktop passes cap
 * their `undelivered` sends by it and finalize a predecessor's records uncapped.
 */
export const RECONCILE_PER_START = 5;

/**
 * Attempts per record: past them a stranded record is finalized without its flush, an undelivered one renamed unsent.
 * An attempt is not counted when no request of it reached the server: every request it made failed before the
 * connection opened (a connection refused, an unresolved host or an unreachable network), so no server can have served it.
 */
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
export type RenameSessionFilesFn = (sessionId: string, bounds?: { deadlineMs?: number; signal?: AbortSignal }) => Promise<boolean>;

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

/** A record's last recorded activity: the latest of its start, `activityStartedAt` and latest delta, finite values only. */
export async function lastRecordedActivityAt(record: Session): Promise<number> {
  const times = [record.startTime, record.activityStartedAt ?? 0, (await maxDeltaTimestamp(record.sessionId)) ?? 0];
  return Math.max(...times.filter((time) => Number.isFinite(time)));
}

/**
 * Whether a closed record still holds data it was to send: an end metric neither sent nor skipped,
 * or — for a matched record — a metric line not synced or a conversation payload neither sent nor
 * superseded. A file that cannot be read is not delivered; a torn line in it is skipped.
 */
async function hasUndeliveredData(record: Session): Promise<boolean> {
  if (record.endMetricSentAt === undefined && record.endMetricSkipped === undefined) return true;
  if (record.correlation?.status !== 'matched') return false;
  try {
    const deltas = await readJSONLTolerant<{ syncStatus?: string }>(getSessionMetricsPath(record.sessionId), '[reconcile]');
    if (deltas.some((delta) => delta.syncStatus !== 'synced')) return true;
    const payloads = await readJSONLTolerant<ConversationPayloadRecord>(getSessionConversationPath(record.sessionId), '[reconcile]');
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

/** The mark of the server's rejection of the analytics credentials of one of `urls`, if set. */
async function invalidAuthMarker(urls: Array<string | undefined>) {
  const marker = await getAnalyticsAuthStatus();
  if (!marker) return undefined;
  const { markerAppliesToProfile } = await import('@/providers/plugins/sso/sso.auth-gate.js');
  return markerAppliesToProfile(marker, urls) ? marker : undefined;
}

/** The server rejected the analytics credentials of one of `urls`: the mark holds until a re-login or a 2xx clears it. */
export async function analyticsAuthMarkedInvalid(urls: Array<string | undefined>): Promise<boolean> {
  return (await invalidAuthMarker(urls)) !== undefined;
}

/**
 * This launch holds the credentials a delivery of the record would carry (its end metric's cookies),
 * and the server has not rejected them: the analytics auth marked invalid for this launch's host
 * holds until a re-login or a 2xx on an analytics request clears it. Without them no request is
 * made, so no attempt is spent on the record.
 */
async function hasCredentials(record: Session, env: NodeJS.ProcessEnv): Promise<boolean> {
  const marker = await invalidAuthMarker([env.CODEMIE_URL, sendPathApiUrl(env), env.CODEMIE_TARGET_API_URL]);
  if (marker) {
    logger.info(`[reconcile] Analytics auth for ${marker.baseUrl} marked invalid (${marker.reason}); its records wait for a re-login`);
    return false;
  }
  const { endMetricCookieAuth } = await import('@/cli/commands/hook/end-metric.js');
  return (await endMetricCookieAuth(env.CODEMIE_URL ?? '', await recordHookConfig(record, env, { deliver: true }))) !== undefined;
}

/** This launch's env, and its credential answer looked up once per provider for the pass that holds it. */
interface Launch {
  env: NodeJS.ProcessEnv;
  hasCredentials(record: Session): Promise<boolean>;
}

/** The answer depends only on this launch's URL and the record's provider, so a pass reuses it. */
function launchOf(env: NodeJS.ProcessEnv): Launch {
  const answers = new Map<string | undefined, Promise<boolean>>();
  return {
    env,
    hasCredentials(record) {
      let answer = answers.get(record.provider);
      if (!answer) {
        answer = hasCredentials(record, env);
        answers.set(record.provider, answer);
      }
      return answer;
    },
  };
}

/** This launch can deliver the record: same CodeMie host, a send path and credentials. */
async function canDeliver(record: Session, launch: Launch): Promise<boolean> {
  return sameHost(record, launch.env) && hasSendPath(launch.env) && (await launch.hasCredentials(record));
}

async function classifyRecord(record: Session, launch: Launch, now: number): Promise<RecordKind | undefined> {
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
    // send, or has no credentials, leaves it for one that can, without spending a slot of the cap on it
    return (await canDeliver(record, launch)) ? 'undelivered' : undefined;
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

export interface Attempt {
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

/** An attempt stopped by the pass's abort before any send is not an attempt: its counter goes back. */
async function rollBackAttempt(attempt: Attempt): Promise<void> {
  if (sendWasAttempted(attempt.signal)) return;
  await restoreCounter(attempt, 'attempt stopped before any send');
}

/**
 * Settles an attempt that ran to its end or threw: rejected credentials anywhere in it, no request of it that
 * reached the server (see {@link attemptNeverReached}), or an abort of the pass before any send, put its counter
 * back; any other outcome keeps it counted — an HTTP answer, a timeout or a reset after the send of any of its
 * requests, and the attempt's own deadline expiring included, so a record that always runs past it reaches its last attempt.
 */
export async function settleAttempt(attempt: Attempt, aborted: boolean): Promise<void> {
  if (authWasRejected(attempt.signal)) {
    // Rejected credentials are no attempt: the record waits for a re-login
    await restoreCounter(attempt, 'credentials rejected by the server');
  } else if (attemptNeverReached(attempt.signal)) {
    await restoreCounter(attempt, 'request never reached the server');
  } else if (aborted) {
    await rollBackAttempt(attempt);
  }
}

/** Puts the attempt's counter back to its value before the attempt. */
async function restoreCounter(attempt: Attempt, why: string): Promise<void> {
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
  logger.info(`[reconcile] ${attempt.sessionId}: ${why}; ${attempt.field} rolled back`);
}

interface AttemptOptions {
  kind: RecordKind;
  launch: Launch;
  pipeline: HookPipeline;
  /** The attempt's requests stop with it */
  parent: AbortSignal;
  deadlineMs?: number;
}

/**
 * A record past its attempts whose finalize still fails is closed here, nothing sent: `completed`,
 * `interrupted`, ending at its latest recorded activity, renamed — so it never holds a slot of the cap.
 */
async function closeExhaustedLocally(sessionId: string, error: unknown, options: AttemptOptions, deliver: boolean): Promise<void> {
  const current = await readLiveRecord(sessionId);
  if (!current) throw error;
  const endTime = await lastRecordedActivityAt(current);
  await new SessionStore().saveSession({ ...current, status: 'completed', reason: 'interrupted', endTime });
  // A record this launch was not to deliver (another host, no send path, legacy) is never marked
  if (deliver) await markDroppedIfUndelivered(sessionId);
  const renamed = await options.pipeline.renameSessionFiles(sessionId, { deadlineMs: options.deadlineMs, signal: options.parent });
  const msg = error instanceof Error ? error.message : String(error);
  if (renamed) {
    logger.warn(`[reconcile] ${sessionId}: finalize failed past ${MAX_ATTEMPTS} attempts (${msg}); closed locally, nothing sent`);
  } else {
    logger.warn(`[reconcile] ${sessionId}: finalize failed past ${MAX_ATTEMPTS} attempts (${msg}); not renamed, the record is still live as ${sessionId}.json`);
  }
}

/** Closes a record that takes no attempt (a gone Desktop daemon's, an unqueued one); true when it was one. */
async function closeWithoutAttempt(record: Session, options: AttemptOptions): Promise<boolean> {
  const id = record.sessionId;
  if (options.kind === 'desktop-gone') {
    const endTime = desktopEndTime(record);
    await new SessionStore().saveSession({ ...record, status: 'completed', reason: 'desktop-daemon-gone', endTime });
    logger.info(`[reconcile] ${id}: Claude Desktop record of a gone daemon closed locally (its daemon delivers it)`);
    return true;
  }
  if (options.kind === 'unqueued') {
    if (await options.pipeline.renameSessionFiles(id, { deadlineMs: options.deadlineMs, signal: options.parent })) {
      logger.info(`[reconcile] ${id}: completed record with no CodeMie host; renamed, nothing sent`);
    } else {
      logger.warn(`[reconcile] ${id}: completed record with no CodeMie host; not renamed, the record is still live as ${id}.json`);
    }
    return true;
  }
  return false;
}

/**
 * Marks a copilot-cli record closing past its attempts with its transcript unsent: its lookup could not
 * conclude, or a transcript is there and this close does not flush it. No pending data shows this, since the
 * failed passes wrote none. A record left uncorrelated had no transcript to lose.
 */
async function markTranscriptUnsent(sessionId: string): Promise<void> {
  const record = await readLiveRecord(sessionId);
  if (!record || record.correlation?.status === 'failed') return;
  await new SessionStore().saveSession({ ...record, droppedAt: Date.now() });
  logger.warn(`[reconcile] ${sessionId}: closes with its transcript unsent; marked dropped`);
}

/**
 * The synthetic end of a stranded / legacy record, delivered when this launch can. True when a
 * finalize past its attempts failed and the record was closed locally instead.
 */
async function finalizeRecord(record: Session, options: AttemptOptions, signal: AbortSignal, exhausted: boolean): Promise<boolean> {
  const { kind, launch, pipeline, deadlineMs } = options;
  const id = record.sessionId;
  const deliver = kind === 'stranded' && (await canDeliver(record, launch));
  if (exhausted) {
    logger.warn(`[reconcile] ${id}: ${kind} after ${MAX_ATTEMPTS} attempts; finalized without the flush`);
  }
  logger.info(`[reconcile] ${id}: ${kind} ${record.agentName} record; finalizing${deliver ? ' and delivering' : ' locally'}`);
  const event = await syntheticSessionEnd(record, { flush: !exhausted });
  if (exhausted && deliver && record.agentName === 'copilot-cli') await markTranscriptUnsent(id);
  try {
    await pipeline.processEvent(event, await recordHookConfig(record, launch.env, { deliver, abortSignal: signal, deadlineMs }));
  } catch (error) {
    if (!exhausted) throw error;
    await closeExhaustedLocally(id, error, options, deliver);
    return true;
  }
  if (kind === 'legacy') {
    await pipeline.renameSessionFiles(id, { deadlineMs, signal });
  }
  return false;
}

/** One attempt on a record whose lock the caller holds. */
async function attemptRecord(record: Session, options: AttemptOptions): Promise<void> {
  const { kind, launch, pipeline, parent, deadlineMs } = options;
  const id = record.sessionId;
  if (await closeWithoutAttempt(record, options)) return;

  const controller = new AbortController();
  const follow = () => controller.abort();
  parent.addEventListener('abort', follow, { once: true });
  if (parent.aborted) controller.abort();

  try {
    const field = kind === 'undelivered' ? 'deliveryAttempts' : 'finalizeAttempts';
    const { attempt, exhausted } = await beginAttempt(record, field, controller.signal);
    let closedLocally = false;
    try {
      if (kind === 'undelivered') {
        if (exhausted) {
          await markDroppedIfUndelivered(id);
          if (await pipeline.renameSessionFiles(id, { deadlineMs, signal: controller.signal })) {
            logger.warn(`[reconcile] ${id}: undelivered after ${MAX_ATTEMPTS} attempts; renamed without sending`);
          } else {
            logger.warn(`[reconcile] ${id}: undelivered after ${MAX_ATTEMPTS} attempts; not renamed, the record is still live as ${id}.json`);
          }
        } else {
          logger.info(`[reconcile] ${id}: undelivered … redeliver(attempt ${(attempt.before ?? 0) + 1}/${MAX_ATTEMPTS})`);
          await pipeline.deliverSession(id, await recordHookConfig(record, launch.env, { deliver: true, abortSignal: controller.signal, deadlineMs }));
        }
      } else {
        closedLocally = await finalizeRecord(record, options, controller.signal, exhausted);
      }
    } finally {
      // Also on a throw: a flush cut by the pass's abort, met by rejected credentials or that never reached the server is no attempt
      if (!closedLocally) await settleAttempt(attempt, controller.signal.aborted);
    }
  } finally {
    parent.removeEventListener('abort', follow);
  }
}

async function listCandidates(launch: Launch, ownSessionId: string): Promise<Session[]> {
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
    if (await classifyRecord(record, launch, now)) candidates.push(record);
  }
  return candidates
    .sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0))
    .slice(0, RECONCILE_PER_START);
}

/** One record of the start pass under its reconcile lock, skipped when another process holds it. */
async function attemptLocked(
  id: string,
  launch: Launch,
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
    const kind = record ? await classifyRecord(record, launch, Date.now()) : undefined;
    if (!record || !kind) {
      logger.debug(`[reconcile] ${id}: no longer needs handling`);
      return;
    }
    await attemptRecord(record, { kind, launch, pipeline, parent, deadlineMs: Date.now() + budgetMs });
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
    const launch = launchOf(ctx.env);
    const candidates = await listCandidates(launch, ctx.ownSessionId);
    if (candidates.length > 0) {
      logger.info(`[reconcile] ${candidates.length} record(s) to finalize or deliver`);
    }

    for (const listed of candidates) {
      if (controller.signal.aborted) return;
      await attemptLocked(listed.sessionId, launch, pipeline, controller.signal, EXIT_NETWORK_BUDGET_MS);
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
    const launch = launchOf(ctx.env);
    if (record.status === 'active') {
      logger.info(`[reconcile] Own record ${sessionId} still active at exit; finalizing it`);
      const event = await syntheticSessionEnd(record, { flush: true });
      await pipeline.processEvent(event, await recordHookConfig(record, ctx.env, { deliver: true, deadlineMs: ctx.deadlineMs }));
    } else if (record.status === 'completed' && hasSendPath(ctx.env) && (await launch.hasCredentials(record))) {
      await attemptRecord(record, {
        kind: 'undelivered',
        launch,
        pipeline,
        parent: new AbortController().signal,
        deadlineMs: ctx.deadlineMs,
      });
    }
  } finally {
    await lock.release();
  }
}
