import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCodemiePath } from '../../../utils/paths.js';
import { logger } from '../../../utils/logger.js';

const LOG_FILENAME = 'session-origin-audit.jsonl';

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
  try {
    const marker =
      JSON.stringify({
        type: 'codemie_session_start',
        uuid: randomUUID(),
        codemie_session_id: codemieSessionId,
        codemie_agent: codemieAgent,
        timestamp: new Date().toISOString(),
      }) + '\n';
    appendFileSync(transcriptPath, marker);
    logger.debug(`[session-origin] Marker written to transcript: ${transcriptPath}`);
  } catch (err) {
    logger.warn(`[session-origin] Failed to write transcript marker (non-fatal): ${err}`);
  }
}
