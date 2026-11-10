import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { writeDestinationMarker, type DestinationMarker } from '@/agents/core/evidence/accepted-marker.js';
import { withSessionLock } from './session-lock.js';
import { readStatus, writeStatus } from './session-status.js';

/*
 * A destination marker (EPMCDME-17054, see accepted-marker.ts) the forwarder could not write is never just dropped: the
 * answer it records came with a batch whose cursor then advances, so no later batch would bring it again. It is kept
 * as an intent in the session status (the spool's own durable state) BEFORE the cursor advances; the legacy gate reads
 * the intent as the marker itself, the sweep retries the write and keeps the status until it succeeds.
 */

const MARKERS: readonly DestinationMarker[] = ['accepted', 'ended'];

/**
 * Writes the marker, else records the intent. Outside the session lock; never throws. 'lost' (both failed) leaves the
 * legacy gate without this answer: an acceptance then keeps the legacy path withheld (fail closed); an end is still
 * read from the status's `endingDiscard` until the status is swept.
 */
export async function recordDestinationMarker(
  marker: DestinationMarker,
  key: string,
  sessionId: string
): Promise<'marker' | 'intent' | 'lost'> {
  try {
    await writeDestinationMarker(marker, key, sessionId);
    return 'marker';
  } catch (err) {
    logger.debug('[otlp-destination] marker not written; kept as an intent', ...sanitizeLogArgs({ sessionId, marker, err: err instanceof Error ? err.message : String(err) }));
  }
  try {
    await withSessionLock(sessionId, async () => {
      const status = await readStatus(sessionId);
      if (!status) throw new Error('no session status');
      const intent = status.destinationIntent?.key === key ? status.destinationIntent : { key };
      status.destinationIntent = { ...intent, [marker]: true };
      await writeStatus(sessionId, status);
    });
    return 'intent';
  } catch {
    logger.warn('[otlp-destination] destination marker lost', ...sanitizeLogArgs({ sessionId, marker }));
    return 'lost';
  }
}

/** Retries the owed markers and clears the written ones. True while an intent is still owed. Outside the session lock; never throws. */
export async function repairDestinationIntent(sessionId: string): Promise<boolean> {
  const intent = (await readStatus(sessionId))?.destinationIntent;
  if (!intent) return false;
  const written: DestinationMarker[] = [];
  for (const marker of MARKERS) {
    if (!intent[marker]) continue;
    try {
      await writeDestinationMarker(marker, intent.key, sessionId);
      written.push(marker);
    } catch { /* still owed */ }
  }
  if (written.length === 0) return true;
  try {
    let owed = false;
    await withSessionLock(sessionId, async () => {
      const status = await readStatus(sessionId);
      if (!status?.destinationIntent || status.destinationIntent.key !== intent.key) return;
      const next = { ...status.destinationIntent };
      for (const marker of written) delete next[marker];
      if (next.accepted || next.ended) status.destinationIntent = next;
      else delete status.destinationIntent;
      owed = status.destinationIntent !== undefined;
      await writeStatus(sessionId, status);
    });
    return owed;
  } catch {
    return true; // the markers exist; a leftover intent only retries idempotent create-once writes
  }
}
