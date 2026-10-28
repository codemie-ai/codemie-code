/**
 * Bounded structural OTLP / hook-line reader (EPMCDME-16440 spec item 6).
 *
 * Not a protobuf framework: it walks only the fields needed to find session ids and
 * `codemie_project_name`, skips everything else by wire type, checks every declared length against
 * its parent, and has fixed schema depth (no recursion). It returns LENGTHS only; bytes are never
 * copied or rewritten. Field numbers are from opentelemetry-proto, pinned by the real-encoder
 * fixtures in __tests__/fixtures/manifest.json.
 *
 * Session source: logs = `session.id` else `session_id`; spans/data points = `session.id` only;
 * resource attributes are never a session source. Project is noted on resource and record/span/point.
 * The signal kind is passed in by the caller (the forwarder knows it from the endpoint).
 */

export type OtlpSignal = 'logs' | 'traces' | 'metrics';
export type ProofReason = 'session_id_absent' | 'session_mismatch' | 'project_conflict' | 'otlp_unparseable';
export interface Proof {
  /** Byte length of the longest verified prefix (resource-entry / whole-line boundary). */
  verified: number;
  /** Reason for the first bad entry/line; absent when everything verified. */
  hold?: ProofReason;
}
export interface ProofTarget {
  sessionId: string;
  /** The record's project; undefined = the record has none (any project value is then a conflict). */
  project?: string;
}

export const MAX_SNAPSHOT_BYTES = 5_242_880;
export const MAX_ATTRIBUTES_PER_RECORD = 256;

const SESSION_ID_KEY = 'session.id';
const SESSION_ID_ALT_KEY = 'session_id';
const PROJECT_KEY = 'codemie_project_name';

class Hold extends Error {
  constructor(readonly reason: ProofReason) {
    super(reason);
  }
}
const unparseable = (): never => {
  throw new Hold('otlp_unparseable');
};

interface Cursor { b: Buffer; p: number; end: number }
interface Field { num: number; wire: number; start: number; end: number }

function varint(c: Cursor): number {
  let result = 0;
  let mul = 1;
  for (let i = 0; i < 10; i++) {
    if (c.p >= c.end) unparseable();
    const byte = c.b[c.p++];
    result += (byte & 0x7f) * mul;
    if ((byte & 0x80) === 0) return result;
    mul *= 128;
  }
  return unparseable();
}

/** Reads one field header and skips its payload; for wire type 2 `start..end` is the payload. */
function nextField(c: Cursor): Field {
  const tag = varint(c);
  const num = Math.floor(tag / 8);
  const wire = tag % 8;
  if (num === 0) unparseable();
  let start = c.p;
  let end: number;
  if (wire === 0) { varint(c); end = c.p; }
  else if (wire === 1) end = c.p + 8;
  else if (wire === 5) end = c.p + 4;
  else if (wire === 2) {
    const len = varint(c);
    start = c.p;
    end = c.p + len;
  } else return unparseable();
  if (end > c.end) unparseable();
  c.p = end;
  return { num, wire, start, end };
}

const sub = (c: Cursor, f: Field): Cursor => ({ b: c.b, p: f.start, end: f.end });

type Kv = { key: string; kind: 'string' | 'other'; value: string };

function keyValue(c: Cursor, f: Field): Kv {
  const kv = sub(c, f);
  let key = '';
  let kind: Kv['kind'] = 'other';
  let value = '';
  while (kv.p < kv.end) {
    const kf = nextField(kv);
    if (kf.num === 1 && kf.wire === 2) key = c.b.toString('utf8', kf.start, kf.end);
    else if (kf.num === 2 && kf.wire === 2) {
      const av = sub(c, kf);
      if (av.p < av.end) {
        const vf = nextField(av);
        if (vf.num === 1 && vf.wire === 2) { kind = 'string'; value = c.b.toString('utf8', vf.start, vf.end); }
      }
    }
  }
  return { key, kind, value };
}

const blank = (s: string): boolean => s.trim() === '';

function checkProject(value: string, target: ProofTarget): void {
  if (blank(value)) return;
  if (target.project === undefined || blank(target.project)) throw new Hold('project_conflict');
  if (value.trim().toLowerCase() !== target.project.trim().toLowerCase()) throw new Hold('project_conflict');
}

