/**
 * CR-011 sender contract: an organization the plain header cannot carry travels only in
 * `X-CodeMie-Organization-Encoded: utf8-b64u.v1:<base64url>`, and only to a namespace whose usable policy
 * advertises it. Shared vectors (the backend decoder tests use the same strings).
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ORG_ENCODED_HEADER,
  encodeOrganization,
  needsOrganizationEncoding,
  organizationSendable,
} from '@/agents/core/evidence/org-encoding.js';

const readVerdictStateMock = vi.fn();
const recordVerdictMock = vi.fn();
vi.mock('../verdict-store.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readVerdictState: readVerdictStateMock,
  recordVerdict: recordVerdictMock,
  replaceVerdict: vi.fn(async () => true),
}));
vi.mock('@/utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const VECTORS: Array<[string, string]> = [
  ['Яндекс', '0K_QvdC00LXQutGB'],
  ['株式会社', '5qCq5byP5Lya56S-'],
  ['𝔘nicorp', '8J2UmG5pY29ycA'],
];

describe('encodeOrganization vectors', () => {
  it.each(VECTORS)('%s -> canonical unpadded base64url behind the version tag', (org, payload) => {
    expect(needsOrganizationEncoding(org)).toBe(true);
    expect(encodeOrganization(org)).toBe(`utf8-b64u.v1:${payload}`);
  });

  it('preserves the original text: no trim, casefold or normalization before encoding', () => {
    const out = encodeOrganization('  Яндекс ')!;
    expect(Buffer.from(out.slice('utf8-b64u.v1:'.length), 'base64url').toString('utf-8')).toBe('  Яндекс ');
  });

  it('Latin-1 and literal-% names stay on the plain header', () => {
    for (const org of ['Acme', 'Müller GmbH', 'Acme%20Corp']) expect(needsOrganizationEncoding(org)).toBe(false);
  });

  it('length limits are code points (<=256) and UTF-8 bytes (<=1024), not bytes alone', () => {
    expect(encodeOrganization('я'.repeat(256))).toBeDefined(); // 512 bytes
    expect(encodeOrganization('я'.repeat(257))).toBeUndefined();
    expect(encodeOrganization('株'.repeat(256))).toBeDefined(); // 768 bytes
    expect(encodeOrganization('𝔘'.repeat(256))).toBeDefined(); // 1024 bytes, 256 code points
    expect(encodeOrganization('𝔘'.repeat(257))).toBeUndefined();
    expect(encodeOrganization('я'.repeat(256))!.length - 'utf8-b64u.v1:'.length).toBeLessThanOrEqual(1366);
    expect(encodeOrganization('𝔘'.repeat(256))!.length - 'utf8-b64u.v1:'.length).toBeLessThanOrEqual(1366);
  });

  it.each([
    ['blank', '   '],
    ['control char', 'Яндекс\u0007'],
    ['C1 control', 'Яндекс\u0085'],
    ['lone surrogate', 'Яндекс\ud800'],
  ])('%s is not encodable', (_n, org) => {
    expect(encodeOrganization(org)).toBeUndefined();
  });

  it('sendable only with the advertised version (plain-representable values need nothing)', () => {
    expect(organizationSendable('Acme', undefined)).toBe(true);
    expect(organizationSendable('Яндекс', undefined)).toBe(false);
    expect(organizationSendable('Яндекс', [])).toBe(false);
    expect(organizationSendable('Яндекс', ['utf8-b64u.v2'])).toBe(false);
    expect(organizationSendable('Яндекс', ['utf8-b64u.v1'])).toBe(true);
    expect(organizationSendable('Яндекс\u0007', ['utf8-b64u.v1'])).toBe(false);
  });
});

const rec = (over: Record<string, unknown> = {}) =>
  ({
    schema: 1, session_id: 's1', launch_mode: 'native', routed_via_codemie: false, routing_proof: 'proven',
    organization: 'Яндекс', project_source: 'none', api_identity: 'https://api', owner_hash: 'h', created: 0, last_used: 0, ...over,
  }) as never;
const SUPPORTED = { organizations: ['Other'], version: 'v1', organization_encodings: ['utf8-b64u.v1'] };
const UNSUPPORTED = { organizations: ['Other'], version: 'v1' };
const HOLD = { action: 'hold', reason: 'organization_encoding_unsupported' };

describe('classifySession organization encoding gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readVerdictStateMock.mockResolvedValue({ state: 'none' });
    recordVerdictMock.mockResolvedValue({ schema: 1, class: 'personal', created: 0 });
  });

  it('supported namespace policy: a known unrepresentable org is sent (personal, evidence intact)', async () => {
    const { classifySession } = await import('../classification.js');
    expect(await classifySession('k', rec(), { policy: SUPPORTED, capability: 'evidence' }))
      .toMatchObject({ action: 'send', result: { class: 'personal', policy_version: 'v1' } });
  });

  it('usable policy without the advertisement: held, never sent and never downgraded to unknown', async () => {
    const { classifySession } = await import('../classification.js');
    expect(await classifySession('k', rec(), { policy: UNSUPPORTED, capability: 'evidence' })).toEqual(HOLD);
  });

  it('expired/absent policy (capability lost): held; the retry sends once the policy advertises it', async () => {
    const { classifySession } = await import('../classification.js');
    expect(await classifySession('k', rec(), { policy: null, capability: 'evidence' })).toEqual(HOLD);
    expect(await classifySession('k', rec(), { policy: SUPPORTED, capability: 'evidence' })).toMatchObject({ action: 'send' });
  });

  it('sticky Personal during policy loss is held, not sent as full evidence without the encoding', async () => {
    readVerdictStateMock.mockResolvedValue({ state: 'ok', verdict: { schema: 1, class: 'personal', policy_version: 'v1', created: 0 } });
    const { classifySession } = await import('../classification.js');
    expect(await classifySession('k', rec(), { policy: null, capability: 'evidence' })).toEqual(HOLD);
  });

  it('CodeMie-routed needs no organization and no encoding support', async () => {
    const { classifySession } = await import('../classification.js');
    expect(await classifySession('k', rec({ routed_via_codemie: true }), { policy: null, capability: 'unknown' }))
      .toMatchObject({ action: 'send', result: { class: 'codemie' } });
  });

  it('routing-unproven sends no organization, so it is not blocked on encoding support', async () => {
    const { classifySession } = await import('../classification.js');
    expect(await classifySession('k', rec({ routing_proof: 'unproven' }), { policy: UNSUPPORTED, capability: 'evidence' }))
      .toMatchObject({ action: 'send', result: { class: 'unknown', basis: 'routing_unproven' } });
  });

  it('a representable org is unaffected by the missing advertisement (old backend, Latin-1 and literal %)', async () => {
    const { classifySession } = await import('../classification.js');
    for (const organization of ['Acme', 'Müller GmbH', 'Acme%20Corp']) {
      expect(await classifySession('k', rec({ organization }), { policy: UNSUPPORTED, capability: 'evidence' })).toMatchObject({ action: 'send' });
    }
  });
});

describe('evidence header serialization', () => {
  const headers = async (record: never, result: Record<string, unknown>) => {
    const { evidenceHeaders } = await import('../evidence-send.js');
    return evidenceHeaders('s1', { record, result } as never);
  };
  const personal = { class: 'personal', status: 'determinate', basis: 'org_no_match', policy_version: 'v1' };

  it('unrepresentable org: encoded header only, plain header absent', async () => {
    const h = await headers(rec(), personal);
    expect(h[ORG_ENCODED_HEADER]).toBe('utf8-b64u.v1:0K_QvdC00LXQutGB');
    expect(h).not.toHaveProperty('X-CodeMie-Organization');
  });

  it('representable org: plain header only, byte-identical, literal % untouched', async () => {
    for (const org of ['Acme', 'Müller GmbH', 'Acme%20Corp']) {
      const h = await headers(rec({ organization: org }), personal);
      expect(h['X-CodeMie-Organization']).toBe(org);
      expect(h).not.toHaveProperty(ORG_ENCODED_HEADER);
    }
  });

  it('CodeMie-routed unrepresentable org sends neither representation', async () => {
    const h = await headers(rec({ routed_via_codemie: true }), { class: 'codemie', status: 'determinate', basis: 'routed' });
    expect(h).not.toHaveProperty('X-CodeMie-Organization');
    expect(h).not.toHaveProperty(ORG_ENCODED_HEADER);
  });

  it('routing-unproven sends neither representation', async () => {
    const h = await headers(rec({ routing_proof: 'unproven' }), { class: 'unknown', status: 'indeterminate', basis: 'routing_unproven' });
    expect(h).not.toHaveProperty(ORG_ENCODED_HEADER);
  });
});

describe('hourly re-probe while held on organization_encoding_unsupported', () => {
  const ns = { api_identity: 'https://a.example.com/api', owner_hash: 'b'.repeat(64) };
  const creds = { cookies: { codemie_access_token: 'x' }, apiUrl: 'https://a.example.com/api' } as never;
  const T0 = 1_800_000_000_000;
  let home: string;
  let saved: string | undefined;
  const body = (encodings: string[]) => JSON.stringify({ organizations: ['Other'], version: 'v1', organization_encodings: encodings });

  beforeEach(() => {
    saved = process.env.CODEMIE_HOME;
    home = mkdtempSync(join(tmpdir(), 'org-reprobe-'));
    process.env.CODEMIE_HOME = home;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (saved === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  it('a policy advertising only an unrecognized token is unsupported and re-read after an hour, not after 24 h', async () => {
    const { refreshPolicy } = await import('../policy-cache.js');
    const { sessionPolicyState } = await import('../classification.js');
    const fetchMock = vi.fn(async () => new Response(body(['utf8-b64u.v9']), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await refreshPolicy(ns, { baseUrl: 'https://a.example.com/api', headers: { Cookie: 'x=1' }, now: T0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 30 * 60_000); // inside the hour: cached state is returned
    expect((await sessionPolicyState(ns, 'https://a.example.com/api', creds, undefined, true)).policy?.organization_encodings).toEqual(['utf8-b64u.v9']);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 61 * 60_000); // not held (reprobe off): still the cache
    await sessionPolicyState(ns, 'https://a.example.com/api', creds);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(async () => new Response(body(['utf8-b64u.v9', 'utf8-b64u.v1']), { status: 200 }));
    const state = await sessionPolicyState(ns, 'https://a.example.com/api', creds, undefined, true); // held: re-read
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(organizationSendable('Яндекс', state.policy?.organization_encodings)).toBe(true);
  });

  it('a failed re-read keeps the old policy and honors the refresh backoff (no hammering)', async () => {
    const { refreshPolicy } = await import('../policy-cache.js');
    const { sessionPolicyState } = await import('../classification.js');
    const fetchMock = vi.fn(async () => new Response(body([]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await refreshPolicy(ns, { baseUrl: 'https://a.example.com/api', headers: { Cookie: 'x=1' }, now: T0 });
    fetchMock.mockImplementation(async () => new Response('boom', { status: 500 }));
    vi.setSystemTime(T0 + 61 * 60_000);
    const first = await sessionPolicyState(ns, 'https://a.example.com/api', creds, undefined, true);
    expect(first.policy?.version).toBe('v1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await sessionPolicyState(ns, 'https://a.example.com/api', creds, undefined, true); // inside backoff
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
