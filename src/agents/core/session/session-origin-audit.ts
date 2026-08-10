import { appendFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
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

/**
 * Agents whose transcript is a parent-linked entry tree rather than a flat log.
 *
 * Pi rebuilds its session from the file on every open: `_buildIndex()` takes the last
 * non-header line as the tree leaf and `buildSessionPath()` walks `parentId` upwards from
 * it to assemble the model context. A marker line carries neither `id` nor `parentId`, so
 * appending one leaves the leaf undefined, ends the walk on its first step, and every later
 * `--resume` of that transcript opens with an empty conversation — indistinguishable from a
 * new session. Ownership for these agents is carried entirely outside the transcript, by the
 * sidecar written above and by `correlation.agentSessionFile` on the session record.
 */
const TREE_STRUCTURED_TRANSCRIPT_AGENTS = new Set(['pi']);

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

  if (TREE_STRUCTURED_TRANSCRIPT_AGENTS.has(codemieAgent)) {
    logger.debug(
      `[session-origin] Skipping in-transcript marker for ${codemieAgent}: the line would become the session's tree leaf and break resume`,
    );
    return;
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
