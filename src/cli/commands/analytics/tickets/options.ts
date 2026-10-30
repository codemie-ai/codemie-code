/**
 * Resolves `--ticket-sources` / `--ticket-tools` (and the `analytics.ticketTools` config key)
 * into the collector's options.
 */

import type { TicketSource } from './merge.js';
import { DEFAULT_TICKET_TOOLS } from './tool-tickets.js';

export const TICKET_SOURCES: readonly TicketSource[] = ['tool', 'branch', 'prompt'];

export class TicketOptionsError extends Error {}

/**
 * Sources to use. Default `tool,branch,prompt`; with `--redact`, `tool,branch` — "redact" means
 * nothing derived from prompts unless `prompt` is asked for explicitly. `none` turns it all off.
 */
export function resolveTicketSources(raw: string | undefined, redact: boolean): Set<TicketSource> {
  if (raw === undefined) {
    return new Set(redact ? ['tool', 'branch'] : TICKET_SOURCES);
  }
  const names = raw.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
  if (names.length === 1 && names[0] === 'none') return new Set();
  if (names.includes('none')) {
    throw new TicketOptionsError('--ticket-sources: none turns ticket extraction off and cannot be combined with other sources.');
  }
  const invalid = names.filter((name) => !TICKET_SOURCES.includes(name as TicketSource));
  if (names.length === 0 || invalid.length > 0) {
    throw new TicketOptionsError(
      `Invalid --ticket-sources${invalid.length ? ` value: ${invalid.join(', ')}` : ''}. Use any of ${TICKET_SOURCES.join(', ')}, or none.`
    );
  }
  return new Set(names as TicketSource[]);
}

/** Tool-name globs: the flag, else the config key, else the built-in Jira default. */
export function resolveTicketTools(flag: string | undefined, configured: unknown): string[] {
  const fromList = (values: unknown[]): string[] => values.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
  if (flag !== undefined) {
    const globs = fromList(flag.split(','));
    if (globs.length === 0) throw new TicketOptionsError('--ticket-tools needs at least one tool-name pattern.');
    return globs;
  }
  const fromConfig = Array.isArray(configured) ? fromList(configured) : typeof configured === 'string' ? fromList(configured.split(',')) : [];
  return fromConfig.length > 0 ? fromConfig : [...DEFAULT_TICKET_TOOLS];
}
