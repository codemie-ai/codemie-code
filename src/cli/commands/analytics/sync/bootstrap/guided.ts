/**
 * `codemie analytics sync bootstrap`'s guided mode (a TTY, no `--webhook` given).
 *
 * This is a placeholder. Task 7 of the EPMCDME-16487 plan replaces it with the real 8-step
 * wizard (spec.md "Guided mode"): Teams channel, SharePoint folder, time zone, import the
 * flow, trigger URL, external sessions, lookback, developers.
 *
 * Imports only from `./types.ts`, never from `./run-bootstrap.ts` — that runner imports this
 * module to dispatch to it, so the reverse import would create a cycle.
 */

import type { BootstrapDeps } from './types.js';

/** Stand-in for the guided wizard: prints why it cannot run yet and how to proceed instead,
 * and fails. Replaced by Task 7. */
export async function runGuided(deps: BootstrapDeps): Promise<number> {
  deps.err(
    'The guided bootstrap wizard is not available yet in this build. ' +
      'Pass --webhook <url> to run `codemie analytics sync bootstrap` non-interactively instead.'
  );
  return 1;
}
