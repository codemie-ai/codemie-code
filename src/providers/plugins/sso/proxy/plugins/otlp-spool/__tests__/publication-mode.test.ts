import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicationMode } from '../publication-mode.js';
import type { PolicyState } from '../policy-cache.js';
import type { ClassResult } from '@/agents/core/evidence/classify.js';
import { evidenceDir, publicationModeFileName, type EvidenceRecord } from '@/agents/core/evidence/record-store.js';

vi.mock('@/utils/logger.js', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));
let home: string;
const record: EvidenceRecord = {
  schema: 1, session_id: 'session', launch_mode: 'managed', routed_via_codemie: true,
  routing_proof: 'proven', project: 'work', project_source: 'profile',
  api_identity: 'https://api.example.com', owner_hash: 'a'.repeat(64), created: 0, last_used: 0,
  funding_route: 'api_based', negotiate_publication: true,
};
const routed: ClassResult = { class: 'codemie', status: 'determinate', basis: 'routed' };
const state = (capability: PolicyState['capability'], contracts?: string[]): PolicyState => ({
  capability, policy: capability === 'evidence' ? { organizations: ['Acme'], version: 'v1' } : null,
  usable: capability === 'evidence', refreshDue: false, publicationContracts: contracts,
});
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'publication-'));
  vi.stubEnv('CODEMIE_HOME', home);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

describe('durable publication protocol', () => {
  it.each(['legacy', 'evidence'] as const)('pins safe %s fallback across backend upgrades and a restarted caller', async (capability) => {
    expect(await publicationMode('key', record, state(capability), routed)).toBe(capability);
    expect(await publicationMode('key', { ...record }, state('evidence', ['1']), routed)).toBe(capability);
  });

  it('never downgrades a contract-bound session, including records created before negotiation existed', async () => {
    expect(await publicationMode('key', record, state('evidence', ['1']), routed)).toBe('contract');
    expect(await publicationMode('key', record, state('legacy'), routed)).toBeNull();
    expect(await publicationMode('old', { ...record, negotiate_publication: undefined }, state('evidence'), routed)).toBeNull();
    expect(await publicationMode('old', { ...record, negotiate_publication: undefined }, state('evidence', ['1']), routed)).toBe('contract');
  });

  it.each([
    ['personal', { class: 'personal', status: 'determinate', basis: 'org_no_match' }, {}],
    ['unknown', { class: 'unknown', status: 'determinate', basis: 'no_org' }, {}],
    ['indeterminate', { class: 'unknown', status: 'indeterminate', basis: 'policy_unavailable' }, {}],
    ['unproven routing', routed, { routing_proof: 'unproven' }],
    ['explicit consent', routed, { consent_ref: 'a'.repeat(16) }],
  ])('holds %s on an old backend without freezing a fallback', async (_name, result, delta) => {
    const candidate = { ...record, ...delta } as EvidenceRecord;
    expect(await publicationMode('key', candidate, state('legacy'), result as ClassResult)).toBeNull();
    expect(await publicationMode('key', candidate, state('evidence', ['1']), result as ClassResult)).toBe('contract');
  });

  it('allows a proven corporate subscription but holds unavailable capability or policy', async () => {
    const corporate: ClassResult = { class: 'corporate', status: 'determinate', basis: 'org_match' };
    expect(await publicationMode('corp', { ...record, funding_route: 'subscription' }, state('evidence'), corporate)).toBe('evidence');
    expect(await publicationMode('unknown', record, state('unknown'), routed)).toBeNull();
    expect(await publicationMode('expired', record, { ...state('evidence'), policy: null }, routed)).toBeNull();
  });

  it('rechecks safe classification before sending on a frozen fallback', async () => {
    expect(await publicationMode('key', record, state('evidence'), routed)).toBe('evidence');
    expect(await publicationMode('key', record, state('evidence', ['1']), {
      class: 'personal', status: 'determinate', basis: 'org_no_match',
    })).toBeNull();
  });

  it('fails closed on a corrupt decision rather than choosing another protocol', async () => {
    await mkdir(evidenceDir(), { recursive: true });
    await writeFile(join(evidenceDir(), publicationModeFileName('key')), '{');
    expect(await publicationMode('key', record, state('evidence', ['1']), routed)).toBeNull();
  });

  it('concurrent selectors use one durable winner', async () => {
    const choices = await Promise.all([
      publicationMode('key', record, state('legacy'), routed),
      publicationMode('key', record, state('evidence', ['1']), routed),
    ]);
    const chosen = await publicationMode('key', record, state('evidence', ['1']), routed);
    expect(['legacy', 'contract']).toContain(chosen);
    expect(choices.every((choice) => choice === null || choice === chosen)).toBe(true);
  });
});
