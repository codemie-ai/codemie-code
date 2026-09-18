/**
 * Pure identifier resolution shared by `codemie setup assistants` and `codemie setup skills`.
 *
 * Resolves user-supplied identifiers (id, slug, or exact name) against a catalog,
 * failing loudly instead of guessing when an identifier is unknown or ambiguous.
 */

import { RegistrationItemNotFoundError, AmbiguousIdentifierError } from '@/utils/errors.js';

export interface ResolvableItem {
  id: string;
  name: string;
  slug?: string;
}

/**
 * Resolves each requested identifier against the catalog, matching case-insensitively
 * by id, then slug, then exact name. Results are ordered like `identifiers`.
 *
 * Throws `RegistrationItemNotFoundError` when an identifier matches nothing, and
 * `AmbiguousIdentifierError` when a name identifier matches multiple catalog entries
 * (listing every candidate rather than picking one).
 */
export function resolveIdentifiers<T extends ResolvableItem>(
  kind: 'assistant' | 'skill',
  identifiers: string[],
  catalog: T[]
): T[] {
  const byId = new Map<string, T>();
  const bySlug = new Map<string, T>();
  const byName = new Map<string, T[]>();

  for (const item of catalog) {
    byId.set(item.id.toLowerCase(), item);

    if (item.slug) {
      bySlug.set(item.slug.toLowerCase(), item);
    }

    const nameKey = item.name.toLowerCase();
    const bucket = byName.get(nameKey);

    if (bucket) {
      bucket.push(item);
    } else {
      byName.set(nameKey, [item]);
    }
  }

  return identifiers.map((identifier) => {
    const key = identifier.toLowerCase();

    if (!key) {
      throw new RegistrationItemNotFoundError(kind, identifier);
    }

    const idMatch = byId.get(key);
    if (idMatch) {
      return idMatch;
    }

    const slugMatch = bySlug.get(key);
    if (slugMatch) {
      return slugMatch;
    }

    const nameMatches = byName.get(key);
    if (nameMatches && nameMatches.length === 1) {
      return nameMatches[0];
    }

    if (nameMatches && nameMatches.length > 1) {
      throw new AmbiguousIdentifierError(kind, identifier, nameMatches);
    }

    throw new RegistrationItemNotFoundError(kind, identifier);
  });
}
