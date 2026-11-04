/**
 * The one rule every agent uses to narrow its model list to the active profile's own models
 * (CODEMIE_PROFILE_MODELS, comma-separated — set for the agent's own list on a per-agent
 * profile, EPMCDME-15641). Agent plugins differ only in the item shape they narrow (picker
 * options, catalog entries, plain ids), so they pass an id accessor instead of reimplementing it.
 */

import { logger } from '@/utils/logger.js';

export interface ProfileModelFilterOptions<T> {
  /** Id of an item as it appears in CODEMIE_PROFILE_MODELS. */
  getId: (item: T) => string;
  /**
   * Model this session runs on. It is kept even when it is missing from the profile list
   * (e.g. a retirement-healed active model), as long as `items` has it.
   */
  activeModel?: string;
  /** Logged when the profile list matches none of `items` and the full list is returned. */
  noMatchMessage: string;
  /** `notice` (default) also shows the message to the user; `warn` writes it to the log only. */
  noMatchLevel?: 'notice' | 'warn';
}

/** Parses a CODEMIE_PROFILE_MODELS value into its model ids. */
export function parseProfileModels(allowedCsv: string): Set<string> {
  return new Set(allowedCsv.split(',').map(id => id.trim()).filter(Boolean));
}

/**
 * Narrows `items` to the profile's own models, plus the active model.
 *
 * Returns `items` unchanged when `allowedCsv` is unset or empty, and when the profile list
 * matches none of `items` at all (AC22) — the fallback is judged before the active-model
 * keep-case, so a list is never silently narrowed down to the active model alone and a
 * model menu is never left empty.
 */
export function filterToProfileModels<T>(
  items: T[],
  allowedCsv: string | undefined,
  options: ProfileModelFilterOptions<T>
): T[] {
  if (!allowedCsv) {
    return items;
  }

  const allowed = parseProfileModels(allowedCsv);
  const matched = items.filter(item => allowed.has(options.getId(item)));

  if (matched.length === 0) {
    if (options.noMatchLevel === 'warn') {
      logger.warn(options.noMatchMessage);
    } else {
      // AC22: the user must see that the menu could not be limited, not just the log file.
      logger.notice(options.noMatchMessage);
    }
    return items;
  }

  const { activeModel } = options;
  if (activeModel && !matched.some(item => options.getId(item) === activeModel)) {
    const activeItem = items.find(item => options.getId(item) === activeModel);
    if (activeItem) {
      return [...matched, activeItem];
    }
  }

  return matched;
}
