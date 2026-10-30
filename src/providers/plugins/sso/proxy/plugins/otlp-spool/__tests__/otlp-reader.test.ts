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

describe('proveRange bounded windows (CR003)', () => {
  const f = byName('traces-ok.bin');
  const one = load(f);
  const opts = { sessionId, project, signal: 'traces' as const };

  it('a window ending inside an entry verifies the whole entries before it and is cut, not held', () => {
    const bytes = Buffer.concat([one, one, one]);
    const window = bytes.subarray(0, one.length * 2 + 7); // third entry cut mid-way
    expect(proveRange(window, { ...opts, more: true })).toEqual({ verified: one.length * 2, windowCut: true });
    // Without `more` the same bytes are a genuine truncation: held.
    expect(proveRange(window, opts)).toEqual({ verified: one.length * 2, hold: 'otlp_unparseable' });
  });

  it('many small valid entries whose total exceeds the cap drain window by window with exact cursors', () => {
    const total = Buffer.concat(Array.from({ length: 12 }, () => one));
    const cap = one.length * 5 + 3; // window size: 5 whole entries plus a partial one
    let cursor = 0;
    const sent: number[] = [];
    while (cursor < total.length) {
      const window = total.subarray(cursor, cursor + cap);
      const more = cursor + cap < total.length;
      const r = proveRange(window, { ...opts, more });
      expect(r.hold).toBeUndefined();
      expect(r.verified).toBeGreaterThan(0);
      sent.push(r.verified);
      cursor += r.verified;
    }
    expect(cursor).toBe(total.length);
    expect(sent.every((n) => n % one.length === 0)).toBe(true);
  });

  it('a window that holds a genuinely bad entry after a good one still holds with the real reason', () => {
    const bad = load(byName('traces-mixed-ids.bin'));
    const r = proveRange(Buffer.concat([one, bad]), { ...opts, more: true });
    expect(r.verified).toBe(one.length);
    expect(r.hold).toBe('session_mismatch');
  });

  it('a single entry larger than the cap has its own explicit reason, even when only its header is in the window', () => {
    const header = Buffer.from([0x0a, 0x80, 0x80, 0x80, 0x03]); // field 1, length 6 MiB
    expect(proveRange(Buffer.concat([header, Buffer.alloc(1000)]), { ...opts, more: true })).toEqual({ verified: 0, hold: 'otlp_entry_too_large' });
  });
});
