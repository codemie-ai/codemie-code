import { describe, it, expect } from 'vitest';
import { classify, decide, type Evidence, type Policy } from '../classify.js';

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
