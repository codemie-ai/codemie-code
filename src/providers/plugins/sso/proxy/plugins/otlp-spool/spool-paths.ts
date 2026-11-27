import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getCodemiePath } from '@/utils/paths.js';

/** The spool directory an analytics plugin named at its start; none in a process that starts no analytics plugin. */
let namedRoot: string | undefined;

/** The proxy's spool directory, `~/.codemie/proxy/otlp-spool`. */
export function proxySpoolRoot(): string {
  return getCodemiePath('proxy', 'otlp-spool');
}

/**
 * Names the spool directory of this process. Called by an analytics plugin as the first statement of its
 * `onProxyStart`, and by nothing else.
 */
export function useSpoolRoot(dir: string): void {
  namedRoot = dir;
}

/**
 * Root directory where all OTLP analytics spool files are stored: the one an analytics plugin named, else the
 * proxy's (a CLI process that starts no plugin reads the proxy's spool).
 */
export function spoolRoot(): string {
  return namedRoot ?? proxySpoolRoot();
}

/** OTEL binary streams (protobuf payloads produced by the agent runtime). */
export const OTEL_STREAMS = ['logs', 'metrics', 'traces'] as const;
export type OtelStream = (typeof OTEL_STREAMS)[number];

/** JSON/NDJSON counterpart of each OTEL signal — masked exports produced by the http/json proxy path. */
export const OTEL_JSON_STREAMS = ['logsJson', 'metricsJson', 'tracesJson'] as const;
export type OtelJsonStream = (typeof OTEL_JSON_STREAMS)[number];

/** Signal -> JSON stream id (ingestion handler picks the spool target from the request's signal). */
export const OTEL_JSON_STREAM_BY_SIGNAL: Record<OtelStream, OtelJsonStream> = {
  logs: 'logsJson',
  metrics: 'metricsJson',
  traces: 'tracesJson',
};

/** JSON stream id -> signal (forwarder picks the backend endpoint from the stream it is sending). */
export const OTEL_SIGNAL_BY_JSON_STREAM: Record<OtelJsonStream, OtelStream> = {
  logsJson: 'logs',
  metricsJson: 'metrics',
  tracesJson: 'traces',
};

/** Every spool stream, in a stable order. */
export const SPOOL_STREAMS = ['hooks', ...OTEL_STREAMS, ...OTEL_JSON_STREAMS] as const;
export type SpoolStream = (typeof SPOOL_STREAMS)[number];

const STREAM_EXT: Record<SpoolStream, string> = {
  hooks: '.hooks.ndjson',
  logs: '.otel_logs.bin',
  metrics: '.otel_metrics.bin',
  traces: '.otel_traces.bin',
  logsJson: '.otel_logs.ndjson',
  metricsJson: '.otel_metrics.ndjson',
  tracesJson: '.otel_traces.ndjson',
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
  try {
    return await listSessionIdsStrict();
  } catch {
    return [];
  }
}

/** Like `listSessionIds`, but only a missing spool root is empty; any other read failure is thrown. */
export async function listSessionIdsStrict(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(spoolRoot());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; // spool root may not exist yet
    throw err;
  }

  const ids = new Set<string>();
  for (const entry of entries) {
    const suffix = ALL_SUFFIXES.find((suffix) => entry.length > suffix.length && entry.endsWith(suffix));
    if (suffix) ids.add(entry.slice(0, -suffix.length));
  }
  return [...ids];
}
