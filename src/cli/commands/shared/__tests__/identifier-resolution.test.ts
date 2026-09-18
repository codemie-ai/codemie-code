import { describe, it, expect } from 'vitest';
import { resolveIdentifiers } from '../identifier-resolution.js';
import type { ResolvableItem } from '../identifier-resolution.js';
import { RegistrationItemNotFoundError, AmbiguousIdentifierError } from '@/utils/errors.js';

interface Fixture extends ResolvableItem {
  id: string;
  name: string;
  slug?: string;
}

const catalog: Fixture[] = [
  { id: 'id-1', name: 'Alpha', slug: 'alpha-slug' },
  { id: 'id-2', name: 'Duplicate', slug: 'dup-2' },
  { id: 'id-3', name: 'Duplicate', slug: 'dup-3' }
];

describe('resolveIdentifiers', () => {
  it('matches by id', () => {
    expect(resolveIdentifiers('assistant', ['id-1'], catalog)).toEqual([catalog[0]]);
  });

  it('matches by slug', () => {
    expect(resolveIdentifiers('assistant', ['alpha-slug'], catalog)).toEqual([catalog[0]]);
  });

  it('matches by exact name, case-insensitively', () => {
    expect(resolveIdentifiers('assistant', ['ALPHA'], catalog)).toEqual([catalog[0]]);
  });

  it('preserves the requested order across a mixed batch', () => {
    expect(resolveIdentifiers('assistant', ['alpha-slug', 'id-1'], catalog)).toEqual([catalog[0], catalog[0]]);

    const result = resolveIdentifiers('assistant', ['id-2', 'alpha-slug'], [catalog[0], catalog[1]]);
    expect(result).toEqual([catalog[1], catalog[0]]);
  });

  it('throws RegistrationItemNotFoundError naming the unknown identifier', () => {
    expect(() => resolveIdentifiers('assistant', ['does-not-exist'], catalog)).toThrow(RegistrationItemNotFoundError);
    expect(() => resolveIdentifiers('assistant', ['does-not-exist'], catalog)).toThrow(/does-not-exist/);
  });

  it('throws AmbiguousIdentifierError listing every candidate when a name matches several entries', () => {
    expect(() => resolveIdentifiers('skill', ['Duplicate'], catalog)).toThrow(AmbiguousIdentifierError);
    expect(() => resolveIdentifiers('skill', ['Duplicate'], catalog)).toThrow(/id-2/);
    expect(() => resolveIdentifiers('skill', ['Duplicate'], catalog)).toThrow(/id-3/);
  });

  it('lets an id match win over a name collision', () => {
    const items: Fixture[] = [
      { id: 'Duplicate', name: 'unrelated', slug: 'unrelated-slug' },
      { id: 'id-2', name: 'Duplicate', slug: 'dup-2' },
      { id: 'id-3', name: 'Duplicate', slug: 'dup-3' }
    ];

    expect(resolveIdentifiers('skill', ['Duplicate'], items)).toEqual([items[0]]);
  });

  it('does not crash on items with no slug and does not match an empty identifier against them', () => {
    const items: Fixture[] = [{ id: 'id-1', name: 'NoSlug' }];

    expect(() => resolveIdentifiers('assistant', [''], items)).toThrow(RegistrationItemNotFoundError);
  });
});
