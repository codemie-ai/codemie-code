import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getCodemiePath } from '@/utils/paths.js';

/**
 * Root directory where all OTLP analytics spool files are stored.
 * Resolves to `~/.codemie/proxy/otlp-spool`.
 */
export function spoolRoot(): string {
  return getCodemiePath('proxy', 'otlp-spool');
}

/** OTEL binary streams (protobuf payloads produced by the agent runtime). */
export const OTEL_STREAMS = ['logs', 'metrics', 'traces'] as const;
export type OtelStream = (typeof OTEL_STREAMS)[number];

/** Every spool stream, in a stable order. */
export const SPOOL_STREAMS = ['hooks', ...OTEL_STREAMS] as const;
export type SpoolStream = (typeof SPOOL_STREAMS)[number];

const STREAM_EXT: Record<SpoolStream, string> = {
  hooks: '.hooks.ndjson',
  logs: '.otel_logs.bin',
  metrics: '.otel_metrics.bin',
  traces: '.otel_traces.bin',
};

export const STATUS_EXT = '.status';

/** Spool data file for one stream of a session. */
export function streamFile(sessionId: string, stream: SpoolStream): string {
  return join(spoolRoot(), sessionId + STREAM_EXT[stream]);
}

/** Delivery bookkeeping file for a session. */
export function statusFile(sessionId: string): string {
  return join(spoolRoot(), sessionId + STATUS_EXT);
}

const ALL_SUFFIXES: readonly string[] = [STATUS_EXT, ...Object.values(STREAM_EXT)];

/**
 * All session ids currently present in the spool root.
 *
 * Derived from any spool artifact (data or status) so that a session whose
 * producer crashed before writing a status file is still discoverable.
 */
export async function listSessionIds(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(spoolRoot());
  } catch {
    return []; // spool root may not exist yet
  }

  const ids = new Set<string>();
  for (const entry of entries) {
    const suffix = ALL_SUFFIXES.find((suffix) => entry.length > suffix.length && entry.endsWith(suffix));
    if (suffix) ids.add(entry.slice(0, -suffix.length));
  }
  return [...ids];
}
