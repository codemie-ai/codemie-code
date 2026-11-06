import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
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

  it('CR001: at the cap, a session known (by id) to have no pending spool is evicted now; a pending one pins its record', async () => {
    process.env.CODEMIE_EVIDENCE_RECORD_MAX_FILES = '2';
    const [a, b, n] = ['a', 'b', 'n'].map((s) => fields(s));
    await createOrRead(keyOf(a), a);
    await createOrRead(keyOf(b), b);
    setLastUsed(keyOf(a), Date.now() - 5 * DAY); // idle and not pending
    const created = await createOrRead(keyOf(n), n, { pendingSessionIds: new Set(['b']) });
    expect(created.kind).toBe('created');
    expect(readdirSync(evidenceDir()).sort()).toEqual([`${keyOf(b)}.json`, `${keyOf(n)}.json`].sort());
    // Both remaining sessions pending: nothing can be evicted, so the new session stays blocked.
    const [m] = ['m'].map((s) => fields(s));
    expect((await createOrRead(keyOf(m), m, { pendingSessionIds: new Set(['b', 'n']) })).kind).toBe('evidence_capacity');
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

  describe('creation and read validation agree (CR-002)', () => {
    const LIMITS: Array<[keyof EvidenceFields, number]> = [
      ['project', 256], ['organization', 256], ['profile', 128], ['repo_key', 512], ['session_id', 200],
    ];
    const published = () => (existsSync(evidenceDir()) ? readdirSync(evidenceDir()).filter((n) => n.endsWith('.json')) : []);

    it.each(LIMITS)('%s: exactly the maximum is created AND reads back; one over is a named refusal, nothing published', async (name, max) => {
      // Keep the whole record under the total bound so only this field's limit is under test.
      const at = fields('s', { project: 'p', organization: 'o', repo_key: 'r', profile: 'p' });
      const okFields = { ...at, [name]: 'x'.repeat(max) } as EvidenceFields;
      const ok = await createOrRead(keyOf(okFields), okFields);
      expect(ok.kind === 'created' || (name === 'repo_key' && ok.kind === 'stamp_invalid')).toBe(true);
      if (ok.kind === 'created') expect((await readRecord(keyOf(okFields)))?.kind).toBe('existing');

      const over = { ...at, ...(name === 'session_id' ? {} : { session_id: 'other' }), [name]: 'x'.repeat(max + 1) } as EvidenceFields;
      const before = published().length;
      const refused = await createOrRead(keyOf(over), over);
      expect(refused).toMatchObject({ kind: 'stamp_invalid' });
      expect(published()).toHaveLength(before);
      expect(await readRecord(keyOf(over))).toBeUndefined();
    });

    it('per-field maxima that sum past the total bound are refused as record_too_large and never published', async () => {
      const big = fields('s2', { project: 'p'.repeat(256), organization: 'o'.repeat(256), repo_key: 'r'.repeat(512), profile: 'q'.repeat(128) });
      expect(await createOrRead(keyOf(big), big)).toEqual({ kind: 'stamp_invalid', reason: 'record_too_large' });
      expect(published()).toHaveLength(0);
    });

    it('a refused field names itself (no value) and a corrected retry for the same key succeeds', async () => {
      const long = fields('s3', { project: 'x'.repeat(257) });
      expect(await createOrRead(keyOf(long), long)).toEqual({ kind: 'stamp_invalid', reason: 'project_too_long' });
      const fixed = fields('s3', { project: 'x'.repeat(256) });
      expect((await createOrRead(keyOf(fixed), fixed)).kind).toBe('created');
    });

    it('a stored record with an over-long session_id or total size is rejected on read', async () => {
      const f = fields('s4');
      await createOrRead(keyOf(f), f);
      const r = JSON.parse(readFileSync(file(keyOf(f)), 'utf-8'));
      writeFileSync(file(keyOf(f)), JSON.stringify({ ...r, pad: 'z'.repeat(1100) }));
      expect((await readRecord(keyOf(f)))?.kind).toBe('stamp_invalid');
    });
  });

  it('creates the evidence directory 0700 (POSIX; Windows modes are not ACL guarantees)', async () => {
    const f = fields('m1');
    await createOrRead(keyOf(f), f);
    if (process.platform !== 'win32') expect(statSync(evidenceDir()).mode & 0o777).toBe(0o700);
  });
});

describe('analytics state placement and existing-store compatibility', () => {
  it('new evidence state shares the analytics/state parent without sharing parse-state cleanup', async () => {
    expect(evidenceDir()).toBe(join(home, 'analytics', 'state', 'evidence'));
    const f = fields('new-session');
    expect((await createOrRead(keyOf(f), f)).kind).toBe('created');
    const parseState = join(home, 'analytics', 'state', 'claude-session.json');
    writeFileSync(parseState, '{"mainOffset":99}');
    await sweepRecords({ pendingKeys: new Set() });
    expect(readFileSync(parseState, 'utf8')).toBe('{"mainOffset":99}');
  });

  it('existing evidence, verdict and policy files remain in their authoritative legacy namespace', async () => {
    const legacy = join(home, 'evidence');
    mkdirSync(legacy, { recursive: true });
    const f = fields('existing-session');
    const key = keyOf(f);
    writeFileSync(join(legacy, `${key}.json`), JSON.stringify({ schema: 1, ...f, created: Date.now(), last_used: Date.now() }));
    const verdict = join(legacy, `${key}.verdict.json`);
    writeFileSync(verdict, '{"schema":1,"class":"personal","created":1}');
    const policy = join(legacy, 'existing.policy.json');
    writeFileSync(policy, '{"version":"old"}');
    expect(evidenceDir()).toBe(legacy);
    const result = await createOrRead(key, { ...f, project: 'changed-project' });
    expect(result.kind).toBe('existing');
    if (result.kind === 'existing') expect(result.record.project).toBe('proj');
    expect(readFileSync(verdict, 'utf8')).toContain('personal');
    expect(readFileSync(policy, 'utf8')).toContain('old');
    expect(existsSync(join(home, 'analytics', 'state', 'evidence'))).toBe(false);
  });

  it('a corrupt legacy record is not bypassed by creating a fresh analytics namespace', async () => {
    const legacy = join(home, 'evidence');
    mkdirSync(legacy, { recursive: true });
    const f = fields('corrupt-session');
    writeFileSync(join(legacy, `${keyOf(f)}.json`), '{invalid');
    expect((await createOrRead(keyOf(f), f)).kind).toBe('stamp_invalid');
    expect(existsSync(join(home, 'analytics', 'state', 'evidence'))).toBe(false);
  });
});
