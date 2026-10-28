import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordKey, createOrRead, readRecord, touch, sweepRecords, evidenceDir,
  type EvidenceFields,
} from '../record-store.js';

const DAY = 86_400_000;
let home: string;
const saved: Record<string, string | undefined> = {};

function fields(sessionId: string, over: Partial<EvidenceFields> = {}): EvidenceFields {
  return {
    session_id: sessionId, launch_mode: 'native', routed_via_codemie: false, routing_proof: 'proven',
    organization: 'Org', project: 'proj', project_source: 'profile', repo_key: 'h/a/b',
    api_identity: 'https://api.example.com', owner_hash: 'a'.repeat(64), profile: 'p', ...over,
  };
}
const keyOf = (f: EvidenceFields) => recordKey(f.api_identity, f.owner_hash, f.session_id);
const file = (key: string) => join(evidenceDir(), `${key}.json`);
function setLastUsed(key: string, ms: number): void {
  const r = JSON.parse(readFileSync(file(key), 'utf-8'));
  r.last_used = ms;
  writeFileSync(file(key), JSON.stringify(r));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rec-store-'));
  for (const k of ['CODEMIE_HOME', 'CODEMIE_EVIDENCE_RECORD_IDLE_DAYS', 'CODEMIE_EVIDENCE_RECORD_MAX_FILES']) saved[k] = process.env[k];
  process.env.CODEMIE_HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(home, { recursive: true, force: true });
});

