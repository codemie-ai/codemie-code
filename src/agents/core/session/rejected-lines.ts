import type { Session } from './types.js';
import { getSessionConversationPath, getSessionMetricsPath } from './session-config.js';
import { legacyMetricsWithheld } from './legacy-metrics-gate.js';
import { readJSONLTolerant } from '@/agents/core/session/utils/jsonl-reader.js';
import { getPayloadId } from '@/providers/plugins/sso/session/processors/conversations/payload-queue.js';
import { CONVERSATION_SYNC_STATUS, type ConversationPayloadRecord } from '@/providers/plugins/sso/session/processors/conversations/types.js';
import { logger } from '@/utils/logger.js';

/**
 * Whether the record holds data the server refused for good (a metric line or a conversation payload `rejected`, a JSON
 * 400/409/422) that was never delivered another way. Such a line is terminal, so it no longer keeps the record queued; the
 * record leaving the queue with one is a drop that must be reported. A file that cannot be read counts as none.
 */
export async function hasRejectedData(record: Session): Promise<boolean> {
  try {
    if (!legacyMetricsWithheld(record)) {
      const deltas = await readJSONLTolerant<{ syncStatus?: string }>(getSessionMetricsPath(record.sessionId), '[rejected-lines]');
      if (deltas.some((delta) => delta.syncStatus === 'rejected')) return true;
    }
    const payloads = await readJSONLTolerant<ConversationPayloadRecord>(getSessionConversationPath(record.sessionId), '[rejected-lines]');
    const sent = new Set(payloads.filter((p) => p.status === CONVERSATION_SYNC_STATUS.SUCCESS).map(getPayloadId));
    return payloads.some((p) => p.status === CONVERSATION_SYNC_STATUS.REJECTED && !sent.has(getPayloadId(p)));
  } catch (error) {
    logger.warn(`[delivery] ${record.sessionId}: cannot read its rejected data: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Stamps the drop of a record that is about to leave the queue while holding a rejected line, when nothing stamped it
 * yet (the caller holds the record's reconcile lock). Every path that renames a record goes through here, so a rejection
 * the sync met outside a reported attempt is still named by the exit notice.
 */
export async function stampRejectedLines(sessionId: string): Promise<void> {
  try {
    // Loaded here: SessionStore imports the session-generation module this one is called from
    const { SessionStore } = await import('./SessionStore.js');
    const store = new SessionStore();
    const record = await store.loadSession(sessionId);
    if (!record || record.droppedAt !== undefined || !(await hasRejectedData(record))) return;
    await store.saveSession({ ...record, droppedAt: Date.now(), droppedReason: 'rejected by the server' });
    logger.warn(`[delivery] ${sessionId}: leaves the delivery queue with data the server rejected; marked dropped`);
  } catch (error) {
    logger.warn(`[delivery] ${sessionId}: cannot stamp its rejected data: ${error instanceof Error ? error.message : String(error)}`);
  }
}
