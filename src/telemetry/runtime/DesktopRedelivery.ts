import { RECONCILE_PER_START, readLiveRecord } from '@/agents/core/session/stale-session-reconciliation.js';
import type { DesktopSessionDelivery } from '@/telemetry/runtime/DesktopSessionDelivery.js';
import { DESKTOP_REDELIVERY_INTERVAL_MS } from '@/telemetry/runtime/desktop-session.js';
import { logger } from '@/utils/logger.js';

/**
 * The runtime's re-delivery of the records it could not send: one pass at a time, every
 * {@link DESKTOP_REDELIVERY_INTERVAL_MS}, a listing pass on a connected poll and a pass over the remembered ids on a
 * not-connected one. The first pass by id over a memory that was empty runs one interval after its first id was
 * remembered, so that id is not re-sent in the poll whose send just failed; an id remembered beside others waits for
 * the next pass.
 */
export class DesktopRedelivery {
  /** The pass running, if any. */
  pass?: Promise<void>;
  /**
   * CodeMie session ids of the records this process finalized or passed over that were left undelivered, in the order
   * a by-id pass takes them from the end, each with the number of its last remembering: a not-connected poll, which
   * lists no session store, re-delivers them by id.
   */
  private readonly undeliveredIds = new Map<string, number>();
  private rememberedCount = 0;
  /** When the memory last went from empty to holding an id. */
  private filledAt = 0;

  constructor(
    private readonly delivery: DesktopSessionDelivery,
    private lastPassAt: number
  ) {}

  /** Remembers the ids as the most recently left undelivered; into an empty memory, at the current time. */
  remember(sessionIds: readonly string[]): void {
    if (this.undeliveredIds.size === 0 && sessionIds.length > 0) this.filledAt = Date.now();
    for (const sessionId of sessionIds) {
      this.undeliveredIds.delete(sessionId);
      this.undeliveredIds.set(sessionId, ++this.rememberedCount);
    }
  }

  /** A listing pass; each pass sends at most `RECONCILE_PER_START` records. The ids no longer undelivered leave the memory. */
  startListingIfDue(now: number): void {
    this.startIfDue(now, '[desktop-telemetry] Re-delivery pass failed:', async () => {
      this.remember(await this.delivery.reconcileRecords(false));
      for (const sessionId of this.undeliveredIds.keys()) {
        if (!(await readLiveRecord(sessionId))) this.undeliveredIds.delete(sessionId);
      }
    });
  }

  /**
   * A not-connected poll's re-delivery of the remembered ids: at most {@link RECONCILE_PER_START} ids a pass, the most
   * recently remembered first, so its sends stay bounded as a listing pass's are. The ids it delivered or found no
   * longer undelivered leave the memory; the ones still undelivered become the least recently remembered, so the next
   * pass takes other ids first, unless remembered again during the pass. The first pass over a memory that was empty
   * runs no earlier than one interval after its first id was remembered.
   */
  startByIdIfDue(now: number): void {
    if (this.undeliveredIds.size === 0 || now - this.filledAt < DESKTOP_REDELIVERY_INTERVAL_MS) return;
    this.startIfDue(now, '[desktop-telemetry] Re-delivery by id failed:', async () => {
      const taken = [...this.undeliveredIds].reverse().slice(0, RECONCILE_PER_START);
      const stillUndelivered = await this.delivery.redeliverById(taken.map(([sessionId]) => sessionId));
      const rotated = new Map<string, number>();
      for (const [sessionId, order] of taken.reverse()) {
        // Remembered again during the pass: it keeps its new place
        if (this.undeliveredIds.get(sessionId) !== order) continue;
        if (!stillUndelivered.includes(sessionId)) this.undeliveredIds.delete(sessionId);
        else rotated.set(sessionId, order);
      }
      const rest = [...this.undeliveredIds].filter(([sessionId]) => !rotated.has(sessionId));
      this.undeliveredIds.clear();
      for (const [sessionId, order] of [...rotated, ...rest]) this.undeliveredIds.set(sessionId, order);
    });
  }

  /** Starts `pass` when none runs and the interval has passed; its failure is logged as `failureText`. */
  private startIfDue(now: number, failureText: string, pass: () => Promise<void>): void {
    // Not awaited: a pass whose sends hang must not stall the polls
    if (this.pass || now - this.lastPassAt < DESKTOP_REDELIVERY_INTERVAL_MS) return;
    this.lastPassAt = now;
    this.pass = pass()
      .catch((error) => {
        logger.error(failureText, error);
      })
      .finally(() => {
        this.pass = undefined;
      });
  }
}
