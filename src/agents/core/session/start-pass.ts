import { logger } from '@/utils/logger.js';
import type { ReconcilePass } from './stale-session-reconciliation.js';

/**
 * The wrapper's exit budget for network work: the start pass still running, the plugin's session
 * end, the own-record step and the proxy's final sync share it; a request in flight at its end is
 * aborted and what is left stays undelivered for the next start.
 */
export const EXIT_NETWORK_BUDGET_MS = 10_000;

/** The start pass's share of the exit budget: a pass still running then is abandoned, the rest is left to the own session. */
export const START_PASS_EXIT_BUDGET_MS = EXIT_NETWORK_BUDGET_MS / 2;

/**
 * Await the start pass until `deadlineMs`; a pass still running then is abandoned (its record in
 * hand keeps no attempt it did not spend, the rest waits for the next start).
 */
export async function settleStartPass(pass: ReconcilePass, deadlineMs: number, displayName: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    pass.done.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), Math.max(0, deadlineMs - Date.now()));
    }),
  ]);
  clearTimeout(timer);
  if (timedOut) {
    logger.info(`[${displayName}] Start pass still running at the exit deadline; abandoned`);
    await pass.abandon();
  }
}
