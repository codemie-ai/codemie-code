/**
 * OTLP wire fixtures for the structural OTLP reader.
 * @group unit
 *
 * The fixtures (fixtures/*.bin) are synthetic and were encoded with the real OpenTelemetry protobuf encoder
 * (opentelemetry-proto Python classes, protobuf 5.29.6), not by hand. manifest.json describes each one: the session
 * and project attribute observations, the top-level resource-entry [start,end) offsets, the size, the sha256 and the
 * verdict the reader must reach (ok, session_id_absent, session_mismatch, project_conflict, otlp_unparseable).
 * The tests only read the bundled files; no generator is needed to run them.
 *
 * The reader tests (mixed or missing session ids, project conflicts, malformed data) are validated against this manifest.
 * Two deliberate differences from the backend decoder: a session.id/session_id contradiction is held, and so are
 * non-string ids. Histogram, summary and exponential-histogram points are never stored by the backend, so only their
 * project is checked there; the client check is stricter. The 5 MiB + 1 oversize case is generated in the test,
 * not stored.
 *
 * WIRE FIELD NUMBERS (opentelemetry-proto; top level of every Export*ServiceRequest):
 *   field 1 (tag 0x0a, length-delimited) = repeated ResourceLogs / ResourceSpans / ResourceMetrics. Concatenated
 *   requests are legal and merge by appending field 1 entries; boundaries are the entry [start,end) offsets in the manifest.
 *   Resource{1 attributes}; ResourceX{1 resource, 2 scope_X}; ScopeX{2 log_records|spans|metrics}; LogRecord.attributes=6,
 *   Span.attributes=9, Metric{1 name, 5 gauge, 7 sum, 9 histogram, 10 exponential_histogram, 11 summary}, data points'
 *   attributes: NumberDataPoint=7, HistogramDataPoint=9, ExponentialHistogramDataPoint=1, SummaryDataPoint=7.
 *   KeyValue{1 key, 2 AnyValue}; AnyValue{1 string, 2 bool, 3 int, 4 double, 5 array, 6 kvlist, 7 bytes}.
 *   Also ResourceX.scope_X=2, ScopeX.scope=1, Metric.name=1, LogRecord.body=5.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const VERDICTS = ['ok', 'session_id_absent', 'session_mismatch', 'project_conflict', 'otlp_unparseable'];
const SIGNALS = ['logs', 'traces', 'metrics'];
const MAX_SNAPSHOT_BYTES = 5_242_880;

interface Entry { start: number; end: number }
interface Obs { where: string; key: string; type: string; value: unknown }
interface Fixture {
  file: string | null; signal: string; note: string; generated_in_test: boolean; expected_verdict: string;
  parse_ok?: boolean; entries: Entry[]; session_observations: Obs[]; project_observations: Obs[];
  size: number; sha256: string | null;
}
interface Manifest {
  expected_session_id: string; expected_project: string; max_attributes_per_record: number;
  max_snapshot_bytes: number; fixtures: Fixture[];
}

const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf-8')) as Manifest;
const stored = manifest.fixtures.filter((f) => f.file !== null);

describe('OTLP wire fixtures (decoder-derived manifest)', () => {
  it('manifest is well-formed and covers every verdict class and signal', () => {
    expect(manifest.max_snapshot_bytes).toBe(MAX_SNAPSHOT_BYTES);
    expect(manifest.max_attributes_per_record).toBe(256);
    expect(new Set(manifest.fixtures.map((f) => f.expected_verdict))).toEqual(new Set(VERDICTS));
    expect(new Set(manifest.fixtures.map((f) => f.signal))).toEqual(new Set(SIGNALS));
    for (const f of manifest.fixtures) {
      expect(VERDICTS).toContain(f.expected_verdict);
      expect(SIGNALS).toContain(f.signal);
    }
    const names = manifest.fixtures.map((f) => f.file);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every stored .bin has the manifest size and sha256, and no orphan files exist', () => {
    const onDisk = readdirSync(DIR).filter((n) => n.endsWith('.bin')).sort();
    expect(onDisk).toEqual(stored.map((f) => f.file as string).sort());
    for (const f of stored) {
      const bytes = readFileSync(join(DIR, f.file as string));
      expect(bytes.length, f.file as string).toBe(f.size);
      expect(createHash('sha256').update(bytes).digest('hex'), f.file as string).toBe(f.sha256);
    }
  });

  it('keeps stored fixtures small (tens of KB)', () => {
    const total = readdirSync(DIR).reduce((n, name) => n + statSync(join(DIR, name)).size, 0);
    expect(total).toBeLessThan(80 * 1024);
  });

  it('top-level resource entries tile the file; each starts with tag 0x0a and a matching varint length', () => {
    for (const f of stored.filter((x) => x.parse_ok)) {
      const bytes = readFileSync(join(DIR, f.file as string));
      expect(f.entries.length, f.file as string).toBeGreaterThan(0);
      let at = 0;
      for (const e of f.entries) {
        expect(e.start, f.file as string).toBe(at);
        expect(bytes[e.start]).toBe(0x0a);
        let len = 0;
        let shift = 0;
        let i = e.start + 1;
        for (;;) {
          const b = bytes[i++];
          len += (b & 0x7f) * 2 ** shift;
          if (!(b & 0x80)) break;
          shift += 7;
        }
        expect(i + len, f.file as string).toBe(e.end);
        at = e.end;
      }
      expect(at, f.file as string).toBe(bytes.length);
    }
  });

  it('unparseable fixtures carry no entries; the concatenated stream has 3', () => {
    for (const f of stored.filter((x) => x.parse_ok === false)) {
      expect(f.expected_verdict).toBe('otlp_unparseable');
      expect(f.entries).toEqual([]);
    }
    expect(manifest.fixtures.find((f) => f.file === 'logs-concatenated-3-records.bin')?.entries).toHaveLength(3);
  });

  it('ok fixtures observe only the expected session id and project (case-insensitive)', () => {
    for (const f of stored.filter((x) => x.expected_verdict === 'ok')) {
      const sess = f.session_observations.filter((o) => !o.where.startsWith('resource'));
      expect(sess.length, f.file as string).toBeGreaterThan(0);
      for (const o of f.session_observations) {
        if (o.value === '') continue; // empty session.id with session_id fallback fixture
        expect(o.value, f.file as string).toBe(manifest.expected_session_id);
      }
      for (const o of f.project_observations) {
        if (typeof o.value === 'string' && o.value.trim() === '') continue;
        expect(String(o.value).toLowerCase(), f.file as string).toBe(manifest.expected_project);
      }
    }
  });

  it('negative fixtures show the observation that justifies their verdict', () => {
    const get = (n: string): Fixture => manifest.fixtures.find((f) => f.file === n) as Fixture;
    const rec = (f: Fixture): Obs[] => f.session_observations.filter((o) => !o.where.startsWith('resource'));
    expect(rec(get('logs-resource-only-session-id.bin'))).toEqual([]);
    expect(get('logs-resource-only-session-id.bin').session_observations).toHaveLength(1);
    expect(rec(get('logs-lookalike-id-in-body.bin'))).toEqual([]);
    expect(new Set(rec(get('logs-mixed-ids.bin')).map((o) => o.value)).size).toBe(2);
    expect(rec(get('logs-non-string-id-int.bin'))[0]).toMatchObject({ type: 'int', value: 12345 });
    expect(rec(get('logs-empty-string-id.bin'))[0]).toMatchObject({ type: 'string', value: '' });
    const contra = rec(get('logs-session-id-vs-session_id-contradiction.bin'));
    expect(contra.map((o) => o.key).sort()).toEqual(['session.id', 'session_id']);
    expect(new Set(contra.map((o) => o.value)).size).toBe(2);
    expect(rec(get('traces-session_id-only-not-a-source.bin'))[0].key).toBe('session_id');
    expect(new Set(get('logs-project-conflict-two-records.bin').project_observations.map((o) => o.value)).size).toBe(2);
    const pc = get('logs-project-conflict-resource-vs-record.bin').project_observations;
    expect(pc.map((o) => o.where.split('[')[0]).sort()).toEqual(['record', 'resource']);
    const big = get('logs-257-plus-attributes.bin');
    expect((big as unknown as { max_attrs_on_a_unit: number }).max_attrs_on_a_unit).toBeGreaterThan(256);
  });

  it('covers all five metric data-point kinds', () => {
    const names = stored.filter((f) => f.signal === 'metrics').map((f) => f.file as string);
    for (const k of ['gauge', 'sum', 'histogram', 'summary', 'exp_histogram']) {
      expect(names.some((n) => n.startsWith(`metrics-${k}-`)), k).toBe(true);
    }
  });

  it('the oversized case is generated in-test, never stored', () => {
    const f = manifest.fixtures.find((x) => x.generated_in_test) as Fixture;
    expect(f).toMatchObject({ file: null, expected_verdict: 'otlp_unparseable', size: MAX_SNAPSHOT_BYTES + 1 });
    const body = Buffer.alloc(f.size);
    expect(body.length).toBeGreaterThan(manifest.max_snapshot_bytes);
  });
});
