import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getPolicyState, refreshPolicy, namespaceKey, BACKOFF_MS, POLICY_USABLE_MS, LEGACY_REPROBE_MS, POLICY_PATH,
  type NamespaceId,
} from '../policy-cache.js';
import { evidenceDir } from '@/agents/core/evidence/record-store.js';

const ns: NamespaceId = { api_identity: 'https://a.example.com/api', owner_hash: 'b'.repeat(64) };
const auth = { Cookie: 'x=fabricated' };
const T0 = 1_800_000_000_000;
let home: string;
let saved: string | undefined;

const json = (status: number, body: unknown, ct = 'application/json') =>
  (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': ct } })) as unknown as typeof fetch;
const okFetch = json(200, { organizations: ['Org A'], version: 'v1' });
const run = (fetchImpl: typeof fetch, now: number, id = ns, headers: Record<string, string> | null = auth, force = false) =>
  refreshPolicy(id, { baseUrl: 'https://a.example.com/api/', headers, fetchImpl, now, force });

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'pol-')); saved = process.env.CODEMIE_HOME; process.env.CODEMIE_HOME = home; });
afterEach(() => { if (saved === undefined) delete process.env.CODEMIE_HOME; else process.env.CODEMIE_HOME = saved; rmSync(home, { recursive: true, force: true }); });

describe('policy-cache', () => {
  it('200 valid => evidence + usable policy for 24h, then unusable but still evidence', async () => {
    let url = '';
    const f = (async (u: string) => { url = u; return okFetch(u); }) as unknown as typeof fetch;
    const s = await run(f, T0);
    expect(url).toBe(`https://a.example.com/api${POLICY_PATH}`);
    expect(s).toMatchObject({ capability: 'evidence', usable: true, policy: { version: 'v1' } });
    expect((await getPolicyState(ns, { now: T0 + POLICY_USABLE_MS - 1 })).usable).toBe(true);
    const old = await getPolicyState(ns, { now: T0 + POLICY_USABLE_MS });
    expect(old).toMatchObject({ usable: false, policy: null, capability: 'evidence', refreshDue: true });
  });

  it('authed 404 => legacy, re-probe after 1h recovers to evidence', async () => {
    const s = await run(json(404, 'nf'), T0);
    expect(s).toMatchObject({ capability: 'legacy', usable: false });
    // within the hour: not due, and refresh does not even fetch
    let calls = 0;
    const counting = (async (u: string) => { calls++; return okFetch(u); }) as unknown as typeof fetch;
    expect((await getPolicyState(ns, { now: T0 + LEGACY_REPROBE_MS - 1 })).refreshDue).toBe(false);
    await run(counting, T0 + LEGACY_REPROBE_MS - 1);
    expect(calls).toBe(0);
    expect((await getPolicyState(ns, { now: T0 + LEGACY_REPROBE_MS })).refreshDue).toBe(true);
    const r = await run(counting, T0 + LEGACY_REPROBE_MS);
    expect(r).toMatchObject({ capability: 'evidence', usable: true });
  });

  it.each([
    ['401', json(401, '{}')], ['403', json(403, '{}')], ['302', json(302, '')], ['500', json(500, '{}')],
    ['503', json(503, '{}')], ['html 200', json(200, '<html>login</html>', 'text/html')],
    ['bad shape', json(200, { organizations: 'x' })], ['oversize', json(200, 'x'.repeat(300_000))],
    ['timeout', (async () => { throw new DOMException('t', 'TimeoutError'); }) as unknown as typeof fetch],
  ])('%s never becomes legacy; backoff 5 min', async (_n, f) => {
    const s = await run(f, T0);
    expect(s.capability).toBe('unknown');
    expect(s.usable).toBe(false);
    expect(s.backoffUntil).toBe(T0 + BACKOFF_MS);
    expect(s.refreshDue).toBe(false);
    expect((await getPolicyState(ns, { now: T0 + BACKOFF_MS })).refreshDue).toBe(true);
  });

  it('unauthenticated 404 is unknown, not legacy', async () => {
    expect((await run(json(404, 'nf'), T0, ns, null)).capability).toBe('unknown');
  });

  it('previous evidence stays evidence (and policy) through unknown outcomes', async () => {
    await run(okFetch, T0);
    const s = await run(json(500, '{}'), T0 + 1000, ns, auth, true);
    expect(s).toMatchObject({ capability: 'evidence', usable: true });
  });

  it('backoff skips fetching unless forced', async () => {
    await run(json(500, '{}'), T0);
    let calls = 0;
    const f = (async (u: string) => { calls++; return okFetch(u); }) as unknown as typeof fetch;
    await run(f, T0 + 1000);
    expect(calls).toBe(0);
    await run(f, T0 + 1000, ns, auth, true);
    expect(calls).toBe(1);
  });

  it('namespaces share nothing (two base paths, owners, profiles); identity mismatch is ignored', async () => {
    await run(okFetch, T0);
    const other = { ...ns, api_identity: 'https://a.example.com/other' };
    expect(await getPolicyState(other, { now: T0 })).toMatchObject({ usable: false, capability: 'unknown' });
    expect((await getPolicyState({ ...ns, owner_hash: 'c'.repeat(64) }, { now: T0 })).usable).toBe(false);
    expect((await getPolicyState({ ...ns, profile: 'p2' }, { now: T0 })).usable).toBe(false);
    expect(namespaceKey(ns)).not.toBe(namespaceKey(other));
    const legacyOther = await run(json(404, 'nf'), T0, other);
    expect(legacyOther.capability).toBe('legacy');
    expect((await getPolicyState(ns, { now: T0 })).capability).toBe('evidence');
    // a file placed under ns's name with another identity is ignored
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(evidenceDir(), `${namespaceKey(ns)}.policy.json`),
      JSON.stringify({ schema: 1, api_identity: 'https://evil', owner_hash: ns.owner_hash, capability: 'legacy' }));
    expect((await getPolicyState(ns, { now: T0 })).capability).toBe('unknown');
  });

  it('IR-CLI001 sibling: the policy body read is genuinely bounded (no content-length, chunked) and a failing read is unknown', async () => {
    const chunk = new Uint8Array(64 * 1024);
    let reads = 0;
    const endless = (async () => ({
      status: 200, headers: new Headers(),
      body: { getReader: () => ({ read: async () => { reads++; return { done: false, value: chunk }; }, cancel: async () => undefined }) },
    })) as unknown as typeof fetch;
    expect((await run(endless, T0)).capability).toBe('unknown');
    expect(reads).toBeLessThanOrEqual(5); // stopped near the 256 KiB cap, not read forever
    const broken = (async () => ({
      status: 200, headers: new Headers(),
      body: { getReader: () => ({ read: async () => { throw new Error('reset'); } }) },
    })) as unknown as typeof fetch;
    expect((await run(broken, T0 + 1, ns, auth, true)).capability).toBe('unknown');
  });

  it('stores no credentials or org names beyond the policy file', async () => {
    await run(okFetch, T0);
    const { readFileSync } = await import('node:fs');
    const f = readdirSync(evidenceDir()).find((n) => n.endsWith('.policy.json'))!;
    expect(readFileSync(join(evidenceDir(), f), 'utf-8')).not.toContain('fabricated');
  });
});
