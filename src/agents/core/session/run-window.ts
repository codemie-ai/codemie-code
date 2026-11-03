/**
 * The run window of a record: its own slice of a shared transcript, [`startTime`, the next CodeMie
 * record's `startTime`), with what bounds a wait on the metrics lock.
 */
import type { ProcessingContext } from './BaseProcessor.js';
import { SessionStore } from './SessionStore.js';
import { nextRecordStart } from './next-record-start.js';
import type { RunWindow } from '@/providers/plugins/sso/session/processors/metrics/MetricsWriter.js';
import { lockBoundsOf } from '@/providers/plugins/sso/session/utils/locked-jsonl.js';
import { SessionRecordNotFoundError } from '@/utils/errors.js';

/**
 * The upper bound is the context's, else the later-record scan of a wrapper / daemon process; a
 * `codemie hook` process has none.
 * @throws {SessionRecordNotFoundError} When neither the live nor the `completed_` record exists
 */
export async function resolveRunWindow(sessionId: string, context?: ProcessingContext): Promise<RunWindow> {
  const record = await new SessionStore().loadSession(sessionId);
  if (!record) {
    throw new SessionRecordNotFoundError(sessionId);
  }
  const upperBound = context?.recordsBeforeMs ?? (context?.hookProcess ? undefined : await nextRecordStart(record));
  return { ...lockBoundsOf(context), startTime: record.startTime, upperBound };
}
