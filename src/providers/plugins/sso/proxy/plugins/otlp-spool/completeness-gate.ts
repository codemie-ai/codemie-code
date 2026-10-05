/**
 * Hold & Gate completeness logic for a spool session.
 *
 * Stream presence is derived from the spool files themselves (a non-empty file
 * means the stream was written, even once its cursor reached EOF), so the gate
 * decision is sticky in the same way the old `*Written` flags were.
 *
 * INVARIANT - OTEL-only sessions are NEVER forwarded, by design. This is what
 * implements the per-project allowlist on the daemon side: the hook process
 * does not forward hooks for untracked projects, so their sessions reach
 * the daemon as OTEL only (OTLP carries no cwd and cannot be filtered here).
 * Never add a path that sends OTEL-only data (for example an "otel-only-force"
 * mirroring `hooks-only-force`) without first adding daemon-side project
 * filtering, or data from untracked projects will be sent to the backend.
 */

import { hooksOnlyForwardAllowed, hooksOnlyWaitTicks } from './spool-config.js';
import { hooksGroupPresent, otelGroupPresent, type SpoolState } from './spool-state.js';
import type { SessionStatus } from './session-status.js';

export type GateDecision = 'send' | 'hooks-only-force' | 'wait' | 'skip' | 'noop';

/**
 * Case A (HOOKS and OTEL groups both present) -> 'send'
 * Case B (hooks only, waited long enough)     -> 'hooks-only-force'
 *        (hooks only, not waited enough)      -> 'wait'
 * Case C (OTEL only, not waited enough)       -> 'wait'
 *        (OTEL only, waited long enough)      -> 'skip' (cursors advanced, never sent)
 * Case D (neither group)                      -> 'noop'
 *
 * 'send' and 'hooks-only-force' are reachable ONLY with hooks data present.
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

  // OTEL only: wait for hooks, then skip. Never 'send' - see INVARIANT in the file header.
  return status.waitTicks >= hooksOnlyWaitTicks() ? 'skip' : 'wait';
}
