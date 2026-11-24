import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getCodemiePath } from '../../../utils/paths.js';
import { logger } from '../../../utils/logger.js';
import { SESSION_ORIGIN, SESSION_ORIGIN_ENV_KEY } from './types.js';
import type { Session } from './types.js';

const LOG_FILENAME = 'session-origin-audit.jsonl';

/**
 * Whether a session must never be ingested (metrics, conversations, transcript markers).
 *
 * The persisted Session record is the single source of truth: once `origin` was written,
 * it alone decides — a stale env var can never reclassify a session whose record says
 * 'codemie'. The env var is the same fact held by the original decision-maker (AgentCLI),
 * consulted only when the record is silent, so the session still fails closed if the
 * record was never written: `createSessionRecord()` swallows write errors and returns
 * early when agent/provider config is missing (see hook.ts), and records predating this
 * field have no origin at all.
 */
export function isExternalOrigin(session: Pick<Session, 'origin'> | null | undefined): boolean {
  if (session?.origin !== undefined) {
    return session.origin === SESSION_ORIGIN.EXTERNAL_RESUME;
  }
  return process.env[SESSION_ORIGIN_ENV_KEY] === SESSION_ORIGIN.EXTERNAL_RESUME;
}

export type AuditEventName =
  | 'transcript_marker_written'
  | 'resume_blocked'
  | 'resume_external_confirmed';

export function appendAuditEvent(
  event: AuditEventName,
  data: Record<string, unknown>,
  logsDir?: string,
): void {
  try {
    const dir = logsDir ?? getCodemiePath('logs');
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), event, data }) + '\n';
    appendFileSync(join(dir, LOG_FILENAME), line);
  } catch {
    // non-fatal — audit log write failure must never break a user session
  }
}

/** A shared sqlite store (opencode.db) holds every run's sessions, so it is no record's own transcript. */
export function isSharedTranscriptStore(transcriptPath: string | undefined): boolean {
  return !!transcriptPath && transcriptPath.endsWith('.db');
}

/**
 * Records that CodeMie owns a transcript, in a sidecar of CodeMie's own sessions directory;
 * the transcript itself is never touched, since the agent owns its bytes (pi, for one,
 * rebuilds a session from every line of it).
 *
 * One sidecar per (CodeMie session, transcript), named `<path hash>-<codemieSessionId>-codemie-marker.json`:
 * the hash leads so a listing of a session's files by its id never picks a sidecar up. A run that
 * spans several transcripts (pi) gets one per transcript. The first write wins (exclusive create),
 * so a rerun for the same pair is a no-op.
 */
export function writeOwnershipMarker(
  transcriptPath: string,
  codemieSessionId: string,
  codemieAgent: string,
): void {
  if (!transcriptPath) return;
  if (isSharedTranscriptStore(transcriptPath)) {
    logger.debug('[session-origin] shared transcript store; no ownership marker');
    return;
  }

  try {
    const sessionsDir = getCodemiePath('sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const pathHash = createHash('sha256').update(transcriptPath).digest('hex').slice(0, 8);
    const sidecarPath = join(sessionsDir, `${pathHash}-${codemieSessionId}-codemie-marker.json`);
    writeFileSync(
      sidecarPath,
      JSON.stringify({
        transcriptPath,
        codemieSessionId,
        codemieAgent,
        timestamp: new Date().toISOString(),
      }),
      { encoding: 'utf-8', flag: 'wx' },
    );
    logger.debug(`[session-origin] Sidecar marker written for ${transcriptPath} (codemie: ${codemieSessionId})`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      logger.debug(`[session-origin] Sidecar marker already exists for ${transcriptPath}, skipping`);
      return;
    }
    logger.debug(`[session-origin] Failed to write sidecar marker (non-fatal): ${err}`);
  }
}
