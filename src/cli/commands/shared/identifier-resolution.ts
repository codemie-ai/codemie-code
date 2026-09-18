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

function bucket<T>(map: Map<string, T[]>, key: string, item: T): void {
  const existing = map.get(key);

  if (existing) {
    existing.push(item);
  } else {
    map.set(key, [item]);
  }
}

/**
 * Resolves each requested identifier against the catalog, matching case-insensitively
 * by id, then slug, then exact name. Results are ordered like `identifiers`.
 *
 * Throws `RegistrationItemNotFoundError` when an identifier matches nothing, and
 * `AmbiguousIdentifierError` — listing every candidate rather than picking one —
 * whenever an identifier matches multiple catalog entries, whether they collide on
 * id, slug or name. Since matching is case-insensitive throughout, entries whose
 * keys differ only in case collide too.
 */
export function resolveIdentifiers<T extends ResolvableItem>(
  kind: 'assistant' | 'skill',
  identifiers: string[],
  catalog: T[]
): T[] {
  const byId = new Map<string, T[]>();
  const bySlug = new Map<string, T[]>();
  const byName = new Map<string, T[]>();

  for (const item of catalog) {
    bucket(byId, item.id.toLowerCase(), item);

    if (item.slug) {
      bucket(bySlug, item.slug.toLowerCase(), item);
    }

    bucket(byName, item.name.toLowerCase(), item);
  }

  return identifiers.map((identifier) => {
    const key = identifier.toLowerCase();

    if (!key) {
      throw new RegistrationItemNotFoundError(kind, identifier);
    }

    for (const candidates of [byId.get(key), bySlug.get(key), byName.get(key)]) {
      if (!candidates) {
        continue;
      }

      if (candidates.length > 1) {
        throw new AmbiguousIdentifierError(kind, identifier, candidates);
      }

      return candidates[0];
    }

    throw new RegistrationItemNotFoundError(kind, identifier);
  });
}
