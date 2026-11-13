/**
 * Session Store
 *
 * Manages persistence of session data to JSON files.
 * One file per session: ~/.codemie/sessions/{sessionId}.json
 */

import { readFile, writeFile, mkdir, readdir, rename, rm } from 'fs/promises';
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { dirname, basename, join } from 'path';
import type { Session } from './types.js';
import { getSessionPath } from './session-config.js';
import { generationSetFiles, recordGeneration } from './session-generation.js';
import { getCodemiePath } from '../../../utils/paths.js';
import { logger } from '../../../utils/logger.js';
import { createErrorContext, formatErrorForLog, PathSecurityError } from '../../../utils/errors.js';

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeAtomic(path: string, session: Session): Promise<void> {
  // Never ends in `.json`, so readers listing the directory skip it.
  const tmpPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(session, null, 2), 'utf-8');
    await rename(tmpPath, path);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

function larger(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.max(a, b);
}

function earlier(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.min(a, b);
}

/**
 * The saving copy wins, except delivery marks it lacks, attempt counters lower than the other copy's, and an earlier
 * failing-since clock (unless the saving copy cleared it); `droppedReason` travels with the `droppedAt` it pairs with.
 */
function mergeCompleted(saving: Session, other: Session): Session {
  return {
    ...saving,
    endMetricSentAt: saving.endMetricSentAt ?? other.endMetricSentAt,
    endMetricSkipped: saving.endMetricSkipped ?? other.endMetricSkipped,
    legacyMetricsConsent: saving.legacyMetricsConsent ?? other.legacyMetricsConsent,
    legacyMetricsWithheld: saving.legacyMetricsWithheld ?? other.legacyMetricsWithheld,
    droppedAt: saving.droppedAt ?? other.droppedAt,
    droppedReason: saving.droppedAt !== undefined ? saving.droppedReason : other.droppedReason,
    // `null` is an explicit clear (a successful attempt ended the failing streak): the other copy's older clock must not return
    deliveryFailingSince: saving.deliveryFailingSince === null
      ? undefined
      : earlier(saving.deliveryFailingSince, other.deliveryFailingSince ?? undefined),
    deliveryRealAttempts: larger(saving.deliveryRealAttempts, other.deliveryRealAttempts),
    deliveryAttemptedAt: larger(saving.deliveryAttemptedAt, other.deliveryAttemptedAt),
    deliveryAttempts: larger(saving.deliveryAttempts, other.deliveryAttempts),
    localFinalizeFailures: larger(saving.localFinalizeFailures, other.localFinalizeFailures),
  };
}

/** The record's native session id when it names one: set, not `'unknown'`, not the record's own CodeMie id (a placeholder). */
function realNativeId(record: Session): string | undefined {
  const id = record.correlation?.agentSessionId;
  return id && id !== 'unknown' && id !== record.sessionId ? id : undefined;
}

function sameGeneration(a: Session, b: Session): boolean {
  return a.startTime === b.startTime && a.correlation?.agentSessionId === b.correlation?.agentSessionId;
}

