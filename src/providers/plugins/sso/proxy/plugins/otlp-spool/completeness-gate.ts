/**
 * Hold & Gate completeness logic for a spool session.
 *
 * Stream presence is derived from the spool files themselves (a non-empty file
 * means the stream was written, even once its cursor reached EOF), so the gate
 * decision is sticky in the same way the old `*Written` flags were.
 */

import { hooksOnlyForwardAllowed, hooksOnlyWaitTicks } from './spool-config.js';
import { hooksGroupPresent, otelGroupPresent, type SpoolState } from './spool-state.js';
import type { SessionStatus } from './session-status.js';

export type GateDecision = 'send' | 'hooks-only-force' | 'wait' | 'noop';

/**
 * Case A (HOOKS and OTEL groups both present) -> 'send'
 * Case B (hooks only, waited long enough)     -> 'hooks-only-force'
 *        (hooks only, not waited enough)      -> 'wait'
 *        (OTEL only)                          -> 'wait'
 * Case C (neither group)                      -> 'noop'
 */
export function gateDecision(spool: SpoolState, status: SessionStatus): GateDecision {
  const hooks = hooksGroupPresent(spool);
  const otel = otelGroupPresent(spool);

  if (hooks && otel) {
    return 'send';
  }

  if (!hooks && !otel) {
    return 'noop';
  }

  if (hooks) {
    return status.waitTicks >= hooksOnlyWaitTicks() && hooksOnlyForwardAllowed()
      ? 'hooks-only-force'
      : 'wait';
  }

  return 'wait'; // OTEL only — wait for hooks
}
