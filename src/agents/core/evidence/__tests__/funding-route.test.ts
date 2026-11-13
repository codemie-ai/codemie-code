import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fundingRoute, routedViaCodemie, type RoutingInput } from '../routing.js';
import { createOrRead, recordKey, readRecord, type EvidenceFields } from '../record-store.js';

const base = (over: Partial<RoutingInput & { apiKeyHelper?: boolean }> = {}): RoutingInput & { apiKeyHelper?: boolean } =>
  ({ env: {}, codemieProvider: false, ...over });
const funding = (i: RoutingInput & { apiKeyHelper?: boolean }) => fundingRoute(i, routedViaCodemie(i));

describe('fundingRoute', () => {
  it('subscription only for the saved OAuth login with a proven direct route', () => {
    expect(funding(base())).toBe('subscription');
    expect(funding(base({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } }))).toBe('subscription');
  });

  it('api_based on the proven CodeMie route', () => {
    const i = base({
      codemieProvider: true,
      env: {
        CODEMIE_SESSION_ID: 'x', ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000', CODEMIE_BASE_URL: 'http://127.0.0.1:4000',
        CODEMIE_TARGET_API_URL: 'https://llm.example.com/v1', CODEMIE_PROFILE_CONFIG: JSON.stringify({ baseUrl: 'https://llm.example.com/v1' }),
      },
    });
    expect(funding(i)).toBe('api_based');
  });

  it('api_based on a native session routed through the live local proxy daemon', () => {
    const i = base({
      codemieProvider: true,
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4001', ANTHROPIC_AUTH_TOKEN: 'gw' },
      profileBaseUrl: 'https://llm.example.com/v1',
      profileName: 'p',
      localProxy: { url: 'http://127.0.0.1:4001', targetUrl: 'https://llm.example.com/v1', profile: 'p' },
    });
    expect(funding(i)).toBe('api_based');
  });

  it('api_based for a first-party API key on the first-party endpoint only', () => {
    expect(funding(base({ env: { ANTHROPIC_API_KEY: 'k' } }))).toBe('api_based');
    expect(funding(base({ env: { ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't' } }))).toBe('unknown');
    expect(funding(base({ env: { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://gw.example.com' } }))).toBe('unknown');
  });

  it('everything contradictory, ambiguous or unproven is unknown', () => {
    expect(funding(base({ apiKeyHelper: true }))).toBe('unknown');
    expect(funding(base({ settingsUnknown: true }))).toBe('unknown');
    expect(funding(base({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }))).toBe('unknown');
    expect(funding(base({ env: { CLAUDE_CODE_USE_BEDROCK: 'maybe' } }))).toBe('unknown');
    expect(funding(base({ env: { ANTHROPIC_BASE_URL: 'https://gw.example.com' } }))).toBe('unknown');
    expect(funding(base({ env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } }))).toBe('unknown');
    expect(funding(base({ settingsEnv: { ANTHROPIC_BASE_URL: { x: 1 } } }))).toBe('unknown');
  });
});

describe('record funding / generation / consent fields', () => {
  let home: string;
  let prev: string | undefined;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'funding-')); prev = process.env.CODEMIE_HOME; process.env.CODEMIE_HOME = home; });
  afterEach(() => { if (prev === undefined) delete process.env.CODEMIE_HOME; else process.env.CODEMIE_HOME = prev; rmSync(home, { recursive: true, force: true }); });

  const fields = (over: Partial<EvidenceFields> = {}): EvidenceFields => ({
    session_id: 's-1', launch_mode: 'managed', routed_via_codemie: true, routing_proof: 'proven', organization: 'o'.repeat(40),
    project: 'proj-with-a-fairly-long-name', project_source: 'profile', repo_key: 'github.com/some-org/some-repo',
    api_identity: 'https://codemie.example.com/code-assistant-api', owner_hash: 'a'.repeat(64), profile: 'claude-personal',
    funding_route: 'subscription', collection_generation: 123, consent_ref: 'abcdef0123456789', ...over,
  });
  const keyOf = (f: EvidenceFields) => recordKey(f.api_identity, f.owner_hash, f.session_id);

  it('is first-wins: a later stamp with another funding claim returns the frozen record', async () => {
    const f = fields();
    await createOrRead(keyOf(f), f);
    const again = await createOrRead(keyOf(f), { ...f, funding_route: 'api_based', collection_generation: 9 });
    expect(again.kind).toBe('existing');
    expect(again.kind === 'existing' && again.record.funding_route).toBe('subscription');
    expect(again.kind === 'existing' && again.record.collection_generation).toBe(123);
  });

  it('a realistic record with all new fields stays well under the 1024 cap', async () => {
    const f = fields();
    const r = await createOrRead(keyOf(f), f);
    expect(r.kind).toBe('created');
    expect(JSON.stringify((r as { record: unknown }).record).length).toBeLessThan(800);
  });

  it('old records without the new fields stay valid and read as legacy (no silent upgrade)', async () => {
    const f = fields({ funding_route: undefined, collection_generation: undefined, consent_ref: undefined });
    await createOrRead(keyOf(f), f);
    const r = await readRecord(keyOf(f));
    expect(r?.kind).toBe('existing');
    expect(r?.kind === 'existing' && r.record.funding_route).toBeUndefined();
  });

  it('rejects invalid values and consent without the new contract', async () => {
    for (const bad of [{ funding_route: 'free' }, { collection_generation: -1 }, { consent_ref: 'not-hex' }, { funding_route: undefined }]) {
      const f = fields(bad as Partial<EvidenceFields>);
      const r = await createOrRead(keyOf(f), f);
      expect(r.kind).toBe('stamp_invalid');
    }
  });
});