describe('record-store', () => {
  it('recordKey is unambiguous', () => {
    expect(recordKey('ab', 'c', 's')).not.toBe(recordKey('a', 'bc', 's'));
    expect(recordKey('a', 'b', 'c')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('concurrent creators converge on one winner', async () => {
    const f = fields('s1');
    const key = keyOf(f);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => createOrRead(key, { ...f, project: `p${i}` })),
    );
    const projects = new Set(results.map((r) => r.record?.project));
    expect(projects.size).toBe(1);
    expect(results.filter((r) => r.kind === 'created')).toHaveLength(1);
    expect(results.every((r) => r.kind === 'created' || r.kind === 'existing')).toBe(true);
    expect(readdirSync(evidenceDir()).filter((n) => n.endsWith('.json'))).toHaveLength(1);
    expect(readdirSync(evidenceDir()).filter((n) => !n.endsWith('.json'))).toHaveLength(0);
  });

  it('stores record fields, under 1 KB, mode 0600', async () => {
    const f = fields('s1');
    const r = await createOrRead(keyOf(f), f);
    expect(r.kind).toBe('created');
    expect(r.record).toMatchObject({ schema: 1, project_source: 'profile', routing_proof: 'proven' });
    expect(statSync(file(keyOf(f))).size).toBeLessThan(1024);
    if (process.platform !== 'win32') expect(statSync(file(keyOf(f))).mode & 0o777).toBe(0o600);
    expect((await readRecord(keyOf(f)))?.kind).toBe('existing');
  });

  it('corrupt file => stamp_invalid and bytes unchanged', async () => {
    const f = fields('s1');
    const key = keyOf(f);
    await createOrRead(key, f);
    writeFileSync(file(key), '{not json');
    const r = await createOrRead(key, f);
    expect(r.kind).toBe('stamp_invalid');
    expect(readFileSync(file(key), 'utf-8')).toBe('{not json');
    expect((await readRecord(key))?.kind).toBe('stamp_invalid');
  });

  it('other schema or mismatched stored identity => stamp_invalid', async () => {
    const f = fields('s1');
    const key = keyOf(f);
    await createOrRead(key, f);
    const orig = readFileSync(file(key), 'utf-8');
    writeFileSync(file(key), JSON.stringify({ ...JSON.parse(orig), schema: 2 }));
    expect((await readRecord(key))?.kind).toBe('stamp_invalid');
    writeFileSync(file(key), JSON.stringify({ ...JSON.parse(orig), owner_hash: 'b'.repeat(64) }));
    expect((await readRecord(key))?.kind).toBe('stamp_invalid');
    writeFileSync(file(key), JSON.stringify({ ...JSON.parse(orig), session_id: 'other' }));
    expect((await createOrRead(key, f)).kind).toBe('stamp_invalid');
  });

  it('missing record reads as undefined', async () => {
    expect(await readRecord('0'.repeat(64))).toBeUndefined();
  });

  it('touch updates last_used at most daily', async () => {
    const f = fields('s1');
    const key = keyOf(f);
    await createOrRead(key, f);
    const before = JSON.parse(readFileSync(file(key), 'utf-8')).last_used;
    await touch(key, before + 1000);
    expect(JSON.parse(readFileSync(file(key), 'utf-8')).last_used).toBe(before);
    await touch(key, before + DAY + 1);
    expect(JSON.parse(readFileSync(file(key), 'utf-8')).last_used).toBe(before + DAY + 1);
  });

  it('evicts idle>90d unless pending; keeps recent; ignores non-record files', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map((s) => fields(s));
    for (const f of [a, b, c]) await createOrRead(keyOf(f), f);
    const now = Date.now();
    setLastUsed(keyOf(a), now - 91 * DAY);
    setLastUsed(keyOf(b), now - 91 * DAY);
    setLastUsed(keyOf(c), now - 10 * DAY);
    writeFileSync(join(evidenceDir(), 'notes.txt'), 'x');
    const res = await sweepRecords({ pendingKeys: new Set([keyOf(b)]) });
    expect(res.capacityBlocked).toBe(false);
    const names = readdirSync(evidenceDir());
    expect(names).toContain('notes.txt');
    expect(names).not.toContain(`${keyOf(a)}.json`);
    expect(names).toContain(`${keyOf(b)}.json`);
    expect(names).toContain(`${keyOf(c)}.json`);
  });

  it('over cap evicts oldest non-pending first', async () => {
    process.env.CODEMIE_EVIDENCE_RECORD_MAX_FILES = '2';
    const fs4 = ['a', 'b', 'c', 'd'].map((s) => fields(s));
    process.env.CODEMIE_EVIDENCE_RECORD_MAX_FILES = '100';
    for (const f of fs4) await createOrRead(keyOf(f), f);
    const now = Date.now();
    fs4.forEach((f, i) => setLastUsed(keyOf(f), now - (4 - i) * DAY)); // a oldest
    process.env.CODEMIE_EVIDENCE_RECORD_MAX_FILES = '2';
    const res = await sweepRecords({ pendingKeys: new Set([keyOf(fs4[0])]) });
    expect(res.capacityBlocked).toBe(false);
    const left = readdirSync(evidenceDir()).sort();
    expect(left).toEqual([`${keyOf(fs4[0])}.json`, `${keyOf(fs4[3])}.json`].sort());
  });

  it('cap blocked by pending => evidence_capacity for new keys, existing still readable', async () => {
    process.env.CODEMIE_EVIDENCE_RECORD_MAX_FILES = '2';
    const [a, b, n] = ['a', 'b', 'n'].map((s) => fields(s));
    await createOrRead(keyOf(a), a);
    await createOrRead(keyOf(b), b);
    const pendingKeys = new Set([keyOf(a), keyOf(b)]);
    expect((await sweepRecords({ pendingKeys, reserve: 1 })).capacityBlocked).toBe(true);
    expect((await createOrRead(keyOf(n), n, { pendingKeys })).kind).toBe('evidence_capacity');
    expect((await createOrRead(keyOf(n), n)).kind).toBe('evidence_capacity');
    expect((await createOrRead(keyOf(a), a)).kind).toBe('existing');
    expect(readdirSync(evidenceDir())).toHaveLength(2);
  });

  it('new key at cap evicts an idle non-pending record when pendingKeys supplied', async () => {
    process.env.CODEMIE_EVIDENCE_RECORD_MAX_FILES = '1';
    const [a, n] = ['a', 'n'].map((s) => fields(s));
    await createOrRead(keyOf(a), a);
    const r = await createOrRead(keyOf(n), n, { pendingKeys: new Set() });
    expect(r.kind).toBe('created');
    expect(readdirSync(evidenceDir())).toEqual([`${keyOf(n)}.json`]);
  });
});
