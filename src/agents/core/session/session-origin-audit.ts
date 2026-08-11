import { appendFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
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

export function appendTranscriptMarker(
  transcriptPath: string,
  codemieSessionId: string,
  codemieAgent: string,
): void {
  if (!transcriptPath) return;

  // CR-006: write a race-condition-free sidecar marker in ~/.codemie/sessions/ instead of
  // appending to the live Claude transcript (avoids byte-level interleaving on concurrent writes).
  // Key by the Claude session ID (transcript basename) so each distinct Claude session gets its
  // own non-overwriting marker — prevents a session resume from clobbering the prior transcript's
  // entry in the ownership index. The write is idempotent: skip if the file already exists.
  try {
    const sessionsDir = getCodemiePath('sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const claudeSessionId = basename(transcriptPath, '.jsonl');
    const sidecarPath = join(sessionsDir, `${claudeSessionId}-codemie-marker.json`);
    if (existsSync(sidecarPath)) {
      logger.debug(`[session-origin] Sidecar marker already exists for ${claudeSessionId}, skipping`);
    } else {
      writeFileSync(
        sidecarPath,
        JSON.stringify({
          transcriptPath,
          codemieSessionId,
          codemieAgent,
          timestamp: new Date().toISOString(),
        }),
        'utf-8',
      );
      logger.debug(`[session-origin] Sidecar marker written for ${claudeSessionId} (codemie: ${codemieSessionId})`);
    }
  } catch (err) {
    logger.debug(`[session-origin] Failed to write sidecar marker (non-fatal): ${err}`);
  }

  // CR-007: spec says "skip and emit debug log if transcript not yet present" (non-fatal).
  if (!existsSync(transcriptPath)) {
    logger.debug(`[session-origin] Transcript file not yet present, skipping transcript marker write`);
    return;
  }

  // Append transcript marker for self-describing backward compat (legacy sessions without sidecar).
  try {
    appendFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'codemie_session_start',
        uuid: randomUUID(),
        codemie_session_id: codemieSessionId,
        codemie_agent: codemieAgent,
        timestamp: new Date().toISOString(),
      }) + '\n',
    );
    logger.debug(`[session-origin] Marker written to transcript: ${transcriptPath}`);
  } catch (err) {
    logger.debug(`[session-origin] Failed to write transcript marker (non-fatal): ${err}`);
  }
}
