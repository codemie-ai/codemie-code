// src/agents/plugins/opencode/opencode.run-session.ts
/**
 * Which OpenCode sessions a CodeMie record's run owns: every session created inside the run window in
 * the record's directory (subagent children included), plus the session the launch named or (a continued
 * run) the one it continued. Shared by processing, the incremental-sync tick and the SessionEnd lookup; each selected
 * session is then processed here through the adapter's processors.
 */
import { latestRecordTime, type AggregatedResult, type ParsedSession, type SessionDescriptor, type SessionDiscoveryOptions } from '../../core/session/BaseSessionAdapter.js';
import type { ProcessingContext, SessionProcessor } from '../../core/session/BaseProcessor.js';
import type { Session } from '../../core/session/types.js';
import type { OpenCodeSession } from './opencode-message-types.js';
import { getOpenCodeDbPath, getAgentOpenCodeStoragePath } from './opencode.paths.js';
import { isSqliteAvailable, readSessionIdsWithMessages, readSessionsFromDb } from './opencode.sqlite-reader.js';
import { SessionStore } from '../../core/session/SessionStore.js';
import { nextRecordStart, safeRealpath } from '../../core/session/next-record-start.js';
import { logger } from '../../../utils/logger.js';

/** A record's run as located: the transcript its sessions are read from, and their OpenCode `ses_*` ids. */
export interface LocatedRun {
  transcript: string;
  /** Newest-updated first; never empty. */
  sessionIds: string[];
  /** The run's upper bound: the next record's start over the same directory; undefined when none. */
  recordsBeforeMs?: number;
}

/** Lists the legacy file-storage sessions of `storagePath` (the adapter's `discoverSessions`). */
export type DiscoverSessions = (options: SessionDiscoveryOptions, storagePath?: string) => Promise<SessionDescriptor[]>;

/**
 * The results of a run's sessions as one: per processor and in total, the latest record time; no
 * session (none of the record's in the db) → an empty success, nothing to flush.
 */
export function mergeRunResults(results: AggregatedResult[]): AggregatedResult {
  if (results.length === 1) return results[0];
  const processors: AggregatedResult['processors'] = {};
  for (const [name, result] of results.flatMap((r) => Object.entries(r.processors))) {
    const prior = processors[name];
    processors[name] = !prior ? result : {
      success: prior.success && result.success,
      message: result.message ?? prior.message,
      recordsProcessed: (prior.recordsProcessed ?? 0) + (result.recordsProcessed ?? 0),
    };
  }
  const failedProcessors = [...new Set(results.flatMap((r) => r.failedProcessors))];
  const times = results.map((r) => r.lastRecordAt).filter((t): t is number => t !== undefined);
  return {
    success: failedProcessors.length === 0,
    processors,
    totalRecords: results.reduce((sum, r) => sum + r.totalRecords, 0),
    failedProcessors,
    ...(times.length > 0 && { lastRecordAt: Math.max(...times) }),
  };
}

/** What one session of a run is processed with: the adapter's parser and its processors in priority order. */
export interface RunSessionProcessing {
  parse: (filePath: string, sessionId: string, openCodeSessionId: string | undefined) => Promise<ParsedSession>;
  processors: SessionProcessor[];
}

/** One OpenCode session of the run: parsed once, then through every processor in priority order. */
export async function processRunSession(
  processing: RunSessionProcessing,
  filePath: string,
  sessionId: string,
  context: ProcessingContext,
  openCodeSessionId: string | undefined
): Promise<AggregatedResult> {
  const parsedSession = await processing.parse(filePath, sessionId, openCodeSessionId);

  // Carry the branch resolved by the CLI through to the processors so every
  // MetricDelta is attributed to a branch (the aggregator groups on it).
  if (context.gitBranch && parsedSession.metadata) {
    (parsedSession.metadata as Record<string, unknown>).gitBranch = context.gitBranch;
  }

  return {
    ...(await runProcessors(processing.processors, parsedSession, context)),
    lastRecordAt: latestRecordTime(parsedSession.recordTimes, context.recordsBeforeMs)
  };
}