export class SessionStore {
  /**
   * Save session to disk, atomically (a temp file renamed over the target).
   *
   * Target: `completed_{sessionId}.json` only for a `completed` record whose live
   * `{sessionId}.json` is gone and whose `completed_` file exists (a record loaded
   * through the fallback stays where it is); every other save → `{sessionId}.json`,
   * except a not-`completed` copy of the generation already in `completed_` (same agent
   * session id and start time): a stale copy saved after the rename, dropped — also when the
   * rename lands while an `active` copy is being written. A `completed` copy written to
   * `{sessionId}.json` while its generation is renamed to `completed_` is merged into that
   * `completed_` file (its fields, plus the delivery marks and larger attempt counters the
   * other process saved there) and `{sessionId}.json` is removed. A live `{sessionId}.json` of
   * another generation (another start time or real native id; `completed`, or `active` with no end) is not written
   * over (a read-then-write window of microseconds remains; the reconcile lock, which `saveSession` does not take,
   * would close it): a `completed` copy is merged into the moved-aside set of its own generation, any other copy
   * is dropped.
   */
  async saveSession(session: Session): Promise<void> {
    if (/[/\\]/.test(session.sessionId)) {
      throw new PathSecurityError(session.sessionId, 'session id contains a path separator');
    }
    const livePath = getSessionPath(session.sessionId);
    const completedPath = join(dirname(livePath), `completed_${basename(livePath)}`);
    const renamed = !existsSync(livePath) && existsSync(completedPath);
    if (!renamed && (await this.keptOffOtherGeneration(livePath, session))) {
      return;
    }
    if (renamed && session.status !== 'completed' && (await this.isCompletedGeneration(completedPath, session))) {
      logger.info(`[SessionStore] Not recreating ${session.sessionId}.json: its generation is already completed`);
      return;
    }
    const sessionPath = renamed && session.status === 'completed' ? completedPath : livePath;
    const completedBefore =
      session.status === 'completed' && sessionPath === livePath ? await readIfExists(completedPath) : undefined;

    try {
      // Ensure directory exists
      const dir = dirname(sessionPath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      await writeAtomic(sessionPath, session);
      // The live record may have been renamed to completed_ while this copy was being written.
      if (
        session.status === 'active' &&
        sessionPath === livePath &&
        existsSync(completedPath) &&
        (await this.isCompletedGeneration(completedPath, session))
      ) {
        await rm(livePath, { force: true });
        logger.info(`[SessionStore] Removed ${session.sessionId}.json saved over its generation completed meanwhile`);
        return;
      }
      if (
        session.status === 'completed' &&
        sessionPath === livePath &&
        (await readIfExists(completedPath)) !== completedBefore &&
        (await this.isCompletedGeneration(completedPath, session))
      ) {
        const other = JSON.parse(await readFile(completedPath, 'utf-8')) as Session;
        await writeAtomic(completedPath, mergeCompleted(session, other));
        await this.removeIfSameGeneration(livePath, session);
        logger.info(`[SessionStore] Merged ${session.sessionId}.json into its generation completed meanwhile`);
        return;
      }

      logger.debug(`[SessionStore] Saved session: ${session.sessionId}`);
    } catch (error) {
      const errorContext = createErrorContext(error, { sessionId: session.sessionId });
      logger.error(`[SessionStore] Failed to save session: ${session.sessionId}`, formatErrorForLog(errorContext));
      throw error;
    }
  }

  /**
   * A live `{id}.json` of another generation (another start time, or another real native session id
   * on both; a placeholder id is no generation) is never written over: a stale
   * `completed` copy is merged into its own generation's set, a stale `active` one is dropped. True
   * when the copy was handled so; false when `{id}.json` is absent, unreadable, of this generation,
   * or no valid live record (`active` with an end: the fresh build repairs it by writing over).
   */
  private async keptOffOtherGeneration(livePath: string, session: Session): Promise<boolean> {
    const raw = await readIfExists(livePath);
    if (raw === undefined) return false;
    let live: Session;
    try {
      live = JSON.parse(raw) as Session;
    } catch {
      return false;
    }
    const liveNative = realNativeId(live);
    const copyNative = realNativeId(session);
    const otherNative = liveNative !== undefined && copyNative !== undefined && liveNative !== copyNative;
    if (live.startTime === session.startTime && !otherNative) return false;
    if (live.status !== 'completed' && !(live.status === 'active' && live.endTime === undefined)) return false;
    if (session.status === 'completed') {
      await this.mergeIntoGenerationSet(session, live);
      return true;
    }
    logger.info(
      `[SessionStore] Not saving ${session.sessionId}.json: it holds another generation ` +
      `(startTime ${live.startTime}, this copy's ${session.startTime})`
    );
    return true;
  }

  /**
   * Merges a stale `completed` copy into the moved-aside set of its generation (same start time and
   * agent session id, among the generation's record files `completed_<id>-<generation>*.json` and a plain
   * `completed_<id>.json` of it), keeping the delivery marks and the
   * larger attempt counters already there. No such set: the copy has no home and is dropped.
   */
  private async mergeIntoGenerationSet(session: Session, live: Session): Promise<void> {
    const generation = recordGeneration(session);
    // A set renamed since its read (to its generation name) is followed by listing the files once more
    for (let pass = 0; pass < 2 && generation !== undefined; pass++) {
      let moved = false;
      for (const path of generationSetFiles(session.sessionId, generation)) {
        let other: Session;
        try {
          other = JSON.parse(await readFile(path, 'utf-8')) as Session;
        } catch (error) {
          logger.warn(`[SessionStore] Unreadable ${basename(path)}; not merging the completed copy of ${session.sessionId} into it`, error);
          continue;
        }
        if (sameGeneration(other, session)) {
          // ponytail: a set renamed away since the read is not recreated, but a rename landing between
          // this check and the write still is, and one landing between the listing and the read is logged
          // as unreadable and not followed; holding the reconcile lock would close both windows
          moved = !existsSync(path);
          if (moved) break;
          await writeAtomic(path, mergeCompleted(session, other));
          logger.info(`[SessionStore] Merged a completed copy into ${basename(path)}: ${session.sessionId}.json holds another generation (startTime ${live.startTime})`);
          return;
        }
      }
      if (!moved) break;
    }
    logger.info(
      `[SessionStore] Not saving a completed copy of ${session.sessionId} (startTime ${session.startTime}): ` +
      `${session.sessionId}.json holds another generation (startTime ${live.startTime}) and no set of this one was moved aside`
    );
  }

  private async isCompletedGeneration(completedPath: string, session: Session): Promise<boolean> {
    let completed: Session;
    try {
      completed = JSON.parse(await readFile(completedPath, 'utf-8')) as Session;
    } catch (error) {
      logger.warn(`[SessionStore] Unreadable ${basename(completedPath)}; saving ${session.sessionId}.json`, error);
      return false;
    }
    return sameGeneration(completed, session);
  }

  /** A newer generation's start may have written `{id}.json` since this save; that record stays. */
  private async removeIfSameGeneration(livePath: string, session: Session): Promise<void> {
    let live: Session;
    try {
      live = JSON.parse(await readFile(livePath, 'utf-8')) as Session;
    } catch (error) {
      logger.debug(`[SessionStore] Leaving ${basename(livePath)} in place: unreadable after the merge`, error);
      return;
    }
    if (!sameGeneration(live, session)) {
      logger.debug(`[SessionStore] Leaving ${basename(livePath)} in place: a different generation wrote it meanwhile`);
      return;
    }
    await rm(livePath, { force: true });
  }

  /**
   * Load session from disk
   *
   * Falls back to the 'completed_' prefixed filename when the primary path is
   * not found. This handles the race where handleSessionEnd renames
   * {sessionId}.json → completed_{sessionId}.json before the final SSO sync runs.
   */
  async loadSession(sessionId: string): Promise<Session | null> {
    let sessionPath = getSessionPath(sessionId);

    if (!existsSync(sessionPath)) {
      // Fallback: session may have been renamed with 'completed_' prefix by handleSessionEnd
      const completedPath = join(dirname(sessionPath), `completed_${basename(sessionPath)}`);
      if (existsSync(completedPath)) {
        sessionPath = completedPath;
        logger.debug(`[SessionStore] Using completed session file: ${sessionId}`);
      } else {
        logger.debug(`[SessionStore] Session file not found: ${sessionId}`);
        return null;
      }
    }

    try {
      const content = await readFile(sessionPath, 'utf-8');
      const session = JSON.parse(content) as Session;

      logger.debug(`[SessionStore] Loaded session: ${sessionId}`);
      return session;
    } catch (error) {
      const errorContext = createErrorContext(error, { sessionId });
      logger.error(`[SessionStore] Failed to load session: ${sessionId}`, formatErrorForLog(errorContext));
      return null;
    }
  }

  /**
   * Find a persisted session by external/local-client session identifier.
   */
  async findSessionByExternalId(agentName: string, externalSessionId: string): Promise<Session | null> {
    const sessionsDir = getCodemiePath('sessions');
    if (!existsSync(sessionsDir)) {
      return null;
    }

    try {
      const files = await readdir(sessionsDir);
      const sessionFiles = files.filter((file) => file.endsWith('.json'));

      for (const file of sessionFiles) {
        const filePath = join(sessionsDir, file);
        try {
          const content = await readFile(filePath, 'utf-8');
          const session = JSON.parse(content) as Session;

          if (session.agentName !== agentName) {
            continue;
          }

          if (session.runtimeCheckpoint?.externalSessionId === externalSessionId) {
            logger.debug(`[SessionStore] Found session by external ID: ${externalSessionId}`);
            return session;
          }
        } catch (error) {
          logger.debug('[SessionStore] Skipping unreadable session file during external ID lookup', {
            filePath,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } catch (error) {
      const errorContext = createErrorContext(error, { sessionId: externalSessionId });
      logger.error('[SessionStore] Failed external session scan', formatErrorForLog(errorContext));
    }

    return null;
  }

  /**
   * Map external/local-client session identifiers to CodeMie session ids in one directory scan.
   * Lets long-running pollers resolve known sessions with loadSession() instead of rescanning
   * every session file per lookup. `keep` leaves out records another process owns.
   */
  async indexSessionsByExternalId(agentName: string, keep?: (session: Session) => boolean): Promise<Map<string, string>> {
    const index = new Map<string, string>();
    const sessionsDir = getCodemiePath('sessions');
    if (!existsSync(sessionsDir)) {
      return index;
    }

    try {
      const files = await readdir(sessionsDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const filePath = join(sessionsDir, file);
        try {
          const session = JSON.parse(await readFile(filePath, 'utf-8')) as Session;
          const externalSessionId = session.runtimeCheckpoint?.externalSessionId;
          if (
            session.agentName === agentName
            && (!keep || keep(session))
            && externalSessionId
            && !index.has(externalSessionId)
          ) {
            index.set(externalSessionId, session.sessionId);
          }
        } catch (error) {
          logger.debug('[SessionStore] Skipping unreadable session file during external ID indexing', {
            filePath,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } catch (error) {
      const errorContext = createErrorContext(error, { agent: agentName });
      logger.error('[SessionStore] Failed external session indexing', formatErrorForLog(errorContext));
    }

    return index;
  }

  /**
   * Update session status and reason; a final status sets `endTime` (`endTime` when given, else now)
   */
  async updateSessionStatus(sessionId: string, status: Session['status'], reason?: string, endTime?: number): Promise<void> {
    const session = await this.loadSession(sessionId);

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.status = status;
    if (reason) {
      session.reason = reason;
    }
    if (status === 'completed' || status === 'recovered' || status === 'failed') {
      session.endTime = endTime ?? Date.now();
    }

    await this.saveSession(session);
  }

  /**
   * Start activity tracking for a session
   * Sets activityStartedAt to current time if not already set (prevents double-counting)
   *
   * @param sessionId - The session ID to start tracking
   */
  async startActivityTracking(sessionId: string): Promise<void> {
    const session = await this.loadSession(sessionId);

    if (!session) {
      logger.warn(`[SessionStore] Cannot start activity tracking - session not found: ${sessionId}`);
      return;
    }

    // Guard: skip if already tracking (prevents double-counting from multiple prompts without Stop)
    if (session.activityStartedAt !== undefined) {
      logger.debug(`[SessionStore] Activity tracking already started for session: ${sessionId}`);
      return;
    }

    session.activityStartedAt = Date.now();
    await this.saveSession(session);

    logger.debug(`[SessionStore] Started activity tracking for session: ${sessionId}`);
  }

  /**
   * Accumulate active duration for a session
   * Calculates duration since activityStartedAt, adds to activeDurationMs, clears activityStartedAt
   *
   * @param sessionId - The session ID to accumulate duration for
   * @param upTo - End of the active period (epoch ms); default now. A period ending before it started adds 0.
   * @returns The duration accumulated in this call (0 if no active period)
   */
  async accumulateActiveDuration(sessionId: string, upTo?: number): Promise<number> {
    const session = await this.loadSession(sessionId);

    if (!session) {
      logger.warn(`[SessionStore] Cannot accumulate duration - session not found: ${sessionId}`);
      return 0;
    }

    // Guard: return 0 if no active period (Stop without UserPromptSubmit)
    if (session.activityStartedAt === undefined) {
      logger.debug(`[SessionStore] No active period to accumulate for session: ${sessionId}`);
      return 0;
    }

    const duration = Math.max(0, (upTo ?? Date.now()) - session.activityStartedAt);
    session.activeDurationMs = (session.activeDurationMs || 0) + duration;
    session.activityStartedAt = undefined; // Clear to mark as idle

    await this.saveSession(session);

    logger.debug(`[SessionStore] Accumulated ${duration}ms for session: ${sessionId} (total: ${session.activeDurationMs}ms)`);

    return duration;
  }
}
