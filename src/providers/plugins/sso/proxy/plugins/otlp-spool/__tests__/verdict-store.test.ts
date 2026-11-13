import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVerdictState, recordVerdict, readVerdict, replaceVerdict, forwardDecisionWithoutPolicy } from '../verdict-store.js';
import { createOrRead, recordKey, sweepRecords, evidenceDir } from '@/agents/core/evidence/record-store.js';
import type { ClassResult } from '@/agents/core/evidence/classify.js';

const personal: ClassResult = { class: 'personal', status: 'determinate', basis: 'org_no_match', policy_version: 'v1' };
const corp: ClassResult = { class: 'corporate', status: 'determinate', basis: 'org_match', policy_version: 'v2' };
const unknown: ClassResult = { class: 'unknown', status: 'indeterminate', basis: 'policy_unavailable' };
let home: string;
let saved: string | undefined;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'verd-')); saved = process.env.CODEMIE_HOME; process.env.CODEMIE_HOME = home; });
afterEach(() => { if (saved === undefined) delete process.env.CODEMIE_HOME; else process.env.CODEMIE_HOME = saved; rmSync(home, { recursive: true, force: true }); });

describe('verdict-store', () => {
  it('only a determinate personal becomes sticky; later results never overwrite', async () => {
    const k = 'k'.repeat(64);
    expect(await recordVerdict(k, unknown)).toBeNull();
    expect(await recordVerdict(k, corp)).toBeNull();
    expect(await readVerdict(k)).toBeNull();
    expect((await recordVerdict(k, personal))?.class).toBe('personal');
    expect((await recordVerdict(k, corp))?.class).toBe('personal');
    expect((await readVerdict(k))?.class).toBe('personal');
  });

  it('replace needs a fresh usable policy and a determinate result carrying its version', async () => {
    const k = 'k'.repeat(64);
    expect(await replaceVerdict(k, corp, true)).toBe(false); // nothing to replace
    await recordVerdict(k, personal);
    expect(await replaceVerdict(k, corp, false)).toBe(false);
    expect(await replaceVerdict(k, unknown, true)).toBe(false);
    expect((await readVerdict(k))?.class).toBe('personal');
    expect(await replaceVerdict(k, corp, true)).toBe(true);
    expect((await readVerdict(k))?.class).toBe('corporate');
  });

  it('IR-CLI002: missing, corrupt and unreadable are distinct states (only ENOENT is none)', async () => {
    const k = 'k'.repeat(64);
    expect(await readVerdictState(k)).toEqual({ state: 'none' });
    mkdirSync(evidenceDir(), { recursive: true });
    writeFileSync(join(evidenceDir(), `${k}.verdict.json`), '{bad');
    expect(await readVerdictState(k)).toEqual({ state: 'unreadable' });
    const d = 'd'.repeat(64);
    mkdirSync(join(evidenceDir(), `${d}.verdict.json`)); // EISDIR
    expect(await readVerdictState(d)).toEqual({ state: 'unreadable' });
    // A determinate Personal repairs a corrupt file; it is then sticky.
    expect((await recordVerdict(k, personal))?.class).toBe('personal');
    expect(await readVerdictState(k)).toMatchObject({ state: 'ok' });
  });

  it('corrupt verdict file reads as null', async () => {
    const k = 'k'.repeat(64);
    mkdirSync(evidenceDir(), { recursive: true });
    writeFileSync(join(evidenceDir(), `${k}.verdict.json`), '{');
    expect(await readVerdict(k)).toBeNull();
  });

  it('forwardDecisionWithoutPolicy (I5, AC16)', () => {
    const p = { class: 'personal' as const };
    expect(forwardDecisionWithoutPolicy({ verdict: p, capability: 'evidence' })).toBe('full_evidence');
    expect(forwardDecisionWithoutPolicy({ verdict: p, capability: 'legacy' })).toBe('hold_personal_not_forwardable');
    expect(forwardDecisionWithoutPolicy({ verdict: p, capability: 'unknown' })).toBe('hold_personal_not_forwardable');
    expect(forwardDecisionWithoutPolicy({ verdict: null, capability: 'legacy' })).toBe('legacy_ok');
    expect(forwardDecisionWithoutPolicy({ verdict: { class: 'corporate' }, capability: 'legacy' })).toBe('legacy_ok');
    expect(forwardDecisionWithoutPolicy({ verdict: null, capability: 'evidence' })).toBe('full_evidence');
  });

  it('verdict file is swept with its record, never while pending', async () => {
    const f = { session_id: 's1', launch_mode: 'native' as const, routed_via_codemie: false, routing_proof: 'proven' as const,
      project_source: 'none' as const, api_identity: 'https://x.example.com', owner_hash: 'a'.repeat(64) };
    const key = recordKey(f.api_identity, f.owner_hash, f.session_id);
    await createOrRead(key, f);
    await recordVerdict(key, personal);
    const rf = join(evidenceDir(), `${key}.json`);
    const rec = JSON.parse(readFileSync(rf, 'utf-8'));
    writeFileSync(rf, JSON.stringify({ ...rec, last_used: Date.now() - 400 * 86_400_000 }));
    await sweepRecords({ pendingKeys: new Set([key]) });
    expect(readdirSync(evidenceDir())).toContain(`${key}.verdict.json`);
    await sweepRecords({ pendingKeys: new Set() });
    expect(readdirSync(evidenceDir()).filter((n) => n.startsWith(key))).toEqual([]);
  });
});
