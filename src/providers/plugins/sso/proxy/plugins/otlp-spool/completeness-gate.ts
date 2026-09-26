/**
 * Hold & Gate completeness logic for a spool session.
 */

export interface SessionStatus {
  hooksWritten: boolean;
  otelLogsWritten: boolean;
  otelMetricsWritten: boolean;
  otelTracesWritten: boolean;
  waitTicks: number;
  forwarded?: boolean;
  authExpired?: boolean;
  /** Byte offset into hooks.ndjson, advanced after each successful forward */
  cursor?: number;
  /** Byte offsets into each OTEL bin file, advanced after each successful forward */
  otelLogsCursor?: number;
  otelMetricsCursor?: number;
  otelTracesCursor?: number;
}

export type GateDecision = 'send' | 'hooks-only-force' | 'wait' | 'noop';

/**
 * Decide what to do with a session based on its current completeness status.
 *
 * Case A (both HOOKS and OTEL groups touched) -> 'send'
 * Case B (exactly one group, hooks-only, waited long enough) -> 'hooks-only-force'
 *        (exactly one group, not hooks-only or not waited enough) -> 'wait'
 * Case C (neither group) -> 'noop'
 */
export function gateDecision(status: SessionStatus): GateDecision {
  const maxAttempts = Number(process.env['OTLP_SEND_MAX_ATTEMPTS'] ?? '4');
  const allowHooksOnly = (process.env['OTLP_ALLOW_HOOKS_ONLY_FORWARD'] ?? 'true') === 'true';

  const hooksGroup = status.hooksWritten;
  const otelGroup = status.otelLogsWritten || status.otelMetricsWritten || status.otelTracesWritten;

  // Case A: both groups present
  if (hooksGroup && otelGroup) {
    return 'send';
  }

  // Case C: neither group
  if (!hooksGroup && !otelGroup) {
    return 'noop';
  }

  // Case B: exactly one group
  if (hooksGroup && !otelGroup) {
    if (status.waitTicks >= maxAttempts && allowHooksOnly) {
      return 'hooks-only-force';
    }
    return 'wait';
  }

  // otelGroup only — wait for hooks
  return 'wait';
}
