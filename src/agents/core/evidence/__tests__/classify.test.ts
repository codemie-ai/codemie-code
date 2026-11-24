import { describe, it, expect } from 'vitest';
import { classify, decide, workConsentNeed, type Evidence, type Policy } from '../classify.js';
import { routedViaCodemie } from '../routing.js';

const policy: Policy = { organizations: ['Acme Corp', 'beta'], version: 'v1abc' };
const ev = (o: Partial<Evidence> = {}): Evidence => ({
  routed_via_codemie: false,
  routing_proof: 'proven',
  organization: 'acme corp',
  ...o,
});

describe('classify (D7)', () => {
  it('routed is determinate codemie even without a policy', () => {
    expect(classify(ev({ routed_via_codemie: true }), null)).toEqual({
      class: 'codemie', status: 'determinate', basis: 'routed',
    });
  });

  it('a native session through the live local proxy daemon classifies as codemie', () => {
    const r = routedViaCodemie({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4001', ANTHROPIC_AUTH_TOKEN: 'gw' },
      codemieProvider: true,
      profileBaseUrl: 'https://llm.example.com',
      profileName: 'p',
      localProxy: { url: 'http://127.0.0.1:4001', targetUrl: 'https://llm.example.com', profile: 'p' },
    });
    expect(classify(ev({ routed_via_codemie: r.routed, routing_proof: r.routing_proof }), null)).toMatchObject({ class: 'codemie' });
  });

  it('matching org (trimmed, case-insensitive) is corporate and carries policy_version', () => {
    expect(classify(ev({ organization: '  ACME corp ' }), policy)).toEqual({
      class: 'corporate', status: 'determinate', basis: 'org_match', policy_version: 'v1abc',
    });
  });

  it('non-matching org is personal', () => {
    const r = classify(ev({ organization: 'someone else' }), policy);
    expect(r).toMatchObject({ class: 'personal', status: 'determinate', basis: 'org_no_match', policy_version: 'v1abc' });
  });

  it('known-empty list is unknown but determinate', () => {
    const r = classify(ev(), { organizations: [], version: 'v0' });
    expect(r).toMatchObject({ class: 'unknown', status: 'determinate', basis: 'org_list_empty', policy_version: 'v0' });
  });

  it('missing or blank org is unknown (no_org)', () => {
    expect(classify(ev({ organization: undefined }), policy)).toMatchObject({ class: 'unknown', status: 'determinate', basis: 'no_org' });
    expect(classify(ev({ organization: '  ' }), null)).toMatchObject({ class: 'unknown', basis: 'no_org' });
  });

  it('AC2: known org, not routed, no policy => unknown indeterminate policy_unavailable, never personal', () => {
    expect(classify(ev(), null)).toEqual({ class: 'unknown', status: 'indeterminate', basis: 'policy_unavailable' });
  });

  it('unproven route with known org is unknown/indeterminate routing_unproven, never personal', () => {
    expect(classify(ev({ routing_proof: 'unproven' }), null)).toEqual({
      class: 'unknown', status: 'indeterminate', basis: 'routing_unproven',
    });
    expect(classify(ev({ routing_proof: 'unproven', organization: 'other' }), policy)).toMatchObject({
      class: 'unknown', status: 'indeterminate', basis: 'routing_unproven',
    });
  });
});

describe('decide', () => {
  const unavailable = classify(ev(), null);

  it('default forwards everything, indeterminate included', () => {
    expect(decide(unavailable)).toBe('forward');
    expect(decide(classify(ev(), policy))).toBe('forward');
  });

  it('explicit consumer may suppress/withhold, and a withhold is re-decided after a policy arrives', () => {
    const consumer = (r: { status: string; class: string }) =>
      r.status === 'indeterminate' ? 'withhold' : r.class === 'personal' ? 'suppress' : 'forward';
    expect(decide(unavailable, consumer)).toBe('withhold');
    expect(decide(classify(ev(), policy), consumer)).toBe('forward');
    expect(decide(classify(ev({ organization: 'x' }), policy), consumer)).toBe('suppress');
  });
});

describe('workConsentNeed (no work consent)', () => {
  const sub = 'subscription';
  it('personal always requires consent', () => {
    expect(workConsentNeed(classify(ev({ organization: 'x' }), policy), undefined)).toBe('required');
  });
  it('codemie and corporate never need it', () => {
    expect(workConsentNeed(classify(ev({ routed_via_codemie: true }), policy), sub)).toBe('none');
    expect(workConsentNeed(classify(ev(), policy), sub)).toBe('none');
  });
  it('determinate unknown needs it only with subscription funding', () => {
    expect(workConsentNeed(classify(ev({ organization: undefined }), policy), sub)).toBe('required');
    expect(workConsentNeed(classify(ev({ organization: undefined }), policy), 'api_based')).toBe('none');
  });
  it('unproven routing under a usable policy: subscription required, otherwise none', () => {
    const r = classify(ev({ organization: 'x', routing_proof: 'unproven' }), policy);
    expect(r).toMatchObject({ class: 'unknown', status: 'indeterminate', basis: 'routing_unproven' });
    expect(workConsentNeed(r, sub)).toBe('required');
    expect(workConsentNeed(r, 'api_based')).toBe('none');
  });
  it('no usable policy: policy_unavailable or subscription is unresolved, otherwise none', () => {
    const unavailable = classify(ev(), null);
    expect(unavailable).toMatchObject({ status: 'indeterminate', basis: 'policy_unavailable' });
    expect(workConsentNeed(unavailable, 'api_based')).toBe('unresolved');
    const unproven = classify(ev({ routing_proof: 'unproven' }), null);
    expect(unproven.basis).toBe('routing_unproven');
    expect(workConsentNeed(unproven, sub)).toBe('unresolved');
    expect(workConsentNeed(unproven, 'api_based')).toBe('none');
  });
});
