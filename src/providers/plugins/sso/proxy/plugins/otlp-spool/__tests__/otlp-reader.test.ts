import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proveRange, proveHookLines, type OtlpSignal } from '../otlp-reader.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
interface Fx { file: string | null; signal: OtlpSignal; expected_verdict: string; entries: { start: number; end: number }[]; size: number }
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
  expected_session_id: string; expected_project: string; fixtures: Fx[];
};
const sessionId = manifest.expected_session_id;
const project = manifest.expected_project;
const load = (f: Fx): Buffer => (f.file ? readFileSync(join(dir, f.file)) : Buffer.alloc(f.size, 0x20));
const byName = (n: string): Fx => manifest.fixtures.find((f) => f.file === n) as Fx;

describe('proveRange against every manifest fixture', () => {
  it.each(manifest.fixtures.map((f) => [f.file ?? 'oversize (generated)', f] as const))('%s', (_n, f) => {
    const bytes = load(f);
    const r = proveRange(bytes, { sessionId, project, signal: f.signal });
    if (f.expected_verdict === 'ok') {
      expect(r).toEqual({ verified: bytes.length });
      return;
    }
    // verified prefix = entries before the first bad one (the last entry is the bad one)
    const expected = f.entries.length > 1 ? f.entries[f.entries.length - 2].end : 0;
    expect(r.hold).toBe(f.expected_verdict);
    expect(r.verified).toBe(expected);
  });

  it('poisoned tail: the verified prefix is byte-identical to the input prefix', () => {
    const f = byName('logs-concatenated-last-mismatch.bin');
    const bytes = load(f);
    const r = proveRange(bytes, { sessionId, project, signal: 'logs' });
    expect(r.verified).toBe(f.entries[1].end);
    expect(bytes.subarray(0, r.verified).equals(bytes.subarray(0, f.entries[1].end))).toBe(true);
    expect(proveRange(bytes.subarray(0, r.verified), { sessionId, project, signal: 'logs' })).toEqual({ verified: r.verified });
  });

  it('project undefined: any project value is a conflict, none is fine', () => {
    const withProject = load(byName('logs-ok-session-id-and-project.bin'));
    expect(proveRange(withProject, { sessionId, signal: 'logs' }).hold).toBe('project_conflict');
    const none = load(byName('logs-ok-session_id-fallback.bin'));
    expect(proveRange(none, { sessionId, signal: 'logs' })).toEqual({ verified: none.length });
  });

  it('garbage after a good entry holds with otlp_unparseable and keeps the good prefix', () => {
    const good = load(byName('logs-ok-session_id-fallback.bin'));
    const bytes = Buffer.concat([good, Buffer.from([0x0a, 0x7f])]);
    expect(proveRange(bytes, { sessionId, project, signal: 'logs' })).toEqual({ verified: good.length, hold: 'otlp_unparseable' });
  });
});

describe('proveHookLines', () => {
  const ev = (o: Record<string, unknown>): string => JSON.stringify(o) + '\n';
  const env = (o: Record<string, unknown>): string => ev({ agentName: 'a', hookEvent: JSON.stringify(o) });

  it('accepts matching bare and enveloped lines, case-insensitive project, blank project', () => {
    const s = ev({ session_id: 's1', codemie_project_name: 'P' }) + env({ session_id: 's1', codemie_project_name: '' });
    expect(proveHookLines(s, { sessionId: 's1', project: 'p' })).toEqual({ verified: Buffer.byteLength(s) });
  });

  it('skips unparseable lines and leaves an unterminated tail unverified without a hold', () => {
    const a = ev({ session_id: 's1' });
    const s = 'not json\n' + a + '{"session_id":"s1"';
    expect(proveHookLines(Buffer.from(s), { sessionId: 's1' })).toEqual({ verified: Buffer.byteLength('not json\n' + a) });
  });

  it.each([
    [{}, 'session_id_absent'],
    [{ session_id: '' }, 'session_id_absent'],
    [{ session_id: 's2' }, 'session_mismatch'],
    [{ session_id: 12 }, 'session_mismatch'],
    [{ session_id: 's1', codemie_project_name: 'other' }, 'project_conflict'],
  ])('holds %j as %s and keeps the prior lines', (body, reason) => {
    const good = env({ session_id: 's1' });
    const s = good + env(body as Record<string, unknown>) + env({ session_id: 's1' });
    expect(proveHookLines(s, { sessionId: 's1', project: 'proj' })).toEqual({ verified: Buffer.byteLength(good), hold: reason });
  });

  it('any project value is a conflict when the record has no project', () => {
    expect(proveHookLines(ev({ session_id: 's1', codemie_project_name: 'x' }), { sessionId: 's1' }).hold).toBe('project_conflict');
  });
});
