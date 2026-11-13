/** Structural proof for masked OTLP JSON exports; never rewrites the transmitted record. */
import { MAX_ATTRIBUTES_PER_RECORD, MAX_SNAPSHOT_BYTES, type OtlpSignal, type Proof, type ProofReason, type ProofTarget } from './otlp-reader.js';

class JsonProofError extends Error {
  constructor(readonly reason: ProofReason) { super(reason); }
}

type JsonObject = Record<string, unknown>;
const object = (v: unknown): JsonObject => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new JsonProofError('otlp_unparseable');
  return v as JsonObject;
};
const list = (v: unknown): unknown[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new JsonProofError('otlp_unparseable');
  return v;
};
const field = (v: JsonObject, camel: string, snake: string): unknown => {
  if (camel in v && snake in v) throw new JsonProofError('otlp_unparseable');
  return v[camel] ?? v[snake];
};

function attributes(v: unknown, target: ProofTarget, session: false | OtlpSignal): void {
  const attrs = list(v);
  if (attrs.length > MAX_ATTRIBUTES_PER_RECORD) throw new JsonProofError('otlp_unparseable');
  const ids = new Set<string>();
  for (const entry of attrs) {
    const attr = object(entry);
    const value = object(attr['value']);
    const text = field(value, 'stringValue', 'string_value');
    if (attr['key'] === 'codemie_project_name' && typeof text === 'string' && text.trim()) {
      if (!target.project || text.trim().toLowerCase() !== target.project.trim().toLowerCase()) throw new JsonProofError('project_conflict');
    }
    if (session && (attr['key'] === 'session.id' || (session === 'logs' && attr['key'] === 'session_id'))) {
      if (typeof text !== 'string') throw new JsonProofError('session_mismatch');
      if (text.trim()) ids.add(text);
    }
  }
  if (session && ids.size === 0) throw new JsonProofError('session_id_absent');
  if (session && (ids.size !== 1 || !ids.has(target.sessionId))) throw new JsonProofError('session_mismatch');
}

/** All units must match the frozen session/project; a failed record is held whole. */
export function proveJsonRecord(record: string, target: ProofTarget & { signal: OtlpSignal }): Proof {
  const bytes = Buffer.byteLength(record);
  if (bytes > MAX_SNAPSHOT_BYTES) return { verified: 0, hold: 'otlp_entry_too_large' };
  try {
    const top = object(JSON.parse(record));
    const signal = target.signal;
    const names = signal === 'logs' ? ['resourceLogs', 'resource_logs', 'scopeLogs', 'scope_logs', 'logRecords', 'log_records']
      : signal === 'traces' ? ['resourceSpans', 'resource_spans', 'scopeSpans', 'scope_spans', 'spans', 'spans']
      : ['resourceMetrics', 'resource_metrics', 'scopeMetrics', 'scope_metrics', 'metrics', 'metrics'];
    for (const resource of list(field(top, names[0], names[1]))) {
      const r = object(resource);
      if (r['resource'] !== undefined) attributes(object(r['resource'])['attributes'], target, false);
      for (const scope of list(field(r, names[2], names[3]))) {
        const sc = object(scope);
        const units = names[4] === names[5] ? sc[names[4]] : field(sc, names[4], names[5]);
        for (const unit of list(units)) {
          const u = object(unit);
          if (signal !== 'metrics') attributes(u['attributes'], target, signal);
          else {
            for (const kind of ['gauge', 'sum', 'histogram', 'exponentialHistogram', 'exponential_histogram', 'summary']) {
              if (u[kind] === undefined) continue;
              for (const point of list(field(object(u[kind]), 'dataPoints', 'data_points'))) {
                attributes(object(point)['attributes'], target, signal);
              }
            }
          }
        }
      }
    }
    return { verified: bytes };
  } catch (reason) {
    return { verified: 0, hold: reason instanceof JsonProofError ? reason.reason : 'otlp_unparseable' };
  }
}