/** Checks one attribute list (field `attrField` of message `m`) as session source (unit) or project-only (resource). */
function checkAttributes(m: Cursor, attrField: number, target: ProofTarget, mode: { session: false } | { session: 'logs' | 'span' }): void {
  const sessionVals = new Set<string>();
  const altVals = new Set<string>();
  let nonString = false;
  let count = 0;
  while (m.p < m.end) {
    const f = nextField(m);
    if (f.num !== attrField || f.wire !== 2) continue;
    if (++count > MAX_ATTRIBUTES_PER_RECORD) unparseable();
    const kv = keyValue(m, f);
    if (kv.key === PROJECT_KEY) {
      if (kv.kind === 'string') checkProject(kv.value, target);
    } else if (mode.session && (kv.key === SESSION_ID_KEY || (mode.session === 'logs' && kv.key === SESSION_ID_ALT_KEY))) {
      if (kv.kind !== 'string') nonString = true;
      else if (!blank(kv.value) && kv.value !== '') (kv.key === SESSION_ID_KEY ? sessionVals : altVals).add(kv.value);
    }
  }
  if (!mode.session) return;
  if (nonString) throw new Hold('session_mismatch');
  const all = new Set([...sessionVals, ...altVals]);
  if (all.size === 0) throw new Hold('session_id_absent');
  if (all.size > 1 || !all.has(target.sessionId)) throw new Hold('session_mismatch');
}

/** Calls `fn` for each length-delimited field `num` of message `m`. */
function eachSub(m: Cursor, num: number, fn: (c: Cursor) => void): void {
  while (m.p < m.end) {
    const f = nextField(m);
    if (f.num === num && f.wire === 2) fn(sub(m, f));
  }
}

// Metric oneof data field -> (data_points field = 1, per-point attributes field).
const POINT_ATTR_BY_METRIC_FIELD: Record<number, number> = { 5: 7, 7: 7, 9: 9, 10: 1, 11: 7 };

function checkResourceEntry(e: Cursor, signal: OtlpSignal, target: ProofTarget): void {
  // Resource (field 1) first, then scopes (field 2); one pass collects both.
  const scopes: Cursor[] = [];
  while (e.p < e.end) {
    const f = nextField(e);
    if (f.wire !== 2) continue;
    if (f.num === 1) checkAttributes(sub(e, f), 1, target, { session: false });
    else if (f.num === 2) scopes.push(sub(e, f));
  }
  for (const scope of scopes) {
    if (signal === 'logs') {
      eachSub(scope, 2, (rec) => checkAttributes(rec, 6, target, { session: 'logs' }));
    } else if (signal === 'traces') {
      eachSub(scope, 2, (span) => checkAttributes(span, 9, target, { session: 'span' }));
    } else {
      eachSub(scope, 2, (metric) => {
        while (metric.p < metric.end) {
          const mf = nextField(metric);
          const attrField = POINT_ATTR_BY_METRIC_FIELD[mf.num];
          if (mf.wire !== 2 || attrField === undefined) continue;
          eachSub(sub(metric, mf), 1, (pt) => checkAttributes(pt, attrField, target, { session: 'span' }));
        }
      });
    }
  }
}

/**
 * Proves a spool OTLP byte range (one or more concatenated export requests, treated as one request).
 * Verified prefixes end at top-level field boundaries; the first bad entry sets `hold`.
 */
export function proveRange(bytes: Buffer, opts: ProofTarget & { signal: OtlpSignal }): Proof {
  if (bytes.length > MAX_SNAPSHOT_BYTES) return { verified: 0, hold: 'otlp_unparseable' };
  const top: Cursor = { b: bytes, p: 0, end: bytes.length };
  let verified = 0;
  while (top.p < top.end) {
    try {
      const f = nextField(top);
      if (f.num === 1 && f.wire === 2) checkResourceEntry(sub(top, f), opts.signal, opts);
    } catch (err) {
      return { verified, hold: err instanceof Hold ? err.reason : 'otlp_unparseable' };
    }
    verified = top.p;
  }
  return { verified };
}

/**
 * Proves spool NDJSON hook lines (spool envelope `{agentName, hookEvent}` or a bare event). Lines
 * that do not parse are skipped (verified past them); an unterminated last line is not yet whole
 * and is left unverified without a hold.
 */
export function proveHookLines(bytes: Buffer | string, target: ProofTarget): Proof {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  let verified = 0;
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const reason = hookLineReason(buf.toString('utf8', pos, nl), target);
    if (reason) return { verified, hold: reason };
    pos = verified = nl + 1;
  }
  return { verified };
}

function hookLineReason(line: string, target: ProofTarget): ProofReason | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
    const inner = (event as { hookEvent?: unknown } | null)?.hookEvent;
    if (typeof inner === 'string') event = JSON.parse(inner);
  } catch {
    return undefined;
  }
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return undefined;
  const rec = event as Record<string, unknown>;
  const sid = rec['session_id'];
  if (sid !== undefined && sid !== null && typeof sid !== 'string') return 'session_mismatch';
  if (!sid) return 'session_id_absent';
  if (sid !== target.sessionId) return 'session_mismatch';
  const project = rec[PROJECT_KEY];
  if (typeof project === 'string') {
    try { checkProject(project, target); } catch { return 'project_conflict'; }
  }
  return undefined;
}