/** Every processor over one parsed session; a processor that throws counts as failed. */
async function runProcessors(processors: SessionProcessor[], parsedSession: ParsedSession, context: ProcessingContext): Promise<AggregatedResult> {
  const processorResults: AggregatedResult['processors'] = {};
  const failedProcessors: string[] = [];
  let totalRecords = 0;

  for (const processor of processors) {
    try {
      if (!processor.shouldProcess(parsedSession)) {
        logger.debug(`[opencode-adapter] Processor ${processor.name} skipped`);
        continue;
      }

      logger.debug(`[opencode-adapter] Running processor: ${processor.name}`);
      const result = await processor.process(parsedSession, context);
      const recordsProcessed = result.metadata?.recordsProcessed as number | undefined;
      processorResults[processor.name] = { success: result.success, message: result.message, recordsProcessed };

      if (!result.success) {
        failedProcessors.push(processor.name);
        logger.warn(`[opencode-adapter] Processor ${processor.name} failed: ${result.message}`);
      }
      if (typeof recordsProcessed === 'number') {
        totalRecords += recordsProcessed;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[opencode-adapter] Processor ${processor.name} threw:`, error);
      processorResults[processor.name] = { success: false, message: errorMessage };
      failedProcessors.push(processor.name);
    }
  }

  return { success: failedProcessors.length === 0, processors: processorResults, totalRecords, failedProcessors };
}

/** The result of one of a run's sessions whose processing threw: failed, named by the session and the error. */
export function failedRunSession(openCodeSessionId: string | undefined, error: unknown): AggregatedResult {
  logger.error(`[opencode-adapter] Processing OpenCode session ${openCodeSessionId} failed:`, error);
  const reason = error instanceof Error ? error.message : String(error);
  return { success: false, processors: {}, totalRecords: 0, failedProcessors: [`${openCodeSessionId}: ${reason}`] };
}

/**
 * The OpenCode sessions to parse, each in turn: a session file is its own session (`[undefined]`);
 * in the db, the context's `ses_*` id alone, else every session of the record's run by the shared
 * selection. Empty when the record is gone or none of its sessions is in the db.
 */
export async function runSessionIds(filePath: string, sessionId: string, context: ProcessingContext): Promise<Array<string | undefined>> {
  if (!filePath.endsWith('.db')) return [context.agentSessionId];
  if (context.agentSessionId?.startsWith('ses_')) return [context.agentSessionId];
  const record = await new SessionStore().loadSession(sessionId);
  const ids = record ? await recordSessionIds(filePath, record, context) : [];
  if (ids.length === 0) logger.info(`[opencode-adapter] No OpenCode session of record ${sessionId} in ${filePath}; nothing to flush`);
  return ids;
}

/** The `ses_*` ids of every session of the record's run in `dbPath`, by the shared selection. */
async function recordSessionIds(dbPath: string, record: Session, context: ProcessingContext): Promise<string[]> {
  // A `codemie hook` process never scans for later records: its window has no upper bound
  const until = context.recordsBeforeMs ?? (context.hookProcess ? undefined : await nextRecordStart(record));
  return (await dbRunSessions(dbPath, record, until)).map((c) => c.sessionId);
}

/**
 * The record's run sessions by the shared selection, in the storage of the record's agent, with the
 * run's upper bound; `discover` lists the legacy file storage when the db is unavailable.
 */
export async function locateRun(
  record: Session,
  discover: DiscoverSessions
): Promise<{ sessions: SessionDescriptor[]; recordsBeforeMs: number | undefined }> {
  const storagePath = getAgentOpenCodeStoragePath(record.agentName);
  const dbPath = getOpenCodeDbPath(storagePath);
  const recordsBeforeMs = await nextRecordStart(record);
  const sessions = dbPath && await isSqliteAvailable()
    ? await dbRunSessions(dbPath, record, recordsBeforeMs)
    // ponytail: legacy file storage lists the sessions created in the last 30 days only
    : selectRunSessions(await discover({ maxAgeDays: 30 }, storagePath), record, recordsBeforeMs);
  return { sessions, recordsBeforeMs };
}

/**
 * The located run of a record: the first session's transcript and every selected session read from
 * it, so processing takes them without selecting again; undefined when no session qualifies.
 *
 * ponytail: in legacy file storage each session is its own file, so the run carries the newest one only
 */
export function locatedRun(sessions: SessionDescriptor[], recordsBeforeMs: number | undefined): LocatedRun | undefined {
  const transcript = sessions[0]?.filePath;
  if (!transcript) return undefined;
  const sessionIds = sessions.filter((c) => c.filePath === transcript).map((c) => c.sessionId);
  return { transcript, sessionIds, ...(recordsBeforeMs !== undefined && { recordsBeforeMs }) };
}

/**
 * The record's run sessions in `dbPath` by the shared selection; for a continued run, which of the older
 * sessions has a message inside the window comes from one query.
 */
async function dbRunSessions(dbPath: string, record: Session, until: number | undefined): Promise<SessionDescriptor[]> {
  const candidates = await dbCandidates(dbPath, record);
  const older = record.continuesPriorSession ? candidates.filter((c) => c.createdAt < record.startTime).map((c) => c.sessionId) : [];
  const withRecord = await readSessionIdsWithMessages(dbPath, older, { since: record.startTime, until });
  return selectRunSessions(candidates, record, until, withRecord);
}

/**
 * The candidate sessions of a record's run in `dbPath`: those updated since the record's start (any age,
 * so a continued older session qualifies), plus the session the launch named.
 */
async function dbCandidates(dbPath: string, record: Session): Promise<SessionDescriptor[]> {
  const sessions = await readSessionsFromDb(dbPath, { updatedSince: record.startTime });
  const named = record.resumeSessionId && !sessions.some((s) => s.id === record.resumeSessionId)
    ? await readSessionsFromDb(dbPath, { id: record.resumeSessionId })
    : [];
  return [...named, ...sessions].map((session) => dbSessionDescriptor(session, dbPath));
}

/** A session row of `dbPath` as a descriptor; its path is the db file, which routes parsing to it. */
export function dbSessionDescriptor(session: OpenCodeSession, dbPath: string): SessionDescriptor {
  return {
    sessionId: session.id,
    filePath: dbPath,
    projectPath: session.directory,
    createdAt: session.time?.created ?? 0,
    updatedAt: typeof session.time?.updated === 'number' ? session.time.updated : undefined,
    agentName: 'opencode',
    ...(session.parentID && { parentId: session.parentID }),
  };
}

/**
 * The OpenCode sessions of a record's run: in the record's directory (by realpath) and created before
 * `until` (the next record's start, which owns later sessions), every session created at or after the
 * record's start (`/new` opens another inside one run; a subagent's child session too), newest-updated
 * first; the session the launch named goes first. A continued run adds the session it continued: of the
 * sessions created before the start and updated at or after it, not a subagent's child, the newest-updated
 * one with a message in the window (`withRecord`), else the newest-updated one. A record with no directory
 * selects only the session it named.
 *
 * ponytail: two concurrent runs in one directory are indistinguishable; a session only read (not
 * updated) is not selected; an earlier run's never-synced turn is sent by no later run.
 */
export function selectRunSessions(
  candidates: SessionDescriptor[],
  record: Pick<Session, 'resumeSessionId' | 'continuesPriorSession' | 'startTime' | 'workingDirectory'>,
  until: number | undefined,
  withRecord?: ReadonlySet<string>
): SessionDescriptor[] {
  const named = record.resumeSessionId ? candidates.find((c) => c.sessionId === record.resumeSessionId) : undefined;
  if (!record.workingDirectory) return named ? [named] : [];
  const directory = safeRealpath(record.workingDirectory);
  const byUpdate = candidates
    .filter((c) => c !== named && !!c.projectPath && safeRealpath(c.projectPath) === directory && (until === undefined || c.createdAt < until))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const older = record.continuesPriorSession && !record.resumeSessionId
    ? byUpdate.filter((c) => !c.parentId && c.createdAt < record.startTime && (c.updatedAt ?? 0) >= record.startTime)
    : [];
  const continued = older.find((c) => withRecord?.has(c.sessionId)) ?? older[0];
  return [...(named ? [named] : []), ...byUpdate.filter((c) => c.createdAt >= record.startTime || c === continued)];
}
