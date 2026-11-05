/**
 * The `--webhook` non-interactive mode's test-send payload, and the pieces its send-failure
 * handling shares with the guided wizard's step 5 (`./guided.ts`).
 *
 * Split out of `./run-bootstrap.ts` (plan task 8) so `guided.ts` can reuse {@link
 * setupCheckReport}, {@link UPDATE_HINT} and {@link sendFailure4xxHint} without importing
 * `run-bootstrap.ts` — which imports `guided.ts` to dispatch to it, so the reverse import
 * would create a cycle. `run-bootstrap.ts` re-exports {@link setupCheckReport} and {@link
 * UPDATE_HINT} so its own existing imports and tests keep working unchanged.
 */

import { SyncDeliveryError } from '@/utils/errors.js';

import type { SyncReport } from '../types.js';

/**
 * `setup-check-<stamp>.json`: the test-send payload for both `--webhook` mode and the
 * guided wizard's step 5. Same shape as the standalone collector's own check
 * (`wizard-support.js`'s `setupCheckFile`) so a lead reading Power Automate's run history
 * sees a familiar payload. Carries no analytics data and no webhook URL. Deliberately not
 * named `codemie-analytics-…`: analysis tooling attributes files by that prefix, and this
 * one belongs to nobody.
 */
export function setupCheckReport(now: Date): SyncReport {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const payload = {
    setupCheck: true,
    sentAt: now.toISOString(),
    note: 'Sent by `codemie analytics sync bootstrap` to test the flow. Safe to delete.'
  };

  return {
    fileName: `setup-check-${stamp}.json`,
    bytes: Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
  };
}

/** Printed to `deps.err` after every successful test send (both modes), right before the
 * install command. Names no version, so it reads the same across CLI releases (spec.md
 * "Install command", decision AR-5). */
export const UPDATE_HINT =
  'Developers who see "unknown command" need a newer CodeMie CLI: have them run `codemie self-update`.';

/**
 * The "flow on / Anyone / whole URL" hint shown after a failed test send whose cause was a
 * 4xx response — keyed off `SyncDeliveryError.status`, never message text, per spec.md
 * "Constraints and left to the builder". `undefined` for every other failure (a non-4xx
 * status, or an error that is not a {@link SyncDeliveryError} at all, e.g. DNS/network).
 * Shared by `--webhook` mode's `printSendFailure` and the guided wizard's step 5 test-send
 * retry menu.
 */
export function sendFailure4xxHint(err: unknown): string | undefined {
  if (err instanceof SyncDeliveryError && err.status !== undefined && err.status >= 400 && err.status < 500) {
    return 'Check that the flow is turned on, that its trigger allows "Anyone", and that the whole URL was copied.';
  }
  return undefined;
}
