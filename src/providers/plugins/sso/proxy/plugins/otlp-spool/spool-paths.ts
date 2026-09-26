import { join } from 'node:path';
import { getCodemiePath } from '@/utils/paths.js';

/**
 * Root directory where all OTLP analytics spool files are stored.
 * Resolves to `~/.codemie/proxy/otlp-spool`.
 */
export function spoolRoot(): string {
  return getCodemiePath('proxy', 'otlp-spool');
}

type SpoolSignal = 'hooks' | 'otel_logs' | 'otel_metrics' | 'otel_traces' | 'status';

const SIGNAL_EXT: Record<SpoolSignal, string> = {
  hooks: '.hooks.ndjson',
  otel_logs: '.otel_logs.bin',
  otel_metrics: '.otel_metrics.bin',
  otel_traces: '.otel_traces.bin',
  status: '.status',
};

/**
 * Full file path for a session's spool file for a given signal type.
 */
export function sessionFile(sessionId: string, signal: SpoolSignal): string {
  return join(spoolRoot(), sessionId + SIGNAL_EXT[signal]);
}
