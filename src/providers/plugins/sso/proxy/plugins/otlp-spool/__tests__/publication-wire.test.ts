import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evidenceHeaders, sendGuard, type EvidenceContext } from '../evidence-send.js';
import { buildAttributionHeaders } from '../../header-injection.plugin.js';
import { stripAnalyticsOnlyHeaders } from '@/agents/core/evidence/publication-contract.js';
import { connectFolder, resolveConsent, disconnectFolder } from '@/agents/core/evidence/consent-store.js';
import { isStopped } from '@/agents/core/evidence/stop-marker.js';
import { recordKey, type EvidenceRecord } from '@/agents/core/evidence/record-store.js';

let home: string;
let prev: string | undefined;
const owner = 'o'.repeat(64);
const api = 'https://api.example.com';
const rec = (over: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  schema: 1, created: 1, last_used: 1, session_id: 's1', launch_mode: 'native', routed_via_codemie: false, routing_proof: 'proven',
  project: 'proj', project_source: 'none', api_identity: api, owner_hash: owner, funding_route: 'subscription', collection_generation: 0, ...over,
});
const ctx = (record: EvidenceRecord, over: Partial<EvidenceContext> = {}): EvidenceContext => ({
  key: recordKey(api, owner, record.session_id), record, ns: { api_identity: api, owner_hash: owner }, baseUrl: api,
  credentials: {} as never, result: { class: 'personal', status: 'determinate', basis: 'org_no_match', policy_version: 'v1' },
  newContract: true, consent: false, ...over,
});

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'wire-')); prev = process.env.CODEMIE_HOME; process.env.CODEMIE_HOME = join(home, '.codemie'); mkdirSync(join(home, 'repo'), { recursive: true }); });
afterEach(() => { if (prev === undefined) delete process.env.CODEMIE_HOME; else process.env.CODEMIE_HOME = prev; rmSync(home, { recursive: true, force: true }); });

describe('publication headers', () => {
  it('contract and funding on every new-contract request, each once; consent only when held and project present', () => {
    const h = evidenceHeaders('s1', ctx(rec()));
    expect(h['X-CodeMie-Publication-Contract']).toBe('1');
    expect(h['X-CodeMie-Funding-Route']).toBe('subscription');
    expect(h['X-CodeMie-Work-Consent']).toBeUndefined();
    const c = evidenceHeaders('s1', ctx(rec({ consent_ref: 'abcdef0123456789' }), { consent: true }));
    expect(c['X-CodeMie-Work-Consent']).toBe('explicit-folder');
    const names = Object.keys(c).map((n) => n.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    const blank = buildAttributionHeaders({ destination: 'analytics', sessionId: 's', routedViaCodemie: false, subscriptionType: 'personal',
      routingUnproven: false, projectSource: 'none', contract: { fundingRoute: 'unknown', consent: true } }).headers;
    expect(blank['X-CodeMie-Work-Consent']).toBeUndefined();
  });

  it('a legacy-recorded session carries none of the new headers', () => {
    const h = evidenceHeaders('s1', ctx(rec({ funding_route: undefined }), { newContract: false }));
    expect(Object.keys(h).filter((n) => /contract|funding|consent/i.test(n))).toEqual([]);
  });

  it('model requests lose analytics-only headers in any case; unrelated ones stay', () => {
    const headers: Record<string, string> = { 'x-codemie-work-consent': 'explicit-folder', 'X-CODEMIE-FUNDING-ROUTE': 'api_based', 'X-CodeMie-Publication-Contract': '1', 'X-Keep': 'y', 'X-CodeMie-Project': 'p' };
    stripAnalyticsOnlyHeaders(headers);
    expect(headers).toEqual({ 'X-Keep': 'y', 'X-CodeMie-Project': 'p' });
  });
});

describe('sendGuard', () => {
  it('a stopped session sends nothing', async () => {
    const r = rec();
    const { writeStop } = await import('@/agents/core/evidence/stop-marker.js');
    await writeStop(recordKey(api, owner, 's1'), 'folder_changed', 's1');
    expect(await sendGuard(recordKey(api, owner, 's1'), r)).toBe(false);
  });

  it('revoked consent stops the bound session (never downgrades it by dropping the header)', async () => {
    const scope = { owner_hash: owner, api_identity: api, project: 'proj' };
    await connectFolder(scope, join(home, 'repo'));
    const ref = (await resolveConsent(scope, join(home, 'repo')))!;
    const r = rec({ consent_ref: ref });
    const key = recordKey(api, owner, 's1');
    expect(await sendGuard(key, r)).toBe(true);
    await disconnectFolder(scope, join(home, 'repo'));
    expect(await sendGuard(key, r)).toBe(false);
    expect(await isStopped(key)).toBe(true);
  });

  it('a collection generation mismatch stops the session; unreadable preferences send nothing', async () => {
    const key = recordKey(api, owner, 's1');
    mkdirSync(join(home, '.codemie'), { recursive: true });
    writeFileSync(join(home, '.codemie', 'claude-analytics.json'), JSON.stringify({ collectionGeneration: 2 }));
    expect(await sendGuard(key, rec({ collection_generation: 1 }))).toBe(false);
    expect(await isStopped(key)).toBe(true);
    const key2 = recordKey(api, owner, 's2');
    writeFileSync(join(home, '.codemie', 'claude-analytics.json'), 'garbage');
    expect(await sendGuard(key2, rec({ session_id: 's2' }))).toBe(false);
    expect(await isStopped(key2)).toBe(false);
  });

  it('legacy-recorded sessions pass unchanged', async () => {
    expect(await sendGuard(recordKey(api, owner, 's1'), rec({ funding_route: undefined }))).toBe(true);
  });
});
